/* Settings (my info, commission defaults, option lists, checklist templates) and the Archive. */
'use strict';

route('/settings', async (main, params, query) => {
  const tab = query.tab || 'me';
  const body = h('div');
  clear(main).append(pageHead('Settings'),
    tabs([['me', 'My Info'], ['commission', 'Commission Defaults'], ['carriers', 'Carriers'], ['types', 'Account Types'], ['team', 'Team Members'], ['templates', 'Document Templates'], ['data', 'Data & Backup']],
      tab, (k) => { location.hash = `#/settings?tab=${k}`; }),
    body);
  await (SETTINGS_TABS[tab] || SETTINGS_TABS.me)(body);
});

async function saveSettings(payload) {
  S.lookups = await api('/settings', { method: 'PUT', body: payload });
  toast('Settings saved');
}

function simpleListEditor(body, { resource, title, help, placeholder, rows, label = r => r.name, extraFields }) {
  const input = h('input', { type: 'text', placeholder, style: { flex: 1 } });
  const add = async () => {
    const name = input.value.trim();
    if (!name) return;
    await R.create(resource, { name });
    await loadLookups();
    refreshRoute();
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
  body.append(h('div', { class: 'panel', style: { maxWidth: '640px' } },
    h('h2', null, title), help ? h('p', { class: 'muted small' }, help) : null,
    h('div', { style: { display: 'flex', gap: '8px', marginBottom: '10px' } }, input, h('button', { class: 'btn btn-primary', onclick: add }, 'Add')),
    h('ul', { class: 'list' }, rows.map(r => h('li', null, h('span', { class: 'grow' }, label(r)),
      extraFields ? h('button', { class: 'btn btn-sm', onclick: () => extraFields(r) }, 'Edit') : h('button', { class: 'btn btn-sm', onclick: async () => {
        const name = prompt('Rename', r.name);
        if (!name || !name.trim()) return;
        await R.update(resource, r.id, { name: name.trim() }); await loadLookups(); refreshRoute();
      } }, 'Rename'),
      h('button', { class: 'btn btn-sm btn-danger', onclick: async () => { await R.archive(resource, r.id); await loadLookups(); toast('Removed'); refreshRoute(); } }, 'Remove'))))));
}

const SETTINGS_TABS = {
  async me(body) {
    const st = L().settings;
    const form = buildForm([
      { key: 'user_name', label: 'Name' },
      { key: 'user_title', label: 'Title' },
      { key: 'user_email', label: 'Email', type: 'email' },
      { key: 'user_phone', label: 'Phone', type: 'tel' },
      { key: 'agency_name', label: 'Brokerage / Office', full: true },
      { key: 'export_header', label: 'Include my info as a header on CSV exports and printed reports', type: 'checkbox', full: true },
      { key: 'pipeline_commission_pct', label: 'Pipeline est. commission % (used when est. commission is blank)', type: 'pct' },
    ], Object.assign({}, st, { export_header: st.export_header === '1' }));
    body.append(h('div', { class: 'panel', style: { maxWidth: '720px' } }, h('h2', null, 'My info'), form.el,
      h('button', { class: 'btn btn-primary', style: { marginTop: '12px' }, onclick: async () => {
        const v = form.values();
        v.export_header = v.export_header ? '1' : '0';
        v.pipeline_commission_pct = v.pipeline_commission_pct === null ? '' : String(v.pipeline_commission_pct);
        for (const k of Object.keys(v)) if (v[k] === null) v[k] = '';
        await saveSettings({ settings: v });
      } }, 'Save')));
  },

  async commission(body) {
    const inputs = {};
    body.append(h('div', { class: 'panel', style: { maxWidth: '520px' } },
      h('h2', null, 'Default commission % by line'),
      h('p', { class: 'muted small' }, 'Pre-fills Commission % on new policies. Existing policies are not changed.'),
      h('table', null, h('tbody', null, L().lines.map(line => {
        const inp = h('input', { type: 'text', inputmode: 'decimal', value: L().line_defaults[line] ?? '', style: { width: '100px' } });
        inputs[line] = inp;
        return h('tr', null, h('td', null, line), h('td', { class: 'num' }, inp, ' %'));
      }))),
      h('button', { class: 'btn btn-primary', style: { marginTop: '12px' }, onclick: () => saveSettings({ line_defaults: Object.fromEntries(Object.entries(inputs).map(([k, i]) => [k, i.value])) }) }, 'Save')));
  },

  async carriers(body) {
    simpleListEditor(body, { resource: 'carriers', title: 'Carriers', placeholder: 'Add a carrier…', rows: await R.list('carriers'),
      help: 'Used for carrier pickers and filters. You can still type any carrier name on a policy or submission.' });
  },

  async types(body) {
    simpleListEditor(body, { resource: 'account_types', title: 'Account type tags', placeholder: 'Add a custom tag…', rows: await R.list('account_types'),
      help: 'Multi-select tags on accounts. Removing a tag here does not remove it from existing accounts.' });
  },

  async team(body) {
    const rows = await R.list('team_members');
    const edit = (r) => editRecord({ resource: 'team_members', record: r, title: r ? 'Edit team member' : 'New team member',
      fields: [{ key: 'name', label: 'Name', required: true }, { key: 'team', label: 'Team', type: 'select', options: L().teams.filter(t => t !== 'Self') },
        { key: 'email', label: 'Email', type: 'email' }, { key: 'phone', label: 'Phone', type: 'tel' }],
      onSaved: async () => { await loadLookups(); refreshRoute(); }, onArchived: async () => { await loadLookups(); refreshRoute(); } });
    body.append(h('div', { class: 'panel', style: { maxWidth: '720px' } },
      h('div', { class: 'panel-head' }, h('h2', null, 'Internal team members'), h('div', { class: 'spacer' }), h('button', { class: 'btn btn-primary', onclick: () => edit(null) }, '+ Team member')),
      h('p', { class: 'muted small' }, 'Placement execs, account managers and operations contacts. These appear as suggestions on submissions and handoffs.'),
      DataTable({ name: 'Team members', rows, search: false, filters: false, onRowClick: edit, emptyText: 'No team members yet.',
        columns: [{ key: 'name', label: 'Name' }, { key: 'team', label: 'Team' }, { key: 'email', label: 'Email' }, { key: 'phone', label: 'Phone' }] })));
  },

  async templates(body) {
    const rows = await R.list('doc_templates');
    const line = (S.route.query.line) || 'GL';
    const items = rows.filter(r => r.line === line);
    const input = h('input', { type: 'text', placeholder: 'Add document to this line’s checklist…', style: { flex: 1 } });
    const add = async () => {
      if (!input.value.trim()) return;
      await R.create('doc_templates', { line, name: input.value.trim(), sort_order: items.length });
      refreshRoute();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    body.append(h('div', { class: 'panel', style: { maxWidth: '720px' } },
      h('h2', null, 'Document checklist templates'),
      h('p', { class: 'muted small' }, 'When a submission is created for a line, these items are added to the account’s document checklist (skipping any already there).'),
      h('div', { class: 'toolbar' }, h('select', { onchange: (e) => { location.hash = `#/settings?tab=templates&line=${encodeURIComponent(e.target.value)}`; } },
        L().lines.map(l => h('option', { value: l, selected: l === line }, `${l} (${rows.filter(r => r.line === l).length})`)))),
      h('div', { style: { display: 'flex', gap: '8px', marginBottom: '10px' } }, input, h('button', { class: 'btn btn-primary', onclick: add }, 'Add')),
      items.length ? h('ul', { class: 'list' }, items.map(r => h('li', null, h('span', { class: 'grow' }, r.name),
        h('button', { class: 'btn btn-sm btn-danger', onclick: async () => { await R.archive('doc_templates', r.id); refreshRoute(); } }, 'Remove'))))
        : h('div', { class: 'empty' }, 'No template items for this line.')));
  },

  async data(body) {
    body.append(h('div', { class: 'panel', style: { maxWidth: '720px' } },
      h('h2', null, 'Data & backup'),
      h('p', null, 'All data lives in a single SQLite file (', h('code', null, 'data/crm.db'), ' in the app folder). Copy that file to back up, or download a copy here.'),
      h('a', { class: 'btn btn-primary', href: '/api/backup' }, '⤓ Download database backup'),
      h('p', { class: 'muted small', style: { marginTop: '14px' } }, 'Deleted records are archived, not removed — see the ', h('a', { href: '#/archive' }, 'Archive'), ' to restore them.')));
  },
};

route('/archive', async (main) => {
  const rows = await api('/archive');
  const labels = { accounts: 'Account', contacts: 'Contact', policies: 'Policy', deals: 'Pipeline', submissions: 'Submission', documents: 'Document',
    loss_runs: 'Loss Run', activities: 'Activity', tasks: 'Task', team: 'Handoff' };
  clear(main).append(pageHead('Archive'),
    h('p', { class: 'muted' }, 'Archived (soft-deleted) records. Restore puts them back exactly as they were.'),
    DataTable({
      name: 'Archive', rows, emptyText: 'Nothing archived.',
      columns: [
        { key: 'resource', label: 'Type', value: r => labels[r.resource] || r.resource, filterOptions: Object.values(labels) },
        { key: 'label', label: 'Record' },
        { key: 'account_name', label: 'Account' },
        { key: 'updated_at', label: 'Archived', type: 'date', value: r => (r.updated_at || '').slice(0, 10) },
        { key: 'restore', label: '', sortable: false, filter: false, export: false, render: r => h('button', { class: 'btn btn-sm', onclick: async () => {
          await R.restore(r.resource, r.id); if (r.resource === 'accounts') invalidateAccounts(); toast('Restored'); refreshRoute();
        } }, 'Restore') },
      ],
    }));
});
