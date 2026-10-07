/* Core helpers: DOM, API, formatting, modal, forms, data tables, router. */
'use strict';

const S = { lookups: null, accounts: null, route: null };

// ---------------------------------------------------------------- DOM
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  const late = {};
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value' || k === 'checked' || k === 'selected') late[k] = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
  }
  append(el, kids);
  for (const [k, v] of Object.entries(late)) el[k] = v;
  return el;
}

function append(el, kids) {
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------------------------------------------------------------- API
async function api(path, opts = {}) {
  const init = { method: opts.method || 'GET', headers: {} };
  if (opts.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(opts.body);
  }
  const res = await fetch('/api' + path, init);
  let data = null;
  try { data = await res.json(); } catch (e) { /* empty body */ }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}
const R = {
  list: (res, params = {}) => api(`/r/${res}?` + new URLSearchParams(params)),
  get: (res, id) => api(`/r/${res}/${id}`),
  create: (res, body) => api(`/r/${res}`, { method: 'POST', body }),
  update: (res, id, body) => api(`/r/${res}/${id}`, { method: 'PUT', body }),
  archive: (res, id) => api(`/r/${res}/${id}`, { method: 'DELETE' }),
  restore: (res, id) => api(`/r/${res}/${id}/restore`, { method: 'POST' }),
};

async function loadLookups() { S.lookups = await api('/lookups'); return S.lookups; }
async function accountsCache(force) {
  if (!S.accounts || force) S.accounts = await R.list('accounts');
  return S.accounts;
}
function invalidateAccounts() { S.accounts = null; }

// ---------------------------------------------------------------- Formatting
function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}
function addDaysISO(iso, n) {
  const d = parseISO(iso); d.setDate(d.getDate() + n);
  return toISO(d);
}
function parseISO(iso) { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return new Date(y, m - 1, d); }
function toISO(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }
function daysUntil(iso) {
  if (!iso) return null;
  return Math.round((parseISO(iso) - parseISO(todayISO())) / 86400000);
}
function fmtDate(iso) {
  if (!iso) return '';
  const s = String(iso);
  if (!/^\d{4}-\d{2}-\d{2}/.test(s)) return s;
  return `${s.slice(5, 7)}/${s.slice(8, 10)}/${s.slice(0, 4)}`;
}
function fmtDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts.replace(' ', 'T'));
  if (isNaN(d)) return ts;
  return d.toLocaleString(undefined, { month: '2-digit', day: '2-digit', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}
const MONEY0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0, minimumFractionDigits: 0 });
const MONEY2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
function fmtMoney(v, cents) {
  if (v === null || v === undefined || v === '') return '';
  const n = Number(v);
  if (isNaN(n)) return String(v);
  return (cents ? MONEY2 : MONEY0).format(n);
}
function fmtNum(v) { return v === null || v === undefined || v === '' ? '' : Number(v).toLocaleString('en-US'); }
function fmtPct(v) { return v === null || v === undefined || v === '' ? '' : `${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`; }
function parseNum(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/[$,%\s]/g, '');
  if (s === '') return null;
  const n = Number(s);
  return isNaN(n) ? null : n;
}
function monthName(key) { // "2026-10" -> "Oct 2026"
  const [y, m] = key.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-US', { month: 'short', year: 'numeric' });
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function urgency(days) {
  if (days === null) return 'gray';
  if (days <= 30) return 'red';
  if (days <= 60) return 'yellow';
  if (days <= 90) return 'green';
  if (days <= 120) return 'blue';
  return 'gray';
}

const STATUS_COLORS = {
  // account
  'Prospect': 'blue', 'BOR Submitted': 'yellow', 'BOR Won': 'green', 'Active Client': 'green', 'Lost': 'red',
  // policy
  'Bound': 'green', 'Renewed': 'green', 'Quoted': 'blue', 'Submitted': 'yellow', 'Marketing': 'yellow',
  'Not Yet Marketed': 'yellow', 'Cancelled': 'red',
  // submission / docs / tasks
  'Pending': 'yellow', 'Need Additional Info': 'red', 'Declined': 'red', 'Requested': 'yellow', 'Received': 'green',
  'Not Requested': 'gray', 'N/A': 'gray', 'Open': 'blue', 'Done': 'green',
  'High': 'red', 'Medium': 'yellow', 'Low': 'gray',
  'Handed Off': 'yellow', 'In Progress': 'blue', 'Complete': 'green',
  'Won': 'green', 'AOR': 'green', 'BOR Pending': 'yellow', 'Not AOR': 'red',
};
function badge(text, color) {
  if (!text) return '';
  return h('span', { class: `badge ${color || STATUS_COLORS[text] || ''}` }, text);
}
function accountLink(row, idKey = 'account_id', nameKey = 'account_name') {
  if (!row[idKey]) return h('span', { class: 'muted' }, '—');
  return h('a', { href: `#/accounts/${row[idKey]}`, onclick: (e) => e.stopPropagation() }, row[nameKey] || `#${row[idKey]}`);
}

// ---------------------------------------------------------------- Toast / modal
function toast(msg, isError) {
  const el = h('div', { class: 'toast' + (isError ? ' error' : '') }, msg);
  $('#toastRoot').appendChild(el);
  setTimeout(() => el.remove(), isError ? 6000 : 2600);
}

const modalStack = [];
function openModal({ title, body, actions = [], wide = false, onClose }) {
  const close = () => {
    backdrop.remove();
    const i = modalStack.indexOf(ctl);
    if (i >= 0) modalStack.splice(i, 1);
    if (onClose) onClose();
  };
  const foot = actions.length ? h('div', { class: 'modal-foot' }, actions.map(a => a === 'spacer'
    ? h('div', { class: 'spacer' })
    : h('button', { class: `btn ${a.class || ''}`, type: a.submit ? 'submit' : 'button', onclick: a.onclick ? () => a.onclick(ctl) : null }, a.label))) : null;
  const modal = h('div', { class: 'modal' + (wide ? ' wide' : '') },
    h('div', { class: 'modal-head' }, h('h2', null, title), h('button', { class: 'icon-btn', onclick: close, 'aria-label': 'Close' }, '×')),
    h('div', { class: 'modal-body' }, body), foot);
  const backdrop = h('div', { class: 'modal-backdrop', onmousedown: (e) => { if (e.target === backdrop) close(); } }, modal);
  const ctl = { close, el: modal };
  modalStack.push(ctl);
  $('#modalRoot').appendChild(backdrop);
  const first = modal.querySelector('input:not([type=checkbox]):not([type=hidden]), select, textarea');
  if (first) setTimeout(() => first.focus(), 30);
  return ctl;
}
function confirmDialog(message, okLabel = 'Confirm') {
  return new Promise(resolve => {
    let done = false;
    openModal({
      title: 'Please confirm', body: h('p', null, message),
      actions: [{ label: 'Cancel', onclick: m => m.close() }, 'spacer',
        { label: okLabel, class: 'btn-primary', onclick: m => { done = true; m.close(); resolve(true); } }],
      onClose: () => { if (!done) resolve(false); },
    });
  });
}

// ---------------------------------------------------------------- Form builder
/*
 field: {key, label, type, options, required, full, default, showIf(values), help, section, placeholder}
 types: text, email, tel, url, number, money, pct, date, select, textarea, checkbox, multiselect,
        account, carrier, person, readonly
*/
function optionList(opts) { return typeof opts === 'function' ? opts() : (opts || []); }

function buildForm(fields, values = {}, opts = {}) {
  const isNew = !values.id;
  const grid = h('div', { class: 'form-grid' });
  const inputs = {};
  const wrappers = {};

  for (const f of fields) {
    if (f.section) { grid.appendChild(h('div', { class: 'form-section' }, f.section)); continue; }
    let v = values[f.key];
    if ((v === undefined || v === null) && isNew && f.default !== undefined) {
      v = f.default === 'today' ? todayISO() : (typeof f.default === 'function' ? f.default(values) : f.default);
    }
    const input = makeInput(f, v);
    inputs[f.key] = input;
    const label = f.type === 'checkbox' ? null
      : h('label', null, f.label, f.required ? h('span', { class: 'req' }, ' *') : null);
    const wrap = h('div', { class: 'field' + (f.full || f.type === 'textarea' || f.type === 'multiselect' ? ' full' : '') },
      label, input.el, f.help ? h('div', { class: 'help' }, f.help) : null);
    wrappers[f.key] = wrap;
    grid.appendChild(wrap);
  }
  const errorEl = h('div', { class: 'form-error' });
  const form = h('form', { onsubmit: (e) => { e.preventDefault(); if (opts.onSubmit) opts.onSubmit(); } }, grid, errorEl,
    h('button', { type: 'submit', class: 'hidden' }));

  const api_ = {
    el: form,
    inputs,
    get(key) { return inputs[key] ? inputs[key].get() : undefined; },
    set(key, val) { if (inputs[key]) inputs[key].set(val); },
    values() {
      const out = {};
      for (const f of fields) if (f.key && inputs[f.key] && f.type !== 'readonly') out[f.key] = inputs[f.key].get();
      return out;
    },
    error(msg) { errorEl.textContent = msg || ''; },
    validate() {
      const vals = api_.values();
      for (const f of fields) {
        if (!f.required || !f.key || wrappers[f.key].classList.contains('hidden')) continue;
        const v = vals[f.key];
        if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) {
          api_.error(`${f.label} is required`);
          return false;
        }
      }
      api_.error('');
      return true;
    },
    refreshVisibility() {
      const vals = api_.values();
      for (const f of fields) if (f.showIf && wrappers[f.key]) wrappers[f.key].classList.toggle('hidden', !f.showIf(vals));
    },
  };
  for (const f of fields) {
    if (!f.key || !inputs[f.key]) continue;
    inputs[f.key].onChange(() => {
      api_.refreshVisibility();
      if (f.onChange) f.onChange(api_);
    });
  }
  api_.refreshVisibility();
  return api_;
}

