/* Record forms and quick-add dialogs shared across pages. */
'use strict';

const L = () => S.lookups;

function accountField(required = true) {
  return { key: 'account_id', label: 'Account', type: 'account', required, full: true };
}

// Remove the account picker when the form is opened from an account page.
function withAccount(fields, accountId) {
  return accountId ? fields.filter(f => f.key !== 'account_id') : fields;
}

function after(opts) { return opts.onSaved || null; }

// ---------------------------------------------------------------- Accounts
function accountFields(isNew) {
  const f = [
    { key: 'named_insured', label: 'Named Insured (legal name)', required: true, full: true },
    { key: 'dba', label: 'DBA' },
    { key: 'status', label: 'Account Status', type: 'select', options: L().account_statuses, required: true, default: 'Prospect' },
    { key: 'territory', label: 'Territory', type: 'select', options: L().territories },
    { key: 'date_added', label: 'Date Added', type: 'date', default: 'today' },
    { key: 'types', label: 'Account Type', type: 'multiselect', options: L().account_types },
  ];
  if (isNew) {
    f.push(
      { key: 'add_to_pipeline', label: 'Add to prospecting pipeline (Identified stage)', type: 'checkbox', default: true, full: true, showIf: v => v.status === 'Prospect' },
      { key: 'source', label: 'Lead Source', type: 'select', options: L().lead_sources, showIf: v => v.status === 'Prospect' && v.add_to_pipeline },
      { key: 'est_premium', label: 'Est. Total Account Premium', type: 'money', showIf: v => v.status === 'Prospect' && v.add_to_pipeline },
    );
  }
  f.push(
    { section: 'Location & details' },
    { key: 'address', label: 'Address', full: true },
    { key: 'city', label: 'City' },
    { key: 'state', label: 'State', placeholder: 'NY' },
    { key: 'zip', label: 'ZIP' },
    { key: 'county', label: 'County' },
    { key: 'fein', label: 'FEIN', placeholder: '12-3456789' },
    { key: 'website', label: 'Website', type: 'url', placeholder: 'https://' },
    { key: 'annual_revenue', label: 'Annual Revenue (client)', type: 'money' },
    { key: 'num_employees', label: 'Number of Employees', type: 'number' },
    { section: 'Prior broker' },
    { key: 'prior_broker_name', label: 'Prior Broker' },
    { key: 'prior_broker_contact', label: 'Broker Contact Name' },
    { key: 'prior_broker_phone', label: 'Broker Phone', type: 'tel' },
    { key: 'prior_broker_email', label: 'Broker Email', type: 'email' },
  );
  return f;
}

