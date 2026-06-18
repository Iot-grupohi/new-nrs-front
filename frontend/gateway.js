(() => {
  'use strict';

  const {
    loadCatalog,
    friendlyUserMessage,
    formatOperatorError,
    WASHER_DOSAGE_OPTIONS,
    findMachineMeta,
    mergeMachinesCatalog,
    getCachedStoreEntry,
    fetchStoreStatusFromHeartbeat,
    canOperateMachineStatus,
    isDeviceVisibleInFrontend,
  } = window.Lav60;
  const { guardPage, mountUserMenu, panelFetch } = window.Lav60Auth;

  const $ = (id) => document.getElementById(id);

  const confirmUI = Lav60DeviceUI.createConfirmUI({
    $,
    onToast: (message, ok = true) => showToast(message, ok),
  });
  const { confirmAction, showActionConfirm, bindConfirmEvents } = confirmUI;

  const {
    createDeviceCard,
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
  let storeGatewayReady = false;
  let storeGatewayError = null;
  let storeCheckGeneration = 0;
  let pingStatus = null;
  let actionBusy = false;
  let deviceLockTimer = null;
  let dryerLocks = {};
  let washerLocks = {};
  const probingDevices = new Set();
  let probeGeneration = 0;
  let probeQueueRunner = null;

  const GATEWAY_CACHE_KEY = 'lav60:gateway:v1';
  const GATEWAY_CACHE_VERSION = 1;
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

  function getStoreGatewayEntry(storeId) {
    const sid = normalizeStoreId(storeId);
    return loadGatewayCacheRoot().stores[sid]?.gateway || null;
  }

  function setStoreGatewayEntry(storeId, entry) {
    const sid = normalizeStoreId(storeId);
    if (!sid) return;
    const root = loadGatewayCacheRoot();
    if (!root.stores[sid]) root.stores[sid] = {};
    const checkedAt = Date.now();
    root.stores[sid].gateway = { online: Boolean(entry.online), error: entry.error || null, checkedAt };
    saveGatewayCacheRoot(root);
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

  async function postStoreLedOn(storeId) {
    const sid = normalizeStoreId(storeId);
    const res = await panelFetch(`/api/gateway/${encodeURIComponent(sid)}/led/on`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, data };
  }

  function revertStoreLedTest(storeId) {
    const sid = normalizeStoreId(storeId);
    panelFetch(`/api/gateway/${encodeURIComponent(sid)}/led/off`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    }).catch(() => {});
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
    $('storeGatewayChecking')?.classList.toggle('hidden', !show);
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

  function updateStoreGatewayMeta(state, detail = '') {
    const el = $('storeGatewayMeta');
    if (!el) return;
    el.className = 'gateway-meta';
    if (!currentStore || !state) {
      el.textContent = 'Gateway: —';
      return;
    }
    if (state === 'checking') {
      el.textContent = 'Gateway: verificando…';
      el.classList.add('gateway-meta--warn');
    } else if (state === 'online') {
      el.textContent = `Gateway: online (${currentStore.toUpperCase()})`;
      el.classList.add('gateway-meta--ok');
    } else if (state === 'offline') {
      el.textContent = detail || `Gateway: offline (${currentStore.toUpperCase()})`;
      el.classList.add('gateway-meta--err');
    } else {
      el.textContent = 'Gateway: —';
    }
  }

  function formatStoreGatewayError(storeId, detail) {
    const code = String(storeId || '').toUpperCase();
    const msg = String(detail || '').trim();
    if (!msg) {
      return `A loja ${code} não possui redundância disponível no momento.`;
    }
    if (msg.toLowerCase().includes('not found') || msg.includes('404')) {
      return `A loja ${code} não está disponível na redundância.`;
    }
    return `Redundância da loja ${code} indisponível. ${friendlyUserMessage(msg)}`;
  }

  async function verifyStoreGateway(storeId, { force = false } = {}) {
    const gen = ++storeCheckGeneration;
    storeGatewayReady = false;
    storeGatewayError = null;
    hideStoreGatewayAlert();

    const cached = getStoreGatewayEntry(storeId);
    if (!force && cached && isCacheFresh(cached.checkedAt, GATEWAY_TTL_MS)) {
      if (gen !== storeCheckGeneration || normalizeStoreId(storeId) !== currentStore) return false;
      if (cached.online) {
        storeGatewayReady = true;
        storeGatewayError = null;
        updateStoreGatewayMeta('online');
        hideStoreGatewayAlert();
        setDevicesPanelBlocked(false);
        gatewayDebug('ESP8266 em cache (online)', { store: storeId, age: formatCacheAge(cached.checkedAt) });
        startBackgroundDeviceProbes({ force });
        refreshGatewayOverview();
        renderDevices();
        return true;
      }
      storeGatewayError = cached.error || formatStoreGatewayError(storeId, '');
      showStoreGatewayAlert(storeGatewayError);
      updateStoreGatewayMeta('offline');
      setDevicesPanelBlocked(true);
      refreshGatewayOverview();
      renderDevices();
      return false;
    }

    showStoreGatewayChecking(true);
    updateStoreGatewayMeta('checking');
    setDevicesPanelBlocked(true);
    renderDevices();

    try {
      gatewayDebug('Verificando ESP8266', { store: storeId, method: 'POST', path: `${storeId}/led/on` });

      const { ok, status, data } = await postStoreLedOn(storeId);
      if (gen !== storeCheckGeneration || normalizeStoreId(storeId) !== currentStore) return false;

      if (ok) {
        setStoreGatewayEntry(storeId, { online: true, error: null });
        storeGatewayReady = true;
        storeGatewayError = null;
        updateStoreGatewayMeta('online');
        hideStoreGatewayAlert();
        setDevicesPanelBlocked(false);
        gatewayDebug('ESP8266 respondeu (led/on)', { store: storeId, data });

        revertStoreLedTest(storeId);
        startBackgroundDeviceProbes({ force });
        refreshGatewayOverview();
        return true;
      }

      const detail = data.detail || data.error || data.message || `HTTP ${status}`;
      storeGatewayError = formatStoreGatewayError(storeId, detail);
      setStoreGatewayEntry(storeId, { online: false, error: storeGatewayError });
      showStoreGatewayAlert(storeGatewayError);
      updateStoreGatewayMeta('offline');
      setDevicesPanelBlocked(true);
      gatewayDebug('ESP8266 offline (led/on)', { store: storeId, status, data });
      refreshGatewayOverview();
      return false;
    } catch (err) {
      if (gen !== storeCheckGeneration || normalizeStoreId(storeId) !== currentStore) return false;
      storeGatewayError = formatStoreGatewayError(storeId, err.message);
      setStoreGatewayEntry(storeId, { online: false, error: storeGatewayError });
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
    $('tokenAlert').classList.toggle('hidden', Boolean(gatewayConfig.token_configured));
    return gatewayConfig;
  }

  function readGatewayError(data, status) {
    if (!data) return `HTTP ${status}`;
    return data.detail || data.error || data.message || `HTTP ${status}`;
  }

  async function gatewayRequest(method, subpath, body, options = {}) {
    if (!currentStore) throw new Error('Selecione uma loja');
    if (!storeGatewayReady) {
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

  async function loadMachinesForStore(storeId) {
    const meta = (catalog?.stores || []).find((s) => normalizeStoreId(s.id) === storeId);
    if (!meta) {
      machinesCatalog = [];
      return;
    }
    const cached = await getCachedStoreEntry(meta, catalog);
    if (cached?.status?.machines?.length) {
      machinesCatalog = cached.status.machines;
      return;
    }
    const { status } = await fetchStoreStatusFromHeartbeat(meta, catalog);
    machinesCatalog = status?.machines || [];
  }

  function getMachinesCatalog() {
    return mergeMachinesCatalog(machinesCatalog);
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
    if (!getMachinesCatalog().length) return ids || [];
    const network = gatewayNetworkContext();
    return (ids || []).filter((id) => isDeviceVisibleInFrontend(deviceType, id, network));
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
    scheduleDeviceLockTick();
  }

  function clearDryerLock(dryerId) {
    delete dryerLocks[String(dryerId)];
    saveDryerLocksToStorage();
    const card = document.querySelector(`.device-card[data-dryer-id="${dryerId}"]`);
    if (card) applyDryerLockUI(card, dryerId);
    scheduleDeviceLockTick();
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
    scheduleDeviceLockTick();
  }

  function clearWasherLock(washerId) {
    delete washerLocks[String(washerId)];
    saveWasherLocksToStorage();
    const card = document.querySelector(`.device-card[data-washer-id="${washerId}"]`);
    if (card) applyWasherLockUI(card, washerId);
    scheduleDeviceLockTick();
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
    const operable = online === true && canOperateMachineStatus(meta?.status);

    if (remaining) {
      card.classList.add('device-card--busy');
      if (statusEl) statusEl.textContent = `Em secagem · ${formatLockRemaining(remaining)}`;
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
    const { silent = false, generation = probeGeneration } = options;
    if (!currentStore) return;
    const path = deviceEndpointPath(deviceType, machine);
    if (!path) return;

    const key = deviceProbeKey(deviceType, machine);
    const label = devicePingLabel(deviceType, machine);
    probingDevices.add(key);
    updateDeviceStatusPill();

    let resolved = null;

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (generation !== probeGeneration) return;

        const result = await gatewayRequest('GET', path, undefined, { allowHttpError: true });
        if (generation !== probeGeneration) return;

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
      if (generation !== probeGeneration) return;
      if (!silent) {
        showToast(`Ping ${label}: ${friendlyUserMessage(err.message)}`, false);
        appendLog(`Ping ${label}`, false, err.payload || err.message);
      }
    } finally {
      probingDevices.delete(key);
      if (generation !== probeGeneration) return;
      const state =
        deviceType === 'ac'
          ? pingStatus?.ac ?? resolved
          : pingStatus?.[`${deviceType}s`]?.[machine] ?? resolved;
      updateDeviceStatusPill();
    }
  }

  function collectDeviceProbeJobs() {
    const jobs = [];
    (gatewayConfig?.washers || []).forEach((id) => jobs.push({ deviceType: 'washer', machine: id }));
    (gatewayConfig?.dryers || []).forEach((id) => jobs.push({ deviceType: 'dryer', machine: id }));
    (gatewayConfig?.dosers || []).forEach((id) => jobs.push({ deviceType: 'doser', machine: id }));
    jobs.push({ deviceType: 'ac', machine: null });
    return jobs;
  }

  async function runProbeQueue(generation) {
    if (probeQueueRunner) {
      await probeQueueRunner.catch(() => {});
    }

    const jobs = collectDeviceProbeJobs();
    probeQueueRunner = (async () => {
      for (const { deviceType, machine } of jobs) {
        if (generation !== probeGeneration) return;
        await probeDeviceOnline(deviceType, machine, { silent: true, generation });
        if (generation !== probeGeneration) return;
        await sleep(250);
      }
    })();

    try {
      await probeQueueRunner;
      if (generation === probeGeneration && currentStore && pingStatus) {
        setStoreDevicesEntry(currentStore, pingStatus);
      }
    } catch {
      /* fila cancelada ao trocar loja */
    } finally {
      if (probeQueueRunner && generation === probeGeneration) {
        probeQueueRunner = null;
      }
    }
  }

  function startBackgroundDeviceProbes({ force = false } = {}) {
    if (!currentStore || !gatewayConfig || !storeGatewayReady) return;

    const cached = getStoreDevicesEntry(currentStore);
    if (!force && cached?.pingStatus && isCacheFresh(cached.checkedAt, DEVICES_TTL_MS)) {
      pingStatus = clonePingStatus(cached.pingStatus);
      renderDevices();
      gatewayDebug('Equipamentos em cache', {
        store: currentStore,
        age: formatCacheAge(cached.checkedAt),
      });
      return;
    }

    probeGeneration += 1;
    const generation = probeGeneration;
    probingDevices.clear();
    resetPingStatus();
    renderDevices();
    runProbeQueue(generation).catch(() => {});
  }

  async function runGatewayAction(label, subpath, method = 'POST', body) {
    const result = await gatewayRequest(method, subpath, body);
    if (!result.ok) {
      const err = new Error(readGatewayError(result.data, result.status));
      err.payload = result.data;
      throw err;
    }
    return result.data;
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
      void startBackgroundDeviceProbes({ force: true });
    } catch (e) {
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
      const data = await runGatewayAction(`Secadora ${id}`, `dryer/${id}`, 'POST', { minutes });
      setDryerLock(id, data.minutes ?? minutes);
      showActionConfirm(`Secadora ${id}`, data);
      void startBackgroundDeviceProbes({ force: true });
    } catch (e) {
      showToast(formatOperatorError(`Secadora ${id}`, e.message), false);
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
      const data = await runGatewayAction(`Lavadora ${id}`, `washer/${id}`, 'POST', am ? { am } : {});
      setWasherLock(id, getWasherLockMinutes(getMachineMeta(id, 'washer')));
      showActionConfirm(`Lavadora ${id}`, data);
      void startBackgroundDeviceProbes({ force: true });
    } catch (e) {
      showToast(formatOperatorError(`Lavadora ${id}`, e.message), false);
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
        { probing: isDeviceProbing('washer', id) }
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
    const minutes = gatewayConfig.dryer_minutes || [15, 30, 45];
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

          const minuteOptions = minutes.map((min) => ({ value: String(min), label: `${min} min` }));
          const picker = createChoicePicker(minuteOptions, { columns: 3, requireSelection: true });
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
        { probing: isDeviceProbing('dryer', id) }
      );
      card.dataset.dryerId = id;
      grid.appendChild(card);
      if (online === true) syncDryerCardControls(card, meta, online);
    });
  }

  function renderDosers() {
    const grid = $('dosersGrid');
    grid.innerHTML = '';
    if (!gatewayConfig) return;
    setSectionCount('dosersCount', pingStatus?.dosers);
    visibleDeviceIds('doser', gatewayConfig.dosers).forEach((id) => {
      const online = deviceOnline('doser', id);
      const meta = getMachineMeta(id, 'doser');
      const card = createDeviceCard(
        id,
        online,
        (actions, _card, ctx) => buildDoserCardContent(actions, id, ctx, runAction, doserCardApi),
        meta,
        { probing: isDeviceProbing('doser', id) }
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
    const temps = gatewayConfig.ac_temperatures || ['18', '22', 'off'];
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
      { probing: isDeviceProbing('ac', null) }
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

  function updateStoreStatusBarVisibility() {
    $('storeStatusBar')?.classList.toggle('hidden', !currentStore);
    $('gatewayNoStore')?.classList.toggle('hidden', Boolean(currentStore));
  }

  async function applyStore(next) {
    next = normalizeStoreId(next);
    probeGeneration += 1;
    storeCheckGeneration += 1;
    storeGatewayReady = false;
    storeGatewayError = null;
    probingDevices.clear();

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
    resetPingStatus();
    await loadMachinesForStore(next);
    initDeviceLocks();
    updateDevicesPanelVisibility();
    updateStoreStatusBarVisibility();
    refreshGatewayOverview();
    renderDevices();
    gatewayDebug('Loja selecionada — verificando gateway', { store: currentStore });
    await verifyStoreGateway(next);
  }

  async function init() {
    const ok = await guardPage({ returnPath: `gateway.html${window.location.search}` });
    if (!ok) return;
    bindConfirmEvents();
    await mountUserMenu($('headerUserMenu'));

    try {
      await loadGatewayConfig();
      catalog = await loadCatalog();
      resetPingStatus();
      setDevicesPanelBlocked(true);
      updateDevicesPanelVisibility();
      updateStoreStatusBarVisibility();
      renderDevices();

      const initial = normalizeStoreId(new URLSearchParams(window.location.search).get('store'));
      window.Lav60GatewayOverview?.mount({
        fetchFn: panelFetch,
        getStores: () => catalog?.stores || [],
        onRefresh: () => {
          if (currentStore) void verifyStoreGateway(currentStore, { force: true });
        },
        skipStores: initial || null,
      });
      if (initial) {
        void applyStore(initial);
      }
    } catch (err) {
      showToast(err.message, false);
    }

    checkApiHealth().catch(() => {});
  }

  init().catch((err) => {
    document.body.classList.remove('auth-pending');
    showToast(err.message || 'Erro ao iniciar', false);
  });
})();
