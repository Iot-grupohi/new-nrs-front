(() => {
  'use strict';

  const {
    loadCatalog,
    findStoreInCatalog,
    loadStoreCached,
    getCachedStoreEntry,
    configFromStatus,
    fetchAgentConfig,
    agentRequest,
    resolveAgentEndpoint,
    discoverAgentEndpoint,
    resolveAgentEndpointForStore,
    statusFromHeartbeatPayload,
    fetchHeartbeatsSnapshot,
    watchStoreHeartbeat,
    fetchStoreStatusFromHeartbeat,
    ensureDefaultAgentToken,
    normalizeStoreId,
    noAgentMessage,
    isAgentUnavailableError,
    isHeartbeatEntryAlive,
    lav60Debug,
    WASHER_DOSAGE_OPTIONS,
    friendlyUserMessage,
    formatOperatorError,
    findMachineMeta,
    mergeMachinesCatalog,
    canOperateMachineStatus,
    machineMetaFacts,
    deviceUnifiedStatus,
    syncConfigDevices,
    isDeviceVisibleInFrontend,
    applyFrontendDeviceVisibility,
    isStoreLav60Suspended,
  } = window.Lav60;

  const pageStore = normalizeStoreId(new URLSearchParams(window.location.search).get('store'));
  let catalog = null;
  let storeMeta = null;
  let config = null;
  let agentEndpoint = null;
  let statusData = null;
  let agentToken = '';
  let stopHeartbeatWatch = null;
  let deviceLockTimer = null;
  let dryerLocks = {};
  let washerLocks = {};
  let uiReady = false;

  const $ = (id) => document.getElementById(id);

  const confirmUI = Lav60DeviceUI.createConfirmUI({
    $,
    onToast: (message, ok = true) => showToast(message, ok),
  });
  const { confirmAction, showActionConfirm, hideActionConfirm, bindConfirmEvents } = confirmUI;

  const {
    createDeviceCard,
    canOperateMachine,
    deviceStatusHint,
    buildDoserCardContent,
    btn,
    createChoicePicker,
    syncReleaseButtonWithPicker,
    appendReleaseButton,
    appendActionGrid,
  } = Lav60DeviceUI.createDeviceUI(window.Lav60);

  const { dosageLabel } = Lav60DeviceUI;

  const DRYER_LOCK_STORAGE_KEY = 'lav60_dryer_locks';
  const WASHER_LOCK_STORAGE_KEY = 'lav60_washer_locks';

  function showOperatorError(label, error) {
    const msg = error?.message || String(error || '');
    showToast(formatOperatorError(label, msg), false);
  }

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

  function healthPercent(summary) {
    const on = summary?.online ?? 0;
    const tot = summary?.total ?? 0;
    return tot ? Math.round((on / tot) * 100) : 0;
  }

  function countOnline(map) {
    if (!map) return { on: 0, total: 0 };
    const vals = Object.values(map);
    return { on: vals.filter(Boolean).length, total: vals.length };
  }

  const STORE_SUSPENDED_NOTICE =
    'Loja suspensa no sistema Lav60 — operação local permitida';

  function updateStoreSuspendedBanner(meta, heartbeatEntry) {
    const banner = $('storeSuspendedBanner');
    if (!banner) return;

    const payload = heartbeatEntry?.payload || heartbeatEntry || {};
    const suspended = isStoreLav60Suspended(meta, { payload }) || meta?.lav60_status === 'suspended';

    if (!suspended) {
      banner.classList.add('hidden');
      document.body.classList.remove('page-store--suspended');
      return;
    }

    banner.classList.remove('hidden');
    document.body.classList.add('page-store--suspended');
    const msgEl = $('storeSuspendedMessage');
    if (msgEl) {
      msgEl.textContent = STORE_SUSPENDED_NOTICE;
    }
  }

  function updateStoreHeader(status) {
    const name = storeMeta?.name || pageStore.toUpperCase();
    const code = pageStore.toUpperCase();
    $('storeTitle').textContent = name;
    $('storeCode').textContent = code;
    if ($('footerStore')) {
      $('footerStore').textContent = `LAV60 · ${name}`;
    }
    document.title = `LAV60 — ${name}`;

    if (status) {
      const summary = status.summary || {};
      const tot = summary.total ?? 0;
      const when = formatTime(status.timestamp);
      $('storeSubtitle').textContent = tot > 0 ? `Última leitura · ${when}` : `Atualizado · ${when}`;
    } else {
      $('storeSubtitle').textContent = 'Aguardando status do agente…';
    }
  }

  function ensureTokenIfRequired() {
    if (!config?.token_required) return true;
    if (agentToken) return true;
    showToast('Autenticação do agente indisponível. Contacte o suporte.', false);
    return false;
  }

  async function apiCall(method, path, body) {
    if (!ensureTokenIfRequired()) {
      throw new Error('Acesso negado — verifique o token');
    }
    const ep = agentEndpoint || resolveAgentEndpoint(storeMeta, catalog, config);
    return agentRequest(storeMeta, catalog, agentToken, method, path, body, ep);
  }

  function applyStatus(data, options = {}) {
    const acId = catalog?.ac_id || '110';
    statusData = data ? applyFrontendDeviceVisibility({ ...data }, acId) : data;
    if (statusData) {
      const merged = mergeMachinesCatalog(config?.machines, statusData.machines);
      if (merged.length) {
        statusData.machines = merged;
      }
    }
    if (config) {
      if (statusData?.machines?.length) {
        config.machines = statusData.machines;
      }
      syncConfigDevices(config, statusData);
    } else if (statusData?.summary?.total || statusData?.washers || statusData?.machines?.length) {
      config = configFromStatus(statusData);
    }
    const summary = statusData.summary || {};
    const on = summary.online ?? 0;
    const tot = summary.total ?? 0;
    const pct = healthPercent(summary);

    $('summaryOnline').textContent = on;
    $('summaryTotal').textContent = `de ${tot} total`;
    $('summaryHealth').textContent = `${pct}%`;
    $('summaryHealthBar').style.width = `${pct}%`;
    $('summaryTime').textContent = formatTime(statusData.timestamp);

    updateStoreHeader(statusData);
    if (options.render !== false && uiReady) {
      renderDevices();
    }
  }

  function applyCachedBootstrap(entry, options = {}) {
    if (!entry?.status || !entry.card?.accessible) return false;
    config = configFromStatus(entry.status);
    applyStatus(entry.status, options);
    return true;
  }

  async function refreshStatus(options = {}) {
    try {
      if (options.force !== true) {
        const { status, error } = await fetchStoreStatusFromHeartbeat(storeMeta, catalog);
        if (status) {
          applyStatus(status);
          return;
        }
        if (error) lav60Debug('store', 'heartbeat refresh', error);
      }

      const ep = agentEndpoint || resolveAgentEndpoint(storeMeta, catalog, config);
      const { status } = await loadStoreCached(storeMeta, catalog, agentToken, {
        ...options,
        force: true,
        endpointOverride: ep,
      });
      if (status) applyStatus(status);
    } catch (e) {
      showOperatorError('Status', e);
    }
  }

  async function loadConfig() {
    if (!agentEndpoint || agentEndpoint.unmatched) {
      agentEndpoint = await resolveAgentEndpointForStore(storeMeta, catalog, agentToken);
    }
    if (agentEndpoint?.unmatched) {
      throw new Error(noAgentMessage(pageStore));
    }
    config = await fetchAgentConfig(storeMeta, catalog, agentToken, agentEndpoint);
    const merged = mergeMachinesCatalog(config.machines, statusData?.machines);
    if (merged.length) {
      config.machines = merged;
      if (statusData) statusData.machines = merged;
    }
    syncConfigDevices(config, statusData || config.last_network_check);
    agentEndpoint = resolveAgentEndpoint(storeMeta, catalog, config);
  }

  async function runAction(label, fn, audit = null) {
    const ok = await confirmAction(audit?.confirmMessage, audit?.confirmRows || [], {
      heading: audit?.confirmHeading || 'Confirmar operação',
    });
    if (!ok) return;
    try {
      const data = await fn();
      showActionConfirm(label, data);
      await logStoreAudit({
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
      const readOnly = audit?.method === 'GET' || audit?.action === 'doser_consult';
      if (!readOnly) {
        await refreshStatus({ force: true });
      }
    } catch (e) {
      await logStoreAudit({
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
      showOperatorError(label, e);
    }
  }

  function buildStoreAudit(fields) {
    const base = {
      store: pageStore,
      page: 'store',
      ...fields,
    };
    return window.Lav60Audit?.buildEntry ? Lav60Audit.buildEntry(base) : base;
  }

  async function logStoreAudit(fields) {
    if (!window.Lav60Audit) return false;
    return Lav60Audit.log(buildStoreAudit(fields));
  }

  function loadDryerLocksFromStorage() {
    try {
      const all = JSON.parse(localStorage.getItem(DRYER_LOCK_STORAGE_KEY) || '{}');
      return all[pageStore] || {};
    } catch {
      return {};
    }
  }

  function saveDryerLocksToStorage() {
    try {
      const all = JSON.parse(localStorage.getItem(DRYER_LOCK_STORAGE_KEY) || '{}');
      all[pageStore] = dryerLocks;
      localStorage.setItem(DRYER_LOCK_STORAGE_KEY, JSON.stringify(all));
    } catch {
      /* ignore */
    }
  }

  function loadWasherLocksFromStorage() {
    try {
      const all = JSON.parse(localStorage.getItem(WASHER_LOCK_STORAGE_KEY) || '{}');
      return all[pageStore] || {};
    } catch {
      return {};
    }
  }

  function saveWasherLocksToStorage() {
    try {
      const all = JSON.parse(localStorage.getItem(WASHER_LOCK_STORAGE_KEY) || '{}');
      all[pageStore] = washerLocks;
      localStorage.setItem(WASHER_LOCK_STORAGE_KEY, JSON.stringify(all));
    } catch {
      /* ignore */
    }
  }

  function pruneDryerLocks() {
    const now = Date.now();
    let changed = false;
    Object.keys(dryerLocks).forEach((id) => {
      if (dryerLocks[id] <= now) {
        delete dryerLocks[id];
        changed = true;
      }
    });
    if (changed) saveDryerLocksToStorage();
  }

  function pruneWasherLocks() {
    const now = Date.now();
    let changed = false;
    Object.keys(washerLocks).forEach((id) => {
      if (washerLocks[id] <= now) {
        delete washerLocks[id];
        changed = true;
      }
    });
    if (changed) saveWasherLocksToStorage();
  }

  function initDeviceLocks() {
    dryerLocks = loadDryerLocksFromStorage();
    washerLocks = loadWasherLocksFromStorage();
    pruneDryerLocks();
    pruneWasherLocks();
    scheduleDeviceLockTick();
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

  function isDryerLocked(dryerId) {
    return getDryerLockRemainingMs(dryerId) > 0;
  }

  function setDryerLock(dryerId, minutes) {
    const mins = Number(minutes) || 15;
    dryerLocks[String(dryerId)] = Date.now() + mins * 60 * 1000;
    saveDryerLocksToStorage();
    scheduleDeviceLockTick();
  }

  function clearDryerLock(dryerId) {
    delete dryerLocks[String(dryerId)];
    saveDryerLocksToStorage();
    const card = document.querySelector(`.device-card[data-dryer-id="${dryerId}"]`);
    if (card) applyDryerLockUI(card, dryerId);
    scheduleDeviceLockTick();
    logStoreAudit({
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
    const mins = Number(minutes) || 45;
    washerLocks[String(washerId)] = Date.now() + mins * 60 * 1000;
    saveWasherLocksToStorage();
    scheduleDeviceLockTick();
  }

  function clearWasherLock(washerId) {
    delete washerLocks[String(washerId)];
    saveWasherLocksToStorage();
    const card = document.querySelector(`.device-card[data-washer-id="${washerId}"]`);
    if (card) applyWasherLockUI(card, washerId);
    scheduleDeviceLockTick();
    logStoreAudit({
      action: 'washer_unlock',
      label: `Reativar botões · lavadora ${washerId}`,
      method: 'UI',
      success: true,
      device_type: 'washer',
      device_id: String(washerId),
    });
  }

  function formatLockRemaining(ms) {
    const totalSec = Math.max(0, Math.ceil(ms / 1000));
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    if (min >= 1 && sec > 0) return `${min} min ${sec} s`;
    if (min >= 1) return `${min} min`;
    return `${sec} s`;
  }

  function syncDryerCardControls(card, meta, online) {
    const dryerId = card.dataset.dryerId;
    const remaining = getDryerLockRemainingMs(dryerId);
    const statusEl = card.querySelector('.device-card__cycle-status');
    const unlockBtn = card.querySelector('.device-card__unlock');
    const releaseBtn = card.querySelector('button[data-dryer-release]');
    const choiceButtons = card.querySelectorAll('.device-card__choice');
    const operable = canOperateMachine(meta, online);

    if (remaining) {
      card.classList.add('device-card--busy');
      if (statusEl) {
        statusEl.textContent = `Em secagem · ${formatLockRemaining(remaining)}`;
      }
      if (releaseBtn) releaseBtn.disabled = true;
      choiceButtons.forEach((b) => {
        b.disabled = true;
      });
      if (unlockBtn) unlockBtn.classList.toggle('device-card__unlock--hidden', false);
      return true;
    }

    card.classList.remove('device-card--busy');
    if (statusEl) {
      statusEl.textContent = operable ? '' : deviceUnifiedStatus(online, meta).label;
    }
    if (releaseBtn) {
      const hasChoice = Array.from(choiceButtons).some((b) =>
        b.classList.contains('device-card__choice--active')
      );
      releaseBtn.disabled = !operable || !hasChoice;
    }
    choiceButtons.forEach((b) => {
      b.disabled = !operable;
    });
    if (unlockBtn) unlockBtn.classList.add('device-card__unlock--hidden');
    return false;
  }

  function applyDryerLockUI(card, dryerId) {
    const meta = getMachineMeta(dryerId, 'dryer', getMachinesCatalog());
    const online = Boolean(statusData?.dryers?.[dryerId]);
    return syncDryerCardControls(card, meta, online);
  }

  function syncWasherCardControls(card, meta, online) {
    const washerId = card.dataset.washerId;
    const remaining = getWasherLockRemainingMs(washerId);
    const statusEl = card.querySelector('.device-card__cycle-status');
    const unlockBtn = card.querySelector('.device-card__unlock');
    const releaseBtn = card.querySelector('button[data-washer-release]');
    const choiceButtons = card.querySelectorAll('.device-card__choice');
    const operable = canOperateMachine(meta, online);

    if (remaining) {
      card.classList.add('device-card--busy');
      if (statusEl) {
        statusEl.textContent = `Em lavagem · ${formatLockRemaining(remaining)}`;
      }
      if (releaseBtn) releaseBtn.disabled = true;
      choiceButtons.forEach((b) => {
        b.disabled = true;
      });
      if (unlockBtn) unlockBtn.classList.remove('device-card__unlock--hidden');
      return true;
    }

    card.classList.remove('device-card--busy');
    if (statusEl) {
      statusEl.textContent = operable ? '' : deviceUnifiedStatus(online, meta).label;
    }
    if (releaseBtn) {
      const hasChoice = Array.from(choiceButtons).some((b) =>
        b.classList.contains('device-card__choice--active')
      );
      releaseBtn.disabled = !operable || !hasChoice;
    }
    choiceButtons.forEach((b) => {
      b.disabled = !operable;
    });
    if (unlockBtn) unlockBtn.classList.add('device-card__unlock--hidden');
    return false;
  }

  function applyWasherLockUI(card, washerId) {
    const meta = getMachineMeta(washerId, 'washer', getMachinesCatalog());
    const online = Boolean(statusData?.washers?.[washerId]);
    return syncWasherCardControls(card, meta, online);
  }

  function scheduleDeviceLockTick() {
    if (deviceLockTimer) {
      clearInterval(deviceLockTimer);
      deviceLockTimer = null;
    }

    pruneDryerLocks();
    pruneWasherLocks();
    if (!Object.keys(dryerLocks).length && !Object.keys(washerLocks).length) return;

    deviceLockTimer = setInterval(() => {
      pruneDryerLocks();
      pruneWasherLocks();
      const dryerIds = Object.keys(dryerLocks);
      const washerIds = Object.keys(washerLocks);
      if (!dryerIds.length && !washerIds.length) {
        clearInterval(deviceLockTimer);
        deviceLockTimer = null;
        return;
      }
      dryerIds.forEach((id) => {
        const card = document.querySelector(`.device-card[data-dryer-id="${id}"]`);
        if (card) applyDryerLockUI(card, id);
      });
      washerIds.forEach((id) => {
        const card = document.querySelector(`.device-card[data-washer-id="${id}"]`);
        if (card) applyWasherLockUI(card, id);
      });
    }, 1000);
  }

  async function runDryerRelease(id, minutes) {
    if (minutes == null || Number.isNaN(minutes)) return;
    const label = `Secadora ${id} · ${minutes} min`;
    const ok = await confirmAction(null, [
      ['Equipamento', `Secadora ${id}`],
      ['Tempo', `${minutes} min`],
    ], { heading: 'Confirmar liberação' });
    if (!ok) return;
    try {
      const data = await apiCall('POST', `/dryer/${id}`, { minutes });
      setDryerLock(id, data.minutes ?? minutes);
      showActionConfirm(`Secadora ${id}`, data);
      await logStoreAudit({
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
      await refreshStatus({ force: true });
    } catch (e) {
      await logStoreAudit({
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
      showOperatorError(`Secadora ${id}`, e);
    }
  }

  async function runWasherRelease(id, amValue) {
    if (amValue == null) return;
    const am = typeof amValue === 'string' ? amValue : amValue?.value || '';
    const amLabel = am ? dosageLabel(am) : 'Sem cheiro';
    const ok = await confirmAction(null, [
      ['Equipamento', `Lavadora ${id}`],
      ['Dosagem', amLabel],
    ], { heading: 'Confirmar liberação' });
    if (!ok) return;
    try {
      const data = await apiCall('POST', `/washer/${id}`, am ? { am } : {});
      const meta = getMachineMeta(id, 'washer', getMachinesCatalog());
      setWasherLock(id, getWasherLockMinutes(meta));
      showActionConfirm(`Lavadora ${id}`, data);
      await logStoreAudit({
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
      await refreshStatus({ force: true });
    } catch (e) {
      await logStoreAudit({
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
      showOperatorError(`Lavadora ${id}`, e);
    }
  }

  function getMachineMeta(id, type, machines) {
    return findMachineMeta(machines, id, type);
  }

  function getMachinesCatalog() {
    return mergeMachinesCatalog(config?.machines, statusData?.machines);
  }

  function setSectionCount(elementId, map) {
    Lav60DeviceUI.setSectionCount($(elementId), map);
  }

  function runDoserCommand(id, type) {
    return apiCall('POST', `/doser/${id}`, { type });
  }

  function runDoserConsult(id) {
    return apiCall('GET', `/doser/${id}/consulta`).then((data) => ({
      ...data,
      machine: data.machine || id,
    }));
  }

  function runDoserSetTime(id, kind, seconds) {
    return apiCall('POST', `/doser/${id}/settime/${kind}`, { seconds });
  }

  const doserCardApi = {
    runDoserCommand,
    runDoserConsult,
    runDoserSetTime,
  };

  function renderWashers() {
    const grid = $('washersGrid');
    grid.innerHTML = '';
    if (!config) return;
    setSectionCount('washersCount', statusData?.washers);
    visibleDeviceIds('washer', config.devices.washers).forEach((id) => {
      const online = Boolean(statusData?.washers?.[id]);
      const meta = getMachineMeta(id, 'washer', getMachinesCatalog());
      const card = createDeviceCard(
        id,
        online,
        (actions, _card, ctx) => {
          actions.classList.add('device-card__actions--washer');

          const statusEl = document.createElement('p');
          statusEl.className = 'device-card__cycle-status';
          statusEl.setAttribute('aria-live', 'polite');
          actions.appendChild(statusEl);

          const dosageOptions = (config.washer_dosage_options || WASHER_DOSAGE_OPTIONS).map((opt) => ({ ...opt }));
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

          const unlockBtn = btn('Ativar botões', 'btn--ghost device-card__unlock', () =>
            clearWasherLock(id)
          );
          unlockBtn.classList.add('device-card__unlock--hidden');
          actions.appendChild(unlockBtn);

          const hint = deviceStatusHint(ctx);
          if (hint) statusEl.textContent = hint;
        },
        meta
      );
      card.dataset.washerId = id;
      grid.appendChild(card);
      if (online) {
        syncWasherCardControls(card, meta, online);
      }
    });
  }

  function renderDryers() {
    const grid = $('dryersGrid');
    grid.innerHTML = '';
    if (!config) return;
    setSectionCount('dryersCount', statusData?.dryers);
    visibleDeviceIds('dryer', config.devices.dryers).forEach((id) => {
      const online = Boolean(statusData?.dryers?.[id]);
      const meta = getMachineMeta(id, 'dryer', getMachinesCatalog());
      const card = createDeviceCard(
        id,
        online,
        (actions, _card, ctx) => {
          actions.classList.add('device-card__actions--dryer');

          const statusEl = document.createElement('p');
          statusEl.className = 'device-card__cycle-status';
          statusEl.setAttribute('aria-live', 'polite');
          actions.appendChild(statusEl);

          const minuteOptions = (config.dryer_minutes || [15, 30, 45]).map((min) => ({
            value: String(min),
            label: `${min} min`,
          }));
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

          const unlockBtn = btn('Ativar botões', 'btn--ghost device-card__unlock', () =>
            clearDryerLock(id)
          );
          unlockBtn.classList.add('device-card__unlock--hidden');
          actions.appendChild(unlockBtn);

          const hint = deviceStatusHint(ctx);
          if (hint) statusEl.textContent = hint;
        },
        meta
      );
      card.dataset.dryerId = id;
      grid.appendChild(card);
      if (online) {
        syncDryerCardControls(card, meta, online);
      }
    });
  }

  function renderDosers() {
    const grid = $('dosersGrid');
    grid.innerHTML = '';
    if (!config) return;
    setSectionCount('dosersCount', statusData?.dosers);
    visibleDeviceIds('doser', config.devices.dosers).forEach((id) => {
      const online = Boolean(statusData?.dosers?.[id]);
      const meta = getMachineMeta(id, 'doser', getMachinesCatalog());
      const card = createDeviceCard(
        id,
        online,
        (actions, _card, ctx) => buildDoserCardContent(actions, id, ctx, runAction, doserCardApi),
        meta
      );
      card.classList.add('device-card--doser');
      grid.appendChild(card);
    });
  }

  function renderAc() {
    const panel = $('acPanel');
    panel.innerHTML = '';
    if (!config) return;
    const online = Boolean(statusData?.ac);
    $('acCount').textContent = online ? '1/1 online' : '0/1 online';

    panel.appendChild(
      createDeviceCard('AC', online, (actions, _card, ctx) => {
        actions.classList.add('device-card__actions--ac');
        const tempOptions = (config.ac_temperatures || ['18', '22', 'off']).map((temp) => ({
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
              () => apiCall('POST', '/ac', { temperature: temp }),
              {
                action: 'ac_control',
                label: `AC · ${tempLabel}`,
                confirmHeading: 'Confirmar acionamento',
                confirmRows: [
                  ['Equipamento', 'Ar-condicionado'],
                  ['Ação', tempLabel],
                ],
                method: 'POST',
                path: '/ac',
                payload: { temperature: temp },
                device_type: 'ac',
                device_id: '110',
              }
            );
          },
        });
        syncReleaseButtonWithPicker(releaseBtn, picker, ctx.operable);
      })
    );
  }

  function visibleDeviceIds(deviceType, ids) {
    return (ids || []).filter((id) => isDeviceVisibleInFrontend(deviceType, id, statusData));
  }

  function renderDevices() {
    renderWashers();
    renderDryers();
    renderDosers();
    renderAc();
    scheduleDeviceLockTick();
    $('devicesPanel')?.classList.remove('devices-panel--loading');
  }

  function initAuthUi() {
    if (!window.Lav60Auth) return;
    Lav60Auth.authEnabled().then(async (enabled) => {
      if (!enabled) return;
      await Lav60Auth.mountUserMenu($('headerUserMenu'));
    });
  }

  function initEvents() {
    bindConfirmEvents();
  }

  function startLiveStatusWatch() {
    if (stopHeartbeatWatch) stopHeartbeatWatch();
    stopHeartbeatWatch = watchStoreHeartbeat(
      pageStore,
      catalog,
      (status, hbMeta) => {
        applyStatus(status);
        updateStoreSuspendedBanner(storeMeta, hbMeta);
        lav60Debug('store', 'status SSE (espelho do card)', status.summary);
      },
      { skipInitialBootstrap: true, skipInitialPoll: true }
    );
  }

  function redirectIfNoAgent(reason) {
    if (!isAgentUnavailableError(reason)) return false;
    redirectToDashboard('no_agent', { reason });
    return true;
  }

  function redirectToDashboard(reason, detail = {}) {
    lav60Debug('store', 'REDIRECT → dashboard', { reason, pageStore, ...detail });
    window.location.href = `index.html?blocked=${encodeURIComponent(pageStore)}#/lojas`;
  }

  async function init() {
    lav60Debug('store', 'init', { pageStore, href: window.location.href });
    if (!pageStore) {
      window.location.href = 'index.html#/lojas';
      return;
    }

    initEvents();
    initAuthUi();
    initDeviceLocks();

    try {
      catalog = await loadCatalog();
      storeMeta = findStoreInCatalog(catalog, pageStore);
      updateStoreSuspendedBanner(storeMeta, null);

      agentToken = await ensureDefaultAgentToken();

      let heartbeatEntry = null;
      let heartbeatAlive = false;
      try {
        const hbSnap = await fetchHeartbeatsSnapshot();
        heartbeatEntry = hbSnap.heartbeats?.[pageStore];
        heartbeatAlive = isHeartbeatEntryAlive(heartbeatEntry, catalog);
        lav60Debug('store', 'heartbeat', {
          entry: heartbeatEntry,
          alive: heartbeatAlive,
          timeout: catalog.heartbeat_timeout_seconds || 90,
        });
        if (!heartbeatAlive) {
          redirectToDashboard('heartbeat_offline', { heartbeatEntry });
          return;
        }
        const status = statusFromHeartbeatPayload(
          storeMeta,
          heartbeatEntry.payload || heartbeatEntry,
          pageStore
        );
        if (status?.summary?.total) {
          config = configFromStatus(status);
          applyStatus(status, { render: false });
          updateStoreSuspendedBanner(storeMeta, heartbeatEntry);
          lav60Debug('store', 'status from heartbeat', status.summary);
        }
      } catch (e) {
        lav60Debug('store', 'heartbeat unavailable — agente direto', e?.message || e);
      }

      agentEndpoint = await resolveAgentEndpointForStore(
        storeMeta,
        catalog,
        agentToken,
        heartbeatEntry
      );
      lav60Debug('store', 'agent endpoint', agentEndpoint);
      if (agentEndpoint?.unmatched) {
        redirectToDashboard('agent_unmatched', { agentEndpoint });
        return;
      }

      const cached = await getCachedStoreEntry(storeMeta, catalog);
      lav60Debug('store', 'cache', {
        hasCard: Boolean(cached?.card),
        accessible: cached?.card?.accessible,
        fresh: cached?.fresh,
        heartbeatAlive,
      });
      // Cache antigo (IndexedDB) não bloqueia se heartbeat confirmou agente online
      if (!heartbeatAlive && cached?.card) {
        if (cached.card.agentUnavailable || isAgentUnavailableError(cached.card.error)) {
          redirectToDashboard('cache_agent_unavailable', { error: cached.card.error });
          return;
        }
        if (!cached.card.accessible) {
          redirectToDashboard('cache_not_accessible', { error: cached.card.error });
          return;
        }
      }

      if (!statusData && applyCachedBootstrap(cached, { render: false })) {
        $('summaryTime').title = '';
        lav60Debug('store', 'bootstrap from cache');
      }

      try {
        await loadConfig();
        lav60Debug('store', 'loadConfig ok', {
          store: config?.store,
          token_required: config?.token_required,
          agentEndpoint,
        });
      } catch (e) {
        lav60Debug('store', 'loadConfig failed', e?.message || e);
        if (redirectIfNoAgent(e?.message || e)) return;
        showOperatorError('Configuração', e);
        return;
      }

      const configStore = normalizeStoreId(config?.store);
      if (agentEndpoint?.unmatched || (configStore && configStore !== pageStore)) {
        redirectToDashboard('config_store_mismatch', {
          configStore,
          pageStore,
          agentEndpoint,
        });
        return;
      }

      uiReady = true;
      if (statusData) {
        applyStatus(statusData);
      } else {
        renderDevices();
      }

      lav60Debug('store', 'ready — staying on store page');

      if (config?.token_required && !agentToken?.trim()) {
        showToast('Autenticação do agente indisponível. Contacte o suporte.', false);
      }

      if (heartbeatAlive) {
        startLiveStatusWatch();
      }
    } catch (e) {
      showOperatorError('Inicialização', e);
    }
  }

  window.addEventListener('beforeunload', () => {
    if (stopHeartbeatWatch) stopHeartbeatWatch();
  });

  (async () => {
    if (window.Lav60Auth) {
      const ok = await Lav60Auth.guardPage();
      if (!ok) return;
    }
    if (window.Lav60Audit) {
      await Lav60Audit.refreshStatus();
    }
    await init();
  })();
})();
