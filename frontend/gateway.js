(() => {
  'use strict';

  const {
    loadCatalog,
    friendlyUserMessage,
    formatOperatorError,
    WASHER_DOSAGE_OPTIONS,
    findMachineMeta,
    mergeMachinesCatalog,
    enrichDoserMeta,
    canOperateMachineStatus,
    deviceUnifiedStatus,
    isDeviceRegisteredInCatalog,
    verifyStoreGatewayLed,
    formatStoreGatewayError,
    syncConfigDevices,
    devicesFromMachines,
    isAgentsDisabled,
    agentOperationFailureMessage,
    agentStatusPayloadIndicatesRelease,
    machineListEntryIndicatesRelease,
    dryerReleaseVerifyDelayMs,
    agentPostConfirmsFirstRelease,
    agentPostExplicitlyReleased,
    getStoreGatewayCacheEntry,
    setStoreGatewayCacheEntry,
    isStoreCardSuspended,
    dryerMinuteChoices,
    dryerChoicePickerColumns,
    dryerChoiceRequireSelection,
  } = window.Lav60;
  const { guardPage, mountUserMenu, panelFetch } = window.Lav60Auth;

  const $ = (id) => document.getElementById(id);

  const confirmUI = Lav60DeviceUI.createConfirmUI({
    $,
    onToast: (message, ok = true) => showToast(message, ok),
    formatError: (label, message) => formatOperatorError(label, message),
  });
  const { confirmAction, showActionConfirm, showActionError, bindConfirmEvents } = confirmUI;

  const {
    createDeviceCard,
    canOperateMachine,
    deviceStatusHint,
    buildDoserCardContent,
    btn,
    createChoicePicker,
    syncReleaseButtonWithPicker,
    appendReleaseButton,
  } = Lav60DeviceUI.createDeviceUI(window.Lav60);

  const { dosageLabel } = Lav60DeviceUI;

  const DRYER_LOCK_STORAGE_KEY = 'lav60_dryer_locks';
  const WASHER_LOCK_STORAGE_KEY = 'lav60_washer_locks';

  const STATUS_PATHS = {
    washer: (id) => `status/washer/${id}`,
    dryer: (id) => `status/dryer/${id}`,
    doser: (id) => `status/doser/${id}`,
    ac: () => 'status/ac',
  };

  let gatewayConfig = null;
  let catalog = null;
  let machinesCatalog = [];
  let currentStore = '';
  let get02PanelDisabled = false;
  let storeGatewayReady = false;
  let storeGatewayError = null;
  let storeGatewayCheckedAt = null;
  let storeGatewayFromCache = false;
  let storeGatewayChecking = false;
  let storeCheckGeneration = 0;
  let pingStatus = null;
  let actionBusy = false;
  let deviceLockTimer = null;
  let dryerLocks = {};
  let washerLocks = {};
  const probingDevices = new Set();
  const activeProbeGroups = new Set();
  let probeGeneration = 0;
  let probeQueueRunner = null;
  let get02HubList = null;

  const GATEWAY_CACHE_KEY = 'lav60:gateway:v1';
  const GATEWAY_CACHE_VERSION = 5;
  const GATEWAY_TTL_MS = 5 * 60 * 1000;
  const DEVICES_TTL_MS = 10 * 60 * 1000;

  function gatewayDebug() {}

  function normalizeStoreId(value) {
    return String(value || '').trim().toLowerCase();
  }

  function isCacheFresh(checkedAt, ttlMs) {
    return Number.isFinite(checkedAt) && Date.now() - checkedAt < ttlMs;
  }

  function formatCacheAge(checkedAt) {
    if (!Number.isFinite(checkedAt)) return '';
    const sec = Math.floor((Date.now() - checkedAt) / 1000);
    if (sec < 45) return 'agora';
    const min = Math.floor(sec / 60);
    if (min < 60) return min === 1 ? 'há 1 min' : `há ${min} min`;
    const hours = Math.floor(min / 60);
    return hours === 1 ? 'há 1 h' : `há ${hours} h`;
  }

  function loadGatewayCacheRoot() {
    try {
      const raw = JSON.parse(localStorage.getItem(GATEWAY_CACHE_KEY) || '{}');
      if (raw.version !== GATEWAY_CACHE_VERSION) {
        return { version: GATEWAY_CACHE_VERSION, stores: {} };
      }
      return { version: GATEWAY_CACHE_VERSION, stores: raw.stores || {} };
    } catch {
      return { version: GATEWAY_CACHE_VERSION, stores: {} };
    }
  }

  function saveGatewayCacheRoot(root) {
    try {
      localStorage.setItem(GATEWAY_CACHE_KEY, JSON.stringify(root));
    } catch {
      /* quota ou modo privado */
    }
  }

  function getStoreDevicesEntry(storeId) {
    const sid = normalizeStoreId(storeId);
    return loadGatewayCacheRoot().stores[sid]?.devices || null;
  }

  function setStoreDevicesEntry(storeId, status) {
    const sid = normalizeStoreId(storeId);
    if (!sid || !status) return;
    const root = loadGatewayCacheRoot();
    if (!root.stores[sid]) root.stores[sid] = {};
    root.stores[sid].devices = {
      pingStatus: {
        washers: { ...(status.washers || {}) },
        dryers: { ...(status.dryers || {}) },
        dosers: { ...(status.dosers || {}) },
        ac: status.ac ?? null,
      },
      checkedAt: Date.now(),
    };
    saveGatewayCacheRoot(root);
  }

  function clonePingStatus(source) {
    if (!source) return null;
    return {
      washers: { ...(source.washers || {}) },
      dryers: { ...(source.dryers || {}) },
      dosers: { ...(source.dosers || {}) },
      ac: source.ac ?? null,
    };
  }

  function refreshGatewayOverview() {
    window.Lav60GatewayOverview?.render();
  }

  function isStoreInGet02Scope(meta) {
    if (!meta) return false;
    if (typeof isStoreCardSuspended === 'function' && isStoreCardSuspended(meta)) return false;
    return String(meta.lav60_status || '').toLowerCase() !== 'suspended';
  }

  function isGet02StoreOnline(meta) {
    if (!isStoreInGet02Scope(meta)) return false;
    const sid = normalizeStoreId(meta.id);
    if (!sid) return false;
    const overviewStatus = window.Lav60GatewayOverview?.statusForStore?.(sid);
    if (overviewStatus) {
      if (overviewStatus.checking) return false;
      return overviewStatus.online === true;
    }
    const cached = getStoreGatewayCacheEntry(sid);
    return cached?.online === true;
  }

  function onlineStoresForGet02() {
    const fromOverview = window.Lav60GatewayOverview?.getOnlineStoreMetas?.();
    if (Array.isArray(fromOverview)) return fromOverview;
    return (catalog?.stores || []).filter((meta) => isGet02StoreOnline(meta));
  }

  function mountGet02HubList() {
    if (!window.Lav60AgentHubStores?.mountHubList) return;
    get02HubList = Lav60AgentHubStores.mountHubList({
      listEl: $('get02StoreList'),
      searchEl: $('get02StoreSearch'),
      metaEl: $('get02StoreHubMeta'),
      countEl: $('get02StoreHubCount'),
      getItems: onlineStoresForGet02,
      getSubtext: (meta) => {
        const sid = normalizeStoreId(meta.id);
        const status = window.Lav60GatewayOverview?.statusForStore?.(sid);
        if (status?.checkedAt) return `Online · ${formatCacheAge(status.checkedAt)}`;
        return 'Gateway online';
      },
      onSelect: (sid) => {
        void applyStore(sid);
      },
      emptyText: 'Nenhuma loja com gateway GET02 online.',
    });
  }

  function refreshGet02HubList() {
    if (get02HubList) {
      get02HubList.refresh();
      return;
    }
    mountGet02HubList();
  }

  function syncGatewayOverviewStore(storeId, entry) {
    window.Lav60GatewayOverview?.noteStoreStatus?.(storeId, entry);
  }

  function escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showToast(message, ok = true) {
    const el = $('toast');
    el.textContent = friendlyUserMessage(message);
    el.className = `toast ${ok ? 'toast--ok' : 'toast--err'}`;
    el.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.add('hidden'), 4500);
  }

  function appendLog() {}

  function storeSelected() {
    return Boolean(currentStore && storeGatewayReady);
  }

  function setDevicesPanelBlocked(blocked) {
    $('devicesPanel')?.classList.toggle('devices-panel--blocked', blocked);
  }

  function showStoreGatewayChecking(show) {
    storeGatewayChecking = show;
    $('storeGatewayChecking')?.classList.toggle('hidden', !show);
    updateStoreStatusButtons();
  }

  function showStoreGatewayAlert(message) {
    const alert = $('storeGatewayAlert');
    const text = $('storeGatewayAlertText');
    if (text) text.textContent = message || 'Gateway da loja não está online.';
    alert?.classList.remove('hidden');
  }

  function hideStoreGatewayAlert() {
    $('storeGatewayAlert')?.classList.add('hidden');
  }

  function gatewayMetaSuffix() {
    const parts = [];
    if (storeGatewayCheckedAt) {
      parts.push(formatCacheAge(storeGatewayCheckedAt));
    }
    if (storeGatewayFromCache) parts.push('em cache');
    return parts.length ? ` · ${parts.join(' · ')}` : '';
  }

  function updateStoreGatewayMeta(state, detail = '') {
    const el = $('storeGatewayMeta');
    const hint = $('storeGatewayHint');
    if (!el) return;
    el.className = 'gateway-meta';
    if (!currentStore || !state) {
      el.textContent = 'Gateway: —';
      if (hint) hint.textContent = 'Teste real: POST /led/on no módulo de redundância';
      updateStoreStatusButtons();
      return;
    }
    const code = currentStore.toUpperCase();
    if (state === 'waiting') {
      el.textContent = `Gateway: aguardando (${code})`;
      el.classList.add('gateway-meta--warn');
      if (hint) hint.textContent = 'Use ↻ em cada equipamento para verificar o status MQTT';
    } else if (state === 'checking') {
      el.textContent = `Gateway: verificando módulo (${code})…`;
      el.classList.add('gateway-meta--warn');
      if (hint) hint.textContent = 'Enviando POST /led/on ao gateway central…';
    } else if (state === 'online') {
      el.textContent = `Gateway: online (${code})${gatewayMetaSuffix()}`;
      el.classList.add('gateway-meta--ok');
      if (hint) {
        hint.textContent = storeGatewayFromCache
          ? 'Status em cache — use “Verificar módulo” para teste real via POST /led/on'
          : 'Módulo respondeu ao POST /led/on';
      }
    } else if (state === 'offline') {
      el.textContent = detail || `Gateway: offline (${code})${gatewayMetaSuffix()}`;
      el.classList.add('gateway-meta--err');
      if (hint) {
        hint.textContent = storeGatewayFromCache
          ? 'Status em cache — use “Verificar módulo” para novo teste'
          : 'Módulo não respondeu ao POST /led/on';
      }
    } else {
      el.textContent = 'Gateway: —';
      if (hint) hint.textContent = 'Teste real: POST /led/on no módulo de redundância';
    }
    updateStoreStatusButtons();
  }

  function updateStoreStatusButtons() {
    const verifyBtn = $('btnVerifyGatewayModule');
    const devicesBtn = $('btnRefreshGatewayDevices');
    const batchProbing = Boolean(probeQueueRunner);
    const anyProbing = probingDevices.size > 0 || batchProbing;
    const canProbe = Boolean(currentStore && !storeGatewayChecking);
    if (verifyBtn) {
      verifyBtn.disabled = !currentStore || storeGatewayChecking;
      verifyBtn.textContent = storeGatewayChecking ? 'Verificando…' : 'Verificar módulo';
    }
    if (devicesBtn) {
      devicesBtn.disabled = !canProbe || batchProbing;
      devicesBtn.textContent = batchProbing ? 'Verificando…' : 'Atualizar equipamentos';
    }
    document.querySelectorAll('[data-refresh-group]').forEach((btn) => {
      const group = btn.dataset.refreshGroup;
      const groupBusy = batchProbing && activeProbeGroups.has(group);
      btn.disabled = !canProbe || groupBusy;
      btn.textContent = groupBusy ? 'Verificando…' : 'Atualizar';
    });
  }

  function deviceRefreshKey(deviceType, machine) {
    const id = machine == null || machine === '' ? '_' : String(machine);
    return `${deviceType}:${id}`;
  }

  function parseDeviceRefreshKey(raw) {
    const text = String(raw || '');
    const colon = text.indexOf(':');
    if (colon < 1) return null;
    const deviceType = text.slice(0, colon).toLowerCase();
    const machineRaw = text.slice(colon + 1);
    const machine = machineRaw === '_' ? null : machineRaw;
    return { deviceType, machine };
  }

  function canRefreshDevice(deviceType, machine) {
    if (!currentStore || storeGatewayChecking) return false;
    if (isDeviceProbing(deviceType, machine)) return false;
    return true;
  }

  function deviceCardRefreshOptions(deviceType, machine) {
    return {
      refreshKey: deviceRefreshKey(deviceType, machine),
      canRefresh: canRefreshDevice(deviceType, machine),
      probing: isDeviceProbing(deviceType, machine),
      requireProbeOnline: true,
      pendingLabel: 'Aguardando',
    };
  }

  async function refreshGatewayDevice(deviceType, machine) {
    const dtype = String(deviceType || '').toLowerCase();
    if (!dtype) return;
    if (!canRefreshDevice(dtype, machine)) return;
    await probeDeviceOnline(dtype, machine, { silent: false, ignoreGeneration: true });
  }

  async function verifyStoreGateway(storeId, { force = false } = {}) {
    const gen = ++storeCheckGeneration;
    storeGatewayReady = false;
    storeGatewayError = null;
    hideStoreGatewayAlert();

    const cached = getStoreGatewayCacheEntry(storeId);
    if (!force && cached && isCacheFresh(cached.checkedAt, GATEWAY_TTL_MS)) {
      if (gen !== storeCheckGeneration || normalizeStoreId(storeId) !== currentStore) return false;
      storeGatewayCheckedAt = cached.checkedAt;
      storeGatewayFromCache = true;
      const gatewayOperable = cached.online === true || cached.apiOnline === true;
      if (gatewayOperable) {
        storeGatewayReady = true;
        storeGatewayError = cached.online === true ? null : cached.error || null;
        if (cached.online === true) {
          updateStoreGatewayMeta('online');
          hideStoreGatewayAlert();
        } else {
          showStoreGatewayAlert(
            storeGatewayError || 'Módulo da loja não respondeu — operação via gateway central'
          );
          updateStoreGatewayMeta('online', storeGatewayError || 'API online, módulo sem resposta');
        }
        setDevicesPanelBlocked(false);
        gatewayDebug('Gateway em cache (operável)', { store: storeId, age: formatCacheAge(cached.checkedAt) });
        syncGatewayOverviewStore(storeId, {
          online: cached.online === true,
          apiOnline: cached.apiOnline === true,
          error: storeGatewayError,
          checkedAt: cached.checkedAt,
        });
        applyMachinesToGatewayConfig();
        syncGatewayDeviceLists(pingStatus);
        renderDevices();
        return true;
      }
      storeGatewayError = cached.error || formatStoreGatewayError(storeId, '');
      showStoreGatewayAlert(storeGatewayError);
      updateStoreGatewayMeta('offline');
      setDevicesPanelBlocked(true);
      syncGatewayOverviewStore(storeId, {
        online: false,
        apiOnline: cached.apiOnline === true,
        error: storeGatewayError,
        checkedAt: cached.checkedAt,
      });
      refreshGatewayOverview();
      renderDevices();
      return false;
    }

    showStoreGatewayChecking(true);
    updateStoreGatewayMeta('checking');
    renderDevices();

    try {
      gatewayDebug('Verificando ESP8266', { store: storeId, method: 'POST', path: `${storeId}/verify` });

      const result = await verifyStoreGatewayLed(storeId, panelFetch, { force });
      if (gen !== storeCheckGeneration || normalizeStoreId(storeId) !== currentStore) return false;

      const gatewayOperable = result.online === true || result.apiOnline === true;
      if (gatewayOperable) {
        setStoreGatewayCacheEntry(storeId, {
          online: result.online === true,
          apiOnline: result.apiOnline === true,
          error: result.error || null,
        });
        storeGatewayReady = true;
        storeGatewayError = result.online === true ? null : result.error || null;
        storeGatewayCheckedAt = result.checkedAt || Date.now();
        storeGatewayFromCache = Boolean(result.fromCache);
        if (result.online === true) {
          updateStoreGatewayMeta('online');
          hideStoreGatewayAlert();
        } else {
          showStoreGatewayAlert(
            storeGatewayError || 'Módulo da loja não respondeu — operação via gateway central'
          );
          updateStoreGatewayMeta('online', storeGatewayError || 'API online, módulo sem resposta');
        }
        setDevicesPanelBlocked(false);
        gatewayDebug('Gateway operável (verify)', {
          store: storeId,
          espOnline: result.online,
          apiOnline: result.apiOnline,
          fromCache: result.fromCache,
        });

        syncGatewayOverviewStore(storeId, {
          online: result.online === true,
          apiOnline: result.apiOnline === true,
          error: storeGatewayError,
          checkedAt: result.checkedAt || Date.now(),
        });
        applyMachinesToGatewayConfig();
        syncGatewayDeviceLists(pingStatus);
        refreshGatewayOverview();
        renderDevices();
        return true;
      }

      storeGatewayError = result.error || formatStoreGatewayError(storeId, '');
      storeGatewayCheckedAt = result.checkedAt || Date.now();
      storeGatewayFromCache = Boolean(result.fromCache);
      setStoreGatewayCacheEntry(storeId, { online: false, apiOnline: false, error: storeGatewayError });
      syncGatewayOverviewStore(storeId, {
        online: false,
        error: storeGatewayError,
        checkedAt: result.checkedAt || Date.now(),
      });
      showStoreGatewayAlert(storeGatewayError);
      updateStoreGatewayMeta('offline');
      setDevicesPanelBlocked(true);
      gatewayDebug('ESP8266 offline (verify)', { store: storeId, error: storeGatewayError });
      refreshGatewayOverview();
      return false;
    } catch (err) {
      if (gen !== storeCheckGeneration || normalizeStoreId(storeId) !== currentStore) return false;
      storeGatewayError = formatStoreGatewayError(storeId, err.message);
      storeGatewayCheckedAt = Date.now();
      storeGatewayFromCache = false;
      setStoreGatewayCacheEntry(storeId, { online: false, apiOnline: false, error: storeGatewayError });
      syncGatewayOverviewStore(storeId, {
        online: false,
        error: storeGatewayError,
        checkedAt: Date.now(),
      });
      showStoreGatewayAlert(storeGatewayError);
      updateStoreGatewayMeta('offline');
      setDevicesPanelBlocked(true);
      refreshGatewayOverview();
      return false;
    } finally {
      if (gen === storeCheckGeneration) {
        showStoreGatewayChecking(false);
        renderDevices();
      }
    }
  }

  async function refreshGatewayModule() {
    if (!currentStore || storeGatewayChecking) return;
    const ok = await verifyStoreGateway(currentStore, { force: true });
    showToast(
      ok ? 'Módulo de redundância online' : storeGatewayError || 'Módulo de redundância offline',
      ok
    );
  }

  async function refreshGatewayDevices() {
    if (!currentStore || storeGatewayChecking) return;
    try {
      await startBackgroundDeviceProbes({ force: true });
      if (normalizeStoreId(currentStore) && !probeQueueRunner && probingDevices.size === 0) {
        showToast('Status dos equipamentos atualizado');
      }
    } catch {
      showToast('Falha ao verificar equipamentos', false);
    }
  }

  const GROUP_REFRESH_LABELS = {
    washer: 'Lavadoras',
    dryer: 'Secadoras',
    doser: 'Dosadoras',
    ac: 'Ar condicionado',
  };

  async function refreshGatewayDeviceGroup(deviceType) {
    const dtype = String(deviceType || '').toLowerCase();
    if (!GROUP_REFRESH_LABELS[dtype]) return;
    if (!currentStore || storeGatewayChecking) return;
    if (probingDevices.size > 0 || probeQueueRunner) return;
    try {
      await startBackgroundDeviceProbes({ force: true, deviceTypes: [dtype] });
      if (normalizeStoreId(currentStore) && !probeQueueRunner && probingDevices.size === 0) {
        showToast(`Status · ${GROUP_REFRESH_LABELS[dtype]} atualizado`);
      }
    } catch {
      showToast(`Falha ao verificar ${GROUP_REFRESH_LABELS[dtype].toLowerCase()}`, false);
    }
  }

  let storeStatusBarReady = false;

  function bindStoreStatusBarEvents() {
    if (storeStatusBarReady) return;
    storeStatusBarReady = true;
    $('btnVerifyGatewayModule')?.addEventListener('click', () => {
      void refreshGatewayModule();
    });
    $('btnRefreshGatewayDevices')?.addEventListener('click', () => {
      void refreshGatewayDevices();
    });
    $('devicesPanel')?.addEventListener('click', (e) => {
      const deviceBtn = e.target.closest('[data-refresh-device]');
      if (deviceBtn && !deviceBtn.disabled) {
        const parsed = parseDeviceRefreshKey(deviceBtn.dataset.refreshDevice);
        if (parsed) {
          e.preventDefault();
          void refreshGatewayDevice(parsed.deviceType, parsed.machine);
        }
        return;
      }
      const btn = e.target.closest('[data-refresh-group]');
      if (!btn || btn.disabled) return;
      void refreshGatewayDeviceGroup(btn.dataset.refreshGroup);
    });
  }

  function deviceEndpointPath(deviceType, machine) {
    const build = STATUS_PATHS[deviceType];
    return build ? build(machine) : '';
  }

  function fullGatewayPath(subpath) {
    return currentStore ? `${currentStore}/${subpath.replace(/^\//, '')}` : subpath;
  }

  async function loadGatewayConfig() {
    const res = await panelFetch('/api/gateway/config');
    if (!res.ok) throw new Error('Configuração do gateway indisponível');
    gatewayConfig = await res.json();
    gatewayConfig.washer_dosage_options = WASHER_DOSAGE_OPTIONS;
    gatewayConfig.dryer_minutes = [15, 30, 45];
    gatewayConfig.ac_temperatures = ['18', '22', 'off'];
    gatewayConfig.ac_id = gatewayConfig.ac_id || '110';
    $('tokenAlert').classList.toggle('hidden', Boolean(gatewayConfig.token_configured));
    return gatewayConfig;
  }

  function applyMachinesToGatewayConfig() {
    if (!gatewayConfig || !machinesCatalog.length) return false;
    const dev = devicesFromMachines(machinesCatalog, pingStatus || {});
    gatewayConfig.washers = dev.washers || [];
    gatewayConfig.dryers = dev.dryers || [];
    gatewayConfig.dosers = dev.dosers || [];
    if (dev.ac) gatewayConfig.ac_id = dev.ac;
    return gatewayConfig.washers.length + gatewayConfig.dryers.length + gatewayConfig.dosers.length > 0;
  }

  async function fetchPortalMachinesCatalog(storeId) {
    const sid = normalizeStoreId(storeId);
    if (!sid) return false;
    const urls = [
      `/api/gateway/machines/${encodeURIComponent(sid)}`,
      `/api/gateway/${encodeURIComponent(sid)}/machines`,
      `/api/stores/${encodeURIComponent(sid)}/machines`,
    ];
    for (const url of urls) {
      try {
        const res = await panelFetch(url);
        if (!res.ok) continue;
        const data = await res.json();
        if (Array.isArray(data.machines) && data.machines.length) {
          machinesCatalog = mergeMachinesCatalog(data.machines, machinesCatalog);
          return true;
        }
      } catch {
        /* tenta próxima rota */
      }
    }
    return false;
  }

  function readGatewayError(data, status) {
    if (!data) return `HTTP ${status}`;
    return data.detail || data.error || data.message || `HTTP ${status}`;
  }

  async function gatewayRequest(method, subpath, body, options = {}) {
    if (!currentStore) throw new Error('Selecione uma loja');
    const normalizedPath = subpath.replace(/^\//, '');
    const isStatusRead = method === 'GET' && normalizedPath.startsWith('status/');
    if (!storeGatewayReady && !options.allowWithoutGateway && !isStatusRead) {
      throw new Error(storeGatewayError || 'Gateway da loja não está online');
    }
    const url = `/api/gateway/${encodeURIComponent(currentStore)}/${subpath.replace(/^\//, '')}`;
    const fetchOptions = { method, headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      fetchOptions.headers['Content-Type'] = 'application/json';
      fetchOptions.body = JSON.stringify(body);
    }
    gatewayDebug(`→ ${method} ${fullGatewayPath(subpath)}`, body !== undefined ? { body } : undefined);
    const started = performance.now();
    const res = await panelFetch(url, fetchOptions);
    let data;
    try {
      data = await res.json();
    } catch {
      data = { detail: `HTTP ${res.status}` };
    }
    gatewayDebug(`← ${method} ${fullGatewayPath(subpath)} HTTP ${res.status} (${Math.round(performance.now() - started)}ms)`, data);
    if (!res.ok && !options.allowHttpError) {
      const err = new Error(readGatewayError(data, res.status));
      err.payload = data;
      throw err;
    }
    return { data, ok: res.ok, status: res.status };
  }

  async function checkApiHealth() {
    try {
      const res = await panelFetch('/api/gateway/health');
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      return data;
    } catch {
      return null;
    }
  }

  function resetPingStatus() {
    pingStatus = {
      washers: Object.fromEntries((gatewayConfig?.washers || []).map((id) => [id, null])),
      dryers: Object.fromEntries((gatewayConfig?.dryers || []).map((id) => [id, null])),
      dosers: Object.fromEntries((gatewayConfig?.dosers || []).map((id) => [id, null])),
      ac: null,
    };
  }

  function parseOnlineFlag(value) {
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    if (typeof value === 'string') {
      const n = value.trim().toLowerCase();
      if (n === 'true' || n === 'online' || n === '1') return true;
      if (n === 'false' || n === 'offline' || n === '0') return false;
    }
    return null;
  }

  function extractOnlineFromProbeResult(result) {
    const data = result.data || {};
    const detail = String(data.detail || data.message || '').toLowerCase();
    if (detail.includes('did not respond') || detail.includes('timeout')) {
      return null;
    }

    const status = typeof data.status === 'string' ? data.status.trim().toLowerCase() : '';
    if (status === 'online') return true;
    if (status === 'offline') return false;

    const fromOnline = parseOnlineFlag(data.online);
    if (fromOnline !== null) return fromOnline;

    const upstream = Number(data.upstream_status);
    if (upstream === 200) return true;
    if (upstream >= 400) return false;
    if (result.ok) return true;
    return null;
  }

  function isEspTimeoutResult(result) {
    const data = result?.data || {};
    const detail = String(data.detail || data.message || '').toLowerCase();
    return detail.includes('did not respond') || detail.includes('timeout');
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  const RELEASE_VERIFY_INTERVAL_MS = 1000;

  function deviceProbeKey(deviceType, machine) {
    return machine ? `${deviceType}:${machine}` : deviceType;
  }

  function isDeviceProbing(deviceType, machine) {
    return probingDevices.has(deviceProbeKey(deviceType, machine));
  }

  function updateDeviceStatusPill() {
    renderDevices();
    scheduleDeviceLockTick();
  }

  async function fetchStoreAgentConfig(_sid) {
    return null;
  }

  function applyStoreAgentSettings(_data) {
    /* agente local desativado — listas vêm do catálogo Lav60; online via status/{tipo}/{id} */
  }

  function gatewayNetworkHasProbeData(net) {
    if (!net || typeof net !== 'object') return false;
    return (
      ['washers', 'dryers', 'dosers'].some((key) => Object.keys(net[key] || {}).length > 0) ||
      net.ac === true ||
      net.ac === false
    );
  }

  function networkContextForDevices(network = null) {
    const net = network || pingStatus || gatewayConfig?._agentNetwork || null;
    if (!gatewayNetworkHasProbeData(net)) return null;
    return {
      ...net,
      machines: net.machines || getMachinesCatalog(),
    };
  }

  function mergeAgentDevicesIntoCfg(cfg, networkCtx) {
    const agent = gatewayConfig?._agentDevices;
    if (!agent) return;
    const ctx = {
      machines: cfg.machines || [],
      washers: networkCtx?.washers || pingStatus?.washers || {},
      dryers: networkCtx?.dryers || pingStatus?.dryers || {},
      dosers: networkCtx?.dosers || pingStatus?.dosers || {},
    };
    [
      ['washer', 'washers'],
      ['dryer', 'dryers'],
      ['doser', 'dosers'],
    ].forEach(([dtype, key]) => {
      const merged = new Set((cfg.devices[key] || []).map((id) => normalizeStoreId(id)));
      (agent[key] || []).forEach((id) => {
        const norm = normalizeStoreId(id);
        if (isDeviceRegisteredInCatalog(cfg.machines || [], dtype, norm)) merged.add(norm);
      });
      cfg.devices[key] = [...merged].sort();
    });
    if (agent.ac) cfg.devices.ac = agent.ac;
  }

  function rebuildPingStatusFromConfig() {
    const prev = pingStatus || {};
    const agentNet = gatewayConfig?._agentNetwork || {};
    pingStatus = {
      washers: Object.fromEntries(
        (gatewayConfig?.washers || []).map((id) => [
          id,
          prev.washers?.[id] ?? agentNet.washers?.[id] ?? null,
        ])
      ),
      dryers: Object.fromEntries(
        (gatewayConfig?.dryers || []).map((id) => [
          id,
          prev.dryers?.[id] ?? agentNet.dryers?.[id] ?? null,
        ])
      ),
      dosers: Object.fromEntries(
        (gatewayConfig?.dosers || []).map((id) => [
          id,
          prev.dosers?.[id] ?? agentNet.dosers?.[id] ?? null,
        ])
      ),
      ac: prev.ac ?? agentNet.ac ?? null,
    };
  }

  async function loadMachinesForStore(storeId) {
    const sid = normalizeStoreId(storeId);
    if (!sid) {
      machinesCatalog = [];
      if (gatewayConfig) {
        delete gatewayConfig._agentDevices;
        delete gatewayConfig._agentNetwork;
      }
      return;
    }

    machinesCatalog = [];
    if (gatewayConfig) {
      delete gatewayConfig._agentDevices;
      delete gatewayConfig._agentNetwork;
      gatewayConfig.washers = [];
      gatewayConfig.dryers = [];
      gatewayConfig.dosers = [];
    }

    await fetchPortalMachinesCatalog(sid);
    applyMachinesToGatewayConfig();
  }

  function getMachinesCatalog() {
    return mergeMachinesCatalog(machinesCatalog);
  }

  function syncGatewayDeviceLists(network = null) {
    if (!gatewayConfig) return;
    const machines = getMachinesCatalog();
    const agentDevices = gatewayConfig._agentDevices;
    const cfg = {
      machines,
      devices: agentDevices
        ? {
            washers: [...(agentDevices.washers || [])],
            dryers: [...(agentDevices.dryers || [])],
            dosers: [...(agentDevices.dosers || [])],
            ac: agentDevices.ac || gatewayConfig.ac_id || '110',
          }
        : {
            washers: gatewayConfig.washers || [],
            dryers: gatewayConfig.dryers || [],
            dosers: gatewayConfig.dosers || [],
            ac: gatewayConfig.ac_id || '110',
          },
    };
    const networkCtx = networkContextForDevices(network);
    if (machines.length || networkCtx) {
      syncConfigDevices(cfg, networkCtx || undefined);
    } else {
      syncConfigDevices(cfg, null);
    }
    mergeAgentDevicesIntoCfg(cfg, networkCtx);
    gatewayConfig.washers = cfg.devices.washers || [];
    gatewayConfig.dryers = cfg.devices.dryers || [];
    gatewayConfig.dosers = cfg.devices.dosers || [];
    if (cfg.devices.ac) gatewayConfig.ac_id = cfg.devices.ac;
  }

  function isDeviceCacheStale(cachedPing) {
    if (!cachedPing || !gatewayConfig) return true;
    const keys = (list, prefix) => (list || []).map((id) => `${prefix}:${normalizeStoreId(id)}`);
    const expected = new Set([
      ...keys(gatewayConfig.washers, 'washer'),
      ...keys(gatewayConfig.dryers, 'dryer'),
      ...keys(gatewayConfig.dosers, 'doser'),
    ]);
    if (!expected.size) return false;
    const cached = new Set([
      ...Object.keys(cachedPing.washers || {}).map((id) => `washer:${normalizeStoreId(id)}`),
      ...Object.keys(cachedPing.dryers || {}).map((id) => `dryer:${normalizeStoreId(id)}`),
      ...Object.keys(cachedPing.dosers || {}).map((id) => `doser:${normalizeStoreId(id)}`),
    ]);
    for (const key of expected) {
      if (!cached.has(key)) return true;
    }
    return false;
  }

  function getMachineMeta(id, type) {
    return findMachineMeta(getMachinesCatalog(), id, type);
  }

  function setSectionCount(elementId, map) {
    Lav60DeviceUI.setSectionCount($(elementId), map);
  }

  function gatewayNetworkContext() {
    return {
      machines: getMachinesCatalog(),
      washers: pingStatus?.washers || {},
      dryers: pingStatus?.dryers || {},
      dosers: pingStatus?.dosers || {},
    };
  }

  function visibleDeviceIds(deviceType, ids) {
    const catalog = getMachinesCatalog();
    if (!catalog.length) return ids || [];
    // GET02: exibir todo equipamento cadastrado na API Lav60; online/offline fica no card (↻).
    return (ids || []).filter((id) => isDeviceRegisteredInCatalog(catalog, deviceType, id));
  }

  function deviceOnline(deviceType, id) {
    if (isDeviceProbing(deviceType, id)) return null;
    if (deviceType === 'ac') return pingStatus?.ac ?? null;
    return pingStatus?.[`${deviceType}s`]?.[id] ?? null;
  }

  function loadDryerLocksFromStorage() {
    try {
      const all = JSON.parse(localStorage.getItem(DRYER_LOCK_STORAGE_KEY) || '{}');
      return all[currentStore] || {};
    } catch {
      return {};
    }
  }

  function saveDryerLocksToStorage() {
    try {
      const all = JSON.parse(localStorage.getItem(DRYER_LOCK_STORAGE_KEY) || '{}');
      all[currentStore] = dryerLocks;
      localStorage.setItem(DRYER_LOCK_STORAGE_KEY, JSON.stringify(all));
    } catch {
      /* ignore */
    }
  }

  function loadWasherLocksFromStorage() {
    try {
      const all = JSON.parse(localStorage.getItem(WASHER_LOCK_STORAGE_KEY) || '{}');
      return all[currentStore] || {};
    } catch {
      return {};
    }
  }

  function saveWasherLocksToStorage() {
    try {
      const all = JSON.parse(localStorage.getItem(WASHER_LOCK_STORAGE_KEY) || '{}');
      all[currentStore] = washerLocks;
      localStorage.setItem(WASHER_LOCK_STORAGE_KEY, JSON.stringify(all));
    } catch {
      /* ignore */
    }
  }

  function formatLockRemaining(ms) {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min >= 1 && sec > 0) return `${min} min ${sec} s`;
    if (min >= 1) return `${min} min`;
    return `${sec} s`;
  }

  function getDryerLockRemainingMs(dryerId) {
    const unlockAt = dryerLocks[String(dryerId)];
    if (!unlockAt) return 0;
    const remaining = unlockAt - Date.now();
    if (remaining <= 0) {
      delete dryerLocks[String(dryerId)];
      saveDryerLocksToStorage();
      return 0;
    }
    return remaining;
  }

  function setDryerLock(dryerId, minutes) {
    dryerLocks[String(dryerId)] = Date.now() + (Number(minutes) || 15) * 60 * 1000;
    saveDryerLocksToStorage();
    const card = document.querySelector(`.device-card[data-dryer-id="${dryerId}"]`);
    if (card) applyDryerLockUI(card, dryerId);
    scheduleDeviceLockTick();
  }

  function clearDryerLock(dryerId) {
    delete dryerLocks[String(dryerId)];
    saveDryerLocksToStorage();
    const card = document.querySelector(`.device-card[data-dryer-id="${dryerId}"]`);
    if (card) applyDryerLockUI(card, dryerId);
    scheduleDeviceLockTick();
    logGatewayAudit({
      action: 'dryer_unlock',
      label: `Reativar botões · secadora ${dryerId}`,
      method: 'UI',
      success: true,
      device_type: 'dryer',
      device_id: String(dryerId),
    });
  }

  function getWasherLockRemainingMs(washerId) {
    const unlockAt = washerLocks[String(washerId)];
    if (!unlockAt) return 0;
    const remaining = unlockAt - Date.now();
    if (remaining <= 0) {
      delete washerLocks[String(washerId)];
      saveWasherLocksToStorage();
      return 0;
    }
    return remaining;
  }

  function getWasherLockMinutes(meta) {
    const mins = Number(meta?.waiting_minutes);
    if (Number.isFinite(mins) && mins > 0) return mins;
    return 45;
  }

  function setWasherLock(washerId, minutes) {
    washerLocks[String(washerId)] = Date.now() + (Number(minutes) || 45) * 60 * 1000;
    saveWasherLocksToStorage();
    const card = document.querySelector(`.device-card[data-washer-id="${washerId}"]`);
    if (card) applyWasherLockUI(card, washerId);
    scheduleDeviceLockTick();
  }

  function clearWasherLock(washerId) {
    delete washerLocks[String(washerId)];
    saveWasherLocksToStorage();
    const card = document.querySelector(`.device-card[data-washer-id="${washerId}"]`);
    if (card) applyWasherLockUI(card, washerId);
    scheduleDeviceLockTick();
    logGatewayAudit({
      action: 'washer_unlock',
      label: `Reativar botões · lavadora ${washerId}`,
      method: 'UI',
      success: true,
      device_type: 'washer',
      device_id: String(washerId),
    });
  }

  function initDeviceLocks() {
    if (!currentStore) return;
    dryerLocks = loadDryerLocksFromStorage();
    washerLocks = loadWasherLocksFromStorage();
    scheduleDeviceLockTick();
  }

  function scheduleDeviceLockTick() {
    if (deviceLockTimer) {
      clearInterval(deviceLockTimer);
      deviceLockTimer = null;
    }
    if (!Object.keys(dryerLocks).length && !Object.keys(washerLocks).length) return;
    deviceLockTimer = setInterval(() => {
      Object.keys(dryerLocks).forEach((id) => {
        const card = document.querySelector(`.device-card[data-dryer-id="${id}"]`);
        if (card) applyDryerLockUI(card, id);
      });
      Object.keys(washerLocks).forEach((id) => {
        const card = document.querySelector(`.device-card[data-washer-id="${id}"]`);
        if (card) applyWasherLockUI(card, id);
      });
    }, 1000);
  }

  function syncDryerCardControls(card, meta, online) {
    const dryerId = card.dataset.dryerId;
    const remaining = getDryerLockRemainingMs(dryerId);
    const statusEl = card.querySelector('.device-card__cycle-status');
    const unlockBtn = card.querySelector('.device-card__unlock');
    const releaseBtn = card.querySelector('button[data-dryer-release]');
    const choiceButtons = card.querySelectorAll('.device-card__choice');
    const operable = online === true && canOperateMachine(meta, true);

    if (remaining) {
      card.classList.add('device-card--busy');
      if (statusEl) statusEl.textContent = `Em secagem · ${formatLockRemaining(remaining)}`;
      if (releaseBtn) releaseBtn.disabled = true;
      choiceButtons.forEach((b) => { b.disabled = true; });
      unlockBtn?.classList.remove('device-card__unlock--hidden');
      return true;
    }

    card.classList.remove('device-card--busy');
    if (statusEl) {
      statusEl.textContent = operable
        ? ''
        : online === null
          ? 'Aguardando'
          : deviceUnifiedStatus(online, meta).label;
    }
    if (releaseBtn) {
      const hasChoice = Array.from(choiceButtons).some((b) => b.classList.contains('device-card__choice--active'));
      releaseBtn.disabled = !operable || !hasChoice;
    }
    choiceButtons.forEach((b) => { b.disabled = !operable; });
    unlockBtn?.classList.add('device-card__unlock--hidden');
    return false;
  }

  function applyDryerLockUI(card, dryerId) {
    syncDryerCardControls(card, getMachineMeta(dryerId, 'dryer'), deviceOnline('dryer', dryerId));
  }

  function syncWasherCardControls(card, meta, online) {
    const washerId = card.dataset.washerId;
    const remaining = getWasherLockRemainingMs(washerId);
    const statusEl = card.querySelector('.device-card__cycle-status');
    const unlockBtn = card.querySelector('.device-card__unlock');
    const releaseBtn = card.querySelector('button[data-washer-release]');
    const choiceButtons = card.querySelectorAll('.device-card__choice');
    const operable = online === true && canOperateMachineStatus(meta?.status);

    if (remaining) {
      card.classList.add('device-card--busy');
      if (statusEl) statusEl.textContent = `Em lavagem · ${formatLockRemaining(remaining)}`;
      if (releaseBtn) releaseBtn.disabled = true;
      choiceButtons.forEach((b) => { b.disabled = true; });
      unlockBtn?.classList.remove('device-card__unlock--hidden');
      return;
    }

    card.classList.remove('device-card--busy');
    if (statusEl) statusEl.textContent = operable ? '' : deviceStatusHint({ online: online === true, operable, statusInfo: { label: meta?.status_label || 'Indisponível' } });
    if (releaseBtn) {
      const hasChoice = Array.from(choiceButtons).some((b) => b.classList.contains('device-card__choice--active'));
      releaseBtn.disabled = !operable || !hasChoice;
    }
    choiceButtons.forEach((b) => { b.disabled = !operable; });
    unlockBtn?.classList.add('device-card__unlock--hidden');
  }

  function applyWasherLockUI(card, washerId) {
    syncWasherCardControls(card, getMachineMeta(washerId, 'washer'), deviceOnline('washer', washerId));
  }

  function devicePingLabel(deviceType, machine) {
    const names = { washer: 'Lavadora', dryer: 'Secadora', doser: 'Dosadora', ac: 'AC' };
    const name = names[deviceType] || deviceType;
    return machine ? `${name} ${machine}` : name;
  }

  function setDeviceOnlineState(deviceType, machine, online) {
    if (!pingStatus) resetPingStatus();
    if (online !== true && online !== false) return;
    if (deviceType === 'ac') pingStatus.ac = online;
    else pingStatus[`${deviceType}s`][machine] = online;
  }

  async function probeDeviceOnline(deviceType, machine, options = {}) {
    const { silent = false, generation = probeGeneration, ignoreGeneration = false } = options;
    if (!currentStore) return;
    const path = deviceEndpointPath(deviceType, machine);
    if (!path) return;

    const key = deviceProbeKey(deviceType, machine);
    const label = devicePingLabel(deviceType, machine);
    probingDevices.add(key);
    updateDeviceStatusPill();
    renderDevices();

    let resolved = null;

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!ignoreGeneration && generation !== probeGeneration) return;

        const result = await gatewayRequest('GET', path, undefined, { allowHttpError: true });
        if (!ignoreGeneration && generation !== probeGeneration) return;

        const online = extractOnlineFromProbeResult(result);
        if (online === true || online === false) {
          resolved = online;
          setDeviceOnlineState(deviceType, machine, online);
          if (!silent) {
            appendLog(`Ping ${label}`, online === true, {
              path: fullGatewayPath(path),
              ...result.data,
              online,
            });
          }
          break;
        }

        if (attempt === 0 && isEspTimeoutResult(result)) {
          gatewayDebug(`Retry ${label} após timeout ESP8266`);
          await sleep(400);
          continue;
        }

        if (!silent) {
          appendLog(`Ping ${label}`, false, { path: fullGatewayPath(path), ...result.data });
        }
        break;
      }

      if (!silent && resolved === true) showToast(`${label} — online`);
      else if (!silent && resolved === false) showToast(`${label} — offline`, false);
    } catch (err) {
      if (!ignoreGeneration && generation !== probeGeneration) return;
      if (!silent) {
        showToast(`Ping ${label}: ${friendlyUserMessage(err.message)}`, false);
        appendLog(`Ping ${label}`, false, err.payload || err.message);
      }
    } finally {
      probingDevices.delete(key);
      if (!ignoreGeneration && generation !== probeGeneration) return;
      updateDeviceStatusPill();
      if (currentStore && pingStatus) {
        syncGatewayDeviceLists(pingStatus);
        setStoreDevicesEntry(currentStore, pingStatus);
      }
      renderDevices();
      updateStoreStatusButtons();
    }
  }

  function collectDeviceProbeJobs(deviceTypes = null) {
    const allowed = Array.isArray(deviceTypes) && deviceTypes.length
      ? new Set(deviceTypes.map((t) => String(t || '').toLowerCase()))
      : null;
    const include = (type) => !allowed || allowed.has(type);
    const jobs = [];
    if (include('washer')) {
      (gatewayConfig?.washers || []).forEach((id) => jobs.push({ deviceType: 'washer', machine: id }));
    }
    if (include('dryer')) {
      (gatewayConfig?.dryers || []).forEach((id) => jobs.push({ deviceType: 'dryer', machine: id }));
    }
    if (include('doser')) {
      (gatewayConfig?.dosers || []).forEach((id) => jobs.push({ deviceType: 'doser', machine: id }));
    }
    if (include('ac')) {
      jobs.push({ deviceType: 'ac', machine: null });
    }
    return jobs;
  }

  async function runProbeQueue(generation, jobs) {
    if (probeQueueRunner) {
      await probeQueueRunner.catch(() => {});
    }

    const queue = Array.isArray(jobs) ? jobs : collectDeviceProbeJobs();
    const groups = new Set(queue.map((job) => job.deviceType));
    probeQueueRunner = (async () => {
      const batchSize = 4;
      for (let i = 0; i < queue.length; i += batchSize) {
        if (generation !== probeGeneration) return;
        const batch = queue.slice(i, i + batchSize);
        await Promise.all(
          batch.map(({ deviceType, machine }) =>
            probeDeviceOnline(deviceType, machine, { silent: true, generation })
          )
        );
      }
    })();

    try {
      await probeQueueRunner;
      if (generation === probeGeneration && currentStore && pingStatus) {
        syncGatewayDeviceLists(pingStatus);
        setStoreDevicesEntry(currentStore, pingStatus);
        renderDevices();
      }
    } catch {
      /* fila cancelada ao trocar loja */
    } finally {
      groups.forEach((g) => activeProbeGroups.delete(g));
      if (probeQueueRunner && generation === probeGeneration) {
        probeQueueRunner = null;
      }
      if (generation === probeGeneration) {
        updateStoreStatusButtons();
      }
    }
  }

  function startBackgroundDeviceProbes({ force = false, deviceTypes = null } = {}) {
    if (!currentStore || !gatewayConfig) return Promise.resolve();
    const jobs = collectDeviceProbeJobs(deviceTypes);
    if (!jobs.length) return Promise.resolve();

    const scoped = Array.isArray(deviceTypes) && deviceTypes.length > 0;
    const cached = getStoreDevicesEntry(currentStore);
    const cacheStale = isDeviceCacheStale(cached?.pingStatus);
    if (!force && !scoped && !cacheStale && cached?.pingStatus && isCacheFresh(cached.checkedAt, DEVICES_TTL_MS)) {
      pingStatus = clonePingStatus(cached.pingStatus);
      renderDevices();
      gatewayDebug('Equipamentos em cache', {
        store: currentStore,
        age: formatCacheAge(cached.checkedAt),
      });
      return Promise.resolve();
    }

    probeGeneration += 1;
    const generation = probeGeneration;
    if (!scoped) probingDevices.clear();
    jobs.forEach((job) => activeProbeGroups.add(job.deviceType));
    rebuildPingStatusFromConfig();
    renderDevices();
    updateStoreStatusButtons();
    return runProbeQueue(generation, jobs);
  }

  async function verifyGatewayDeviceRelease(deviceType, deviceId, options = {}) {
    const dtype = String(deviceType || '').toLowerCase();
    const id = normalizeStoreId(deviceId);
    if (!id || (dtype !== 'washer' && dtype !== 'dryer')) return null;

    if (options.postData && agentPostConfirmsFirstRelease(options.postData)) {
      return {
        ...options.postData,
        release_verified: true,
        release_confirm_source: 'agent_first_pulse',
      };
    }

    const devicePath = `status/${dtype}/${id}`;
    let initialDelay = Number(options.initialDelayMs);
    if (!Number.isFinite(initialDelay) || initialDelay < 0) {
      initialDelay = dtype === 'dryer' ? dryerReleaseVerifyDelayMs(options.minutes) : 500;
    }
    if (initialDelay > 0) await sleep(initialDelay);

    for (let attempt = 0; attempt < 15; attempt += 1) {
      if (attempt > 0) await sleep(RELEASE_VERIFY_INTERVAL_MS);

      const result = await gatewayRequest('GET', devicePath, undefined, { allowHttpError: true });
      if (
        agentStatusPayloadIndicatesRelease(result.data) ||
        machineListEntryIndicatesRelease(result.data?.machines, dtype, id)
      ) {
        return { ...result.data, release_verified: true };
      }
      const fail = agentOperationFailureMessage(result.data);
      if (fail) throw new Error(fail);
    }

    if (options.postData && agentPostExplicitlyReleased(options.postData)) {
      return { ...options.postData, release_verified: true, release_confirm_source: 'agent_post' };
    }

    const label = dtype === 'dryer' ? 'secadora' : 'lavadora';
    throw new Error(
      `Liberação não confirmada — a ${label} ${id.toUpperCase()} não indicou ciclo iniciado. Verifique na loja antes de tentar de novo.`
    );
  }

  async function runGatewayAction(label, subpath, method = 'POST', body, options = {}) {
    const result = await gatewayRequest(method, subpath, body);
    if (!result.ok) {
      const err = new Error(readGatewayError(result.data, result.status));
      err.payload = result.data;
      throw err;
    }

    const kind = options.operationKind || null;
    if (kind && kind.includes('release')) {
      const fail = agentOperationFailureMessage(result.data);
      if (fail) throw new Error(fail);

      const match = String(subpath).match(/^(washer|dryer)\/([^/?#]+)/i);
      if (agentPostConfirmsFirstRelease(result.data)) {
        return {
          ...result.data,
          release_verified: true,
          release_confirm_source: 'agent_first_pulse',
          machine: result.data.machine || (match ? match[2] : undefined),
          minutes: result.data.minutes ?? body?.minutes,
          _httpStatus: 200,
        };
      }

      if (options.verifyRelease !== false) {
        if (match) {
          const verified = await verifyGatewayDeviceRelease(match[1], match[2], {
            minutes: body?.minutes,
            postData: result.data,
          });
          return { ...result.data, ...(verified || {}), release_verified: true };
        }
      }
    }

    return result.data;
  }

  function shouldRefreshDevicesAfterAction(_audit) {
    // Liberações não invalidam o ping já carregado; re-scan zera todos os cards.
    return false;
  }

  function buildGatewayAudit(fields) {
    const base = {
      store: currentStore,
      page: 'gateway',
      ...fields,
    };
    return window.Lav60Audit?.buildEntry ? Lav60Audit.buildEntry(base) : base;
  }

  async function logGatewayAudit(fields) {
    if (!window.Lav60Audit) return false;
    return Lav60Audit.log(buildGatewayAudit(fields));
  }

  async function runAction(label, fn, audit = null) {
    if (actionBusy) return;
    if (!storeSelected()) {
      showToast(storeGatewayError || 'Gateway da loja não está online', false);
      return;
    }
    const ok = await confirmAction(audit?.confirmMessage, audit?.confirmRows || [], {
      heading: audit?.confirmHeading || 'Confirmar operação',
    });
    if (!ok) return;
    actionBusy = true;
    try {
      const data = await fn();
      showActionConfirm(label, data);
      await logGatewayAudit({
        action: audit?.action || 'operation',
        label: audit?.label || label,
        method: audit?.method || 'POST',
        path: audit?.path || null,
        success: true,
        payload: audit?.payload || null,
        response: data,
        device_type: audit?.device_type || null,
        device_id: audit?.device_id || null,
        meta: audit?.meta || null,
      });
      if (shouldRefreshDevicesAfterAction(audit)) {
        void startBackgroundDeviceProbes({ force: true });
      }
    } catch (e) {
      await logGatewayAudit({
        action: audit?.action || 'operation',
        label: audit?.label || label,
        method: audit?.method || 'POST',
        path: audit?.path || null,
        success: false,
        payload: audit?.payload || null,
        error: e?.message || String(e),
        device_type: audit?.device_type || null,
        device_id: audit?.device_id || null,
        meta: audit?.meta || null,
      });
      showToast(formatOperatorError(label, e.message), false);
    } finally {
      actionBusy = false;
    }
  }

  async function runDryerRelease(id, minutes) {
    if (minutes == null || Number.isNaN(minutes)) return;
    const ok = await confirmAction(null, [
      ['Equipamento', `Secadora ${id}`],
      ['Tempo', `${minutes} min`],
    ], { heading: 'Confirmar liberação' });
    if (!ok) return;
    try {
      const data = await runGatewayAction(`Secadora ${id}`, `dryer/${id}`, 'POST', { minutes: Number(minutes) }, {
        operationKind: 'dryer_release',
        verifyRelease: true,
      });
      setDryerLock(id, data.minutes ?? minutes);
      showActionConfirm(`Secadora ${id}`, data);
      await logGatewayAudit({
        action: 'dryer_release',
        label: `Secadora ${id} · ${minutes} min`,
        method: 'POST',
        path: `/dryer/${id}`,
        success: true,
        payload: { minutes },
        response: data,
        device_type: 'dryer',
        device_id: String(id),
      });
    } catch (e) {
      await logGatewayAudit({
        action: 'dryer_release',
        label: `Secadora ${id} · ${minutes} min`,
        method: 'POST',
        path: `/dryer/${id}`,
        success: false,
        payload: { minutes },
        error: e?.message || String(e),
        device_type: 'dryer',
        device_id: String(id),
      });
      showActionError(`Secadora ${id}`, formatOperatorError(`Secadora ${id}`, e.message), [
        ['Equipamento', `Secadora ${id}`],
        ['Tempo', `${minutes} min`],
      ]);
      void startBackgroundDeviceProbes({ force: true });
    }
  }

  async function runWasherRelease(id, amValue) {
    const am = typeof amValue === 'string' ? amValue : '';
    const amLabel = am ? dosageLabel(am) : 'Sem cheiro';
    const ok = await confirmAction(null, [
      ['Equipamento', `Lavadora ${id}`],
      ['Dosagem', amLabel],
    ], { heading: 'Confirmar liberação' });
    if (!ok) return;
    try {
      const data = await runGatewayAction(`Lavadora ${id}`, `washer/${id}`, 'POST', am ? { am } : {}, {
        operationKind: 'washer_release',
        verifyRelease: true,
      });
      setWasherLock(id, getWasherLockMinutes(getMachineMeta(id, 'washer')));
      showActionConfirm(`Lavadora ${id}`, data);
      await logGatewayAudit({
        action: 'washer_release',
        label: `Lavadora ${id}`,
        method: 'POST',
        path: `/washer/${id}`,
        success: true,
        payload: am ? { am } : {},
        response: data,
        device_type: 'washer',
        device_id: String(id),
      });
    } catch (e) {
      await logGatewayAudit({
        action: 'washer_release',
        label: `Lavadora ${id}`,
        method: 'POST',
        path: `/washer/${id}`,
        success: false,
        payload: am ? { am } : {},
        error: e?.message || String(e),
        device_type: 'washer',
        device_id: String(id),
      });
      showActionError(`Lavadora ${id}`, formatOperatorError(`Lavadora ${id}`, e.message), [
        ['Equipamento', `Lavadora ${id}`],
      ]);
      void startBackgroundDeviceProbes({ force: true });
    }
  }

  const doserCardApi = {
    runDoserCommand: (id, type) =>
      runGatewayAction(`Dosadora ${id}`, `doser/${id}`, 'POST', { type }).then((data) => ({
        ...data,
        type,
        machine: data.machine || id,
      })),
    runDoserConsult: (id) =>
      runGatewayAction(`Consulta ${id}`, `doser/${id}/consulta`, 'GET').then((data) => ({
        ...data,
        machine: data.machine || id,
      })),
    runDoserSetTime: (id, kind, seconds) =>
      runGatewayAction(`Ajuste ${id}`, `doser/${id}/settime/${kind}`, 'POST', { seconds }).then((data) => ({
        ...data,
        machine: data.machine || id,
        seconds,
      })),
  };

  function renderWashers() {
    const grid = $('washersGrid');
    grid.innerHTML = '';
    if (!gatewayConfig) return;
    setSectionCount('washersCount', pingStatus?.washers);
    visibleDeviceIds('washer', gatewayConfig.washers).forEach((id) => {
      const online = deviceOnline('washer', id);
      const meta = getMachineMeta(id, 'washer');
      const card = createDeviceCard(
        id,
        online,
        (actions, _card, ctx) => {
          actions.classList.add('device-card__actions--washer');
          const statusEl = document.createElement('p');
          statusEl.className = 'device-card__cycle-status';
          statusEl.setAttribute('aria-live', 'polite');
          actions.appendChild(statusEl);

          const dosageOptions = (gatewayConfig.washer_dosage_options || WASHER_DOSAGE_OPTIONS).map((o) => ({ ...o }));
          const picker = createChoicePicker(dosageOptions, { columns: 2, requireSelection: true });
          if (!ctx.operable) picker.setDisabled(true);
          actions.appendChild(picker.root);

          const releaseBtn = appendReleaseButton(actions, {
            dataset: { washerRelease: '1' },
            disabled: true,
            onRelease: () => {
              if (!picker.hasSelection()) return;
              runWasherRelease(id, picker.getValue());
            },
          });
          syncReleaseButtonWithPicker(releaseBtn, picker, ctx.operable);

          const unlockBtn = btn('Ativar botões', 'btn--ghost device-card__unlock', () => clearWasherLock(id));
          unlockBtn.classList.add('device-card__unlock--hidden');
          actions.appendChild(unlockBtn);

          const hint = deviceStatusHint(ctx);
          if (hint) statusEl.textContent = hint;
        },
        meta,
        deviceCardRefreshOptions('washer', id)
      );
      card.dataset.washerId = id;
      grid.appendChild(card);
      if (online === true) syncWasherCardControls(card, meta, online);
    });
  }

  function renderDryers() {
    const grid = $('dryersGrid');
    grid.innerHTML = '';
    if (!gatewayConfig) return;
    setSectionCount('dryersCount', pingStatus?.dryers);
    const defaultMinutes = gatewayConfig.dryer_minutes || [15, 30, 45];
    visibleDeviceIds('dryer', gatewayConfig.dryers).forEach((id) => {
      const online = deviceOnline('dryer', id);
      const meta = getMachineMeta(id, 'dryer');
      const card = createDeviceCard(
        id,
        online,
        (actions, _card, ctx) => {
          actions.classList.add('device-card__actions--dryer');
          const statusEl = document.createElement('p');
          statusEl.className = 'device-card__cycle-status';
          statusEl.setAttribute('aria-live', 'polite');
          actions.appendChild(statusEl);

          const minuteOptions = dryerMinuteChoices(meta, defaultMinutes);
          const picker = createChoicePicker(minuteOptions, {
            columns: dryerChoicePickerColumns(meta),
            requireSelection: dryerChoiceRequireSelection(meta),
          });
          if (!ctx.operable) picker.setDisabled(true);
          actions.appendChild(picker.root);

          const releaseBtn = appendReleaseButton(actions, {
            dataset: { dryerRelease: '1' },
            disabled: true,
            onRelease: () => {
              if (!picker.hasSelection()) return;
              runDryerRelease(id, Number(picker.getValue()));
            },
          });
          syncReleaseButtonWithPicker(releaseBtn, picker, ctx.operable);

          const unlockBtn = btn('Ativar botões', 'btn--ghost device-card__unlock', () => clearDryerLock(id));
          unlockBtn.classList.add('device-card__unlock--hidden');
          actions.appendChild(unlockBtn);

          const hint = deviceStatusHint(ctx);
          if (hint) statusEl.textContent = hint;
        },
        meta,
        deviceCardRefreshOptions('dryer', id)
      );
      card.dataset.dryerId = id;
      grid.appendChild(card);
      if (online !== null) syncDryerCardControls(card, meta, online);
    });
  }

  function renderDosers() {
    const grid = $('dosersGrid');
    grid.innerHTML = '';
    if (!gatewayConfig) return;
    setSectionCount('dosersCount', pingStatus?.dosers);
    visibleDeviceIds('doser', gatewayConfig.dosers).forEach((id) => {
      const catalog = getMachinesCatalog();
      const meta = enrichDoserMeta(getMachineMeta(id, 'doser'), id, catalog);
      const online = deviceOnline('doser', id);
      const card = createDeviceCard(
        id,
        online,
        (actions, _card, ctx) => buildDoserCardContent(actions, id, ctx, runAction, doserCardApi),
        meta,
        deviceCardRefreshOptions('doser', id)
      );
      card.classList.add('device-card--doser');
      card.dataset.doserId = id;
      grid.appendChild(card);
    });
  }

  function renderAc() {
    const grid = $('acGrid');
    grid.innerHTML = '';
    if (!gatewayConfig) return;
    const temps = ['18', '22', 'off'];
    gatewayConfig.ac_temperatures = temps;
    const online = deviceOnline('ac', null);
    const meta = getMachineMeta('110', 'ac') || { machine_type_label: 'Ar-condicionado' };

    const card = createDeviceCard(
      'AC',
      online,
      (actions, _card, ctx) => {
        actions.classList.add('device-card__actions--ac');
        const tempOptions = temps.map((temp) => ({
          value: temp,
          label: temp === 'off' ? 'Desligar' : `${temp}°C`,
        }));
        const picker = createChoicePicker(tempOptions, { columns: 3, requireSelection: true });
        if (!ctx.operable) picker.setDisabled(true);
        actions.appendChild(picker.root);

        const releaseBtn = appendReleaseButton(actions, {
          label: 'Acionar',
          disabled: true,
          onRelease: () => {
            if (!picker.hasSelection()) return;
            const temp = picker.getValue();
            const tempLabel = temp === 'off' ? 'Desligar' : `${temp}°C`;
            runAction(
              `Ar-condicionado · ${tempLabel}`,
              () => runGatewayAction(`AC · ${tempLabel}`, 'ac', 'POST', { temperature: temp }),
              {
                action: 'ac_control',
                label: `AC · ${tempLabel}`,
                confirmHeading: 'Confirmar acionamento',
                confirmRows: [
                  ['Equipamento', 'Ar-condicionado'],
                  ['Ação', tempLabel],
                ],
                method: 'POST',
                path: 'ac',
                payload: { temperature: temp },
                device_type: 'ac',
                device_id: '110',
              }
            );
          },
        });
        syncReleaseButtonWithPicker(releaseBtn, picker, ctx.operable);
      },
      meta,
      deviceCardRefreshOptions('ac', null)
    );
    grid.appendChild(card);
  }

  function renderDevices() {
    if (!gatewayConfig) return;
    renderWashers();
    renderDryers();
    renderDosers();
    renderAc();
    scheduleDeviceLockTick();
  }

  function updateDevicesPanelVisibility() {
    $('devicesPanel')?.classList.toggle('hidden', !currentStore);
  }

  function syncStorePageClass() {
    document.body.classList.toggle('page-store', Boolean(currentStore));
  }

  function syncHubPanelVisibility() {
    const showHub = !currentStore && !get02PanelDisabled;
    $('agentPageHub')?.classList.toggle('hidden', !showHub);
    $('agentStoreMode')?.classList.toggle('hidden', !currentStore);
    syncStorePageClass();
  }

  function updateStoreStatusBarVisibility() {
    $('storeStatusBar')?.classList.toggle('hidden', !currentStore);
    syncHubPanelVisibility();
  }

  function updateGet02DisabledAlert(catalogData, gatewayCfg) {
    get02PanelDisabled =
      catalogData?.mqtt_gateway_enabled === false || !gatewayCfg?.token_configured;
    $('get02DisabledAlert')?.classList.toggle('hidden', !get02PanelDisabled);
    syncHubPanelVisibility();
  }

  async function applyStore(next) {
    next = normalizeStoreId(next);
    probeGeneration += 1;
    storeCheckGeneration += 1;
    storeGatewayReady = false;
    storeGatewayError = null;
    storeGatewayCheckedAt = null;
    storeGatewayFromCache = false;
    probingDevices.clear();
    activeProbeGroups.clear();

    if (!next) {
      currentStore = '';
      hideStoreGatewayAlert();
      showStoreGatewayChecking(false);
      updateStoreGatewayMeta(null);
      setDevicesPanelBlocked(true);
      resetPingStatus();
      updateDevicesPanelVisibility();
      updateStoreStatusBarVisibility();
      refreshGatewayOverview();
      renderDevices();
      const url = new URL(window.location.href);
      url.searchParams.delete('store');
      window.history.replaceState({}, '', url);
      return;
    }

    currentStore = next;
    const url = new URL(window.location.href);
    url.searchParams.set('store', next);
    window.history.replaceState({}, '', url);
    await loadMachinesForStore(next);
    syncGatewayDeviceLists();
    resetPingStatus();
    initDeviceLocks();
    updateDevicesPanelVisibility();
    updateStoreStatusBarVisibility();
    setDevicesPanelBlocked(false);
    storeGatewayReady = true;
    storeGatewayError = null;
    hideStoreGatewayAlert();
    showStoreGatewayChecking(false);
    updateStoreGatewayMeta('waiting');
    renderDevices();
    updateStoreStatusButtons();
    gatewayDebug('Loja selecionada — aguardando verificação MQTT por equipamento', { store: currentStore });
  }

  async function init() {
    // No SPA, autenticação já tratada pelo router.js boot().
    if (!document.getElementById('appView')) {
      const ok = await guardPage({ returnPath: `gateway.html${window.location.search}` });
      if (!ok) return;
    }
    window.Lav60AgentNav?.render?.('get02');
    bindConfirmEvents();
    bindStoreStatusBarEvents();
    if ($('headerUserMenu')) await mountUserMenu($('headerUserMenu'));

    if (window.Lav60Audit) {
      await Lav60Audit.refreshStatus();
    }

    try {
      await loadGatewayConfig();
      catalog = await loadCatalog();
      updateGet02DisabledAlert(catalog, gatewayConfig);
      resetPingStatus();
      setDevicesPanelBlocked(true);
      updateDevicesPanelVisibility();
      updateStoreStatusBarVisibility();
      renderDevices();

      const initial = normalizeStoreId(new URLSearchParams(window.location.search).get('store'));
      window.Lav60GatewayOverview?.mount({
        fetchFn: panelFetch,
        getStores: () => catalog?.stores || [],
        onStoreAction: (sid) => {
          void applyStore(sid);
        },
        onStoresUpdated: () => refreshGet02HubList(),
        probeActiveOnMount: false,
      });
      mountGet02HubList();
      if (initial) {
        void Lav60GatewayOverview?.probeStore?.(initial, { force: false });
        void applyStore(initial);
      } else {
        Lav60GatewayOverview?.refreshFromCache?.({ fetchServer: false });
      }
    } catch (err) {
      showToast(err.message, false);
    }

    checkApiHealth().catch(() => {});
  }

  function destroy() {
    get02HubList = null;
    document.body.classList.remove('page-store');
  }

  // No SPA: exposto para o router chamar via Lav60AgentGet02Page.init()
  // Em standalone: auto-executa imediatamente
  if (document.getElementById('appView')) {
    window.Lav60AgentGet02Page = {
      init: () => init().catch((err) => {
        document.body.classList.remove('auth-pending');
        showToast(err.message || 'Erro ao iniciar', false);
      }),
      destroy,
    };
  } else {
    init().catch((err) => {
      document.body.classList.remove('auth-pending');
      showToast(err.message || 'Erro ao iniciar', false);
    });
  }
})();
