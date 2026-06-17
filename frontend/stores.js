(() => {
  'use strict';

  const {
    loadAllStores,
    ensureDefaultAgentToken,
    friendlyUserMessage,
    formatOfflineDuration,
    noAgentMessage,
    isAgentUnavailableError,
    loadCatalog,
    stopHeartbeatMonitor,
    machineMetaTitle,
    normalizeMachineStatus,
  } = window.Lav60;
  let offlineDurationTimer = null;
  let refreshInFlight = false;
  let allStores = [];
  let catalogConfig = null;
  let activeFilter = 'all';
  let searchQuery = '';

  const $ = (id) => document.getElementById(id);

  const STATE_LABELS = {
    ok: 'Operacional',
    partial: 'Parcial',
    offline: 'Sem equipamentos',
    unreachable: 'Offline',
    unknown: 'Aguardando',
  };

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

  function matchesFilter(store) {
    if (activeFilter === 'all') return true;
    if (activeFilter === 'unreachable') {
      return (
        store.state === 'unreachable' ||
        store.state === 'offline' ||
        store.agentUnavailable ||
        isAgentUnavailableError(store.error)
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
      address: dev.address,
      status_label: dev.status_label,
      capacity: dev.capacity,
      liter_capacity: dev.liter_capacity,
      waiting_minutes: dev.waiting_minutes,
      store_code: dev.store_code,
      time_dosage: dev.time_dosage,
      port: dev.port,
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

  function renderDeviceGroups(devices) {
    return Object.keys(GROUP_LABELS)
      .map(
        (group) => `
        <div class="store-card__device-group">
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

  function renderStoreCardBody(store, { accessible, online, total, pct }) {
    const healthLabel = accessible
      ? `<span><strong>${online}</strong> de ${total} online · ${formatTime(store.timestamp)}</span>`
      : renderOfflineHealthLabel(store);
    const healthPct = accessible ? `${pct}%` : '—';
    const healthFill = accessible ? pct : 0;
    const devicesClass = accessible
      ? 'store-card__devices'
      : 'store-card__devices store-card__devices--stale';

    const ctaHtml = accessible
      ? `<div class="store-card__cta">
          <span>Abrir painel da loja</span>
          <span class="store-card__cta-icon" aria-hidden="true">→</span>
        </div>`
      : `<div class="store-card__cta store-card__cta--blocked">
          <span>Sem conexão com a loja</span>
        </div>`;

    return `
      <div class="store-card__body${accessible ? '' : ' store-card__body--offline'}">
        <div class="store-card__health">
          <div class="store-card__health-track${accessible ? '' : ' store-card__health-track--offline'}" role="presentation">
            <span class="store-card__health-fill" style="width:${healthFill}%"></span>
          </div>
          <div class="store-card__health-labels">
            ${healthLabel}
            <span class="store-card__health-pct">${healthPct}</span>
          </div>
        </div>
        <div class="${devicesClass}">${renderDeviceGroups(store.devices)}</div>
        ${ctaHtml}
      </div>`;
  }

  function tickOfflineDurations() {
    document.querySelectorAll('.store-card[data-offline-since]').forEach((card) => {
      const since = Number(card.dataset.offlineSince);
      if (!since) return;
      const el = card.querySelector('.store-card__offline-since');
      if (!el) return;
      const dur = formatOfflineDuration(since);
      el.textContent = dur || '';
    });
  }

  function setupOfflineDurationTick() {
    if (offlineDurationTimer) return;
    offlineDurationTimer = setInterval(tickOfflineDurations, 30000);
  }

  function buildStoreHeading(store) {
    const code = store.id.toUpperCase();
    const name = (store.name || '').trim();
    const sameAsCode =
      !name || name.toUpperCase() === code || name.toUpperCase() === store.id.toUpperCase();

    if (sameAsCode) {
      return `<h3 class="store-card__title">${escapeHtml(code)}</h3>`;
    }

    return `<span class="store-card__code">${escapeHtml(code)}</span><h3 class="store-card__title">${escapeHtml(name)}</h3>`;
  }

  function renderStoreCard(store) {
    const summary = store.summary || {};
    const online = summary.online ?? 0;
    const total = summary.total ?? 0;
    const pct = healthPercent(summary);
    const accessible = store.accessible === true && !store.loading;
    const isOfflineAlert = !store.loading && !accessible;
    const state = store.loading ? 'unknown' : store.state || 'unreachable';
    const stateLabel = store.loading ? 'Carregando' : STATE_LABELS[state] || 'Offline';

    const card = document.createElement('article');
    card.className = [
      'store-card',
      'store-card--v2',
      `store-card--${state}`,
      accessible ? 'store-card--clickable' : 'store-card--blocked',
      isOfflineAlert ? 'store-card--offline-alert' : '',
      store.loading ? 'store-card--loading' : '',
    ]
      .filter(Boolean)
      .join(' ');

    card.dataset.storeId = store.id;
    card.dataset.state = state;
    if (isOfflineAlert && store.offlineSince) {
      card.dataset.offlineSince = String(store.offlineSince);
    }

    const storeLabel = store.name || store.id.toUpperCase();

    let bodyHtml = '';
    if (store.loading) {
      bodyHtml = `<p class="store-card__message">Sincronizando equipamentos…</p>`;
    } else {
      bodyHtml = renderStoreCardBody(store, { accessible, online, total, pct });
    }

    card.innerHTML = `
      <div class="store-card__accent" aria-hidden="true"></div>
      <div class="store-card__top">
        <div class="store-card__identity">
          ${buildStoreHeading(store)}
        </div>
        <span class="store-card__status pill pill--${state}">${stateLabel}</span>
      </div>
      ${bodyHtml}
    `;

    if (accessible) {
      card.setAttribute('role', 'button');
      card.setAttribute('tabindex', '0');
      card.setAttribute('aria-label', `Abrir loja ${storeLabel}`);
      const open = () => {
        window.location.href = `store.html?store=${encodeURIComponent(store.id)}`;
      };
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
    grid.innerHTML = '';

    if (!allStores.length) {
      grid.innerHTML = `
        <div class="stores-empty-state">
          <p>Nenhuma loja conectada — aguardando heartbeat dos agentes</p>
        </div>`;
      $('storesCount').classList.add('hidden');
      return;
    }

    if (!stores.length) {
      grid.innerHTML = `
        <div class="stores-empty-state">
          <p>Nenhuma loja encontrada com os filtros atuais.</p>
        </div>`;
    } else {
      const frag = document.createDocumentFragment();
      stores.forEach((store) => frag.appendChild(renderStoreCard(store)));
      grid.appendChild(frag);
    }

    const countEl = $('storesCount');
    countEl.textContent = `Exibindo ${stores.length} de ${allStores.length} lojas`;
    countEl.classList.remove('hidden');
    setupOfflineDurationTick();
  }

  function filterAndRender() {
    const filtered = allStores.filter((s) => matchesFilter(s) && matchesSearch(s));
    renderStoresList(filtered);
  }

  function updateDashboardHeader(payload) {
    const dashboard = payload.dashboard || {};
    const stores = dashboard.stores || {};
    const devices = dashboard.devices || {};
    const subtitle = $('dashboardSubtitle');
    if (!subtitle) return;

    if (payload.fromCache && payload.live === false) {
      const count = payload.stores?.length || dashboard.stores?.total || 0;
      subtitle.textContent = `${count} loja(s) no cache local · sincronizando heartbeat…`;
      return;
    }

    if (payload.refreshing && payload.progress?.total) {
      subtitle.textContent = `Carregando catálogo de lojas (${payload.progress.done}/${payload.progress.total})…`;
      return;
    }

    if (payload.timestamp) {
      const offlineDevices = devices.offline ?? 0;
      const totalStores = stores.total ?? 0;
      subtitle.textContent =
        offlineDevices > 0
          ? `${offlineDevices} equipamento(s) offline no total · ${totalStores} loja(s) monitoradas`
          : `${totalStores} loja(s) monitoradas · rede estável`;
      return;
    }

    subtitle.textContent = 'Carregando monitoramento…';
  }

  function renderDashboard(dashboard, payload) {
    const stores = dashboard.stores || {};
    const devices = dashboard.devices || {};

    $('kpiStoresOnline').textContent = stores.online ?? '—';
    $('kpiStoresOnlineSub').textContent =
      stores.connected > stores.online
        ? `${stores.online} operacional · ${stores.connected} com agente`
        : `de ${stores.total ?? '—'} lojas`;
    $('kpiStoresOffline').textContent = stores.offline ?? '—';
    $('kpiStoresOfflineSub').textContent =
      stores.pending > 0 ? `${stores.pending} carregando` : 'sem equipamento ou agente';
    $('kpiDevicesOffline').textContent = devices.offline ?? '—';
    $('kpiDevicesOfflineSub').textContent = `de ${devices.total ?? '—'} equipamentos`;

    updateDashboardHeader({ dashboard, ...payload });

    let meta = formatTime(payload.timestamp);
    if (payload.refreshing && payload.progress) {
      meta = `Sincronizando ${payload.progress.done}/${payload.progress.total} · ${meta}`;
    } else if (payload.fromCache && payload.live === false) {
      meta = `Cache local · ${meta}`;
    }
    $('storesMeta').textContent = meta;
  }

  function applyPayload(data) {
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
      window.history.replaceState({}, '', 'index.html');
    }
  }

  function initAuthUi() {
    if (!window.Lav60Auth) return;
    Lav60Auth.authEnabled().then(async (enabled) => {
      if (!enabled) return;
      await Lav60Auth.mountUserMenu($('headerUserMenu'));
    });
  }

  function initFilters() {
    $('inputSearch').addEventListener('input', (e) => {
      searchQuery = e.target.value.trim();
      filterAndRender();
    });

    $('filterChips').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-filter]');
      if (!chip) return;
      activeFilter = chip.dataset.filter;
      $('filterChips').querySelectorAll('.chip').forEach((c) => c.classList.remove('chip--active'));
      chip.classList.add('chip--active');
      filterAndRender();
    });
  }

  async function init() {
    initFilters();
    initAuthUi();
    checkBlockedParam();
    await ensureDefaultAgentToken();
    try {
      catalogConfig = await loadCatalog();
      await loadStores();
    } catch (e) {
      $('storesGrid').innerHTML = `<div class="stores-empty-state"><p>${escapeHtml(e.message)}</p></div>`;
      showToast(e.message, false);
    }
  }

  (async () => {
    if (window.Lav60Auth) {
      const ok = await Lav60Auth.guardPage();
      if (!ok) return;
    }
    await init();
  })();
})();
