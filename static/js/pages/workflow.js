/* Cross-account work queues: submissions, documents, loss runs, activities, tasks, internal team. */
'use strict';

function statusTabs(options, current, base) {
  return h('div', { class: 'btn-group' }, options.map(([val, label]) =>
    h('button', { class: 'btn btn-sm' + (current === val ? ' active' : ''), onclick: () => { location.hash = base + (val ? `?show=${encodeURIComponent(val)}` : ''); } }, label)));
}

route('/submissions', async (main, params, query) => {
  const show = query.show || 'active';
  const rows = await R.list('submissions');
  const active = ['Pending', 'Need Additional Info', 'Quoted'];
  const shown = show === 'all' ? rows : rows.filter(r => show === 'active' ? active.includes(r.status) : r.status === show);
  clear(main).append(
    pageHead('Submission Tracker', h('button', { class: 'btn btn-primary', onclick: () => openSubmissionForm(null, { onSaved: refreshRoute }) }, '+ Submission')),
    h('div', { class: 'toolbar' }, statusTabs([['active', 'Active'], ...L().submission_statuses.map(s => [s, s]), ['all', 'All']], show, '#/submissions')),
    DataTable({
      name: 'Submissions', rows: shown, emptyText: 'No submissions.',
      onRowClick: r => openSubmissionDetail(r, refreshRoute), defaultSort: { key: 'date_submitted', dir: -1 },
      columns: submissionColumns({ account: true }),
    }));
});

route('/documents', async (main, params, query) => {
  const show = query.show || 'outstanding';
  const rows = await R.list('documents');
  const shown = show === 'all' ? rows : show === 'outstanding' ? rows.filter(r => ['Not Requested', 'Requested'].includes(r.status)) : rows.filter(r => r.status === show);
  clear(main).append(
    pageHead('Document Checklist', h('button', { class: 'btn', onclick: () => { location.hash = '#/settings?tab=templates'; } }, 'Edit templates')),
    h('p', { class: 'muted' }, 'Checklists auto-populate per line when a submission is created. Marking an item "Requested" creates a 7-day follow-up task.'),
    h('div', { class: 'toolbar' }, statusTabs([['outstanding', 'Outstanding'], ...L().doc_statuses.map(s => [s, s]), ['all', 'All']], show, '#/documents')),
    DataTable({
      name: 'Documents', rows: shown, emptyText: 'No documents.',
      onRowClick: r => openDocumentForm(r, { onSaved: refreshRoute }), defaultSort: { key: 'account_name', dir: 1 },
      columns: documentColumns({ account: true }),
    }));
});

route('/lossruns', async (main, params, query) => {
  const show = query.show || 'Requested';
  const rows = await R.list('loss_runs');
  const shown = show === 'all' ? rows : rows.filter(r => r.status === show);
  const out = rows.filter(r => r.status === 'Requested');
  clear(main).append(
    pageHead('Loss Run Tracker', h('button', { class: 'btn btn-primary', onclick: () => openLossRunForm(null, { onSaved: refreshRoute }) }, '+ Loss Run Request')),
    h('div', { class: 'cards' },
      stat('Outstanding', out.length),
      stat('Over 30 Days', out.filter(r => r.days_outstanding > 30).length, null, { cls: out.some(r => r.days_outstanding > 30) ? 'alert' : '' }),
      stat('Oldest', out.length ? `${Math.max(...out.map(r => r.days_outstanding || 0))} days` : '—')),
    h('div', { class: 'toolbar' }, statusTabs([...L().loss_run_statuses.map(s => [s, s]), ['all', 'All']], show, '#/lossruns')),
    DataTable({
      name: 'Loss Runs', rows: shown, emptyText: 'No loss run requests.',
      onRowClick: r => openLossRunForm(r, { onSaved: refreshRoute }), defaultSort: { key: 'days_outstanding', dir: -1 },
      columns: lossRunColumns({ account: true }),
    }));
});

