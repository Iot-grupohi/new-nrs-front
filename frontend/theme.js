(() => {
  'use strict';

  const STORAGE_KEY = 'lav60:theme';
  const VALID = new Set(['light', 'dark']);

  function readStoredTheme() {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return VALID.has(value) ? value : null;
    } catch {
      return null;
    }
  }

  function resolveTheme(preferred) {
    if (VALID.has(preferred)) return preferred;
    const stored = readStoredTheme();
    if (stored) return stored;
    if (window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
    return 'dark';
  }

  function applyTheme(theme, { persist = true } = {}) {
    const next = VALID.has(theme) ? theme : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    if (persist) {
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
    }
    syncToggleButtons();
    window.dispatchEvent(new CustomEvent('lav60:theme-change', { detail: { theme: next } }));
    return next;
  }

  function getTheme() {
    return document.documentElement.getAttribute('data-theme') || readStoredTheme() || 'dark';
  }

  function toggleTheme() {
    return applyTheme(getTheme() === 'light' ? 'dark' : 'light');
  }

  function syncToggleButtons() {
    const theme = getTheme();
    document.querySelectorAll('[data-theme-set]').forEach((btn) => {
      const value = btn.getAttribute('data-theme-set');
      const active = value === theme;
      btn.classList.toggle('theme-toggle__btn--active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function mountToggle(container, options = {}) {
    if (!container || container.dataset.themeMounted === '1') return;
    const variant = options.variant || 'inline';
    container.dataset.themeMounted = '1';
    container.classList.add('theme-toggle-wrap', `theme-toggle-wrap--${variant}`);
    container.innerHTML = `
      <div class="theme-toggle" role="group" aria-label="Tema da interface">
        <button type="button" class="theme-toggle__btn" data-theme-set="light" aria-pressed="false" title="Tema claro">
          <span class="theme-toggle__icon" aria-hidden="true">☀</span>
          <span class="theme-toggle__label">Claro</span>
        </button>
        <button type="button" class="theme-toggle__btn" data-theme-set="dark" aria-pressed="false" title="Tema escuro">
          <span class="theme-toggle__icon" aria-hidden="true">☾</span>
          <span class="theme-toggle__label">Escuro</span>
        </button>
      </div>`;

    container.querySelectorAll('[data-theme-set]').forEach((btn) => {
      btn.addEventListener('click', () => {
        applyTheme(btn.getAttribute('data-theme-set'));
      });
    });

    syncToggleButtons();
  }

  function mountAll() {
    document.querySelectorAll('[data-theme-mount]').forEach((el) => {
      let options = {};
      try {
        if (el.dataset.themeMount) options = JSON.parse(el.dataset.themeMount);
      } catch {
        options = {};
      }
      mountToggle(el, options);
    });
  }

  applyTheme(resolveTheme(), { persist: false });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountAll);
  } else {
    mountAll();
  }

  window.Lav60Theme = {
    getTheme,
    setTheme: (theme) => applyTheme(theme),
    toggleTheme,
    mountToggle,
    syncToggleButtons,
  };
})();
