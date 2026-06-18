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

  const $ = (id) => document.getElementById(id);

  const STATE_LABELS = {
    ok: 'Operacional',
    partial: 'Parcial',
    offline: 'Sem equipamentos',
    unreachable: 'Offline',
    suspended: 'Suspensa',
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

  function isStoreSuspended(store) {
    return Boolean(
      store?.storeSuspended ||
        store?.lav60Status === 'suspended' ||
        store?.lav60_status === 'suspended' ||
        store?.state === 'suspended'
    );
  }

  function matchesFilter(store) {
    if (activeFilter === 'all') return true;
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

    let healthLabel;
    if (suspended && operable) {
      healthLabel = renderSuspendedHealthLabel(store);
    } else if (operable) {
      healthLabel = `<span><strong>${online}</strong> de ${total} online · ${formatTime(store.timestamp)}</span>`;
    } else if (suspended) {
      healthLabel = renderSuspendedHealthLabel(store);
    } else {
      healthLabel = renderOfflineHealthLabel(store);
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
    const suspended = isStoreSuspended(store);
    const accessible = store.accessible === true && !store.loading;
    const canPickChannel = !store.loading;
    const isOfflineAlert = !store.loading && !accessible && !suspended;
    const state = store.loading ? 'unknown' : store.state || 'unreachable';
    const pillState = suspended ? 'suspended' : state;
    const stateLabel = store.loading
      ? 'Carregando'
      : STATE_LABELS[pillState] || STATE_LABELS[state] || 'Offline';

    const card = document.createElement('article');
    card.className = [
      'store-card',
      'store-card--v2',
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
        <span class="store-card__status pill pill--${pillState}">${stateLabel}</span>
      </div>
      ${bodyHtml}
    `;

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
      stores.forEach((store) => frag.appendChild(renderStoreCard(store)));
      grid.appendChild(frag);
    }

    const countEl = $('storesCount');
    if (countEl) {
      countEl.textContent = `Exibindo ${stores.length} de ${allStores.length} lojas`;
      countEl.classList.remove('hidden');
    }
    setupOfflineDurationTick();
  }

  function filterAndRender() {
    if (currentPageMode !== 'lojas' || !$('storesGrid')) return;
    const filtered = allStores.filter((s) => matchesFilter(s) && matchesSearch(s));
    renderStoresList(filtered);
  }

  function updatePageSubtitle(payload) {
    const dashboard = payload.dashboard || {};
    const stores = dashboard.stores || {};
    const devices = dashboard.devices || {};
    const subtitle = $('dashboardSubtitle') || $('lojasSubtitle');
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

      const healthPct = devices.health_pct ?? 0;
      const healthEl = $('kpiNetworkHealth');
      const healthBar = $('kpiNetworkHealthBar');
      if (healthEl) {
        healthEl.textContent = devices.total ? `${healthPct}%` : '—';
      }
      if (healthBar) {
        healthBar.style.width = devices.total ? `${healthPct}%` : '0%';
      }

      const onlineTotalEl = $('kpiDevicesOnlineTotal');
      if (onlineTotalEl) {
        onlineTotalEl.textContent = devices.total
          ? `${devices.online ?? 0}/${devices.total}`
          : '—';
      }
      const onlineSubEl = $('kpiDevicesOnlineSub');
      if (onlineSubEl) {
        onlineSubEl.textContent = devices.total
          ? `${devices.online ?? 0} operacionais de ${devices.total} cadastrados`
          : 'Aguardando dados das lojas';
      }

      const partialEl = $('kpiStoresPartial');
      if (partialEl) partialEl.textContent = stores.partial ?? '—';

      const suspendedEl = $('kpiStoresSuspended');
      if (suspendedEl) suspendedEl.textContent = stores.suspended ?? '—';

      renderOfflineLongestList(lastDashboardEvents);
    }

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

    if (activeKpiPanel) {
      renderKpiEventsPanel(activeKpiPanel);
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
      ? 'Verificando redundância…'
      : gatewayOnline
        ? `Redundância disponível${gatewayState.checkedAt ? ` · ${formatGatewayCacheAge(gatewayState.checkedAt)}` : ''}`
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

    const gen = ++channelPickerGeneration;
    const label = store.name ? `${store.name} (${store.id.toUpperCase()})` : store.id.toUpperCase();
    $('storeChannelTitle').textContent = label;
    $('storeChannelSubtitle').textContent = 'Escolha como operar esta loja';
    renderStoreChannelOptions(store, { loading: true });
    modal.classList.remove('hidden');

    let gatewayState = { loading: false, online: false, error: null, checkedAt: null };
    try {
      const result = await verifyStoreGatewayLed(store.id, panelFetch, { force: false });
      if (gen !== channelPickerGeneration) return;
      gatewayState = {
        loading: false,
        online: result.online,
        error: result.error,
        checkedAt: result.checkedAt,
      };
    } catch (err) {
      if (gen !== channelPickerGeneration) return;
      gatewayState = {
        loading: false,
        online: false,
        error: friendlyUserMessage(err.message),
        checkedAt: null,
      };
    }

    renderStoreChannelOptions(store, gatewayState);

    const agent = agentChannelSummary(store);
    if (agent.ready) {
      $('storeChannelSubtitle').textContent = 'Agente local disponível — redundância verificada';
    } else if (gatewayState.online) {
      $('storeChannelSubtitle').textContent = 'Agente indisponível — use a redundância';
    } else {
      $('storeChannelSubtitle').textContent = 'Nenhum canal operacional no momento';
    }
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
        const dur = entry.offline_since ? formatOfflineDuration(entry.offline_since) : '';
        const durText = dur ? `Offline há ${dur}` : 'Offline';
        return `
          <li class="dashboard-list__item">
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

    const hours = data?.hours ?? 24;
    const truncated = data?.truncated ? ' · amostra limitada' : '';
    $('dashboardAuditMeta').textContent = `Últimas ${hours}h${truncated}`;

    totalEl.textContent = Number(data?.total ?? 0).toLocaleString('pt-BR');
    const rate = data?.success_rate;
    $('dashboardAuditSuccessRate').textContent =
      rate != null ? `${rate}%` : '—';

    const topOp = data?.top_operator;
    $('dashboardAuditTopOperator').textContent = topOp
      ? `${operatorDisplayName(topOp)} · ${Number(topOp.count).toLocaleString('pt-BR')} ops`
      : '—';

    const topStore = data?.top_store;
    $('dashboardAuditTopStore').textContent = topStore?.store
      ? `${topStore.store.toUpperCase()} · ${Number(topStore.count).toLocaleString('pt-BR')} ops`
      : '—';
  }

  async function loadAuditDashboardSummary({ force = false } = {}) {
    if (!$('dashboardAuditTotal')) return;

    if (
      !force &&
      auditSummaryCache &&
      Date.now() - auditSummaryLoadedAt <= AUDIT_SUMMARY_TTL_MS
    ) {
      renderAuditSummary(auditSummaryCache);
      return;
    }

    try {
      const res = await fetch('/api/audit/dashboard-summary?hours=24', {
        credentials: 'same-origin',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.available === false || data.detail === 'audit_unavailable') {
        renderAuditSummary({
          available: false,
          detail: data.detail || 'audit_unavailable',
          hint: data.hint,
        });
        return;
      }
      auditSummaryCache = { ...data, available: true };
      auditSummaryLoadedAt = Date.now();
      renderAuditSummary(auditSummaryCache);
    } catch {
      renderAuditSummary({ detail: 'audit_unavailable' });
    }
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

  function renderKpiEventsPanel(kpiKey) {
    const panel = $('kpiEventsPanel');
    const config = KPI_PANEL_CONFIG[kpiKey];
    const events = lastDashboardEvents || {};
    if (!panel || !config) return;

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

    $('kpiEventsTitle').textContent = config.title;
    $('kpiEventsMeta').textContent =
      count > 0 ? `${count} registro(s)` : config.empty;
    $('kpiEventsBody').innerHTML =
      html || `<p class="kpi-events-panel__empty">${escapeHtml(config.empty)}</p>`;

    panel.classList.remove('hidden');
    document.querySelectorAll('[data-kpi]').forEach((el) => {
      const active = el.dataset.kpi === kpiKey;
      el.classList.toggle('stat-card--active', active);
      el.setAttribute('aria-expanded', active ? 'true' : 'false');
    });
  }

  function closeKpiEventsPanel() {
    activeKpiPanel = null;
    $('kpiEventsPanel')?.classList.add('hidden');
    document.querySelectorAll('[data-kpi]').forEach((el) => {
      el.classList.remove('stat-card--active');
      el.setAttribute('aria-expanded', 'false');
    });
  }

  function toggleKpiEventsPanel(kpiKey) {
    if (activeKpiPanel === kpiKey) {
      closeKpiEventsPanel();
      return;
    }
    activeKpiPanel = kpiKey;
    renderKpiEventsPanel(kpiKey);
  }

  function initKpiEvents(signal) {
    const root = document.querySelector('.main-content--dashboard') || $('dashboard');
    if (!root) return;

    root.addEventListener('click', (e) => {
      const storeLink = e.target.closest('a.kpi-event-item__store[href*="store.html"], a.kpi-event-group__store[href*="store.html"]');
      if (storeLink) {
        e.preventDefault();
        try {
          const storeId = new URL(storeLink.href, window.location.origin).searchParams.get('store');
          if (storeId) promptStoreChannelById(storeId);
        } catch {
          /* ignore */
        }
        return;
      }
      const card = e.target.closest('[data-kpi]');
      if (!card) return;
      toggleKpiEventsPanel(card.dataset.kpi);
    }, { signal });

    root.addEventListener('keydown', (e) => {
      const card = e.target.closest('[data-kpi]');
      if (!card || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      toggleKpiEventsPanel(card.dataset.kpi);
    }, { signal });

    $('kpiEventsClose')?.addEventListener('click', closeKpiEventsPanel, { signal });
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
    closeKpiEventsPanel();
    window.Lav60GatewayOverview?.destroy();
    currentPageMode = null;
  }

  function initGatewayDashboardPanel() {
    if (currentPageMode !== 'dashboard' || !$('gatewayOverview') || !panelFetch) return;
    window.Lav60GatewayOverview?.mount({
      fetchFn: panelFetch,
      getStores: () => catalogConfig?.stores || [],
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
    initKpiEvents(signal);
    initStoreChannelModal();

    if (mode === 'lojas') checkBlockedParam();

    if (mode === 'dashboard') {
      loadAuditDashboardSummary();
    }

    if (storesBootstrapped && allStores.length) {
      renderDashboard(lastPayload?.dashboard || {}, lastPayload || {});
      filterAndRender();
      if (mode === 'dashboard') initGatewayDashboardPanel();
      return;
    }

    await ensureDefaultAgentToken();
    try {
      catalogConfig = await loadCatalog();
      await loadStores();
      storesBootstrapped = true;
      if (mode === 'dashboard') {
        loadAuditDashboardSummary();
        initGatewayDashboardPanel();
      }
    } catch (e) {
      const grid = $('storesGrid');
      if (grid) {
        grid.innerHTML = `<div class="stores-empty-state"><p>${escapeHtml(e.message)}</p></div>`;
      }
      showToast(e.message, false);
    }
  }

  window.Lav60StoresPage = { init, destroy };
})();
