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
    canOperateMachineStatus,
    machineMetaFacts,
    deviceUnifiedStatus,
    syncConfigDevices,
    isDeviceVisibleInFrontend,
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
  let actionPromptResolver = null;

  const DRYER_LOCK_STORAGE_KEY = 'lav60_dryer_locks';
  const WASHER_LOCK_STORAGE_KEY = 'lav60_washer_locks';

  const $ = (id) => document.getElementById(id);

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

  const TEMPO_LABELS = { sabao: 'Sabão', floral: 'Floral', sport: 'Sport' };
  const RELE_LABELS = { 1: 'Sabão', 2: 'Floral', 3: 'Sport' };
  const DOSER_TYPE_LABELS = { rele1on: 'Sabão', rele2on: 'Floral', rele3on: 'Sport' };

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = String(text ?? '');
    return d.innerHTML;
  }

  function dosageLabel(am) {
    const opt = WASHER_DOSAGE_OPTIONS.find((o) => o.value === am);
    return opt ? opt.label : am;
  }

  function renderInfoRows(rows) {
    if (!rows.length) return '';
    return `<dl class="confirm-info">${rows
      .map(
        ([label, value]) =>
          `<div class="confirm-info__row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`
      )
      .join('')}</dl>`;
  }

  function renderTemposGrid(tempos) {
    return `<div class="confirm-tempos">${['sabao', 'floral', 'sport']
      .map((key) => {
        const val = tempos[key];
        return `<div class="confirm-tempos__item">
          <span class="confirm-tempos__label">${TEMPO_LABELS[key]}</span>
          <strong class="confirm-tempos__value">${val != null ? val : '—'}</strong>
          <span class="confirm-tempos__unit">seg</span>
        </div>`;
      })
      .join('')}</div>`;
  }

  function cleanConfirmMessage(message) {
    if (!message) return '';
    return String(message)
      .replace(/\s*—\s*washer.*?$/i, '')
      .replace(/\s*\(.*background.*\)/i, '')
      .replace(/\bOK\b\s*—?\s*/gi, '')
      .trim();
  }

  function formatConfirmMessage(label, data) {
    if (data.tempos) return 'Consulta realizada com sucesso.';
    if (data.message) return cleanConfirmMessage(data.message) || `${label} concluído.`;
    return `${label} concluído com sucesso.`;
  }

  function buildConfirmView(label, data) {
    if (data.tempos && typeof data.tempos === 'object') {
      return {
        title: 'Consulta de tempos',
        message: data.machine ? `Dosadora ${data.machine}` : '',
        bodyHtml: renderTemposGrid(data.tempos),
      };
    }

    if (data.seconds != null && data.machine) {
      const rows = [['Equipamento', data.machine]];
      if (data.rele) rows.push(['Produto', RELE_LABELS[data.rele] || `Relé ${data.rele}`]);
      rows.push(['Tempo', `${data.seconds} seg`]);
      return {
        title: 'Tempo configurado',
        message: 'Configuração aplicada com sucesso.',
        bodyHtml: renderInfoRows(rows),
      };
    }

    if (data.doser || data.washer) {
      const rows = [['Lavadora', data.machine || '—']];
      if (data.doser) rows.push(['Dosagem', dosageLabel(data.doser)]);
      rows.push([
        'Status',
        data.background_processing ? 'Liberação em andamento' : 'Liberada',
      ]);
      return {
        title: 'Lavadora liberada',
        message: '',
        bodyHtml: renderInfoRows(rows),
      };
    }

    if (data.minutes != null) {
      return {
        title: 'Secadora liberada',
        message: '',
        bodyHtml: renderInfoRows([
          ['Equipamento', data.machine || '—'],
          ['Duração', `${data.minutes} min`],
        ]),
      };
    }

    if (data.type && data.machine) {
      return {
        title: 'Dosadora acionada',
        message: '',
        bodyHtml: renderInfoRows([
          ['Equipamento', data.machine],
          ['Produto', DOSER_TYPE_LABELS[data.type] || data.type],
        ]),
      };
    }

    if (label === 'AC') {
      const temp = data.payload ?? data.temperature;
      const tempLabel = temp === 'off' ? 'Desligado' : `${temp}°C`;
      return {
        title: 'Ar-condicionado',
        message: '',
        bodyHtml: renderInfoRows([['Temperatura', tempLabel]]),
      };
    }

    const rows = [];
    if (data.machine) rows.push(['Equipamento', data.machine]);
    let message = cleanConfirmMessage(data.message);
    if (!rows.length && !message) {
      message = `${label} concluído com sucesso.`;
    }

    return {
      title: 'Comando confirmado',
      message: rows.length ? message : message || `${label} concluído com sucesso.`,
      bodyHtml: rows.length ? renderInfoRows(rows) : '',
    };
  }

  function showActionConfirm(label, data) {
    const status = data._httpStatus || 200;
    if (status !== 200) {
      showToast(formatConfirmMessage(label, data), true);
      return;
    }

    const view = buildConfirmView(label, data);
    $('confirmTitle').textContent = view.title;
    $('confirmMessage').textContent = view.message || '';

    const bodyEl = $('confirmBody');
    if (view.bodyHtml) {
      bodyEl.innerHTML = view.bodyHtml;
      bodyEl.classList.remove('hidden');
    } else {
      bodyEl.innerHTML = '';
      bodyEl.classList.add('hidden');
    }

    $('confirmStatus').textContent = 'Confirmado';
    $('confirmModal').classList.remove('hidden');
  }

  function hideActionConfirm() {
    $('confirmModal').classList.add('hidden');
  }

  function hideActionPrompt(confirmed) {
    $('actionPromptModal').classList.add('hidden');
    if (!actionPromptResolver) return;
    const resolve = actionPromptResolver;
    actionPromptResolver = null;
    resolve(Boolean(confirmed));
  }

  function confirmAction(message, rows = [], options = {}) {
    return new Promise((resolve) => {
      if (actionPromptResolver) {
        hideActionPrompt(false);
      }
      actionPromptResolver = resolve;

      const heading = options.heading || 'Confirmar operação';
      let promptMessage = '';
      if (typeof message === 'string' && message.trim()) {
        promptMessage = message.trim();
      } else if (Array.isArray(rows) && rows.length) {
        promptMessage = 'Revise os dados abaixo e confirme a operação.';
      } else {
        promptMessage = 'Deseja executar esta ação na loja?';
      }

      $('actionPromptTitle').textContent = heading;
      $('actionPromptMessage').textContent = promptMessage;

      const bodyEl = $('actionPromptBody');
      if (Array.isArray(rows) && rows.length) {
        bodyEl.innerHTML = renderInfoRows(rows);
        bodyEl.classList.remove('hidden');
      } else {
        bodyEl.innerHTML = '';
        bodyEl.classList.add('hidden');
      }

      $('actionPromptModal').classList.remove('hidden');
    });
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
    showToast('Agente exige token — configure API_TOKEN no .env do servidor', false);
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
    statusData = data;
    if (config) {
      if (Array.isArray(data.machines) && data.machines.length) {
        config.machines = data.machines;
      }
      syncConfigDevices(config, data);
    } else if (data?.summary?.total || data?.washers || data?.machines?.length) {
      config = configFromStatus(data);
    }
    const summary = data.summary || {};
    const on = summary.online ?? 0;
    const tot = summary.total ?? 0;
    const pct = healthPercent(summary);

    $('summaryOnline').textContent = on;
    $('summaryTotal').textContent = `de ${tot} total`;
    $('summaryHealth').textContent = `${pct}%`;
    $('summaryHealthBar').style.width = `${pct}%`;
    $('summaryTime').textContent = formatTime(data.timestamp);

    updateStoreHeader(data);
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
    if (Array.isArray(statusData?.machines) && statusData.machines.length) {
      config.machines = statusData.machines;
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
      await refreshStatus({ force: true });
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

  function btn(text, className, onclick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn btn--sm ${className || ''}`;
    b.textContent = text;
    b.addEventListener('click', onclick);
    return b;
  }

  function createChoicePicker(options, { columns = 3, requireSelection = false } = {}) {
    const wrap = document.createElement('div');
    wrap.className = `device-card__choice-grid device-card__choice-grid--${columns}`;
    let selected = requireSelection ? null : options[0]?.value ?? '';
    const buttons = [];
    const listeners = [];

    function notifyChange() {
      listeners.forEach((fn) => fn(selected));
    }

    options.forEach((opt) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'device-card__choice';
      if (opt.wide) {
        b.classList.add('device-card__choice--wide');
      }
      if (!requireSelection && String(opt.value) === String(selected)) {
        b.classList.add('device-card__choice--active');
      }
      b.textContent = opt.label;
      b.dataset.choiceValue = String(opt.value);
      b.addEventListener('click', () => {
        if (b.disabled) return;
        selected = opt.value;
        buttons.forEach((item) => {
          item.classList.toggle(
            'device-card__choice--active',
            item.dataset.choiceValue === String(selected)
          );
        });
        notifyChange();
      });
      buttons.push(b);
      wrap.appendChild(b);
    });

    return {
      root: wrap,
      buttons,
      getValue: () => selected,
      hasSelection: () => selected != null,
      onChange(fn) {
        listeners.push(fn);
      },
      setDisabled(disabled) {
        buttons.forEach((item) => {
          item.disabled = disabled;
        });
      },
    };
  }

  function syncReleaseButtonWithPicker(releaseBtn, picker, operable) {
    if (!releaseBtn || !picker) return;
    const update = () => {
      releaseBtn.disabled = !operable || !picker.hasSelection();
    };
    picker.onChange(update);
    update();
  }

  function appendReleaseButton(container, { label = 'Liberar', className = 'btn--primary', onRelease, dataset = {}, disabled = false }) {
    const releaseBtn = btn(label, `device-card__release-btn ${className}`, onRelease);
    Object.entries(dataset).forEach(([key, value]) => {
      releaseBtn.dataset[key] = value;
    });
    releaseBtn.disabled = disabled;
    container.appendChild(releaseBtn);
    return releaseBtn;
  }

  function getMachineMeta(id, type, machines) {
    return findMachineMeta(machines, id, type);
  }

  function getMachinesCatalog() {
    if (Array.isArray(statusData?.machines) && statusData.machines.length) {
      return statusData.machines;
    }
    return config?.machines || [];
  }

  function canOperateMachine(meta, online) {
    if (!online) return false;
    return canOperateMachineStatus(meta?.status);
  }

  function setDeviceActionsDisabled(actions, disabled) {
    if (!disabled) return;
    actions.querySelectorAll('button, input, select, textarea').forEach((el) => {
      el.disabled = true;
    });
  }

  function deviceStatusHint(ctx) {
    if (!ctx.online) return 'Sem conexão na rede';
    if (!ctx.operable) return ctx.statusInfo.label;
    return '';
  }

  function createDeviceCard(id, online, fillActions, meta) {
    const card = document.createElement('article');
    const operable = canOperateMachine(meta, online);
    const statusInfo = deviceUnifiedStatus(online, meta);
    const capacity = meta?.capacity && meta.capacity !== '—' ? meta.capacity : '';
    const facts = machineMetaFacts(meta);

    card.className = [
      'device-card',
      'device-card--tile',
      `device-card--${statusInfo.tone}`,
      online ? 'device-card--online' : 'device-card--offline',
    ].join(' ');

    if (!operable) {
      card.classList.add('device-card--blocked');
      card.setAttribute('aria-disabled', 'true');
    }

    const factsHtml = facts.length
      ? `<p class="device-card__facts">${facts.map((f) => escapeHtml(f)).join('<span class="device-card__sep">·</span>')}</p>`
      : '';

    card.innerHTML = `
      <header class="device-card__head">
        <div class="device-card__title-row">
          <h3 class="device-card__id">${escapeHtml(String(id))}</h3>
          ${capacity ? `<span class="device-card__cap">${escapeHtml(capacity)}</span>` : ''}
        </div>
        <span class="device-card__status pill ${statusInfo.pillClass}">${escapeHtml(statusInfo.label)}</span>
      </header>
      ${factsHtml}
      <div class="device-card__actions"></div>
    `;

    const actions = card.querySelector('.device-card__actions');
    const ctx = { operable, online, statusInfo };
    fillActions(actions, card, ctx);
    if (!operable) {
      setDeviceActionsDisabled(actions, true);
    }
    return card;
  }

  function setSectionCount(elementId, map) {
    const { on, total } = countOnline(map);
    $(elementId).textContent = total ? `${on}/${total} online` : '—';
  }

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

  function appendActionGrid(container, columns, buttons) {
    const grid = document.createElement('div');
    grid.className = `device-card__action-grid device-card__action-grid--${columns}`;
    buttons.forEach((button) => grid.appendChild(button));
    container.appendChild(grid);
    return grid;
  }

  function buildDoserCardContent(actions, id, ctx = {}) {
    actions.classList.add('device-card__actions--doser');

    const picker = createChoicePicker(
      [
        { value: 'rele1on', label: 'Sabão' },
        { value: 'rele2on', label: 'Floral' },
        { value: 'rele3on', label: 'Sport' },
      ],
      { columns: 3, requireSelection: true }
    );
    if (!ctx.operable) picker.setDisabled(true);
    actions.appendChild(picker.root);

    const releaseBtn = appendReleaseButton(actions, {
      label: 'Acionar',
      disabled: true,
      onRelease: () => {
        if (!picker.hasSelection()) return;
        const type = picker.getValue();
        runAction(
          `Dosadora ${id}`,
          () => apiCall('POST', `/doser/${id}`, { type }),
          {
            action: 'doser_command',
            label: `Dosadora ${id} · ${DOSER_TYPE_LABELS[type] || type}`,
            confirmHeading: 'Confirmar acionamento',
            confirmRows: [
              ['Equipamento', `Dosadora ${id}`],
              ['Produto', DOSER_TYPE_LABELS[type] || type],
            ],
            method: 'POST',
            path: `/doser/${id}`,
            payload: { type },
            device_type: 'doser',
            device_id: String(id),
          }
        );
      },
    });
    syncReleaseButtonWithPicker(releaseBtn, picker, ctx.operable);

    const consultRow = document.createElement('div');
    consultRow.className = 'device-card__action-row';
    consultRow.appendChild(
      btn('Consultar tempos salvos', 'btn--ghost device-card__action-wide', () =>
        runAction(
          `Consulta dosadora ${id}`,
          () =>
            apiCall('GET', `/doser/${id}/consulta`).then((data) => ({
              ...data,
              machine: data.machine || id,
            })),
          {
            action: 'doser_consult',
            label: `Consulta dosadora ${id}`,
            confirmHeading: 'Confirmar consulta',
            confirmMessage: 'Deseja consultar os tempos salvos desta dosadora?',
            confirmRows: [['Equipamento', `Dosadora ${id}`]],
            method: 'GET',
            path: `/doser/${id}/consulta`,
            device_type: 'doser',
            device_id: String(id),
          }
        )
      )
    );
    actions.appendChild(consultRow);

    const panel = document.createElement('div');
    panel.className = 'device-card__panel';

    const panelLabel = document.createElement('span');
    panelLabel.className = 'device-card__panel-label';
    panelLabel.textContent = 'Ajuste de tempo';
    panel.appendChild(panelLabel);

    const timeField = document.createElement('div');
    timeField.className = 'device-card__time-field';

    const secInput = document.createElement('input');
    secInput.type = 'number';
    secInput.min = '1';
    secInput.max = '3600';
    secInput.value = '5';
    secInput.className = 'device-card__input';
    secInput.title = 'Segundos';
    secInput.setAttribute('aria-label', 'Segundos de dosagem');

    const secUnit = document.createElement('span');
    secUnit.className = 'device-card__time-unit';
    secUnit.textContent = 'seg';

    timeField.appendChild(secInput);
    timeField.appendChild(secUnit);
    panel.appendChild(timeField);

    const setButtons = ['sabao', 'floral', 'sport'].map((kind) => {
      const kindLabel = TEMPO_LABELS[kind] || kind;
      return btn(kindLabel, 'btn--ghost', () => {
        const seconds = parseFloat(secInput.value) || 5;
        runAction(
          `Ajuste dosadora ${id}`,
          () =>
            apiCall('POST', `/doser/${id}/settime/${kind}`, { seconds }),
          {
            action: 'doser_settime',
            label: `Ajuste de tempo · dosadora ${id} · ${kindLabel}`,
            confirmHeading: 'Confirmar ajuste',
            confirmMessage: 'Revise os dados abaixo e confirme o ajuste de tempo.',
            confirmRows: [
              ['Equipamento', `Dosadora ${id}`],
              ['Produto', kindLabel],
              ['Tempo', `${seconds} seg`],
            ],
            method: 'POST',
            path: `/doser/${id}/settime/${kind}`,
            payload: { seconds },
            device_type: 'doser',
            device_id: String(id),
          }
        );
      });
    });
    appendActionGrid(panel, 3, setButtons);
    actions.appendChild(panel);
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
        (actions, _card, ctx) => buildDoserCardContent(actions, id, ctx),
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
    $('confirmOk').addEventListener('click', hideActionConfirm);
    $('confirmModal').querySelector('.confirm-modal__backdrop')?.addEventListener('click', hideActionConfirm);
    $('actionPromptOk').addEventListener('click', () => hideActionPrompt(true));
    $('actionPromptCancel').addEventListener('click', () => hideActionPrompt(false));
    $('actionPromptModal')
      .querySelector('[data-action-prompt-dismiss]')
      ?.addEventListener('click', () => hideActionPrompt(false));
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (!$('actionPromptModal').classList.contains('hidden')) {
        hideActionPrompt(false);
        return;
      }
      if (!$('confirmModal').classList.contains('hidden')) {
        hideActionConfirm();
      }
    });
  }

  function startLiveStatusWatch() {
    if (stopHeartbeatWatch) stopHeartbeatWatch();
    stopHeartbeatWatch = watchStoreHeartbeat(
      pageStore,
      catalog,
      (status) => {
        applyStatus(status);
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
    window.location.href = `index.html?blocked=${encodeURIComponent(pageStore)}`;
  }

  async function init() {
    lav60Debug('store', 'init', { pageStore, href: window.location.href });
    if (!pageStore) {
      window.location.href = 'index.html';
      return;
    }

    initEvents();
    initAuthUi();
    initDeviceLocks();

    try {
      catalog = await loadCatalog();
      storeMeta = findStoreInCatalog(catalog, pageStore);

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
        showToast('Agente exige token — configure API_TOKEN no .env do servidor', false);
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
