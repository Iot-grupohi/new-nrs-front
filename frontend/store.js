(() => {
  'use strict';

  const {
    loadCatalog,
    findStoreInCatalog,
    loadStoreCached,
    getCachedStoreEntry,
    configFromStatus,
    configFromStatusCacheDoc,
    statusFromStatusCacheDoc,
    fetchStoreStatusCache,
    resolveAgentEndpointFromStatusCache,
    fetchAgentConfig,
    agentRequest,
    resolveAgentEndpoint,
    discoverAgentEndpoint,
    resolveAgentEndpointForStore,
    statusFromHeartbeatPayload,
    fetchHeartbeatsSnapshot,
    watchStoreHeartbeat,
    fetchStoreStatusFromHeartbeat,
    probePowpayHealth,
    ensureDefaultAgentToken,
    isAgentTokenConfiguredOnServer,
    shouldUsePanelAgentProxy,
    getPollIntervalMs,
    normalizeStoreId,
    noAgentMessage,
    isAgentUnavailableError,
    isHeartbeatEntryAlive,
    networkPayloadHasDevices,
    lav60Debug,
    WASHER_DOSAGE_OPTIONS,
    friendlyUserMessage,
    formatOperatorError,
    findMachineMeta,
    mergeMachinesCatalog,
    enrichDoserMeta,
    canOperateMachineStatus,
    machineMetaFacts,
    deviceUnifiedStatus,
    syncConfigDevices,
    isDeviceVisibleInFrontend,
    applyFrontendDeviceVisibility,
    resolveDeviceOnline,
    isStoreLav60Suspended,
    isAgentsDisabled,
    isPowpayHealthPanel,
    isRtdbOnlyPanel,
    dryerMinuteChoices,
    dryerChoicePickerColumns,
    dryerChoiceRequireSelection,
    fetchPortalMachinesCatalog,
  } = window.Lav60;

  const pageStoreFromUrl = () =>
    normalizeStoreId(new URLSearchParams(window.location.search).get('store'));

  let pageStore = pageStoreFromUrl();
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
  let agentStatusPollTimer = null;
  let pingStatus = null;
  let lastNetworkStatusSource = null;
  let storeAgentReady = false;
  let storeAgentChecking = false;
  let storeAgentCheckedAt = null;
  let storeAgentError = null;
  let storeHeartbeatAlive = false;
  const probingDevices = new Set();
  const activeProbeGroups = new Set();
  let probeGeneration = 0;
  let probeQueueRunner = null;
  let storeStatusBarReady = false;

  const STATUS_PATHS = {
    washer: (id) => `status/washer/${id}`,
    dryer: (id) => `status/dryer/${id}`,
    doser: (id) => `status/doser/${id}`,
    ac: () => 'status/ac',
  };

  const GROUP_REFRESH_LABELS = {
    washer: 'Lavadoras',
    dryer: 'Secadoras',
    doser: 'Dosadoras',
    ac: 'Ar condicionado',
  };

  const $ = (id) => document.getElementById(id);

  const confirmUI = Lav60DeviceUI.createConfirmUI({
    $,
    onToast: (message, ok = true) => showToast(message, ok),
    formatError: (label, message) => formatOperatorError(label, message),
  });
  const { confirmAction, showActionConfirm, showActionError, hideActionConfirm, bindConfirmEvents } = confirmUI;

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

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

  function storeAgentMetaSuffix() {
    const parts = [];
    if (storeAgentCheckedAt) parts.push(formatCacheAge(storeAgentCheckedAt));
    return parts.length ? ` · ${parts.join(' · ')}` : '';
  }

  function updateStoreAgentMeta(state, detail = '') {
    const el = $('storeAgentMeta');
    const hint = $('storeAgentHint');
    if (!el) return;
    el.className = 'gateway-meta';
    const code = pageStore.toUpperCase();
    if (!state) {
      el.textContent = 'Agente: —';
      if (hint) hint.textContent = 'Use ↻ em cada equipamento para verificar o status na rede local';
      updateStoreStatusButtons();
      return;
    }
    if (state === 'waiting') {
      el.textContent = `Agente: aguardando (${code})`;
      el.classList.add('gateway-meta--warn');
      if (hint) hint.textContent = 'Use ↻ em cada equipamento ou “Atualizar equipamentos”';
    } else if (state === 'checking') {
      el.textContent = `Agente: verificando (${code})…`;
      el.classList.add('gateway-meta--warn');
      if (hint) hint.textContent = 'Consultando túnel Cloudflare / agente local…';
    } else if (state === 'online') {
      el.textContent = `Agente: online (${code})${storeAgentMetaSuffix()}`;
      el.classList.add('gateway-meta--ok');
      if (hint) hint.textContent = 'Túnel respondendo — verifique cada equipamento com ↻';
    } else if (state === 'offline') {
      el.textContent = detail || `Agente: offline (${code})${storeAgentMetaSuffix()}`;
      el.classList.add('gateway-meta--err');
      if (hint) hint.textContent = 'Túnel ou agente sem resposta — tente “Verificar agente”';
    } else {
      el.textContent = 'Agente: —';
    }
    updateStoreStatusButtons();
  }

  function updateStoreStatusButtons() {
    const verifyBtn = $('btnVerifyStoreAgent');
    const devicesBtn = $('btnRefreshStoreDevices');
    const batchProbing = Boolean(probeQueueRunner);
    const canProbe = Boolean(config && storeAgentReady && !storeAgentChecking);
    if (verifyBtn) {
      verifyBtn.disabled = !config || storeAgentChecking;
      verifyBtn.textContent = storeAgentChecking ? 'Verificando…' : 'Verificar agente';
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

  function deviceEndpointPath(deviceType, machine) {
    const build = STATUS_PATHS[deviceType];
    return build ? build(machine) : '';
  }

  function deviceProbeKey(deviceType, machine) {
    return machine ? `${deviceType}:${machine}` : deviceType;
  }

  function isDeviceProbing(deviceType, machine) {
    return probingDevices.has(deviceProbeKey(deviceType, machine));
  }

  function canRefreshDevice(deviceType, machine) {
    if (!config || !storeAgentReady || storeAgentChecking) return false;
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

  function resetPingStatus() {
    if (!config?.devices) {
      pingStatus = { washers: {}, dryers: {}, dosers: {}, ac: null };
      return;
    }
    pingStatus = {
      washers: Object.fromEntries((config.devices.washers || []).map((id) => [id, null])),
      dryers: Object.fromEntries((config.devices.dryers || []).map((id) => [id, null])),
      dosers: Object.fromEntries((config.devices.dosers || []).map((id) => [id, null])),
      ac: config.devices.ac ? null : null,
    };
  }

  function rebuildPingStatusFromConfig() {
    const prev = pingStatus || {};
    if (!config?.devices) {
      resetPingStatus();
      return;
    }
    pingStatus = {
      washers: Object.fromEntries(
        (config.devices.washers || []).map((id) => [id, prev.washers?.[id] ?? null])
      ),
      dryers: Object.fromEntries(
        (config.devices.dryers || []).map((id) => [id, prev.dryers?.[id] ?? null])
      ),
      dosers: Object.fromEntries(
        (config.devices.dosers || []).map((id) => [id, prev.dosers?.[id] ?? null])
      ),
      ac: prev.ac ?? null,
    };
  }

  function pingStatusHasAnyResult() {
    if (!pingStatus) return false;
    const lists = [pingStatus.washers, pingStatus.dryers, pingStatus.dosers];
    for (const map of lists) {
      if (Object.values(map || {}).some((v) => v !== null)) return true;
    }
    return pingStatus.ac !== null;
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

  async function agentProbeRequest(method, path, body) {
    try {
      const data = await apiCall(method, path, body, { allowHttpError: true, validateOperation: false });
      return { ok: data._httpOk !== false, status: data._httpStatus || 200, data };
    } catch (e) {
      return { ok: false, status: 0, data: { detail: e?.message || String(e) } };
    }
  }

  function setDeviceOnlineState(deviceType, machine, online) {
    if (!pingStatus) resetPingStatus();
    if (online !== true && online !== false) return;
    if (deviceType === 'ac') pingStatus.ac = online;
    else pingStatus[`${deviceType}s`][machine] = online;
  }

  function networkValueToOnline(value) {
    if (value === true || value === false) return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'object' && value != null) {
      if (typeof value.online === 'boolean') return value.online;
      const status = typeof value.status === 'string' ? value.status.trim().toLowerCase() : '';
      if (status === 'online') return true;
      if (status === 'offline') return false;
    }
    return Boolean(value);
  }

  function lookupNetworkValue(block, id) {
    if (!block || typeof block !== 'object') return undefined;
    const norm = normalizeStoreId(id);
    if (Object.prototype.hasOwnProperty.call(block, id)) return block[id];
    if (Object.prototype.hasOwnProperty.call(block, norm)) return block[norm];
    const match = Object.entries(block).find(([key]) => normalizeStoreId(key) === norm);
    return match ? match[1] : undefined;
  }

  /** Espelha mapas washers/dryers/dosers/ac do heartbeat RTDB no pingStatus (mesma fonte do card das lojas). */
  function seedPingStatusFromNetworkStatus(source) {
    if (!source || typeof source !== 'object') return false;
    const hasNetwork =
      (source.washers && Object.keys(source.washers).length) ||
      (source.dryers && Object.keys(source.dryers).length) ||
      (source.dosers && Object.keys(source.dosers).length) ||
      source.ac != null;
    if (!hasNetwork) return false;

    if (!pingStatus) {
      if (config?.devices) rebuildPingStatusFromConfig();
      else resetPingStatus();
    }
    if (!pingStatus) return false;

    let seeded = false;
    const applyBlock = (deviceType, block, catalogIds) => {
      const key = `${deviceType}s`;
      const targets = Array.isArray(catalogIds) && catalogIds.length ? catalogIds : Object.keys(block || {});
      targets.forEach((rawId) => {
        const id = String(rawId);
        const value = lookupNetworkValue(block, id);
        if (value === undefined) return;
        if (!pingStatus[key]) pingStatus[key] = {};
        pingStatus[key][id] = networkValueToOnline(value);
        seeded = true;
      });
    };

    if (config?.devices) {
      applyBlock('washer', source.washers, config.devices.washers);
      applyBlock('dryer', source.dryers, config.devices.dryers);
      applyBlock('doser', source.dosers, config.devices.dosers);
      if (config.devices.ac || source.ac != null) {
        pingStatus.ac = networkValueToOnline(source.ac);
        seeded = true;
      }
    } else {
      applyBlock('washer', source.washers);
      applyBlock('dryer', source.dryers);
      applyBlock('doser', source.dosers);
      if (source.ac != null) {
        pingStatus.ac = networkValueToOnline(source.ac);
        seeded = true;
      }
    }
    return seeded;
  }

  function storeAgentMetaStateFromContext() {
    if (storeAgentChecking) return 'checking';
    if (isRtdbOnlyPanel(catalog)) {
      if (storeHeartbeatAlive) return 'online';
      if (storeAgentReady) return 'offline';
      return 'waiting';
    }
    if (pingStatusHasAnyResult() || statusData?.summary?.total) return 'online';
    if (storeAgentReady) return 'waiting';
    return 'waiting';
  }

  function syncStoreHeartbeatAlive(entry, cat) {
    if (!isRtdbOnlyPanel(cat)) return;
    storeHeartbeatAlive = Boolean(entry && isHeartbeatEntryAlive(entry, cat));
  }

  function updateStoreAgentMetaFromContext(detail = '') {
    updateStoreAgentMeta(storeAgentMetaStateFromContext(), detail);
  }

  function updateSummaryWidgets(summary, timestamp) {
    const on = summary?.online ?? 0;
    const tot = summary?.total ?? 0;
    const pct = healthPercent(summary);
    $('summaryOnline').textContent = on;
    $('summaryTotal').textContent = `de ${tot} total`;
    $('summaryHealth').textContent = `${pct}%`;
    $('summaryHealthBar').style.width = `${pct}%`;
    if (timestamp) {
      $('summaryTime').textContent = formatTime(timestamp);
    }
  }

  function updateSummaryFromPingStatus() {
    if (!pingStatus || !config) return;
    let on = 0;
    let total = 0;
    ['washers', 'dryers', 'dosers'].forEach((key) => {
      Object.values(pingStatus[key] || {}).forEach((value) => {
        total += 1;
        if (value === true) on += 1;
      });
    });
    if (config.devices?.ac || pingStatus.ac !== null) {
      total += 1;
      if (pingStatus.ac === true) on += 1;
    }
    const summary = { online: on, total, offline: total - on };
    updateSummaryWidgets(summary, new Date().toISOString());
    if (statusData) {
      statusData.summary = summary;
      statusData.timestamp = new Date().toISOString();
    }
    updateStoreHeader(statusData || { summary, timestamp: new Date().toISOString() });
  }

  function deviceOnline(deviceType, id) {
    if (isDeviceProbing(deviceType, id)) return null;
    if (deviceType === 'ac') return pingStatus?.ac ?? null;
    return pingStatus?.[`${deviceType}s`]?.[id] ?? null;
  }

  function markDeviceOffline(deviceType, id) {
    if (!id) return;
    setDeviceOnlineState(deviceType, id, false);
    if (uiReady) {
      updateSummaryFromPingStatus();
      renderDevices();
    }
  }

  function isDeviceUnreachableError(error) {
    const msg = String(error?.message || error || '').toLowerCase();
    return (
      msg.includes('não respondeu') ||
      msg.includes('did not respond') ||
      msg.includes('timeout') ||
      msg.includes('unreachable') ||
      msg.includes('sem resposta') ||
      msg.includes('offline')
    );
  }

  function showOperatorError(label, error, options = {}) {
    const msg = error?.message || String(error || '');
    const formatted = formatOperatorError(label, msg);
    if (options.modal !== false && typeof showActionError === 'function') {
      showActionError(label, formatted, options.rows || []);
      return;
    }
    showToast(formatted, false);
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
    const codeLower = pageStore.toLowerCase();
    $('storeTitle').textContent = name;
    $('storeCode').textContent = code;
    if ($('storeHeroTitle')) $('storeHeroTitle').textContent = name;
    if ($('storeHeroTunnel')) $('storeHeroTunnel').textContent = `${codeLower}.powpay.com.br`;
    const get02Link = $('storeGet02Link');
    if (get02Link && pageStore) {
      const sid = encodeURIComponent(pageStore);
      if (document.getElementById('appView')) {
        get02Link.href = `index.html?store=${sid}#/agent-get02`;
        get02Link.dataset.route = 'agent-get02';
      } else {
        get02Link.href = `gateway.html?store=${sid}`;
        delete get02Link.dataset.route;
      }
    }
    if ($('footerStore')) {
      $('footerStore').textContent = `LAV60 · ${name}`;
    }
    document.title = `LAV60 — GET01 · ${name}`;
    window.Lav60PortalLayout?.setPageTitle?.(`LAV60 — GET01 · ${name}`);

    let subtitle = 'GET01 — Aguardando status do agente…';
    if (status) {
      const summary = status.summary || {};
      const tot = summary.total ?? 0;
      const when = formatTime(status.timestamp);
      subtitle = tot > 0 ? `GET01 · Última leitura · ${when}` : `GET01 · Atualizado · ${when}`;
    }
    $('storeSubtitle').textContent = subtitle;
    if ($('storeHeroDesc')) {
      $('storeHeroDesc').textContent = `Operação via túnel Cloudflare · ${subtitle.replace(/^GET01 ·?\s?/, '')}`;
    }
  }

  function ensureTokenIfRequired() {
    if (!config?.token_required) return true;
    if (agentToken) return true;
    if (shouldUsePanelAgentProxy(pageStore) && isAgentTokenConfiguredOnServer()) return true;
    showToast('Autenticação do agente indisponível. Contacte o suporte.', false);
    return false;
  }

  async function apiCall(method, path, body, options = {}) {
    if (!ensureTokenIfRequired()) {
      throw new Error('Acesso negado — verifique o token');
    }
    const ep = agentEndpoint || resolveAgentEndpoint(storeMeta, catalog, config);
    return agentRequest(storeMeta, catalog, agentToken, method, path, body, ep, options);
  }

  async function probeDeviceOnline(deviceType, machine, options = {}) {
    const { silent = false, generation = probeGeneration, ignoreGeneration = false } = options;
    if (!config) return;
    const path = deviceEndpointPath(deviceType, machine);
    if (!path) return;

    const key = deviceProbeKey(deviceType, machine);
    const label = devicePingLabel(deviceType, machine);
    probingDevices.add(key);
    updateStoreStatusButtons();
    renderDevices();

    let resolved = null;

    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        if (!ignoreGeneration && generation !== probeGeneration) return;

        const result = await agentProbeRequest('GET', path);
        if (!ignoreGeneration && generation !== probeGeneration) return;

        const online = extractOnlineFromProbeResult(result);
        if (online === true || online === false) {
          resolved = online;
          setDeviceOnlineState(deviceType, machine, online);
          break;
        }

        if (attempt === 0 && isEspTimeoutResult(result)) {
          await sleep(400);
          continue;
        }
        break;
      }

      if (!silent && resolved === true) showToast(`${label} — online`);
      else if (!silent && resolved === false) showToast(`${label} — offline`, false);
    } catch (err) {
      if (!ignoreGeneration && generation !== probeGeneration) return;
      if (!silent) showToast(`${label}: ${friendlyUserMessage(err.message)}`, false);
    } finally {
      probingDevices.delete(key);
      if (!ignoreGeneration && generation !== probeGeneration) return;
      updateSummaryFromPingStatus();
      renderDevices();
      updateStoreStatusButtons();
    }
  }

  function collectDeviceProbeJobs(deviceTypes = null) {
    if (!config?.devices) return [];
    const allowed = Array.isArray(deviceTypes) && deviceTypes.length
      ? new Set(deviceTypes.map((t) => String(t || '').toLowerCase()))
      : null;
    const include = (type) => !allowed || allowed.has(type);
    const jobs = [];
    if (include('washer')) {
      (config.devices.washers || []).forEach((id) => jobs.push({ deviceType: 'washer', machine: id }));
    }
    if (include('dryer')) {
      (config.devices.dryers || []).forEach((id) => jobs.push({ deviceType: 'dryer', machine: id }));
    }
    if (include('doser')) {
      (config.devices.dosers || []).forEach((id) => jobs.push({ deviceType: 'doser', machine: id }));
    }
    if (include('ac') && config.devices.ac) {
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
      if (generation === probeGeneration) {
        updateSummaryFromPingStatus();
        renderDevices();
      }
    } catch {
      /* fila cancelada */
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

  async function startBackgroundDeviceProbes({ force = false, deviceTypes = null } = {}) {
    if (!config) return Promise.resolve();
    const jobs = collectDeviceProbeJobs(deviceTypes);
    if (!jobs.length) return Promise.resolve();

    probeGeneration += 1;
    const generation = probeGeneration;
    const scoped = Array.isArray(deviceTypes) && deviceTypes.length > 0;
    if (!scoped) probingDevices.clear();
    jobs.forEach((job) => activeProbeGroups.add(job.deviceType));
    rebuildPingStatusFromConfig();
    renderDevices();
    updateStoreStatusButtons();
    return runProbeQueue(generation, jobs);
  }

  async function refreshStoreDevice(deviceType, machine) {
    const dtype = String(deviceType || '').toLowerCase();
    if (!dtype) return;
    if (!canRefreshDevice(dtype, machine)) return;
    await probeDeviceOnline(dtype, machine, { silent: false, ignoreGeneration: true });
  }

  async function refreshStoreDevices() {
    if (!config || storeAgentChecking) return;
    try {
      await startBackgroundDeviceProbes({ force: true });
      if (!probeQueueRunner && probingDevices.size === 0) {
        showToast('Status dos equipamentos atualizado');
      }
    } catch {
      showToast('Falha ao verificar equipamentos', false);
    }
  }

  async function refreshStoreDeviceGroup(deviceType) {
    const dtype = String(deviceType || '').toLowerCase();
    if (!GROUP_REFRESH_LABELS[dtype]) return;
    if (!config || storeAgentChecking) return;
    if (probingDevices.size > 0 || probeQueueRunner) return;
    try {
      await startBackgroundDeviceProbes({ force: true, deviceTypes: [dtype] });
      if (!probeQueueRunner && probingDevices.size === 0) {
        showToast(`Status · ${GROUP_REFRESH_LABELS[dtype]} atualizado`);
      }
    } catch {
      showToast(`Falha ao verificar ${GROUP_REFRESH_LABELS[dtype].toLowerCase()}`, false);
    }
  }

  async function verifyStoreAgent() {
    if (storeAgentChecking || !config) return false;
    storeAgentChecking = true;
    updateStoreAgentMeta('checking');
    try {
      let ok = false;
      const ping = await agentProbeRequest('GET', 'ping-status');
      if (ping.ok) {
        const online = extractOnlineFromProbeResult(ping);
        ok = online !== false;
      }
      if (!ok) {
        const net = await agentProbeRequest('GET', '/api/network-status');
        ok = net.ok;
      }
      storeAgentCheckedAt = Date.now();
      storeAgentReady = true;
      storeAgentError = ok ? null : 'Agente sem resposta';
      updateStoreAgentMeta(ok ? 'online' : 'offline', storeAgentError || '');
      showToast(ok ? 'Agente online' : 'Agente offline ou sem resposta', ok);
      return ok;
    } catch (e) {
      storeAgentError = friendlyUserMessage(e.message);
      updateStoreAgentMeta('offline', storeAgentError);
      showToast(storeAgentError, false);
      return false;
    } finally {
      storeAgentChecking = false;
      updateStoreStatusButtons();
    }
  }

  function bindStoreStatusBarEvents() {
    if (storeStatusBarReady) return;
    storeStatusBarReady = true;
    $('btnVerifyStoreAgent')?.addEventListener('click', () => {
      void verifyStoreAgent();
    });
    $('btnRefreshStoreDevices')?.addEventListener('click', () => {
      void refreshStoreDevices();
    });
    $('devicesPanel')?.addEventListener('click', (e) => {
      const deviceBtn = e.target.closest('[data-refresh-device]');
      if (deviceBtn && !deviceBtn.disabled) {
        const parsed = parseDeviceRefreshKey(deviceBtn.dataset.refreshDevice);
        if (parsed) {
          e.preventDefault();
          void refreshStoreDevice(parsed.deviceType, parsed.machine);
        }
        return;
      }
      const btn = e.target.closest('[data-refresh-group]');
      if (!btn || btn.disabled) return;
      void refreshStoreDeviceGroup(btn.dataset.refreshGroup);
    });
  }

  function applyStatus(data, options = {}) {
    const acId = catalog?.ac_id || '110';
    let payload = data ? { ...data } : data;
    if (payload) {
      const merged = mergeMachinesCatalog(config?.machines, payload.machines);
      if (merged.length) payload.machines = merged;
    }
    const networkSource = data && typeof data === 'object' ? data : null;
    // Mapas de rede (washers/dryers/dosers) são necessários para exibir TITAN (321/210/321)
    // em isDeviceVisibleInFrontend — o card das lojas usa a mesma regra do dashboard.
    statusData = payload ? applyFrontendDeviceVisibility(payload, acId) : payload;
    if (config) {
      if (statusData?.machines?.length) {
        config.machines = statusData.machines;
      }
      syncConfigDevices(config, statusData);
      rebuildPingStatusFromConfig();
    } else if (statusData?.summary?.total || statusData?.machines?.length) {
      config = configFromStatus(statusData);
      rebuildPingStatusFromConfig();
    }

    if (networkSource && networkPayloadHasDevices(networkSource)) {
      if (seedPingStatusFromNetworkStatus(networkSource)) {
        lastNetworkStatusSource = networkSource;
      }
    }

    if (pingStatusHasAnyResult()) {
      updateSummaryFromPingStatus();
    } else if (statusData?.summary) {
      updateSummaryWidgets(statusData.summary, statusData.timestamp);
      updateStoreHeader(statusData);
    } else {
      updateStoreHeader(statusData);
    }

    if (options.render !== false && uiReady) {
      renderDevices();
    }
    updateStoreStatusButtons();
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

  async function supplementMachinesFromPortal() {
    const portal = await fetchPortalMachinesCatalog(pageStore);
    if (!portal.length) return false;
    const merged = mergeMachinesCatalog(config?.machines, statusData?.machines, portal);
    if (!merged.length) return false;
    if (config) config.machines = merged;
    if (statusData) {
      statusData.machines = merged;
      applyStatus(statusData, { render: uiReady });
    } else if (config) {
      syncConfigDevices(config, statusData);
      rebuildPingStatusFromConfig();
      if (uiReady) renderDevices();
    }
    return true;
  }

  async function loadConfig() {
    if (!agentEndpoint || agentEndpoint.unmatched) {
      agentEndpoint = await resolveAgentEndpointForStore(storeMeta, catalog, agentToken);
    }
    if (agentEndpoint?.unmatched) {
      throw new Error(noAgentMessage(pageStore));
    }
    config = await fetchAgentConfig(storeMeta, catalog, agentToken, agentEndpoint);
    const portal = await fetchPortalMachinesCatalog(pageStore);
    const merged = mergeMachinesCatalog(config.machines, statusData?.machines, portal);
    if (merged.length) {
      config.machines = merged;
      if (statusData) statusData.machines = merged;
    }
    syncConfigDevices(config, statusData || config.last_network_check);
    rebuildPingStatusFromConfig();
    if (lastNetworkStatusSource) seedPingStatusFromNetworkStatus(lastNetworkStatusSource);
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
    const operable = online === true && canOperateMachine(meta, true);

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
      statusEl.textContent = operable
        ? ''
        : online === null
          ? 'Aguardando'
          : deviceUnifiedStatus(online, meta).label;
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
    const online = deviceOnline('dryer', dryerId);
    return syncDryerCardControls(card, meta, online);
  }

  function syncWasherCardControls(card, meta, online) {
    const washerId = card.dataset.washerId;
    const remaining = getWasherLockRemainingMs(washerId);
    const statusEl = card.querySelector('.device-card__cycle-status');
    const unlockBtn = card.querySelector('.device-card__unlock');
    const releaseBtn = card.querySelector('button[data-washer-release]');
    const choiceButtons = card.querySelectorAll('.device-card__choice');
    const operable = online === true && canOperateMachine(meta, true);

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
      statusEl.textContent = operable
        ? ''
        : online === null
          ? 'Aguardando'
          : deviceUnifiedStatus(online, meta).label;
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
    const online = deviceOnline('washer', washerId);
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
      const data = await apiCall('POST', `/dryer/${id}`, { minutes }, {
        operationKind: 'dryer_release',
        verifyRelease: true,
      });
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
      showOperatorError(`Secadora ${id}`, e, {
        rows: [
          ['Equipamento', `Secadora ${id}`],
          ['Tempo', `${minutes} min`],
        ],
      });
      if (isDeviceUnreachableError(e)) markDeviceOffline('dryer', id);
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
      const data = await apiCall('POST', `/washer/${id}`, am ? { am } : {}, {
        operationKind: 'washer_release',
        verifyRelease: true,
      });
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
      showOperatorError(`Lavadora ${id}`, e, {
        rows: [['Equipamento', `Lavadora ${id}`]],
      });
      if (isDeviceUnreachableError(e)) markDeviceOffline('washer', id);
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
    setSectionCount('washersCount', pingStatus?.washers);
    visibleDeviceIds('washer', config.devices.washers).forEach((id) => {
      const meta = getMachineMeta(id, 'washer', getMachinesCatalog());
      const online = deviceOnline('washer', id);
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
        meta,
        deviceCardRefreshOptions('washer', id)
      );
      card.dataset.washerId = id;
      grid.appendChild(card);
      if (online !== null) {
        syncWasherCardControls(card, meta, online);
      }
    });
  }

  function renderDryers() {
    const grid = $('dryersGrid');
    grid.innerHTML = '';
    if (!config) return;
    setSectionCount('dryersCount', pingStatus?.dryers);
    visibleDeviceIds('dryer', config.devices.dryers).forEach((id) => {
      const meta = getMachineMeta(id, 'dryer', getMachinesCatalog());
      const online = deviceOnline('dryer', id);
      const card = createDeviceCard(
        id,
        online,
        (actions, _card, ctx) => {
          actions.classList.add('device-card__actions--dryer');

          const statusEl = document.createElement('p');
          statusEl.className = 'device-card__cycle-status';
          statusEl.setAttribute('aria-live', 'polite');
          actions.appendChild(statusEl);

          const minuteOptions = dryerMinuteChoices(meta, config.dryer_minutes);
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

          const unlockBtn = btn('Ativar botões', 'btn--ghost device-card__unlock', () =>
            clearDryerLock(id)
          );
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
      if (online !== null) {
        syncDryerCardControls(card, meta, online);
      }
    });
  }

  function renderDosers() {
    const grid = $('dosersGrid');
    grid.innerHTML = '';
    if (!config) return;
    setSectionCount('dosersCount', pingStatus?.dosers);
    visibleDeviceIds('doser', config.devices.dosers).forEach((id) => {
      const catalog = getMachinesCatalog();
      const meta = enrichDoserMeta(getMachineMeta(id, 'doser', catalog), id, catalog);
      const online = deviceOnline('doser', id);
      const card = createDeviceCard(
        id,
        online,
        (actions, _card, ctx) => buildDoserCardContent(actions, id, ctx, runAction, doserCardApi),
        meta,
        deviceCardRefreshOptions('doser', id)
      );
      card.classList.add('device-card--doser');
      grid.appendChild(card);
    });
  }

  function renderAc() {
    const panel = $('acPanel');
    panel.innerHTML = '';
    if (!config) return;
    const online = deviceOnline('ac', null);
    if (pingStatus?.ac === null) {
      $('acCount').textContent = '—';
    } else {
      $('acCount').textContent = online ? '1/1 online' : '0/1 online';
    }

    panel.appendChild(
      createDeviceCard(
        'AC',
        online,
        (actions, _card, ctx) => {
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
      },
        null,
        deviceCardRefreshOptions('ac', null)
      )
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
    if (!window.Lav60Auth || !$('headerUserMenu')) return;
    Lav60Auth.authEnabled().then(async (enabled) => {
      if (!enabled) return;
      await Lav60Auth.mountUserMenu($('headerUserMenu'));
    });
  }

  function initEvents() {
    bindConfirmEvents();
    bindStoreStatusBarEvents();
  }

  function startLiveStatusWatch() {
    if (stopHeartbeatWatch) stopHeartbeatWatch();
    stopHeartbeatWatch = watchStoreHeartbeat(
      pageStore,
      catalog,
      (nextStatus, hbMeta) => {
        if (hbMeta && (hbMeta.entry || hbMeta.alive != null || hbMeta.payload)) {
          syncStoreHeartbeatAlive(
            hbMeta.entry || {
              payload: hbMeta.payload,
              received_at: hbMeta.receivedAt,
              alive: hbMeta.alive,
            },
            catalog
          );
          updateStoreAgentMetaFromContext();
        }
        updateStoreSuspendedBanner(storeMeta, hbMeta?.payload || hbMeta);
        if (nextStatus?.summary?.total) {
          applyStatus(nextStatus, { render: uiReady });
        }
        lav60Debug('store', 'heartbeat SSE', nextStatus?.summary);
      },
      { skipInitialBootstrap: true, skipInitialPoll: false }
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

  function startAgentStatusPolling() {
    if (agentStatusPollTimer) return;
    const intervalMs = getPollIntervalMs(catalog);
    agentStatusPollTimer = setInterval(() => {
      void refreshStatus({ force: false });
    }, intervalMs);
  }

  function stopAgentStatusPolling() {
    if (!agentStatusPollTimer) return;
    clearInterval(agentStatusPollTimer);
    agentStatusPollTimer = null;
  }

  function renderStoreUiFromContext() {
    if (pingStatusHasAnyResult()) {
      updateSummaryFromPingStatus();
    } else if (statusData?.summary) {
      updateSummaryWidgets(statusData.summary, statusData.timestamp);
      updateStoreHeader(statusData);
    } else {
      updateStoreHeader(statusData);
    }
    renderDevices();
    updateStoreStatusButtons();
  }

  function applyStatusCacheBootstrap(doc, options = {}) {
    if (!doc?.hit) return false;
    let applied = false;
    const skipNetwork = options.skipNetwork === true;
    if (!skipNetwork) {
      const status = statusFromStatusCacheDoc(storeMeta, doc, pageStore);
      if (status?.summary?.total) {
        applyStatus(status, options);
        applied = true;
      }
    }
    if (doc.config_fresh && doc.config_snapshot) {
      const snapConfig = configFromStatusCacheDoc(doc.config_snapshot);
      if (snapConfig) {
        config = {
          ...snapConfig,
          machines: mergeMachinesCatalog(
            snapConfig.machines,
            config?.machines,
            statusData?.machines
          ),
        };
        syncConfigDevices(config, statusData);
        applied = true;
      }
    }
    return applied;
  }

  function finishStoreReady(heartbeatAlive, agentReachable) {
    const configStore = normalizeStoreId(config?.store);
    if (agentEndpoint?.unmatched || (configStore && configStore !== pageStore)) {
      redirectToDashboard('config_store_mismatch', {
        configStore,
        pageStore,
        agentEndpoint,
      });
      return false;
    }

    uiReady = true;
    storeAgentReady = true;
    rebuildPingStatusFromConfig();
    if (lastNetworkStatusSource) seedPingStatusFromNetworkStatus(lastNetworkStatusSource);
    updateStoreAgentMetaFromContext();
    renderStoreUiFromContext();

    lav60Debug('store', 'ready — staying on store page');

    if (
      config?.token_required &&
      !agentToken?.trim() &&
      !(shouldUsePanelAgentProxy(pageStore) && isAgentTokenConfiguredOnServer())
    ) {
      showToast('Autenticação do agente indisponível. Contacte o suporte.', false);
    }

    if (heartbeatAlive) {
      startLiveStatusWatch();
    }
    return true;
  }

  async function init() {
    pageStore = pageStoreFromUrl();
    lav60Debug('store', 'init', { pageStore, href: window.location.href });
    if (!pageStore) {
      window.location.href = document.getElementById('appView')
        ? 'index.html#/lojas'
        : 'index.html#/lojas';
      return;
    }

    if (isAgentsDisabled(null)) {
      window.location.replace(
        document.getElementById('appView') ? 'index.html#/agent-get01' : 'index.html#/agent-get01'
      );
      return;
    }

    if (!document.getElementById('appView')) {
      window.Lav60AgentNav?.render?.('get01');
    }
    const get02Link = $('storeGet02Link');
    if (get02Link && pageStore) {
      const sid = encodeURIComponent(pageStore);
      if (document.getElementById('appView')) {
        get02Link.href = `index.html?store=${sid}#/agent-get02`;
      } else {
        get02Link.href = `gateway.html?store=${sid}`;
      }
    }

    initEvents();
    initAuthUi();
    initDeviceLocks();

    try {
      catalog = await loadCatalog();
      storeMeta = findStoreInCatalog(catalog, pageStore);
      updateStoreSuspendedBanner(storeMeta, null);

      agentToken = await ensureDefaultAgentToken();

      const [hbSnap, statusCache, cached] = await Promise.all([
        fetchHeartbeatsSnapshot({ force: true, lite: false }).catch((e) => {
          lav60Debug('store', 'heartbeat unavailable', e?.message || e);
          return null;
        }),
        fetchStoreStatusCache(pageStore, catalog),
        getCachedStoreEntry(storeMeta, catalog),
      ]);

      let heartbeatEntry = null;
      let heartbeatAlive = false;
      let heartbeatBootstrapped = false;
      if (hbSnap?.heartbeats) {
        heartbeatEntry = hbSnap.heartbeats[pageStore];
        heartbeatAlive = isHeartbeatEntryAlive(heartbeatEntry, catalog);
        syncStoreHeartbeatAlive(heartbeatEntry, catalog);
        lav60Debug('store', 'heartbeat', {
          entry: heartbeatEntry,
          alive: heartbeatAlive,
          timeout: catalog.heartbeat_timeout_seconds || 120,
        });
        if (heartbeatEntry) {
          const status = statusFromHeartbeatPayload(
            storeMeta,
            heartbeatEntry.payload || heartbeatEntry,
            pageStore
          );
          if (status?.summary?.total) {
            if (!config) config = configFromStatus(status);
            applyStatus(status, { render: false });
            heartbeatBootstrapped = true;
            updateStoreSuspendedBanner(storeMeta, heartbeatEntry);
            lav60Debug('store', 'status from heartbeat', status.summary);
          }
          if (
            typeof probePowpayHealth === 'function' &&
            isPowpayHealthPanel(catalog) &&
            !isRtdbOnlyPanel(catalog)
          ) {
            const health = await probePowpayHealth(pageStore);
            lav60Debug('store', 'powpay health', health);
            if (health.definite_offline || (health.ok === false && !health.transient)) {
              heartbeatAlive = false;
            } else if (health.ok) {
              heartbeatAlive = true;
            }
          }
        }
      }

      if (
        applyStatusCacheBootstrap(statusCache, {
          render: false,
          skipNetwork: heartbeatBootstrapped && isRtdbOnlyPanel(catalog),
        })
      ) {
        $('summaryTime').title = statusCache?.config_fresh
          ? 'Cache Firebase · atualizando agente em segundo plano'
          : 'Cache Firebase';
        lav60Debug('store', 'bootstrap from firebase cache', {
          configFresh: statusCache?.config_fresh,
          alive: statusCache?.alive,
        });
      }

      void supplementMachinesFromPortal().then((ok) => {
        if (ok) lav60Debug('store', 'machines supplemented from portal API');
      });

      lav60Debug('store', 'cache', {
        hasCard: Boolean(cached?.card),
        accessible: cached?.card?.accessible,
        fresh: cached?.fresh,
        heartbeatAlive,
        firebaseHit: Boolean(statusCache?.hit),
      });

      if (!statusData && applyCachedBootstrap(cached, { render: false })) {
        $('summaryTime').title = '';
        lav60Debug('store', 'bootstrap from indexeddb cache');
      }

      agentEndpoint =
        resolveAgentEndpointFromStatusCache(statusCache, storeMeta, catalog, config) ||
        (await resolveAgentEndpointForStore(storeMeta, catalog, agentToken, heartbeatEntry));

      lav60Debug('store', 'agent endpoint', agentEndpoint);
      if (agentEndpoint?.unmatched) {
        redirectToDashboard('agent_unmatched', { agentEndpoint });
        return;
      }

      let agentReachable = false;
      const cacheConfigFresh = Boolean(statusCache?.config_fresh && statusCache?.config_snapshot);
      const canBootstrapUi = Boolean(
        statusData?.summary?.total ||
          (config?.devices &&
            ['washers', 'dryers', 'dosers'].some(
              (key) => Array.isArray(config.devices[key]) && config.devices[key].length
            ))
      );
      const deferConfigLoad = cacheConfigFresh || canBootstrapUi;

      if (deferConfigLoad) {
        agentReachable = cacheConfigFresh || canBootstrapUi;
        if (!finishStoreReady(heartbeatAlive, agentReachable)) return;
        void loadConfig()
          .then(() => {
            agentReachable = true;
            lav60Debug('store', 'background loadConfig ok');
            storeAgentReady = true;
            rebuildPingStatusFromConfig();
            if (lastNetworkStatusSource) seedPingStatusFromNetworkStatus(lastNetworkStatusSource);
            updateStoreAgentMetaFromContext();
            if (uiReady) {
              renderStoreUiFromContext();
            }
          })
          .catch((e) => {
            lav60Debug('store', 'background loadConfig failed', e?.message || e);
            if (!cacheConfigFresh && !canBootstrapUi) {
              if (!heartbeatAlive && redirectIfNoAgent(e?.message || e)) return;
              showOperatorError('Configuração', e);
            }
          });
        return;
      }

      try {
        await loadConfig();
        agentReachable = true;
        lav60Debug('store', 'loadConfig ok', {
          store: config?.store,
          token_required: config?.token_required,
          agentEndpoint,
        });
      } catch (e) {
        lav60Debug('store', 'loadConfig failed', e?.message || e);
        if (!heartbeatAlive && !statusCache?.alive) {
          if (redirectIfNoAgent(e?.message || e)) return;
          redirectToDashboard('heartbeat_offline', { heartbeatEntry, error: e?.message || e });
          return;
        }
        if (redirectIfNoAgent(e?.message || e)) return;
        showOperatorError('Configuração', e);
        return;
      }

      finishStoreReady(heartbeatAlive, agentReachable);
    } catch (e) {
      showOperatorError('Inicialização', e);
    }
  }

  function destroy() {
    if (stopHeartbeatWatch) {
      stopHeartbeatWatch();
      stopHeartbeatWatch = null;
    }
    stopAgentStatusPolling();
    if (deviceLockTimer) {
      clearInterval(deviceLockTimer);
      deviceLockTimer = null;
    }
    storeStatusBarReady = false;
    uiReady = false;
    storeAgentReady = false;
  }

  window.addEventListener('beforeunload', () => {
    destroy();
  });

  if (document.getElementById('appView')) {
    window.Lav60AgentStorePage = {
      init: async () => {
        if (window.Lav60Audit) {
          await Lav60Audit.refreshStatus();
        }
        await init();
      },
      destroy,
    };
  } else {
    (async () => {
      if (window.Lav60Auth) {
        const ok = await Lav60Auth.guardPage({
          returnPath: `store.html?store=${encodeURIComponent(pageStore || '')}`,
        });
        if (!ok) return;
      }
      if (window.Lav60Audit) {
        await Lav60Audit.refreshStatus();
      }
      await init();
    })();
  }
})();
