/* Prospecting pipeline: kanban (drag & drop) and list views. */
'use strict';

route('/pipeline', async (main, params, query) => {
  const view = query.view || 'board';
  const all = await R.list('deals');
  const filters = { territory: query.territory || '', source: query.source || '' };
  const deals = all.filter(d => (!filters.territory || d.territory === filters.territory) && (!filters.source || d.source === filters.source));
  const go = (changes) => {
    const q = Object.assign({ view }, filters, changes);
    location.hash = '#/pipeline?' + new URLSearchParams(Object.entries(q).filter(([, v]) => v)).toString();
  };
  const stages = L().pipeline_stages;
  const open = deals.filter(d => !['Won', 'Lost'].includes(d.stage));

  clear(main).append(
    pageHead('Prospecting Pipeline',
      h('button', { class: 'btn', onclick: () => openDealForm(null, { onSaved: refreshRoute }) }, '+ Existing account'),
      h('button', { class: 'btn btn-primary', onclick: () => openAccountForm(null, { defaults: { status: 'Prospect' }, onSaved: refreshRoute }) }, '+ New prospect')),
    h('div', { class: 'cards' },
      stat('Open Prospects', open.length),
      stat('Open Est. Premium', fmtMoney(open.reduce((s, d) => s + (d.est_premium || 0), 0))),
      stat('Open Est. Commission', fmtMoney(open.reduce((s, d) => s + (d.est_commission || 0), 0))),
      stat('Won', deals.filter(d => d.stage === 'Won').length, fmtMoney(deals.filter(d => d.stage === 'Won').reduce((s, d) => s + (d.est_premium || 0), 0))),
      stat('Lost', deals.filter(d => d.stage === 'Lost').length)),
    h('div', { class: 'toolbar' },
      h('div', { class: 'btn-group' },
        h('button', { class: 'btn btn-sm' + (view === 'board' ? ' active' : ''), onclick: () => go({ view: 'board' }) }, 'Board'),
        h('button', { class: 'btn btn-sm' + (view === 'list' ? ' active' : ''), onclick: () => go({ view: 'list' }) }, 'List'),
        h('button', { class: 'btn btn-sm' + (view === 'summary' ? ' active' : ''), onclick: () => go({ view: 'summary' }) }, 'Summary')),
      selectFilter('territories', L().territories, filters.territory, v => go({ territory: v })),
      selectFilter('sources', L().lead_sources, filters.source, v => go({ source: v })),
      h('div', { class: 'spacer' }),
      view === 'board' ? h('span', { class: 'muted small' }, 'Drag cards between stages (or use the dropdown on mobile).') : null),
  );

  if (view === 'board') main.append(kanban(deals, stages));
  else if (view === 'list') main.append(DataTable({
    name: 'Pipeline', rows: deals, emptyText: 'No prospects in the pipeline.',
    onRowClick: r => openDealForm(r, { onSaved: refreshRoute }),
    defaultSort: { key: 'stage', dir: 1 },
    columns: [
      { key: 'account_name', label: 'Account', render: r => accountLink(r) },
      { key: 'stage', label: 'Stage', filterOptions: stages, sortValue: r => stages.indexOf(r.stage), render: r => badge(r.stage, r.stage === 'Won' ? 'green' : r.stage === 'Lost' ? 'red' : 'blue') },
      { key: 'days_in_stage', label: 'Days in Stage', type: 'number' },
      { key: 'stage_entered_at', label: 'Entered Stage', type: 'date', value: r => (r.stage_entered_at || '').slice(0, 10) },
      { key: 'est_premium', label: 'Est. Premium', type: 'money', sum: true },
      { key: 'est_commission', label: 'Est. Commission', type: 'money', sum: true },
      { key: 'source', label: 'Source', filterOptions: L().lead_sources },
      { key: 'territory', label: 'Territory', filterOptions: L().territories },
      { key: 'target_date', label: 'Target Date', type: 'date' },
      { key: 'lost_reason', label: 'Reason Lost', value: r => [r.lost_reason, r.lost_reason_detail].filter(Boolean).join(' — ') },
    ],
  }));
  else main.append(pipelineSummaryTable(deals, stages));
});

