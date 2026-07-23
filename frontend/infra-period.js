(() => {
  'use strict';

  const STORAGE_KEY = 'lav60:infra:metrics-period';
  const INTERVAL_SEC = 300;

  const OPTIONS = [
    { label: '1 hora', seconds: 3600 },
    { label: '6 horas', seconds: 21600 },
    { label: '24 horas', seconds: 86400 },
    { label: '7 dias', seconds: 604800 },
    { label: '14 dias', seconds: 1209600 },
  ];

  const DEFAULT_SECONDS = 3600;

  function findOption(seconds) {
    return OPTIONS.find((opt) => opt.seconds === Number(seconds)) || OPTIONS[0];
  }

  function getSelectedSeconds() {
    try {
      const parsed = parseInt(localStorage.getItem(STORAGE_KEY) || '', 10);
      if (OPTIONS.some((opt) => opt.seconds === parsed)) return parsed;
    } catch {
      /* ignore */
    }
    return DEFAULT_SECONDS;
  }

  function persistSeconds(seconds) {
    try {
      localStorage.setItem(STORAGE_KEY, String(seconds));
    } catch {
      /* ignore */
    }
  }

  function formatPeriodLabel(seconds) {
    return findOption(seconds).label;
  }

  function chartTickLimit(windowSeconds) {
    return Math.min(14, Math.max(6, Math.ceil(Number(windowSeconds) / INTERVAL_SEC / 6)));
  }

  function populateSelect(selectEl, selectedSeconds) {
    if (!selectEl) return getSelectedSeconds();
    const current = selectedSeconds || getSelectedSeconds();
    selectEl.innerHTML = OPTIONS.map(
      (opt) => `<option value="${opt.seconds}"${opt.seconds === current ? ' selected' : ''}>${opt.label}</option>`,
    ).join('');
    selectEl.value = String(current);
    return current;
  }

  function bindSelect(selectEl, onChange, options = {}) {
    const current = populateSelect(selectEl, getSelectedSeconds());
    if (!selectEl) return current;
    selectEl.addEventListener('change', () => {
      const seconds = parseInt(selectEl.value, 10);
      if (!OPTIONS.some((opt) => opt.seconds === seconds)) return;
      persistSeconds(seconds);
      if (typeof onChange === 'function') onChange(seconds);
    }, options);
    return current;
  }

  window.Lav60InfraPeriod = {
    OPTIONS,
    DEFAULT_SECONDS,
    INTERVAL_SEC,
    getSelectedSeconds,
    persistSeconds,
    formatPeriodLabel,
    chartTickLimit,
    populateSelect,
    bindSelect,
  };
})();
