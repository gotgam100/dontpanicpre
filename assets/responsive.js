/* responsive.js — mobile/responsive enhancements
 * Both app.js and responsive.js are deferred in order.
 * app.js runs first, then this file. DOM is ready at this point.
 * No DOMContentLoaded wrapper needed.
 */
(function () {

  /* ============================================================
   * 1. THEME TOGGLE — light / dark
   * ============================================================ */
  const THEME_KEY = 'dpre-theme';

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(THEME_KEY, theme);
    // Update all toggle buttons (header + drawer)
    document.querySelectorAll('.theme-toggle-btn, #themeToggleBtn').forEach(btn => {
      btn.textContent = theme === 'light' ? '🌙' : '☀️';
      btn.title = theme === 'light' ? '다크 모드로 전환' : '라이트 모드로 전환';
    });
  }

  window.toggleTheme = function () {
    const current = document.documentElement.getAttribute('data-theme') || 'dark';
    applyTheme(current === 'dark' ? 'light' : 'dark');
  };

  // Apply saved theme immediately
  applyTheme(localStorage.getItem(THEME_KEY) || 'dark');


  /* ============================================================
   * 2. SCRIPT READ MODE — all devices
   * ============================================================ */
  let isReadMode = false;

  window.toggleReadMode = function () {
    isReadMode = !isReadMode;
    const ed = document.getElementById('scriptEditor');
    const btn = document.getElementById('readModeToggleBtn');
    const toolbar = document.querySelector('.editor-toolbar');

    if (!ed) return;

    if (isReadMode) {
      ed.contentEditable = 'false';
      if (toolbar) toolbar.style.display = 'none';
      if (btn) { btn.textContent = '✏️ 편집'; btn.style.color = '#22c55e'; }
    } else {
      ed.contentEditable = 'true';
      if (toolbar) toolbar.style.display = '';
      if (btn) { btn.textContent = '📖 읽기'; btn.style.color = ''; }
      ed.focus();
    }
  };

  // Phone: start in read mode when script tab is active
  function initReadModeForPhone() {
    if (!window.matchMedia('(max-width: 767px)').matches) return;
    const ed = document.getElementById('scriptEditor');
    const btn = document.getElementById('readModeToggleBtn');
    const toolbar = document.querySelector('.editor-toolbar');
    if (!ed) return;
    isReadMode = true;
    ed.contentEditable = 'false';
    if (toolbar) toolbar.style.display = 'none';
    if (btn) { btn.textContent = '✏️ 편집'; btn.style.color = '#22c55e'; }
  }


  /* ============================================================
   * 3. SCENE LIST CHUNK RENDER
   * ============================================================ */
  const CHUNK_SIZE = 30;
  let chunkObserver = null;

  function initChunkRender() {
    const wrap = document.getElementById('bdTableWrap');
    if (!wrap) return;
    const rows = Array.from(wrap.querySelectorAll('tbody tr.bd-row'));
    if (rows.length <= CHUNK_SIZE) return;

    rows.slice(CHUNK_SIZE).forEach(r => (r.style.display = 'none'));
    let shown = CHUNK_SIZE;

    let sentinel = document.getElementById('bdChunkSentinel');
    if (sentinel) sentinel.remove();
    sentinel = document.createElement('div');
    sentinel.id = 'bdChunkSentinel';
    sentinel.style.cssText = 'height:10px;pointer-events:none';
    wrap.appendChild(sentinel);

    if (chunkObserver) chunkObserver.disconnect();
    chunkObserver = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) return;
      rows.slice(shown, shown + CHUNK_SIZE).forEach(r => (r.style.display = ''));
      shown += CHUNK_SIZE;
      if (shown >= rows.length) {
        chunkObserver.disconnect();
        sentinel.remove();
      }
    }, { rootMargin: '300px' });
    chunkObserver.observe(sentinel);
  }


  /* ============================================================
   * 4. PATCH switchTab + mobileTab for sync
   * ============================================================ */
  function syncBottomTabBar(id) {
    document.querySelectorAll('.btab-btn[data-tab]').forEach(b => {
      b.classList.toggle('on', b.dataset.tab === id);
    });
    const more = document.getElementById('btabMore');
    if (more) more.classList.remove('on');
  }

  window.btabSwitch = function (id) {
    if (typeof switchTab === 'function') switchTab(id, null);
    syncBottomTabBar(id);
    document.querySelectorAll('.mobile-drawer-item[data-tab]').forEach(b => {
      b.classList.toggle('on', b.dataset.tab === id);
    });
  };

  // Patch switchTab — app.js already ran so switchTab is defined
  const _origSwitchTab = window.switchTab;
  if (typeof _origSwitchTab === 'function') {
    window.switchTab = function (id, btn) {
      _origSwitchTab(id, btn);
      syncBottomTabBar(id);
      if (id === 'breakdown') setTimeout(initChunkRender, 0);
      if (id === 'editor' && window.matchMedia('(max-width: 767px)').matches) {
        // reset to read mode when switching back to editor on phone
        isReadMode = false;
        toggleReadMode(); // will flip to read mode
      }
    };
  }

  // Patch renderBreakdown for chunk support
  const _origRenderBreakdown = window.renderBreakdown;
  if (typeof _origRenderBreakdown === 'function') {
    window.renderBreakdown = function () {
      _origRenderBreakdown();
      if (chunkObserver) chunkObserver.disconnect();
      setTimeout(initChunkRender, 0);
    };
  }


  /* ============================================================
   * 5. INIT on load
   * ============================================================ */
  window.addEventListener('load', function () {
    // Re-apply theme to update button labels after DOM is fully ready
    applyTheme(localStorage.getItem(THEME_KEY) || 'dark');
    // Phone: default to read mode on script tab
    initReadModeForPhone();
  });

})();
