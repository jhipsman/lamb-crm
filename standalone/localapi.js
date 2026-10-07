/*
 In-browser backend for the standalone (no-install) build.

 Mirrors crm/resources.py and crm/api.py, running against SQLite compiled to
 WebAssembly (sql.js). The database is persisted to IndexedDB after every change,
 and optionally to a .db file on disk (File System Access API, Chrome/Edge).
 The .db file format is identical to the Flask version's data/crm.db.

 window.CRM_CONFIG (schema, option lists, defaults) is injected by build_standalone.py
 from the Python source so both versions stay in sync.
*/
'use strict';

const LocalAPI = (() => {
  const CFG = window.CRM_CONFIG;
  const C = CFG.lookups;
  let db = null;

  // ------------------------------------------------------------------ utils
  const pad = n => String(n).padStart(2, '0');
  function today() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
  function now() { const d = new Date(); return `${today()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; }
  function addDays(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(y, m - 1, d + n);
    return `${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
  }

  class ValidationError extends Error {}
  class NotFound extends Error {}

  function norm(v) {
    if (v === undefined) return null;
    if (typeof v === 'boolean') return v ? 1 : 0;
    return v;
  }
  function all(sql, params = []) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params.map(norm));
      const out = [];
      while (stmt.step()) out.push(stmt.getAsObject());
      return out;
    } finally { stmt.free(); }
  }
  function one(sql, params) { return all(sql, params)[0] || null; }
  function scalar(sql, params) { const r = one(sql, params); return r ? Object.values(r)[0] : null; }
  function run(sql, params = []) { db.run(sql, params.map(norm)); }
  function lastId() { return scalar('SELECT last_insert_rowid() AS id'); }

  function insert(table, values) {
    const ts = now();
    values = Object.assign({}, values, { created_at: ts, updated_at: ts });
    const cols = Object.keys(values);
    run(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map(c => values[c]));
    return lastId();
  }
  function update(table, id, values) {
    values = Object.assign({}, values, { updated_at: now() });
    const cols = Object.keys(values);
    run(`UPDATE ${table} SET ${cols.map(c => `${c} = ?`).join(', ')} WHERE id = ?`, [...cols.map(c => values[c]), id]);
  }

  // ------------------------------------------------------------------ coercion
  function toNumber(v, int) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return int ? Math.trunc(v) : v;
    const s = String(v).replace(/[,$%\s]/g, '');
    if (s === '') return null;
    const n = Number(s);
    if (isNaN(n)) throw new ValidationError(`'${v}' is not a number`);
    return int ? Math.trunc(n) : n;
  }
  function toBool(v) {
    if (typeof v === 'string') return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()) ? 1 : 0;
    return v ? 1 : 0;
  }
  function toText(v) {
    if (v === null || v === undefined) return null;
    const s = String(v).trim();
    return s || null;
  }
  const COERCE = {
    text: toText, date: toText, real: v => toNumber(v, false), int: v => toNumber(v, true), bool: toBool,
    json: v => JSON.stringify(Array.isArray(v) ? v : (v === null || v === undefined || v === '' ? [] : [v])),
  };
  const title = k => k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  const round2 = n => Math.round(n * 100) / 100;

  // ------------------------------------------------------------------ SQL fragments (today injected)
  const q = s => `'${s}'`;  // only ever used with today()/now() output
  function renewalDateSql(a = 't') {
    return `CASE WHEN ${a}.multi_year = 1 AND ${a}.term_end_date IS NOT NULL THEN ${a}.term_end_date ELSE ${a}.expiration_date END`;
  }
  function inForceSql(a = 't') {
    const rd = renewalDateSql(a);
    return `(${a}.archived = 0 AND ${a}.status IN ('Bound', 'Renewed') AND (${rd} IS NULL OR ${rd} >= ${q(today())}))`;
  }
  const ACCOUNT_JOIN = 'LEFT JOIN accounts a ON a.id = t.account_id';
  const ACCOUNT_COLS = 'a.named_insured AS account_name, a.territory AS territory, a.status AS account_status';

  // ------------------------------------------------------------------ Resource
  class Resource {
    constructor(table, fields, o = {}) {
      Object.assign(this, { table, fields, required: [], select: () => 't.*', joins: '', order: 't.id DESC',
        before: null, after: null, jsonOut: [], updatable: true, deletable: true }, o);
    }
    clean(payload, partial) {
      const data = {};
      for (const [name, kind] of Object.entries(this.fields)) if (name in payload) data[name] = COERCE[kind](payload[name]);
      for (const name of this.required) {
        if (partial && !(name in data)) continue;
        if (data[name] === null || data[name] === undefined || data[name] === '') throw new ValidationError(`${title(name)} is required`);
      }
      return data;
    }
    out(row) {
      if (!row) return null;
      for (const k of this.jsonOut) { try { row[k] = JSON.parse(row[k] || '[]'); } catch (e) { row[k] = []; } }
      return row;
    }
    base() { return `SELECT ${this.select()} FROM ${this.table} t ${this.joins}`; }
    list(args) {
      const where = ['t.archived = ?'], params = [['1', 'true'].includes(args.archived) ? 1 : 0];
      for (const [k, v] of Object.entries(args)) {
        if (k in this.fields || k === 'id') { where.push(`t.${k} = ?`); params.push(v); }
      }
      return all(`${this.base()} WHERE ${where.join(' AND ')} ORDER BY ${this.order}`, params).map(r => this.out(r));
    }
    get(id) { return this.out(one(`${this.base()} WHERE t.id = ?`, [id])); }
    raw(id) { return one(`SELECT * FROM ${this.table} WHERE id = ?`, [id]); }
    createNoCommit(payload) {
      const data = this.clean(payload, false);
      if (this.before) this.before(data, null, payload);
      const id = insert(this.table, data);
      if (this.after) this.after(id, data, null, payload);
      return id;
    }
    updateNoCommit(id, payload) {
      if (!this.updatable) throw new ValidationError('This record cannot be edited');
      const old = this.raw(id);
      if (!old) throw new NotFound();
      const data = this.clean(payload, true);
      if (this.before) this.before(data, old, payload);
      update(this.table, id, data);
      if (this.after) this.after(id, data, old, payload);
    }
    create(payload) { return this.get(tx(() => this.createNoCommit(payload))); }
    update(id, payload) { tx(() => this.updateNoCommit(id, payload)); return this.get(id); }
    setArchived(id, flag) {
      if (!this.deletable) throw new ValidationError('This record cannot be archived');
      run(`UPDATE ${this.table} SET archived = ?, updated_at = ? WHERE id = ?`, [flag ? 1 : 0, now(), id]);
    }
  }

  function tx(fn) {
    run('SAVEPOINT w');
    try { const r = fn(); run('RELEASE w'); return r; }
    catch (e) { run('ROLLBACK TO w'); run('RELEASE w'); throw e; }
  }

  // ------------------------------------------------------------------ hook helpers
  const changed = (f, data, old) => (f in data) && (old === null || data[f] !== old[f]);
  const merged = (data, old, f) => (f in data) ? data[f] : (old ? old[f] : null);
  const setting = (key, def) => { const r = one('SELECT value FROM settings WHERE key = ?', [key]); return r && r.value !== null && r.value !== '' ? r.value : def; };
  const defaultPct = line => { const r = one('SELECT commission_pct FROM line_defaults WHERE line = ?', [line]); return r ? r.commission_pct : null; };
  const accountName = id => { const r = one('SELECT named_insured FROM accounts WHERE id = ?', [id]); return r ? r.named_insured : ''; };

  // ------------------------------------------------------------------ hooks (mirror crm/resources.py)
  function accountBefore(data, old) {
    if (old === null) {
      data.status = data.status || 'Prospect';
      data.date_added = data.date_added || today();
      data.status_changed_at = now();
    } else if (changed('status', data, old)) data.status_changed_at = now();
  }
  function accountAfter(id, data, old, payload) {
    if (old === null && data.status === 'Prospect' && toBool(payload.add_to_pipeline)) {
      R.deals.createNoCommit({ account_id: id, stage: 'Identified', source: payload.source, est_premium: payload.est_premium });
    }
  }
  function contactAfter(id, data, old) {
    if (data.is_primary) run('UPDATE contacts SET is_primary = 0 WHERE account_id = ? AND id != ?', [merged(data, old, 'account_id'), id]);
  }
  function policyBefore(data, old) {
    const line = merged(data, old, 'line');
    if (old === null && (data.commission_pct === null || data.commission_pct === undefined)) data.commission_pct = defaultPct(line);
    const premium = merged(data, old, 'premium'), pct = merged(data, old, 'commission_pct');
    if ('premium' in data || 'commission_pct' in data || old === null) {
      data.commission_amt = premium !== null && premium !== undefined && pct !== null && pct !== undefined ? round2(premium * pct / 100) : null;
    }
    if (old === null && data.effective_date && !data.expiration_date) data.expiration_date = addDays(data.effective_date, 365);
  }
  function dealBefore(data, old) {
    if (old === null) data.stage = data.stage || 'Identified';
    if (changed('stage', data, old)) data.stage_entered_at = now();
    if ((data.est_commission === null || data.est_commission === undefined) && (old === null || 'est_premium' in data)) {
      const premium = merged(data, old, 'est_premium');
      if (premium !== null && premium !== undefined) data.est_commission = round2(premium * (toNumber(setting('pipeline_commission_pct', '15')) || 0) / 100);
    }
  }
  const STAGE_TO_STATUS = { 'BOR Submitted': 'BOR Submitted', 'Won': 'BOR Won', 'Lost': 'Lost' };
  function dealAfter(id, data, old) {
    if (!changed('stage', data, old)) return;
    insert('deal_stage_history', { deal_id: id, stage: data.stage, entered_at: now() });
    const status = STAGE_TO_STATUS[data.stage];
    const accountId = merged(data, old, 'account_id');
    if (status) update('accounts', accountId, { status, status_changed_at: now() });
    else if (old !== null && STAGE_TO_STATUS[old.stage]) update('accounts', accountId, { status: 'Prospect', status_changed_at: now() });
  }
  function populateDocuments(accountId, line, submissionId) {
    for (const item of all('SELECT name FROM doc_templates WHERE line = ? AND archived = 0 ORDER BY sort_order, id', [line])) {
      const exists = one('SELECT 1 AS x FROM documents WHERE account_id = ? AND line = ? AND name = ? AND archived = 0', [accountId, line, item.name]);
      if (!exists) insert('documents', { account_id: accountId, submission_id: submissionId, line, name: item.name, status: 'Not Requested' });
    }
  }
  function submissionBefore(data, old) {
    if (old === null) {
      data.date_submitted = data.date_submitted || today();
      if (data.policy_id && !data.line) { const p = one('SELECT line FROM policies WHERE id = ?', [data.policy_id]); if (p) data.line = p.line; }
      if (!data.line) throw new ValidationError('Line is required');
    }
    if (changed('status', data, old) && merged(data, old, 'status') === 'Quoted' && !merged(data, old, 'quote_date')) data.quote_date = today();
  }
  function submissionAfter(id, data, old) {
    const accountId = merged(data, old, 'account_id'), policyId = merged(data, old, 'policy_id');
    if (old === null) {
      populateDocuments(accountId, data.line, id);
      if (policyId) {
        const p = one('SELECT status FROM policies WHERE id = ?', [policyId]);
        if (p && ['Not Yet Marketed', 'Marketing'].includes(p.status)) update('policies', policyId, { status: 'Submitted' });
      }
    }
    if (policyId && changed('status', data, old)) {
      if (data.status === 'Quoted') {
        const p = one('SELECT status FROM policies WHERE id = ?', [policyId]);
        if (p && ['Not Yet Marketed', 'Marketing', 'Submitted'].includes(p.status)) update('policies', policyId, { status: 'Quoted' });
      } else if (data.status === 'Bound') {
        const pol = R.policies.raw(policyId);
        const values = { status: 'Bound', carrier: merged(data, old, 'carrier') || pol.carrier, aor_status: 'AOR' };
        const quote = merged(data, old, 'quote_amount');
        if (quote !== null && quote !== undefined) {
          values.premium = quote;
          if (pol.commission_pct !== null) values.commission_amt = round2(quote * pol.commission_pct / 100);
        }
        update('policies', policyId, values);
      }
    }
  }
  function documentBefore(data, old) {
    if (!changed('status', data, old)) return;
    const status = merged(data, old, 'status');
    if (status === 'Requested' && !merged(data, old, 'date_requested')) data.date_requested = today();
    if (status === 'Received' && !merged(data, old, 'date_received')) data.date_received = today();
  }
  const isLossRun = name => (name || '').toLowerCase().startsWith('loss run');
  function documentAfter(id, data, old) {
    if (!changed('status', data, old)) return;
    const doc = R.documents.raw(id);
    if (doc.status === 'Requested') {
      const requested = doc.date_requested || today();
      const openTask = one("SELECT 1 AS x FROM tasks WHERE document_id = ? AND status = 'Open' AND archived = 0", [id]);
      if (!openTask) {
        insert('tasks', { account_id: doc.account_id, document_id: id, title: `Follow up: ${doc.name}` + (doc.line ? ` (${doc.line})` : ''),
          description: `Document requested ${requested} for ${accountName(doc.account_id)}`, due_date: addDays(requested, 7),
          priority: 'Medium', status: 'Open', category: 'Document Chase', assigned_to: 'Self' });
      }
      if (isLossRun(doc.name) && !one('SELECT 1 AS x FROM loss_runs WHERE document_id = ? AND archived = 0', [id])) {
        const pol = one('SELECT carrier, prior_carrier FROM policies WHERE account_id = ? AND line = ? AND archived = 0 ORDER BY expiration_date DESC LIMIT 1', [doc.account_id, doc.line]);
        insert('loss_runs', { account_id: doc.account_id, document_id: id, carrier: pol ? (pol.carrier || pol.prior_carrier) : null,
          line: doc.line, date_requested: requested, status: 'Requested' });
      }
    }
    if (['Received', 'N/A'].includes(doc.status)) {
      run("UPDATE tasks SET status = 'Done', completed_at = ?, updated_at = ? WHERE document_id = ? AND status = 'Open'", [now(), now(), id]);
      run('UPDATE loss_runs SET status = ?, date_received = COALESCE(date_received, ?), updated_at = ? WHERE document_id = ? AND status != ?',
        [doc.status, doc.status === 'Received' ? today() : null, now(), id, doc.status]);
    }
  }
  function lossRunBefore(data, old) {
    if (old === null) data.date_requested = data.date_requested || today();
    if (changed('status', data, old) && merged(data, old, 'status') === 'Received' && !merged(data, old, 'date_received')) data.date_received = today();
  }
  function lossRunAfter(id, data, old) {
    if (!changed('status', data, old)) return;
    const lr = R.loss_runs.raw(id);
    if (lr.document_id && ['Received', 'N/A'].includes(lr.status)) {
      const doc = R.documents.raw(lr.document_id);
      if (doc && doc.status !== lr.status) R.documents.updateNoCommit(lr.document_id, { status: lr.status, date_received: lr.date_received });
    }
  }
  const activityBefore = (data, old) => { if (old === null) data.activity_date = data.activity_date || today(); };
  function taskBefore(data, old) {
    if (old === null) data.due_date = data.due_date || today();
    if (changed('status', data, old)) data.completed_at = data.status === 'Done' ? now() : null;
  }
  const teamBefore = (data, old) => { if (old === null) data.handoff_date = data.handoff_date || today(); };

  // ------------------------------------------------------------------ resources (mirror crm/resources.py)
  const R = {
    accounts: new Resource('accounts', {
      named_insured: 'text', dba: 'text', address: 'text', city: 'text', state: 'text', zip: 'text', county: 'text', fein: 'text',
      website: 'text', types: 'json', status: 'text', territory: 'text', annual_revenue: 'real', num_employees: 'int',
      prior_broker_name: 'text', prior_broker_contact: 'text', prior_broker_phone: 'text', prior_broker_email: 'text', date_added: 'date',
    }, {
      required: ['named_insured'],
      select: () => `t.*,
        (SELECT name FROM contacts c WHERE c.account_id = t.id AND c.archived = 0 ORDER BY c.is_primary DESC, c.id LIMIT 1) AS primary_contact,
        (SELECT COUNT(*) FROM policies p WHERE p.account_id = t.id AND p.archived = 0) AS policy_count,
        (SELECT COALESCE(SUM(p.premium), 0) FROM policies p WHERE p.account_id = t.id AND ${inForceSql('p')}) AS bound_premium`,
      order: 't.named_insured COLLATE NOCASE', before: accountBefore, after: accountAfter, jsonOut: ['types'],
    }),
    contacts: new Resource('contacts', { account_id: 'int', name: 'text', title: 'text', phone: 'text', email: 'text', is_primary: 'bool' }, {
      required: ['account_id', 'name'], select: () => `t.*, ${ACCOUNT_COLS}`, joins: ACCOUNT_JOIN,
      order: 't.is_primary DESC, t.name COLLATE NOCASE', after: contactAfter,
    }),
    notes: new Resource('account_notes', { account_id: 'int', body: 'text' }, {
      required: ['account_id', 'body'], order: 't.created_at DESC, t.id DESC', updatable: false, deletable: false,
    }),
    policies: new Resource('policies', {
      account_id: 'int', line: 'text', carrier: 'text', policy_number: 'text', effective_date: 'date', expiration_date: 'date',
      premium: 'real', commission_pct: 'real', coverage_form: 'text', retro_date: 'date', experience_mod: 'real', status: 'text',
      aor_status: 'text', prior_carrier: 'text', multi_year: 'bool', term_end_date: 'date', renewed_to_id: 'int', notes: 'text',
    }, {
      required: ['account_id', 'line'], select: () => `t.*, ${ACCOUNT_COLS}, ${renewalDateSql()} AS renewal_date`,
      joins: ACCOUNT_JOIN, order: 't.expiration_date', before: policyBefore,
    }),
    deals: new Resource('deals', {
      account_id: 'int', stage: 'text', est_premium: 'real', est_commission: 'real', source: 'text', target_date: 'date',
      lost_reason: 'text', lost_reason_detail: 'text', notes: 'text',
    }, {
      required: ['account_id'],
      select: () => `t.*, ${ACCOUNT_COLS}, a.dba AS dba, a.types AS account_types,
        CAST(julianday(${q(now())}) - julianday(t.stage_entered_at) AS INTEGER) AS days_in_stage`,
      joins: ACCOUNT_JOIN, order: 't.stage_entered_at DESC', before: dealBefore, after: dealAfter,
    }),
    submissions: new Resource('submissions', {
      account_id: 'int', policy_id: 'int', line: 'text', carrier: 'text', wholesaler: 'text', date_submitted: 'date', status: 'text',
      quote_amount: 'real', quote_date: 'date', decline_reason: 'text', placement_exec: 'text', target_premium: 'real', notes: 'text',
    }, {
      required: ['account_id'],
      select: () => `t.*, ${ACCOUNT_COLS},
        (SELECT COUNT(*) FROM subjectivities s WHERE s.submission_id = t.id AND s.archived = 0) AS subj_total,
        (SELECT COUNT(*) FROM subjectivities s WHERE s.submission_id = t.id AND s.archived = 0 AND s.done = 1) AS subj_done`,
      joins: ACCOUNT_JOIN, order: 't.date_submitted DESC, t.id DESC', before: submissionBefore, after: submissionAfter,
    }),
    subjectivities: new Resource('subjectivities', { submission_id: 'int', text: 'text', done: 'bool' }, { required: ['submission_id', 'text'], order: 't.id' }),
    documents: new Resource('documents', {
      account_id: 'int', submission_id: 'int', line: 'text', name: 'text', status: 'text', date_requested: 'date', date_received: 'date', notes: 'text',
    }, {
      required: ['account_id', 'name'],
      select: () => `t.*, ${ACCOUNT_COLS}, CAST(julianday(${q(today())}) - julianday(t.date_requested) AS INTEGER) AS days_outstanding`,
      joins: ACCOUNT_JOIN, order: 't.line, t.id', before: documentBefore, after: documentAfter,
    }),
    loss_runs: new Resource('loss_runs', {
      account_id: 'int', document_id: 'int', carrier: 'text', line: 'text', date_requested: 'date', date_received: 'date', status: 'text', notes: 'text',
    }, {
      required: ['account_id'],
      select: () => `t.*, ${ACCOUNT_COLS},
        CAST(julianday(COALESCE(t.date_received, ${q(today())})) - julianday(t.date_requested) AS INTEGER) AS days_outstanding`,
      joins: ACCOUNT_JOIN, order: 't.date_requested', before: lossRunBefore, after: lossRunAfter,
    }),
    activities: new Resource('activities', {
      account_id: 'int', type: 'text', activity_date: 'date', summary: 'text', next_step: 'text', follow_up_date: 'date', follow_up_done: 'bool', priority: 'text',
    }, { required: ['type'], select: () => `t.*, ${ACCOUNT_COLS}`, joins: ACCOUNT_JOIN, order: 't.activity_date DESC, t.id DESC', before: activityBefore }),
    tasks: new Resource('tasks', {
      account_id: 'int', document_id: 'int', title: 'text', description: 'text', due_date: 'date', priority: 'text', status: 'text', category: 'text', assigned_to: 'text',
    }, {
      required: ['title'], select: () => `t.*, ${ACCOUNT_COLS}`, joins: ACCOUNT_JOIN,
      order: "t.status DESC, t.due_date, CASE t.priority WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END", before: taskBefore,
    }),
    team: new Resource('team_assignments', {
      account_id: 'int', role: 'text', person_name: 'text', handoff_date: 'date', handoff_status: 'text', notes: 'text',
    }, { required: ['account_id', 'role'], select: () => `t.*, ${ACCOUNT_COLS}`, joins: ACCOUNT_JOIN, order: 't.handoff_date DESC, t.id DESC', before: teamBefore }),
    carriers: new Resource('carriers', { name: 'text' }, { required: ['name'], order: 't.name COLLATE NOCASE' }),
    account_types: new Resource('account_types', { name: 'text' }, { required: ['name'], order: 't.id' }),
    team_members: new Resource('team_members', { name: 'text', team: 'text', email: 'text', phone: 'text' }, { required: ['name'], order: 't.name COLLATE NOCASE' }),
    doc_templates: new Resource('doc_templates', { line: 'text', name: 'text', sort_order: 'int' }, { required: ['line', 'name'], order: 't.line, t.sort_order, t.id' }),
  };
  function resource(name) {
    if (!R[name]) throw new ValidationError(`Unknown resource '${name}'`);
    return R[name];
  }

  // ------------------------------------------------------------------ API endpoints (mirror crm/api.py)
  const ACTIVE_SUB = ['Pending', 'Need Additional Info', 'Quoted'];
  const prio = col => `CASE ${col} WHEN 'High' THEN 0 WHEN 'Medium' THEN 1 ELSE 2 END`;
  const renewalBase = () => `
    SELECT p.id, p.account_id, p.line, p.carrier, p.policy_number, p.premium, p.status, p.commission_amt,
           p.aor_status, p.expiration_date, ${renewalDateSql('p')} AS renewal_date,
           a.named_insured AS account_name, a.territory
    FROM policies p JOIN accounts a ON a.id = p.account_id
    WHERE p.archived = 0 AND a.archived = 0 AND p.renewed_to_id IS NULL AND p.status NOT IN ('Lost', 'Cancelled')`;

  function lookups() {
    const data = JSON.parse(JSON.stringify(C));
    data.carriers = all('SELECT name FROM carriers WHERE archived = 0 ORDER BY name COLLATE NOCASE').map(r => r.name);
    data.account_types = all('SELECT name FROM account_types WHERE archived = 0 ORDER BY id').map(r => r.name);
    data.team_members = all('SELECT id, name, team FROM team_members WHERE archived = 0 ORDER BY name COLLATE NOCASE');
    data.line_defaults = Object.fromEntries(all('SELECT line, commission_pct FROM line_defaults').map(r => [r.line, r.commission_pct]));
    data.settings = Object.fromEntries(all("SELECT key, value FROM settings WHERE substr(key, 1, 1) != '_'").map(r => [r.key, r.value]));
    data.today = today();
    return data;
  }

  function saveSettings(body) {
    for (const [k, v] of Object.entries(body.settings || {})) {
      if (k.startsWith('_')) continue;
      if (one('SELECT 1 AS x FROM settings WHERE key = ?', [k])) run('UPDATE settings SET value = ?, updated_at = ? WHERE key = ?', [v, now(), k]);
      else insert('settings', { key: k, value: v });
    }
    for (const [line, pct] of Object.entries(body.line_defaults || {})) {
      const n = toNumber(pct);
      if (one('SELECT 1 AS x FROM line_defaults WHERE line = ?', [line])) run('UPDATE line_defaults SET commission_pct = ?, updated_at = ? WHERE line = ?', [n, now(), line]);
      else insert('line_defaults', { line, commission_pct: n });
    }
    return lookups();
  }

  function accountFull(id) {
    const account = R.accounts.get(id);
    if (!account) throw new NotFound();
    const out = { account };
    for (const k of ['contacts', 'notes', 'policies', 'deals', 'submissions', 'documents', 'loss_runs', 'activities', 'tasks', 'team']) {
      out[k] = R[k].list({ account_id: id });
    }
    return out;
  }

  function renewPolicy(id) {
    const old = R.policies.raw(id);
    if (!old) throw new NotFound();
    const start = (old.multi_year && old.term_end_date ? old.term_end_date : old.expiration_date) || today();
    const payload = {};
    for (const k of ['account_id', 'line', 'carrier', 'commission_pct', 'coverage_form', 'retro_date', 'experience_mod', 'aor_status', 'premium']) payload[k] = old[k];
    Object.assign(payload, { effective_date: start, expiration_date: addDays(start, 365), status: 'Marketing', prior_carrier: old.carrier, multi_year: 0 });
    const newId = tx(() => {
      const nid = R.policies.createNoCommit(payload);
      run('UPDATE policies SET renewed_to_id = ?, updated_at = ? WHERE id = ?', [nid, now(), id]);
      return nid;
    });
    return R.policies.get(newId);
  }

  function callCounts() {
    const t = new Date();
    const d = today();
    const ws = new Date(t.getFullYear(), t.getMonth(), t.getDate() - ((t.getDay() + 6) % 7));
    const weekStart = `${ws.getFullYear()}-${pad(ws.getMonth() + 1)}-${pad(ws.getDate())}`;
    const monthStart = d.slice(0, 8) + '01';
    const sql = "SELECT COUNT(*) AS n FROM activities WHERE archived = 0 AND type = 'Call' AND activity_date >= ? AND activity_date <= ?";
    return { today: scalar(sql, [d, d]), week: scalar(sql, [weekStart, d]), month: scalar(sql, [monthStart, d]) };
  }

  function pipelineSummary() {
    const data = Object.fromEntries(all(`
      SELECT d.stage, COUNT(*) AS count, COALESCE(SUM(d.est_premium), 0) AS est_premium, COALESCE(SUM(d.est_commission), 0) AS est_commission
      FROM deals d JOIN accounts a ON a.id = d.account_id WHERE d.archived = 0 AND a.archived = 0 GROUP BY d.stage`).map(r => [r.stage, r]));
    return C.pipeline_stages.map(s => ({ stage: s, count: (data[s] || {}).count || 0, est_premium: (data[s] || {}).est_premium || 0, est_commission: (data[s] || {}).est_commission || 0 }));
  }

  function dashboard() {
    const t = today(), rd = renewalDateSql('p');
    const keys = [];
    const base = new Date(); base.setDate(1);
    for (let i = 0; i < 6; i++) { const d = new Date(base.getFullYear(), base.getMonth() + i, 1); keys.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`); }
    const byMonth = Object.fromEntries(all(`
      SELECT strftime('%Y-%m', ${rd}) AS m, COUNT(*) AS n, COALESCE(SUM(p.premium), 0) AS premium
      FROM policies p JOIN accounts a ON a.id = p.account_id
      WHERE p.archived = 0 AND a.archived = 0 AND p.renewed_to_id IS NULL AND p.status NOT IN ('Lost', 'Cancelled') AND ${rd} >= ?
      GROUP BY m`, [keys[0] + '-01']).map(r => [r.m, r]));
    return {
      renewals_90: all(renewalBase() + ` AND ${rd} >= ? AND ${rd} <= ? ORDER BY ${rd}`, [t, addDays(t, 90)]),
      renewals_by_month: keys.map(k => ({ month: k, count: (byMonth[k] || {}).n || 0, premium: (byMonth[k] || {}).premium || 0 })),
      tasks_today: all(`SELECT t.*, a.named_insured AS account_name FROM tasks t LEFT JOIN accounts a ON a.id = t.account_id
        WHERE t.archived = 0 AND t.status = 'Open' AND t.due_date <= ? ORDER BY ${prio('t.priority')}, t.due_date`, [t]),
      overdue_followups: all(`SELECT t.*, a.named_insured AS account_name FROM activities t LEFT JOIN accounts a ON a.id = t.account_id
        WHERE t.archived = 0 AND t.follow_up_done = 0 AND t.follow_up_date IS NOT NULL AND t.follow_up_date < ? ORDER BY ${prio('t.priority')}, t.follow_up_date`, [t]),
      followups_today: scalar('SELECT COUNT(*) AS n FROM activities WHERE archived = 0 AND follow_up_done = 0 AND follow_up_date = ?', [t]),
      outstanding_docs: scalar(`SELECT COUNT(*) AS n FROM documents d JOIN accounts a ON a.id = d.account_id
        WHERE d.archived = 0 AND a.archived = 0 AND d.status IN ('Not Requested', 'Requested')
          AND EXISTS (SELECT 1 FROM submissions s WHERE s.account_id = d.account_id AND s.line = d.line AND s.archived = 0
                      AND s.status IN (${ACTIVE_SUB.map(() => '?').join(', ')}))`, ACTIVE_SUB),
      outstanding_loss_runs: one(`SELECT COUNT(*) AS count, MIN(l.date_requested) AS oldest FROM loss_runs l JOIN accounts a ON a.id = l.account_id
        WHERE l.archived = 0 AND a.archived = 0 AND l.status = 'Requested'`),
      pipeline: pipelineSummary(),
      book: one(`SELECT (SELECT COUNT(*) FROM accounts WHERE archived = 0 AND status IN ('Active Client', 'BOR Won')) AS active_accounts,
          COALESCE(SUM(t.premium), 0) AS premium, COALESCE(SUM(t.commission_amt), 0) AS commission, COUNT(*) AS policies
        FROM policies t JOIN accounts a ON a.id = t.account_id WHERE a.archived = 0 AND ${inForceSql('t')}`),
      calls: callCounts(),
      recent_accounts: all('SELECT id, named_insured, status, territory, updated_at, created_at FROM accounts WHERE archived = 0 ORDER BY updated_at DESC LIMIT 5'),
    };
  }

  function todayView() {
    const t = today();
    return {
      tasks: all(`SELECT t.*, a.named_insured AS account_name FROM tasks t LEFT JOIN accounts a ON a.id = t.account_id
        WHERE t.archived = 0 AND t.status = 'Open' AND t.due_date <= ? ORDER BY ${prio('t.priority')}, t.due_date`, [t]),
      followups: all(`SELECT t.*, a.named_insured AS account_name FROM activities t LEFT JOIN accounts a ON a.id = t.account_id
        WHERE t.archived = 0 AND t.follow_up_done = 0 AND t.follow_up_date IS NOT NULL AND t.follow_up_date <= ?
        ORDER BY ${prio('t.priority')}, t.follow_up_date`, [t]),
      calls: callCounts(),
    };
  }

  function renewals(args) {
    const rd = renewalDateSql('p');
    let sql = renewalBase();
    const params = [];
    if (args.start) { sql += ` AND ${rd} >= ?`; params.push(args.start); }
    if (args.end) { sql += ` AND ${rd} <= ?`; params.push(args.end); }
    for (const [arg, col] of [['line', 'p.line'], ['carrier', 'p.carrier'], ['territory', 'a.territory'], ['account_id', 'p.account_id']]) {
      if (args[arg]) { sql += ` AND ${col} = ?`; params.push(args[arg]); }
    }
    return all(sql + ` AND ${rd} IS NOT NULL ORDER BY ${rd}, a.named_insured`, params);
  }

  function search(args) {
    const qq = (args.q || '').trim();
    if (!qq) return { accounts: [], contacts: [], policies: [], notes: [] };
    const like = `%${qq}%`;
    return {
      accounts: all(`SELECT id, named_insured, dba, city, state, status FROM accounts
        WHERE archived = 0 AND (named_insured LIKE ? OR dba LIKE ? OR fein LIKE ? OR city LIKE ?) ORDER BY named_insured COLLATE NOCASE LIMIT 50`, [like, like, like, like]),
      contacts: all(`SELECT c.id, c.account_id, c.name, c.title, c.email, c.phone, a.named_insured AS account_name
        FROM contacts c JOIN accounts a ON a.id = c.account_id
        WHERE c.archived = 0 AND a.archived = 0 AND (c.name LIKE ? OR c.email LIKE ? OR c.phone LIKE ?) ORDER BY c.name COLLATE NOCASE LIMIT 50`, [like, like, like]),
      policies: all(`SELECT p.id, p.account_id, p.line, p.carrier, p.policy_number, p.expiration_date, p.status, a.named_insured AS account_name
        FROM policies p JOIN accounts a ON a.id = p.account_id
        WHERE p.archived = 0 AND a.archived = 0 AND (p.policy_number LIKE ? OR p.carrier LIKE ? OR p.prior_carrier LIKE ? OR p.notes LIKE ?)
        ORDER BY p.expiration_date DESC LIMIT 50`, [like, like, like, like]),
      notes: all(`SELECT 'Note' AS kind, n.account_id, n.body AS text, n.created_at AS at, a.named_insured AS account_name
        FROM account_notes n JOIN accounts a ON a.id = n.account_id WHERE n.archived = 0 AND a.archived = 0 AND n.body LIKE ?
        UNION ALL
        SELECT 'Activity', t.account_id, t.type || ': ' || COALESCE(t.summary, '') || ' ' || COALESCE(t.next_step, ''), t.activity_date, a.named_insured
        FROM activities t LEFT JOIN accounts a ON a.id = t.account_id WHERE t.archived = 0 AND (t.summary LIKE ? OR t.next_step LIKE ?)
        ORDER BY at DESC LIMIT 50`, [like, like, like]),
    };
  }

  function boundFilter(args, al = 't') {
    const where = [`${al}.archived = 0`, 'a.archived = 0', `${al}.status IN ('Bound', 'Renewed')`], params = [];
    for (const [arg, col] of [['account_id', `${al}.account_id`], ['line', `${al}.line`], ['carrier', `${al}.carrier`], ['territory', 'a.territory']]) {
      if (args[arg]) { where.push(`${col} = ?`); params.push(args[arg]); }
    }
    if (args.start) { where.push(`${al}.effective_date >= ?`); params.push(args.start); }
    if (args.end) { where.push(`${al}.effective_date <= ?`); params.push(args.end); }
    return [where.join(' AND '), params];
  }

  function commission(args) {
    const [where, params] = boundFilter(args);
    const base = `FROM policies t JOIN accounts a ON a.id = t.account_id WHERE ${where}`;
    const policies = all(`SELECT t.id, t.account_id, a.named_insured AS account_name, t.line, t.carrier, t.policy_number,
        t.effective_date, t.expiration_date, t.premium, t.commission_pct, t.commission_amt, t.status, ${inForceSql('t')} AS in_force
      ${base} ORDER BY t.effective_date DESC`, params);
    const totals = one(`SELECT COALESCE(SUM(t.premium), 0) AS premium, COALESCE(SUM(t.commission_amt), 0) AS commission, COUNT(*) AS count ${base}`, params);
    const inForce = one(`SELECT COALESCE(SUM(t.premium), 0) AS premium, COALESCE(SUM(t.commission_amt), 0) AS commission, COUNT(*) AS count ${base} AND ${inForceSql('t')}`, params);
    const byYear = all(`SELECT strftime('%Y', t.effective_date) AS year, COUNT(*) AS count, COALESCE(SUM(t.premium), 0) AS premium,
        COALESCE(SUM(t.commission_amt), 0) AS commission ${base} AND t.effective_date IS NOT NULL GROUP BY year ORDER BY year`, params);
    let prev = null;
    for (const r of byYear) {
      r.yoy_commission = prev ? r.commission - prev.commission : null;
      r.yoy_pct = prev && prev.commission ? (r.commission - prev.commission) / prev.commission * 100 : null;
      prev = r;
    }
    const year = Number(args.year) || new Date().getFullYear();
    const monthly = {};
    for (const r of all(`SELECT CAST(strftime('%Y', t.effective_date) AS INTEGER) AS y, CAST(strftime('%m', t.effective_date) AS INTEGER) AS m,
        COALESCE(SUM(t.premium), 0) AS premium, COALESCE(SUM(t.commission_amt), 0) AS commission
      ${base} AND t.effective_date IS NOT NULL GROUP BY y, m`, params)) monthly[`${r.y}-${r.m}`] = r;
    const rd = renewalDateSql('t');
    const renewing = {};
    for (const r of all(`SELECT CAST(strftime('%m', ${rd}) AS INTEGER) AS m, COALESCE(SUM(t.commission_amt), 0) AS commission
      ${base} AND ${inForceSql('t')} AND strftime('%Y', ${rd}) = ? GROUP BY m`, [...params, String(year)])) renewing[r.m] = r;
    const months = [];
    for (let m = 1; m <= 12; m++) {
      const cur = monthly[`${year}-${m}`] || {}, last = monthly[`${year - 1}-${m}`] || {};
      months.push({ month: m, premium: cur.premium || 0, commission: cur.commission || 0,
        prior_year_commission: last.commission || 0, renewing_commission: (renewing[m] || {}).commission || 0 });
    }
    return { policies, totals, in_force: inForce, projection: { annual: inForce.commission, monthly: inForce.commission / 12 }, by_year: byYear, year, months };
  }

  function report(name, args) {
    if (name === 'book') {
      return all(`SELECT a.id AS account_id, a.named_insured AS account_name, a.dba, a.status AS account_status, a.territory, a.city, a.state,
          t.line, t.carrier, t.policy_number, t.effective_date, t.expiration_date, t.premium, t.commission_pct, t.commission_amt, t.status, t.aor_status
        FROM accounts a LEFT JOIN policies t ON t.account_id = a.id AND ${inForceSql('t')}
        WHERE a.archived = 0 AND a.status IN ('Active Client', 'BOR Won') ORDER BY a.named_insured COLLATE NOCASE, t.line`);
    }
    if (name === 'renewals') {
      const rd = renewalDateSql('p');
      const start = args.start || today(), end = args.end || addDays(start, 120);
      return all(renewalBase() + ` AND ${rd} >= ? AND ${rd} <= ? ORDER BY ${rd}`, [start, end]);
    }
    if (name === 'pipeline') {
      let sql = `SELECT d.id, d.account_id, a.named_insured AS account_name, a.territory, d.stage, d.source, d.est_premium, d.est_commission,
          d.stage_entered_at, d.target_date, d.lost_reason, CAST(julianday(${q(now())}) - julianday(d.stage_entered_at) AS INTEGER) AS days_in_stage
        FROM deals d JOIN accounts a ON a.id = d.account_id WHERE d.archived = 0 AND a.archived = 0`;
      const params = [];
      if (args.stage) { sql += ' AND d.stage = ?'; params.push(args.stage); }
      const order = C.pipeline_stages.map((s, i) => `WHEN '${s}' THEN ${i}`).join(' ');
      return { rows: all(sql + ` ORDER BY CASE d.stage ${order} END, a.named_insured`, params), summary: pipelineSummary() };
    }
    if (name === 'submissions') {
      let sql = `SELECT s.id, s.account_id, a.named_insured AS account_name, s.line, s.carrier, s.wholesaler, s.status, s.date_submitted,
          s.quote_amount, s.quote_date, s.target_premium, s.placement_exec, s.decline_reason
        FROM submissions s JOIN accounts a ON a.id = s.account_id WHERE s.archived = 0 AND a.archived = 0`;
      const params = [];
      for (const k of ['carrier', 'status']) if (args[k]) { sql += ` AND s.${k} = ?`; params.push(args[k]); }
      if (args.start) { sql += ' AND s.date_submitted >= ?'; params.push(args.start); }
      if (args.end) { sql += ' AND s.date_submitted <= ?'; params.push(args.end); }
      const rows = all(sql + ' ORDER BY s.carrier COLLATE NOCASE, s.status', params);
      const pivot = {};
      for (const r of rows) {
        const key = r.carrier || '(none)';
        pivot[key] = pivot[key] || Object.fromEntries(C.submission_statuses.map(s => [s, 0]));
        pivot[key][r.status] = (pivot[key][r.status] || 0) + 1;
      }
      return { rows, pivot: Object.keys(pivot).sort().map(k => Object.assign({ carrier: k }, pivot[k])) };
    }
    if (name === 'commission') {
      const fmts = {
        month: "strftime('%Y-%m', t.effective_date)",
        quarter: "strftime('%Y', t.effective_date) || '-Q' || ((CAST(strftime('%m', t.effective_date) AS INTEGER) + 2) / 3)",
        year: "strftime('%Y', t.effective_date)",
      };
      const fmt = fmts[args.group] || fmts.month;
      const [where, params] = boundFilter(args);
      return all(`SELECT ${fmt} AS period, COUNT(*) AS policies, COALESCE(SUM(t.premium), 0) AS premium, COALESCE(SUM(t.commission_amt), 0) AS commission
        FROM policies t JOIN accounts a ON a.id = t.account_id WHERE ${where} AND t.effective_date IS NOT NULL GROUP BY period ORDER BY period`, params);
    }
    if (name === 'lost') {
      return all(`SELECT 'Prospect' AS kind, d.account_id, a.named_insured AS account_name, a.territory, NULL AS line, NULL AS carrier,
          d.est_premium AS premium, substr(d.stage_entered_at, 1, 10) AS lost_date, d.lost_reason AS reason, d.lost_reason_detail AS detail, d.source
        FROM deals d JOIN accounts a ON a.id = d.account_id WHERE d.archived = 0 AND a.archived = 0 AND d.stage = 'Lost'
        UNION ALL
        SELECT 'Policy', p.account_id, a.named_insured, a.territory, p.line, p.carrier, p.premium, substr(p.updated_at, 1, 10), NULL, p.notes, NULL
        FROM policies p JOIN accounts a ON a.id = p.account_id WHERE p.archived = 0 AND a.archived = 0 AND p.status = 'Lost'
        ORDER BY lost_date DESC`);
    }
    throw new NotFound();
  }

  function archive() {
    const specs = [
      ['accounts', 'accounts', 'named_insured', null],
      ['contacts', 'contacts', 'name', 'account_id'],
      ['policies', 'policies', "line || ' - ' || COALESCE(carrier, '') || ' ' || COALESCE(policy_number, '')", 'account_id'],
      ['deals', 'deals', "'Pipeline: ' || stage", 'account_id'],
      ['submissions', 'submissions', "line || ' - ' || COALESCE(carrier, '')", 'account_id'],
      ['documents', 'documents', 'name', 'account_id'],
      ['loss_runs', 'loss_runs', "'Loss run ' || COALESCE(carrier, '')", 'account_id'],
      ['activities', 'activities', "type || ': ' || COALESCE(summary, '')", 'account_id'],
      ['tasks', 'tasks', 'title', 'account_id'],
      ['team', 'team_assignments', "role || ': ' || COALESCE(person_name, '')", 'account_id'],
    ];
    const out = [];
    for (const [res, table, label, acct] of specs) {
      const acctSql = acct ? `(SELECT named_insured FROM accounts WHERE id = t.${acct})` : 'NULL';
      for (const r of all(`SELECT t.id, ${label} AS label, ${acctSql} AS account_name, t.updated_at FROM ${table} t
          WHERE t.archived = 1 ORDER BY t.updated_at DESC LIMIT 500`)) out.push(Object.assign({ resource: res }, r));
    }
    return out.sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''));
  }

  // ------------------------------------------------------------------ request dispatcher
  function route(method, path, body) {
    const url = new URL(path, 'http://local');
    const args = Object.fromEntries(url.searchParams);
    const p = url.pathname.split('/').filter(Boolean);
    if (p[0] === 'r') {
      const res = resource(p[1]);
      const id = p[2] !== undefined ? Number(p[2]) : null;
      if (id === null && method === 'GET') return res.list(args);
      if (id === null && method === 'POST') return res.create(body || {});
      if (p[3] === 'restore' && method === 'POST') { res.setArchived(id, false); return { ok: true }; }
      if (method === 'GET') { const r = res.get(id); if (!r) throw new NotFound(); return r; }
      if (method === 'PUT') { if (!res.raw(id)) throw new NotFound(); return res.update(id, body || {}); }
      if (method === 'DELETE') { res.setArchived(id, true); return { ok: true }; }
    }
    if (path === '/lookups') return lookups();
    if (p[0] === 'settings' && method === 'PUT') return saveSettings(body || {});
    if (p[0] === 'accounts' && p[2] === 'full') return accountFull(Number(p[1]));
    if (p[0] === 'accounts' && p[2] === 'populate_docs') {
      if (!body || !body.line) throw new ValidationError('Line is required');
      tx(() => populateDocuments(Number(p[1]), body.line, null));
      return R.documents.list({ account_id: Number(p[1]) });
    }
    if (p[0] === 'policies' && p[2] === 'renew') return renewPolicy(Number(p[1]));
    if (p[0] === 'deals' && p[2] === 'history') {
      return all('SELECT stage, entered_at FROM deal_stage_history WHERE deal_id = ? ORDER BY entered_at, id', [Number(p[1])]);
    }
    if (p[0] === 'dashboard') return dashboard();
    if (p[0] === 'today') return todayView();
    if (p[0] === 'calls') return callCounts();
    if (p[0] === 'renewals') return renewals(args);
    if (p[0] === 'search') return search(args);
    if (p[0] === 'commission') return commission(args);
    if (p[0] === 'reports') return report(p[1], args);
    if (p[0] === 'archive') return archive();
    throw new NotFound();
  }

  // ------------------------------------------------------------------ persistence
  const IDB_NAME = 'book-crm', IDB_STORE = 'kv';
  function idb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async function idbGet(key) {
    const d = await idb();
    return new Promise((resolve, reject) => {
      const r = d.transaction(IDB_STORE).objectStore(IDB_STORE).get(key);
      r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
    });
  }
  async function idbSet(key, value) {
    const d = await idb();
    return new Promise((resolve, reject) => {
      const tr = d.transaction(IDB_STORE, 'readwrite');
      tr.objectStore(IDB_STORE).put(value, key);
      tr.oncomplete = () => resolve(); tr.onerror = () => reject(tr.error);
    });
  }

  const state = { fileHandle: null, fileOk: false, lastSaved: null, lastFileSave: null, lastBackup: null, saving: null, dirty: false, listeners: [] };
  const notify = () => state.listeners.forEach(fn => { try { fn(status()); } catch (e) { /* ignore */ } });
  function status() {
    return { lastSaved: state.lastSaved, fileName: state.fileHandle ? state.fileHandle.name : null, fileOk: state.fileOk,
      lastFileSave: state.lastFileSave, lastBackup: state.lastBackup, fsSupported: 'showSaveFilePicker' in window, dirty: state.dirty };
  }

  async function persist() {
    state.dirty = true;
    if (state.saving) { state.again = true; return state.saving; }
    state.saving = (async () => {
      do {
        state.again = false;
        const bytes = db.export();
        try {
          await idbSet('db', bytes);
          state.lastSaved = new Date().toISOString();
          await idbSet('lastSaved', state.lastSaved);
        } catch (e) { console.error('IndexedDB save failed', e); }
        if (state.fileHandle && state.fileOk) {
          try {
            const w = await state.fileHandle.createWritable();
            await w.write(bytes); await w.close();
            state.lastFileSave = new Date().toISOString();
          } catch (e) { console.error('File save failed', e); state.fileOk = false; }
        }
      } while (state.again);
      state.dirty = false;
      state.saving = null;
      notify();
    })();
    return state.saving;
  }

  function initSchema() {
    db.exec(CFG.schema);
    for (const [k, v] of Object.entries(CFG.default_settings)) {
      if (!one('SELECT 1 AS x FROM settings WHERE key = ?', [k])) insert('settings', { key: k, value: v });
    }
    for (const [line, pct] of Object.entries(CFG.default_commission)) {
      if (!one('SELECT 1 AS x FROM line_defaults WHERE line = ?', [line])) insert('line_defaults', { line, commission_pct: pct });
    }
    if (!one("SELECT value FROM settings WHERE key = '_seeded'")) {
      CFG.default_account_types.forEach(name => insert('account_types', { name }));
      CFG.default_carriers.forEach(name => insert('carriers', { name }));
      for (const [line, items] of Object.entries(CFG.default_doc_templates)) items.forEach((name, i) => insert('doc_templates', { line, name, sort_order: i }));
      insert('settings', { key: '_seeded', value: '1' });
    }
  }

  async function init() {
    const SQL = await initSqlJs({ wasmBinary: CFG.wasm() });
    LocalAPI.SQL = SQL;
    const saved = await idbGet('db').catch(() => null);
    db = saved ? new SQL.Database(saved) : new SQL.Database();
    initSchema();
    state.fileHandle = await idbGet('fileHandle').catch(() => null) || null;
    state.lastBackup = await idbGet('lastBackup').catch(() => null) || null;
    state.lastSaved = await idbGet('lastSaved').catch(() => null) || null;
    if (state.fileHandle && state.fileHandle.queryPermission) {
      state.fileOk = (await state.fileHandle.queryPermission({ mode: 'readwrite' })) === 'granted';
    }
    if (!saved) await persist();
    window.addEventListener('beforeunload', (e) => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
    notify();
  }

  async function handle(method, path, body) {
    try {
      const result = route(method, path, body);
      if (method !== 'GET' && !state.deferred) await persist();
      return result;
    } catch (e) {
      if (e instanceof ValidationError) throw Object.assign(new Error(e.message), { status: 400 });
      if (e instanceof NotFound) throw Object.assign(new Error('Not found'), { status: 404 });
      console.error(e);
      throw e;
    }
  }

  // ------------------------------------------------------------------ backup / file controls
  function stamp() { return today(); }
  function downloadBackup() {
    const blob = new Blob([db.export()], { type: 'application/x-sqlite3' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `crm-backup-${stamp()}.db`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    state.lastBackup = new Date().toISOString();
    idbSet('lastBackup', state.lastBackup);
    notify();
  }
  async function restoreFromBytes(bytes) {
    const test = new LocalAPI.SQL.Database(bytes);
    try { test.exec('SELECT COUNT(*) FROM accounts'); } catch (e) { test.close(); throw new Error('That file is not a Book CRM database.'); }
    db.close();
    db = test;
    initSchema();
    await persist();
  }
  async function linkFile() {
    const handle = await window.showSaveFilePicker({ suggestedName: 'crm.db', types: [{ description: 'SQLite database', accept: { 'application/x-sqlite3': ['.db'] } }] });
    state.fileHandle = handle; state.fileOk = true;
    await idbSet('fileHandle', handle);
    await persist();
  }
  async function openFile() {
    const [handle] = await window.showOpenFilePicker({ types: [{ description: 'SQLite database', accept: { 'application/x-sqlite3': ['.db'] } }] });
    const bytes = new Uint8Array(await (await handle.getFile()).arrayBuffer());
    await restoreFromBytes(bytes);
    state.fileHandle = handle; state.fileOk = (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
    await idbSet('fileHandle', handle);
    await persist();
  }
  async function reconnectFile() {
    if (!state.fileHandle) return false;
    state.fileOk = (await state.fileHandle.requestPermission({ mode: 'readwrite' })) === 'granted';
    if (state.fileOk) await persist(); else notify();
    return state.fileOk;
  }
  async function unlinkFile() {
    state.fileHandle = null; state.fileOk = false;
    await idbSet('fileHandle', null);
    notify();
  }

  // Bulk operations (e.g. the document importer): save once at the end instead of after every write.
  async function withDeferredSave(fn) {
    state.deferred = true;
    try { return await fn(); }
    finally { state.deferred = false; await persist(); }
  }

  return {
    init, handle, withDeferredSave, status, downloadBackup, restoreFromBytes, linkFile, openFile, reconnectFile, unlinkFile,
    onStatus: fn => state.listeners.push(fn),
  };
})();
window.LocalAPI = LocalAPI;