function makeInput(f, value) {
  const listeners = [];
  const fire = () => listeners.forEach(fn => fn());
  const t = f.type || 'text';
  let el, get, set;

  if (t === 'select') {
    el = h('select', { onchange: fire },
      f.required && !f.blank ? null : h('option', { value: '' }, f.placeholder || '—'),
      optionList(f.options).map(o => typeof o === 'object'
        ? h('option', { value: o.value }, o.label) : h('option', { value: o }, o)));
    if (value !== undefined && value !== null && !Array.from(el.options).some(o => o.value === String(value))) {
      el.appendChild(h('option', { value }, value));
    }
    get = () => el.value || null;
    set = (v) => { el.value = v ?? ''; };
    set(value);
  } else if (t === 'textarea') {
    el = h('textarea', { rows: f.rows || 3, placeholder: f.placeholder || '', oninput: fire });
    get = () => el.value.trim() || null;
    set = (v) => { el.value = v ?? ''; };
    set(value);
  } else if (t === 'checkbox') {
    const cb = h('input', { type: 'checkbox', onchange: fire });
    el = h('label', { class: 'check' }, cb, f.label);
    get = () => cb.checked;
    set = (v) => { cb.checked = !!v && v !== '0'; };
    set(value);
  } else if (t === 'multiselect') {
    const boxes = optionList(f.options).map(o => h('input', { type: 'checkbox', value: o, onchange: fire }));
    el = h('div', { class: 'check-group' }, boxes.map(b => h('label', null, b, b.value)));
    get = () => boxes.filter(b => b.checked).map(b => b.value);
    set = (v) => { const arr = Array.isArray(v) ? v : []; boxes.forEach(b => { b.checked = arr.includes(b.value); }); };
    set(value);
  } else if (t === 'money' || t === 'pct' || t === 'number') {
    el = h('input', { type: 'text', inputmode: 'decimal', placeholder: f.placeholder || (t === 'money' ? '$0' : t === 'pct' ? '0%' : ''), oninput: fire });
    const fmt = (n) => n === null ? '' : t === 'money' ? fmtMoney(n, n % 1 !== 0) : t === 'pct' ? fmtPct(n) : String(n);
    el.addEventListener('blur', () => { const n = parseNum(el.value); el.value = fmt(n); });
    el.addEventListener('focus', () => { const n = parseNum(el.value); el.value = n === null ? '' : String(n); el.select(); });
    get = () => parseNum(el.value);
    set = (v) => { el.value = fmt(parseNum(v)); };
    set(value);
  } else if (t === 'account') {
    return accountPicker(f, value, listeners);
  } else if (t === 'carrier' || t === 'person') {
    const listId = `dl-${t}-${Math.random().toString(36).slice(2, 8)}`;
    const opts = t === 'carrier' ? S.lookups.carriers : S.lookups.team_members.map(m => m.name);
    const input = h('input', { type: 'text', list: listId, placeholder: f.placeholder || '', oninput: fire, onchange: fire });
    el = h('div', null, input, h('datalist', { id: listId }, opts.map(o => h('option', { value: o }))));
    get = () => input.value.trim() || null;
    set = (v) => { input.value = v ?? ''; };
    set(value);
  } else if (t === 'readonly') {
    el = h('div', { class: 'muted', style: { padding: '7px 0' } });
    get = () => value;
    set = (v) => { el.textContent = f.format ? f.format(v) : (v ?? ''); };
    set(value);
  } else {
    const type = { date: 'date', email: 'email', tel: 'tel', url: 'url' }[t] || 'text';
    el = h('input', { type, placeholder: f.placeholder || '', oninput: fire, onchange: fire });
    get = () => el.value.trim() || null;
    set = (v) => { el.value = v ?? ''; };
    set(value);
  }
  return { el, get, set, onChange: fn => listeners.push(fn) };
}

