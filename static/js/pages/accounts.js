/* Accounts list, account detail (overview, portfolio, submissions, docs, ...), policies list. */
'use strict';

route('/accounts', async (main, params, query) => {
  const rows = await R.list('accounts');
  S.accounts = rows;
  const status = query.status || '';
  const filtered = status ? rows.filter(r => r.status === status) : rows;
  const counts = Object.fromEntries(L().account_statuses.map(s => [s, rows.filter(r => r.status === s).length]));
  clear(main).append(
    pageHead('Accounts', h('button', { class: 'btn btn-primary', onclick: () => openAccountForm(null) }, '+ New Account')),
    h('div', { class: 'toolbar' }, h('div', { class: 'btn-group' },
      h('button', { class: 'btn btn-sm' + (!status ? ' active' : ''), onclick: () => { location.hash = '#/accounts'; } }, `All (${rows.length})`),
      L().account_statuses.map(s => h('button', { class: 'btn btn-sm' + (status === s ? ' active' : ''), onclick: () => { location.hash = `#/accounts?status=${encodeURIComponent(s)}`; } }, `${s} (${counts[s]})`)))),
    DataTable({
      name: 'Accounts' + (status ? ` - ${status}` : ''), rows: filtered,
      emptyText: 'No accounts yet. Press N to add one.',
      onRowClick: r => { location.hash = `#/accounts/${r.id}`; },
      defaultSort: { key: 'named_insured', dir: 1 },
      columns: [
        { key: 'named_insured', label: 'Named Insured', render: r => h('a', { href: `#/accounts/${r.id}` }, r.named_insured) },
        { key: 'dba', label: 'DBA' },
        { key: 'status', label: 'Status', type: 'badge', filterOptions: L().account_statuses },
        { key: 'types', label: 'Type', filterOptions: L().account_types, render: r => (r.types || []).map(t => h('span', { class: 'tag' }, t)) },
        { key: 'territory', label: 'Territory', filterOptions: L().territories },
        { key: 'city', label: 'City', value: r => [r.city, r.state].filter(Boolean).join(', ') },
        { key: 'primary_contact', label: 'Primary Contact' },
        { key: 'policy_count', label: 'Policies', type: 'number' },
        { key: 'bound_premium', label: 'In-Force Premium', type: 'money', sum: true },
        { key: 'annual_revenue', label: 'Revenue', type: 'money' },
        { key: 'date_added', label: 'Added', type: 'date' },
        { key: 'status_changed_at', label: 'Status Changed', type: 'date', value: r => (r.status_changed_at || '').slice(0, 10) },
      ],
    }),
  );
});

// Lines most nonprofit/human services accounts should carry; used for cross-sell hints.
const CORE_LINES = ['GL', 'Professional Liability', 'Property', 'Auto', 'WC', 'D&O', 'EPL', 'Cyber', 'Crime', 'Excess/Umbrella', 'Abuse & Molestation'];

