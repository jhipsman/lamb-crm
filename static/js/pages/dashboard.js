/* Dashboard, Today view and global search results. */
'use strict';

route('/', async (main) => {
  const d = await api('/dashboard');
  const calls = d.calls;
  const lr = d.outstanding_loss_runs;
  const pipeTotal = d.pipeline.filter(p => !['Won', 'Lost'].includes(p.stage));
  const openCount = pipeTotal.reduce((s, p) => s + p.count, 0);
  const openPrem = pipeTotal.reduce((s, p) => s + p.est_premium, 0);
  const openComm = pipeTotal.reduce((s, p) => s + p.est_commission, 0);

  clear(main).append(
    pageHead('Dashboard',
      h('button', { class: 'btn', onclick: () => quickAdd('account') }, '+ Account ', h('kbd', null, 'N')),
      h('button', { class: 'btn', onclick: () => quickAdd('task') }, '+ Task ', h('kbd', null, 'T')),
      h('button', { class: 'btn', onclick: () => quickAdd('activity') }, '+ Activity ', h('kbd', null, 'A')),
      h('button', { class: 'btn btn-primary', onclick: () => quickAdd('call') }, '☎ Log Call')),

    h('div', { class: 'cards' },
      stat('Active Accounts', fmtNum(d.book.active_accounts), 'Active Client + BOR Won', { href: '#/accounts?status=Active Client' }),
      stat('In-Force Premium', fmtMoney(d.book.premium), `${d.book.policies} bound policies`, { href: '#/commission' }),
      stat('Est. Annual Commission', fmtMoney(d.book.commission), `${fmtMoney(d.book.commission / 12)}/mo`, { href: '#/commission' }),
      stat('Calls Today', fmtNum(calls.today), `Week ${calls.week} · Month ${calls.month}`, { href: '#/activities?type=Call' }),
      stat('Tasks Due Today', fmtNum(d.tasks_today.length), 'incl. overdue', { href: '#/today', cls: d.tasks_today.length ? 'warn' : '' }),
      stat('Overdue Follow-ups', fmtNum(d.overdue_followups.length), `${d.followups_today} due today`, { href: '#/today', cls: d.overdue_followups.length ? 'alert' : '' }),
      stat('Outstanding Docs', fmtNum(d.outstanding_docs), 'on active submissions', { href: '#/documents' }),
      stat('Loss Runs Outstanding', fmtNum(lr.count), lr.oldest ? `oldest ${fmtDate(lr.oldest)}` : '', { href: '#/lossruns', cls: lr.count ? 'warn' : '' }),
      stat('Open Pipeline', fmtNum(openCount), `${fmtMoney(openPrem)} prem · ${fmtMoney(openComm)} comm`, { href: '#/pipeline' }),
    ),

    h('div', { class: 'panel', style: { marginBottom: '14px' } },
      h('div', { class: 'panel-head' }, h('h2', null, 'Upcoming renewals by month'), h('div', { class: 'spacer' }), h('a', { href: '#/renewals' }, 'Calendar →')),
      h('div', { class: 'month-bars' }, d.renewals_by_month.map(m => h('a', { class: 'month-bar', href: `#/renewals?month=${m.month}` },
        h('div', { class: 'm' }, monthName(m.month)), h('div', { class: 'n' }, m.count), h('div', { class: 'muted small' }, fmtMoney(m.premium)))))),

    h('div', { class: 'grid grid-2' },
      h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, `Renewals next 90 days (${d.renewals_90.length})`), h('div', { class: 'spacer' }), h('a', { href: '#/renewals?view=list' }, 'All →')),
        d.renewals_90.length ? h('ul', { class: 'list' }, d.renewals_90.slice(0, 15).map(r => {
          const days = daysUntil(r.renewal_date);
          return h('li', null, h('span', { class: `dot ${urgency(days)}` }),
            h('div', { class: 'grow' }, h('a', { href: `#/accounts/${r.account_id}` }, r.account_name), h('div', { class: 'muted small' }, `${r.line} · ${r.carrier || 'no carrier'} · ${r.status}`)),
            h('div', { class: 'right' }, h('div', null, fmtDate(r.renewal_date)), h('div', { class: 'muted small' }, `${days}d · ${fmtMoney(r.premium)}`)));
        })) : h('div', { class: 'empty' }, 'No renewals in the next 90 days.')),

      h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Due today & overdue'), h('div', { class: 'spacer' }), h('a', { href: '#/today' }, 'Today view →')),
        (d.tasks_today.length || d.overdue_followups.length) ? h('ul', { class: 'list' },
          d.tasks_today.slice(0, 10).map(t => h('li', null, taskCheckbox(t),
            h('div', { class: 'grow' }, t.title, h('div', { class: 'muted small' }, [t.account_name, t.category, t.due_date < todayISO() ? `overdue since ${fmtDate(t.due_date)}` : 'due today'].filter(Boolean).join(' · '))),
            badge(t.priority))),
          d.overdue_followups.slice(0, 10).map(a => h('li', null,
            h('button', { class: 'btn btn-sm', title: 'Mark follow-up done', onclick: () => completeFollowUp(a) }, '✓'),
            h('div', { class: 'grow' }, `Follow up: ${a.next_step || a.summary || a.type}`, h('div', { class: 'muted small' }, [a.account_name, `was due ${fmtDate(a.follow_up_date)}`].filter(Boolean).join(' · '))),
            badge(a.priority)))
        ) : h('div', { class: 'empty' }, 'Nothing due. Nice.')),

      h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Pipeline summary'), h('div', { class: 'spacer' }), h('a', { href: '#/pipeline' }, 'Board →')),
        h('div', { class: 'table-wrap' }, h('table', null,
          h('thead', null, h('tr', null, h('th', null, 'Stage'), h('th', { class: 'num' }, 'Count'), h('th', { class: 'num' }, 'Est. Premium'), h('th', { class: 'num' }, 'Est. Commission'))),
          h('tbody', null, d.pipeline.map(p => h('tr', null, h('td', null, p.stage), h('td', { class: 'num' }, p.count), h('td', { class: 'num' }, fmtMoney(p.est_premium)), h('td', { class: 'num' }, fmtMoney(p.est_commission))))),
          h('tfoot', null, h('tr', null, h('td', null, 'Open (excl. Won/Lost)'), h('td', { class: 'num' }, openCount), h('td', { class: 'num' }, fmtMoney(openPrem)), h('td', { class: 'num' }, fmtMoney(openComm))))))),

      h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Recently added / updated'), h('div', { class: 'spacer' }), h('a', { href: '#/accounts' }, 'All accounts →')),
        d.recent_accounts.length ? h('ul', { class: 'list' }, d.recent_accounts.map(a => h('li', null,
          h('div', { class: 'grow' }, h('a', { href: `#/accounts/${a.id}` }, a.named_insured), h('div', { class: 'muted small' }, [a.territory, `updated ${fmtDateTime(a.updated_at)}`].filter(Boolean).join(' · '))),
          badge(a.status)))) : h('div', { class: 'empty' }, h('p', null, 'No accounts yet.'), h('button', { class: 'btn btn-primary', onclick: () => quickAdd('account') }, 'Add your first account'))),
    ),
  );
});

