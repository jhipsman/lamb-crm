/* Reports: book of business, renewals, pipeline, submissions, commission, lost business. */
'use strict';

const REPORTS = [
  ['book', 'Book of Business'],
  ['renewals', 'Renewals by Date Range'],
  ['pipeline', 'Pipeline by Stage'],
  ['submissions', 'Submissions by Carrier & Status'],
  ['commission', 'Commission by Period'],
  ['lost', 'Lost Business'],
];

route('/reports', async (main, params, query) => {
  const name = query.r || 'book';
  const go = (changes) => { location.hash = '#/reports?' + new URLSearchParams(Object.entries(Object.assign({}, query, changes)).filter(([, v]) => v)).toString(); };
  const title = (REPORTS.find(r => r[0] === name) || REPORTS[0])[1];
  const st = L().settings;
  const body = h('div');
  clear(main).append(
    pageHead('Reports', h('button', { class: 'btn', onclick: () => window.print() }, '⎙ Print')),
    tabs(REPORTS.map(([k, l]) => [k, l]), name, (k) => go({ r: k, start: '', end: '', stage: '', carrier: '', status: '', group: '' })),
    h('div', { class: 'print-only muted small', style: { marginBottom: '8px' } },
      [st.user_name, st.user_title, st.agency_name].filter(Boolean).join(', '), ' — ', title, ' — ', fmtDate(todayISO())),
    body);
  await (REPORT_RENDERERS[name] || REPORT_RENDERERS.book)(body, query, go, title);
});

