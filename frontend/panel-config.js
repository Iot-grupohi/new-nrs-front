(() => {
  'use strict';

  const cfg = window.__LAV60_CONFIG__ || {};
  const apiBase = String(cfg.apiBase || cfg.apiUrl || '').trim().replace(/\/$/, '');

  function isCrossOrigin() {
    return Boolean(apiBase);
  }

  function resolve(path) {
    const raw = String(path || '');
    if (!raw) return apiBase || '';
    if (/^https?:\/\//i.test(raw)) return raw;
    if (!apiBase) return raw;
    return `${apiBase}${raw.startsWith('/') ? raw : `/${raw}`}`;
  }

  function apiOrigin() {
    if (apiBase) return apiBase;
    if (typeof window !== 'undefined' && window.location?.origin) return window.location.origin;
    return '';
  }

  function credentials(mode) {
    if (mode === 'omit') return 'omit';
    return isCrossOrigin() ? 'include' : 'same-origin';
  }

  function panelFetch(path, options = {}) {
    const cred =
      options.credentials !== undefined
        ? options.credentials
        : credentials(options.omitCredentials ? 'omit' : undefined);
    return fetch(resolve(path), {
      ...options,
      credentials: cred,
      headers: {
        Accept: 'application/json',
        ...(options.headers || {}),
      },
    });
  }

  function openEventSource(path) {
    const url = resolve(path);
    if (isCrossOrigin() && typeof EventSource !== 'undefined') {
      return new EventSource(url, { withCredentials: true });
    }
    return new EventSource(url);
  }

  window.Lav60PanelApi = {
    apiBase,
    isCrossOrigin,
    resolve,
    apiOrigin,
    credentials,
    panelFetch,
    openEventSource,
  };
})();
