(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  let moduleAbort = null;
  let allSites = [];
  let activeFilter = 'all';
  let searchQuery = '';
  let refreshTimer = null;
  let intervalSec = 60;
  let lastFetchedAt = null;

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function panelFetch(url, options = {}) {
    const fetcher = window.Lav60Auth?.panelFetch || ((target, opts) => fetch(target, { ...opts, credentials: 'same-origin' }));
    return fetcher(url, {
      ...options,
      headers: {
        Accept: 'application/json',
        ...(options.headers || {}),
      },
    });
  }

  function showBanner(message, tone = 'warn') {
    const banner = $('sitesMonitorBanner');
    if (!banner) return;
    banner.textContent = message;
    banner.classList.remove('hidden', 'records-audit-banner--warn', 'records-audit-banner--err');
    banner.classList.add(tone === 'err' ? 'records-audit-banner--err' : 'records-audit-banner--warn');
  }

  function hideBanner() {
    $('sitesMonitorBanner')?.classList.add('hidden');
  }

  function formatCheckedAt(value, fallbackEpoch = null) {
    const candidates = [value, fallbackEpoch];
    for (const item of candidates) {
      if (item == null || item === '') continue;
      if (typeof item === 'number' || /^\d+(\.\d+)?$/.test(String(item))) {
        const epoch = Number(item);
        const ms = epoch > 1e12 ? epoch : epoch * 1000;
        const date = new Date(ms);
        if (!Number.isNaN(date.getTime())) return date.toLocaleString('pt-BR');
      }
      const date = new Date(String(item));
      if (!Number.isNaN(date.getTime())) return date.toLocaleString('pt-BR');
    }
    return '—';
  }

  function formatUpdatedAt(epochSec) {
    return formatCheckedAt(epochSec);
  }

  function filteredSites() {
    const q = searchQuery.trim().toLowerCase();
    return allSites.filter((site) => {
      if (activeFilter === 'online' && !site.online) return false;
      if (activeFilter === 'offline' && site.online) return false;
      if (!q) return true;
      const haystack = [
        site.hostname,
        site.name,
        site.url,
        site.http_status,
        site.status_label,
        site.ssl_days,
        site.domain_expiry_days,
      ].join(' ').toLowerCase();
      return haystack.includes(q);
    });
  }

  function renderSummary(summary = {}) {
    $('sitesKpiTotal').textContent = summary.total ?? '—';
    $('sitesKpiOnline').textContent = summary.online ?? '—';
    $('sitesKpiOffline').textContent = summary.offline ?? '—';
    $('sitesKpiInterval').textContent = intervalSec ? `${intervalSec}s` : '—';
  }

  function displayHost(site) {
    const raw = String(site.hostname || site.url || site.name || '').trim();
    if (!raw) return 'Site';
    return raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '').split('/')[0];
  }

  function statusPill(site) {
    if (site.http_code != null && !Number.isNaN(Number(site.http_code))) {
      return `HTTP ${Math.round(Number(site.http_code))}`;
    }
    const http = String(site.http_status || '').trim();
    const httpMatch = http.match(/HTTP\s*(\d+)/i);
    if (httpMatch) return `HTTP ${httpMatch[1]}`;
    if (http && !/^online|offline$/i.test(http)) return http;
    return site.online ? 'Online' : 'Offline';
  }

  function expiryTone(days, { warn = 30, danger = 14 } = {}) {
    if (days == null || Number.isNaN(Number(days))) return 'muted';
    const value = Number(days);
    if (value <= danger) return 'danger';
    if (value <= warn) return 'warn';
    return 'ok';
  }

  function formatExpiryDays(days) {
    if (days == null || Number.isNaN(Number(days))) return '—';
    const value = Math.max(0, Math.round(Number(days)));
    return value === 1 ? 'Restam 1 dia' : `Restam ${value} dias`;
  }

  function renderExpiryMetric(label, days, thresholds) {
    const tone = expiryTone(days, thresholds);
    const value = formatExpiryDays(days);
    return `
      <div class="sites-monitor-card__metric sites-monitor-card__metric--${tone}" title="${escapeHtml(label)} · ${escapeHtml(value)}">
        <span class="sites-monitor-card__metric-label">${escapeHtml(label)}</span>
        <span class="sites-monitor-card__metric-value">${escapeHtml(value)}</span>
      </div>`;
  }

  function renderSiteCard(site, { compact = false, fetchedAt = null } = {}) {
    const statusClass = site.online ? 'sites-monitor-card--online' : 'sites-monitor-card--offline';
    const host = displayHost(site);
    const pill = statusPill(site);
    const checkedLabel = formatCheckedAt(site.checked_at, fetchedAt ?? lastFetchedAt);
    const compactClass = compact ? ' sites-monitor-card--compact' : '';

    return `
      <article class="sites-monitor-card ${statusClass}${compactClass}">
        <div class="sites-monitor-card__shine" aria-hidden="true"></div>
        <div class="sites-monitor-card__glow" aria-hidden="true"></div>
        <div class="sites-monitor-card__top">
          <span class="sites-monitor-card__pill">
            <span class="sites-monitor-card__pill-dot" aria-hidden="true"></span>
            ${escapeHtml(pill)}
          </span>
          ${site.href ? `<a href="${escapeHtml(site.href)}" class="sites-monitor-card__open" target="_blank" rel="noopener noreferrer" aria-label="Abrir ${escapeHtml(host)}">↗</a>` : ''}
        </div>
        <div class="sites-monitor-card__body">
          <h3 class="sites-monitor-card__host">${escapeHtml(host)}</h3>
        </div>
        <div class="sites-monitor-card__metrics" aria-label="Validade SSL e domínio">
          ${renderExpiryMetric('SSL', site.ssl_days, { warn: 30, danger: 14 })}
          ${renderExpiryMetric('Domínio', site.domain_expiry_days, { warn: 60, danger: 30 })}
        </div>
        <p class="sites-monitor-card__checked">
          <span class="sites-monitor-card__checked-icon" aria-hidden="true">◷</span>
          <span>Última verificação · <time>${escapeHtml(checkedLabel)}</time></span>
        </p>
      </article>`;
  }

  function renderGrid() {
    const grid = $('sitesMonitorGrid');
    const meta = $('sitesMonitorMeta');
    if (!grid) return;

    const sites = filteredSites();
    if (meta) {
      meta.textContent = `${sites.length} de ${allSites.length} site(s)`;
    }

    if (!allSites.length) {
      grid.innerHTML = '<div class="stores-empty-state"><p>Nenhum site retornado pela API.</p></div>';
      return;
    }

    if (!sites.length) {
      grid.innerHTML = '<div class="stores-empty-state"><p>Nenhum site corresponde aos filtros.</p></div>';
      return;
    }

    grid.innerHTML = sites.map(renderSiteCard).join('');
  }

  function scheduleAutoRefresh() {
    clearInterval(refreshTimer);
    if (!intervalSec || intervalSec < 15) return;
    refreshTimer = setInterval(() => {
      loadSites({ silent: true });
    }, intervalSec * 1000);
  }

  async function loadSites({ force = false, silent = false } = {}) {
    const grid = $('sitesMonitorGrid');
    if (!silent && grid) {
      grid.innerHTML = `
        <div class="stores-empty-state">
          <div class="spinner" aria-hidden="true"></div>
          <p>Carregando sites…</p>
        </div>`;
    }

    try {
      const url = force ? '/api/monitor/sites?force=1' : '/api/monitor/sites';
      const res = await panelFetch(url);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.detail || 'Não foi possível carregar os sites.');
      }

      allSites = Array.isArray(data.sites) ? data.sites : [];
      intervalSec = Number(data.interval_sec) || 60;
      lastFetchedAt = data.fetched_at || null;
      renderSummary(data.summary || {});
      $('sitesMonitorUpdatedAt').textContent = `Atualizado ${formatUpdatedAt(data.fetched_at)}`;
      $('sitesMonitorUpdatedAt')?.classList.remove('hidden');
      $('sitesMonitorSubtitle').textContent = data.available
        ? `${data.summary?.online ?? 0} online · ${data.summary?.offline ?? 0} offline`
        : 'Monitor de sites indisponível';
      hideBanner();
      renderGrid();
      scheduleAutoRefresh();
    } catch (error) {
      allSites = [];
      renderSummary({});
      if (grid) {
        grid.innerHTML = `<div class="stores-empty-state"><p>${escapeHtml(error.message || 'Erro ao carregar sites.')}</p></div>`;
      }
      showBanner(error.message || 'Erro ao carregar monitor de sites.', 'err');
    }
  }

  function bindEvents(signal) {
    $('btnSitesMonitorRefresh')?.addEventListener('click', () => loadSites({ force: true }), { signal });
    $('sitesMonitorSearch')?.addEventListener('input', (event) => {
      searchQuery = event.target.value || '';
      renderGrid();
    }, { signal });

    $('sitesMonitorFilters')?.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-sites-filter]');
      if (!chip) return;
      activeFilter = chip.dataset.sitesFilter || 'all';
      document.querySelectorAll('[data-sites-filter]').forEach((btn) => {
        btn.classList.toggle('chip--active', btn === chip);
      });
      renderGrid();
    }, { signal });
  }

  async function init() {
    moduleAbort?.abort();
    moduleAbort = new AbortController();
    activeFilter = 'all';
    searchQuery = '';
    if ($('sitesMonitorSearch')) $('sitesMonitorSearch').value = '';
    bindEvents(moduleAbort.signal);
    await loadSites();
  }

  function destroy() {
    moduleAbort?.abort();
    moduleAbort = null;
    clearInterval(refreshTimer);
    refreshTimer = null;
  }

  window.Lav60SitesMonitorPage = { init, destroy };
  window.Lav60SitesMonitorCard = {
    render: renderSiteCard,
    formatExpiryDays,
    expiryTone,
    displayHost,
    statusPill,
    formatCheckedAt,
  };
})();
