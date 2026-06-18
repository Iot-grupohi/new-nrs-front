(() => {
  'use strict';

  const { loadCatalog, friendlyUserMessage, WASHER_DOSAGE_OPTIONS } = window.Lav60;
  const { guardPage, mountUserMenu, panelFetch } = window.Lav60Auth;

  const $ = (id) => document.getElementById(id);
  const MAX_LOG = 10;

  const TEMPO_LABELS = { sabao: 'Sabão', floral: 'Floral', sport: 'Sport' };
  const DOSER_TYPE_LABELS = { rele1on: 'Sabão', rele2on: 'Floral', rele3on: 'Sport' };

  const STATUS_PATHS = {
    washer: (id) => `status/washer/${id}`,
    dryer: (id) => `status/dryer/${id}`,
    doser: (id) => `status/doser/${id}`,
    ac: () => 'status/ac',
  };

  let gatewayConfig = null;
  let catalog = null;
  let currentStore = '';
  let storeGatewayReady = false;
  let storeGatewayError = null;
  let storeCheckGeneration = 0;
  let pingStatus = null;
  let actionBusy = false;
  const probingDevices = new Set();
  let probeGeneration = 0;
  let probeQueueRunner = null;

  const GATEWAY_CACHE_KEY = 'lav60:gateway:v1';
  const GATEWAY_CACHE_VERSION = 1;
  const GATEWAY_TTL_MS = 5 * 60 * 1000;
  const DEVICES_TTL_MS = 10 * 60 * 1000;

  const storeOverviewStatus = Object.create(null);
  let overviewScanRunning = false;
  let activeGatewayKpi = null;

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

  function gatewayDebug(label, payload) {
    const ts = new Date().toISOString().slice(11, 23);
    if (payload !== undefined) console.log(`[LAV60 Gateway ${ts}] ${label}`, payload);
    else console.log(`[LAV60 Gateway ${ts}] ${label}`);
  }

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
    storeOverviewStatus[sid] = { ...root.stores[sid].gateway, checking: false };
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

  function hydrateOverviewFromCache() {
    const root = loadGatewayCacheRoot();
    Object.entries(root.stores || {}).forEach(([sid, block]) => {
      if (block?.gateway) {
        storeOverviewStatus[sid] = { ...block.gateway, checking: false };
      }
    });
  }

  function overviewStatusForStore(storeId) {
    const sid = normalizeStoreId(storeId);
    return storeOverviewStatus[sid] || getStoreGatewayEntry(sid) || null;
  }

  function storeDisplayName(entry) {
    const sid = normalizeStoreId(entry?.store || entry?.id);
    const name = entry?.name;
    if (name) return `${name} (${sid.toUpperCase()})`;
    return sid.toUpperCase();
  }

  function buildGatewayEventLists() {
    const online = [];
    const offline = [];
    const pending = [];
    (catalog?.stores || []).forEach((meta) => {
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
          const age = entry.checkedAt ? formatCacheAge(entry.checkedAt) : '';
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
          const age = entry.checkedAt ? formatCacheAge(entry.checkedAt) : '';
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

  function initGatewayKpiEvents() {
    const root = $('gatewayOverview');
    if (!root) return;

    root.addEventListener('click', (e) => {
      const storeBtn = e.target.closest('[data-gateway-store]');
      if (storeBtn) {
        void applyStore(storeBtn.dataset.gatewayStore);
        closeGatewayKpiPanel();
        $('devicesPanel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
        return;
      }
      const card = e.target.closest('[data-kpi]');
      if (!card) return;
      toggleGatewayKpiPanel(card.dataset.kpi);
    });

    root.addEventListener('keydown', (e) => {
      const card = e.target.closest('[data-kpi]');
      if (!card || (e.key !== 'Enter' && e.key !== ' ')) return;
      e.preventDefault();
      toggleGatewayKpiPanel(card.dataset.kpi);
    });

    $('gatewayKpiClose')?.addEventListener('click', closeGatewayKpiPanel);
  }

  function updateGatewayOverviewKpis() {
    const stores = catalog?.stores || [];
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
    el.textContent = `ESP8266 verificado via POST led/on — cache local por ${ttlMin} min (equipamentos por ${Math.round(DEVICES_TTL_MS / 60000)} min)`;
  }

  function renderGatewayOverview() {
    updateGatewayOverviewKpis();
    updateGatewayOverviewMeta(overviewScanRunning);
    if (activeGatewayKpi) renderGatewayKpiPanel(activeGatewayKpi);
  }

  function refreshGatewayOverview() {
    renderGatewayOverview();
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

  async function probeOverviewStoreGateway(storeId) {
    const sid = normalizeStoreId(storeId);
    storeOverviewStatus[sid] = { ...(storeOverviewStatus[sid] || {}), checking: true, online: null };
    refreshGatewayOverview();

    try {
      const { ok, status, data } = await postStoreLedOn(sid);
      if (ok) {
        setStoreGatewayEntry(sid, { online: true, error: null });
        revertStoreLedTest(sid);
        gatewayDebug('Overview ESP online', { store: sid });
      } else {
        const error = formatStoreGatewayError(
          sid,
          data.detail || data.error || data.message || `HTTP ${status}`
        );
        setStoreGatewayEntry(sid, { online: false, error });
        gatewayDebug('Overview ESP offline', { store: sid, status });
      }
    } catch (err) {
      setStoreGatewayEntry(sid, { online: false, error: formatStoreGatewayError(sid, err.message) });
    }

    refreshGatewayOverview();
  }

  async function scanAllStoreGateways({ force = false, skipStores = null } = {}) {
    if (overviewScanRunning || !catalog) return;
    overviewScanRunning = true;
    updateGatewayOverviewMeta(true);
    $('btnRefreshGateways')?.setAttribute('disabled', 'disabled');

    const skip = new Set(
      (Array.isArray(skipStores) ? skipStores : skipStores ? [skipStores] : [])
        .map(normalizeStoreId)
        .filter(Boolean)
    );

    const stores = catalog.stores || [];
    try {
      for (let i = 0; i < stores.length; i += 1) {
        const sid = normalizeStoreId(stores[i].id);
        if (!sid || skip.has(sid)) continue;
        const cached = getStoreGatewayEntry(sid);
        if (!force && cached && isCacheFresh(cached.checkedAt, GATEWAY_TTL_MS)) {
          storeOverviewStatus[sid] = { ...cached, checking: false };
          continue;
        }
        await probeOverviewStoreGateway(sid);
        if (i < stores.length - 1) await sleep(400);
      }
    } finally {
      overviewScanRunning = false;
      $('btnRefreshGateways')?.removeAttribute('disabled');
      updateGatewayOverviewMeta(false);
      refreshGatewayOverview();
    }
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

  function appendLog(label, ok, payload) {
    const list = $('responseLog');
    if (!list) return;
    const item = document.createElement('li');
    item.className = `gateway-log__item ${ok ? 'gateway-log__item--ok' : 'gateway-log__item--err'}`;
    const preview =
      typeof payload === 'string' ? payload : JSON.stringify(payload, null, 0).slice(0, 320);
    item.innerHTML = `<time>${new Date().toLocaleTimeString('pt-BR')}</time>
      <strong>${escapeHtml(label)}</strong>
      <code>${escapeHtml(preview)}</code>`;
    list.prepend(item);
    while (list.children.length > MAX_LOG) list.removeChild(list.lastChild);
  }

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
      el.textContent = 'Gateway loja: —';
      return;
    }
    if (state === 'checking') {
      el.textContent = 'Gateway loja: verificando…';
      el.classList.add('gateway-meta--warn');
    } else if (state === 'online') {
      const cached = getStoreGatewayEntry(currentStore);
      const age = cached?.checkedAt ? ` · ${formatCacheAge(cached.checkedAt)}` : '';
      el.textContent = `Gateway loja: online (${currentStore.toUpperCase()}${age})`;
      el.classList.add('gateway-meta--ok');
    } else if (state === 'offline') {
      el.textContent = detail || `Gateway loja: offline (${currentStore.toUpperCase()})`;
      el.classList.add('gateway-meta--err');
    } else {
      el.textContent = 'Gateway loja: —';
    }
  }

  function formatStoreGatewayError(storeId, detail) {
    const code = String(storeId || '').toUpperCase();
    const msg = String(detail || '').trim();
    if (!msg) {
      return `A loja ${code} não possui gateway online no momento. Apenas lojas com ESP8266 ativo no gateway central podem ser operadas por aqui.`;
    }
    if (msg.toLowerCase().includes('not found') || msg.includes('404')) {
      return `A loja ${code} não está cadastrada no gateway central ou o ESP8266 não está configurado.`;
    }
    return `Gateway da loja ${code} não está online. ${friendlyUserMessage(msg)}`;
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
    const base = gatewayConfig.base_url || 'https://gateway.lav60.com';
    $('gatewayBaseUrl').textContent = base.replace(/^https?:\/\//, '');
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
    $('apiHealthMeta').textContent = 'API: verificando…';
    try {
      const res = await panelFetch('/api/gateway/health');
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      $('apiHealthMeta').textContent = `API: online (${data.message || 'OK'})`;
      $('apiHealthMeta').className = 'gateway-meta gateway-meta--ok';
      appendLog('Health API', true, data);
      return data;
    } catch (err) {
      $('apiHealthMeta').textContent = `API: offline — ${err.message}`;
      $('apiHealthMeta').className = 'gateway-meta gateway-meta--err';
      appendLog('Health API', false, err.message);
      throw err;
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

  function onlinePill(online, probing = false) {
    if (probing) {
      return '<span class="device-card__status pill pill--warn">Verificando…</span>';
    }
    if (online === true) return '<span class="device-card__status pill pill--on">Online</span>';
    if (online === false) return '<span class="device-card__status pill pill--off">Offline</span>';
    return '<span class="device-card__status pill pill--warn">Não verificado</span>';
  }

  function deviceProbeKey(deviceType, machine) {
    return machine ? `${deviceType}:${machine}` : deviceType;
  }

  function isDeviceProbing(deviceType, machine) {
    return probingDevices.has(deviceProbeKey(deviceType, machine));
  }

  function findDeviceCard(deviceType, machine) {
    if (deviceType === 'washer') {
      return document.querySelector(`[data-washer-id="${CSS.escape(String(machine))}"]`);
    }
    if (deviceType === 'dryer') {
      return document.querySelector(`[data-dryer-id="${CSS.escape(String(machine))}"]`);
    }
    if (deviceType === 'doser') {
      return document.querySelector(`[data-doser-id="${CSS.escape(String(machine))}"]`);
    }
    if (deviceType === 'ac') {
      return $('acGrid')?.querySelector('.device-card');
    }
    return null;
  }

  function updateDeviceStatusPill(deviceType, machine, online, probing = false) {
    const card = findDeviceCard(deviceType, machine);
    if (!card) return;
    const pill = card.querySelector('.device-card__status');
    if (!pill) return;
    pill.outerHTML = onlinePill(online, probing);
  }

  function btn(text, className, onclick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn btn--sm ${className || ''}`;
    b.textContent = text;
    if (onclick) b.addEventListener('click', onclick);
    return b;
  }

  function createChoicePicker(options, { columns = 3, requireSelection = false, disabled = false } = {}) {
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
      if (opt.wide) b.classList.add('device-card__choice--wide');
      if (!requireSelection && String(opt.value) === String(selected)) {
        b.classList.add('device-card__choice--active');
      }
      b.textContent = opt.label;
      b.dataset.choiceValue = String(opt.value);
      b.disabled = disabled;
      b.addEventListener('click', () => {
        if (b.disabled) return;
        selected = opt.value;
        buttons.forEach((item) => {
          item.classList.toggle('device-card__choice--active', item.dataset.choiceValue === String(selected));
        });
        notifyChange();
      });
      buttons.push(b);
      wrap.appendChild(b);
    });

    return {
      root: wrap,
      getValue: () => selected,
      hasSelection: () => selected != null,
      onChange(fn) {
        listeners.push(fn);
      },
      setDisabled(value) {
        buttons.forEach((item) => {
          item.disabled = value;
        });
      },
    };
  }

  function syncReleaseButtonWithPicker(releaseBtn, picker) {
    if (!releaseBtn || !picker) return;
    const update = () => {
      releaseBtn.disabled = !storeSelected() || !picker.hasSelection();
    };
    picker.onChange(update);
    update();
  }

  function appendReleaseButton(container, { label = 'Liberar', className = 'btn--primary', onRelease, disabled = false }) {
    const releaseBtn = btn(label, `device-card__release-btn ${className}`, onRelease);
    releaseBtn.disabled = disabled || !storeSelected();
    container.appendChild(releaseBtn);
    return releaseBtn;
  }

  function appendEndpointHint(container, deviceType, machine) {
    const path = deviceEndpointPath(deviceType, machine);
    if (!currentStore || !path) return;
    const p = document.createElement('p');
    p.className = 'device-card__endpoint';
    p.innerHTML = `<code>GET ${escapeHtml(fullGatewayPath(path))}</code>`;
    container.appendChild(p);
  }

  function createDeviceShell(id, online, fillContent, { probing = false } = {}) {
    const card = document.createElement('article');
    card.className = 'device-card device-card--tile';
    card.innerHTML = `
      <header class="device-card__head">
        <div class="device-card__title-row">
          <h3 class="device-card__id">${escapeHtml(String(id))}</h3>
        </div>
      </header>
    `;
    const head = card.querySelector('.device-card__head');
    head.insertAdjacentHTML('beforeend', onlinePill(online, probing));
    fillContent(card);
    return card;
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
    updateDeviceStatusPill(deviceType, machine, null, true);

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
      updateDeviceStatusPill(deviceType, machine, state, false);
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

  async function runAction(label, fn) {
    if (actionBusy) return;
    if (!currentStore) {
      showToast('Selecione uma loja', false);
      return;
    }
    if (!storeGatewayReady) {
      showToast(storeGatewayError || 'Gateway da loja não está online', false);
      return;
    }
    actionBusy = true;
    try {
      const data = await fn();
      showToast(`${label} — OK`);
      appendLog(label, true, data);
      return data;
    } catch (err) {
      showToast(`${label}: ${friendlyUserMessage(err.message)}`, false);
      appendLog(label, false, err.payload || err.message);
    } finally {
      actionBusy = false;
    }
  }

  function dosageLabel(am) {
    const opt = WASHER_DOSAGE_OPTIONS.find((o) => o.value === am);
    return opt?.label || am || 'Sem cheiro';
  }

  function renderWashers() {
    const grid = $('washersGrid');
    grid.innerHTML = '';
    const ids = gatewayConfig?.washers || [];
    $('washersCount').textContent = String(ids.length);
    const disabled = !storeSelected();

    ids.forEach((id) => {
      const probing = isDeviceProbing('washer', id);
      const online = probing ? null : pingStatus?.washers?.[id] ?? null;
      const card = createDeviceShell(
        id,
        online,
        (shell) => {
        appendEndpointHint(shell, 'washer', id);

        const actions = document.createElement('div');
        actions.className = 'device-card__actions device-card__actions--washer';

        const dosageOptions = (gatewayConfig.washer_dosage_options || WASHER_DOSAGE_OPTIONS).map((o) => ({ ...o }));
        const picker = createChoicePicker(dosageOptions, { columns: 2, requireSelection: true, disabled });
        actions.appendChild(picker.root);

        const releaseBtn = appendReleaseButton(actions, {
          disabled: true,
          onRelease: () => {
            if (!picker.hasSelection()) return;
            const am = picker.getValue();
            const amLabel = am ? dosageLabel(am) : 'Sem cheiro';
            if (!confirm(`Confirmar liberação da lavadora ${id}?\nDosagem: ${amLabel}`)) return;
            runAction(`Lavadora ${id}`, () =>
              runGatewayAction(`Lavadora ${id}`, `washer/${id}`, 'POST', am ? { am } : {})
            );
          },
        });
        syncReleaseButtonWithPicker(releaseBtn, picker);
        shell.appendChild(actions);
      },
        { probing }
      );
      card.dataset.washerId = id;
      grid.appendChild(card);
    });
  }

  function renderDryers() {
    const grid = $('dryersGrid');
    grid.innerHTML = '';
    const ids = gatewayConfig?.dryers || [];
    const minutes = gatewayConfig?.dryer_minutes || [15, 30, 45];
    $('dryersCount').textContent = String(ids.length);
    const disabled = !storeSelected();

    ids.forEach((id) => {
      const probing = isDeviceProbing('dryer', id);
      const online = probing ? null : pingStatus?.dryers?.[id] ?? null;
      const card = createDeviceShell(
        id,
        online,
        (shell) => {
        appendEndpointHint(shell, 'dryer', id);

        const actions = document.createElement('div');
        actions.className = 'device-card__actions device-card__actions--dryer';

        const minuteOptions = minutes.map((min) => ({ value: String(min), label: `${min} min` }));
        const picker = createChoicePicker(minuteOptions, { columns: 3, requireSelection: true, disabled });
        actions.appendChild(picker.root);

        const releaseBtn = appendReleaseButton(actions, {
          disabled: true,
          onRelease: () => {
            if (!picker.hasSelection()) return;
            const mins = Number(picker.getValue());
            if (!confirm(`Iniciar secadora ${id} por ${mins} min?`)) return;
            runAction(`Secadora ${id} · ${mins} min`, () =>
              runGatewayAction(`Secadora ${id}`, `dryer/${id}`, 'POST', { minutes: mins })
            );
          },
        });
        syncReleaseButtonWithPicker(releaseBtn, picker);
        shell.appendChild(actions);
      },
        { probing }
      );
      card.dataset.dryerId = id;
      grid.appendChild(card);
    });
  }

  function buildDoserActions(actions, id) {
    actions.classList.add('device-card__actions--doser');
    const disabled = !storeSelected();

    const picker = createChoicePicker(
      [
        { value: 'rele1on', label: 'Sabão' },
        { value: 'rele2on', label: 'Floral' },
        { value: 'rele3on', label: 'Sport' },
      ],
      { columns: 3, requireSelection: true, disabled }
    );
    actions.appendChild(picker.root);

    const releaseBtn = appendReleaseButton(actions, {
      label: 'Acionar',
      disabled: true,
      onRelease: () => {
        if (!picker.hasSelection()) return;
        const type = picker.getValue();
        const product = DOSER_TYPE_LABELS[type] || type;
        if (!confirm(`Acionar ${product} na dosadora ${id}?`)) return;
        runAction(`Dosadora ${id} · ${product}`, () =>
          runGatewayAction(`Dosadora ${id}`, `doser/${id}`, 'POST', { type })
        );
      },
    });
    syncReleaseButtonWithPicker(releaseBtn, picker);

    const consultRow = document.createElement('div');
    consultRow.className = 'device-card__action-row';
    consultRow.appendChild(
      btn('Consultar tempos salvos', 'btn--ghost device-card__action-wide', () => {
        if (!confirm(`Consultar tempos da dosadora ${id}?`)) return;
        runAction(`Consulta dosadora ${id}`, () =>
          runGatewayAction(`Consulta ${id}`, `doser/${id}/consulta`, 'GET')
        );
      })
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
    secInput.disabled = disabled;

    const secUnit = document.createElement('span');
    secUnit.className = 'device-card__time-unit';
    secUnit.textContent = 'seg';

    timeField.appendChild(secInput);
    timeField.appendChild(secUnit);
    panel.appendChild(timeField);

    const setGrid = document.createElement('div');
    setGrid.className = 'device-card__action-grid device-card__action-grid--3';
    ['sabao', 'floral', 'sport'].forEach((kind) => {
      const kindLabel = TEMPO_LABELS[kind] || kind;
      const setBtn = btn(kindLabel, 'btn--ghost', () => {
        const seconds = parseFloat(secInput.value) || 5;
        if (!confirm(`Ajustar ${kindLabel} da dosadora ${id} para ${seconds} seg?`)) return;
        runAction(`Ajuste ${id} · ${kindLabel}`, () =>
          runGatewayAction(`Ajuste ${id}`, `doser/${id}/settime/${kind}`, 'POST', { seconds })
        );
      });
      setBtn.disabled = disabled;
      setGrid.appendChild(setBtn);
    });
    panel.appendChild(setGrid);
    actions.appendChild(panel);
  }

  function renderDosers() {
    const grid = $('dosersGrid');
    grid.innerHTML = '';
    const ids = gatewayConfig?.dosers || [];
    $('dosersCount').textContent = String(ids.length);

    ids.forEach((id) => {
      const probing = isDeviceProbing('doser', id);
      const online = probing ? null : pingStatus?.dosers?.[id] ?? null;
      const card = createDeviceShell(
        id,
        online,
        (shell) => {
        appendEndpointHint(shell, 'doser', id);
        const actions = document.createElement('div');
        actions.className = 'device-card__actions';
        buildDoserActions(actions, id);
        shell.appendChild(actions);
      },
        { probing }
      );
      card.classList.add('device-card--doser');
      card.dataset.doserId = id;
      grid.appendChild(card);
    });
  }

  function renderAc() {
    const grid = $('acGrid');
    grid.innerHTML = '';
    const temps = gatewayConfig?.ac_temperatures || ['18', '22', 'off'];
    const probing = isDeviceProbing('ac', null);
    const online = probing ? null : pingStatus?.ac ?? null;
    const disabled = !storeSelected();

    const card = createDeviceShell(
      'AC',
      online,
      (shell) => {
      appendEndpointHint(shell, 'ac');

      const actions = document.createElement('div');
      actions.className = 'device-card__actions device-card__actions--ac';

      const tempOptions = temps.map((temp) => ({
        value: temp,
        label: temp === 'off' ? 'Desligar' : `${temp}°C`,
      }));
      const picker = createChoicePicker(tempOptions, { columns: 3, requireSelection: true, disabled });
      actions.appendChild(picker.root);

      const releaseBtn = appendReleaseButton(actions, {
        label: 'Acionar',
        disabled: true,
        onRelease: () => {
          if (!picker.hasSelection()) return;
          const temp = picker.getValue();
          const tempLabel = temp === 'off' ? 'Desligar' : `${temp}°C`;
          if (!confirm(`Confirmar AC · ${tempLabel}?`)) return;
          runAction(`AC · ${tempLabel}`, () =>
            runGatewayAction(`AC · ${tempLabel}`, 'ac', 'POST', { temperature: temp })
          );
        },
      });
      syncReleaseButtonWithPicker(releaseBtn, picker);
      shell.appendChild(actions);
    },
      { probing }
    );
    grid.appendChild(card);
  }

  function renderLed() {
    const grid = $('ledGrid');
    grid.innerHTML = '';
    const disabled = !storeSelected();

    const card = createDeviceShell('LED', null, (shell) => {
      const p = document.createElement('p');
      p.className = 'device-card__endpoint';
      p.innerHTML = `<code>POST ${escapeHtml(currentStore ? `${currentStore}/led/on` : '{loja}/led/on')}</code>`;
      shell.appendChild(p);

      const actions = document.createElement('div');
      actions.className = 'device-card__actions';
      const onBtn = btn('Ligar', 'btn--success', () => {
        runAction('LED ligar', () => runGatewayAction('LED ligar', 'led/on', 'POST'));
      });
      const offBtn = btn('Desligar', 'btn--ghost', () => {
        runAction('LED desligar', () => runGatewayAction('LED desligar', 'led/off', 'POST'));
      });
      onBtn.disabled = disabled;
      offBtn.disabled = disabled;
      actions.appendChild(onBtn);
      actions.appendChild(offBtn);
      shell.appendChild(actions);
    });
    grid.appendChild(card);
  }

  function renderDevices() {
    if (!gatewayConfig) return;
    renderWashers();
    renderDryers();
    renderDosers();
    renderAc();
    renderLed();
  }

  function updateDevicesPanelVisibility() {
    $('devicesPanel')?.classList.toggle('hidden', !currentStore);
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
      $('storeMeta').textContent = 'Loja: —';
      hideStoreGatewayAlert();
      showStoreGatewayChecking(false);
      updateStoreGatewayMeta(null);
      setDevicesPanelBlocked(true);
      resetPingStatus();
      updateDevicesPanelVisibility();
      refreshGatewayOverview();
      renderDevices();
      const url = new URL(window.location.href);
      url.searchParams.delete('store');
      window.history.replaceState({}, '', url);
      return;
    }

    currentStore = next;
    const meta = (catalog?.stores || []).find((s) => s.id === next);
    const title = meta?.name ? `${meta.name} (${next.toUpperCase()})` : next.toUpperCase();
    $('storeMeta').textContent = `Loja: ${title}`;
    $('storeSelect').value = next;
    const url = new URL(window.location.href);
    url.searchParams.set('store', next);
    window.history.replaceState({}, '', url);
    resetPingStatus();
    updateDevicesPanelVisibility();
    refreshGatewayOverview();
    renderDevices();
    gatewayDebug('Loja selecionada — verificando gateway', { store: currentStore });
    await verifyStoreGateway(next);
  }

  function onStoreSelectChange() {
    void applyStore($('storeSelect').value);
  }

  function populateStoreSelect() {
    const select = $('storeSelect');
    const stores = catalog?.stores || [];
    select.innerHTML = '<option value="">Selecione…</option>';
    stores.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name ? `${s.name} (${s.id.toUpperCase()})` : s.id.toUpperCase();
      select.appendChild(opt);
    });
  }

  async function init() {
    const ok = await guardPage({ returnPath: `gateway.html${window.location.search}` });
    if (!ok) return;
    await mountUserMenu($('headerUserMenu'));

    try {
      await loadGatewayConfig();
      catalog = await loadCatalog();
      populateStoreSelect();
      hydrateOverviewFromCache();
      renderGatewayOverview();
      resetPingStatus();
      setDevicesPanelBlocked(true);
      updateDevicesPanelVisibility();
      renderDevices();

      const initial = normalizeStoreId(new URLSearchParams(window.location.search).get('store'));
      scanAllStoreGateways({ force: false, skipStores: initial }).catch(() => {});
      if (initial) {
        $('storeSelect').value = initial;
        void applyStore(initial);
      }
    } catch (err) {
      showToast(err.message, false);
    }

    checkApiHealth().catch(() => {});

    initGatewayKpiEvents();
    $('storeSelect').addEventListener('change', onStoreSelectChange);
    $('btnRefreshGateways')?.addEventListener('click', () => {
      void scanAllStoreGateways({ force: true }).then(() => {
        if (currentStore) void verifyStoreGateway(currentStore, { force: true });
      });
    });
    $('btnClearLog').addEventListener('click', () => {
      $('responseLog').innerHTML = '';
    });
  }

  init().catch((err) => {
    document.body.classList.remove('auth-pending');
    gatewayDebug('init erro', err.message);
    showToast(err.message || 'Erro ao iniciar', false);
  });

  gatewayDebug('gateway.js carregado — verificação automática por equipamento');
})();