function accountPicker(f, value, listeners) {
  let selected = value ? Number(value) : null;
  const fire = () => listeners.forEach(fn => fn());
  const input = h('input', { type: 'text', placeholder: 'Type to search accounts…', autocomplete: 'off' });
  const list = h('div', { class: 'combo-list hidden' });
  const wrap = h('div', { class: 'combo' }, input, list);
  let items = [];
  let active = 0;

  const label = (a) => a ? a.named_insured : '';
  accountsCache().then(accts => {
    if (selected) { const a = accts.find(x => x.id === selected); input.value = label(a); }
  });

  function render() {
    const q = input.value.trim().toLowerCase();
    const accts = S.accounts || [];
    items = accts.filter(a => !q || a.named_insured.toLowerCase().includes(q) || (a.dba || '').toLowerCase().includes(q)).slice(0, 30);
    clear(list);
    if (!items.length) { list.appendChild(h('div', { class: 'sub' }, 'No matches')); }
    items.forEach((a, i) => list.appendChild(h('div', {
      class: i === active ? 'active' : '',
      onmousedown: (e) => { e.preventDefault(); choose(a); },
    }, a.named_insured, h('div', { class: 'sub' }, [a.dba, a.city, a.status].filter(Boolean).join(' · ')))));
    list.classList.remove('hidden');
  }
  function choose(a) {
    selected = a ? a.id : null;
    input.value = label(a);
    list.classList.add('hidden');
    fire();
  }
  input.addEventListener('focus', async () => { await accountsCache(); active = 0; render(); });
  input.addEventListener('input', () => { selected = null; active = 0; render(); fire(); });
  input.addEventListener('blur', () => setTimeout(() => list.classList.add('hidden'), 120));
  input.addEventListener('keydown', (e) => {
    if (list.classList.contains('hidden')) return;
    if (e.key === 'ArrowDown') { active = Math.min(active + 1, items.length - 1); render(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); render(); e.preventDefault(); }
    else if (e.key === 'Enter' && items[active]) { choose(items[active]); e.preventDefault(); }
    else if (e.key === 'Escape') { list.classList.add('hidden'); e.stopPropagation(); }
  });
  return {
    el: wrap,
    get: () => selected,
    set: (v) => { selected = v ? Number(v) : null; accountsCache().then(accts => { input.value = label(accts.find(x => x.id === selected)); }); },
    onChange: fn => listeners.push(fn),
  };
}