const REPORT_RENDERERS = {
  async book(body, q, go, title) {
    const rows = await api('/reports/book');
    const accts = new Set(rows.map(r => r.account_id));
    body.append(
      h('div', { class: 'cards' }, stat('Active Accounts', accts.size), stat('Bound Lines', rows.filter(r => r.line).length),
        stat('In-Force Premium', fmtMoney(rows.reduce((s, r) => s + (r.premium || 0), 0))), stat('Commission', fmtMoney(rows.reduce((s, r) => s + (r.commission_amt || 0), 0)))),
      DataTable({
        name: title, rows, emptyText: 'No active accounts (Active Client / BOR Won) yet.',
        columns: [
          { key: 'account_name', label: 'Account', render: r => accountLink(r) },
          { key: 'dba', label: 'DBA' },
          { key: 'account_status', label: 'Status', filterOptions: ['Active Client', 'BOR Won'] },
          { key: 'territory', label: 'Territory', filterOptions: L().territories },
          { key: 'line', label: 'Line', filterOptions: L().lines },
          { key: 'carrier', label: 'Carrier' },
          { key: 'policy_number', label: 'Policy #' },
          { key: 'effective_date', label: 'Effective', type: 'date' },
          { key: 'expiration_date', label: 'Expiration', type: 'date' },
          { key: 'premium', label: 'Premium', type: 'money', sum: true },
          { key: 'commission_pct', label: 'Comm %', type: 'pct' },
          { key: 'commission_amt', label: 'Commission', type: 'money', sum: true },
        ],
      }));
  },

  async renewals(body, q, go, title) {
    const t = todayISO();
    const start = q.start || t, end = q.end || addDaysISO(t, 120);
    const rows = await api(`/reports/renewals?start=${start}&end=${end}`);
    const s = h('input', { type: 'date', value: start }), e = h('input', { type: 'date', value: end });
    body.append(
      h('div', { class: 'toolbar' }, 'From', s, 'to', e, h('button', { class: 'btn btn-sm', onclick: () => go({ start: s.value, end: e.value }) }, 'Run')),
      DataTable({
        name: `${title} ${start} to ${end}`, rows, emptyText: 'No renewals in range.', defaultSort: { key: 'renewal_date', dir: 1 },
        columns: [
          { key: 'renewal_date', label: 'Renewal', type: 'date', render: r => h('span', null, h('span', { class: `dot ${urgency(daysUntil(r.renewal_date))}` }), fmtDate(r.renewal_date)) },
          { key: 'days', label: 'Days', type: 'number', value: r => daysUntil(r.renewal_date) },
          { key: 'account_name', label: 'Account', render: r => accountLink(r) },
          { key: 'line', label: 'Line', filterOptions: L().lines },
          { key: 'carrier', label: 'Carrier' },
          { key: 'policy_number', label: 'Policy #' },
          { key: 'premium', label: 'Premium', type: 'money', sum: true },
          { key: 'commission_amt', label: 'Commission', type: 'money', sum: true },
          { key: 'status', label: 'Status', filterOptions: L().policy_statuses },
          { key: 'aor_status', label: 'AOR', filterOptions: L().aor_statuses },
          { key: 'territory', label: 'Territory', filterOptions: L().territories },
        ],
      }));
  },

  async pipeline(body, q, go, title) {
    const d = await api('/reports/pipeline' + (q.stage ? `?stage=${encodeURIComponent(q.stage)}` : ''));
    const stages = L().pipeline_stages;
    body.append(
      h('div', { class: 'toolbar' }, selectFilter('stages', stages, q.stage || '', v => go({ stage: v }))),
      h('div', { class: 'panel', style: { marginBottom: '14px' } }, h('h2', null, 'Summary by stage'),
        DataTable({ name: 'Pipeline summary', rows: d.summary, search: false, filters: false, columns: [
          { key: 'stage', label: 'Stage', sortValue: r => stages.indexOf(r.stage) },
          { key: 'count', label: 'Count', type: 'number', sum: true },
          { key: 'est_premium', label: 'Est. Premium', type: 'money', sum: true },
          { key: 'est_commission', label: 'Est. Commission', type: 'money', sum: true },
        ] })),
      DataTable({
        name: title, rows: d.rows, emptyText: 'No prospects.',
        columns: [
          { key: 'stage', label: 'Stage', filterOptions: stages, sortValue: r => stages.indexOf(r.stage) },
          { key: 'account_name', label: 'Account', render: r => accountLink(r) },
          { key: 'territory', label: 'Territory', filterOptions: L().territories },
          { key: 'source', label: 'Source', filterOptions: L().lead_sources },
          { key: 'est_premium', label: 'Est. Premium', type: 'money', sum: true },
          { key: 'est_commission', label: 'Est. Commission', type: 'money', sum: true },
          { key: 'stage_entered_at', label: 'In Stage Since', type: 'date', value: r => (r.stage_entered_at || '').slice(0, 10) },
          { key: 'days_in_stage', label: 'Days', type: 'number' },
          { key: 'target_date', label: 'Target', type: 'date' },
          { key: 'lost_reason', label: 'Reason Lost' },
        ],
      }));
  },

  async submissions(body, q, go, title) {
    const qs = new URLSearchParams(Object.entries({ carrier: q.carrier, status: q.status, start: q.start, end: q.end }).filter(([, v]) => v)).toString();
    const d = await api('/reports/submissions?' + qs);
    const s = h('input', { type: 'date', value: q.start || '' }), e = h('input', { type: 'date', value: q.end || '' });
    const statuses = L().submission_statuses;
    body.append(
      h('div', { class: 'toolbar' },
        selectFilter('carriers', L().carriers, q.carrier || '', v => go({ carrier: v })),
        selectFilter('statuses', statuses, q.status || '', v => go({ status: v })),
        'Submitted', s, 'to', e, h('button', { class: 'btn btn-sm', onclick: () => go({ start: s.value, end: e.value }) }, 'Run')),
      h('div', { class: 'panel', style: { marginBottom: '14px' } }, h('h2', null, 'By carrier & status'),
        DataTable({ name: 'Submissions by carrier', rows: d.pivot.map(p => Object.assign({ total: statuses.reduce((s2, k) => s2 + (p[k] || 0), 0) }, p)), search: false, filters: false,
          emptyText: 'No submissions.',
          columns: [{ key: 'carrier', label: 'Carrier' }, ...statuses.map(k => ({ key: k, label: k, type: 'number', sum: true })),
            { key: 'total', label: 'Total', type: 'number', sum: true },
            { key: 'hit', label: 'Bind Ratio', type: 'pct', value: r => r.total ? Math.round((r.Bound || 0) / r.total * 1000) / 10 : null }] })),
      DataTable({
        name: title, rows: d.rows, emptyText: 'No submissions.',
        columns: [
          { key: 'carrier', label: 'Carrier' },
          { key: 'status', label: 'Status', type: 'badge', filterOptions: statuses },
          { key: 'account_name', label: 'Account', render: r => accountLink(r) },
          { key: 'line', label: 'Line', filterOptions: L().lines },
          { key: 'wholesaler', label: 'Wholesaler/MGA' },
          { key: 'date_submitted', label: 'Submitted', type: 'date' },
          { key: 'target_premium', label: 'Target', type: 'money' },
          { key: 'quote_amount', label: 'Quote', type: 'money' },
          { key: 'quote_date', label: 'Quote Date', type: 'date' },
          { key: 'placement_exec', label: 'Placement Exec' },
          { key: 'decline_reason', label: 'Decline Reason' },
        ],
      }));
  },

  async commission(body, q, go, title) {
    const group = q.group || 'month';
    const qs = new URLSearchParams(Object.entries({ group, line: q.line, carrier: q.carrier, start: q.start, end: q.end }).filter(([, v]) => v)).toString();
    const rows = await api('/reports/commission?' + qs);
    const s = h('input', { type: 'date', value: q.start || '' }), e = h('input', { type: 'date', value: q.end || '' });
    body.append(
      h('div', { class: 'toolbar' },
        h('div', { class: 'btn-group' }, ['month', 'quarter', 'year'].map(g => h('button', { class: 'btn btn-sm' + (group === g ? ' active' : ''), onclick: () => go({ group: g }) }, g[0].toUpperCase() + g.slice(1)))),
        selectFilter('lines', L().lines, q.line || '', v => go({ line: v })),
        selectFilter('carriers', L().carriers, q.carrier || '', v => go({ carrier: v })),
        'Effective', s, 'to', e, h('button', { class: 'btn btn-sm', onclick: () => go({ start: s.value, end: e.value }) }, 'Run')),
      DataTable({
        name: `${title} by ${group}`, rows, search: false, emptyText: 'No bound policies with effective dates.',
        columns: [
          { key: 'period', label: group[0].toUpperCase() + group.slice(1), render: r => group === 'month' ? monthName(r.period) : r.period, exportValue: r => r.period },
          { key: 'policies', label: 'Policies', type: 'number', sum: true },
          { key: 'premium', label: 'Bound Premium', type: 'money', sum: true },
          { key: 'commission', label: 'Commission', type: 'money', sum: true },
        ],
      }));
  },

  async lost(body, q, go, title) {
    const rows = await api('/reports/lost');
    const reasons = {};
    rows.filter(r => r.kind === 'Prospect').forEach(r => { reasons[r.reason || '(none)'] = (reasons[r.reason || '(none)'] || 0) + 1; });
    body.append(
      h('div', { class: 'cards' }, stat('Lost Prospects', rows.filter(r => r.kind === 'Prospect').length), stat('Lost Policies', rows.filter(r => r.kind === 'Policy').length),
        stat('Lost Premium', fmtMoney(rows.reduce((s, r) => s + (r.premium || 0), 0))),
        Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => stat(`Reason: ${k}`, v))),
      DataTable({
        name: title, rows, emptyText: 'No lost business recorded.', defaultSort: { key: 'lost_date', dir: -1 },
        columns: [
          { key: 'kind', label: 'Type', filterOptions: ['Prospect', 'Policy'] },
          { key: 'account_name', label: 'Account', render: r => accountLink(r) },
          { key: 'line', label: 'Line' },
          { key: 'carrier', label: 'Carrier' },
          { key: 'premium', label: 'Premium', type: 'money', sum: true },
          { key: 'lost_date', label: 'Date', type: 'date' },
          { key: 'reason', label: 'Reason', filterOptions: L().lost_reasons },
          { key: 'detail', label: 'Detail' },
          { key: 'source', label: 'Source' },
          { key: 'territory', label: 'Territory', filterOptions: L().territories },
        ],
      }));
  },
};
