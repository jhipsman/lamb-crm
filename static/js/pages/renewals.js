/* Renewal calendar (month grid + list) with urgency colour coding. */
'use strict';

route('/renewals', async (main, params, query) => {
  const view = query.view || 'calendar';
  const t = todayISO();
  const month = query.month || t.slice(0, 7);
  const filters = { line: query.line || '', carrier: query.carrier || '', territory: query.territory || '' };
  const go = (changes) => {
    const q = Object.assign({ view, month, start: query.start, end: query.end }, filters, changes);
    location.hash = '#/renewals?' + new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
  };

  let start, end;
  const [y, m] = month.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const gridStart = new Date(first); gridStart.setDate(1 - first.getDay());
  const gridEnd = new Date(gridStart); gridEnd.setDate(gridStart.getDate() + 41);
  if (view === 'calendar') { start = toISO(gridStart); end = toISO(gridEnd); }
  else { start = query.start || t; end = query.end || addDaysISO(t, 120); }

  const rows = await api('/renewals?' + new URLSearchParams(Object.assign({ start, end }, Object.fromEntries(Object.entries(filters).filter(([, v]) => v)))));
  rows.forEach(r => { r.days = daysUntil(r.renewal_date); });

  const legend = h('div', { class: 'legend' },
    h('span', null, h('span', { class: 'dot red' }), '≤ 30 days'), h('span', null, h('span', { class: 'dot yellow' }), '31–60'),
    h('span', null, h('span', { class: 'dot green' }), '61–90'), h('span', null, h('span', { class: 'dot blue' }), '91–120'),
    h('span', null, h('span', { class: 'dot gray' }), '> 120'));

  const toolbar = h('div', { class: 'toolbar' },
    h('div', { class: 'btn-group' },
      h('button', { class: 'btn btn-sm' + (view === 'calendar' ? ' active' : ''), onclick: () => go({ view: 'calendar' }) }, 'Calendar'),
      h('button', { class: 'btn btn-sm' + (view === 'list' ? ' active' : ''), onclick: () => go({ view: 'list' }) }, 'List')),
    selectFilter('lines', L().lines, filters.line, v => go({ line: v })),
    selectFilter('carriers', L().carriers, filters.carrier, v => go({ carrier: v })),
    selectFilter('territories', L().territories, filters.territory, v => go({ territory: v })),
    h('div', { class: 'spacer' }), legend);

  clear(main).append(pageHead('Renewal Calendar'), toolbar);

  if (view === 'calendar') {
    const shift = (n) => { const d = new Date(y, m - 1 + n, 1); go({ month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` }); };
    const inMonth = rows.filter(r => r.renewal_date.slice(0, 7) === month);
    main.append(
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn btn-sm', onclick: () => shift(-1) }, '‹ Prev'),
        h('button', { class: 'btn btn-sm', onclick: () => go({ month: t.slice(0, 7) }) }, 'Today'),
        h('button', { class: 'btn btn-sm', onclick: () => shift(1) }, 'Next ›'),
        h('h2', { style: { margin: '0 10px' } }, first.toLocaleString('en-US', { month: 'long', year: 'numeric' })),
        h('span', { class: 'muted' }, `${inMonth.length} renewal${inMonth.length === 1 ? '' : 's'} · ${fmtMoney(inMonth.reduce((s, r) => s + (r.premium || 0), 0))} premium`)),
      calendarGrid(gridStart, month, rows));
  } else {
    const startIn = h('input', { type: 'date', value: start });
    const endIn = h('input', { type: 'date', value: end });
    main.append(
      h('div', { class: 'toolbar' }, 'From', startIn, 'to', endIn,
        h('button', { class: 'btn btn-sm', onclick: () => go({ start: startIn.value, end: endIn.value }) }, 'Apply'),
        [30, 60, 90, 120, 365].map(n => h('button', { class: 'btn btn-sm', onclick: () => go({ start: t, end: addDaysISO(t, n) }) }, `Next ${n}`)),
        h('button', { class: 'btn btn-sm', onclick: () => go({ start: addDaysISO(t, -60), end: t }) }, 'Past 60')),
      DataTable({
        name: 'Renewals', rows, emptyText: 'No renewals in this range.', defaultSort: { key: 'renewal_date', dir: 1 },
        onRowClick: r => showRenewal(r),
        columns: [
          { key: 'renewal_date', label: 'Renewal', type: 'date', render: r => h('span', null, h('span', { class: `dot ${urgency(r.days)}` }), fmtDate(r.renewal_date)) },
          { key: 'days', label: 'Days', type: 'number' },
          { key: 'account_name', label: 'Account', render: r => accountLink(r) },
          { key: 'line', label: 'Line', filterOptions: L().lines },
          { key: 'carrier', label: 'Carrier' },
          { key: 'policy_number', label: 'Policy #' },
          { key: 'premium', label: 'Premium', type: 'money', sum: true },
          { key: 'commission_amt', label: 'Commission', type: 'money', sum: true },
          { key: 'status', label: 'Status', type: 'badge', filterOptions: L().policy_statuses },
          { key: 'aor_status', label: 'AOR', filterOptions: L().aor_statuses },
          { key: 'territory', label: 'Territory', filterOptions: L().territories },
        ],
      }));
  }
});

function calendarGrid(gridStart, month, rows) {
  const byDay = {};
  rows.forEach(r => { (byDay[r.renewal_date] = byDay[r.renewal_date] || []).push(r); });
  const t = todayISO();
  const cal = h('div', { class: 'cal' }, ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map(d => h('div', { class: 'dow' }, d)));
  for (let i = 0; i < 42; i++) {
    const d = new Date(gridStart); d.setDate(gridStart.getDate() + i);
    const iso = toISO(d);
    const items = byDay[iso] || [];
    cal.appendChild(h('div', { class: 'day' + (iso.slice(0, 7) !== month ? ' other' : '') + (iso === t ? ' today' : '') },
      h('span', { class: 'dnum' }, d.getDate()),
      items.map(r => h('span', { class: `chip ${urgency(r.days)}`, title: `${r.account_name} — ${r.line} (${r.carrier || 'no carrier'}) ${fmtMoney(r.premium)}`,
        onclick: () => showRenewal(r) }, `${r.line} · ${r.account_name}`))));
  }
  return cal;
}

async function showRenewal(r) {
  const d = await api(`/accounts/${r.account_id}/full`);
  const pols = d.policies.filter(p => !p.renewed_to_id);
  const primary = d.contacts[0];
  const reopen = () => { m.close(); refreshRoute(); };
  const m = openModal({
    title: d.account.named_insured, wide: true,
    body: h('div', null,
      h('div', { class: 'cards' },
        stat('Renewing', `${r.line}`, `${fmtDate(r.renewal_date)} · ${r.days} days`, { cls: r.days <= 30 ? 'alert' : r.days <= 60 ? 'warn' : '' }),
        stat('Account Status', d.account.status, d.account.territory || '', { cls: 'text' }),
        stat('Primary Contact', primary ? primary.name : '—', primary ? [primary.title, primary.phone, primary.email].filter(Boolean).join(' · ') : '', { cls: 'text' }),
        stat('Bound Premium', fmtMoney(pols.filter(p => ['Bound', 'Renewed'].includes(p.status)).reduce((s, p) => s + (p.premium || 0), 0)))),
      h('h3', null, 'All policies on this account'),
      DataTable({ name: `Portfolio - ${d.account.named_insured}`, rows: pols, search: false, filters: false,
        rowClass: p => (p.id === r.id ? 'row-overdue ' : '') + (p.status === 'Not Yet Marketed' ? 'row-nym' : ''),
        columns: policyColumns({ onSaved: reopen }) })),
    actions: [{ label: 'Create renewal task', onclick: (mm) => { mm.close(); openTaskForm(null, { defaults: { account_id: r.account_id, title: `Renewal prep: ${r.line} (${fmtDate(r.renewal_date)})`, category: 'Renewal Prep', due_date: addDaysISO(r.renewal_date, -90) > todayISO() ? addDaysISO(r.renewal_date, -90) : todayISO() } }); } },
      'spacer', { label: 'Open account', class: 'btn-primary', onclick: (mm) => { mm.close(); location.hash = `#/accounts/${r.account_id}?tab=portfolio`; } }],
  });
}