route('/activities', async (main, params, query) => {
  const [rows, calls] = await Promise.all([R.list('activities'), api('/calls')]);
  const type = query.type || '';
  const shown = type ? rows.filter(r => r.type === type) : rows;
  clear(main).append(
    pageHead('Activity Log',
      h('button', { class: 'btn', onclick: () => quickAdd('activity') }, '+ Activity'),
      h('button', { class: 'btn btn-primary', onclick: () => quickAdd('call') }, '☎ Log Call')),
    h('div', { class: 'cards' }, stat('Calls Today', calls.today), stat('Calls This Week', calls.week), stat('Calls This Month', calls.month),
      stat('Open Follow-ups', rows.filter(r => r.follow_up_date && !r.follow_up_done).length, null, { href: '#/today' })),
    h('div', { class: 'toolbar' }, h('div', { class: 'btn-group' },
      h('button', { class: 'btn btn-sm' + (!type ? ' active' : ''), onclick: () => { location.hash = '#/activities'; } }, 'All'),
      L().activity_types.map(t => h('button', { class: 'btn btn-sm' + (type === t ? ' active' : ''), onclick: () => { location.hash = `#/activities?type=${encodeURIComponent(t)}`; } }, t)))),
    DataTable({
      name: 'Activity Log' + (type ? ` - ${type}` : ''), rows: shown, emptyText: 'No activity logged yet. Press A to log one.',
      onRowClick: r => openActivityForm(r, { onSaved: refreshRoute }), defaultSort: { key: 'activity_date', dir: -1 },
      columns: activityColumns({ account: true }),
    }));
});

route('/tasks', async (main, params, query) => {
  const show = query.show || 'open';
  const rows = await R.list('tasks');
  const t = todayISO();
  const filters = {
    today: r => r.status === 'Open' && r.due_date && r.due_date <= t,
    open: r => r.status === 'Open',
    done: r => r.status === 'Done',
    all: () => true,
  };
  const shown = rows.filter(filters[show] || filters.open);
  const prio = { High: 0, Medium: 1, Low: 2 };
  clear(main).append(
    pageHead('Tasks', h('button', { class: 'btn btn-primary', onclick: () => quickAdd('task') }, '+ Task')),
    h('div', { class: 'toolbar' }, statusTabs([['today', `Today & overdue (${rows.filter(filters.today).length})`], ['open', `Open (${rows.filter(filters.open).length})`], ['done', 'Done'], ['all', 'All']], show, '#/tasks')),
    DataTable({
      name: 'Tasks', rows: show === 'today' ? shown.sort((a, b) => prio[a.priority] - prio[b.priority] || (a.due_date || '').localeCompare(b.due_date || '')) : shown,
      emptyText: 'No tasks.', rowClass: taskRowClass,
      onRowClick: r => openTaskForm(r, { onSaved: refreshRoute }),
      defaultSort: show === 'today' ? null : { key: 'due_date', dir: 1 },
      columns: taskColumns({ account: true }),
    }));
});

route('/team', async (main, params, query) => {
  const show = query.show || 'open';
  const rows = await R.list('team');
  const shown = show === 'all' ? rows : show === 'open' ? rows.filter(r => r.handoff_status !== 'Complete') : rows.filter(r => r.handoff_status === show);
  clear(main).append(
    pageHead('Internal Team Tracker', h('button', { class: 'btn btn-primary', onclick: () => openTeamForm(null, { onSaved: refreshRoute }) }, '+ Handoff')),
    h('p', { class: 'muted' }, 'Who on your team is handling what on each account. Manage team member names in Settings.'),
    h('div', { class: 'toolbar' }, statusTabs([['open', 'Open'], ...L().handoff_statuses.map(s => [s, s]), ['all', 'All']], show, '#/team')),
    DataTable({
      name: 'Internal Team', rows: shown, emptyText: 'No handoffs logged.',
      onRowClick: r => openTeamForm(r, { onSaved: refreshRoute }), defaultSort: { key: 'handoff_date', dir: -1 },
      columns: teamColumns({ account: true }),
    }));
});