route('/accounts/:id', async (main, params, query) => {
  const id = Number(params.id);
  const d = await api(`/accounts/${id}/full`);
  const a = d.account;
  const tab = query.tab || 'overview';
  const reload = () => refreshRoute();
  const opt = { account_id: id, onSaved: reload };

  const openTasks = d.tasks.filter(t => t.status === 'Open').length;
  const outstandingDocs = d.documents.filter(x => ['Not Requested', 'Requested'].includes(x.status)).length;
  const currentPolicies = d.policies.filter(p => !p.renewed_to_id);
  const tabList = [
    ['overview', 'Overview'],
    ['portfolio', 'Portfolio', currentPolicies.length],
    ['submissions', 'Submissions', d.submissions.length],
    ['documents', 'Documents', outstandingDocs || null],
    ['lossruns', 'Loss Runs', d.loss_runs.filter(l => l.status === 'Requested').length || null],
    ['activity', 'Activity', d.activities.length],
    ['tasks', 'Tasks', openTasks || null],
    ['team', 'Internal Team', d.team.length || null],
  ];
  const body = h('div');
  const renderers = { overview: overviewTab, portfolio: portfolioTab, submissions: submissionsTab, documents: documentsTab, lossruns: lossRunsTab, activity: activityTab, tasks: tasksTab, team: teamTab };

  clear(main).append(
    h('div', { class: 'page-head' },
      h('div', null,
        h('h1', null, a.named_insured, ' ', badge(a.status)),
        h('div', { class: 'muted' }, [a.dba && `DBA ${a.dba}`, a.territory, [a.city, a.state].filter(Boolean).join(', ')].filter(Boolean).join(' · ')),
        h('div', { style: { marginTop: '4px' } }, (a.types || []).map(t => h('span', { class: 'tag' }, t)))),
      h('div', { class: 'spacer' }),
      h('button', { class: 'btn', onclick: () => openAccountForm(a) }, 'Edit'),
      h('button', { class: 'btn', onclick: () => openActivityForm(null, opt) }, '+ Activity'),
      h('button', { class: 'btn', onclick: () => openTaskForm(null, opt) }, '+ Task'),
      h('button', { class: 'btn', onclick: () => openPolicyForm(null, opt) }, '+ Policy'),
      h('button', { class: 'btn', onclick: () => openSubmissionForm(null, opt) }, '+ Submission'),
      !d.deals.length && a.status === 'Prospect' ? h('button', { class: 'btn', onclick: () => openDealForm(null, opt) }, '+ Pipeline') : null),
    tabs(tabList, tab, (k) => { setQuery({ tab: k }); renderTab(k); }),
    body,
  );
  function renderTab(k) {
    $$('.tabs button', main).forEach((b, i) => b.classList.toggle('active', tabList[i][0] === k));
    clear(body).appendChild(renderers[k](d, opt));
  }
  renderTab(renderers[tab] ? tab : 'overview');
});

function kvRows(pairs) {
  return h('div', { class: 'kv' }, pairs.map(([k, v]) => [h('div', { class: 'k' }, k), h('div', null, v === null || v === undefined || v === '' ? h('span', { class: 'muted' }, '—') : v)]));
}