/*
 Generic record editor in a modal.
 opts: {resource, fields, record, title, defaults, onSaved(row), wide, extra(node), beforeSave(values, form)}
*/
function editRecord(opts) {
  const record = opts.record || null;
  const values = Object.assign({}, opts.defaults || {}, record || {});
  let modal;
  const save = async () => {
    if (!form.validate()) return;
    let vals = form.values();
    try {
      if (opts.beforeSave) {
        const r = await opts.beforeSave(vals, form, record);
        if (r === false) return;
        if (r) vals = r;
      }
      const row = record && record.id
        ? await R.update(opts.resource, record.id, vals)
        : await R.create(opts.resource, Object.assign({}, opts.hidden || {}, vals));
      modal.close();
      toast(record && record.id ? 'Saved' : 'Created');
      if (opts.resource === 'accounts') invalidateAccounts();
      if (opts.onSaved) opts.onSaved(row);
      else refreshRoute();
    } catch (e) { form.error(e.message); }
  };
  const form = buildForm(opts.fields, values, { onSubmit: save });
  const actions = [];
  if (record && record.id && opts.archivable !== false) {
    actions.push({
      label: 'Archive', class: 'btn-danger', onclick: async (m) => {
        if (!await confirmDialog('Archive this record? You can restore it later from the Archive page.', 'Archive')) return;
        await R.archive(opts.resource, record.id);
        m.close();
        toast('Archived');
        if (opts.resource === 'accounts') invalidateAccounts();
        if (opts.onArchived) opts.onArchived(); else refreshRoute();
      },
    });
  }
  actions.push('spacer', { label: 'Cancel', onclick: m => m.close() }, { label: 'Save', class: 'btn-primary', onclick: save });
  modal = openModal({ title: opts.title, body: h('div', null, opts.extraTop || null, form.el, opts.extra || null), actions, wide: opts.wide });
  if (opts.afterOpen) opts.afterOpen(form, modal);
  return { form, modal };
}