function openAccountForm(record, opts = {}) {
  const isNew = !(record && record.id);
  return editRecord({
    resource: 'accounts', fields: accountFields(isNew), record, defaults: opts.defaults,
    title: isNew ? 'New Account' : `Edit ${record.named_insured}`, wide: true,
    beforeSave: (vals) => { if (vals.website && !/^https?:\/\//i.test(vals.website)) vals.website = 'https://' + vals.website; return vals; },
    onSaved: opts.onSaved || ((row) => { if (isNew) location.hash = `#/accounts/${row.id}`; else refreshRoute(); }),
    onArchived: () => { location.hash = '#/accounts'; },
  });
}

// ---------------------------------------------------------------- Contacts
function openContactForm(record, opts = {}) {
  return editRecord({
    resource: 'contacts', record, hidden: { account_id: opts.account_id }, title: record ? 'Edit Contact' : 'New Contact',
    fields: [
      { key: 'name', label: 'Name', required: true },
      { key: 'title', label: 'Title' },
      { key: 'phone', label: 'Phone', type: 'tel' },
      { key: 'email', label: 'Email', type: 'email' },
      { key: 'is_primary', label: 'Primary contact', type: 'checkbox', default: false },
    ],
    onSaved: after(opts),
  });
}

// ---------------------------------------------------------------- Policies
function updateCommissionPreview(form) {
  const p = form.get('premium'), pct = form.get('commission_pct');
  form.set('commission_preview', p !== null && pct !== null ? p * pct / 100 : null);
}

function policyFields(isNew) {
  return [
    accountField(),
    { key: 'line', label: 'Line of Coverage', type: 'select', options: L().lines, required: true,
      onChange: (form) => {
        const def = L().line_defaults[form.get('line')];
        if (isNew && def !== undefined && def !== null) { form.set('commission_pct', def); updateCommissionPreview(form); }
      } },
    { key: 'status', label: 'Status', type: 'select', options: L().policy_statuses, required: true, default: 'Not Yet Marketed' },
    { key: 'carrier', label: 'Carrier', type: 'carrier' },
    { key: 'policy_number', label: 'Policy Number' },
    { key: 'aor_status', label: 'AOR Status', type: 'select', options: L().aor_statuses, required: true, default: 'AOR',
      help: 'Flag lines where we are not broker of record yet' },
    { key: 'prior_carrier', label: 'Prior Carrier (who had it before us)', type: 'carrier' },
    { key: 'effective_date', label: 'Effective Date', type: 'date', default: 'today',
      onChange: (form) => {
        const eff = form.get('effective_date');
        if (eff && /^\d{4}-\d{2}-\d{2}$/.test(eff)) {
          const d = parseISO(eff); d.setFullYear(d.getFullYear() + 1);
          form.set('expiration_date', toISO(d));
        }
      } },
    { key: 'expiration_date', label: 'Expiration Date', type: 'date', default: () => { const d = parseISO(todayISO()); d.setFullYear(d.getFullYear() + 1); return toISO(d); } },
    { key: 'premium', label: 'Premium', type: 'money', onChange: updateCommissionPreview },
    { key: 'commission_pct', label: 'Commission %', type: 'pct', onChange: updateCommissionPreview,
      help: 'Defaults from Settings by line' },
    { key: 'commission_preview', label: 'Commission $ (auto-calculated)', type: 'readonly', format: v => v === null || v === undefined ? '—' : fmtMoney(v, true) },
    { key: 'coverage_form', label: 'Coverage Form', type: 'select', options: L().coverage_forms, default: 'Occurrence' },
    { key: 'retro_date', label: 'Retro Date', type: 'date', showIf: v => v.coverage_form === 'Claims-Made' },
    { key: 'experience_mod', label: 'Experience Mod', type: 'number', placeholder: '0.95', showIf: v => v.line === 'WC' },
    { key: 'multi_year', label: 'Multi-year policy', type: 'checkbox', default: false },
    { key: 'term_end_date', label: 'Term End Date', type: 'date', showIf: v => v.multi_year, help: 'Renewal calendar uses this date for multi-year terms' },
    { key: 'notes', label: 'Notes', type: 'textarea' },
  ];
}

function openPolicyForm(record, opts = {}) {
  const isNew = !(record && record.id);
  const defaults = Object.assign({}, opts.defaults || {});
  if (record) defaults.commission_preview = record.commission_amt;
  return editRecord({
    resource: 'policies', fields: withAccount(policyFields(isNew), opts.account_id), record,
    hidden: { account_id: opts.account_id }, defaults, wide: true,
    title: isNew ? 'New Policy' : `Edit ${record.line} Policy`,
    afterOpen: (form) => { if (isNew && form.get('line')) form.inputs.line.el.dispatchEvent(new Event('change')); },
    onSaved: after(opts),
  });
}

async function renewPolicy(policy, onDone) {
  if (!await confirmDialog(`Create the next term for this ${policy.line} policy? A new policy record will be created starting ${fmtDate(policy.renewal_date || policy.expiration_date)} with status "Marketing". The current term stays in the history.`, 'Create renewal term')) return;
  const row = await api(`/policies/${policy.id}/renew`, { method: 'POST' });
  toast('Renewal term created');
  if (onDone) onDone(row); else refreshRoute();
}

// ---------------------------------------------------------------- Pipeline deals
function dealFields() {
  return [
    accountField(),
    { key: 'stage', label: 'Stage', type: 'select', options: L().pipeline_stages, required: true, default: 'Identified' },
    { key: 'source', label: 'Source', type: 'select', options: L().lead_sources },
    { key: 'est_premium', label: 'Est. Total Account Premium', type: 'money' },
    { key: 'est_commission', label: 'Est. Commission', type: 'money', help: `Leave blank to auto-calc at ${L().settings.pipeline_commission_pct || 15}% of premium` },
    { key: 'target_date', label: 'Target Date (e.g. X-date)', type: 'date' },
    { key: 'lost_reason', label: 'Reason Lost', type: 'select', options: L().lost_reasons, required: true, blank: true, showIf: v => v.stage === 'Lost' },
    { key: 'lost_reason_detail', label: 'Lost Detail', type: 'textarea', showIf: v => v.stage === 'Lost' },
    { key: 'notes', label: 'Notes', type: 'textarea' },
  ];
}

async function openDealForm(record, opts = {}) {
  let extra = null;
  if (record && record.id) {
    const hist = await api(`/deals/${record.id}/history`);
    extra = h('div', { style: { marginTop: '14px' } }, h('h3', null, 'Stage history'),
      hist.length ? h('ul', { class: 'list' }, hist.map(x => h('li', null, h('span', { class: 'grow' }, x.stage), h('span', { class: 'muted small' }, fmtDateTime(x.entered_at)))))
        : h('div', { class: 'muted' }, 'No history'));
  }
  return editRecord({
    resource: 'deals', fields: withAccount(dealFields(), opts.account_id), record, hidden: { account_id: opts.account_id },
    defaults: opts.defaults, title: record && record.id ? `Pipeline: ${record.account_name || ''}` : 'Add to Pipeline', extra,
    onSaved: after(opts),
  });
}

function askLostReason(deal) {
  return new Promise(resolve => {
    let done = false;
    const form = buildForm([
      { key: 'lost_reason', label: 'Reason Lost', type: 'select', options: L().lost_reasons, required: true },
      { key: 'lost_reason_detail', label: 'Detail', type: 'textarea' },
    ], deal);
    const ok = (m) => { if (!form.validate()) return; done = true; m.close(); resolve(form.values()); };
    openModal({ title: `Mark ${deal.account_name} as Lost`, body: form.el,
      actions: [{ label: 'Cancel', onclick: m => m.close() }, 'spacer', { label: 'Mark Lost', class: 'btn-primary', onclick: ok }],
      onClose: () => { if (!done) resolve(null); } });
  });
}

// ---------------------------------------------------------------- Submissions
function submissionFields() {
  const active = ['Quoted', 'Bound'];
  return [
    accountField(),
    { key: 'policy_id', label: 'Policy (optional)', type: 'select', options: [], placeholder: '— none —',
      onChange: (form) => {
        const sel = form.inputs.policy_id.el;
        const opt = sel.options[sel.selectedIndex];
        if (opt && opt.dataset.line) form.set('line', opt.dataset.line);
      } },
    { key: 'line', label: 'Line', type: 'select', options: L().lines, required: true },
    { key: 'carrier', label: 'Carrier', type: 'carrier', required: true },
    { key: 'wholesaler', label: 'Wholesaler / MGA' },
    { key: 'date_submitted', label: 'Date Submitted', type: 'date', default: 'today' },
    { key: 'status', label: 'Status', type: 'select', options: L().submission_statuses, required: true, default: 'Pending' },
    { key: 'placement_exec', label: 'Placement Exec', type: 'person' },
    { key: 'target_premium', label: 'Target Premium (to beat)', type: 'money' },
    { key: 'quote_amount', label: 'Quote Amount', type: 'money', showIf: v => active.includes(v.status) },
    { key: 'quote_date', label: 'Quote Date', type: 'date', showIf: v => active.includes(v.status) },
    { key: 'decline_reason', label: 'Decline Reason', type: 'textarea', showIf: v => v.status === 'Declined' },
    { key: 'notes', label: 'Notes', type: 'textarea' },
  ];
}

async function fillPolicyOptions(form, accountId, selected) {
  const sel = form.inputs.policy_id.el;
  clear(sel).appendChild(h('option', { value: '' }, '— none —'));
  if (!accountId) return;
  const pols = await R.list('policies', { account_id: accountId });
  pols.filter(p => !p.renewed_to_id).forEach(p => sel.appendChild(h('option', { value: p.id, dataset: { line: p.line } },
    `${p.line}${p.carrier ? ' — ' + p.carrier : ''}${p.expiration_date ? ' (exp ' + fmtDate(p.expiration_date) + ')' : ''} · ${p.status}`)));
  sel.value = selected || '';
}

function openSubmissionForm(record, opts = {}) {
  const isNew = !(record && record.id);
  return editRecord({
    resource: 'submissions', fields: withAccount(submissionFields(), opts.account_id), record, defaults: opts.defaults,
    hidden: { account_id: opts.account_id }, wide: true,
    title: isNew ? 'New Submission' : `Edit Submission — ${record.line} / ${record.carrier || ''}`,
    extraTop: isNew ? h('p', { class: 'muted small' }, 'Creating a submission auto-populates the document checklist for that line on the account.') : null,
    afterOpen: (form) => {
      const acct = opts.account_id || (record && record.account_id) || (opts.defaults && opts.defaults.account_id);
      fillPolicyOptions(form, acct, (record && record.policy_id) || (opts.defaults && opts.defaults.policy_id));
      if (form.inputs.account_id) form.inputs.account_id.onChange(() => fillPolicyOptions(form, form.get('account_id')));
    },
    onSaved: after(opts),
  });
}

async function openSubmissionDetail(sub, onChange) {
  const reload = async () => {
    sub = await R.get('submissions', sub.id);
    const subjs = await R.list('subjectivities', { submission_id: sub.id });
    render(subjs);
  };
  const body = h('div');
  const m = openModal({ title: `${sub.line} — ${sub.carrier || 'No carrier'}`, body, wide: true,
    actions: [{ label: 'Edit submission', onclick: (mm) => { mm.close(); openSubmissionForm(sub, { onSaved: () => { if (onChange) onChange(); } }); } },
      'spacer', { label: 'Close', class: 'btn-primary', onclick: mm => mm.close() }],
    onClose: () => { if (onChange) onChange(); } });

  function render(subjs) {
    const input = h('input', { type: 'text', placeholder: 'Add a subjectivity / binding condition…', style: { flex: 1 } });
    const add = async () => {
      if (!input.value.trim()) return;
      await R.create('subjectivities', { submission_id: sub.id, text: input.value.trim() });
      reload();
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    clear(body).append(
      h('div', { class: 'kv', style: { marginBottom: '14px' } },
        h('div', { class: 'k' }, 'Account'), h('div', null, accountLink(sub)),
        h('div', { class: 'k' }, 'Status'), h('div', null, badge(sub.status)),
        h('div', { class: 'k' }, 'Wholesaler / MGA'), h('div', null, sub.wholesaler || '—'),
        h('div', { class: 'k' }, 'Date submitted'), h('div', null, fmtDate(sub.date_submitted) || '—'),
        h('div', { class: 'k' }, 'Placement exec'), h('div', null, sub.placement_exec || '—'),
        h('div', { class: 'k' }, 'Target premium'), h('div', null, fmtMoney(sub.target_premium) || '—'),
        h('div', { class: 'k' }, 'Quote'), h('div', null, sub.quote_amount !== null ? `${fmtMoney(sub.quote_amount)} on ${fmtDate(sub.quote_date)}` : '—'),
        sub.status === 'Declined' ? [h('div', { class: 'k' }, 'Decline reason'), h('div', null, sub.decline_reason || '—')] : null,
        h('div', { class: 'k' }, 'Notes'), h('div', { style: { whiteSpace: 'pre-wrap' } }, sub.notes || '—')),
      h('h3', null, `Subjectivities / binding conditions (${subjs.filter(s => s.done).length}/${subjs.length})`),
      h('div', null, subjs.map(s => h('div', { class: 'subj-item' + (s.done ? ' done' : '') },
        h('input', { type: 'checkbox', checked: !!s.done, onchange: async (e) => { await R.update('subjectivities', s.id, { done: e.target.checked }); reload(); } }),
        h('span', { class: 'grow' }, s.text),
        h('button', { class: 'btn btn-sm btn-ghost', title: 'Remove', onclick: async () => { await R.archive('subjectivities', s.id); reload(); } }, '×')))),
      h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } }, input, h('button', { class: 'btn', onclick: add }, 'Add')),
    );
  }
  await reload();
  return m;
}

