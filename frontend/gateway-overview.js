(() => {
  'use strict';

  const {
    normalizeStoreId,
    getStoreGatewayCacheEntry,
    setStoreGatewayCacheEntry,
    isGatewayCacheFresh,
    verifyStoreGatewayLed,
    formatGatewayCacheAge,
    formatStoreGatewayError,
    GATEWAY_TTL_MS,
  } = window.Lav60;

  const GATEWAY_KPI_CONFIG = {
    'gateway-online': {
      title: 'Gateways online',
      empty: 'Nenhuma loja com ESP8266 online no gateway central.',
    },
    'gateway-offline': {
      title: 'Gateways offline',
      empty: 'Nenhuma loja com gateway offline.',
    },
    'gateway-pending': {
      title: 'Aguardando verificação',
      empty: 'Todas as lojas já foram verificadas.',
    },
  };

  const storeOverviewStatus = Object.create(null);
  let overviewScanRunning = false;
  let activeGatewayKpi = null;
  let eventsBound = false;
  let fetchFn = null;
  let getStores = () => [];
  let onStoreAction = null;
  let onRefresh = null;

  const $ = (id) => document.getElementById(id);

  function escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function storeDisplayName(entry) {
    const sid = normalizeStoreId(entry?.store || entry?.id);
    const name = entry?.name;
    if (name) return `${name} (${sid.toUpperCase()})`;
    return sid.toUpperCase();
  }

  function hydrateOverviewFromCache() {
    Object.keys(storeOverviewStatus).forEach((key) => delete storeOverviewStatus[key]);
    getStores().forEach((meta) => {
      const sid = normalizeStoreId(meta.id);
      const cached = getStoreGatewayCacheEntry(sid);
      if (cached) storeOverviewStatus[sid] = { ...cached, checking: false };
    });
  }

  function overviewStatusForStore(storeId) {
    const sid = normalizeStoreId(storeId);
    return storeOverviewStatus[sid] || getStoreGatewayCacheEntry(sid) || null;
  }

  function buildGatewayEventLists() {
    const online = [];
    const offline = [];
    const pending = [];
    getStores().forEach((meta) => {
      const sid = normalizeStoreId(meta.id);
      const status = overviewStatusForStore(sid);
      const entry = {
        store: sid,
        name: meta.name,
        checkedAt: status?.checkedAt,
        error: status?.error,
        checking: Boolean(status?.checking),
      };
      if (!status || status.checking || status.online == null) pending.push(entry);
      else if (status.online) online.push(entry);
      else offline.push(entry);
    });
    const sort = (a, b) => a.store.localeCompare(b.store);
    online.sort(sort);
    offline.sort(sort);
    pending.sort(sort);
    return { online, offline, pending };
  }

  function renderGatewayOnlineEvents(items) {
    if (!items?.length) return '';
    return `<ul class="kpi-event-list kpi-event-list--stores">
      ${items
        .map((entry) => {
          const age = entry.checkedAt ? formatGatewayCacheAge(entry.checkedAt) : '';
          const sub = age ? `ESP8266 online · ${age}` : 'ESP8266 online';
          return `
        <li class="kpi-event-item">
          <button type="button" class="kpi-event-item__store kpi-event-item__store--action" data-gateway-store="${escapeHtml(entry.store)}">${escapeHtml(storeDisplayName(entry))}</button>
          <span class="kpi-event-item__sub">${escapeHtml(sub)}</span>
        </li>`;
        })
        .join('')}
    </ul>`;
  }

  function renderGatewayOfflineEvents(items) {
    if (!items?.length) return '';
    return `<ul class="kpi-event-list kpi-event-list--stores">
      ${items
        .map((entry) => {
          const age = entry.checkedAt ? formatGatewayCacheAge(entry.checkedAt) : '';
          const reason = entry.error || 'Gateway offline';
          const sub = age ? `${reason} · ${age}` : reason;
          return `
        <li class="kpi-event-item kpi-event-item--alert">
          <span class="kpi-event-item__store">${escapeHtml(storeDisplayName(entry))}</span>
          <span class="kpi-event-item__sub">${escapeHtml(sub)}</span>
        </li>`;
        })
        .join('')}
    </ul>`;
  }

  function renderGatewayPendingEvents(items) {
    if (!items?.length) return '';
    return `<ul class="kpi-event-list kpi-event-list--stores">
      ${items
        .map((entry) => {
          const sub = entry.checking ? 'Verificando ESP8266…' : 'Aguardando verificação';
          return `
        <li class="kpi-event-item">
          <span class="kpi-event-item__store">${escapeHtml(storeDisplayName(entry))}</span>
          <span class="kpi-event-item__sub">${escapeHtml(sub)}</span>
        </li>`;
        })
        .join('')}
    </ul>`;
  }

  function renderGatewayKpiPanel(kpiKey) {
    const panel = $('gatewayKpiPanel');
    const config = GATEWAY_KPI_CONFIG[kpiKey];
    const lists = buildGatewayEventLists();
    if (!panel || !config) return;

    let html = '';
    let count = 0;

    if (kpiKey === 'gateway-online') {
      count = lists.online.length;
      html = renderGatewayOnlineEvents(lists.online);
    } else if (kpiKey === 'gateway-offline') {
      count = lists.offline.length;
      html = renderGatewayOfflineEvents(lists.offline);
    } else if (kpiKey === 'gateway-pending') {
      count = lists.pending.length;
      html = renderGatewayPendingEvents(lists.pending);
    }

    $('gatewayKpiTitle').textContent = config.title;
    $('gatewayKpiMeta').textContent = count > 0 ? `${count} loja(s)` : config.empty;
    $('gatewayKpiBody').innerHTML =
      html || `<p class="kpi-events-panel__empty">${escapeHtml(config.empty)}</p>`;

    panel.classList.remove('hidden');
    document.querySelectorAll('#gatewayKpis [data-kpi]').forEach((el) => {
      const active = el.dataset.kpi === kpiKey;
      el.classList.toggle('stat-card--active', active);
      el.setAttribute('aria-expanded', active ? 'true' : 'false');
    });
  }

  function closeGatewayKpiPanel() {
    activeGatewayKpi = null;
    $('gatewayKpiPanel')?.classList.add('hidden');
    document.querySelectorAll('#gatewayKpis [data-kpi]').forEach((el) => {
      el.classList.remove('stat-card--active');
      el.setAttribute('aria-expanded', 'false');
    });
  }

  function toggleGatewayKpiPanel(kpiKey) {
    if (activeGatewayKpi === kpiKey) {
      closeGatewayKpiPanel();
      return;
    }
    activeGatewayKpi = kpiKey;
    renderGatewayKpiPanel(kpiKey);
  }

  function updateGatewayOverviewKpis() {
    const stores = getStores();
    let online = 0;
    let offline = 0;
    let pending = 0;
    stores.forEach((meta) => {
      const status = overviewStatusForStore(meta.id);
      if (!status || status.checking || status.online == null) pending += 1;
      else if (status.online) online += 1;
      else offline += 1;
    });
    const onlineEl = $('kpiGatewayOnline');
    const offlineEl = $('kpiGatewayOffline');
    const pendingEl = $('kpiGatewayPending');
    if (onlineEl) onlineEl.textContent = String(online);
    if (offlineEl) offlineEl.textContent = String(offline);
    if (pendingEl) pendingEl.textContent = String(pending);
  }

  function updateGatewayOverviewMeta(scanning = false) {
    const el = $('gatewayOverviewMeta');
    if (!el) return;
    if (scanning) {
      el.textContent = 'Verificando gateways (POST led/on)…';
      return;
    }
    const ttlMin = Math.round(GATEWAY_TTL_MS / 60000);
    el.textContent = `Redundância via gateway.lav60.com · cache ${ttlMin} min`;
  }

  function render() {
    if (!$('gatewayOverview')) return;
    updateGatewayOverviewKpis();
    updateGatewayOverviewMeta(overviewScanRunning);
    if (activeGatewayKpi) renderGatewayKpiPanel(activeGatewayKpi);
  }

  async function probeOverviewStoreGateway(storeId) {
    const sid = normalizeStoreId(storeId);
    if (!fetchFn) return;
    storeOverviewStatus[sid] = { ...(storeOverviewStatus[sid] || {}), checking: true, online: null };
    render();

    try {
      const result = await verifyStoreGatewayLed(sid, fetchFn, { force: false });
      setStoreGatewayCacheEntry(sid, { online: result.online, error: result.error });
      storeOverviewStatus[sid] = {
        online: result.online,
        error: result.error,
        checkedAt: result.checkedAt,
        checking: false,
      };
    } catch (err) {
      const error = formatStoreGatewayError(sid, err.message);
      setStoreGatewayCacheEntry(sid, { online: false, error });
      storeOverviewStatus[sid] = { online: false, error, checkedAt: Date.now(), checking: false };
    }

    render();
  }

  async function scanAll({ force = false, skipStores = null } = {}) {
    if (overviewScanRunning || !fetchFn || !$('gatewayOverview')) return;
    const stores = getStores();
    if (!stores.length) return;

    overviewScanRunning = true;
    updateGatewayOverviewMeta(true);
    $('btnRefreshGateways')?.setAttribute('disabled', 'disabled');

    const skip = new Set(
      (Array.isArray(skipStores) ? skipStores : skipStores ? [skipStores] : [])
        .map(normalizeStoreId)
        .filter(Boolean)
    );

    try {
      for (let i = 0; i < stores.length; i += 1) {
        const sid = normalizeStoreId(stores[i].id);
        if (!sid || skip.has(sid)) continue;
        const cached = getStoreGatewayCacheEntry(sid);
        if (!force && cached && isGatewayCacheFresh(cached.checkedAt)) {
          storeOverviewStatus[sid] = { ...cached, checking: false };
          render();
          continue;
        }
        await probeOverviewStoreGateway(sid);
        if (i < stores.length - 1) await sleep(400);
      }
    } finally {
      overviewScanRunning = false;
      $('btnRefreshGateways')?.removeAttribute('disabled');
      updateGatewayOverviewMeta(false);
      render();
    }
  }

  function bindEvents() {
    if (eventsBound) return;
    const root = $('gatewayOverview');
    if (!root) return;
    eventsBound = true;

    root.addEventListener('click', (e) => {
      const storeBtn = e.target.closest('[data-gateway-store]');
      if (storeBtn) {
        const sid = storeBtn.dataset.gatewayStore;
        closeGatewayKpiPanel();
        if (typeof onStoreAction === 'function') onStoreAction(sid);
        return;
      }
      if (e.target.closest('#btnRefreshGateways')) {
        void scanAll({ force: true }).then(() => {
          if (typeof onRefresh === 'function') onRefresh();
        });
        return;
      }
      const card = e.target.closest('[data-kpi]');
      if (!card || !card.closest('#gatewayKpis')) return;
      toggleGatewayKpiPanel(card.dataset.kpi);
    });

    root.addEventListener('keydown', (e) => {
      const card = e.target.closest('[data-kpi]');
      if (!card || !card.closest('#gatewayKpis') || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      toggleGatewayKpiPanel(card.dataset.kpi);
    });

    $('gatewayKpiClose')?.addEventListener('click', closeGatewayKpiPanel);
  }

  function mount(options = {}) {
    fetchFn = options.fetchFn || null;
    getStores = typeof options.getStores === 'function' ? options.getStores : () => [];
    onStoreAction = typeof options.onStoreAction === 'function' ? options.onStoreAction : null;
    onRefresh = typeof options.onRefresh === 'function' ? options.onRefresh : null;
    bindEvents();
    hydrateOverviewFromCache();
    render();
    if (fetchFn) void scanAll({ force: false, skipStores: options.skipStores || null });
  }

  function destroy() {
    overviewScanRunning = false;
    activeGatewayKpi = null;
    closeGatewayKpiPanel();
  }

  window.Lav60GatewayOverview = { mount, destroy, render, scanAll, refresh: render };
})();
