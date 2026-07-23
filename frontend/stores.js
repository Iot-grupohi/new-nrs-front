(() => {
  'use strict';

  const {
    loadAllStores,
    ensureDefaultAgentToken,
    friendlyUserMessage,
    formatOfflineDuration,
    formatOnlineDuration,
    noAgentMessage,
    isAgentUnavailableError,
    loadCatalog,
    stopHeartbeatMonitor,
    machineMetaTitle,
    normalizeMachineStatus,
    verifyStoreGatewayLed,
    formatGatewayCacheAge,
  } = window.Lav60;
  const panelFetch = window.Lav60Auth?.panelFetch;
  let offlineDurationTimer = null;
  let refreshInFlight = false;
  let allStores = [];
  let catalogConfig = null;
  let activeFilter = 'all';
  let searchQuery = '';
  let activeKpiPanel = null;
  let lastDashboardEvents = null;
  let lastPayload = null;
  let pageAbort = null;
  let storesBootstrapped = false;
  let currentPageMode = null;
  let channelPickerGeneration = 0;
  let channelModalReady = false;

  const LOJAS_LAYOUT_KEY = 'lav60:lojas-layout';
  const LOJAS_LAYOUTS = ['compact', 'detailed', 'list'];
  let lojasCardLayout = 'compact';

  function loadLojasCardLayout() {
    try {
      const saved = localStorage.getItem(LOJAS_LAYOUT_KEY);
      if (saved && LOJAS_LAYOUTS.includes(saved)) lojasCardLayout = saved;
    } catch {
      /* ignore */
    }
  }

  function saveLojasCardLayout(layout) {
    try {
      localStorage.setItem(LOJAS_LAYOUT_KEY, layout);
    } catch {
      /* ignore */
    }
  }

  function getLojasCardLayout() {
    return currentPageMode === 'lojas' ? lojasCardLayout : 'detailed';
  }

  function isLojasCompactMode() {
    return getLojasCardLayout() === 'compact';
  }

  function isLojasListMode() {
    return getLojasCardLayout() === 'list';
  }

  function isLojasDetailedMode() {
    return getLojasCardLayout() === 'detailed';
  }

  const KPI_PANEL_CONFIG = {
    'stores-online': {
      title: 'Lojas operacionais',
      empty: 'Nenhuma loja operacional no momento.',
    },
    'stores-offline': {
      title: 'Lojas offline ou indisponíveis',
      empty: 'Nenhuma loja offline.',
    },
    'devices-suspended': {
      title: 'Máquinas suspensas',
      empty: 'Nenhuma máquina suspensa.',
    },
    'devices-occupied': {
      title: 'Máquinas ocupadas',
      empty: 'Nenhuma máquina ocupada.',
    },
    'devices-available': {
      title: 'Máquinas disponíveis',
      empty: 'Nenhuma máquina disponível.',
    },
    'devices-offline': {
      title: 'Dispositivos offline na rede',
      empty: 'Nenhum dispositivo fora da rede.',
    },
    'stores-partial': {
      title: 'Lojas parciais',
      empty: 'Nenhuma loja com operação parcial.',
    },
    'stores-suspended': {
      title: 'Lojas suspensas no Lav60',
      empty: 'Nenhuma loja suspensa com agente online.',
    },
  };

  let auditSummaryCache = null;
  let auditSummaryLoadedAt = 0;
  const AUDIT_SUMMARY_TTL_MS = 2 * 60 * 1000;
  const AUDIT_DASHBOARD_HOURS = 168;
  const INFRA_SUMMARY_TTL_MS = 2 * 60 * 1000;
  let infraSummaryCache = null;
  let infraSummaryLoadedAt = 0;
  const AUDIT_SUMMARY_STORAGE_KEY = 'lav60:dashboard:audit-summary';
  const INFRA_SUMMARY_STORAGE_KEY = 'lav60:dashboard:infra-summary';
  const SITES_SUMMARY_STORAGE_KEY = 'lav60:dashboard:sites-summary';
  const SITES_SUMMARY_TTL_MS = 2 * 60 * 1000;
  const DASHBOARD_SITES_LIMIT = 8;
  let sitesSummaryCache = null;
  let sitesSummaryLoadedAt = 0;

  const $ = (id) => document.getElementById(id);

  function readDashboardCacheFromStorage(key, isValid) {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      const row = JSON.parse(raw);
      if (!isValid(row?.data) || !row.cachedAt) return null;
      return row;
    } catch {
      return null;
    }
  }

  function writeDashboardCacheToStorage(key, data) {
    try {
      sessionStorage.setItem(key, JSON.stringify({ data, cachedAt: Date.now() }));
    } catch {
      /* private mode */
    }
  }

  function hydrateDashboardWidgetCaches() {
    if (!auditSummaryCache) {
      const stored = readDashboardCacheFromStorage(AUDIT_SUMMARY_STORAGE_KEY, auditSummaryIsValid);
      if (stored) {
        auditSummaryCache = stored.data;
        auditSummaryLoadedAt = stored.cachedAt;
        if ($('dashboardAuditTotal')) renderAuditSummary(auditSummaryCache);
      }
    }
    if (!infraSummaryCache) {
      const stored = readDashboardCacheFromStorage(INFRA_SUMMARY_STORAGE_KEY, infraSummaryIsValid);
      if (stored) {
        infraSummaryCache = stored.data;
        infraSummaryLoadedAt = stored.cachedAt;
        if ($('dashboardInfraVpsList') || $('dashboardInfraDbList')) {
          renderInfraDashboard(infraSummaryCache);
        }
      }
    }
    if (!sitesSummaryCache) {
      const stored = readDashboardCacheFromStorage(SITES_SUMMARY_STORAGE_KEY, sitesSummaryIsValid);
      if (stored) {
        sitesSummaryCache = stored.data;
        sitesSummaryLoadedAt = stored.cachedAt;
        if ($('dashboardSitesList')) renderSitesDashboard(sitesSummaryCache);
      }
    }
  }

  const STATE_LABELS = {
    ok: 'Operacional',
    partial: 'Parcial',
    offline: 'Sem equipamentos',
    unreachable: 'Offline',
    suspended: 'Suspensa',
    unknown: 'Aguardando',
  };

  const STATE_LABELS_SHORT = {
    ok: 'OK',
    partial: 'Parc.',
    offline: 'Sem eq.',
    unreachable: 'Off',
    suspended: 'Susp.',
    unknown: '…',
  };

  function isStoreOffline(store) {
    if (store?.loading) return false;
    if (isStoreSuspended(store)) return false;
    return !isStoreOnline(store);
  }

  function computeLojasStats(stores = allStores) {
    const ready = (stores || []).filter((s) => !s.loading);
    let online = 0;
    let offline = 0;
    let suspended = 0;
    ready.forEach((store) => {
      if (isStoreSuspended(store)) suspended += 1;
      else if (isStoreOnline(store)) online += 1;
      else offline += 1;
    });
    return {
      online,
      offline,
      suspended,
      total: ready.length,
      pending: (stores || []).length - ready.length,
    };
  }

  function updateLojasStatsPanel(stores = allStores) {
    if (currentPageMode !== 'lojas') return;
    const stats = computeLojasStats(stores);
    const onlineEl = $('storesStatOnline');
    const offlineEl = $('storesStatOffline');
    const suspendedEl = $('storesStatSuspended');
    const suspendedWrap = $('storesStatSuspendedWrap');
    const totalEl = $('storesStatTotal');
    if (onlineEl) onlineEl.textContent = stats.total ? String(stats.online) : '—';
    if (offlineEl) offlineEl.textContent = stats.total ? String(stats.offline) : '—';
    if (suspendedEl) suspendedEl.textContent = stats.suspended ? String(stats.suspended) : '0';
    if (suspendedWrap) {
      suspendedWrap.classList.toggle('hidden', stats.suspended <= 0);
    }
    if (totalEl) totalEl.textContent = stats.total ? String(stats.total) : '—';

    const subtitle = $('lojasSubtitle');
    if (subtitle && stats.total) {
      const parts = [`${stats.online} online`, `${stats.offline} offline`];
      if (stats.suspended > 0) parts.push(`${stats.suspended} suspensa(s)`);
      subtitle.textContent = `${parts.join(' · ')} · ${stats.total} loja(s)`;
    }
  }

  function syncLojasViewToggleUi() {
    const toggle = $('storesViewToggle');
    if (!toggle) return;
    toggle.querySelectorAll('[data-layout]').forEach((btn) => {
      btn.classList.toggle('chip--active', btn.dataset.layout === lojasCardLayout);
    });
  }

  function applyLojasGridLayoutClass(grid) {
    if (!grid) return;
    grid.classList.remove(
      'stores-list--compact',
      'stores-list--detailed',
      'stores-list--list'
    );
    const layout = getLojasCardLayout();
    grid.classList.add(`stores-list--${layout}`);
  }

  function storeSortRank(store) {
    if (store.loading) return 4;
    if (isStoreOnline(store)) return 0;
    if (store.state === 'partial') return 1;
    if (isStoreSuspended(store)) return 2;
    return 3;
  }

  function sortStoresForDisplay(stores) {
    return [...stores].sort((a, b) => {
      const rank = storeSortRank(a) - storeSortRank(b);
      if (rank !== 0) return rank;
      return String(a.id).localeCompare(String(b.id));
    });
  }

  const GROUP_LABELS = {
    washers: 'Lav',
    dryers: 'Sec',
    dosers: 'Dos',
    ac: 'AC',
  };

  function showToast(message, ok = true) {
    const el = $('toast');
    el.textContent = friendlyUserMessage(message);
    el.className = `toast ${ok ? 'toast--ok' : 'toast--err'}`;
    el.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.add('hidden'), 4500);
  }

  function formatTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text;
    return d.innerHTML;
  }

  function healthPercent(summary) {
    const on = summary?.online ?? 0;
    const tot = summary?.total ?? 0;
    return tot ? Math.round((on / tot) * 100) : 0;
  }

  function isStoreSuspended(store) {
    return Boolean(
      store?.storeSuspended ||
        store?.lav60Status === 'suspended' ||
        store?.lav60_status === 'suspended' ||
        store?.state === 'suspended'
    );
  }

  function isStoreOnline(store) {
    if (isStoreSuspended(store) || store.loading) return false;
    if (store.accessible !== true) return false;
    const online = store.summary?.online ?? 0;
    return online > 0 || store.state === 'ok' || store.state === 'partial';
  }

  function matchesFilter(store) {
    if (activeFilter === 'all') return true;
    if (activeFilter === 'online') return isStoreOnline(store);
    if (activeFilter === 'suspended') return isStoreSuspended(store);
    if (activeFilter === 'unreachable') {
      return (
        !isStoreSuspended(store) &&
        (store.state === 'unreachable' ||
          store.state === 'offline' ||
          store.agentUnavailable ||
          isAgentUnavailableError(store.error))
      );
    }
    return store.state === activeFilter;
  }

  function matchesSearch(store) {
    if (!searchQuery) return true;
    const q = searchQuery.toLowerCase();
    return (
      store.id.includes(q) ||
      (store.name || '').toLowerCase().includes(q)
    );
  }

  function dotClassForDevice(dev) {
    const status = normalizeMachineStatus(dev.status);
    if (status === 'suspended') return 'dot dot--suspended';
    if (!dev.online) return 'dot dot--off';
    if (status === 'occupied') return 'dot dot--warn';
    return 'dot dot--on';
  }

  function deviceDotTitle(dev) {
    const parts = [dev.id, dev.online ? 'Rede: online' : 'Rede: offline'];
    const meta = {
      machine_type_label: dev.machine_type_label,
      status_label: dev.status_label,
      capacity: dev.capacity,
      liter_capacity: dev.liter_capacity,
      waiting_minutes: dev.waiting_minutes,
      store_code: dev.store_code,
      time_dosage: dev.time_dosage,
    };
    const apiTitle = machineMetaTitle(meta);
    if (apiTitle) parts.push(apiTitle);
    return parts.join(' · ');
  }

  function renderDots(devices, group) {
    const list = (devices || {})[group] || [];
    if (!list.length) return '<span class="dots-empty">—</span>';
    return list
      .map((dev) => {
        const cls = dotClassForDevice(dev);
        return `<span class="${cls}" title="${escapeHtml(deviceDotTitle(dev))}"></span>`;
      })
      .join('');
  }

  function renderDeviceGroups(devices, { compact = false } = {}) {
    return Object.keys(GROUP_LABELS)
      .map(
        (group) => `
        <div class="store-card__device-group${compact ? ' store-card__device-group--compact' : ''}">
          <span class="store-card__device-label">${GROUP_LABELS[group]}</span>
          <div class="store-card__dots">${renderDots(devices, group)}</div>
        </div>`
      )
      .join('');
  }

  function offlineStoreReason(store) {
    const noAgent = store.agentUnavailable || isAgentUnavailableError(store.error);
    if (noAgent) return store.error || noAgentMessage(store.id);
    return store.error || 'Loja indisponível';
  }

  function renderOfflineHealthLabel(store) {
    const reason = escapeHtml(offlineStoreReason(store));
    const dur = formatOfflineDuration(store.offlineSince);
    const durHtml = dur
      ? ` · Offline há <strong class="store-card__offline-since">${escapeHtml(dur)}</strong>`
      : '';
    return `<span class="store-card__health-label--offline">${reason}${durHtml}</span>`;
  }

  function buildStoreMetrics(store, { accessible, online, total, pct, suspended, operable }) {
    if (store.loading) {
      return { tone: 'neutral', segments: [], offlineReason: '' };
    }

    const segments = [];
    let tone = 'neutral';
    let offlineReason = '';

    if (operable && !suspended) {
      if (total > 0) {
        segments.push({ kind: 'equip', text: `${online}/${total}` });
        segments.push({ kind: 'pct', text: `${pct}%` });
      }
      const updated = formatTime(store.timestamp);
      if (updated !== '—') {
        segments.push({ kind: 'updated', text: `Atualizado ${updated}` });
      }
      const onlineDur = formatOnlineDuration(store.onlineSince);
      if (onlineDur) {
        segments.push({
          kind: 'online',
          text: `Online há ${onlineDur}`,
          live: true,
          since: store.onlineSince,
        });
      }
      tone = pct >= 90 ? 'ok' : pct >= 70 ? 'warn' : 'danger';
    } else if (operable && suspended) {
      if (total > 0) segments.push({ kind: 'equip', text: `${online}/${total}` });
      const updated = formatTime(store.timestamp);
      if (updated !== '—') segments.push({ kind: 'updated', text: `Atualizado ${updated}` });
      const onlineDur = formatOnlineDuration(store.onlineSince);
      if (onlineDur) {
        segments.push({
          kind: 'online',
          text: `Online há ${onlineDur}`,
          live: true,
          since: store.onlineSince,
        });
      }
      tone = 'suspended';
    } else if (suspended) {
      offlineReason = store.storeNotice || 'Loja suspensa';
      tone = 'suspended';
    } else {
      offlineReason = offlineStoreReason(store);
      const offlineDur = formatOfflineDuration(store.offlineSince);
      if (offlineDur) {
        segments.push({
          kind: 'offline',
          text: `Offline há ${offlineDur}`,
          live: true,
          since: store.offlineSince,
        });
      }
      tone = 'offline';
    }

    return { tone, segments, offlineReason };
  }

  function renderMetricsSegmentHtml(segment) {
    if (segment.live && segment.since) {
      const cls =
        segment.kind === 'online' ? 'store-card__online-since' : 'store-card__offline-since';
      const prefix = segment.kind === 'online' ? 'Online há ' : 'Offline há ';
      return `${prefix}<strong class="${cls}">${escapeHtml(formatOfflineDuration(segment.since))}</strong>`;
    }
    return escapeHtml(segment.text);
  }

  function renderStoreMetricsRow(metrics, { layout = 'compact' } = {}) {
    if (!metrics.segments.length && !metrics.offlineReason) return '';

    const rowClass =
      layout === 'list'
        ? 'store-card__metrics store-card__metrics--list'
        : layout === 'detailed'
          ? 'store-card__metrics store-card__metrics--detailed'
          : 'store-card__metrics store-card__metrics--compact';

    if (metrics.offlineReason && !metrics.segments.some((s) => s.kind === 'equip' || s.kind === 'updated')) {
      const offlineSeg = metrics.segments.find((s) => s.kind === 'offline');
      const reason = escapeHtml(metrics.offlineReason);
      const durHtml = offlineSeg ? ` · ${renderMetricsSegmentHtml(offlineSeg)}` : '';
      return `<div class="${rowClass} store-card__metrics--${metrics.tone}"><span class="store-card__metrics-note">${reason}${durHtml}</span></div>`;
    }

    const html = metrics.segments
      .map((segment) => {
        const cls = `store-card__metrics-item store-card__metrics-item--${segment.kind}`;
        return `<span class="${cls}">${renderMetricsSegmentHtml(segment)}</span>`;
      })
      .join('');

    return `<div class="${rowClass} store-card__metrics--${metrics.tone}">${html}</div>`;
  }

  function metricsHealthLabelFromParts(metrics, store, { online, total }) {
    if (metrics.offlineReason && metrics.tone === 'offline') {
      const reason = escapeHtml(metrics.offlineReason);
      const offlineSeg = metrics.segments.find((s) => s.kind === 'offline');
      const durHtml = offlineSeg ? ` · ${renderMetricsSegmentHtml(offlineSeg)}` : '';
      return `<span class="store-card__health-label--offline">${reason}${durHtml}</span>`;
    }
    if (metrics.tone === 'suspended' && !metrics.segments.length) {
      return renderSuspendedHealthLabel(store);
    }

    const equip = metrics.segments.find((s) => s.kind === 'equip');
    const updated = metrics.segments.find((s) => s.kind === 'updated');
    const onlineSeg = metrics.segments.find((s) => s.kind === 'online');
    const parts = [];
    if (equip && total) {
      parts.push(`<strong>${online}</strong> de ${total} online`);
    }
    if (updated) parts.push(updated.text);
    if (onlineSeg) parts.push(renderMetricsSegmentHtml(onlineSeg));
    if (!parts.length) return renderSuspendedHealthLabel(store);
    return `<span>${parts.join(' · ')}</span>`;
  }

  function renderSuspendedHealthLabel(store) {
    const note = store.storeNotice || 'Loja suspensa no sistema Lav60 — operação local permitida';
    const stats =
      store.summary?.total > 0
        ? `<span class="store-card__health-stats"><strong>${store.summary.online ?? 0}</strong> de ${store.summary.total} na rede · ${formatTime(store.timestamp)}</span>`
        : '';
    return `<span class="store-card__health-label--suspended">${escapeHtml(note)}${stats ? `<br>${stats}` : ''}</span>`;
  }

  function renderStoreCardBody(store, { accessible, online, total, pct }) {
    const suspended = isStoreSuspended(store);
    const operable = accessible && !store.loading;
    const metrics = buildStoreMetrics(store, {
      accessible,
      online,
      total,
      pct,
      suspended,
      operable,
    });

    let healthLabel;
    if (suspended && operable) {
      healthLabel = metricsHealthLabelFromParts(metrics, store, { online, total });
    } else if (operable) {
      healthLabel = metricsHealthLabelFromParts(metrics, store, { online, total });
    } else if (suspended) {
      healthLabel = renderSuspendedHealthLabel(store);
    } else {
      healthLabel = metricsHealthLabelFromParts(metrics, store, { online, total });
    }

    const healthPct = operable && !suspended ? `${pct}%` : suspended && total ? `${pct}%` : '—';
    const healthFill = operable || (suspended && total) ? pct : 0;
    const devicesClass =
      operable || (suspended && total)
        ? 'store-card__devices'
        : 'store-card__devices store-card__devices--stale';

    const ctaHtml =
      operable
        ? `<div class="store-card__cta">
          <span>${suspended ? 'Abrir e operar localmente' : 'Escolher canal de operação'}</span>
          <span class="store-card__cta-icon" aria-hidden="true">→</span>
        </div>`
        : !store.loading
          ? `<div class="store-card__cta store-card__cta--alt">
          <span>Escolher canal de operação</span>
          <span class="store-card__cta-icon" aria-hidden="true">→</span>
        </div>`
          : `<div class="store-card__cta store-card__cta--blocked">
          <span>${suspended ? 'Aguardando agente' : 'Sem conexão com a loja'}</span>
        </div>`;

    const bodyClass = operable
      ? suspended
        ? ' store-card__body--suspended'
        : ''
      : suspended
        ? ' store-card__body--suspended store-card__body--offline'
        : ' store-card__body--offline';

    return `
      <div class="store-card__body${bodyClass}">
        <div class="store-card__health">
          <div class="store-card__health-track${operable || suspended ? '' : ' store-card__health-track--offline'}" role="presentation">
            <span class="store-card__health-fill" style="width:${healthFill}%"></span>
          </div>
          <div class="store-card__health-labels">
            ${healthLabel}
            <span class="store-card__health-pct">${healthPct}</span>
          </div>
        </div>
        <div class="${devicesClass}">${renderDeviceGroups(store.devices, { compact: false })}</div>
        ${ctaHtml}
      </div>`;
  }

  function tickOfflineDurations() {
    document.querySelectorAll('.store-card[data-offline-since]').forEach((card) => {
      const since = Number(card.dataset.offlineSince);
      if (!since) return;
      const el = card.querySelector('.store-card__offline-since');
      if (!el) return;
      el.textContent = formatOfflineDuration(since) || '';
    });
    document.querySelectorAll('.store-card[data-online-since]').forEach((card) => {
      const since = Number(card.dataset.onlineSince);
      if (!since) return;
      const el = card.querySelector('.store-card__online-since');
      if (!el) return;
      el.textContent = formatOnlineDuration(since) || '';
    });
  }

  function setupOfflineDurationTick() {
    if (offlineDurationTimer) return;
    offlineDurationTimer = setInterval(tickOfflineDurations, 30000);
  }

  function buildStoreHeading(store, { compact = false } = {}) {
    const code = store.id.toUpperCase();
    const name = (store.name || '').trim();
    const sameAsCode =
      !name || name.toUpperCase() === code || name.toUpperCase() === store.id.toUpperCase();

    if (compact) {
      const title = sameAsCode ? code : name;
      const subtitle = sameAsCode ? '' : code;
      return `<h3 class="store-card__title store-card__title--compact" title="${escapeHtml(sameAsCode ? code : `${code} · ${name}`)}">${escapeHtml(title)}</h3>${subtitle ? `<span class="store-card__code store-card__code--compact">${escapeHtml(subtitle)}</span>` : ''}`;
    }

    if (sameAsCode) {
      return `<h3 class="store-card__title">${escapeHtml(code)}</h3>`;
    }

    return `<span class="store-card__code">${escapeHtml(code)}</span><h3 class="store-card__title">${escapeHtml(name)}</h3>`;
  }

  function renderStoreCardCompactBody(store, { accessible, online, total, suspended, operable, pct }) {
    const metrics = buildStoreMetrics(store, {
      accessible,
      online,
      total,
      pct,
      suspended,
      operable,
    });
    const devicesHtml =
      operable || (suspended && total)
        ? `<div class="store-card__devices store-card__devices--compact">${renderDeviceGroups(store.devices, { compact: true })}</div>`
        : '';

    const ratio = total ? `${online}/${total}` : '—';
    const metricsHtml = renderStoreMetricsRow(metrics, { layout: 'compact' });

    return `
      <div class="store-card__compact-row">
        <span class="store-card__compact-ratio" title="${online} de ${total} online">${ratio}</span>
        ${devicesHtml}
        <span class="store-card__compact-chevron" aria-hidden="true">→</span>
      </div>
      ${metricsHtml}`;
  }

  function renderStoreCardListBody(store, { accessible, online, total, suspended, operable, pillState, stateLabel, pct }) {
    const code = store.id.toUpperCase();
    const ratio = total ? `${online}/${total}` : '—';
    const metrics = buildStoreMetrics(store, {
      accessible,
      online,
      total,
      pct,
      suspended,
      operable,
    });
    const dotsHtml =
      operable || (suspended && total)
        ? `<div class="store-card__list-dots">${renderDeviceGroups(store.devices, { compact: true })}</div>`
        : '';
    const metricsHtml = renderStoreMetricsRow(metrics, { layout: 'list' });

    return `
      <div class="store-card__list-inner">
        <div class="store-card__list-row-top">
          <div class="store-card__list-main">
            <span class="store-card__list-code">${escapeHtml(code)}</span>
            <span class="store-card__status pill pill--${pillState} pill--xs">${stateLabel}</span>
            <span class="store-card__list-ratio" title="${online} de ${total} online">${ratio}</span>
            ${dotsHtml}
          </div>
          <span class="store-card__list-chevron" aria-hidden="true">→</span>
        </div>
        ${metricsHtml}
      </div>`;
  }

  function renderStoreCard(store) {
    const summary = store.summary || {};
    const online = summary.online ?? 0;
    const total = summary.total ?? 0;
    const pct = healthPercent(summary);
    const suspended = isStoreSuspended(store);
    const accessible = store.accessible === true && !store.loading;
    const operable = accessible && !store.loading;
    const canPickChannel = !store.loading;
    const isOfflineAlert = !store.loading && !accessible && !suspended;
    const state = store.loading ? 'unknown' : store.state || 'unreachable';
    const pillState = suspended ? 'suspended' : state;
    const stateLabel = store.loading
      ? '…'
      : isLojasListMode() || isLojasCompactMode()
        ? STATE_LABELS_SHORT[pillState] || STATE_LABELS_SHORT[state] || 'Off'
        : STATE_LABELS[pillState] || STATE_LABELS[state] || 'Offline';

    const card = document.createElement('article');
    card.className = [
      'store-card',
      'store-card--v2',
      isLojasCompactMode() ? 'store-card--compact' : '',
      isLojasListMode() ? 'store-card--list' : '',
      isLojasDetailedMode() && currentPageMode === 'lojas' ? 'store-card--detailed' : '',
      `store-card--${suspended ? 'suspended' : state}`,
      canPickChannel ? 'store-card--clickable' : 'store-card--blocked',
      isOfflineAlert ? 'store-card--offline-alert' : '',
      store.loading ? 'store-card--loading' : '',
    ]
      .filter(Boolean)
      .join(' ');

    card.dataset.storeId = store.id;
    card.dataset.state = suspended ? 'suspended' : state;
    if (isOfflineAlert && store.offlineSince) {
      card.dataset.offlineSince = String(store.offlineSince);
    }
    if (store.onlineSince && operable) {
      card.dataset.onlineSince = String(store.onlineSince);
    }

    const storeLabel = store.name || store.id.toUpperCase();

    let bodyHtml = '';
    if (store.loading) {
      bodyHtml = `<p class="store-card__message store-card__message--compact">Sincronizando…</p>`;
    } else if (isLojasListMode()) {
      bodyHtml = renderStoreCardListBody(store, {
        accessible,
        online,
        total,
        suspended,
        operable,
        pillState,
        stateLabel,
        pct,
      });
    } else if (isLojasCompactMode()) {
      bodyHtml = renderStoreCardCompactBody(store, {
        accessible,
        online,
        total,
        suspended,
        operable,
        pct,
      });
    } else {
      bodyHtml = renderStoreCardBody(store, { accessible, online, total, pct });
    }

    if (isLojasListMode()) {
      card.innerHTML = `
        <div class="store-card__accent" aria-hidden="true"></div>
        ${bodyHtml}`;
    } else {
      const topClass = isLojasCompactMode()
        ? 'store-card__top store-card__top--compact'
        : 'store-card__top';

      card.innerHTML = `
        <div class="store-card__accent" aria-hidden="true"></div>
        <div class="${topClass}">
          <div class="store-card__identity">
            ${buildStoreHeading(store, { compact: isLojasCompactMode() })}
          </div>
          <span class="store-card__status pill pill--${pillState}${isLojasCompactMode() ? ' pill--xs' : ''}">${stateLabel}</span>
        </div>
        ${bodyHtml}`;
    }

    if (canPickChannel) {
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', `Operar loja ${storeLabel}`);
      const open = () => promptStoreChannel(store);
      card.addEventListener('click', open);
      card.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open();
        }
      });
    } else {
      card.setAttribute('aria-disabled', 'true');
      if (store.error) {
        card.title = store.error;
      }
    }

    return card;
  }

  function renderStoresList(stores) {
    const grid = $('storesGrid');
    if (!grid) return;
    grid.innerHTML = '';
    applyLojasGridLayoutClass(grid);
    updateLojasStatsPanel(allStores);

    if (!allStores.length) {
      grid.innerHTML = `
        <div class="stores-empty-state">
          <p>Nenhuma loja conectada — aguardando heartbeat dos agentes</p>
        </div>`;
      $('storesCount')?.classList.add('hidden');
      return;
    }

    if (!stores.length) {
      grid.innerHTML = `
        <div class="stores-empty-state">
          <p>Nenhuma loja encontrada com os filtros atuais.</p>
        </div>`;
    } else {
      const frag = document.createDocumentFragment();
      sortStoresForDisplay(stores).forEach((store) => frag.appendChild(renderStoreCard(store)));
      grid.appendChild(frag);
    }

    const countEl = $('storesCount');
    if (countEl) {
      const stats = computeLojasStats(allStores);
      countEl.textContent = `Exibindo ${stores.length} de ${stats.total} lojas`;
      countEl.classList.remove('hidden');
    }
    setupOfflineDurationTick();
  }

  function filterAndRender() {
    if (currentPageMode !== 'lojas' || !$('storesGrid')) return;
    const filtered = allStores.filter((s) => matchesFilter(s) && matchesSearch(s));
    renderStoresList(filtered);
  }

  function healthTone(pct) {
    if (pct >= 90) return 'ok';
    if (pct >= 70) return 'warn';
    return 'danger';
  }

  function healthLabel(pct) {
    if (pct >= 90) return 'Estável';
    if (pct >= 70) return 'Atenção';
    return 'Crítico';
  }

  function updateDashboardHeader(payload) {
    const badge = $('dashboardLiveBadge');
    const sync = $('dashboardSyncTime');
    if (badge) {
      if (payload.refreshing && payload.progress?.total) {
        badge.textContent = 'Sincronizando';
        badge.className = 'dashboard-live-badge dashboard-live-badge--pending';
      } else if (payload.fromCache && payload.live === false) {
        badge.textContent = 'Cache local';
        badge.className = 'dashboard-live-badge dashboard-live-badge--cache';
      } else if (payload.timestamp) {
        badge.textContent = 'Ao vivo';
        badge.className = 'dashboard-live-badge dashboard-live-badge--live';
      } else {
        badge.textContent = 'Conectando';
        badge.className = 'dashboard-live-badge dashboard-live-badge--pending';
      }
    }
    if (sync) {
      sync.textContent = payload.timestamp
        ? `Atualizado ${formatTime(payload.timestamp)}`
        : 'Aguardando primeira sincronização…';
    }
  }

  function updateHealthCard(devices) {
    const card = $('dashboardHealthCard');
    const badge = $('dashboardHealthBadge');
    const healthEl = $('kpiNetworkHealth');
    const healthBar = $('kpiNetworkHealthBar');
    const subEl = $('kpiNetworkHealthSub');
    const healthPct = devices.health_pct ?? 0;
    const tone = healthTone(healthPct);

    if (healthEl) {
      healthEl.textContent = devices.total ? `${healthPct}%` : '—';
    }
    if (healthBar) {
      healthBar.style.width = devices.total ? `${healthPct}%` : '0%';
    }
    if (subEl) {
      subEl.textContent = devices.total
        ? `${devices.online ?? 0} de ${devices.total} equipamentos operacionais`
        : 'Equipamentos operacionais na rede';
    }
    if (card) {
      card.classList.remove(
        'dashboard-health-card--idle',
        'dashboard-health-card--ok',
        'dashboard-health-card--warn',
        'dashboard-health-card--danger'
      );
      if (devices.total) card.classList.add(`dashboard-health-card--${tone}`);
      else card.classList.add('dashboard-health-card--idle');
    }
    if (badge) {
      badge.textContent = devices.total ? healthLabel(healthPct) : '—';
    }
  }

  function updateDashboardSummaryTiles(stores, devices) {
    const storesTotal = stores.total ?? 0;
    const storesOnline = stores.online ?? 0;
    const storesOffline = stores.offline ?? 0;
    const devicesTotal = devices.total ?? 0;
    const devicesOnline = devices.online ?? 0;
    const alerts =
      (stores.offline ?? 0) +
      (stores.partial ?? 0) +
      (stores.suspended ?? 0) +
      (devices.offline_network ?? 0) +
      (devices.suspended ?? 0);

    const tileStoresOnline = $('dashboardTileStoresOnline');
    const tileStoresOnlineMeta = $('dashboardTileStoresOnlineMeta');
    if (tileStoresOnline) {
      tileStoresOnline.textContent = storesTotal ? String(storesOnline) : '—';
    }
    if (tileStoresOnlineMeta) {
      tileStoresOnlineMeta.textContent = storesTotal
        ? `${storesOnline}/${storesTotal} unidades`
        : '—';
    }

    const tileStoresOffline = $('dashboardTileStoresOffline');
    if (tileStoresOffline) {
      tileStoresOffline.textContent = storesTotal ? String(storesOffline) : '—';
    }

    const tileDevicesOnline = $('dashboardTileDevicesOnline');
    const tileDevicesOnlineMeta = $('dashboardTileDevicesOnlineMeta');
    if (tileDevicesOnline) {
      tileDevicesOnline.textContent = devicesTotal ? `${devicesOnline}/${devicesTotal}` : '—';
    }
    if (tileDevicesOnlineMeta) {
      tileDevicesOnlineMeta.textContent = devicesTotal
        ? `${devices.available ?? 0} disponíveis agora`
        : '—';
    }

    const tileAlerts = $('dashboardTileAlerts');
    const tileAlertsMeta = $('dashboardTileAlertsMeta');
    if (tileAlerts) {
      tileAlerts.textContent = storesTotal || devicesTotal ? String(alerts) : '—';
    }
    if (tileAlertsMeta) {
      tileAlertsMeta.textContent = alerts
        ? 'Offline, parciais e suspensas'
        : 'Nenhum ponto crítico';
    }
  }

  function updatePageSubtitle(payload) {
    const dashboard = payload.dashboard || {};
    const stores = dashboard.stores || {};
    const devices = dashboard.devices || {};
    const lojasSubtitle = $('lojasSubtitle');
    const dashboardSubtitle = $('dashboardSubtitle');

    if (currentPageMode === 'lojas' && lojasSubtitle) {
      if (payload.fromCache && payload.live === false) {
        const count = payload.stores?.length || dashboard.stores?.total || 0;
        lojasSubtitle.textContent = `${count} loja(s) · sincronizando…`;
        return;
      }
      if (payload.refreshing && payload.progress?.total) {
        lojasSubtitle.textContent = `Carregando catálogo (${payload.progress.done}/${payload.progress.total})…`;
        return;
      }
      if (!payload.timestamp) {
        lojasSubtitle.textContent = 'Carregando monitoramento…';
      }
      return;
    }

    const subtitle = dashboardSubtitle || lojasSubtitle;
    if (!subtitle) return;

    if (payload.fromCache && payload.live === false) {
      const count = payload.stores?.length || dashboard.stores?.total || 0;
      subtitle.textContent = `${count} loja(s) · sincronizando…`;
      return;
    }

    if (payload.refreshing && payload.progress?.total) {
      subtitle.textContent = `Carregando catálogo de lojas (${payload.progress.done}/${payload.progress.total})…`;
      return;
    }

    if (payload.timestamp) {
      const storesSuspended = stores.suspended ?? 0;
      const suspended = devices.suspended ?? 0;
      const occupied = devices.occupied ?? 0;
      const available = devices.available ?? 0;
      const offlineNetwork = devices.offline_network ?? 0;
      const totalStores = stores.total ?? 0;
      if (storesSuspended > 0 || suspended > 0 || occupied > 0 || available > 0 || offlineNetwork > 0) {
        const parts = [];
        if (storesSuspended > 0) parts.push(`${storesSuspended} loja(s) suspensa(s)`);
        if (available > 0) parts.push(`${available} disponível(is)`);
        if (offlineNetwork > 0) parts.push(`${offlineNetwork} offline na rede`);
        if (occupied > 0) parts.push(`${occupied} ocupada(s)`);
        if (suspended > 0) parts.push(`${suspended} máq. suspensa(s)`);
        subtitle.textContent = `${parts.join(' · ')} · ${totalStores} loja(s) monitoradas`;
      } else {
        subtitle.textContent = `${totalStores} loja(s) monitoradas · rede estável`;
      }
      return;
    }

    subtitle.textContent = 'Carregando monitoramento…';
  }

  function renderDashboard(dashboard, payload) {
    const stores = dashboard.stores || {};
    const devices = dashboard.devices || {};
    lastDashboardEvents = dashboard.events || null;

    const hasKpis = Boolean($('kpiStoresOnline'));
    if (hasKpis) {
      $('kpiStoresOnline').textContent = stores.online ?? '—';
      $('kpiStoresOffline').textContent = stores.offline ?? '—';
      $('kpiDevicesSuspended').textContent = devices.suspended ?? '—';
      $('kpiDevicesOccupied').textContent = devices.occupied ?? '—';
      $('kpiDevicesAvailable').textContent = devices.available ?? '—';
      $('kpiDevicesOffline').textContent = devices.offline_network ?? '—';

      updateHealthCard(devices);
      updateDashboardSummaryTiles(stores, devices);

      const onlineTotalEl = $('kpiDevicesOnlineTotal');
      if (onlineTotalEl) {
        onlineTotalEl.textContent = devices.total
          ? `${devices.online ?? 0}/${devices.total}`
          : '—';
      }
      const onlineSubEl = $('kpiDevicesOnlineSub');
      if (onlineSubEl) {
        onlineSubEl.textContent = devices.total
          ? `${devices.available ?? 0} disponíveis · ${devices.occupied ?? 0} ocupadas`
          : 'Aguardando dados das lojas';
      }

      const partialEl = $('kpiStoresPartial');
      if (partialEl) partialEl.textContent = stores.partial ?? '—';

      const suspendedEl = $('kpiStoresSuspended');
      if (suspendedEl) suspendedEl.textContent = stores.suspended ?? '—';

      renderOfflineLongestList(lastDashboardEvents);
    }

    updateDashboardHeader(payload);
    updatePageSubtitle({ dashboard, ...payload });

    const storesMeta = $('storesMeta');
    if (storesMeta) {
      let meta = formatTime(payload.timestamp);
      if (payload.refreshing && payload.progress) {
        meta = `Sincronizando ${payload.progress.done}/${payload.progress.total} · ${meta}`;
      } else if (payload.fromCache && payload.live === false) {
        meta = `Cache local · ${meta}`;
      }
      storesMeta.textContent = meta;
    }

    updateLojasStatsPanel(payload.stores || allStores);

    if (activeKpiPanel) {
      renderAgentKpiModalContent(activeKpiPanel);
    }
  }

  function storeDisplayName(entry) {
    return entry.store_name || String(entry.store || '').toUpperCase();
  }

  function storePageHref(storeId) {
    return `store.html?store=${encodeURIComponent(storeId)}`;
  }

  function gatewayPageHref(storeId) {
    return `gateway.html?store=${encodeURIComponent(storeId)}`;
  }

  function findStoreById(storeId) {
    const sid = String(storeId || '').trim().toLowerCase();
    return allStores.find((s) => String(s.id).toLowerCase() === sid) || null;
  }

  function agentChannelSummary(store) {
    if (!store || store.loading) return { ready: false, label: 'Carregando', detail: 'Aguardando dados do agente' };
    if (store.accessible) {
      const online = store.summary?.online ?? 0;
      const total = store.summary?.total ?? 0;
      return {
        ready: true,
        label: 'Online',
        detail: total ? `${online} de ${total} equipamentos na rede` : 'Agente respondendo',
      };
    }
    if (store.storeSuspended && !store.accessible) {
      return { ready: false, label: 'Aguardando', detail: 'Agente offline — loja suspensa' };
    }
    if (store.agentUnavailable) {
      return { ready: false, label: 'Sem agente', detail: noAgentMessage(store.id) };
    }
    return {
      ready: false,
      label: 'Offline',
      detail: store.error || 'Agente indisponível no momento',
    };
  }

  function hideStoreChannelModal() {
    channelPickerGeneration += 1;
    $('storeChannelModal')?.classList.add('hidden');
  }

  function buildChannelOptionHtml(type, { title, detail, statusLabel, statusClass, disabled, loading, ready }) {
    const state = loading ? 'loading' : ready ? 'ready' : 'unavailable';
    const pillMap = { on: 'ok', off: 'offline', warn: 'partial' };
    const pillKind = pillMap[statusClass] || 'unknown';
    const pill = loading
      ? '<span class="pill pill--partial">Verificando…</span>'
      : `<span class="pill pill--${pillKind}">${escapeHtml(statusLabel)}</span>`;
    const icon = type === 'agent' ? '◫' : '⟲';
    const cta = ready && !loading ? '<span class="store-channel-option__cta">Abrir painel →</span>' : '';
    return `
      <button type="button" class="store-channel-option store-channel-option--${type} store-channel-option--${state}" data-channel="${type}" ${disabled ? 'disabled' : ''}>
        <span class="store-channel-option__accent" aria-hidden="true"></span>
        <span class="store-channel-option__inner">
          <span class="store-channel-option__icon-wrap" aria-hidden="true">
            <span class="store-channel-option__icon">${icon}</span>
          </span>
          <span class="store-channel-option__content">
            <span class="store-channel-option__head">
              <strong class="store-channel-option__title">${escapeHtml(title)}</strong>
              ${pill}
            </span>
            <span class="store-channel-option__detail">${escapeHtml(detail)}</span>
            ${cta}
          </span>
        </span>
      </button>`;
  }

  function renderStoreChannelOptions(store, gatewayState) {
    const options = $('storeChannelOptions');
    if (!options) return;

    const agent = agentChannelSummary(store);
    const gatewayLoading = gatewayState?.loading;
    const gatewayOnline = gatewayState?.online === true;
    const gatewayDetail = gatewayLoading
      ? 'Verificando redundância (POST /led/on)…'
      : gatewayOnline
        ? `Redundância disponível${gatewayState.checkedAt ? ` · ${formatGatewayCacheAge(gatewayState.checkedAt)}` : ''}${gatewayState.fromCache ? ' · em cache' : ''}`
        : gatewayState?.error || 'Redundância indisponível';

    options.innerHTML = [
      buildChannelOptionHtml('agent', {
        title: 'Agente local',
        detail: agent.detail,
        statusLabel: agent.label,
        statusClass: agent.ready ? 'on' : 'off',
        disabled: !agent.ready,
        loading: false,
        ready: agent.ready,
      }),
      buildChannelOptionHtml('gateway', {
        title: 'Gateway (redundância)',
        detail: gatewayDetail,
        statusLabel: gatewayLoading ? 'Verificando' : gatewayOnline ? 'Online' : 'Offline',
        statusClass: gatewayLoading ? 'warn' : gatewayOnline ? 'on' : 'off',
        disabled: gatewayLoading || !gatewayOnline,
        loading: gatewayLoading,
        ready: gatewayOnline && !gatewayLoading,
      }),
    ].join('');
  }

  function renderStoreChannelSubtitle(store, gatewayState) {
    const agent = agentChannelSummary(store);
    if (agent.ready) {
      $('storeChannelSubtitle').textContent = 'Agente local disponível — redundância verificada';
    } else if (gatewayState.online) {
      $('storeChannelSubtitle').textContent = 'Agente indisponível — use a redundância';
    } else {
      $('storeChannelSubtitle').textContent = 'Nenhum canal operacional no momento';
    }
  }

  async function loadStoreChannelGateway(store, { force = false } = {}) {
    const gen = channelPickerGeneration;
    renderStoreChannelOptions(store, { loading: true });
    let gatewayState = { loading: false, online: false, error: null, checkedAt: null, fromCache: false };
    try {
      const result = await verifyStoreGatewayLed(store.id, panelFetch, { force });
      if (gen !== channelPickerGeneration) return null;
      gatewayState = {
        loading: false,
        online: result.online,
        error: result.error,
        checkedAt: result.checkedAt,
        fromCache: Boolean(result.fromCache),
      };
    } catch (err) {
      if (gen !== channelPickerGeneration) return null;
      gatewayState = {
        loading: false,
        online: false,
        error: friendlyUserMessage(err.message),
        checkedAt: null,
        fromCache: false,
      };
    }
    renderStoreChannelOptions(store, gatewayState);
    renderStoreChannelSubtitle(store, gatewayState);
    return gatewayState;
  }

  async function openStoreChannelPicker(store) {
    const modal = $('storeChannelModal');
    if (!store) return;
    if (!modal) {
      window.location.href = storePageHref(store.id);
      return;
    }
    if (!panelFetch) {
      showToast('Autenticação indisponível', false);
      return;
    }

    ++channelPickerGeneration;
    const label = store.name ? `${store.name} (${store.id.toUpperCase()})` : store.id.toUpperCase();
    $('storeChannelTitle').textContent = label;
    $('storeChannelSubtitle').textContent = 'Escolha como operar esta loja';
    modal.classList.remove('hidden');

    await loadStoreChannelGateway(store, { force: false });
  }

  function initStoreChannelModal() {
    if (channelModalReady) return;
    channelModalReady = true;
    const modal = $('storeChannelModal');
    if (!modal) return;

    modal.addEventListener('click', (e) => {
      if (e.target.closest('[data-channel-dismiss]')) {
        hideStoreChannelModal();
        return;
      }
      const option = e.target.closest('[data-channel]');
      if (!option || option.disabled) return;
      const storeId = modal.dataset.storeId;
      if (!storeId) return;
      if (option.dataset.channel === 'agent') {
        window.location.href = storePageHref(storeId);
        return;
      }
      if (option.dataset.channel === 'gateway') {
        window.location.href = gatewayPageHref(storeId);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !modal.classList.contains('hidden')) hideStoreChannelModal();
    });

    $('btnRefreshChannelGateway')?.addEventListener('click', () => {
      const storeId = modal.dataset.storeId;
      if (!storeId || !panelFetch) return;
      const store = findStoreById(storeId) || {
        id: String(storeId).trim().toLowerCase(),
        name: String(storeId).toUpperCase(),
        accessible: false,
        loading: false,
        agentUnavailable: true,
      };
      void loadStoreChannelGateway(store, { force: true });
    });
  }

  function promptStoreChannel(store) {
    initStoreChannelModal();
    const modal = $('storeChannelModal');
    if (modal) modal.dataset.storeId = store.id;
    void openStoreChannelPicker(store);
  }

  function promptStoreChannelById(storeId) {
    const store = findStoreById(storeId);
    if (store) {
      promptStoreChannel(store);
      return true;
    }
    promptStoreChannel({
      id: String(storeId || '').trim().toLowerCase(),
      name: String(storeId || '').toUpperCase(),
      accessible: false,
      loading: false,
      agentUnavailable: true,
      error: 'Dados do agente indisponíveis',
    });
    return false;
  }

  function groupDeviceEvents(items) {
    const map = new Map();
    (items || []).forEach((item) => {
      const key = item.store;
      if (!map.has(key)) {
        map.set(key, { store: item.store, store_name: item.store_name, devices: [] });
      }
      map.get(key).devices.push(item);
    });
    return [...map.values()].sort((a, b) => a.store.localeCompare(b.store));
  }

  function renderDeviceEventsGrouped(items) {
    const groups = groupDeviceEvents(items);
    if (!groups.length) return '';
    return groups
      .map((group) => {
        const devicesHtml = group.devices
          .map(
            (dev) => `
            <li class="kpi-event-item kpi-event-item--device">
              <span class="kpi-event-item__main">${escapeHtml(dev.type_label)} ${escapeHtml(String(dev.id))}</span>
              <span class="kpi-event-item__sub">${escapeHtml(dev.status_label || '')}</span>
            </li>`
          )
          .join('');
        return `
          <article class="kpi-event-group">
            <header class="kpi-event-group__head">
              <a class="kpi-event-group__store" href="${storePageHref(group.store)}">${escapeHtml(storeDisplayName(group))}</a>
              <span class="kpi-event-group__count">${group.devices.length} equip.</span>
            </header>
            <ul class="kpi-event-list">${devicesHtml}</ul>
          </article>`;
      })
      .join('');
  }

  function renderStorePartialEvents(items) {
    if (!items?.length) return '';
    return `<ul class="kpi-event-list kpi-event-list--stores">
      ${items
        .map(
          (entry) => `
        <li class="kpi-event-item">
          <a class="kpi-event-item__store" href="${storePageHref(entry.store)}">${escapeHtml(storeDisplayName(entry))}</a>
          <span class="kpi-event-item__sub">${entry.summary_online} de ${entry.summary_total} online · ${entry.health_pct}%</span>
        </li>`
        )
        .join('')}
    </ul>`;
  }

  function renderStoreSuspendedEvents(items) {
    if (!items?.length) return '';
    return `<ul class="kpi-event-list kpi-event-list--stores">
      ${items
        .map(
          (entry) => `
        <li class="kpi-event-item kpi-event-item--suspended">
          <a class="kpi-event-item__store" href="${storePageHref(entry.store)}">${escapeHtml(storeDisplayName(entry))}</a>
          <span class="kpi-event-item__sub">${escapeHtml(entry.reason || 'Loja suspensa — operação local permitida')} · ${entry.summary_online} de ${entry.summary_total} online</span>
        </li>`
        )
        .join('')}
    </ul>`;
  }

  function renderOfflineLongestList(events) {
    const listEl = $('dashboardOfflineList');
    const metaEl = $('dashboardOfflineMeta');
    if (!listEl) return;

    const items = events?.stores_offline_longest || [];
    if (metaEl) {
      metaEl.textContent = items.length
        ? `${items.length} loja(s) com agente offline`
        : 'Nenhuma loja offline no momento';
    }

    if (!items.length) {
      listEl.innerHTML = '<li class="dashboard-list__empty">Todas as lojas estão acessíveis.</li>';
      return;
    }

    listEl.innerHTML = items
      .map((entry) => {
        const sinceMs = entry.offline_since
          ? (typeof entry.offline_since === 'number'
            ? entry.offline_since
            : new Date(entry.offline_since).getTime())
          : 0;
        const dur = entry.offline_since ? formatOfflineDuration(entry.offline_since) : '';
        const durText = dur ? `Offline há ${dur}` : 'Offline';
        const warnClass = sinceMs && Date.now() - sinceMs >= 3600000 ? ' dashboard-list__item--warn' : '';
        return `
          <li class="dashboard-list__item${warnClass}">
            <span class="dashboard-list__name">${escapeHtml(storeDisplayName(entry))}</span>
            <span class="dashboard-list__meta">${escapeHtml(durText)}</span>
          </li>`;
      })
      .join('');
  }

  function operatorDisplayName(op) {
    if (!op) return '—';
    const name = String(op.name || '').trim();
    const email = String(op.email || '').trim();
    if (name && email && name.toLowerCase() !== email.toLowerCase()) return name;
    return email || name || '—';
  }

  function auditWindowLabel(hours) {
    const h = Number(hours) || AUDIT_DASHBOARD_HOURS;
    if (h === 24) return 'Últimas 24h';
    if (h === 168) return 'Últimos 7 dias';
    if (h % 24 === 0) return `Últimos ${h / 24} dias`;
    return `Últimas ${h}h`;
  }

  function auditSummaryIsValid(data) {
    return Boolean(data && data.available !== false && data.detail !== 'audit_unavailable');
  }

  function infraSummaryIsValid(data) {
    return Boolean(
      data &&
        data.configured !== false &&
        !data.detail &&
        (Array.isArray(data.vps) || Array.isArray(data.databases))
    );
  }

  function sitesSummaryIsValid(data) {
    return Boolean(data && data.available !== false && !data.detail && data.summary);
  }

  function renderAuditSummary(data) {
    const totalEl = $('dashboardAuditTotal');
    if (!totalEl) return;

    if (!data?.available && (data?.detail === 'audit_unavailable' || data?.hint)) {
      $('dashboardAuditMeta').textContent = data.hint
        ? `Auditoria indisponível — ${data.hint}`
        : 'Auditoria indisponível — configure FIREBASE_SERVICE_ACCOUNT_FILE no VPS';
      totalEl.textContent = '—';
      $('dashboardAuditSuccessRate').textContent = '—';
      $('dashboardAuditTopOperator').textContent = '—';
      $('dashboardAuditTopStore').textContent = '—';
      return;
    }

    const hours = data?.hours ?? AUDIT_DASHBOARD_HOURS;
    const truncated = data?.truncated ? ' · amostra limitada' : '';
    const total = Number(data?.total ?? 0);
    const windowLabel = auditWindowLabel(hours);

    $('dashboardAuditMeta').textContent = total === 0
      ? `${windowLabel} · nenhuma operação${truncated}`
      : `${windowLabel}${truncated}`;

    totalEl.textContent = total.toLocaleString('pt-BR');
    const rate = data?.success_rate;
    $('dashboardAuditSuccessRate').textContent =
      total === 0 ? '—' : (rate != null ? `${rate}%` : '—');

    const topOp = data?.top_operator;
    $('dashboardAuditTopOperator').textContent = topOp
      ? `${operatorDisplayName(topOp)} · ${Number(topOp.count).toLocaleString('pt-BR')} ops`
      : (total === 0 ? 'Sem operações' : '—');

    const topStore = data?.top_store;
    $('dashboardAuditTopStore').textContent = topStore?.store
      ? `${topStore.store.toUpperCase()} · ${Number(topStore.count).toLocaleString('pt-BR')} ops`
      : (total === 0 ? 'Sem operações' : '—');
  }

  async function loadAuditDashboardSummary({ force = false } = {}) {
    if (!$('dashboardAuditTotal')) return;

    if (!auditSummaryCache) {
      const stored = readDashboardCacheFromStorage(AUDIT_SUMMARY_STORAGE_KEY, auditSummaryIsValid);
      if (stored) {
        auditSummaryCache = stored.data;
        auditSummaryLoadedAt = stored.cachedAt;
      }
    }

    const hasCache = auditSummaryIsValid(auditSummaryCache);
    const cacheFresh = hasCache && Date.now() - auditSummaryLoadedAt <= AUDIT_SUMMARY_TTL_MS;

    if (hasCache) {
      renderAuditSummary(auditSummaryCache);
    }

    if (!force && cacheFresh) {
      return;
    }

    const metaEl = $('dashboardAuditMeta');
    if (hasCache && metaEl) {
      metaEl.textContent = `${auditWindowLabel(auditSummaryCache?.hours)} · atualizando…`;
    } else if (metaEl) {
      metaEl.textContent = 'Auditoria · carregando…';
    }

    try {
      const res = await fetch(`/api/audit/dashboard-summary?hours=${AUDIT_DASHBOARD_HOURS}`, {
        credentials: 'same-origin',
        signal: pageAbort?.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.available === false || data.detail === 'audit_unavailable') {
        if (hasCache) {
          renderAuditSummary(auditSummaryCache);
          return;
        }
        renderAuditSummary({
          available: false,
          detail: data.detail || 'audit_unavailable',
          hint: data.hint,
        });
        return;
      }
      auditSummaryCache = { ...data, available: true };
      auditSummaryLoadedAt = Date.now();
      writeDashboardCacheToStorage(AUDIT_SUMMARY_STORAGE_KEY, auditSummaryCache);
      renderAuditSummary(auditSummaryCache);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      if (hasCache) {
        renderAuditSummary(auditSummaryCache);
        return;
      }
      renderAuditSummary({ detail: 'audit_unavailable' });
    }
  }

  function formatInfraPercent(value) {
    if (value == null || Number.isNaN(Number(value))) return '—';
    return `${Number(value).toFixed(1)}%`;
  }

  function infraUsageTone(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 'neutral';
    if (n >= 85) return 'danger';
    if (n >= 70) return 'warn';
    return 'ok';
  }

  function infraStatusPill(status, okValues = ['active', 'online']) {
    const label = status || '—';
    const kind = okValues.includes(String(status || '').toLowerCase()) ? 'ok' : 'partial';
    return `<span class="pill pill--${kind} pill--sm">${escapeHtml(label)}</span>`;
  }

  function infraMetricBar(label, value) {
    const tone = infraUsageTone(value);
    const width = value == null || Number.isNaN(Number(value))
      ? 0
      : Math.max(0, Math.min(100, Number(value)));
    return `
      <div class="dashboard-infra-metric dashboard-infra-metric--${tone}">
        <div class="dashboard-infra-metric__head">
          <span class="dashboard-infra-metric__label">${escapeHtml(label)}</span>
          <strong class="dashboard-infra-metric__value">${escapeHtml(formatInfraPercent(value))}</strong>
        </div>
        <div class="dashboard-infra-metric__bar" aria-hidden="true">
          <div class="dashboard-infra-metric__bar-fill" style="width:${width}%"></div>
        </div>
      </div>`;
  }

  function infraMetricBarRow(label, value) {
    const tone = infraUsageTone(value);
    const width = value == null || Number.isNaN(Number(value))
      ? 0
      : Math.max(0, Math.min(100, Number(value)));
    return `
      <div class="dashboard-infra-metric dashboard-infra-metric--row dashboard-infra-metric--${tone}">
        <span class="dashboard-infra-metric__label">${escapeHtml(label)}</span>
        <div class="dashboard-infra-metric__bar" aria-hidden="true">
          <div class="dashboard-infra-metric__bar-fill" style="width:${width}%"></div>
        </div>
        <strong class="dashboard-infra-metric__value">${escapeHtml(formatInfraPercent(value))}</strong>
      </div>`;
  }

  function infraUsageFromItem(item, kind) {
    const metrics = item?.metrics;
    if (!metrics || item?.metrics_error) return null;
    if (kind === 'cpu') {
      return metrics.cpu?.latest_percent ?? metrics.cpu_percent ?? null;
    }
    if (kind === 'memory') return metrics.memory_percent ?? null;
    if (kind === 'disk') return metrics.disk_percent ?? null;
    return null;
  }

  function infraItemAlerts(item) {
    if (item?.error || item?.metrics_error) return 1;
    const cpu = infraUsageFromItem(item, 'cpu');
    const memory = infraUsageFromItem(item, 'memory');
    const disk = infraUsageFromItem(item, 'disk');
    return [cpu, memory, disk].some((value) => Number(value) >= 85) ? 1 : 0;
  }

  function renderInfraServerItem(item, type) {
    const name = item?.name || item?.label || item?.id || '—';
    const typeLabel = type === 'vps' ? 'VPS' : String(item?.engine || 'DB').toUpperCase();
    const status = item?.status || (item?.metrics_error ? 'erro' : '—');

    if (item?.error || item?.metrics_error) {
      return `
        <li class="dashboard-infra-item dashboard-infra-item--error">
          <div class="dashboard-infra-item__head">
            <span class="dashboard-infra-item__type">${escapeHtml(typeLabel)}</span>
            <strong class="dashboard-infra-item__name">${escapeHtml(name)}</strong>
            <span class="pill pill--offline pill--sm">erro</span>
          </div>
          <p class="dashboard-infra-item__error">${escapeHtml(item.error || item.metrics_error || 'Métricas indisponíveis')}</p>
        </li>`;
    }

    const cpu = infraUsageFromItem(item, 'cpu');
    const memory = infraUsageFromItem(item, 'memory');
    const disk = infraUsageFromItem(item, 'disk');
    const specs = [];
    if (type === 'vps') {
      if (item?.vcpus) specs.push(`${item.vcpus} vCPU`);
      if (item?.memory_mb) specs.push(`${Math.round(item.memory_mb / 1024)} GB`);
      if (item?.region) specs.push(item.region);
    } else {
      if (item?.size) specs.push(String(item.size));
      if (item?.num_nodes) specs.push(`${item.num_nodes} nó(s)`);
      if (item?.region) specs.push(item.region);
    }
    const specsLine = specs.join(' · ');

    return `
      <li class="dashboard-infra-item">
        <div class="dashboard-infra-item__head">
          <span class="dashboard-infra-item__type">${escapeHtml(typeLabel)}</span>
          <strong class="dashboard-infra-item__name" title="${escapeHtml(name)}">${escapeHtml(name)}</strong>
          ${infraStatusPill(status)}
        </div>
        ${specsLine ? `<p class="dashboard-infra-item__specs">${escapeHtml(specsLine)}</p>` : ''}
        <div class="dashboard-infra-item__metrics">
          ${infraMetricBarRow('CPU', cpu)}
          ${infraMetricBarRow('Memória', memory)}
          ${infraMetricBarRow('Disco', disk)}
        </div>
      </li>`;
  }

  function renderInfraList(listEl, items, emptyMessage) {
    if (!listEl) return;
    if (!items.length) {
      listEl.innerHTML = `<li class="dashboard-list__empty">${escapeHtml(emptyMessage)}</li>`;
      return;
    }
    listEl.innerHTML = items.join('');
  }

  function renderInfraDashboard(data) {
    const vpsListEl = $('dashboardInfraVpsList');
    const dbListEl = $('dashboardInfraDbList');
    if (!vpsListEl && !dbListEl) return;

    const vps = Array.isArray(data?.vps) ? data.vps : [];
    const databases = Array.isArray(data?.databases) ? data.databases : [];
    const configured = data?.configured !== false;
    const metaEl = $('dashboardInfraMeta');

    if (!configured) {
      if (metaEl) metaEl.textContent = data?.detail || 'DigitalOcean não configurado no servidor';
      if ($('kpiInfraVps')) $('kpiInfraVps').textContent = '—';
      if ($('kpiInfraDb')) $('kpiInfraDb').textContent = '—';
      if ($('kpiInfraAlerts')) $('kpiInfraAlerts').textContent = '—';
      renderInfraList(vpsListEl, [], 'Configure DIGITALOCEAN_TOKEN no painel.');
      renderInfraList(dbListEl, [], 'Configure DIGITALOCEAN_DB_TOKEN no painel.');
      return;
    }

    const alerts = [...vps, ...databases].reduce((sum, item) => sum + infraItemAlerts(item), 0);
    const vpsOk = vps.filter((item) => !item.error && !item.metrics_error).length;
    const dbOk = databases.filter((item) => !item.error && !item.metrics_error).length;

    if ($('kpiInfraVps')) $('kpiInfraVps').textContent = vps.length ? String(vpsOk) : '0';
    if ($('kpiInfraVpsSub')) {
      $('kpiInfraVpsSub').textContent = vps.length ? `${vpsOk}/${vps.length} ok` : 'Nenhuma VPS';
    }
    if ($('kpiInfraDb')) $('kpiInfraDb').textContent = databases.length ? String(dbOk) : '0';
    if ($('kpiInfraDbSub')) {
      $('kpiInfraDbSub').textContent = databases.length ? `${dbOk}/${databases.length} ok` : 'Nenhum DB';
    }
    if ($('kpiInfraAlerts')) $('kpiInfraAlerts').textContent = String(alerts);
    if ($('kpiInfraAlertsSub')) {
      $('kpiInfraAlertsSub').textContent = alerts ? 'Revisar' : 'Tudo ok';
    }

    const parts = [];
    if (data?.checked_at) {
      parts.push(`Atualizado ${new Date(data.checked_at).toLocaleString('pt-BR')}`);
    }
    if (data?.from_cache) parts.push('em cache');
    parts.push('última 1 hora · intervalo 5 min');
    if (metaEl) metaEl.textContent = parts.join(' · ');

    renderInfraList(
      vpsListEl,
      vps.map((item) => renderInfraServerItem(item, 'vps')),
      'Nenhuma VPS cadastrada.',
    );
    renderInfraList(
      dbListEl,
      databases.map((item) => renderInfraServerItem(item, 'db')),
      'Nenhum database cadastrado.',
    );
  }

  async function loadInfraDashboardSummary({ force = false } = {}) {
    if (!$('dashboardInfraVpsList') && !$('dashboardInfraDbList')) return;

    if (!infraSummaryCache) {
      const stored = readDashboardCacheFromStorage(INFRA_SUMMARY_STORAGE_KEY, infraSummaryIsValid);
      if (stored) {
        infraSummaryCache = stored.data;
        infraSummaryLoadedAt = stored.cachedAt;
      }
    }

    const hasCache = infraSummaryIsValid(infraSummaryCache);
    const cacheFresh = hasCache && Date.now() - infraSummaryLoadedAt <= INFRA_SUMMARY_TTL_MS;

    if (hasCache) {
      renderInfraDashboard(infraSummaryCache);
    }

    if (!force && cacheFresh) {
      return;
    }

    const metaEl = $('dashboardInfraMeta');
    if (hasCache && metaEl) {
      metaEl.textContent = 'VPS e databases · atualizando…';
    } else if (metaEl) {
      metaEl.textContent = 'VPS e databases DigitalOcean · carregando…';
    }

    const fetchFn = panelFetch || fetch;
    try {
      const query = new URLSearchParams({
        window: '3600',
        include_databases: '1',
        ...(force ? { force: '1' } : {}),
      });
      const res = await fetchFn(`/api/infra/metrics?${query.toString()}`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: pageAbort?.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (hasCache) {
          renderInfraDashboard(infraSummaryCache);
          return;
        }
        renderInfraDashboard({
          configured: false,
          detail: data.detail || `HTTP ${res.status}`,
        });
        return;
      }
      infraSummaryCache = data;
      infraSummaryLoadedAt = Date.now();
      writeDashboardCacheToStorage(INFRA_SUMMARY_STORAGE_KEY, infraSummaryCache);
      renderInfraDashboard(data);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      if (hasCache) {
        renderInfraDashboard(infraSummaryCache);
        return;
      }
      renderInfraDashboard({
        configured: false,
        detail: err?.message || 'Infraestrutura indisponível',
      });
    }
  }

  function initInfraDashboardPanel(signal) {
    $('btnRefreshInfra')?.addEventListener('click', () => {
      void loadInfraDashboardSummary({ force: true });
    }, { signal });
  }

  function sortSitesForDashboard(sites) {
    return [...sites].sort((a, b) => {
      if (Boolean(a.online) !== Boolean(b.online)) {
        return a.online ? 1 : -1;
      }
      const minDays = (site) => {
        const values = [site.ssl_days, site.domain_expiry_days]
          .map((item) => Number(item))
          .filter((item) => !Number.isNaN(item));
        return values.length ? Math.min(...values) : Number.POSITIVE_INFINITY;
      };
      return minDays(a) - minDays(b);
    });
  }

  function formatSitesCheckedAt(epochSec) {
    const helpers = window.Lav60SitesMonitorCard;
    if (helpers?.formatCheckedAt) {
      return helpers.formatCheckedAt(epochSec);
    }
    if (epochSec == null) return '—';
    const ms = Number(epochSec) > 1e12 ? Number(epochSec) : Number(epochSec) * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('pt-BR');
  }

  function siteExpiryTone(days, { warn = 30, danger = 14 } = {}) {
    if (days == null || Number.isNaN(Number(days))) return 'muted';
    const value = Number(days);
    if (value <= danger) return 'danger';
    if (value <= warn) return 'warn';
    return 'ok';
  }

  function formatSiteExpiryDays(days) {
    if (days == null || Number.isNaN(Number(days))) return '—';
    const value = Math.max(0, Math.round(Number(days)));
    return value === 1 ? 'Restam 1 dia' : `Restam ${value} dias`;
  }

  function displaySiteHost(site) {
    const raw = String(site.hostname || site.url || site.name || '').trim();
    if (!raw) return 'Site';
    return raw.replace(/^https?:\/\//i, '').replace(/\/+$/, '').split('/')[0];
  }

  function siteHttpLabel(site) {
    if (site.http_code != null && !Number.isNaN(Number(site.http_code))) {
      return `HTTP ${Math.round(Number(site.http_code))}`;
    }
    const http = String(site.http_status || '').trim();
    const match = http.match(/HTTP\s*(\d+)/i);
    if (match) return `HTTP ${match[1]}`;
    return site.online ? 'Online' : 'Offline';
  }

  function countSiteAlerts(sites) {
    return sites.filter((site) => {
      const sslCritical = site.ssl_days != null && Number(site.ssl_days) <= 14;
      const domainCritical = site.domain_expiry_days != null && Number(site.domain_expiry_days) <= 30;
      return sslCritical || domainCritical || !site.online;
    }).length;
  }

  function renderDashboardSiteRow(site) {
    const host = displaySiteHost(site);
    const http = siteHttpLabel(site);
    const sslTone = siteExpiryTone(site.ssl_days, { warn: 30, danger: 14 });
    const domainTone = siteExpiryTone(site.domain_expiry_days, { warn: 60, danger: 30 });
    const dotClass = site.online ? 'dashboard-sites-row__dot--online' : 'dashboard-sites-row__dot--offline';

    return `
      <li class="dashboard-sites-row">
        <div class="dashboard-sites-row__hostline">
          <span class="dashboard-sites-row__dot ${dotClass}" aria-hidden="true"></span>
          <span class="dashboard-sites-row__host" title="${escapeHtml(host)}">${escapeHtml(host)}</span>
          <span class="dashboard-sites-row__http">${escapeHtml(http)}</span>
        </div>
        <div class="dashboard-sites-expiry dashboard-sites-expiry--${sslTone}">
          <span class="dashboard-sites-expiry__label">SSL</span>
          <span class="dashboard-sites-expiry__value">${escapeHtml(formatSiteExpiryDays(site.ssl_days))}</span>
        </div>
        <div class="dashboard-sites-expiry dashboard-sites-expiry--${domainTone}">
          <span class="dashboard-sites-expiry__label">Domínio</span>
          <span class="dashboard-sites-expiry__value">${escapeHtml(formatSiteExpiryDays(site.domain_expiry_days))}</span>
        </div>
      </li>`;
  }

  function renderSitesDashboard(data) {
    const listEl = $('dashboardSitesList');
    const metaEl = $('dashboardSitesMeta');
    if (!listEl) return;

    if (!data || data.detail || data.available === false) {
      if (metaEl) metaEl.textContent = data?.detail || 'Monitor de sites indisponível';
      $('kpiSitesTotal').textContent = '—';
      $('kpiSitesOnline').textContent = '—';
      $('kpiSitesOffline').textContent = '—';
      $('kpiSitesAlerts').textContent = '—';
      listEl.innerHTML = `<li class="dashboard-list__empty">${escapeHtml(data?.detail || 'Configure MONITOR_SITES_BEARER_TOKEN no servidor.')}</li>`;
      return;
    }

    const summary = data.summary || {};
    const sites = sortSitesForDashboard(Array.isArray(data.sites) ? data.sites : []);
    const fetchedLabel = formatSitesCheckedAt(data.fetched_at);
    const alerts = countSiteAlerts(sites);
    const visibleSites = sites.slice(0, DASHBOARD_SITES_LIMIT);
    const hiddenCount = Math.max(0, sites.length - visibleSites.length);

    $('kpiSitesTotal').textContent = Number(summary.total ?? sites.length).toLocaleString('pt-BR');
    $('kpiSitesOnline').textContent = Number(summary.online ?? 0).toLocaleString('pt-BR');
    $('kpiSitesOffline').textContent = Number(summary.offline ?? 0).toLocaleString('pt-BR');
    $('kpiSitesAlerts').textContent = Number(alerts).toLocaleString('pt-BR');

    if (metaEl) {
      metaEl.textContent = `${summary.online ?? 0} online · ${summary.offline ?? 0} offline · ${alerts} alerta(s) · ${fetchedLabel}`;
    }

    if (!sites.length) {
      listEl.innerHTML = '<li class="dashboard-list__empty">Nenhum site retornado pela API.</li>';
      return;
    }

    listEl.innerHTML = [
      ...visibleSites.map(renderDashboardSiteRow),
      hiddenCount > 0
        ? `<li class="dashboard-list__empty">+ ${hiddenCount} site(s) no monitoramento completo</li>`
        : '',
    ].join('');
  }

  async function loadSitesDashboardSummary({ force = false } = {}) {
    if (!$('dashboardSitesList')) return;

    if (!sitesSummaryCache) {
      const stored = readDashboardCacheFromStorage(SITES_SUMMARY_STORAGE_KEY, sitesSummaryIsValid);
      if (stored) {
        sitesSummaryCache = stored.data;
        sitesSummaryLoadedAt = stored.cachedAt;
      }
    }

    const hasCache = sitesSummaryIsValid(sitesSummaryCache);
    const cacheFresh = hasCache && Date.now() - sitesSummaryLoadedAt <= SITES_SUMMARY_TTL_MS;

    if (hasCache) {
      renderSitesDashboard(sitesSummaryCache);
    }

    if (!force && cacheFresh) {
      return;
    }

    const metaEl = $('dashboardSitesMeta');
    if (hasCache && metaEl) {
      metaEl.textContent = 'SSL e domínio · atualizando…';
    } else if (metaEl) {
      metaEl.textContent = 'SSL e domínio · carregando…';
    }

    const fetchFn = panelFetch || fetch;
    try {
      const query = force ? '?force=1' : '';
      const res = await fetchFn(`/api/monitor/sites${query}`, {
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
        signal: pageAbort?.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (hasCache) {
          renderSitesDashboard(sitesSummaryCache);
          return;
        }
        renderSitesDashboard({
          available: false,
          detail: data.detail || `HTTP ${res.status}`,
        });
        return;
      }
      sitesSummaryCache = data;
      sitesSummaryLoadedAt = Date.now();
      writeDashboardCacheToStorage(SITES_SUMMARY_STORAGE_KEY, sitesSummaryCache);
      renderSitesDashboard(data);
    } catch (err) {
      if (err?.name === 'AbortError') return;
      if (hasCache) {
        renderSitesDashboard(sitesSummaryCache);
        return;
      }
      renderSitesDashboard({
        available: false,
        detail: err?.message || 'Monitor de sites indisponível',
      });
    }
  }

  function initSitesDashboardPanel(signal) {
    $('btnRefreshDashboardSites')?.addEventListener('click', () => {
      void loadSitesDashboardSummary({ force: true });
    }, { signal });
  }

  function renderStoreOnlineEvents(items) {
    if (!items?.length) return '';
    return `<ul class="kpi-event-list kpi-event-list--stores">
      ${items
        .map(
          (entry) => `
        <li class="kpi-event-item">
          <a class="kpi-event-item__store" href="${storePageHref(entry.store)}">${escapeHtml(storeDisplayName(entry))}</a>
          <span class="kpi-event-item__sub">${entry.summary_online} de ${entry.summary_total} operacionais · ${entry.health_pct}%</span>
        </li>`
        )
        .join('')}
    </ul>`;
  }

  function renderStoreOfflineEvents(items) {
    if (!items?.length) return '';
    return `<ul class="kpi-event-list kpi-event-list--stores">
      ${items
        .map((entry) => {
          const dur = entry.offline_since ? formatOfflineDuration(entry.offline_since) : '';
          const durHtml = dur ? ` · há ${escapeHtml(dur)}` : '';
          return `
        <li class="kpi-event-item kpi-event-item--alert">
          <span class="kpi-event-item__store">${escapeHtml(storeDisplayName(entry))}</span>
          <span class="kpi-event-item__sub">${escapeHtml(entry.reason || 'Indisponível')}${durHtml}</span>
        </li>`;
        })
        .join('')}
    </ul>`;
  }

  function buildKpiEventsHtml(kpiKey) {
    const events = lastDashboardEvents || {};
    let html = '';
    let count = 0;

    if (kpiKey === 'stores-online') {
      const items = events.stores_online || [];
      count = items.length;
      html = renderStoreOnlineEvents(items);
    } else if (kpiKey === 'stores-offline') {
      const items = events.stores_offline || [];
      count = items.length;
      html = renderStoreOfflineEvents(items);
    } else if (kpiKey === 'stores-partial') {
      const items = events.stores_partial || [];
      count = items.length;
      html = renderStorePartialEvents(items);
    } else if (kpiKey === 'stores-suspended') {
      const items = events.stores_suspended || [];
      count = items.length;
      html = renderStoreSuspendedEvents(items);
    } else if (kpiKey === 'devices-suspended') {
      const items = events.devices_suspended || [];
      count = items.length;
      html = renderDeviceEventsGrouped(items);
    } else if (kpiKey === 'devices-occupied') {
      const items = events.devices_occupied || [];
      count = items.length;
      html = renderDeviceEventsGrouped(items);
    } else if (kpiKey === 'devices-available') {
      const items = events.devices_available || [];
      count = items.length;
      html = renderDeviceEventsGrouped(items);
    } else if (kpiKey === 'devices-offline') {
      const items = events.devices_offline_network || [];
      count = items.length;
      html = renderDeviceEventsGrouped(items);
    }

    return { html, count };
  }

  function handleKpiStoreLinkClick(e) {
    const storeLink = e.target.closest('a.kpi-event-item__store[href*="store.html"], a.kpi-event-group__store[href*="store.html"]');
    if (!storeLink) return false;
    e.preventDefault();
    try {
      const storeId = new URL(storeLink.href, window.location.origin).searchParams.get('store');
      if (storeId) promptStoreChannelById(storeId);
    } catch {
      /* ignore */
    }
    return true;
  }

  function renderAgentKpiModalContent(kpiKey) {
    const config = KPI_PANEL_CONFIG[kpiKey];
    if (!config) return;

    const { html, count } = buildKpiEventsHtml(kpiKey);
    const titleEl = $('agentKpiModalTitle');
    const subtitleEl = $('agentKpiModalSubtitle');
    const bodyEl = $('agentKpiModalBody');

    if (titleEl) titleEl.textContent = config.title;
    if (subtitleEl) {
      subtitleEl.textContent = count > 0 ? `${count} registro(s)` : config.empty;
    }
    if (bodyEl) {
      bodyEl.innerHTML = html || `<p class="kpi-events-panel__empty">${escapeHtml(config.empty)}</p>`;
    }
    window.Lav60KpiModalSearch?.syncAfterRender?.(count);
  }

  function setActiveAgentKpiCard(cardEl) {
    document.querySelectorAll('.dashboard-panel--agent [data-kpi]').forEach((el) => {
      const active = el === cardEl;
      el.classList.toggle('stat-card--active', active);
      el.setAttribute('aria-expanded', active ? 'true' : 'false');
    });
  }

  function openAgentKpiModal(kpiKey, cardEl) {
    const config = KPI_PANEL_CONFIG[kpiKey];
    if (!config || !cardEl) return;

    window.Lav60GatewayOverview?.closeGatewayKpiModal?.();

    activeKpiPanel = kpiKey;
    window.Lav60KpiModalSearch?.init?.();
    window.Lav60KpiModalSearch?.reset?.();
    renderAgentKpiModalContent(kpiKey);
    setActiveAgentKpiCard(cardEl);

    $('agentKpiModal')?.classList.remove('hidden');
    document.body.classList.add('agent-kpi-modal-open');
  }

  function closeAgentKpiModal() {
    activeKpiPanel = null;
    $('agentKpiModal')?.classList.add('hidden');
    document.body.classList.remove('agent-kpi-modal-open');
    window.Lav60KpiModalSearch?.hide?.();
    document.querySelectorAll('.dashboard-panel--agent [data-kpi]').forEach((el) => {
      el.classList.remove('stat-card--active');
      el.setAttribute('aria-expanded', 'false');
    });
    window.Lav60GatewayOverview?.clearGatewayKpiActive?.();
  }

  function initKpiEvents(signal) {
    const root = document.querySelector('.main-content--dashboard') || $('dashboard');
    if (!root) return;

    document.querySelectorAll('[data-agent-kpi-dismiss]').forEach((el) => {
      el.addEventListener('click', closeAgentKpiModal, { signal });
    });

    $('agentKpiModal')?.addEventListener('click', (e) => {
      handleKpiStoreLinkClick(e);
    }, { signal });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if ($('agentKpiModal')?.classList.contains('hidden')) return;
      closeAgentKpiModal();
      window.Lav60GatewayOverview?.closeGatewayKpiModal?.();
    }, { signal });

    root.addEventListener('click', (e) => {
      if (handleKpiStoreLinkClick(e)) return;

      const gatewayCard = e.target.closest('#gatewayKpis [data-kpi]');
      if (gatewayCard) {
        window.Lav60GatewayOverview?.openGatewayKpiModal?.(gatewayCard.dataset.kpi);
        return;
      }

      const agentCard = e.target.closest('.dashboard-panel--agent [data-kpi]');
      if (agentCard) {
        openAgentKpiModal(agentCard.dataset.kpi, agentCard);
      }
    }, { signal });

    root.addEventListener('keydown', (e) => {
      const gatewayCard = e.target.closest('#gatewayKpis [data-kpi]');
      if (gatewayCard && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        window.Lav60GatewayOverview?.openGatewayKpiModal?.(gatewayCard.dataset.kpi);
        return;
      }

      const card = e.target.closest('.dashboard-panel--agent [data-kpi]');
      if (!card || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      openAgentKpiModal(card.dataset.kpi, card);
    }, { signal });
  }

  function applyPayload(data) {
    lastPayload = data;
    allStores = data.stores || [];
    renderDashboard(data.dashboard || {}, data);
    filterAndRender();
  }

  async function loadStores(options = {}) {
    if (refreshInFlight && !options.force) return;
    refreshInFlight = true;

    try {
      if (!catalogConfig) catalogConfig = await loadCatalog();
      const token = await ensureDefaultAgentToken();

      if (options.force) {
        stopHeartbeatMonitor();
      }

      await loadAllStores(token, {
        force: options.force === true,
        onUpdate: (partial) => applyPayload(partial),
      });
    } finally {
      refreshInFlight = false;
    }
  }

  function checkBlockedParam() {
    const params = new URLSearchParams(window.location.search);
    const blocked = params.get('blocked');
    if (blocked) {
      showToast(noAgentMessage(blocked), false);
      window.history.replaceState({ route: 'lojas' }, '', 'index.html#/lojas');
    }
  }

  function initLojasViewToggle(signal) {
    const toggle = $('storesViewToggle');
    if (!toggle) return;
    loadLojasCardLayout();
    syncLojasViewToggleUi();
    toggle.addEventListener(
      'click',
      (e) => {
        const btn = e.target.closest('[data-layout]');
        if (!btn) return;
        const layout = btn.dataset.layout;
        if (!LOJAS_LAYOUTS.includes(layout) || layout === lojasCardLayout) return;
        lojasCardLayout = layout;
        saveLojasCardLayout(layout);
        syncLojasViewToggleUi();
        filterAndRender();
      },
      { signal }
    );
  }

  function initFilters(signal) {
    const search = $('inputSearch');
    const chips = $('filterChips');
    if (!search || !chips) return;

    search.addEventListener('input', (e) => {
      searchQuery = e.target.value.trim();
      filterAndRender();
    }, { signal });

    chips.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-filter]');
      if (!chip) return;
      activeFilter = chip.dataset.filter;
      chips.querySelectorAll('.chip').forEach((c) => c.classList.remove('chip--active'));
      chip.classList.add('chip--active');
      filterAndRender();
    }, { signal });
  }

  function destroy() {
    pageAbort?.abort();
    pageAbort = null;
    closeAgentKpiModal();
    window.Lav60GatewayOverview?.destroy();
    currentPageMode = null;
  }

  function initGatewayDashboardPanel() {
    if (currentPageMode !== 'dashboard' || !$('gatewayOverview') || !panelFetch) return;
    window.Lav60GatewayOverview?.mount({
      fetchFn: panelFetch,
      getStores: () => (allStores.length ? allStores : (catalogConfig?.stores || [])),
      onStoreAction: (storeId) => {
        window.location.href = gatewayPageHref(storeId);
      },
    });
  }

  async function init(mode = 'dashboard') {
    destroy();
    pageAbort = new AbortController();
    const { signal } = pageAbort;
    currentPageMode = mode;

    if (mode === 'dashboard') {
      activeFilter = 'all';
      searchQuery = '';
    }

    initFilters(signal);
    initLojasViewToggle(signal);
    initKpiEvents(signal);
    initStoreChannelModal();

    if (mode === 'lojas') checkBlockedParam();

    if (mode === 'dashboard') {
      hydrateDashboardWidgetCaches();
      loadAuditDashboardSummary();
      loadInfraDashboardSummary();
      loadSitesDashboardSummary();
      initInfraDashboardPanel(signal);
      initSitesDashboardPanel(signal);
    }

    if (storesBootstrapped && allStores.length) {
      renderDashboard(lastPayload?.dashboard || {}, lastPayload || {});
      filterAndRender();
      if (mode === 'dashboard') initGatewayDashboardPanel();
      return;
    }

    void (async () => {
      try {
        await ensureDefaultAgentToken();
        catalogConfig = await loadCatalog();
        await loadStores();
        storesBootstrapped = true;
        if (mode === 'dashboard') initGatewayDashboardPanel();
      } catch (e) {
        const grid = $('storesGrid');
        if (grid) {
          grid.innerHTML = `<div class="stores-empty-state"><p>${escapeHtml(e.message)}</p></div>`;
        }
        showToast(e.message, false);
      }
    })();
  }

  window.Lav60StoresPage = { init, destroy, closeAgentKpiModal };
})();