function overviewTab(d, opt) {
  const a = d.account;
  const noteInput = h('textarea', { rows: 3, placeholder: 'Add a note… (notes are timestamped and append-only)' });
  const addNote = async () => {
    const body = noteInput.value.trim();
    if (!body) return;
    await R.create('notes', { account_id: a.id, body });
    toast('Note added');
    refreshRoute();
  };
  noteInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) addNote(); });
  const deal = d.deals[0];
  return h('div', { class: 'grid grid-2' },
    h('div', { class: 'grid' },
      h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Account details'), h('div', { class: 'spacer' }), h('button', { class: 'btn btn-sm', onclick: () => openAccountForm(a) }, 'Edit')),
        kvRows([
          ['Named insured', a.named_insured], ['DBA', a.dba],
          ['Address', [a.address, [a.city, a.state].filter(Boolean).join(', '), a.zip].filter(Boolean).join(' ')],
          ['County', a.county], ['FEIN', a.fein],
          ['Website', a.website ? h('a', { href: a.website, target: '_blank', rel: 'noopener' }, a.website) : null],
          ['Annual revenue', fmtMoney(a.annual_revenue)], ['Employees', fmtNum(a.num_employees)],
          ['Territory', a.territory], ['Status', badge(a.status)],
          ['Date added', fmtDate(a.date_added)], ['Status changed', fmtDateTime(a.status_changed_at)],
          ['Prior broker', a.prior_broker_name],
          ['Broker contact', [a.prior_broker_contact, a.prior_broker_phone, a.prior_broker_email].filter(Boolean).join(' · ')],
        ])),
      h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Contacts'), h('div', { class: 'spacer' }), h('button', { class: 'btn btn-sm', onclick: () => openContactForm(null, opt) }, '+ Contact')),
        d.contacts.length ? h('ul', { class: 'list' }, d.contacts.map(c => h('li', null,
          h('div', { class: 'grow' }, h('strong', null, c.name), c.is_primary ? h('span', { class: 'badge blue', style: { marginLeft: '6px' } }, 'Primary') : null,
            h('div', { class: 'muted small' }, c.title || ''),
            h('div', { class: 'small' }, c.phone ? h('a', { href: `tel:${c.phone}` }, c.phone) : null, c.phone && c.email ? ' · ' : '', c.email ? h('a', { href: `mailto:${c.email}` }, c.email) : null)),
          h('button', { class: 'btn btn-sm', onclick: () => openContactForm(c, opt) }, 'Edit')))) : h('div', { class: 'empty' }, 'No contacts yet.')),
      deal ? h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Pipeline'), h('div', { class: 'spacer' }), h('button', { class: 'btn btn-sm', onclick: () => openDealForm(deal, opt) }, 'Edit')),
        kvRows([['Stage', badge(deal.stage, deal.stage === 'Won' ? 'green' : deal.stage === 'Lost' ? 'red' : 'blue')], ['In stage since', `${fmtDateTime(deal.stage_entered_at)} (${deal.days_in_stage ?? 0} days)`],
          ['Est. premium', fmtMoney(deal.est_premium)], ['Est. commission', fmtMoney(deal.est_commission)], ['Source', deal.source],
          deal.stage === 'Lost' ? ['Reason lost', [deal.lost_reason, deal.lost_reason_detail].filter(Boolean).join(' — ')] : null].filter(Boolean))) : null,
      d.team.length ? h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Internal team')),
        h('ul', { class: 'list' }, d.team.map(t => h('li', null, h('div', { class: 'grow' }, h('strong', null, t.role), ': ', t.person_name || '—'), badge(t.handoff_status))))) : null,
    ),
    h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Notes')),
      noteInput,
      h('div', { style: { margin: '8px 0 6px' } }, h('button', { class: 'btn btn-primary btn-sm', onclick: addNote }, 'Add note'), h('span', { class: 'muted small' }, '  Ctrl/⌘+Enter')),
      h('div', { class: 'notes-list' }, d.notes.length ? d.notes.map(n => h('div', { class: 'note' }, h('div', { class: 'when' }, fmtDateTime(n.created_at)), n.body))
        : h('div', { class: 'empty' }, 'No notes yet.'))),
  );
}

function policyColumns(opt, extra = {}) {
  return [
    { key: 'line', label: 'Line', filterOptions: L().lines, render: r => h('span', null, r.line,
      r.aor_status && r.aor_status !== 'AOR' ? h('span', { class: 'flag', title: `Not AOR yet: ${r.aor_status}` }, ' ⚑') : null) },
    extra.account ? { key: 'account_name', label: 'Account', render: r => accountLink(r) } : null,
    { key: 'carrier', label: 'Carrier' },
    { key: 'policy_number', label: 'Policy #' },
    { key: 'effective_date', label: 'Effective', type: 'date' },
    { key: 'expiration_date', label: 'Expiration', type: 'date', render: r => {
      const days = daysUntil(r.renewal_date);
      return h('span', null, r.expiration_date ? h('span', { class: `dot ${r.renewed_to_id || ['Lost', 'Cancelled'].includes(r.status) ? 'gray' : urgency(days)}` }) : null, fmtDate(r.expiration_date),
        r.multi_year && r.term_end_date ? h('div', { class: 'muted small' }, `term ends ${fmtDate(r.term_end_date)}`) : null);
    } },
    { key: 'premium', label: 'Premium', type: 'money', sum: true },
    { key: 'commission_amt', label: 'Commission', type: 'money', sum: true },
    { key: 'status', label: 'Status', type: 'badge', filterOptions: L().policy_statuses },
    { key: 'aor_status', label: 'AOR', filterOptions: L().aor_statuses, render: r => r.aor_status === 'AOR' ? h('span', { class: 'muted' }, 'AOR') : badge(r.aor_status) },
    extra.territory ? { key: 'territory', label: 'Territory', filterOptions: L().territories } : null,
    { key: 'actions', label: '', sortable: false, filter: false, export: false, render: r => h('span', { class: 'nowrap' },
      !r.renewed_to_id && ['Bound', 'Renewed'].includes(r.status) ? h('button', { class: 'btn btn-sm', title: 'Create next term', onclick: () => renewPolicy(r, opt.onSaved) }, 'Renew') : null, ' ',
      !r.renewed_to_id && !['Bound', 'Renewed', 'Cancelled'].includes(r.status) ? h('button', { class: 'btn btn-sm', title: 'Create a submission for this line', onclick: () => openSubmissionForm(null, { account_id: r.account_id, defaults: { policy_id: r.id, line: r.line }, onSaved: opt.onSaved }) }, 'Submit') : null) },
  ].filter(Boolean);
}