// ---------------------------------------------------------------- CSV export
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadCSV(name, headers, rows) {
  const lines = [];
  const st = (S.lookups && S.lookups.settings) || {};
  if (st.export_header === '1' && (st.user_name || st.agency_name)) {
    lines.push(csvCell(`Prepared by: ${[st.user_name, st.user_title, st.agency_name].filter(Boolean).join(', ')}`));
    const contact = [st.user_email, st.user_phone].filter(Boolean).join(' | ');
    if (contact) lines.push(csvCell(contact));
    lines.push(csvCell(`${name} — exported ${fmtDate(todayISO())}`));
    lines.push('');
  }
  lines.push(headers.map(csvCell).join(','));
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `${name.replace(/[^\w-]+/g, '_')}_${todayISO()}.csv` });
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------------------------------------------------------------- Data table
/*
 DataTable({
   columns: [{key, label, type: text|money|date|number|pct|bool|badge, render(row), value(row), sum, filter:false, sortable:false, cls}],
   rows, name (CSV filename), rowClass(row), onRowClick(row), emptyText, search: true, csv: true,
   defaultSort: {key, dir}, toolbarExtra: [nodes], footer: true(auto sums)
 })
 Click a header to sort; type in the filter row under the header to filter that column.
*/
function DataTable(cfg) {
  const cols = cfg.columns;
  const state = { sortKey: cfg.defaultSort ? cfg.defaultSort.key : null, sortDir: cfg.defaultSort ? cfg.defaultSort.dir : 1, q: '', filters: {} };
  const rowsAll = cfg.rows || [];
  const colValue = (c, r) => c.value ? c.value(r) : r[c.key];
  const colText = (c, r) => {
    const v = colValue(c, r);
    if (v === null || v === undefined) return '';
    switch (c.type) {
      case 'money': return fmtMoney(v);
      case 'date': return fmtDate(v);
      case 'pct': return fmtPct(v);
      case 'bool': return v ? 'Yes' : '';
      case 'number': return fmtNum(v);
      default: return Array.isArray(v) ? v.join(', ') : String(v);
    }
  };
  const numeric = (c) => ['money', 'number', 'pct'].includes(c.type);

  const countEl = h('span', { class: 'muted small' });
  const search = cfg.search === false ? null : h('input', {
    type: 'search', placeholder: 'Filter rows…', oninput: (e) => { state.q = e.target.value.toLowerCase(); renderBody(); },
  });
  const csvBtn = cfg.csv === false ? null : h('button', { class: 'btn btn-sm', onclick: () => exportCSV() }, '⤓ CSV');
  const toolbar = h('div', { class: 'dt-toolbar' }, search, cfg.toolbarExtra || null, h('div', { class: 'spacer' }), countEl, csvBtn);

  const headRow = h('tr');
  const filterRow = h('tr', { class: 'filter-row' });
  const tbody = h('tbody');
  const tfoot = h('tfoot');
  const hasFilters = cfg.filters !== false;

  cols.forEach(c => {
    const sortable = c.sortable !== false;
    const th = h('th', { class: (sortable ? 'sortable ' : '') + (numeric(c) ? 'num' : ''), onclick: sortable ? () => {
      if (state.sortKey === c.key) state.sortDir = -state.sortDir; else { state.sortKey = c.key; state.sortDir = 1; }
      renderHead(); renderBody();
    } : null }, c.label);
    th._col = c;
    headRow.appendChild(th);
    let fcell;
    if (!hasFilters || c.filter === false) fcell = h('th');
    else if (c.filterOptions) {
      fcell = h('th', null, h('select', { onchange: (e) => { state.filters[c.key] = e.target.value; renderBody(); } },
        h('option', { value: '' }, 'All'), c.filterOptions.map(o => h('option', { value: o }, o))));
    } else {
      fcell = h('th', null, h('input', { type: 'text', placeholder: '', oninput: (e) => { state.filters[c.key] = e.target.value.toLowerCase(); renderBody(); } }));
    }
    filterRow.appendChild(fcell);
  });

  const table = h('table', null, h('thead', null, headRow, hasFilters ? filterRow : null), tbody, tfoot);
  const wrap = h('div', null, toolbar, h('div', { class: 'table-wrap' }, table));

  function renderHead() {
    Array.from(headRow.children).forEach(th => {
      const c = th._col;
      const old = th.querySelector('.arrow'); if (old) old.remove();
      if (state.sortKey === c.key) th.appendChild(h('span', { class: 'arrow' }, state.sortDir > 0 ? '▲' : '▼'));
    });
  }

  function currentRows() {
    let out = rowsAll.filter(r => {
      for (const [k, fv] of Object.entries(state.filters)) {
        if (!fv) continue;
        const c = cols.find(x => x.key === k);
        const text = colText(c, r).toLowerCase();
        if (c.filterOptions ? text !== fv.toLowerCase() && !text.split(', ').includes(fv.toLowerCase()) : !text.includes(fv)) return false;
      }
      if (state.q) return cols.some(c => colText(c, r).toLowerCase().includes(state.q));
      return true;
    });
    if (state.sortKey) {
      const c = cols.find(x => x.key === state.sortKey);
      out = out.slice().sort((a, b) => {
        const sv = c.sortValue || ((r) => colValue(c, r));
        let va = sv(a), vb = sv(b);
        const ea = va === null || va === undefined || va === '', eb = vb === null || vb === undefined || vb === '';
        if (ea && eb) return 0; if (ea) return 1; if (eb) return -1;
        if (numeric(c) || (typeof va === 'number' && typeof vb === 'number')) return (Number(va) - Number(vb)) * state.sortDir;
        if (Array.isArray(va)) va = va.join(', '); if (Array.isArray(vb)) vb = vb.join(', ');
        return String(va).localeCompare(String(vb), undefined, { numeric: true, sensitivity: 'base' }) * state.sortDir;
      });
    }
    return out;
  }

  function renderBody() {
    const rows = currentRows();
    clear(tbody);
    if (!rows.length) {
      tbody.appendChild(h('tr', null, h('td', { colspan: cols.length, class: 'empty' }, rowsAll.length ? 'No rows match the filters.' : (cfg.emptyText || 'Nothing here yet.'))));
    }
    for (const r of rows) {
      const tr = h('tr', { class: [cfg.rowClass ? cfg.rowClass(r) : '', cfg.onRowClick ? 'clickable' : ''].join(' ').trim() || null });
      if (cfg.onRowClick) tr.addEventListener('click', (e) => {
        if (e.target.closest('a, button, input, select, label')) return;
        cfg.onRowClick(r);
      });
      for (const c of cols) {
        const content = c.render ? c.render(r) : (c.type === 'badge' ? badge(colValue(c, r)) : colText(c, r));
        tr.appendChild(h('td', { class: [(numeric(c) ? 'num' : ''), c.cls || ''].join(' ').trim() || null }, content));
      }
      tbody.appendChild(tr);
    }
    countEl.textContent = `${rows.length}${rows.length !== rowsAll.length ? ' of ' + rowsAll.length : ''} row${rowsAll.length === 1 ? '' : 's'}`;
    clear(tfoot);
    if (cols.some(c => c.sum) && rows.length) {
      const tr = h('tr');
      cols.forEach((c, i) => {
        if (c.sum) {
          const total = rows.reduce((s, r) => s + (Number(colValue(c, r)) || 0), 0);
          tr.appendChild(h('td', { class: 'num' }, c.type === 'money' ? fmtMoney(total) : fmtNum(total)));
        } else tr.appendChild(h('td', null, i === 0 ? 'Total' : ''));
      });
      tfoot.appendChild(tr);
    }
  }

  function exportCSV() {
    const rows = currentRows();
    const exportCols = cols.filter(c => c.export !== false);
    const data = rows.map(r => exportCols.map(c => {
      if (c.exportValue) return c.exportValue(r);
      const v = colValue(c, r);
      if (v === null || v === undefined) return '';
      if (numeric(c)) return v;
      if (c.type === 'date') return fmtDate(v);
      if (c.type === 'bool') return v ? 'Yes' : 'No';
      return Array.isArray(v) ? v.join('; ') : v;
    }));
    if (exportCols.some(c => c.sum)) {
      data.push(exportCols.map((c, i) => c.sum ? rows.reduce((s, r) => s + (Number(colValue(c, r)) || 0), 0) : (i === 0 ? 'Total' : '')));
    }
    downloadCSV(cfg.name || 'export', exportCols.map(c => c.label), data);
  }

  renderHead();
  renderBody();
  wrap.exportCSV = exportCSV;
  wrap.currentRows = currentRows;
  return wrap;
}

