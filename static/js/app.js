/* Boot: load lookups, wire up nav, search, theme and keyboard shortcuts. */
'use strict';

(async function boot() {
  // Theme (dark by default)
  let theme = 'dark';
  try { theme = localStorage.getItem('crm-theme') || 'dark'; } catch (e) { /* storage blocked */ }
  document.documentElement.dataset.theme = theme;
  $('#themeToggle').addEventListener('click', () => {
    theme = theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('crm-theme', theme); } catch (e) { /* ignore */ }
  });

  // Collapsible sidebar sections
  let collapsed = {};
  try { collapsed = JSON.parse(localStorage.getItem('crm-nav') || '{}'); } catch (e) { /* ignore */ }
  $$('.nav-section').forEach(sec => {
    const key = sec.dataset.section;
    if (collapsed[key]) sec.classList.add('collapsed');
    $('.nav-head', sec).addEventListener('click', () => {
      sec.classList.toggle('collapsed');
      collapsed[key] = sec.classList.contains('collapsed');
      try { localStorage.setItem('crm-nav', JSON.stringify(collapsed)); } catch (e) { /* ignore */ }
    });
  });
  $('#menuToggle').addEventListener('click', () => document.body.classList.toggle('nav-open'));
  $('#scrim').addEventListener('click', () => document.body.classList.remove('nav-open'));

  // Global search
  $('#globalSearch').addEventListener('submit', (e) => {
    e.preventDefault();
    const q = $('#globalSearchInput').value.trim();
    if (q) location.hash = '#/search?q=' + encodeURIComponent(q);
  });

  // Quick-add buttons
  $$('[data-quick]').forEach(b => b.addEventListener('click', () => quickAdd(b.dataset.quick)));

  // Keyboard shortcuts: N = account, T = task, A = activity, / = search, Esc = close modal
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modalStack.length) { modalStack[modalStack.length - 1].close(); return; }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'textarea', 'select'].includes(tag) || e.target.isContentEditable) return;
    if (modalStack.length) return;
    const k = e.key.toLowerCase();
    if (k === 'n') { e.preventDefault(); quickAdd('account'); }
    else if (k === 't') { e.preventDefault(); quickAdd('task'); }
    else if (k === 'a') { e.preventDefault(); quickAdd('activity'); }
    else if (e.key === '/') { e.preventDefault(); $('#globalSearchInput').focus(); }
  });

  try {
    await loadLookups();
  } catch (e) {
    $('#main').appendChild(h('div', { class: 'panel' }, h('h2', null, 'Cannot reach the CRM server'), h('p', null, e.message)));
    return;
  }
  window.addEventListener('hashchange', dispatch);
  dispatch();
})();