function portfolioTab(d, opt) {
  const wrap = h('div');
  let showHistory = false;
  const render = () => {
    const pols = showHistory ? d.policies : d.policies.filter(p => !p.renewed_to_id);
    const inForce = d.policies.filter(p => !p.renewed_to_id && ['Bound', 'Renewed'].includes(p.status));
    const nym = d.policies.filter(p => !p.renewed_to_id && p.status === 'Not Yet Marketed');
    const notAor = d.policies.filter(p => !p.renewed_to_id && p.aor_status && p.aor_status !== 'AOR');
    const have = new Set(d.policies.filter(p => !p.renewed_to_id).map(p => p.line));
    const missing = CORE_LINES.filter(l => !have.has(l));
    const sum = (arr, k) => arr.reduce((s, p) => s + (Number(p[k]) || 0), 0);
    clear(wrap).append(
      h('div', { class: 'cards' },
        stat('Bound Premium', fmtMoney(sum(inForce, 'premium')), `${inForce.length} bound line${inForce.length === 1 ? '' : 's'}`),
        stat('Bound Commission', fmtMoney(sum(inForce, 'commission_amt'))),
        stat('Cross-sell (Not Yet Marketed)', nym.length, nym.map(p => p.line).join(', '), { cls: nym.length ? 'warn' : '' }),
        stat('Not AOR Yet', notAor.length, notAor.map(p => `${p.line} (${p.aor_status})`).join(', '), { cls: notAor.length ? 'warn' : '' })),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn btn-primary', onclick: () => openPolicyForm(null, opt) }, '+ Policy'),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: showHistory, onchange: (e) => { showHistory = e.target.checked; render(); } }), 'Show prior terms'),
        h('div', { class: 'spacer' }),
        h('span', { class: 'legend' }, h('span', null, h('span', { class: 'flag' }, '⚑'), ' not AOR'), h('span', null, h('span', { class: 'dot yellow' }), 'highlighted = Not Yet Marketed')),
        h('button', { class: 'btn btn-sm', onclick: () => window.print() }, '⎙ Print')),
      DataTable({
        name: `Portfolio - ${d.account.named_insured}`, rows: pols, search: false,
        emptyText: 'No policies yet. Add every line, including ones not yet marketed, to see the full picture.',
        rowClass: r => r.renewed_to_id ? 'row-history' : (r.status === 'Not Yet Marketed' ? 'row-nym' : ''),
        onRowClick: r => openPolicyForm(r, opt),
        defaultSort: { key: 'line', dir: 1 },
        columns: policyColumns(opt),
      }),
      h('p', { class: 'muted small' }, 'Table totals include every line shown (including not-yet-marketed estimates). Bound totals above count Bound/Renewed lines only.'),
      missing.length ? h('div', { class: 'panel', style: { marginTop: '12px' } },
        h('h3', null, 'Lines not on file — cross-sell ideas'),
        h('div', null, missing.map(l => h('button', { class: 'btn btn-sm', style: { margin: '0 6px 6px 0' },
          onclick: () => openPolicyForm(null, Object.assign({}, opt, { defaults: { line: l, status: 'Not Yet Marketed', aor_status: 'Not AOR' } })) }, '+ ' + l)))) : null,
    );
  };
  render();
  return wrap;
}