// ---------------------------------------------------------------- Router
const routes = [];
function route(pattern, handler) {
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ re, keys, handler });
}
async function dispatch() {
  const hash = location.hash.slice(1) || '/';
  const [path, qs] = hash.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  for (const r of routes) {
    const m = path.match(r.re);
    if (!m) continue;
    const params = {};
    r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    S.route = { path, params, query, handler: r.handler };
    highlightNav(path);
    document.body.classList.remove('nav-open');
    const main = $('#main');
    try {
      await r.handler(main, params, query);
    } catch (e) {
      console.error(e);
      clear(main).appendChild(h('div', { class: 'panel' }, h('h2', null, 'Something went wrong'), h('p', { class: 'muted' }, e.message)));
    }
    return;
  }
  clear($('#main')).appendChild(h('div', { class: 'panel' }, 'Page not found.'));
}
async function refreshRoute() {
  if (!S.route) return dispatch();
  const y = window.scrollY;
  const main = $('#main');
  try { await S.route.handler(main, S.route.params, S.route.query); } catch (e) { toast(e.message, true); }
  window.scrollTo(0, y);
}
function highlightNav(path) {
  const base = '/' + (path.split('/')[1] || '');
  $$('.sidebar a').forEach(a => {
    const href = a.getAttribute('href').slice(1);
    a.classList.toggle('active', href === base || (href === '/' && base === '/'));
  });
}
function setQuery(params) {
  const path = (location.hash.slice(1) || '/').split('?')[0];
  const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== '' && v != null)).toString();
  history.replaceState(null, '', '#' + path + (qs ? '?' + qs : ''));
  if (S.route) S.route.query = Object.fromEntries(new URLSearchParams(qs));
}

// ---------------------------------------------------------------- Misc UI
function pageHead(title, ...right) {
  return h('div', { class: 'page-head' }, h('h1', null, title), h('div', { class: 'spacer' }), right);
}
function stat(label, value, sub, opts = {}) {
  return h(opts.href ? 'a' : 'div', { class: 'stat ' + (opts.cls || ''), href: opts.href }, h('div', { class: 'label' }, label),
    h('div', { class: 'value' }, value), sub ? h('div', { class: 'sub' }, sub) : null);
}
function selectFilter(label, options, value, onchange) {
  return h('select', { onchange: (e) => onchange(e.target.value), title: label },
    h('option', { value: '' }, `All ${label}`),
    options.map(o => h('option', { value: o, selected: o === value }, o)));
}
function tabs(names, active, onSelect) {
  return h('div', { class: 'tabs' }, names.map(([key, label, count]) =>
    h('button', { class: key === active ? 'active' : '', onclick: () => onSelect(key) }, label,
      count !== undefined && count !== null ? h('span', { class: 'count' }, count) : null)));
}
