/* Commission book: bound premium, commission, projections and year-over-year. */
'use strict';

route('/commission', async (main, params, query) => {
  const f = { account_id: query.account_id || '', line: query.line || '', carrier: query.carrier || '', territory: query.territory || '',
    start: query.start || '', end: query.end || '', year: query.year || String(new Date().getFullYear()) };
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  const [d, accounts] = await Promise.all([api('/commission?' + qs), accountsCache()]);
  const go = (changes) => { location.hash = '#/commission?' + new URLSearchParams(Object.entries(Object.assign({}, f, changes)).filter(([, v]) => v)).toString(); };

  const startIn = h('input', { type: 'date', value: f.start, title: 'Effective from' });
  const endIn = h('input', { type: 'date', value: f.end, title: 'Effective to' });
  const yearSel = h('select', { onchange: (e) => go({ year: e.target.value }) });
  const years = new Set(d.by_year.map(y => y.year)); years.add(String(new Date().getFullYear())); years.add(f.year);
  Array.from(years).sort().reverse().forEach(y => yearSel.appendChild(h('option', { value: y, selected: y === f.year }, y)));
  const acctSel = h('select', { onchange: (e) => go({ account_id: e.target.value }) }, h('option', { value: '' }, 'All accounts'),
    accounts.filter(a => a.policy_count).map(a => h('option', { value: a.id, selected: String(a.id) === f.account_id }, a.named_insured)));

  const y = Number(f.year);
  const monthRows = d.months.map(m => Object.assign({ label: `${MONTHS[m.month - 1]} ${y}` }, m,
    { yoy: m.prior_year_commission ? m.commission - m.prior_year_commission : null }));
  const ytd = d.months.filter(m => y < new Date().getFullYear() || m.month <= new Date().getMonth() + 1).reduce((s, m) => s + m.commission, 0);
  const hasYoY = d.by_year.length > 1;

  clear(main).append(
    pageHead('Commission Book'),
    h('div', { class: 'toolbar' }, acctSel,
      selectFilter('lines', L().lines, f.line, v => go({ line: v })),
      selectFilter('carriers', L().carriers, f.carrier, v => go({ carrier: v })),
      selectFilter('territories', L().territories, f.territory, v => go({ territory: v })),
      h('span', { class: 'muted small' }, 'Effective'), startIn, h('span', { class: 'muted small' }, 'to'), endIn,
      h('button', { class: 'btn btn-sm', onclick: () => go({ start: startIn.value, end: endIn.value }) }, 'Apply'),
      h('button', { class: 'btn btn-sm btn-ghost', onclick: () => { location.hash = '#/commission'; } }, 'Reset')),
    h('div', { class: 'cards' },
      stat('Bound Premium (all terms)', fmtMoney(d.totals.premium), `${d.totals.count} bound policies`),
      stat('Commission (all terms)', fmtMoney(d.totals.commission)),
      stat('In-Force Premium', fmtMoney(d.in_force.premium), `${d.in_force.count} in force`),
      stat('Projected Annual Commission', fmtMoney(d.projection.annual), 'in-force run rate'),
      stat('Projected Monthly', fmtMoney(d.projection.monthly), 'annual ÷ 12'),
      stat(`${y} Booked Commission`, fmtMoney(d.months.reduce((s, m) => s + m.commission, 0)), `YTD ${fmtMoney(ytd)}`)),

    h('div', { class: 'grid grid-2', style: { marginBottom: '14px' } },
      h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Monthly'), h('div', { class: 'spacer' }), yearSel),
        DataTable({
          name: `Commission by month ${y}`, rows: monthRows, search: false, filters: false,
          columns: [
            { key: 'label', label: 'Month', sortValue: r => r.month },
            { key: 'premium', label: 'Bound Premium', type: 'money', sum: true },
            { key: 'commission', label: 'Booked Commission', type: 'money', sum: true },
            { key: 'renewing_commission', label: 'Renewing (projected)', type: 'money', sum: true },
            { key: 'prior_year_commission', label: `${y - 1} Commission`, type: 'money', sum: true },
            { key: 'yoy', label: 'YoY Δ', type: 'money', render: r => r.yoy === null ? '' : h('span', { style: { color: r.yoy >= 0 ? 'var(--ok)' : 'var(--danger)' } }, (r.yoy >= 0 ? '+' : '') + fmtMoney(r.yoy)) },
          ],
        }),
        h('p', { class: 'muted small' }, 'Booked = bound policies by effective month. Renewing = in-force commission whose renewal date falls in that month (what is up for renewal).')),
      h('div', { class: 'panel' },
        h('div', { class: 'panel-head' }, h('h2', null, 'Year over year')),
        DataTable({
          name: 'Commission by year', rows: d.by_year, search: false, filters: false, emptyText: 'No bound policies with effective dates yet.',
          columns: [
            { key: 'year', label: 'Year' },
            { key: 'count', label: 'Policies', type: 'number' },
            { key: 'premium', label: 'Premium', type: 'money' },
            { key: 'commission', label: 'Commission', type: 'money' },
            { key: 'yoy_commission', label: 'Change', type: 'money', render: r => r.yoy_commission === null ? '' : h('span', { style: { color: r.yoy_commission >= 0 ? 'var(--ok)' : 'var(--danger)' } }, (r.yoy_commission >= 0 ? '+' : '') + fmtMoney(r.yoy_commission)) },
            { key: 'yoy_pct', label: 'Change %', type: 'pct', render: r => r.yoy_pct === null ? '' : `${r.yoy_pct >= 0 ? '+' : ''}${r.yoy_pct.toFixed(1)}%` },
          ],
        }),
        hasYoY ? null : h('p', { class: 'muted small' }, 'Year-over-year comparison fills in once you have more than one year of bound policies.'))),

    h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('h2', null, 'Bound policies')),
      DataTable({
        name: 'Commission Book', rows: d.policies, emptyText: 'No bound policies match.', defaultSort: { key: 'effective_date', dir: -1 },
        onRowClick: r => { location.hash = `#/accounts/${r.account_id}?tab=portfolio`; },
        columns: [
          { key: 'account_name', label: 'Account', render: r => accountLink(r) },
          { key: 'line', label: 'Line', filterOptions: L().lines },
          { key: 'carrier', label: 'Carrier' },
          { key: 'policy_number', label: 'Policy #' },
          { key: 'effective_date', label: 'Effective', type: 'date' },
          { key: 'expiration_date', label: 'Expiration', type: 'date' },
          { key: 'premium', label: 'Premium', type: 'money', sum: true },
          { key: 'commission_pct', label: 'Comm %', type: 'pct' },
          { key: 'commission_amt', label: 'Commission', type: 'money', sum: true },
          { key: 'in_force', label: 'In Force', type: 'bool', filterOptions: ['Yes'] },
          { key: 'status', label: 'Status', type: 'badge' },
        ],
      })),
  );
});