function pipelineSummaryTable(deals, stages) {
  const rows = stages.map(s => {
    const ds = deals.filter(d => d.stage === s);
    return { stage: s, count: ds.length, est_premium: ds.reduce((a, d) => a + (d.est_premium || 0), 0), est_commission: ds.reduce((a, d) => a + (d.est_commission || 0), 0),
      avg_days: ds.length ? Math.round(ds.reduce((a, d) => a + (d.days_in_stage || 0), 0) / ds.length) : null };
  });
  return DataTable({
    name: 'Pipeline Summary', rows, search: false, filters: false,
    columns: [
      { key: 'stage', label: 'Stage', sortValue: r => stages.indexOf(r.stage) },
      { key: 'count', label: 'Count', type: 'number', sum: true },
      { key: 'est_premium', label: 'Est. Premium', type: 'money', sum: true },
      { key: 'est_commission', label: 'Est. Commission', type: 'money', sum: true },
      { key: 'avg_days', label: 'Avg Days in Stage', type: 'number' },
    ],
  });
}

async function moveDeal(deal, stage) {
  if (deal.stage === stage) return;
  const body = { stage };
  if (stage === 'Lost') {
    const reason = await askLostReason(deal);
    if (!reason) { refreshRoute(); return; }
    Object.assign(body, reason);
  }
  try {
    await R.update('deals', deal.id, body);
    toast(`${deal.account_name} → ${stage}`);
  } catch (e) { toast(e.message, true); }
  refreshRoute();
}

function kanban(deals, stages) {
  let dragging = null;
  const board = h('div', { class: 'kanban' });
  for (const stage of stages) {
    const ds = deals.filter(d => d.stage === stage);
    const col = h('div', { class: 'kcol' + (stage === 'Won' ? ' won' : stage === 'Lost' ? ' lost' : '') },
      h('div', { class: 'kcol-head' },
        h('div', { class: 'title' }, h('span', null, stage), h('span', { class: 'muted' }, ds.length)),
        h('div', { class: 'sub' }, `${fmtMoney(ds.reduce((s, d) => s + (d.est_premium || 0), 0))} prem · ${fmtMoney(ds.reduce((s, d) => s + (d.est_commission || 0), 0))} comm`)),
      h('div', { class: 'kcol-body' }, ds.map(d => {
        const card = h('div', { class: 'kcard', draggable: 'true' },
          h('div', { class: 'name' }, h('a', { href: `#/accounts/${d.account_id}` }, d.account_name)),
          h('div', { class: 'meta' }, h('span', null, fmtMoney(d.est_premium) || 'no est.'), h('span', null, d.est_commission ? `${fmtMoney(d.est_commission)} comm` : '')),
          h('div', { class: 'meta' }, h('span', null, d.source || ''), h('span', { title: `In stage since ${fmtDateTime(d.stage_entered_at)}` }, `${d.days_in_stage ?? 0}d in stage`)),
          d.stage === 'Lost' && d.lost_reason ? h('div', { class: 'meta' }, h('span', null, `Lost: ${d.lost_reason}`)) : null,
          h('select', { onchange: (e) => moveDeal(d, e.target.value), onclick: (e) => e.stopPropagation() },
            stages.map(s => h('option', { value: s, selected: s === d.stage }, s === d.stage ? `Stage: ${s}` : `Move to ${s}`))));
        card.addEventListener('click', (e) => { if (!e.target.closest('a, select')) openDealForm(d, { onSaved: refreshRoute }); });
        card.addEventListener('dragstart', (e) => { dragging = d; card.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(d.id)); });
        card.addEventListener('dragend', () => { card.classList.remove('dragging'); });
        return card;
      })));
    col.addEventListener('dragover', (e) => { e.preventDefault(); col.classList.add('drag-over'); });
    col.addEventListener('dragleave', (e) => { if (!col.contains(e.relatedTarget)) col.classList.remove('drag-over'); });
    col.addEventListener('drop', (e) => {
      e.preventDefault(); col.classList.remove('drag-over');
      if (dragging) { const d = dragging; dragging = null; moveDeal(d, stage); }
    });
    board.appendChild(col);
  }
  return board;
}
