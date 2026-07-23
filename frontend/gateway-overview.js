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
    fetchStoreStatuses,
    applyStoreStatusRows,
    formatOfflineDuration,
    GATEWAY_TTL_MS,
  } = window.Lav60;

  const GATEWAY_KPI_CONFIG = {
    'gateway-online': {
      title: 'Gateways online',
      empty: 'Nenhuma loja com redundância disponível.',
    },
    'gateway-offline': {
      title: 'Gateways offline',
      empty: 'Nenhuma loja com gateway offline.',
    },
    'gateway-pending': {
      title: 'Sem verificação recente',
      empty: 'Todas as lojas já foram verificadas antes.',
    },
  };

  const storeOverviewStatus = Object.create(null);
  let overviewScanRunning = false;
  let activeGatewayKpi = null;
  let eventsAbort = null;
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
        online: status?.online,
        agentAlive: status?.agentAlive,
        agentOfflineSinceMs: status?.agentOfflineSinceMs,
        gatewayOfflineSinceMs: status?.gatewayOfflineSinceMs,
      };
      if (!status || status.online == null) {
        if (status?.agentAlive === false) offline.push(entry);
        else pending.push(entry);
      } else if (status.online) online.push(entry);
      else offline.push(entry);
    });
    const sort = (a, b) => a.store.localeCompare(b.store);
    online.sort(sort);
    offline.sort(sort);
    pending.sort(sort);
    return { online, offline, pending };
  }

  function gatewayPageHref(storeId) {
    return `gateway.html?store=${encodeURIComponent(storeId)}`;
  }

  function renderGatewayOnlineEvents(items) {
    if (!items?.length) return '';
    return `<ul class="kpi-event-list kpi-event-list--stores">
      ${items
        .map((entry) => {
          const age = entry.checkedAt ? formatGatewayCacheAge(entry.checkedAt) : '';
          const sub = age ? `Online · ${age}` : 'Online';
          return `
        <li class="kpi-event-item">
          <a class="kpi-event-item__store" href="${gatewayPageHref(entry.store)}">${escapeHtml(storeDisplayName(entry))}</a>
          <span class="kpi-event-item__sub">${escapeHtml(sub)}</span>
        </li>`;
        })
        .join('')}
    </ul>`;
  }

  function offlineDetail(entry) {
    const parts = [];
    if (entry.agentAlive === false && entry.agentOfflineSinceMs) {
      parts.push(`Agente offline há ${formatOfflineDuration(entry.agentOfflineSinceMs)}`);
    }
    if (entry.online === false) {
      if (entry.error) parts.push(entry.error);
      else if (entry.gatewayOfflineSinceMs) {
        parts.push(`Gateway offline há ${formatOfflineDuration(entry.gatewayOfflineSinceMs)}`);
      } else {
        parts.push('Gateway offline');
      }
    } else if (entry.agentAlive === false && !parts.length) {
      parts.push('Agente offline');
    }
    return parts.join(' · ') || 'Sem conexão';
  }

  function renderGatewayOfflineEvents(items) {
    if (!items?.length) return '';
    return `<ul class="kpi-event-list kpi-event-list--stores">
      ${items
        .map((entry) => {
          const age = entry.checkedAt ? formatGatewayCacheAge(entry.checkedAt) : '';
          const reason = offlineDetail(entry);
          const sub = age ? `${reason} · verificado ${age}` : reason;
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
          const sub = entry.checking ? 'Verificando…' : 'Ainda não verificada nesta sessão';
          return `
        <li class="kpi-event-item">
          <span class="kpi-event-item__store">${escapeHtml(storeDisplayName(entry))}</span>
          <span class="kpi-event-item__sub">${escapeHtml(sub)}</span>
        </li>`;
        })
        .join('')}
    </ul>`;
  }

  let kpiModalItemCount = 0;
  let kpiModalSearchBound = false;

  function applyKpiModalSearch(query) {
    const bodyEl = $('agentKpiModalBody');
    const subtitleEl = $('agentKpiModalSubtitle');
    if (!bodyEl) return;

    const q = String(query || '').trim().toLowerCase();
    let visible = 0;
    let total = 0;

    const groups = bodyEl.querySelectorAll('.kpi-event-group');
    if (groups.length) {
      groups.forEach((group) => {
        const headText = group.querySelector('.kpi-event-group__head')?.textContent.toLowerCase() || '';
        const storeMatch = !!q && headText.includes(q);
        let groupVisible = 0;
        group.querySelectorAll('.kpi-event-item').forEach((item) => {
          total += 1;
          const match = !q || storeMatch || item.textContent.toLowerCase().includes(q);
          item.classList.toggle('kpi-event-item--filtered-out', !match);
          if (match) groupVisible += 1;
        });
        group.classList.toggle('kpi-event-group--filtered-out', !!q && groupVisible === 0);
        visible += groupVisible;
      });
    } else {
      bodyEl.querySelectorAll('.kpi-event-item').forEach((item) => {
        total += 1;
        const match = !q || item.textContent.toLowerCase().includes(q);
        item.classList.toggle('kpi-event-item--filtered-out', !match);
        if (match) visible += 1;
      });
    }

    let emptyEl = bodyEl.querySelector('.kpi-events-panel__filter-empty');
    if (q && total > 0 && visible === 0) {
      if (!emptyEl) {
        emptyEl = document.createElement('p');
        emptyEl.className = 'kpi-events-panel__empty kpi-events-panel__filter-empty';
        bodyEl.appendChild(emptyEl);
      }
      emptyEl.textContent = 'Nenhum resultado para esta busca.';
      emptyEl.hidden = false;
    } else if (emptyEl) {
      emptyEl.hidden = true;
    }

    if (subtitleEl && kpiModalItemCount > 0) {
      if (q && total > 0) {
        subtitleEl.textContent =
          visible === total ? `${total} registro(s)` : `${visible} de ${total} registro(s)`;
      } else {
        subtitleEl.textContent = `${kpiModalItemCount} registro(s)`;
      }
    }
  }

  function resetKpiModalSearch() {
    const input = $('agentKpiModalSearch');
    if (input) input.value = '';
    applyKpiModalSearch('');
  }

  function syncKpiModalSearchToolbar(count) {
    kpiModalItemCount = count;
    $('agentKpiModalToolbar')?.classList.toggle('hidden', count <= 0);
    const input = $('agentKpiModalSearch');
    applyKpiModalSearch(input?.value || '');
  }

  function hideKpiModalSearchToolbar() {
    $('agentKpiModalToolbar')?.classList.add('hidden');
    resetKpiModalSearch();
  }

  function initKpiModalSearch() {
    if (kpiModalSearchBound) return;
    kpiModalSearchBound = true;
    const input = $('agentKpiModalSearch');
    if (!input) return;
    input.addEventListener('input', () => applyKpiModalSearch(input.value));
    input.addEventListener('search', () => applyKpiModalSearch(input.value));
  }

  function hideSharedKpiModal() {
    $('agentKpiModal')?.classList.add('hidden');
    document.body.classList.remove('agent-kpi-modal-open');
    hideKpiModalSearchToolbar();
  }

  function renderGatewayKpiModalContent(kpiKey) {
    const config = GATEWAY_KPI_CONFIG[kpiKey];
    const lists = buildGatewayEventLists();
    if (!config) return;

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
    syncKpiModalSearchToolbar(count);
  }

  function resetActiveGatewayKpiCard() {
    document.querySelectorAll('#gatewayKpis [data-kpi]').forEach((el) => {
      el.classList.remove('stat-card--active');
      el.setAttribute('aria-expanded', 'false');
    });
  }

  function setActiveGatewayKpiCard(kpiKey) {
    document.querySelectorAll('#gatewayKpis [data-kpi]').forEach((el) => {
      const active = el.dataset.kpi === kpiKey;
      el.classList.toggle('stat-card--active', active);
      el.setAttribute('aria-expanded', active ? 'true' : 'false');
    });
  }

  function openGatewayKpiModal(kpiKey) {
    const config = GATEWAY_KPI_CONFIG[kpiKey];
    if (!config || !$('agentKpiModal')) return;

    window.Lav60StoresPage?.closeAgentKpiModal?.();

    activeGatewayKpi = kpiKey;
    initKpiModalSearch();
    resetKpiModalSearch();
    renderGatewayKpiModalContent(kpiKey);
    setActiveGatewayKpiCard(kpiKey);

    $('agentKpiModal').classList.remove('hidden');
    document.body.classList.add('agent-kpi-modal-open');
  }

  function clearGatewayKpiActive() {
    activeGatewayKpi = null;
    resetActiveGatewayKpiCard();
  }

  function closeGatewayKpiModal() {
    clearGatewayKpiActive();
    hideSharedKpiModal();
  }

  function updateGatewayOverviewKpis() {
    const stores = getStores();
    let online = 0;
    let offline = 0;
    let pending = 0;
    stores.forEach((meta) => {
      const status = overviewStatusForStore(meta.id);
      if (!status || status.online == null) {
        if (status?.agentAlive === false) offline += 1;
        else pending += 1;
      } else if (status.online) online += 1;
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
      el.textContent = 'Atualizando painel…';
      return;
    }
    el.textContent = 'Clique no card para ver o relatório';
  }

  function noteStoreStatus(storeId, entry = {}) {
    const sid = normalizeStoreId(storeId);
    if (!sid) return;
    storeOverviewStatus[sid] = {
      online: Boolean(entry.online),
      error: entry.error || null,
      checkedAt: entry.checkedAt || Date.now(),
      checking: false,
    };
    render();
  }

  async function loadOverviewFromServer() {
    if (!fetchFn || typeof fetchStoreStatuses !== 'function') return;
    try {
      const rows = await fetchStoreStatuses(fetchFn);
      if (typeof applyStoreStatusRows === 'function') applyStoreStatusRows(rows);
      rows.forEach((row) => {
        const sid = normalizeStoreId(row?.store);
        if (!sid) return;
        storeOverviewStatus[sid] = {
          online: row.gateway_online === true ? true : (row.gateway_online === false ? false : null),
          error: row.gateway_error || null,
          checkedAt: row.gateway_checked_at_ms || null,
          checking: false,
          agentAlive: row.agent_alive,
          agentOfflineSinceMs: row.agent_offline_since_ms || null,
          gatewayOfflineSinceMs: row.gateway_offline_since_ms || null,
        };
      });
      render();
    } catch {
      /* mantém cache local */
    }
  }

  function refreshFromCache() {
    hydrateOverviewFromCache();
    render();
    void loadOverviewFromServer();
  }

  function render() {
    if (!$('gatewayOverview')) return;
    updateGatewayOverviewKpis();
    updateGatewayOverviewMeta(overviewScanRunning);
    if (activeGatewayKpi) renderGatewayKpiModalContent(activeGatewayKpi);
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
        gatewayOfflineSinceMs: result.online ? null : result.checkedAt,
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
    eventsAbort?.abort();
    eventsAbort = new AbortController();
    const { signal } = eventsAbort;

    const root = $('gatewayOverview');
    if (!root) return;

    $('agentKpiModal')?.addEventListener('click', (e) => {
      const storeLink = e.target.closest('a.kpi-event-item__store[href*="gateway.html"]');
      if (!storeLink || !activeGatewayKpi) return;
      const sid = normalizeStoreId(new URL(storeLink.href, window.location.origin).searchParams.get('store'));
      if (!sid) return;
      closeGatewayKpiModal();
      if (typeof onStoreAction === 'function') {
        e.preventDefault();
        onStoreAction(sid);
      }
    }, { signal });

    root.addEventListener('click', (e) => {
      if (e.target.closest('#btnRefreshGateways')) {
        refreshFromCache();
        if (typeof onRefresh === 'function') onRefresh();
        return;
      }
      const card = e.target.closest('[data-kpi]');
      if (!card || !card.closest('#gatewayKpis')) return;
      openGatewayKpiModal(card.dataset.kpi);
    }, { signal });

    root.addEventListener('keydown', (e) => {
      const card = e.target.closest('[data-kpi]');
      if (!card || !card.closest('#gatewayKpis') || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      openGatewayKpiModal(card.dataset.kpi);
    }, { signal });

    document.querySelectorAll('[data-agent-kpi-dismiss]').forEach((el) => {
      el.addEventListener('click', closeGatewayKpiModal, { signal });
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if ($('agentKpiModal')?.classList.contains('hidden')) return;
      if (!activeGatewayKpi) return;
      closeGatewayKpiModal();
    }, { signal });
  }

  function mount(options = {}) {
    fetchFn = options.fetchFn || null;
    getStores = typeof options.getStores === 'function' ? options.getStores : () => [];
    onStoreAction = typeof options.onStoreAction === 'function' ? options.onStoreAction : null;
    onRefresh = typeof options.onRefresh === 'function' ? options.onRefresh : null;
    bindEvents();
    hydrateOverviewFromCache();
    render();
    void loadOverviewFromServer();
  }

  function destroy() {
    overviewScanRunning = false;
    activeGatewayKpi = null;
    eventsAbort?.abort();
    eventsAbort = null;
    closeGatewayKpiModal();
  }

  window.Lav60GatewayOverview = {
    mount,
    destroy,
    render,
    scanAll,
    noteStoreStatus,
    refreshFromCache,
    refresh: render,
    openGatewayKpiModal,
    closeGatewayKpiModal,
    clearGatewayKpiActive,
  };

  window.Lav60KpiModalSearch = {
    init: initKpiModalSearch,
    syncAfterRender: syncKpiModalSearchToolbar,
    reset: resetKpiModalSearch,
    hide: hideKpiModalSearchToolbar,
  };

  if ($('agentKpiModal')) initKpiModalSearch();
})();