// ---------------------------------------------------------------- Documents & loss runs
function openDocumentForm(record, opts = {}) {
  return editRecord({
    resource: 'documents', record, hidden: { account_id: opts.account_id }, defaults: opts.defaults,
    title: record ? `Edit ${record.name}` : 'Add Custom Document',
    fields: [
      { key: 'name', label: 'Document', required: true, full: true },
      { key: 'line', label: 'Line', type: 'select', options: L().lines },
      { key: 'status', label: 'Status', type: 'select', options: L().doc_statuses, required: true, default: 'Not Requested' },
      { key: 'date_requested', label: 'Date Requested', type: 'date', showIf: v => v.status !== 'Not Requested' },
      { key: 'date_received', label: 'Date Received', type: 'date', showIf: v => v.status === 'Received' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ],
    onSaved: after(opts),
  });
}

async function setDocStatus(doc, status, onDone) {
  await R.update('documents', doc.id, { status });
  if (status === 'Requested') toast(`Marked requested — follow-up task created for ${fmtDate(addDaysISO(todayISO(), 7))}`);
  if (onDone) onDone(); else refreshRoute();
}

function docStatusSelect(doc, onDone) {
  return h('select', { class: 'inline', onchange: (e) => setDocStatus(doc, e.target.value, onDone) },
    L().doc_statuses.map(s => h('option', { value: s, selected: s === doc.status }, s)));
}

function openLossRunForm(record, opts = {}) {
  return editRecord({
    resource: 'loss_runs', fields: withAccount([
      accountField(),
      { key: 'carrier', label: 'Carrier', type: 'carrier', required: true },
      { key: 'line', label: 'Line', type: 'select', options: L().lines },
      { key: 'date_requested', label: 'Date Requested', type: 'date', default: 'today' },
      { key: 'status', label: 'Status', type: 'select', options: L().loss_run_statuses, required: true, default: 'Requested' },
      { key: 'date_received', label: 'Date Received', type: 'date', showIf: v => v.status === 'Received' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ], opts.account_id), record, hidden: { account_id: opts.account_id }, title: record ? 'Edit Loss Run Request' : 'New Loss Run Request',
    onSaved: after(opts),
  });
}

// ---------------------------------------------------------------- Activities & tasks
function openActivityForm(record, opts = {}) {
  return editRecord({
    resource: 'activities', record, hidden: { account_id: opts.account_id }, defaults: opts.defaults,
    title: record && record.id ? 'Edit Activity' : 'Log Activity',
    fields: withAccount([
      accountField(false),
      { key: 'type', label: 'Type', type: 'select', options: L().activity_types, required: true, default: 'Call' },
      { key: 'activity_date', label: 'Date', type: 'date', default: 'today' },
      { key: 'summary', label: 'Summary', type: 'textarea', full: true },
      { key: 'next_step', label: 'Next Step', full: true },
      { key: 'follow_up_date', label: 'Follow-up Date', type: 'date', help: 'Shows in Today when due' },
      { key: 'priority', label: 'Priority', type: 'select', options: L().priorities, required: true, default: 'Medium' },
      { key: 'follow_up_done', label: 'Follow-up done', type: 'checkbox', default: false, showIf: v => !!v.follow_up_date },
    ], opts.account_id),
    onSaved: after(opts),
  });
}

function openTaskForm(record, opts = {}) {
  return editRecord({
    resource: 'tasks', record, hidden: { account_id: opts.account_id }, defaults: opts.defaults,
    title: record && record.id ? 'Edit Task' : 'New Task',
    fields: withAccount([
      { key: 'title', label: 'Task', required: true, full: true },
      accountField(false),
      { key: 'due_date', label: 'Due Date', type: 'date', default: 'today' },
      { key: 'priority', label: 'Priority', type: 'select', options: L().priorities, required: true, default: 'Medium' },
      { key: 'category', label: 'Category', type: 'select', options: L().task_categories, required: true, default: 'Follow-up' },
      { key: 'assigned_to', label: 'Assigned To', type: 'select', options: L().teams, required: true, default: 'Self' },
      { key: 'status', label: 'Status', type: 'select', options: L().task_statuses, required: true, default: 'Open' },
      { key: 'description', label: 'Details', type: 'textarea' },
    ], opts.account_id),
    onSaved: after(opts),
  });
}

async function toggleTask(task, done, onDone) {
  await R.update('tasks', task.id, { status: done ? 'Done' : 'Open' });
  toast(done ? 'Task completed' : 'Task reopened');
  if (onDone) onDone(); else refreshRoute();
}

function taskCheckbox(task, onDone) {
  return h('input', { type: 'checkbox', title: 'Mark done', checked: task.status === 'Done', onchange: (e) => toggleTask(task, e.target.checked, onDone) });
}

async function completeFollowUp(act, onDone) {
  await R.update('activities', act.id, { follow_up_done: true });
  toast('Follow-up marked done');
  if (onDone) onDone(); else refreshRoute();
}

// ---------------------------------------------------------------- Team
function openTeamForm(record, opts = {}) {
  return editRecord({
    resource: 'team', record, hidden: { account_id: opts.account_id }, title: record ? 'Edit Handoff' : 'New Internal Handoff',
    fields: withAccount([
      accountField(),
      { key: 'role', label: 'Role', type: 'select', options: L().team_roles, required: true },
      { key: 'person_name', label: 'Team Member / Department', type: 'person' },
      { key: 'handoff_date', label: 'Handoff Date', type: 'date', default: 'today' },
      { key: 'handoff_status', label: 'Handoff Status', type: 'select', options: L().handoff_statuses, required: true, default: 'Handed Off' },
      { key: 'notes', label: 'Notes', type: 'textarea' },
    ], opts.account_id),
    onSaved: after(opts),
  });
}

// ---------------------------------------------------------------- Quick add (keyboard shortcuts)
function quickAdd(kind) {
  if (modalStack.length) return;
  const acct = S.route && S.route.path.startsWith('/accounts/') ? Number(S.route.params.id) : null;
  const defaults = acct ? { account_id: acct } : {};
  if (kind === 'account') openAccountForm(null);
  else if (kind === 'task') openTaskForm(null, { defaults });
  else if (kind === 'activity') openActivityForm(null, { defaults });
  else if (kind === 'call') openActivityForm(null, { defaults: Object.assign({ type: 'Call' }, defaults) });
}