function submissionColumns(extra = {}) {
  return [
    extra.account ? { key: 'account_name', label: 'Account', render: r => accountLink(r) } : null,
    { key: 'line', label: 'Line', filterOptions: L().lines },
    { key: 'carrier', label: 'Carrier' },
    { key: 'wholesaler', label: 'Wholesaler/MGA' },
    { key: 'date_submitted', label: 'Submitted', type: 'date' },
    { key: 'status', label: 'Status', type: 'badge', filterOptions: L().submission_statuses },
    { key: 'target_premium', label: 'Target', type: 'money' },
    { key: 'quote_amount', label: 'Quote', type: 'money' },
    { key: 'quote_date', label: 'Quote Date', type: 'date' },
    { key: 'placement_exec', label: 'Placement Exec' },
    { key: 'subj', label: 'Subjectivities', value: r => r.subj_total ? `${r.subj_done}/${r.subj_total}` : '', cls: 'nowrap' },
    { key: 'decline_reason', label: 'Decline Reason' },
  ].filter(Boolean);
}

function submissionsTab(d, opt) {
  return h('div', null,
    h('div', { class: 'toolbar' }, h('button', { class: 'btn btn-primary', onclick: () => openSubmissionForm(null, opt) }, '+ Submission'),
      h('span', { class: 'muted small' }, 'Click a row to see details and the subjectivities checklist.')),
    DataTable({
      name: `Submissions - ${d.account.named_insured}`, rows: d.submissions, emptyText: 'No submissions yet.',
      onRowClick: r => openSubmissionDetail(r, refreshRoute), columns: submissionColumns(),
    }));
}

function documentsTab(d, opt) {
  const groups = {};
  d.documents.forEach(doc => { (groups[doc.line || 'General'] = groups[doc.line || 'General'] || []).push(doc); });
  const lineSel = h('select', null, h('option', { value: '' }, 'Add checklist for line…'), L().lines.map(l => h('option', { value: l }, l)));
  const addChecklist = async () => {
    if (!lineSel.value) return;
    await api(`/accounts/${d.account.id}/populate_docs`, { method: 'POST', body: { line: lineSel.value } });
    toast(`${lineSel.value} checklist added`);
    refreshRoute();
  };
  return h('div', null,
    h('div', { class: 'toolbar' }, lineSel, h('button', { class: 'btn', onclick: addChecklist }, 'Add checklist'),
      h('button', { class: 'btn', onclick: () => openDocumentForm(null, opt) }, '+ Custom item'),
      h('div', { class: 'spacer' }),
      h('span', { class: 'muted small' }, 'Marking an item "Requested" creates a 7-day follow-up task. Loss runs also appear in the Loss Run tracker.')),
    Object.keys(groups).length ? Object.entries(groups).map(([line, docs]) => h('div', { class: 'doc-group' },
      h('h3', null, line, h('span', { class: 'muted small', style: { textTransform: 'none' } },
        `${docs.filter(x => x.status === 'Received' || x.status === 'N/A').length}/${docs.length} complete`),
        h('button', { class: 'btn btn-sm', onclick: () => openDocumentForm(null, Object.assign({}, opt, { defaults: { line: line === 'General' ? null : line } })) }, '+ item')),
      DataTable({
        name: `Documents - ${d.account.named_insured} - ${line}`, rows: docs, search: false, filters: false,
        onRowClick: r => openDocumentForm(r, opt),
        columns: documentColumns(),
      }))) : h('div', { class: 'panel empty' }, 'No documents yet. Creating a submission auto-populates the standard checklist for that line, or add one above.'));
}