route('/today', async (main) => {
  const d = await api('/today');
  const t = todayISO();
  const prioRank = { High: 0, Medium: 1, Low: 2 };
  clear(main).append(
    pageHead(`Today — ${new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}`,
      h('button', { class: 'btn', onclick: () => quickAdd('task') }, '+ Task'),
      h('button', { class: 'btn btn-primary', onclick: () => quickAdd('call') }, '☎ Log Call')),
    h('div', { class: 'cards' },
      stat('Calls Today', d.calls.today), stat('Calls This Week', d.calls.week), stat('Calls This Month', d.calls.month),
      stat('Tasks Due', d.tasks.length, `${d.tasks.filter(x => x.due_date < t).length} overdue`, { cls: d.tasks.length ? 'warn' : '' }),
      stat('Follow-ups Due', d.followups.length, `${d.followups.filter(x => x.follow_up_date < t).length} overdue`, { cls: d.followups.some(x => x.follow_up_date < t) ? 'alert' : '' })),
    h('div', { class: 'panel', style: { marginBottom: '14px' } },
      h('div', { class: 'panel-head' }, h('h2', null, 'Tasks due today & overdue'), h('div', { class: 'spacer' }), h('span', { class: 'muted small' }, 'sorted by priority')),
      DataTable({
        name: 'Tasks due today', rows: d.tasks, emptyText: 'No tasks due.',
        rowClass: r => r.due_date < t ? 'row-overdue' : '',
        onRowClick: r => openTaskForm(r),
        defaultSort: null,
        columns: [
          { key: 'done', label: '✓', sortable: false, filter: false, export: false, render: r => taskCheckbox(r) },
          { key: 'priority', label: 'Priority', type: 'badge', value: r => r.priority, filterOptions: L().priorities },
          { key: 'title', label: 'Task' },
          { key: 'account_name', label: 'Account', render: r => accountLink(r) },
          { key: 'category', label: 'Category', filterOptions: L().task_categories },
          { key: 'assigned_to', label: 'Assigned', filterOptions: L().teams },
          { key: 'due_date', label: 'Due', type: 'date' },
        ],
      })),
    h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Follow-ups due today & overdue')),
      DataTable({
        name: 'Follow-ups due', rows: d.followups.sort((a, b) => (prioRank[a.priority] ?? 1) - (prioRank[b.priority] ?? 1) || a.follow_up_date.localeCompare(b.follow_up_date)),
        emptyText: 'No follow-ups due.',
        rowClass: r => r.follow_up_date < t ? 'row-overdue' : '',
        onRowClick: r => openActivityForm(r),
        columns: [
          { key: 'done', label: '✓', sortable: false, filter: false, export: false, render: r => h('button', { class: 'btn btn-sm', onclick: () => completeFollowUp(r) }, 'Done') },
          { key: 'priority', label: 'Priority', type: 'badge', filterOptions: L().priorities },
          { key: 'account_name', label: 'Account', render: r => accountLink(r) },
          { key: 'next_step', label: 'Next Step' },
          { key: 'summary', label: 'Last Activity', value: r => `${r.type}: ${r.summary || ''}` },
          { key: 'follow_up_date', label: 'Follow-up', type: 'date' },
          { key: 'log', label: '', sortable: false, filter: false, export: false, render: r => h('button', { class: 'btn btn-sm', onclick: () => openActivityForm(null, { defaults: { account_id: r.account_id, type: 'Call' }, onSaved: () => completeFollowUp(r) }) }, 'Log & close') },
        ],
      })),
  );
});

