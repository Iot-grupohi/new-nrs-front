(() => {
  'use strict';

  const OFFLINE_SINCE_KEY = 'lav60_offline_since';
  const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
  const Cache = window.Lav60Cache;

  let cachedAgentToken = null;
  let panelBootstrapCache = null;

  async function fetchPanelBootstrap() {
    if (panelBootstrapCache) return panelBootstrapCache;
    try {
      const res = await fetch('/api/panel/bootstrap', {
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      });
      if (!res.ok) {
        panelBootstrapCache = {};
        return panelBootstrapCache;
      }
      panelBootstrapCache = await res.json();
      return panelBootstrapCache;
    } catch {
      panelBootstrapCache = {};
      return panelBootstrapCache;
    }
  }

  /** Token do agente a partir do .env do servidor (API_TOKEN). */
  async function ensureDefaultAgentToken() {
    if (cachedAgentToken !== null) return cachedAgentToken;
    const boot = await fetchPanelBootstrap();
    cachedAgentToken = String(boot?.default_agent_token || '').trim();
    return cachedAgentToken;
  }

  function friendlyUserMessage(message, context = '') {
    if (!message) return 'Não foi possível concluir a operação';
    const raw = String(message);
    const m = raw.toLowerCase();
    const ctx = String(context).toLowerCase();

    const byContext = (equipamento, fallback) => {
      if (ctx.includes('ac') || ctx.includes('ar-condicionado')) return 'Ar-condicionado não respondeu. Tente novamente.';
      if (ctx.includes('secador')) return 'Secadora não respondeu. Tente novamente.';
      if (ctx.includes('lavador')) return 'Lavadora não respondeu. Tente novamente.';
      if (ctx.includes('dosador') || ctx.includes('consulta')) return 'Dosadora não respondeu. Tente novamente.';
      return fallback || `${equipamento} não respondeu. Tente novamente.`;
    };

    if (
      m.includes('failed to fetch') ||
      m.includes('networkerror') ||
      m.includes('falha de rede') ||
      m.includes('load failed') ||
      m.includes('network request failed') ||
      m.includes('aborted') ||
      m.includes('abort') ||
      m.includes('signal is aborted')
    ) {
      return 'Sem conexão com a loja';
    }

    if (
      m.includes('timed out') ||
      m.includes('timeout') ||
      m.includes('httpconnectionpool') ||
      m.includes('connection refused') ||
      m.includes('connection error') ||
      m.includes('connection aborted') ||
      m.includes('max retries') ||
      /\b192\.168\.|\b10\.\d+\.\d+\.\d+|\bhost=|\bport=\d+/i.test(raw)
    ) {
      return byContext('Equipamento', 'Equipamento não respondeu. Tente novamente.');
    }

    if (m.includes('did not respond') || m.includes('não respondeu')) {
      if (m.includes(' ac') || m.startsWith('ac ') || ctx.includes('ac')) {
        return 'Ar-condicionado não respondeu. Tente novamente.';
      }
      if (m.includes('dryer') || m.includes('secador')) return 'Secadora não respondeu. Tente novamente.';
      if (m.includes('washer') || m.includes('lavador')) return 'Lavadora não respondeu. Tente novamente.';
      if (m.includes('doser') || m.includes('dosador')) return 'Dosadora não respondeu. Tente novamente.';
      return byContext('Equipamento');
    }

    if (m.includes('401') || m.includes('403') || m.includes('não autorizado')) {
      if (m.includes('este agente é') || m.includes('recusada')) {
        return 'Este computador não é o agente desta loja';
      }
      return 'Acesso negado — verifique o token';
    }
    if (m.includes('404')) return 'Recurso não encontrado';
    if (m.includes('stores.json') || m.includes('configuração do painel')) return 'Configuração do painel indisponível';

    if (
      m.includes('invalid machine') ||
      m.includes('invalid minutes') ||
      m.includes('invalid temperature') ||
      m.includes('invalid type') ||
      m.includes('invalid rele') ||
      m.includes('invalid seconds') ||
      m.includes('invalid number') ||
      m.includes('invalid pump') ||
      m.includes('invalid am') ||
      m.includes('equipamento inválido') ||
      m.includes('parâmetro inválido') ||
      m.includes('comando inválido')
    ) {
      return 'Comando inválido. Verifique os dados e tente novamente.';
    }

    if (m.includes("field '") || m.includes('fields ') || m.includes('is required') || m.includes('provide ')) {
      return 'Dados incompletos. Verifique e tente novamente.';
    }

    if (
      m.includes(' failed') ||
      m.includes('falhou') ||
      m.includes('not available') ||
      m.includes('was not released')
    ) {
      return byContext('Equipamento', 'Não foi possível concluir. Tente novamente.');
    }

    if (/http\s*\d|config:|status:|fetch|json\.parse|typeerror|exception|traceback|error:|use:\s*\[/i.test(raw)) {
      return byContext('Equipamento', 'Não foi possível concluir. Tente novamente.');
    }

    if (/^[a-z0-9_.\-]+\s*:\s*/i.test(raw) && /[{}[\]\\]|http/i.test(raw)) {
      return 'Não foi possível concluir. Tente novamente.';
    }

    return raw;
  }

  function formatOperatorError(label, message) {
    return friendlyUserMessage(message, label);
  }

  function normalizeStoreId(id) {
    return String(id || '').trim().toLowerCase();
  }

  function noAgentMessage(storeId) {
    return `Nenhum agente ${normalizeStoreId(storeId).toUpperCase()} disponível`;
  }

  function isAgentUnavailableError(message) {
    if (!message) return false;
    const m = String(message).toLowerCase();
    return m.includes('nenhum agente') && (m.includes('disponível') || m.includes('encontrado'));
  }

  function normalizeCardAccess(card) {
    if (!card) return card;
    const agentUnavailable = card.agentUnavailable || isAgentUnavailableError(card.error);
    if (!agentUnavailable && card.accessible !== false) return card;
    if (agentUnavailable) {
      return {
        ...card,
        agentUnavailable: true,
        accessible: false,
        loading: false,
        state: 'unreachable',
        error: card.error || noAgentMessage(card.id),
      };
    }
    return card;
  }

  function isPanelOnLocalMachine() {
    if (typeof window === 'undefined') return false;
    const host = (window.location.hostname || '').toLowerCase();
    return (
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host.startsWith('192.168.') ||
      host.startsWith('10.') ||
      host.endsWith('.local')
    );
  }

  function isLocalAgentUrl(url) {
    if (!url) return false;
    return /^https?:\/\/(localhost|127\.0\.0\.1)(?::\d+)?/i.test(String(url).trim());
  }

  /** localhost:8080 só quando painel e agente estão na mesma máquina (dev). */
  function normalizeAgentUrl(url) {
    if (!url) return url;
    let base = String(url).replace(/\/$/, '');
    if (typeof window === 'undefined') return base;
    if (isLocalAgentUrl(base)) {
      if (!isPanelOnLocalMachine()) {
        return null;
      }
      const local = base.match(/^https?:\/\/(localhost|127\.0\.0\.1)(?::(\d+))?/i);
      const port = local?.[2] || '8080';
      const host = window.location.hostname || '127.0.0.1';
      return `http://${host}:${port}`;
    }
    if (/^http:\/\//i.test(base)) {
      base = base.replace(/^http:\/\//i, 'https://');
    }
    return base;
  }

  const endpointDiscoveryCache = new Map();

  function invalidateAgentDiscovery(storeId) {
    endpointDiscoveryCache.delete(normalizeStoreId(storeId));
  }

  function clearAgentDiscoveryCache() {
    endpointDiscoveryCache.clear();
  }

  function agentStoreMatchesCatalog(agentStore, catalogId) {
    if (!agentStore) return true;
    return normalizeStoreId(agentStore) === normalizeStoreId(catalogId);
  }

  function buildAgentCandidates(meta, catalog) {
    const storeId = normalizeStoreId(meta?.id);
    const suffix = catalog?.domain_suffix || 'powpay.com.br';
    const candidates = [];
    // Cada loja no seu PC/túnel — nunca reutilizar localhost:8080 entre lojas
    candidates.push(`https://${storeId}.${suffix}`);
    if (meta?.agent) {
      const normalized = normalizeAgentUrl(meta.agent);
      if (normalized) candidates.push(normalized);
    }
    return [...new Set(candidates.filter(Boolean))];
  }

  async function probeAgentBase(base, token, timeoutMs = 5000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${base.replace(/\/$/, '')}/api/agent/config`, {
        headers: authHeaders(token),
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  function isHeartbeatEntryAlive(entry, catalog) {
    if (!entry) return false;
    if (entry.alive === false) return false;
    const timeoutMs = getHeartbeatTimeoutMs(catalog);
    const receivedAt =
      typeof entry.received_at === 'number' ? entry.received_at * 1000 : entry.receivedAt || 0;
    return Boolean(receivedAt && Date.now() - receivedAt <= timeoutMs);
  }

  function lav60Debug() {}

  function agentUrlCandidatesFromHeartbeat(entry) {
    const payload = entry?.payload || entry || {};
    const urls = [];
    if (payload.agent_url) urls.push(payload.agent_url);
    if (isPanelOnLocalMachine()) {
      if (payload.agent_local_url) urls.push(payload.agent_local_url);
      urls.push('http://127.0.0.1:8080');
    }
    return [...new Set(urls.map((u) => normalizeAgentUrl(u)).filter(Boolean))];
  }

  async function resolveAgentEndpointForStore(meta, catalog, token, heartbeatEntry = null) {
    const catalogId = normalizeStoreId(meta.id);
    let entry = heartbeatEntry;

    if (!entry) {
      const cached = heartbeatState.get(catalogId);
      if (cached && Date.now() - cached.receivedAt <= getHeartbeatTimeoutMs(catalog)) {
        entry = { received_at: cached.receivedAt / 1000, payload: cached.payload };
      }
    }

    if (!entry) {
      try {
        const snap = await fetchHeartbeatsSnapshot();
        entry = snap.heartbeats?.[catalogId];
      } catch {
        /* painel indisponível */
      }
    }

    if (isHeartbeatEntryAlive(entry, catalog)) {
      lav60Debug('agent', 'heartbeat alive', { store: catalogId, urls: agentUrlCandidatesFromHeartbeat(entry) });
      for (const base of agentUrlCandidatesFromHeartbeat(entry)) {
        const data = await probeAgentBase(base, token, 8000);
        lav60Debug('agent', 'probe', { base, ok: Boolean(data), store: data?.store });
        if (data && agentStoreMatchesCatalog(data.store, catalogId)) {
          const ep = {
            base: normalizeAgentUrl(data.agent_url || base).replace(/\/$/, ''),
            storeId: catalogId,
          };
          endpointDiscoveryCache.set(catalogId, ep);
          lav60Debug('agent', 'resolved via probe', ep);
          return ep;
        }
      }
      const bases = agentUrlCandidatesFromHeartbeat(entry);
      if (bases.length) {
        const ep = { base: bases[0].replace(/\/$/, ''), storeId: catalogId };
        endpointDiscoveryCache.set(catalogId, ep);
        lav60Debug('agent', 'resolved via heartbeat url', ep);
        return ep;
      }
    }

    lav60Debug('agent', 'fallback discoverAgentEndpoint', catalogId);
    return discoverAgentEndpoint(meta, catalog, token);
  }

  async function discoverAgentEndpoint(meta, catalog, token, options = {}) {
    const catalogId = normalizeStoreId(meta?.id);
    const cached = endpointDiscoveryCache.get(catalogId);
    if (cached && !cached.unmatched && options.force !== true) {
      return cached;
    }

    for (const base of buildAgentCandidates(meta, catalog)) {
      const data = await probeAgentBase(base, token);
      if (!data) continue;
      const agentStore = normalizeStoreId(data.store);
      if (!agentStoreMatchesCatalog(agentStore, catalogId)) {
        continue;
      }
      const ep = {
        base: normalizeAgentUrl(data.agent_url || base).replace(/\/$/, ''),
        storeId: agentStore || catalogId,
      };
      endpointDiscoveryCache.set(catalogId, ep);
      return ep;
    }

    return {
      base: `https://${catalogId}.${catalog?.domain_suffix || 'powpay.com.br'}`,
      storeId: catalogId,
      unmatched: true,
    };
  }

  function resolveAgentEndpoint(meta, catalog, agentConfig = null) {
    const catalogId = normalizeStoreId(meta?.id);
    if (agentConfig && !agentStoreMatchesCatalog(agentConfig.store, catalogId)) {
      return { base: null, storeId: catalogId, unmatched: true };
    }
    if (agentConfig?.agent_url) {
      return {
        base: normalizeAgentUrl(agentConfig.agent_url).replace(/\/$/, ''),
        storeId: normalizeStoreId(agentConfig.store || catalogId),
      };
    }
    const suffix = catalog?.domain_suffix || 'powpay.com.br';
    if (meta?.agent) {
      const normalized = normalizeAgentUrl(meta.agent);
      if (normalized) {
        return { base: normalized.replace(/\/$/, ''), storeId: catalogId };
      }
    }
    return { base: `https://${catalogId}.${suffix}`, storeId: catalogId };
  }

  function agentBaseUrl(meta, catalog, agentConfig = null) {
    return resolveAgentEndpoint(meta, catalog, agentConfig).base;
  }

  function authHeaders(token, extra = {}) {
    const headers = { Accept: 'application/json', ...extra };
    if (token) headers['X-Token'] = token;
    return headers;
  }

  function countOnlineMap(items) {
    const values = Object.values(items || {});
    const online = values.filter(Boolean).length;
    return [online, values.length];
  }

  function attachSummary(status) {
    const [wOn, wTot] = countOnlineMap(status.washers);
    const [dOn, dTot] = countOnlineMap(status.dryers);
    const [sOn, sTot] = countOnlineMap(status.dosers);
    const acOn = status.ac ? 1 : 0;
    const online = wOn + dOn + sOn + acOn;
    const total = wTot + dTot + sTot + 1;
    status.summary = {
      total,
      online,
      offline: total - online,
      categories: {
        washers: { online: wOn, total: wTot },
        dryers: { online: dOn, total: dTot },
        dosers: { online: sOn, total: sTot },
        ac: { online: acOn, total: 1 },
      },
    };
    return status;
  }

  const DEVICE_GROUP_TYPE = {
    washers: 'washer',
    dryers: 'dryer',
    dosers: 'doser',
  };

  function findMachineMeta(machines, id, type) {
    const list = machines || [];
    const norm = normalizeStoreId(id);
    return (
      list.find((m) => normalizeStoreId(m.id) === norm && m.type === type) || null
    );
  }

  function normalizeMachineStatus(status) {
    const s = String(status || '').trim().toLowerCase();
    if (s === 'busy') return 'occupied';
    if (s === 'suspended' || s === 'suspensa' || s === 'suspens' || s.startsWith('suspend')) {
      return 'suspended';
    }
    return s;
  }

  function machineStatusPillClass(status) {
    const s = normalizeMachineStatus(status);
    if (s === 'available') return 'pill--on';
    if (s === 'occupied') return 'pill--warn';
    if (s === 'suspended') return 'pill--suspended';
    return 'pill--muted';
  }

  function canOperateMachineStatus(status) {
    if (!status) return true;
    return normalizeMachineStatus(status) === 'available';
  }

  function displayMachineValue(value) {
    if (value === null || value === undefined || value === '') return null;
    return String(value);
  }

  function machineMetaFacts(meta) {
    if (!meta) return [];
    const facts = [];
    if (meta.address) facts.push(meta.address);
    if (meta.liter_capacity != null && meta.liter_capacity !== '') {
      facts.push(`${meta.liter_capacity} L`);
    }
    if (meta.waiting_minutes != null && meta.waiting_minutes !== '') {
      facts.push(`${meta.waiting_minutes} min`);
    }
    if (displayMachineValue(meta.time_dosage)) {
      facts.push(displayMachineValue(meta.time_dosage));
    }
    if (displayMachineValue(meta.port)) {
      facts.push(`porta ${meta.port}`);
    }
    return facts;
  }

  function deviceUnifiedStatus(online, meta) {
    const normalized = normalizeMachineStatus(meta?.status);

    if (normalized === 'suspended') {
      return {
        label: meta?.status_label || 'Suspensa',
        tone: 'suspended',
        pillClass: 'pill--suspended',
      };
    }
    if (normalized === 'occupied') {
      return {
        label: meta?.status_label || 'Ocupada',
        tone: 'occupied',
        pillClass: 'pill--warn',
      };
    }
    if (!online) {
      return {
        label: 'Sem rede',
        tone: 'offline',
        pillClass: 'pill--off',
      };
    }
    if (normalized === 'available') {
      return {
        label: meta?.status_label || 'Disponível',
        tone: 'available',
        pillClass: 'pill--on',
      };
    }
    return { label: 'Online', tone: 'online', pillClass: 'pill--on' };
  }

  function machineMetaRows(meta) {
    if (!meta) return [];
    return [
      ['Tipo', meta.machine_type_label || meta.machine_type],
      ['IP', meta.address],
      ['Status', meta.status_label],
      ['Capacidade', meta.capacity && meta.capacity !== '—' ? meta.capacity : null],
      ['Litros', meta.liter_capacity != null && meta.liter_capacity !== '' ? `${meta.liter_capacity} L` : null],
      ['Espera', meta.waiting_minutes != null && meta.waiting_minutes !== '' ? `${meta.waiting_minutes} min` : null],
      ['Dosagem', displayMachineValue(meta.time_dosage)],
      ['Porta', displayMachineValue(meta.port)],
      ['Loja', meta.store_code],
      ['Endpoint', meta.endpoints?.release || meta.endpoints?.status || null],
    ].filter(([, v]) => v);
  }

  function machineMetaTitle(meta) {
    return machineMetaRows(meta)
      .map(([k, v]) => `${k}: ${v}`)
      .join(' · ');
  }

  const HIDE_WHEN_OFFLINE = [
    { type: 'washer', id: '321' },
    { type: 'dryer', id: '210' },
    { type: 'doser', id: '321' },
  ];

  function isFixedMapExtra(deviceType, machineId) {
    const mid = normalizeStoreId(machineId);
    const dtype = String(deviceType || '').toLowerCase();
    return HIDE_WHEN_OFFLINE.some(
      (rule) => rule.type === dtype && normalizeStoreId(rule.id) === mid
    );
  }

  /** Só equipamentos cadastrados na API Lav60; sem lista, oculta extras do mapa fixo (321/210/321). */
  function isDeviceRegisteredInCatalog(machines, deviceType, machineId) {
    if (!Array.isArray(machines)) {
      return !isFixedMapExtra(deviceType, machineId);
    }
    if (!machines.length) {
      return !isFixedMapExtra(deviceType, machineId);
    }
    const mid = normalizeStoreId(machineId);
    const dtype = String(deviceType || '').toLowerCase();
    return machines.some(
      (m) => String(m.type || '').toLowerCase() === dtype && normalizeStoreId(m.id) === mid
    );
  }

  /** Exige cadastro Lav60; lavadora 321, secadora 210 e dosadora 321 também exigem ping online. */
  function isDeviceVisibleInFrontend(deviceType, machineId, network) {
    const machines = network?.machines;
    if (!isDeviceRegisteredInCatalog(machines, deviceType, machineId)) return false;
    const mid = normalizeStoreId(machineId);
    const dtype = String(deviceType || '').toLowerCase();
    const mustBeOnline = isFixedMapExtra(dtype, mid);
    if (!mustBeOnline) return true;
    const key =
      dtype === 'washer' ? 'washers' : dtype === 'dryer' ? 'dryers' : dtype === 'doser' ? 'dosers' : null;
    if (!key || !network) return false;
    return (network[key] || {})[mid] === true;
  }

  function applyFrontendDeviceVisibility(status, acId = '110') {
    if (!status) return status;
    const next = { ...status };
    [
      ['washer', 'washers'],
      ['dryer', 'dryers'],
      ['doser', 'dosers'],
    ].forEach(([dtype, key]) => {
      const block = next[key] || {};
      next[key] = Object.fromEntries(
        Object.entries(block).filter(([id]) => isDeviceVisibleInFrontend(dtype, id, next))
      );
    });
    if (Array.isArray(next.machines)) {
      next.machines = next.machines.filter((m) =>
        isDeviceVisibleInFrontend(m.type, m.id, next)
      );
    }
    return reconcileStatusSummary(next, acId);
  }

  function devicesFromMachines(machines, network = {}) {
    const ids = { washers: new Set(), dryers: new Set(), dosers: new Set() };
    const catalog = machines || [];
    const net = { ...network, machines: network?.machines ?? catalog };
    catalog.forEach((m) => {
      const t = m.type;
      if (!isDeviceVisibleInFrontend(t, m.id, net)) return;
      const key = t === 'washer' ? 'washers' : t === 'dryer' ? 'dryers' : t === 'doser' ? 'dosers' : null;
      if (key) ids[key].add(normalizeStoreId(m.id));
    });
    if (catalog.length) {
      return {
        washers: [...ids.washers].sort(),
        dryers: [...ids.dryers].sort(),
        dosers: [...ids.dosers].sort(),
        ac: '110',
      };
    }
    ['washers', 'dryers', 'dosers'].forEach((key) => {
      const dtype = { washers: 'washer', dryers: 'dryer', dosers: 'doser' }[key];
      Object.keys(network[key] || {}).forEach((id) => {
        if (isDeviceVisibleInFrontend(dtype, id, net)) {
          ids[key].add(normalizeStoreId(id));
        }
      });
    });
    return {
      washers: [...ids.washers].sort(),
      dryers: [...ids.dryers].sort(),
      dosers: [...ids.dosers].sort(),
      ac: '110',
    };
  }

  /** Alinha config.devices ao status de rede (321/210/321 só aparecem se online). */
  function syncConfigDevices(config, network) {
    if (!config) return config;
    const net = network || config.last_network_check || null;
    const machines = config.machines || [];
    if (machines.length || net) {
      config.devices = devicesFromMachines(machines, net);
    } else if (config.devices) {
      config.devices = {
        washers: (config.devices.washers || []).filter((id) =>
          isDeviceVisibleInFrontend('washer', id, net)
        ),
        dryers: (config.devices.dryers || []).filter((id) =>
          isDeviceVisibleInFrontend('dryer', id, net)
        ),
        dosers: (config.devices.dosers || []).filter((id) =>
          isDeviceVisibleInFrontend('doser', id, net)
        ),
        ac: config.devices.ac || '110',
      };
    }
    return config;
  }

  function buildDeviceDots(status, acId) {
    if (!status) return {};
    const machines = status.machines || [];
    const dots = {};
    ['washers', 'dryers', 'dosers'].forEach((key) => {
      const items = status[key] || {};
      const mtype = DEVICE_GROUP_TYPE[key];
      let list;

      if (machines.length) {
        list = machines
          .filter((m) => m.type === mtype && isDeviceVisibleInFrontend(mtype, m.id, status))
          .map((meta) => {
            const id = normalizeStoreId(meta.id);
            return {
              ...meta,
              id: meta.id,
              online: items[id] === true,
            };
          });
      } else {
        list = Object.keys(items)
          .filter((id) => isDeviceVisibleInFrontend(mtype, id, status))
          .map((id) => {
            const meta = findMachineMeta(machines, id, mtype);
            return {
              ...(meta || {}),
              id,
              online: Boolean(items[id]),
            };
          });
      }

      dots[key] = list.sort((a, b) => normalizeStoreId(a.id).localeCompare(normalizeStoreId(b.id)));
    });
    dots.ac = [{ id: acId || '110', online: Boolean(status.ac) }];
    return dots;
  }

  /** Equipamento operacional = responde na rede e não está suspenso. */
  function isDeviceOperational(dev) {
    if (!dev?.online) return false;
    return normalizeMachineStatus(dev.status) !== 'suspended';
  }

  function isDeviceSuspended(dev) {
    return normalizeMachineStatus(dev?.status) === 'suspended';
  }

  function countDeviceStates(devices) {
    let suspended = 0;
    let offlineNetwork = 0;
    ['washers', 'dryers', 'dosers', 'ac'].forEach((key) => {
      (devices?.[key] || []).forEach((dev) => {
        if (isDeviceSuspended(dev)) suspended += 1;
        else if (!dev.online) offlineNetwork += 1;
      });
    });
    return { suspended, offlineNetwork };
  }

  function summaryFromDevices(devices) {
    let online = 0;
    let total = 0;
    const categories = {};
    ['washers', 'dryers', 'dosers', 'ac'].forEach((key) => {
      const list = devices[key] || [];
      let catOn = 0;
      list.forEach((dev) => {
        total += 1;
        if (isDeviceOperational(dev)) catOn += 1;
      });
      categories[key] = { online: catOn, total: list.length };
      online += catOn;
    });
    return {
      total,
      online,
      offline: total - online,
      categories,
    };
  }

  function reconcileStatusSummary(status, acId = '110') {
    if (!status) return status;
    const devices = buildDeviceDots(status, acId);
    const rollup = summaryFromDevices(devices);
    if (rollup.total > 0) {
      status.summary = rollup;
      return status;
    }
    if (!status.summary) attachSummary(status);
    return status;
  }

  function storeHealthState(summary, error) {
    if (error) return 'unreachable';
    if (!summary) return 'unknown';
    const { online = 0, total = 0 } = summary;
    if (total <= 0) return 'unknown';
    if (online >= total) return 'ok';
    if (online <= 0) return 'offline';
    return 'partial';
  }

  function buildStoreCard(meta, status, error, catalog, extra = {}) {
    const acId = catalog?.ac_id || '110';
    if (status) status = applyFrontendDeviceVisibility({ ...status }, acId);
    const summary = status?.summary || null;
    const agentUnavailable = isAgentUnavailableError(error);
    const hasDeviceData = Boolean(summary?.total);
    const card = {
      id: normalizeStoreId(meta.id),
      name: meta.name || meta.id.toUpperCase(),
      agent: agentBaseUrl(meta, catalog),
      state: agentUnavailable ? 'unreachable' : storeHealthState(summary, error),
      accessible: !error && Boolean(status) && hasDeviceData && !agentUnavailable,
      agentUnavailable,
      summary,
      devices: buildDeviceDots(status, acId),
      machines: status?.machines || [],
      timestamp: status?.timestamp || null,
      error: error
        ? agentUnavailable
          ? noAgentMessage(meta.id)
          : friendlyUserMessage(error)
        : null,
      ...extra,
    };
    return normalizeCardAccess(card);
  }

  function buildPlaceholderCard(meta, catalog) {
    return buildStoreCard(meta, null, null, catalog, {
      accessible: false,
      state: 'unknown',
      loading: true,
      error: null,
    });
  }

  function buildDashboard(cards) {
    const ready = cards.filter((c) => !c.loading);
    const connected = ready.filter((c) => c.accessible);
    const operational = connected.filter((c) => (c.summary?.online ?? 0) > 0);
    const allDevicesOffline = connected.filter((c) => (c.summary?.online ?? 0) <= 0);
    const unreachable = ready.filter((c) => !c.accessible);
    const partialCount = connected.filter((c) => {
      const on = c.summary?.online ?? 0;
      const tot = c.summary?.total ?? 0;
      return on > 0 && on < tot;
    }).length;
    let devicesOnline = 0;
    let devicesTotal = 0;
    let devicesSuspended = 0;
    let devicesOfflineNetwork = 0;
    const devicesSuspendedEvents = [];
    const devicesOfflineNetworkEvents = [];
    const storesOnlineEvents = [];
    const storesOfflineEvents = [];
    const typeLabels = {
      washers: 'Lavadora',
      dryers: 'Secadora',
      dosers: 'Dosadora',
      ac: 'AC',
    };

    ready.forEach((card) => {
      if (card.loading) return;
      const storeEntry = {
        store: card.id,
        store_name: card.name || card.id.toUpperCase(),
        state: card.state,
        summary_online: card.summary?.online ?? 0,
        summary_total: card.summary?.total ?? 0,
      };
      if (card.accessible && (card.summary?.online ?? 0) > 0) {
        storesOnlineEvents.push({
          ...storeEntry,
          health_pct: card.summary?.total
            ? Math.round(((card.summary?.online ?? 0) / card.summary.total) * 100)
            : 0,
        });
      }
      if (!card.accessible) {
        storesOfflineEvents.push({
          ...storeEntry,
          kind: 'unreachable',
          reason: card.agentUnavailable
            ? noAgentMessage(card.id)
            : card.error || 'Loja indisponível',
          offline_since: card.offlineSince || null,
        });
      } else if ((card.summary?.online ?? 0) <= 0 && (card.summary?.total ?? 0) > 0) {
        storesOfflineEvents.push({
          ...storeEntry,
          kind: 'devices_down',
          reason: 'Nenhum equipamento operacional',
          offline_since: null,
        });
      }
    });

    connected.forEach((card) => {
      const summary = card.summary || {};
      devicesOnline += summary.online || 0;
      devicesTotal += summary.total || 0;
      const stateCounts = countDeviceStates(card.devices);
      devicesSuspended += stateCounts.suspended;
      devicesOfflineNetwork += stateCounts.offlineNetwork;
      Object.entries(typeLabels).forEach(([group, label]) => {
        (card.devices?.[group] || []).forEach((dev) => {
          if (isDeviceSuspended(dev)) {
            devicesSuspendedEvents.push({
              store: card.id,
              store_name: card.name || card.id.toUpperCase(),
              type_label: label,
              id: dev.id,
              status_label: dev.status_label || 'Suspensa',
            });
          } else if (!dev.online) {
            devicesOfflineNetworkEvents.push({
              store: card.id,
              store_name: card.name || card.id.toUpperCase(),
              type_label: label,
              id: dev.id,
              status_label: dev.status_label || 'Sem rede',
            });
          }
        });
      });
    });

    return {
      stores: {
        total: cards.length,
        online: operational.length,
        connected: connected.length,
        offline: unreachable.length + allDevicesOffline.length,
        partial: partialCount,
        pending: cards.filter((c) => c.loading).length,
      },
      devices: {
        online: devicesOnline,
        total: devicesTotal,
        offline: devicesSuspended + devicesOfflineNetwork,
        suspended: devicesSuspended,
        offline_network: devicesOfflineNetwork,
        health_pct: devicesTotal ? Math.round((devicesOnline / devicesTotal) * 100) : 0,
      },
      events: {
        stores_online: storesOnlineEvents.sort((a, b) => a.store.localeCompare(b.store)),
        stores_offline: storesOfflineEvents.sort((a, b) => a.store.localeCompare(b.store)),
        devices_suspended: devicesSuspendedEvents.sort((a, b) =>
          a.store.localeCompare(b.store) || String(a.id).localeCompare(String(b.id))
        ),
        devices_offline_network: devicesOfflineNetworkEvents.sort((a, b) =>
          a.store.localeCompare(b.store) || String(a.id).localeCompare(String(b.id))
        ),
      },
    };
  }

  function loadOfflineSinceMap() {
    try {
      return JSON.parse(localStorage.getItem(OFFLINE_SINCE_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function saveOfflineSinceMap(map) {
    localStorage.setItem(OFFLINE_SINCE_KEY, JSON.stringify(map));
  }

  function syncStoreOfflineSince(cards) {
    const map = loadOfflineSinceMap();
    const now = Date.now();
    let changed = false;

    cards.forEach((card) => {
      if (card.loading) return;

      if (!card.accessible) {
        if (!map[card.id]) {
          map[card.id] = now;
          changed = true;
        }
        card.offlineSince = map[card.id];
      } else if (map[card.id]) {
        delete map[card.id];
        changed = true;
        card.offlineSince = null;
      } else {
        card.offlineSince = null;
      }
    });

    if (changed) saveOfflineSinceMap(map);
    return cards;
  }

  function formatOfflineDuration(sinceMs) {
    if (sinceMs == null || sinceMs === '') return '';
    const ms = typeof sinceMs === 'number' ? sinceMs : new Date(sinceMs).getTime();
    if (!ms || Number.isNaN(ms)) return '';

    const diff = Math.max(0, Date.now() - ms);
    const min = Math.floor(diff / 60000);
    const hr = Math.floor(min / 60);
    const day = Math.floor(hr / 24);

    if (day >= 1) return `${day}d ${hr % 24}h`;
    if (hr >= 1) return `${hr}h ${min % 60}min`;
    if (min >= 1) return `${min} min`;
    return 'menos de 1 min';
  }

  function assemblePayload(cards, extra = {}) {
    syncStoreOfflineSince(cards);
    cards.sort((a, b) => a.id.localeCompare(b.id));
    return {
      stores: cards,
      dashboard: buildDashboard(cards),
      timestamp: new Date().toISOString(),
      ...extra,
    };
  }

  function getCacheTtlMs(catalog) {
    if (catalog?.cache_ttl_seconds) return catalog.cache_ttl_seconds * 1000;
    return DEFAULT_CACHE_TTL_MS;
  }

  function getOfflineRetryTtlMs(catalog) {
    if (catalog?.offline_retry_seconds) return catalog.offline_retry_seconds * 1000;
    return 15000;
  }

  function getOnlineRetryTtlMs(catalog) {
    if (catalog?.online_retry_seconds) return catalog.online_retry_seconds * 1000;
    if (catalog?.offline_retry_seconds) return catalog.offline_retry_seconds * 1000;
    return 30000;
  }

  function getHeartbeatTimeoutMs(catalog) {
    if (catalog?.heartbeat_timeout_seconds) return catalog.heartbeat_timeout_seconds * 1000;
    return 90000;
  }

  /** Tempo sem heartbeat antes do card do dashboard mostrar offline (>= timeout técnico). */
  function getOfflineDisplayDelayMs(catalog) {
    const timeoutMs = getHeartbeatTimeoutMs(catalog);
    if (catalog?.offline_display_delay_seconds) {
      return Math.max(catalog.offline_display_delay_seconds * 1000, timeoutMs);
    }
    return Math.max(timeoutMs * 2, 120000);
  }

  const heartbeatState = new Map();
  let heartbeatMonitorStarted = false;
  let heartbeatEventSource = null;
  let heartbeatTimeoutTimer = null;
  let heartbeatPollTimer = null;
  let heartbeatStreamReconnectMs = 3000;
  let heartbeatPageStartedAt = Date.now();
  let heartbeatCatalog = null;
  let heartbeatOnUpdate = null;
  let heartbeatAuthToken = '';
  let dashboardCacheMap = {};
  let persistDashboardTimer = null;

  function cardHasDeviceDots(card) {
    return Object.values(card?.devices || {}).some(
      (list) => Array.isArray(list) && list.length
    );
  }

  function cardFromCacheRow(meta, row, catalog) {
    if (!row?.card) return null;
    const acId = catalog?.ac_id || '110';
    const card = normalizeCardAccess({ ...row.card, loading: false });
    let status = row.status ? { ...row.status } : statusFromCard(row.card);
    if (status) {
      status = applyFrontendDeviceVisibility(status, acId);
      card.devices = buildDeviceDots(status, acId);
      card.summary = status.summary || card.summary;
      card.timestamp = status.timestamp || card.timestamp;
      card.machines = status.machines || card.machines || [];
    }
    if (card.summary) {
      card.state = storeHealthState(card.summary, card.error);
    }
    card.fromCache = true;
    card.cachedAt = row.cachedAt;
    return card;
  }

  async function loadDashboardCacheMap(catalog) {
    const hash = Cache.catalogHash(catalog.stores || []);
    const rows = await Cache.getAll();
    const map = {};
    (rows || []).forEach((row) => {
      if (row?.id && row.catalogHash === hash) {
        map[row.id] = row;
      }
    });
    return map;
  }

  function schedulePersistDashboardCards(cards, catalog) {
    if (persistDashboardTimer) clearTimeout(persistDashboardTimer);
    persistDashboardTimer = setTimeout(() => {
      persistDashboardCards(cards, catalog).catch(() => {});
    }, 1200);
  }

  async function persistDashboardCards(cards, catalog) {
    const hash = Cache.catalogHash(catalog.stores || []);
    const entries = (cards || [])
      .filter((c) => c && !c.loading)
      .map((c) => {
        const copy = { ...c, loading: false };
        delete copy.fromCache;
        delete copy.cachedAt;
        return [c.id, copy, statusFromCard(c)];
      });
    if (!entries.length) return;
    await Cache.setManyWithStatus(entries, hash);
  }

  function buildCardsFromCache(catalog, cacheMap) {
    return (catalog.stores || []).map((meta) => {
      const row = cacheMap[normalizeStoreId(meta.id)];
      if (row) {
        const card = cardFromCacheRow(meta, row, catalog);
        if (card) return card;
      }
      return buildPlaceholderCard(meta, catalog);
    });
  }

  function ingestHeartbeatEntry(storeId, entry) {
    const id = normalizeStoreId(storeId);
    if (!id) return;
    const prev = heartbeatState.get(id);
    const receivedAt =
      typeof entry?.received_at === 'number'
        ? entry.received_at * 1000
        : entry?.receivedAt || Date.now();
    const payload = entry?.payload || entry;
    const status = statusFromHeartbeatPayload(null, payload, id);
    heartbeatState.set(id, {
      receivedAt,
      payload,
      lastStatus: status || prev?.lastStatus || null,
    });
  }

  function ingestHeartbeatSnapshot(snapshot) {
    const items = snapshot?.heartbeats || snapshot || {};
    Object.entries(items).forEach(([storeId, entry]) => {
      ingestHeartbeatEntry(storeId, entry);
    });
  }

  function networkPayloadHasDevices(network) {
    if (!network || typeof network !== 'object') return false;
    if (network.summary?.total > 0) return true;
    return ['washers', 'dryers', 'dosers'].some(
      (key) => network[key] && Object.keys(network[key]).length > 0
    );
  }

  function statusFromHeartbeatPayload(meta, payload, catalogId) {
    const network = payload?.network;
    if (!networkPayloadHasDevices(network)) {
      return null;
    }
    const status = {
      store: normalizeStoreId(payload.store || catalogId),
      washers: network.washers || {},
      dryers: network.dryers || {},
      dosers: network.dosers || {},
      ac: Boolean(network.ac),
      timestamp: network.timestamp || payload.timestamp || new Date().toISOString(),
      summary: network.summary || null,
    };
    status.machines = payload?.machines || [];
    return applyFrontendDeviceVisibility(status);
  }

  function attachAgentUrlToCard(card, hb) {
    const agentUrl = hb?.payload?.agent_url;
    if (agentUrl) {
      card.agent = normalizeAgentUrl(agentUrl);
    }
    return card;
  }

  function buildOnlineCardFromHeartbeat(meta, catalog, hb, status) {
    const id = normalizeStoreId(meta.id);
    heartbeatState.set(id, { ...hb, lastStatus: status });
    return attachAgentUrlToCard(
      buildStoreCard(meta, status, null, catalog, { fromHeartbeat: true }),
      hb
    );
  }

  function buildOfflineCardFromHeartbeat(meta, catalog, hb, cacheMap) {
    const lastStatus = hb?.lastStatus || null;
    if (lastStatus) {
      return buildStoreCard(meta, lastStatus, 'Sem conexão com a loja', catalog, {
        staleSnapshot: Boolean(lastStatus),
      });
    }
    const cachedRow = cacheMap?.[normalizeStoreId(meta.id)];
    if (cachedRow) {
      const cached = cardFromCacheRow(meta, cachedRow, catalog);
      if (cached) {
        return {
          ...cached,
          accessible: false,
          staleSnapshot: true,
          error: friendlyUserMessage('Sem conexão com a loja'),
          state: 'unreachable',
        };
      }
    }
    return buildStoreCard(meta, null, 'Sem conexão com a loja', catalog);
  }

  function buildCardFromHeartbeat(meta, catalog, cacheMap = dashboardCacheMap) {
    const id = normalizeStoreId(meta.id);
    const hb = heartbeatState.get(id);
    const displayDelayMs = getOfflineDisplayDelayMs(catalog);
    const now = Date.now();
    const cachedRow = cacheMap?.[id];

    function fromCache() {
      if (!cachedRow) return null;
      return cardFromCacheRow(meta, cachedRow, catalog);
    }

    if (!hb) {
      const cached = fromCache();
      if (cached) return cached;
      if (now - heartbeatPageStartedAt < displayDelayMs) {
        return buildPlaceholderCard(meta, catalog);
      }
      return buildStoreCard(meta, null, 'Sem conexão com a loja', catalog);
    }

    const ageMs = now - hb.receivedAt;

    if (ageMs > displayDelayMs) {
      return buildOfflineCardFromHeartbeat(meta, catalog, hb, cacheMap);
    }

    const status = statusFromHeartbeatPayload(meta, hb.payload, id) || hb.lastStatus;
    if (status?.summary?.total > 0) {
      return buildOnlineCardFromHeartbeat(meta, catalog, hb, status);
    }

    const cached = fromCache();
    if (cached) return cached;
    return buildPlaceholderCard(meta, catalog);
  }

  function buildPayloadFromHeartbeats(catalog, extra = {}) {
    const list = catalog.stores || [];
    const cards = list.map((meta) => buildCardFromHeartbeat(meta, catalog, dashboardCacheMap));
    return assemblePayload(cards, { fromHeartbeat: true, ...extra });
  }

  function emitHeartbeatUpdate(extra = {}) {
    if (!heartbeatCatalog || !heartbeatOnUpdate) return;
    heartbeatCatalog = rebuildCatalogStores(heartbeatCatalog);
    const payload = buildPayloadFromHeartbeats(heartbeatCatalog, extra);
    schedulePersistDashboardCards(payload.stores, heartbeatCatalog);
    heartbeatOnUpdate(payload);
  }

  function stopHeartbeatMonitor() {
    heartbeatMonitorStarted = false;
    if (heartbeatEventSource) {
      heartbeatEventSource.close();
      heartbeatEventSource = null;
    }
    if (heartbeatTimeoutTimer) {
      clearInterval(heartbeatTimeoutTimer);
      heartbeatTimeoutTimer = null;
    }
    if (heartbeatPollTimer) {
      clearInterval(heartbeatPollTimer);
      heartbeatPollTimer = null;
    }
  }

  function connectHeartbeatStream() {
    if (!heartbeatMonitorStarted) return;
    if (heartbeatEventSource) {
      heartbeatEventSource.close();
      heartbeatEventSource = null;
    }
    heartbeatEventSource = new EventSource('/api/heartbeats/stream');
    heartbeatEventSource.onmessage = (event) => {
      heartbeatStreamReconnectMs = 3000;
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'heartbeat') {
          ingestHeartbeatEntry(msg.store, msg);
          emitHeartbeatUpdate({ live: true });
        } else if (msg.type === 'snapshot') {
          ingestHeartbeatSnapshot(msg);
          emitHeartbeatUpdate({ live: true, snapshot: true });
        }
      } catch {
        /* ignore malformed SSE */
      }
    };
    heartbeatEventSource.onerror = () => {
      if (!heartbeatMonitorStarted) return;
      if (heartbeatEventSource) {
        heartbeatEventSource.close();
        heartbeatEventSource = null;
      }
      const delay = heartbeatStreamReconnectMs;
      heartbeatStreamReconnectMs = Math.min(Math.round(heartbeatStreamReconnectMs * 1.5), 30000);
      setTimeout(connectHeartbeatStream, delay);
    };
  }

  function startHeartbeatMonitor(catalog, onUpdate, token = '') {
    heartbeatCatalog = catalog;
    heartbeatOnUpdate = onUpdate;
    heartbeatAuthToken = token || '';
    heartbeatPageStartedAt = Date.now();
    heartbeatStreamReconnectMs = 3000;
    if (heartbeatMonitorStarted) return;
    heartbeatMonitorStarted = true;

    pollHeartbeatsSnapshot();
    if (heartbeatPollTimer) clearInterval(heartbeatPollTimer);
    heartbeatPollTimer = setInterval(pollHeartbeatsSnapshot, 20000);

    connectHeartbeatStream();

    if (heartbeatTimeoutTimer) clearInterval(heartbeatTimeoutTimer);
    heartbeatTimeoutTimer = setInterval(() => {
      emitHeartbeatUpdate({ tick: true });
    }, 5000);
  }

  async function pollHeartbeatsSnapshot() {
    try {
      const snap = await fetchHeartbeatsSnapshot();
      ingestHeartbeatSnapshot(snap);
      emitHeartbeatUpdate({ poll: true });
    } catch {
      /* painel indisponível */
    }
  }

  async function fetchHeartbeatsSnapshot() {
    const res = await fetch('/api/heartbeats', { credentials: 'same-origin' });
    if (!res.ok) {
      throw new Error('Painel de heartbeat indisponível — execute .\\serve.ps1');
    }
    return res.json();
  }

  /**
   * Loja/card: escuta SSE do painel e aplica status ao vivo (mesma fonte do dashboard).
   * Retorna função para cancelar a inscrição.
   */
  function watchStoreHeartbeat(storeId, catalog, onStatus, options = {}) {
    const id = normalizeStoreId(storeId);
    if (!id || typeof onStatus !== 'function') {
      return () => {};
    }

    const skipInitialBootstrap = options.skipInitialBootstrap === true;
    const skipInitialPoll = options.skipInitialPoll === true;

    let stopped = false;
    let eventSource = null;
    let pollTimer = null;
    let streamReconnectMs = 3000;

    function deliver(entry) {
      if (stopped || !entry) return;
      const payload = entry.payload || entry;
      const status = statusFromHeartbeatPayload(null, payload, id);
      if (!status?.summary?.total) return;
      onStatus(status, { live: true, receivedAt: entry.received_at || entry.receivedAt });
    }

    async function bootstrap() {
      try {
        const snap = await fetchHeartbeatsSnapshot();
        const entry = snap.heartbeats?.[id];
        if (entry && isHeartbeatEntryAlive(entry, catalog)) {
          deliver(entry);
        }
      } catch {
        /* painel indisponível */
      }
    }

    function connect() {
      if (stopped) return;
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      eventSource = new EventSource('/api/heartbeats/stream');
      eventSource.onmessage = (event) => {
        if (stopped) return;
        streamReconnectMs = 3000;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'heartbeat' && normalizeStoreId(msg.store) === id) {
            deliver(msg);
          } else if (msg.type === 'snapshot') {
            const entry = msg.heartbeats?.[id];
            if (entry) deliver(entry);
          }
        } catch {
          /* ignore malformed SSE */
        }
      };
      eventSource.onerror = () => {
        if (stopped) return;
        if (eventSource) {
          eventSource.close();
          eventSource = null;
        }
        const delay = streamReconnectMs;
        streamReconnectMs = Math.min(Math.round(streamReconnectMs * 1.5), 30000);
        setTimeout(connect, delay);
      };
    }

    async function pollOnce() {
      if (stopped) return;
      try {
        const snap = await fetchHeartbeatsSnapshot();
        const entry = snap.heartbeats?.[id];
        if (entry && isHeartbeatEntryAlive(entry, catalog)) {
          deliver(entry);
        }
      } catch {
        /* painel indisponível */
      }
    }

    if (skipInitialBootstrap) {
      connect();
    } else {
      bootstrap().then(connect);
    }
    if (!skipInitialPoll) {
      pollOnce();
    }
    pollTimer = setInterval(pollOnce, 20000);

    return () => {
      stopped = true;
      if (pollTimer) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
    };
  }

  async function fetchStoreStatusFromHeartbeat(meta, catalog) {
    const id = normalizeStoreId(meta.id);
    const snap = await fetchHeartbeatsSnapshot();
    const entry = snap.heartbeats?.[id];
    if (!entry || !isHeartbeatEntryAlive(entry, catalog)) {
      return { status: null, error: 'Sem heartbeat recente do agente' };
    }
    const status = statusFromHeartbeatPayload(meta, entry.payload || entry, id);
    if (!status?.summary?.total) {
      return { status: null, error: 'Aguardando leitura de equipamentos' };
    }
    return { status, error: null };
  }

  function isStoreAliveInHeartbeats(storeId, catalog) {
    const id = normalizeStoreId(storeId);
    const hb = heartbeatState.get(id);
    if (!hb) return false;
    return Date.now() - hb.receivedAt <= getHeartbeatTimeoutMs(catalog);
  }

  function getAgentProbeTimeoutMs(catalog) {
    if (catalog?.agent_probe_timeout_seconds) return catalog.agent_probe_timeout_seconds * 1000;
    return 10000;
  }

  function getStatusFullTimeoutMs(catalog) {
    if (catalog?.status_timeout_seconds) return catalog.status_timeout_seconds * 1000;
    return 45000;
  }

  function statusFromAgentConfig(config, catalogId) {
    const cached = config?.last_network_check;
    if (!cached || typeof cached !== 'object') return null;
    if (!cached.washers && !cached.dryers && !cached.dosers) return null;
    const status = {
      store: normalizeStoreId(config.store || catalogId),
      washers: cached.washers || {},
      dryers: cached.dryers || {},
      dosers: cached.dosers || {},
      ac: Boolean(cached.ac),
      timestamp: cached.timestamp || new Date().toISOString(),
      summary: cached.summary || null,
    };
    status.machines = config?.machines || [];
    return applyFrontendDeviceVisibility(status);
  }

  function connectionErrorMessage(err, catalogId) {
    const name = err?.name || '';
    const msg = err?.message || String(err || '');
    if (name === 'AbortError' || /abort/i.test(msg)) {
      return 'Sem conexão com a loja';
    }
    return friendlyUserMessage(msg || 'Falha de rede');
  }

  function shouldRefreshStore(meta, row, hash, catalog, force) {
    if (force) return true;
    if (!row || row.catalogHash !== hash) return true;
    const card = normalizeCardAccess(row.card);
    if (!card.accessible || card.agentUnavailable || card.loading) {
      return !Cache.isFresh(row, hash, getOfflineRetryTtlMs(catalog));
    }
    // Loja online também revalida no intervalo curto (detecta agente parado)
    return !Cache.isFresh(row, hash, getOnlineRetryTtlMs(catalog));
  }

  function getConcurrency(catalog) {
    return catalog?.refresh_concurrency || 15;
  }

  async function loadCatalog() {
    let res = await fetch('/api/catalog', { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) {
      res = await fetch(`./stores.json?_=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin' });
    }
    if (!res.ok) throw new Error('Configuração do painel indisponível');
    return res.json();
  }

  function storeMetaFromId(storeId, entry = null) {
    const id = normalizeStoreId(storeId);
    if (!id) return null;
    const payload = entry?.payload || entry || {};
    const name = String(payload.store_name || payload.name || id.toUpperCase()).trim();
    return { id, name: name || id.toUpperCase() };
  }

  function rebuildCatalogStores(catalog) {
    const byId = new Map();
    (catalog?.stores || []).forEach((meta) => {
      const id = normalizeStoreId(meta.id);
      if (id) byId.set(id, { ...meta, id, name: meta.name || id.toUpperCase() });
    });
    heartbeatState.forEach((hb, id) => {
      byId.set(id, storeMetaFromId(id, { payload: hb.payload }));
    });
    const stores = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    return { ...(catalog || {}), stores };
  }

  async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...options, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchStoreStatus(meta, catalog, token, endpointOverride = null, options = {}) {
    const catalogId = normalizeStoreId(meta.id);
    const ep = endpointOverride || (await discoverAgentEndpoint(meta, catalog, token));

    if (ep.unmatched) {
      return {
        status: null,
        error: noAgentMessage(catalogId),
      };
    }

    const { base, storeId } = ep;
    const agentBase = normalizeAgentUrl(base).replace(/\/$/, '');
    const configUrl = `${agentBase}/api/agent/config`;

    let config;
    try {
      const res = await fetchWithTimeout(
        configUrl,
        { headers: authHeaders(token) },
        getAgentProbeTimeoutMs(catalog)
      );
      if (!res.ok) {
        invalidateAgentDiscovery(catalogId);
        return { status: null, error: friendlyUserMessage(`HTTP ${res.status}`) };
      }
      config = await res.json();
    } catch (e) {
      invalidateAgentDiscovery(catalogId);
      return { status: null, error: connectionErrorMessage(e, catalogId) };
    }

    if (!agentStoreMatchesCatalog(config.store, catalogId)) {
      invalidateAgentDiscovery(catalogId);
      return { status: null, error: noAgentMessage(catalogId) };
    }

    const cachedStatus = statusFromAgentConfig(config, catalogId);
    if (cachedStatus && options.force !== true) {
      return { status: cachedStatus, error: null };
    }

    const statusUrl = `${agentBase}/${storeId}/status`;
    try {
      const res = await fetchWithTimeout(
        statusUrl,
        { headers: authHeaders(token) },
        getStatusFullTimeoutMs(catalog)
      );
      if (!res.ok) {
        return { status: null, error: friendlyUserMessage(`HTTP ${res.status}`) };
      }
      const status = await res.json();
      if (status.store && !agentStoreMatchesCatalog(status.store, catalogId)) {
        return { status: null, error: noAgentMessage(catalogId) };
      }
      if (status && !status.summary) attachSummary(status);
      return { status, error: null };
    } catch (e) {
      return { status: null, error: connectionErrorMessage(e, catalogId) };
    }
  }

  async function runPool(items, concurrency, worker) {
    let index = 0;
    let done = 0;
    const total = items.length;

    async function runner() {
      while (index < items.length) {
        const i = index++;
        await worker(items[i], i);
        done += 1;
      }
    }

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => runner());
    await Promise.all(workers);
    return done;
  }

  async function refreshOneStore(meta, catalog, token, hash, endpointOverride = null) {
    const id = normalizeStoreId(meta.id);
    const { status, error } = await fetchStoreStatus(meta, catalog, token, endpointOverride);
    if (status && !status.summary) attachSummary(status);
    const card = buildStoreCard(meta, status, error, catalog, { fromCache: false });
    await Cache.setStore(id, card, hash, status);
    return card;
  }

  /** Reconstrói payload /status a partir do card (cache antigo sem status). */
  function statusFromCard(card) {
    if (!card) return null;
    const status = {
      washers: {},
      dryers: {},
      dosers: {},
      ac: false,
      timestamp: card.timestamp,
      summary: card.summary,
    };
    (card.devices?.washers || []).forEach((d) => {
      status.washers[d.id] = Boolean(d.online);
    });
    (card.devices?.dryers || []).forEach((d) => {
      status.dryers[d.id] = Boolean(d.online);
    });
    (card.devices?.dosers || []).forEach((d) => {
      status.dosers[d.id] = Boolean(d.online);
    });
    const acDev = (card.devices?.ac || [])[0];
    status.ac = acDev ? Boolean(acDev.online) : false;
    return status;
  }

  const WASHER_DOSAGE_OPTIONS = [
    { value: 'am01-1', label: 'Floral simples' },
    { value: 'am01-2', label: 'Floral dupla' },
    { value: 'am02-1', label: 'Sport simples' },
    { value: 'am02-2', label: 'Sport dupla' },
    { value: '', label: 'Sem cheiro', wide: true },
  ];

  function configFromStatus(status) {
    const machines = status?.machines || [];
    return {
      devices: devicesFromMachines(machines, status || {}),
      machines,
      washer_dosage_options: WASHER_DOSAGE_OPTIONS,
      washer_am_options: WASHER_DOSAGE_OPTIONS.filter((o) => o.value).map((o) => o.value),
      dryer_minutes: [15, 30, 45],
      ac_temperatures: ['18', '22', 'off'],
    };
  }

  async function getCachedStoreEntry(meta, catalog) {
    const id = normalizeStoreId(meta.id);
    const hash = Cache.catalogHash(catalog.stores || []);
    const row = await Cache.getStore(id);
    if (!row || row.catalogHash !== hash) {
      return null;
    }
    const status = row.status ? { ...row.status } : statusFromCard(row.card);
    return {
      card: row.card,
      status,
      cachedAt: row.cachedAt,
      fresh: Cache.isFresh(row, hash, getCacheTtlMs(catalog)),
    };
  }

  /**
   * Dashboard: recebe heartbeats dos agentes via painel (push).
   * options: { force, onUpdate }
   */
  async function enrichOfflineCardsFromCache(cards, catalog) {
    const hash = Cache.catalogHash(catalog.stores || []);
    const acId = catalog?.ac_id || '110';

    await Promise.all(
      cards.map(async (card) => {
        if (card.accessible || card.loading) return;
        const hasDots = Object.values(card.devices || {}).some(
          (list) => Array.isArray(list) && list.length
        );
        if (hasDots) return;

        const row = await Cache.getStore(card.id);
        if (!row || row.catalogHash !== hash) return;

        const status = row.status ? { ...row.status } : statusFromCard(row.card);
        if (!status) return;

        reconcileStatusSummary(status, acId);
        card.devices = buildDeviceDots(status, acId);
        card.summary = status.summary || row.card?.summary || null;
        card.timestamp = status.timestamp || row.card?.timestamp || null;
        card.staleSnapshot = true;
      })
    );
  }

  async function loadAllStores(token, options = {}) {
    const { onUpdate } = options;
    let catalog = await loadCatalog();
    heartbeatPageStartedAt = Date.now();

    const snapshot = await fetchHeartbeatsSnapshot();
    ingestHeartbeatSnapshot(snapshot);
    catalog = rebuildCatalogStores(catalog);
    heartbeatCatalog = catalog;

    dashboardCacheMap = options.force ? {} : await loadDashboardCacheMap(catalog);

    if (!options.force && Object.keys(dashboardCacheMap).length && onUpdate) {
      onUpdate(
        assemblePayload(buildCardsFromCache(catalog, dashboardCacheMap), {
          fromCache: true,
          live: false,
          refreshing: false,
        })
      );
    }

    let cards = (catalog.stores || []).map((meta) =>
      buildCardFromHeartbeat(meta, catalog, dashboardCacheMap)
    );
    await enrichOfflineCardsFromCache(cards, catalog);

    const payload = assemblePayload(cards, {
      fromHeartbeat: true,
      fromCache: false,
      live: true,
      refreshing: false,
      heartbeatTimeoutSeconds: snapshot.timeout_seconds,
    });

    schedulePersistDashboardCards(payload.stores, catalog);
    if (onUpdate) onUpdate(payload);

    startHeartbeatMonitor(
      catalog,
      (partial) => {
        schedulePersistDashboardCards(partial.stores, catalog);
        if (onUpdate) onUpdate({ ...partial, live: true, fromCache: false });
      },
      token
    );
    return payload;
  }

  async function loadStoreCached(meta, catalog, token, options = {}) {
    const id = normalizeStoreId(meta.id);
    const hash = Cache.catalogHash(catalog.stores || []);
    const force = options.force === true;

    if (!force) {
      const row = await Cache.getStore(id);
      if (row && !shouldRefreshStore(meta, row, hash, catalog, false)) {
        const status = row.status ? { ...row.status } : statusFromCard(row.card);
        return { card: normalizeCardAccess(row.card), status, fromCache: true };
      }
    }

    const { status, error } = await fetchStoreStatus(
      meta,
      catalog,
      token,
      options.endpointOverride || null,
      { force: options.force === true }
    );
    if (status && !status.summary) attachSummary(status);
    const card = buildStoreCard(meta, status, error, catalog, { fromCache: false });
    await Cache.setStore(id, card, hash, status);
    return { card, status, fromCache: false };
  }

  function findStoreInCatalog(catalog, storeId) {
    const id = normalizeStoreId(storeId);
    if (!id) return null;
    const found = (catalog.stores || []).find((s) => normalizeStoreId(s.id) === id);
    if (found) return found;
    const hb = heartbeatState.get(id);
    if (hb) return storeMetaFromId(id, { payload: hb.payload });
    return storeMetaFromId(id);
  }

  async function fetchAgentConfig(meta, catalog, token, endpointOverride = null) {
    const ep = endpointOverride || (await discoverAgentEndpoint(meta, catalog, token));
    if (ep.unmatched || !ep.base) {
      throw new Error(noAgentMessage(meta.id));
    }
    const { base } = ep;
    const configBase = normalizeAgentUrl(base).replace(/\/$/, '');
    const res = await fetch(`${configBase}/api/agent/config`, {
      headers: authHeaders(token),
    });
    if (!res.ok) {
      throw new Error(friendlyUserMessage(`Config: HTTP ${res.status}`));
    }
    const data = await res.json();
    return { ...data, washer_dosage_options: WASHER_DOSAGE_OPTIONS };
  }

  async function agentRequest(meta, catalog, token, method, path, body, endpointOverride = null) {
    const ep = endpointOverride || (await discoverAgentEndpoint(meta, catalog, token));
    if (ep.unmatched || !ep.base) {
      throw new Error(noAgentMessage(meta.id));
    }
    const { base, storeId } = ep;
    const agentBase = normalizeAgentUrl(base).replace(/\/$/, '');
    let url;
    if (path.startsWith('/api/')) {
      url = `${agentBase}${path}`;
    } else {
      const sub = path.startsWith('/') ? path : `/${path}`;
      url = `${agentBase}/${storeId}${sub}`;
    }
    const opts = {
      method,
      headers: authHeaders(token, { 'Content-Type': 'application/json' }),
    };
    if (body !== undefined) opts.body = JSON.stringify(body);
    const res = await fetch(url, opts);
    let data;
    try {
      data = await res.json();
    } catch {
      data = { detail: res.statusText || 'Erro desconhecido' };
    }
    if (!res.ok) {
      throw new Error(friendlyUserMessage(data.detail || data.message || data.error || `HTTP ${res.status}`, ''));
    }
    data._httpStatus = res.status;
    return data;
  }

  window.Lav60 = {
    WASHER_DOSAGE_OPTIONS,
    ensureDefaultAgentToken,
    normalizeStoreId,
    noAgentMessage,
    isAgentUnavailableError,
    normalizeCardAccess,
    friendlyUserMessage,
    formatOperatorError,
    agentBaseUrl,
    resolveAgentEndpoint,
    resolveAgentEndpointForStore,
    discoverAgentEndpoint,
    invalidateAgentDiscovery,
    clearAgentDiscoveryCache,
    normalizeAgentUrl,
    getPollIntervalMs: (catalog) => getHeartbeatTimeoutMs(catalog),
    getHeartbeatTimeoutMs,
    isHeartbeatEntryAlive,
    lav60Debug,
    fetchHeartbeatsSnapshot,
    watchStoreHeartbeat,
    fetchStoreStatusFromHeartbeat,
    startHeartbeatMonitor,
    stopHeartbeatMonitor,
    isStoreAliveInHeartbeats,
    ingestHeartbeatSnapshot,
    statusFromHeartbeatPayload,
    loadCatalog,
    loadAllStores,
    loadStoreCached,
    getCachedStoreEntry,
    statusFromCard,
    configFromStatus,
    fetchStoreStatus,
    findMachineMeta,
    normalizeMachineStatus,
    machineStatusPillClass,
    canOperateMachineStatus,
    machineMetaRows,
    machineMetaFacts,
    machineMetaTitle,
    deviceUnifiedStatus,
    devicesFromMachines,
    syncConfigDevices,
    isDeviceVisibleInFrontend,
    applyFrontendDeviceVisibility,
    buildStoreCard,
    findStoreInCatalog,
    storeMetaFromId,
    rebuildCatalogStores,
    fetchAgentConfig,
    agentRequest,
    attachSummary,
    formatOfflineDuration,
  };
})();