function documentColumns(extra = {}) {
  return [
    extra.account ? { key: 'account_name', label: 'Account', render: r => accountLink(r) } : null,
    extra.account ? { key: 'line', label: 'Line', filterOptions: L().lines } : null,
    { key: 'name', label: 'Document' },
    { key: 'status', label: 'Status', filterOptions: extra.account ? L().doc_statuses : null, render: r => docStatusSelect(r), exportValue: r => r.status },
    { key: 'date_requested', label: 'Requested', type: 'date' },
    { key: 'date_received', label: 'Received', type: 'date' },
    { key: 'days_outstanding', label: 'Days Out', type: 'number', value: r => r.status === 'Requested' ? r.days_outstanding : null },
    { key: 'notes', label: 'Notes' },
  ].filter(Boolean);
}

function lossRunColumns(extra = {}) {
  return [
    extra.account ? { key: 'account_name', label: 'Account', render: r => accountLink(r) } : null,
    { key: 'carrier', label: 'Carrier' },
    { key: 'line', label: 'Line', filterOptions: L().lines },
    { key: 'date_requested', label: 'Requested', type: 'date' },
    { key: 'status', label: 'Status', filterOptions: L().loss_run_statuses, exportValue: r => r.status, render: r => h('select', {
      class: 'inline', onchange: async (e) => { await R.update('loss_runs', r.id, { status: e.target.value }); toast('Updated'); refreshRoute(); },
    }, L().loss_run_statuses.map(s => h('option', { value: s, selected: s === r.status }, s))) },
    { key: 'days_outstanding', label: 'Days Outstanding', type: 'number', render: r => {
      const n = r.days_outstanding;
      if (r.status !== 'Requested') return h('span', { class: 'muted' }, r.status === 'Received' ? `${n}d to receive` : '');
      return badge(`${n} days`, n > 30 ? 'red' : n > 14 ? 'yellow' : 'gray');
    } },
    { key: 'date_received', label: 'Received', type: 'date' },
    extra.account ? { key: 'territory', label: 'Territory', filterOptions: L().territories } : null,
    { key: 'notes', label: 'Notes' },
  ].filter(Boolean);
}

function lossRunsTab(d, opt) {
  return h('div', null,
    h('div', { class: 'toolbar' }, h('button', { class: 'btn btn-primary', onclick: () => openLossRunForm(null, opt) }, '+ Loss Run Request')),
    DataTable({ name: `Loss Runs - ${d.account.named_insured}`, rows: d.loss_runs, onRowClick: r => openLossRunForm(r, opt),
      columns: lossRunColumns(), defaultSort: { key: 'days_outstanding', dir: -1 } }));
}

function activityColumns(extra = {}) {
  return [
    { key: 'activity_date', label: 'Date', type: 'date' },
    { key: 'type', label: 'Type', filterOptions: L().activity_types },
    extra.account ? { key: 'account_name', label: 'Account', render: r => accountLink(r) } : null,
    { key: 'summary', label: 'Summary' },
    { key: 'next_step', label: 'Next Step' },
    { key: 'follow_up_date', label: 'Follow-up', type: 'date', render: r => r.follow_up_date ? h('span', { class: r.follow_up_done ? 'muted' : (r.follow_up_date < todayISO() ? 'flag' : '') },
      fmtDate(r.follow_up_date), r.follow_up_done ? ' ✓' : '') : '' },
    { key: 'priority', label: 'Priority', type: 'badge', filterOptions: L().priorities },
  ].filter(Boolean);
}

function activityTab(d, opt) {
  return h('div', null,
    h('div', { class: 'toolbar' }, h('button', { class: 'btn btn-primary', onclick: () => openActivityForm(null, opt) }, '+ Log Activity'),
      h('button', { class: 'btn', onclick: () => openActivityForm(null, Object.assign({}, opt, { defaults: { type: 'Call' } })) }, '☎ Log Call')),
    DataTable({ name: `Activity - ${d.account.named_insured}`, rows: d.activities, onRowClick: r => openActivityForm(r, opt), columns: activityColumns() }));
}