route('/search', async (main, params, query) => {
  const q = query.q || '';
  $('#globalSearchInput').value = q;
  const d = await api('/search?q=' + encodeURIComponent(q));
  const total = d.accounts.length + d.contacts.length + d.policies.length + d.notes.length;
  const section = (title, items, render) => items.length ? h('div', { class: 'panel', style: { marginBottom: '14px' } },
    h('h2', null, `${title} (${items.length})`), h('ul', { class: 'list' }, items.map(render))) : null;
  clear(main).append(
    pageHead(`Search: “${q}”`, h('span', { class: 'muted' }, `${total} result${total === 1 ? '' : 's'}`)),
    total ? null : h('div', { class: 'panel empty' }, 'No matches.'),
    section('Accounts', d.accounts, a => h('li', null, h('div', { class: 'grow' }, h('a', { href: `#/accounts/${a.id}` }, a.named_insured),
      h('div', { class: 'muted small' }, [a.dba && `DBA ${a.dba}`, [a.city, a.state].filter(Boolean).join(', ')].filter(Boolean).join(' · '))), badge(a.status))),
    section('Contacts', d.contacts, c => h('li', null, h('div', { class: 'grow' }, h('a', { href: `#/accounts/${c.account_id}` }, c.name),
      h('div', { class: 'muted small' }, [c.title, c.account_name, c.email, c.phone].filter(Boolean).join(' · '))))),
    section('Policies', d.policies, p => h('li', null, h('div', { class: 'grow' }, h('a', { href: `#/accounts/${p.account_id}?tab=portfolio` }, `${p.line} — ${p.carrier || 'no carrier'}`),
      h('div', { class: 'muted small' }, [p.account_name, p.policy_number && `#${p.policy_number}`, p.expiration_date && `exp ${fmtDate(p.expiration_date)}`].filter(Boolean).join(' · '))), badge(p.status))),
    section('Notes & Activity', d.notes, n => h('li', null, h('div', { class: 'grow' },
      n.account_id ? h('a', { href: `#/accounts/${n.account_id}` }, n.account_name) : h('span', { class: 'muted' }, 'No account'),
      h('div', { class: 'small', style: { whiteSpace: 'pre-wrap' } }, n.text)), h('span', { class: 'muted small nowrap' }, `${n.kind} · ${fmtDate(n.at)}`))),
  );
});