function taskColumns(extra = {}) {
  return [
    { key: 'done', label: '✓', sortable: false, filter: false, export: false, render: r => taskCheckbox(r) },
    { key: 'title', label: 'Task' },
    extra.account ? { key: 'account_name', label: 'Account', render: r => accountLink(r) } : null,
    { key: 'due_date', label: 'Due', type: 'date' },
    { key: 'priority', label: 'Priority', type: 'badge', filterOptions: L().priorities,
      value: r => r.priority, sortValue: r => ({ High: 0, Medium: 1, Low: 2 })[r.priority] },
    { key: 'category', label: 'Category', filterOptions: L().task_categories },
    { key: 'assigned_to', label: 'Assigned To', filterOptions: L().teams },
    { key: 'status', label: 'Status', type: 'badge', filterOptions: L().task_statuses },
  ].filter(Boolean);
}

function taskRowClass(r) {
  if (r.status === 'Done') return 'row-done';
  return r.due_date && r.due_date < todayISO() ? 'row-overdue' : '';
}

function tasksTab(d, opt) {
  return h('div', null,
    h('div', { class: 'toolbar' }, h('button', { class: 'btn btn-primary', onclick: () => openTaskForm(null, opt) }, '+ Task')),
    DataTable({ name: `Tasks - ${d.account.named_insured}`, rows: d.tasks, rowClass: taskRowClass, onRowClick: r => openTaskForm(r, opt), columns: taskColumns() }));
}

function teamColumns(extra = {}) {
  return [
    extra.account ? { key: 'account_name', label: 'Account', render: r => accountLink(r) } : null,
    { key: 'role', label: 'Role', filterOptions: L().team_roles },
    { key: 'person_name', label: 'Team Member / Dept' },
    { key: 'handoff_date', label: 'Handoff Date', type: 'date' },
    { key: 'handoff_status', label: 'Status', filterOptions: L().handoff_statuses, exportValue: r => r.handoff_status, render: r => h('select', {
      class: 'inline', onchange: async (e) => { await R.update('team', r.id, { handoff_status: e.target.value }); toast('Updated'); refreshRoute(); },
    }, L().handoff_statuses.map(s => h('option', { value: s, selected: s === r.handoff_status }, s))) },
    { key: 'notes', label: 'Notes' },
  ].filter(Boolean);
}

function teamTab(d, opt) {
  return h('div', null,
    h('div', { class: 'toolbar' }, h('button', { class: 'btn btn-primary', onclick: () => openTeamForm(null, opt) }, '+ Handoff')),
    DataTable({ name: `Internal Team - ${d.account.named_insured}`, rows: d.team, onRowClick: r => openTeamForm(r, opt), columns: teamColumns() }));
}

route('/policies', async (main, params, query) => {
  const rows = await R.list('policies');
  const showHistory = query.history === '1';
  const shown = showHistory ? rows : rows.filter(r => !r.renewed_to_id);
  const opt = { onSaved: refreshRoute };
  clear(main).append(
    pageHead('Policies',
      h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: showHistory, onchange: (e) => { location.hash = '#/policies' + (e.target.checked ? '?history=1' : ''); } }), 'Show prior terms'),
      h('button', { class: 'btn btn-primary', onclick: () => openPolicyForm(null, opt) }, '+ Policy')),
    DataTable({
      name: 'Policies', rows: shown, emptyText: 'No policies yet.',
      rowClass: r => r.renewed_to_id ? 'row-history' : (r.status === 'Not Yet Marketed' ? 'row-nym' : ''),
      onRowClick: r => openPolicyForm(r, opt), defaultSort: { key: 'expiration_date', dir: 1 },
      columns: policyColumns(opt, { account: true, territory: true }),
    }));
});
