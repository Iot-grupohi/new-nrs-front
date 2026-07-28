(() => {
  'use strict';

  const OFFLINE_SINCE_KEY = 'lav60_offline_since';
  const ONLINE_SINCE_KEY = 'lav60_online_since';
  const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;

  let cachedAgentToken = null;
  let cachedAgentTokenConfigured = false;
  let panelBootstrapCache = null;
  let storesLoadGeneration = 0;

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

  /** Token do agente a partir do .env do servidor (CLOUDFLARE_API_TOKEN). */
  async function ensureDefaultAgentToken() {
    if (cachedAgentToken !== null) return cachedAgentToken;
    const boot = await fetchPanelBootstrap();
    cachedAgentToken = String(boot?.default_agent_token || '').trim();
    cachedAgentTokenConfigured = Boolean(boot?.agent_token_configured);
    return cachedAgentToken;
  }

  function isAgentTokenConfiguredOnServer() {
    return cachedAgentTokenConfigured;
  }

  function isAgentTokenMissingError(message) {
    const m = String(message || '').toLowerCase();
    return (
      m.includes('invalid or missing x-token') ||
      m.includes('x-token inválido ou ausente') ||
      m.includes('token do agente não configurado')
    );
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
      m.includes('cloudflare') ||
      m.includes('origin web server') ||
      m.includes('bad gateway') ||
      m.includes('túnel da loja indisponível')
    ) {
      return 'Túnel da loja instável (Cloudflare). Tentando via gateway… Se persistir, aguarde 1 minuto e tente de novo.';
    }

    if (
      m.includes('invalid or missing x-token') ||
      m.includes('x-token inválido ou ausente') ||
      m.includes('token do agente não configurado')
    ) {
      return 'Token do agente ausente ou inválido no servidor. Atualize CLOUDFLARE_API_TOKEN na VPS e faça deploy.';
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

  /** Painel central (VPS) — browser não pode chamar *.powpay.com.br direto (CORS). */
  function isCentralPanelHost() {
    if (typeof window === 'undefined') return false;
    if (isPanelOnLocalMachine()) return false;
    const host = (window.location.hostname || '').toLowerCase();
    return host.includes('lav60.com') || host.endsWith('.lav60.com');
  }

  /** Validação HTTP ao agente Powpay — só no painel central (VPS). Dev local usa heartbeat. */
  function shouldRunLiveAgentProbe() {
    return isCentralPanelHost();
  }

  const MAX_AGENT_PROBES_PER_CYCLE = 12;

  function shouldUsePanelAgentProxy(storeId) {
    if (typeof window === 'undefined') return false;
    const id = normalizeStoreId(storeId);
    const host = (window.location.hostname || '').toLowerCase();
    if (host === `${id}.powpay.com.br`) return false;
    // Painel local ou central: /api/stores/{id}/agent/* faz proxy (evita CORS no Powpay).
    return isCentralPanelHost() || isPanelOnLocalMachine();
  }

  function panelAgentConfigUrl(storeId) {
    return `${window.location.origin}/api/stores/${normalizeStoreId(storeId)}/agent/config`;
  }

  function panelStoreStatusCacheUrl(storeId) {
    return `${window.location.origin}/api/stores/${normalizeStoreId(storeId)}/status-cache`;
  }

  function panelStoresStatusCacheBulkUrl() {
    return `${window.location.origin}/api/stores/status-cache`;
  }

  function panelAgentProbeBatchUrl() {
    return `${window.location.origin}/api/stores/agent-probe-batch`;
  }

  async function fetchAgentProbeBatch(storeIds, token, catalog) {
    const ids = [...new Set(storeIds.map((id) => normalizeStoreId(id)).filter(Boolean))].slice(
      0,
      MAX_AGENT_PROBES_PER_CYCLE
    );
    if (!ids.length) return {};

    try {
      const res = await fetchWithTimeout(
        panelAgentProbeBatchUrl(),
        {
          method: 'POST',
          headers: {
            ...authHeaders(token),
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          credentials: 'same-origin',
          body: JSON.stringify({ stores: ids }),
        },
        Math.min(45000, 8000 + ids.length * 2500)
      );
      if (!res.ok) return {};
      const data = await res.json();
      return data.results && typeof data.results === 'object' ? data.results : {};
    } catch {
      return {};
    }
  }

  function applyAgentProbeBatchResult(card, row, catalog) {
    const meta = catalogStoreMeta(catalog, card.id);
    const hb = heartbeatState.get(normalizeStoreId(card.id));
    const id = normalizeStoreId(card.id);

    if (row?.reachable && row?.config) {
      recordAgentProbe(card.id, { ok: true });
      const status = statusFromAgentConfig(row.config, id);
      if (status?.summary?.total) {
        applyLiveCardSnapshot(card, meta, hb, catalog, status);
      }
      return;
    }

    if (row?.definite_offline) {
      applyAgentProbeFailure(
        card,
        meta,
        hb,
        catalog,
        friendlyUserMessage(`HTTP ${row.status || 404}`)
      );
      return;
    }

    if (row?.transient_error) {
      recordAgentProbe(card.id, {
        ok: null,
        error: friendlyUserMessage(`HTTP ${row.status || 502}`),
        transient: true,
      });
      if (Number(row.status) === 530) {
        applyAgentProbeFailure(
          card,
          meta,
          hb,
          catalog,
          friendlyUserMessage('Túnel Cloudflare indisponível (HTTP 530)')
        );
      }
    }
  }

  async function fetchStoreStatusCache(storeId, catalog) {
    const timeoutMs = Math.min(8000, getHeartbeatTimeoutMs(catalog) || 8000);
    try {
      const res = await fetchWithTimeout(
        panelStoreStatusCacheUrl(storeId),
        { credentials: 'same-origin' },
        timeoutMs
      );
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  async function fetchStoresStatusCacheBulk(catalog) {
    const timeoutMs = Math.min(12000, (getHeartbeatTimeoutMs(catalog) || 8000) + 4000);
    try {
      const res = await fetchWithTimeout(
        panelStoresStatusCacheBulkUrl(),
        { credentials: 'same-origin' },
        timeoutMs
      );
      if (!res.ok) return null;
      return res.json();
    } catch {
      return null;
    }
  }

  function statusFromStatusCacheDoc(meta, doc, catalogId) {
    if (!doc || doc.available === false) return null;
    const id = normalizeStoreId(catalogId || doc.store || meta?.id);
    const network = doc.network;
    const hasNetwork = networkPayloadHasDevices(network);
    const machines = mergeMachinesCatalog(doc.machines);
    if (!hasNetwork && !machines.length) return null;

    const status = {
      store: id,
      washers: network?.washers || {},
      dryers: network?.dryers || {},
      dosers: network?.dosers || {},
      ac: Boolean(network?.ac),
      timestamp:
        network?.timestamp || doc.received_at_iso || new Date(doc.received_at * 1000).toISOString(),
      summary: network?.summary || null,
      machines,
    };
    if (!status.summary?.total) attachSummary(status);
    return applyFrontendDeviceVisibility(status);
  }

  function configFromStatusCacheDoc(snap) {
    if (!snap || typeof snap !== 'object') return null;
    const machines = mergeMachinesCatalog(snap.machines);
    return {
      store: normalizeStoreId(snap.store),
      token_required: Boolean(snap.token_required),
      devices: snap.devices?.washers
        ? snap.devices
        : devicesFromMachines(machines, snap),
      machines,
      washer_dosage_options: snap.washer_dosage_options?.length
        ? snap.washer_dosage_options
        : WASHER_DOSAGE_OPTIONS,
      washer_am_options:
        snap.washer_am_options ||
        WASHER_DOSAGE_OPTIONS.filter((o) => o.value).map((o) => o.value),
      dryer_minutes: snap.dryer_minutes?.length ? snap.dryer_minutes : [15, 30, 45],
      ac_temperatures: snap.ac_temperatures?.length ? snap.ac_temperatures : ['18', '22', 'off'],
      agent_url: snap.agent_url,
      network_check_interval: snap.network_check_interval,
    };
  }

  function resolveAgentEndpointFromStatusCache(doc, meta, catalog, agentConfig = null) {
    if (!doc || doc.available === false) {
      return resolveAgentEndpoint(meta, catalog, agentConfig);
    }
    const catalogId = normalizeStoreId(meta?.id || doc.store);
    if (shouldUsePanelAgentProxy(catalogId)) {
      return { base: window.location.origin, storeId: catalogId, panelProxy: true };
    }
    const url = doc.agent_url || doc.config_snapshot?.agent_url || agentConfig?.agent_url;
    if (url) {
      const base = normalizeAgentUrl(url);
      if (base) {
        return { base: base.replace(/\/$/, ''), storeId: catalogId };
      }
    }
    return resolveAgentEndpoint(meta, catalog, agentConfig);
  }

  function recordAgentProbe(storeId, result) {
    const id = normalizeStoreId(storeId);
    if (!id) return;
    agentProbeState.set(id, {
      ok: result?.ok === true ? true : result?.ok === false ? false : null,
      error: result?.error || null,
      transient: Boolean(result?.transient),
      at: Date.now(),
    });
  }

  function recentAgentProbeFailure(storeId, maxAgeMs = AGENT_PROBE_FAIL_TTL_MS) {
    const row = agentProbeState.get(normalizeStoreId(storeId));
    if (!row || row.ok !== false || row.transient) return null;
    if (Date.now() - row.at > maxAgeMs) return null;
    return row;
  }

  function isAgentDefiniteOfflineError(error) {
    if (!error) return false;
    if (isAgentUnavailableError(error)) return true;
    const message = String(error).toLowerCase();
    return /http\s+(404|401|403)\b/.test(message);
  }

  function isAgentTransientProbeError(error) {
    if (!error) return false;
    const message = String(error).toLowerCase();
    if (/http\s+(502|503|504|530)\b/.test(message)) return true;
    if (/agente indisponível|falha de rede|network|timeout|aborted|fetch/.test(message)) {
      return true;
    }
    return false;
  }

  function agentProbePriority(card) {
    let score = 0;
    if (card.agentPulseStale) score += 4;
    if (card.staleSnapshot) score += 3;
    if (card.accessible) score += 2;
    if ((card.summary?.online ?? 0) > 0) score += 1;
    return score;
  }

  function selectAgentProbeTargets(cards, catalog) {
    return cards
      .filter((card) => cardNeedsAgentValidation(card, catalog))
      .sort((a, b) => agentProbePriority(b) - agentProbePriority(a))
      .slice(0, MAX_AGENT_PROBES_PER_CYCLE);
  }

  function reapplyAllStoreCardPolicies(cards, catalog) {
    return (cards || []).map((card) => reapplyStoreCardPolicy(card, catalog));
  }

  function cardNeedsAgentValidation(card, catalog) {
    if (!card || card.loading || isStoreCardSuspended(card, catalog)) return false;
    if (card.fromLiveProbe && !card.agentPulseStale && !card.staleSnapshot) return false;

    const id = normalizeStoreId(card.id);
    const hb = heartbeatState.get(id);
    const hbAlive = Boolean(hb && isStoreHeartbeatAlive(hb, catalog));

    if (card.accessible || card.agentPulseStale || card.staleSnapshot) return true;
    if (hbAlive && ((card.summary?.total ?? 0) > 0 || heartbeatHasAgentPayload(hb))) return true;
    return false;
  }

  function agentProbeConcurrency(catalog) {
    return Math.min(getConcurrency(catalog), 3);
  }

  function applyAgentProbeFailure(card, meta, hb, catalog, error) {
    recordAgentProbe(card.id, { ok: false, error });
    const fresh = withStoreCardPolicy(
      buildStoreCard(meta, null, error, catalog, {
        accessible: false,
        agentUnavailable: isAgentUnavailableError(error),
        fromLiveProbe: true,
        staleSnapshot: false,
        agentPulseStale: false,
        agentProbeFailed: true,
      }),
      meta,
      hb,
      catalog
    );
    Object.keys(fresh).forEach((key) => {
      card[key] = fresh[key];
    });
  }

  function applyStatusCacheAvailabilityMeta(card, doc) {
    if (!card || !doc || typeof doc !== 'object') return card;
    if (doc.agent_online_since_ms != null) {
      card.agent_online_since_ms = doc.agent_online_since_ms;
    }
    if (doc.agent_offline_since_ms != null) {
      card.agent_offline_since_ms = doc.agent_offline_since_ms;
    }
    return card;
  }

  function enrichCardsFromStatusCache(cards, catalog, bulk) {
    const storesMap = bulk?.stores;
    if (!bulk?.available || !storesMap || typeof storesMap !== 'object') return;

    for (const card of cards) {
      if (card.accessible && !card.agentPulseStale && card.fromLiveProbe) continue;
      const doc = storesMap[normalizeStoreId(card.id)];
      if (!doc) continue;
      applyStatusCacheAvailabilityMeta(card, doc);
      const meta = catalogStoreMeta(catalog, card.id);
      const status = statusFromStatusCacheDoc(meta, doc, card.id);
      if (!status?.summary?.total) continue;
      const hb = heartbeatState.get(normalizeStoreId(card.id));
      const pulseStale = !isHeartbeatEntryAlive(hb, catalog);
      applyLiveCardSnapshot(card, meta, hb, catalog, status, {
        agentPulseStale: pulseStale,
        staleSnapshot: pulseStale || !doc.alive,
        fromHeartbeat: false,
        accessible: pulseStale ? false : undefined,
      });
      applyStatusCacheAvailabilityMeta(card, doc);
    }
  }

  function panelAgentGatewayUrl(storeId, path) {
    const sub = String(path || '').replace(/^\//, '');
    return `${window.location.origin}/api/stores/${normalizeStoreId(storeId)}/gateway/${sub}`;
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

  async function probeAgentBase(base, token, timeoutMs = 5000, storeId = null) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const useProxy = Boolean(storeId && shouldUsePanelAgentProxy(storeId));
    try {
      const url = useProxy
          ? panelAgentConfigUrl(storeId)
          : `${String(base).replace(/\/$/, '')}/api/agent/config`;
      const res = await fetch(url, {
        headers: useProxy ? { Accept: 'application/json' } : authHeaders(token),
        signal: ctrl.signal,
        credentials: useProxy ? 'same-origin' : 'omit',
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
      if (shouldUsePanelAgentProxy(catalogId)) {
        const ep = {
          base: window.location.origin,
          storeId: catalogId,
          panelProxy: true,
        };
        endpointDiscoveryCache.set(catalogId, ep);
        lav60Debug('agent', 'resolved via panel proxy', ep);
        return ep;
      }
      lav60Debug('agent', 'heartbeat alive', { store: catalogId, urls: agentUrlCandidatesFromHeartbeat(entry) });
      for (const base of agentUrlCandidatesFromHeartbeat(entry)) {
        const data = await probeAgentBase(base, token, 8000, catalogId);
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
      const data = await probeAgentBase(base, token, 5000, catalogId);
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

  const MACHINE_CAPACITY_LABELS = {
    normal_capacity: 'giant',
    large_capacity: 'titan',
    'normal-capacity': 'giant',
    'large-capacity': 'titan',
    giant: 'giant',
    titan: 'titan',
  };

  function normalizeMachineCapacity(raw) {
    const key = String(raw || '').trim().toLowerCase();
    if (!key || key === '—' || key === '-') return '';
    return MACHINE_CAPACITY_LABELS[key] || key;
  }

  function machineCapacityRaw(record) {
    if (!record) return '';
    const candidates = [
      record.capacity_raw,
      record['machine-capacity'],
      record.machine_capacity,
      record.model_label,
      record.capacity,
    ];
    for (const raw of candidates) {
      const key = String(raw || '').trim().toLowerCase();
      if (!key || key === '—' || key === '-') continue;
      return key;
    }
    return '';
  }

  /** Modelo comercial lavadora/secadora: giant ou titan. */
  function machineModelLabel(meta) {
    if (!meta) return '';
    const dtype = machineRecordType(meta);
    if (dtype === 'doser') {
      const model = meta.paired_washer_model || '';
      return model === 'giant' || model === 'titan' ? model : '';
    }
    if (dtype !== 'washer' && dtype !== 'dryer') return '';
    const model = normalizeMachineCapacity(machineCapacityRaw(meta));
    return model === 'giant' || model === 'titan' ? model : '';
  }

  /** Dosadora espelha a lavadora com o mesmo ID (ex.: dos 432 → lav 432). */
  function doserWasherLink(doserId, machines) {
    const did = normalizeStoreId(doserId);
    if (!did) return null;

    let washerId = did;
    let washerMeta = findMachineMeta(machines, washerId, 'washer');
    if (!washerMeta) {
      washerId = pairedWasherForDoser(did);
      if (!washerId) return null;
      washerMeta = findMachineMeta(machines, washerId, 'washer');
    }
    if (!washerMeta) return null;

    const model = machineModelLabel(washerMeta);
    return { washerId, model };
  }

  function enrichDoserMeta(meta, doserId, machines) {
    const base = meta || { id: String(doserId || '').trim(), type: 'doser' };
    if (machineRecordType(base) !== 'doser') return base;
    const link = doserWasherLink(doserId, machines);
    if (!link) return base;
    return {
      ...base,
      paired_washer_id: link.washerId,
      paired_washer_model: link.model,
    };
  }

  function machineRecordType(record) {
    const raw = record?.type || record?.machine_type || record?.['machine-type'] || '';
    const value = String(raw).trim().toLowerCase().replace(/_/g, '-');
    const aliases = {
      washer: 'washer',
      lavadora: 'washer',
      washers: 'washer',
      dryer: 'dryer',
      secadora: 'dryer',
      dryers: 'dryer',
      doser: 'doser',
      dosadora: 'doser',
      dosadoras: 'doser',
    };
    return aliases[value] || value;
  }

  function normalizeMachineRecord(record) {
    if (!record?.id) return null;
    const dtype = machineRecordType(record);
    const capacityRaw = machineCapacityRaw(record);
    const capacity = normalizeMachineCapacity(capacityRaw);
    const model_label =
      dtype === 'washer' || dtype === 'dryer'
        ? capacity === 'giant' || capacity === 'titan'
          ? capacity
          : ''
        : '';
    const statusRaw = record.status_raw || record.status || '';
    const status = normalizeMachineStatus(statusRaw);
    const liter =
      record.liter_capacity ?? record['liter-capacity'] ?? record.literCapacity ?? null;
    const waiting =
      record.waiting_minutes ?? record['waiting-minutes'] ?? record.waitingMinutes ?? null;
    return {
      ...record,
      id: String(record.id).trim(),
      type: dtype,
      address: record.address || record.ip || '',
      status,
      status_raw: String(statusRaw || '').trim().toLowerCase(),
      status_label:
        record.status_label ||
        (status === 'available'
          ? 'Disponível'
          : status === 'occupied'
            ? 'Ocupada'
            : status === 'suspended'
              ? 'Suspensa'
              : ''),
      capacity: model_label || capacity,
      capacity_raw: String(capacityRaw || ''),
      model_label,
      liter_capacity: liter,
      waiting_minutes: waiting,
      time_dosage: record.time_dosage ?? record['time-dosage'] ?? null,
      port: record.port ?? null,
      store_code: record.store_code || record.storeCode || '',
    };
  }

  function normalizeMachinesList(machines) {
    return (machines || []).map(normalizeMachineRecord).filter(Boolean);
  }

  function mergeMachinesCatalog(...sources) {
    const merged = new Map();
    sources.forEach((list) => {
      normalizeMachinesList(list).forEach((record) => {
        const key = `${record.type}:${normalizeStoreId(record.id)}`;
        const prev = merged.get(key);
        if (!prev) {
          merged.set(key, record);
          return;
        }
        const next = { ...prev, ...record };
        const model = machineModelLabel(next) || machineModelLabel(prev);
        if (model) {
          next.model_label = model;
          next.capacity = model;
        } else if (machineModelLabel(prev)) {
          next.model_label = prev.model_label;
          next.capacity = prev.capacity;
          if (!next.capacity_raw || next.capacity_raw === '—') {
            next.capacity_raw = prev.capacity_raw;
          }
        }
        merged.set(key, next);
      });
    });
    return [...merged.values()].sort(
      (a, b) =>
        String(a.type).localeCompare(String(b.type)) ||
        normalizeStoreId(a.id).localeCompare(normalizeStoreId(b.id))
    );
  }

  function findMachineMeta(machines, id, type) {
    const norm = normalizeStoreId(id);
    const dtype = String(type || '').toLowerCase();
    const found = (machines || []).find(
      (m) => normalizeStoreId(m.id) === norm && machineRecordType(m) === dtype
    );
    return found ? normalizeMachineRecord(found) : null;
  }

  function normalizeMachineStatus(status) {
    const s = String(status || '').trim().toLowerCase();
    if (s === 'busy') return 'occupied';
    if (
      s === 'running' ||
      s === 'active' ||
      s === 'in_use' ||
      s === 'in-cycle' ||
      s === 'in_cycle' ||
      s === 'working' ||
      s === 'ocupada' ||
      s === 'ocupado'
    ) {
      return 'occupied';
    }
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

  function isNetworkMapOnline(value) {
    if (value === true || value === 1) return true;
    if (typeof value === 'string') {
      const s = value.trim().toLowerCase();
      return s === 'true' || s === '1' || s === 'online' || s === 'on';
    }
    return false;
  }

  /** Agente obteve status operacional — equipamento respondeu na rede local. */
  function machineStatusImpliesReachable(meta) {
    const s = normalizeMachineStatus(meta?.status);
    return s === 'available' || s === 'occupied' || s === 'suspended';
  }

  function normalizeNetworkMapKeys(map) {
    const out = {};
    Object.entries(map || {}).forEach(([id, value]) => {
      out[normalizeStoreId(id)] = value;
    });
    return out;
  }

  function resolveDeviceOnline(networkMap, id, meta) {
    const mid = normalizeStoreId(id);
    const map = networkMap || {};
    if (Object.prototype.hasOwnProperty.call(map, mid)) {
      return isNetworkMapOnline(map[mid]);
    }
    return machineStatusImpliesReachable(meta);
  }

  function reconcileNetworkFromMachines(status) {
    if (!status) return status;
    const next = {
      ...status,
      washers: normalizeNetworkMapKeys(status.washers),
      dryers: normalizeNetworkMapKeys(status.dryers),
      dosers: normalizeNetworkMapKeys(status.dosers),
    };
    const machines = normalizeMachinesList(next.machines);
    if (!machines.length) return next;

    ['washers', 'dryers', 'dosers'].forEach((key) => {
      const mtype = DEVICE_GROUP_TYPE[key];
      const block = { ...(next[key] || {}) };
      machines.forEach((meta) => {
        if (machineRecordType(meta) !== mtype) return;
        const id = normalizeStoreId(meta.id);
        if (Object.prototype.hasOwnProperty.call(block, id) && !isNetworkMapOnline(block[id])) {
          return;
        }
        if (resolveDeviceOnline(block, id, meta)) {
          block[id] = true;
        }
      });
      next[key] = block;
    });
    return next;
  }

  function displayMachineValue(value) {
    if (value === null || value === undefined || value === '') return null;
    return String(value);
  }

  function machineMetaFacts(meta) {
    if (!meta) return [];
    const facts = [];
    if (machineRecordType(meta) === 'doser' && meta.paired_washer_id) {
      facts.push(`Lavadora ${meta.paired_washer_id}`);
    }
    if (meta.liter_capacity != null && meta.liter_capacity !== '') {
      facts.push(`${meta.liter_capacity} L`);
    }
    if (meta.waiting_minutes != null && meta.waiting_minutes !== '') {
      facts.push(`${meta.waiting_minutes} min`);
    }
    if (displayMachineValue(meta.time_dosage)) {
      facts.push(displayMachineValue(meta.time_dosage));
    }
    return facts;
  }

  function deviceUnifiedStatus(online, meta) {
    if (online === false) {
      return {
        label: 'Sem rede',
        tone: 'offline',
        pillClass: 'pill--off',
      };
    }

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
    const effectivelyOnline = online === true || machineStatusImpliesReachable(meta);
    if (!effectivelyOnline) {
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
    const model = machineModelLabel(meta);
    const dtype = machineRecordType(meta);
    return [
      ['Tipo', meta.machine_type_label || meta.machine_type],
      dtype === 'doser' && meta.paired_washer_id
        ? ['Lavadora', meta.paired_washer_id]
        : null,
      ['Modelo', model ? model.toUpperCase() : null],
      ['Status', meta.status_label],
      ['Litros', meta.liter_capacity != null && meta.liter_capacity !== '' ? `${meta.liter_capacity} L` : null],
      ['Espera', meta.waiting_minutes != null && meta.waiting_minutes !== '' ? `${meta.waiting_minutes} min` : null],
      ['Dosagem', displayMachineValue(meta.time_dosage)],
      ['Loja', meta.store_code],
    ].filter((row) => row && row[1]);
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

  /** Dosadora espelha a lavadora com o mesmo ID (ex.: lav 432 → dos 432). */
  const WASHER_DOSER_PAIRS = [{ washer: '321', doser: '321' }];

  function washerIdsInCatalog(machines) {
    const ids = new Set();
    (machines || []).forEach((m) => {
      if (machineRecordType(m) === 'washer') {
        ids.add(normalizeStoreId(m.id));
      }
    });
    return ids;
  }

  /** Dosadora só existe se houver lavadora cadastrada com o mesmo ID. */
  function isDoserMirroredToWasher(doserId, machines, washerIds = null) {
    const mid = normalizeStoreId(doserId);
    const washers = washerIds || washerIdsInCatalog(machines);
    return washers.has(mid);
  }

  function isPairedDoserId(doserId) {
    const id = normalizeStoreId(doserId);
    return WASHER_DOSER_PAIRS.some((pair) => normalizeStoreId(pair.doser) === id);
  }

  function pairedWasherForDoser(doserId) {
    const id = normalizeStoreId(doserId);
    const pair = WASHER_DOSER_PAIRS.find((row) => normalizeStoreId(row.doser) === id);
    return pair ? normalizeStoreId(pair.washer) : null;
  }

  function applyWasherDoserPairs(ids, machines) {
    WASHER_DOSER_PAIRS.forEach(({ washer, doser }) => {
      const washerId = normalizeStoreId(washer);
      const doserId = normalizeStoreId(doser);
      if (!ids.washers.has(washerId)) return;
      if (!isDeviceRegisteredInCatalog(machines, 'doser', doserId)) return;
      ids.dosers.add(doserId);
    });
  }

  function isFixedMapExtra(deviceType, machineId) {
    const mid = normalizeStoreId(machineId);
    const dtype = String(deviceType || '').toLowerCase();
    return HIDE_WHEN_OFFLINE.some(
      (rule) => rule.type === dtype && normalizeStoreId(rule.id) === mid
    );
  }

  /** Lav/sec exigem API Lav60; dosadoras usam rede; extras 321/210/321 só se cadastrados na API. */
  function isDeviceRegisteredInCatalog(machines, deviceType, machineId) {
    const mid = normalizeStoreId(machineId);
    const dtype = String(deviceType || '').toLowerCase();

    if (dtype === 'doser') {
      if (isPairedDoserId(mid)) {
        const washerId = pairedWasherForDoser(mid);
        return washerId ? isDeviceRegisteredInCatalog(machines, 'washer', washerId) : false;
      }
      if (!Array.isArray(machines) || !machines.length) {
        return false;
      }
      return isDoserMirroredToWasher(mid, machines);
    }

    if (isFixedMapExtra(deviceType, machineId)) {
      if (!Array.isArray(machines) || !machines.length) {
        return false;
      }
      return machines.some(
        (m) => machineRecordType(m) === dtype && normalizeStoreId(m.id) === mid
      );
    }

    if (!Array.isArray(machines)) {
      return !isFixedMapExtra(deviceType, machineId);
    }
    if (!machines.length) {
      return !isFixedMapExtra(deviceType, machineId);
    }
    return machines.some(
      (m) => machineRecordType(m) === dtype && normalizeStoreId(m.id) === mid
    );
  }

  /** Lav/sec exigem API; dosadoras só ping; lavadora 321, secadora 210 e dosadora 321 exigem online. */
  function isDeviceVisibleInFrontend(deviceType, machineId, network) {
    const machines = network?.machines;
    if (!isDeviceRegisteredInCatalog(machines, deviceType, machineId)) return false;
    const mid = normalizeStoreId(machineId);
    const dtype = String(deviceType || '').toLowerCase();

    if (dtype === 'doser' && isPairedDoserId(mid)) {
      const washerId = pairedWasherForDoser(mid);
      const washerOnline = washerId ? (network?.washers || {})[washerId] === true : false;
      const doserOnline = (network?.dosers || {})[mid] === true;
      return washerOnline || doserOnline;
    }

    const mustBeOnline = isFixedMapExtra(dtype, mid);
    if (!mustBeOnline) return true;
    const key =
      dtype === 'washer' ? 'washers' : dtype === 'dryer' ? 'dryers' : dtype === 'doser' ? 'dosers' : null;
    if (!key || !network) return false;
    return isNetworkMapOnline((network[key] || {})[mid]);
  }

  function applyFrontendDeviceVisibility(status, acId = '110') {
    if (!status) return status;
    const next = reconcileNetworkFromMachines({ ...status });
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
        isDeviceVisibleInFrontend(machineRecordType(m), m.id, next)
      );
    }
    return reconcileStatusSummary(next, acId);
  }

  function devicesFromMachines(machines, network = {}) {
    const ids = { washers: new Set(), dryers: new Set(), dosers: new Set() };
    const catalog = machines || [];
    const source = network && typeof network === 'object' ? network : {};
    const net = { ...source, machines: source.machines ?? catalog };
    catalog.forEach((m) => {
      const t = machineRecordType(m);
      if (t === 'doser') return;
      if (!isDeviceRegisteredInCatalog(catalog, t, m.id)) return;
      const key = t === 'washer' ? 'washers' : t === 'dryer' ? 'dryers' : null;
      if (key) ids[key].add(normalizeStoreId(m.id));
    });
    applyWasherDoserPairs(ids, catalog);
    ids.washers.forEach((washerId) => {
      if (isDeviceRegisteredInCatalog(catalog, 'doser', washerId)) {
        ids.dosers.add(normalizeStoreId(washerId));
      }
    });
    const networkKeys = catalog.length ? ['dosers'] : ['washers', 'dryers', 'dosers'];
    networkKeys.forEach((key) => {
      const dtype = { washers: 'washer', dryers: 'dryer', dosers: 'doser' }[key];
      Object.keys(net[key] || {}).forEach((id) => {
        const norm = normalizeStoreId(id);
        if (dtype === 'doser' && !ids.washers.has(norm)) return;
        if (isDeviceVisibleInFrontend(dtype, id, net)) {
          ids[key].add(norm);
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
      config.devices = devicesFromMachines(machines, net || {});
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

      if (key === 'dosers' || !machines.length) {
        list = Object.keys(items)
          .filter((id) => isDeviceVisibleInFrontend(mtype, id, status))
          .map((id) => {
            const meta = findMachineMeta(machines, id, mtype);
            return {
              ...(meta || {}),
              id,
              online: resolveDeviceOnline(items, id, meta),
            };
          });
      } else {
        list = machines
          .filter(
            (m) =>
              machineRecordType(m) === mtype && isDeviceVisibleInFrontend(mtype, m.id, status)
          )
          .map((meta) => {
            const normalized = normalizeMachineRecord(meta) || meta;
            const id = normalizeStoreId(normalized.id);
            return {
              ...normalized,
              id: normalized.id,
              online: resolveDeviceOnline(items, id, normalized),
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
    const online = dev?.online || machineStatusImpliesReachable(dev);
    if (!online) return false;
    return normalizeMachineStatus(dev.status) !== 'suspended';
  }

  function isDeviceSuspended(dev) {
    return normalizeMachineStatus(dev?.status) === 'suspended';
  }

  function isDeviceOccupied(dev) {
    return normalizeMachineStatus(dev?.status) === 'occupied';
  }

  function isDeviceAvailable(dev) {
    const online = dev?.online || machineStatusImpliesReachable(dev);
    if (!online) return false;
    return normalizeMachineStatus(dev?.status) === 'available';
  }

  function countDeviceStates(devices) {
    let suspended = 0;
    let offlineNetwork = 0;
    let occupied = 0;
    let available = 0;
    ['washers', 'dryers', 'dosers', 'ac'].forEach((key) => {
      (devices?.[key] || []).forEach((dev) => {
        if (isDeviceSuspended(dev)) suspended += 1;
        else if (isDeviceOccupied(dev)) occupied += 1;
        else if (isDeviceAvailable(dev)) available += 1;
        else if (!dev.online) offlineNetwork += 1;
      });
    });
    return { suspended, offlineNetwork, occupied, available };
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

  const STORE_SUSPENDED_NOTICE =
    'Loja suspensa no sistema Lav60 — operação local permitida';

  function heartbeatPayload(hb) {
    if (!hb) return {};
    if (hb.payload && typeof hb.payload === 'object') return hb.payload;
    if (hb.lav60_status || hb.network || hb.store) return hb;
    return {};
  }

  function lav60StatusFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return null;
    if (payload.lav60_status === 'suspended' || payload.store_suspended === true) {
      return 'suspended';
    }
    const raw = typeof payload.lav60_status === 'string' ? payload.lav60_status.trim().toLowerCase() : '';
    if (raw === 'suspended') return 'suspended';
    if (raw === 'ok') return 'ok';
    if (raw && raw !== 'unknown') return raw;
    return null;
  }

  function catalogSuspendedIdSet(catalog) {
    const cat = catalog || heartbeatCatalog;
    if (!cat && panelCatalogSuspendedIds.size) return panelCatalogSuspendedIds;
    if (!cat) return new Set();
    if (cat._suspendedIdSet instanceof Set) return cat._suspendedIdSet;
    const set = new Set(panelCatalogSuspendedIds);
    (cat.suspended_store_ids || []).forEach((id) => {
      const sid = normalizeStoreId(id);
      if (sid) set.add(sid);
    });
    (cat.stores || []).forEach((store) => {
      if (String(store?.lav60_status || '').toLowerCase() === 'suspended') {
        const sid = normalizeStoreId(store.id);
        if (sid) set.add(sid);
      }
    });
    cat._suspendedIdSet = set;
    return set;
  }

  function isStoreCardSuspended(card, catalog) {
    if (!card || card.loading) return false;
    if (
      card.storeSuspended ||
      card.lav60Status === 'suspended' ||
      card.lav60_status === 'suspended' ||
      card.state === 'suspended'
    ) {
      return true;
    }
    const sid = normalizeStoreId(card.id);
    return Boolean(sid && catalogSuspendedIdSet(catalog).has(sid));
  }

  function resolveStoreLav60Status(meta, hb, catalog) {
    const payload = heartbeatPayload(hb);
    const fromAgent = lav60StatusFromPayload(payload);
    const metaStatus =
      typeof meta?.lav60_status === 'string' ? meta.lav60_status.trim().toLowerCase() : '';
    const sid = normalizeStoreId(meta?.id);
    if (sid && catalogSuspendedIdSet(catalog).has(sid)) return 'suspended';

    if (fromAgent === 'suspended' || metaStatus === 'suspended') return 'suspended';
    if (fromAgent === 'ok') return 'ok';
    if (metaStatus === 'ok') return 'ok';
    if (fromAgent) return fromAgent;
    if (metaStatus && metaStatus !== 'unknown') return metaStatus;
    return 'ok';
  }

  function isStoreLav60Suspended(meta, hb, catalog) {
    return resolveStoreLav60Status(meta, hb, catalog) === 'suspended';
  }

  function finalizeStoreCard(card, meta, hb, catalog) {
    if (!card || card.loading) return card;
    if (!isStoreLav60Suspended(meta, hb, catalog)) return card;

    const hbAlive = hb && isStoreHeartbeatAlive(hb, catalog);
    const base = {
      ...card,
      lav60Status: 'suspended',
      storeSuspended: true,
    };

    if (!hbAlive) {
      return {
        ...base,
        state: 'suspended',
        accessible: false,
        storeNotice: STORE_SUSPENDED_NOTICE,
      };
    }

    return {
      ...base,
      state: 'suspended',
      accessible: true,
      agentUnavailable: false,
      loading: false,
      error: null,
      storeNotice: STORE_SUSPENDED_NOTICE,
    };
  }

  function withStoreCardPolicy(card, meta, hb, catalog) {
    return finalizeStoreCard(card, meta, hb, catalog);
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
      agent_offline_since_ms: meta.agent_offline_since_ms ?? null,
      gateway_online: meta.gateway_online ?? null,
      gateway_error: meta.gateway_error ?? null,
      gateway_offline_since_ms: meta.gateway_offline_since_ms ?? null,
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

  /** Card mínimo do catálogo — sem spinner (lista grande de lojas). */
  function buildCatalogPlaceholderCard(meta, catalog) {
    return buildStoreCard(meta, null, null, catalog, {
      accessible: false,
      state: 'unreachable',
      loading: false,
      error: null,
      staleSnapshot: true,
    });
  }

  function buildCardsFromStatusCacheBulk(catalog, bulk) {
    const storesMap = bulk?.stores;
    if (!bulk?.available || !storesMap || typeof storesMap !== 'object') {
      return (catalog.stores || []).map((meta) =>
        withStoreCardPolicy(buildCatalogPlaceholderCard(meta, catalog), meta, null, catalog)
      );
    }

    return (catalog.stores || []).map((meta) => {
      const id = normalizeStoreId(meta.id);
      const doc = storesMap[id];
      const hb = heartbeatState.get(id);
      if (!doc) {
        return withStoreCardPolicy(buildCatalogPlaceholderCard(meta, catalog), meta, hb, catalog);
      }
      const card = cardFromStatusCacheEntry(meta, doc, catalog);
      if (!card) {
        return withStoreCardPolicy(buildCatalogPlaceholderCard(meta, catalog), meta, hb, catalog);
      }
      return withStoreCardPolicy(card, meta, hb, catalog);
    });
  }

  function isStoreCardHeartbeatAlive(card, catalog) {
    if (!card || card.loading) return false;
    const hb = heartbeatState.get(normalizeStoreId(card.id));
    return isStoreHeartbeatAlive(hb, catalog || heartbeatCatalog);
  }

  function enrichCardHeartbeatAlive(card, catalog) {
    if (!card || typeof card !== 'object') return card;
    return {
      ...card,
      heartbeatAlive: isStoreCardHeartbeatAlive(card, catalog),
    };
  }

  function isCardAgentReachable(card) {
    if (!card || card.loading || isStoreCardSuspended(card, heartbeatCatalog)) return false;
    if (card.agentProbeFailed || card.agentUnavailable) return false;
    if (card.accessible === false) return false;
    return card.heartbeatAlive === true;
  }

  function buildDashboard(cards) {
    const ready = cards.filter((c) => !c.loading);
    const connected = ready.filter((c) => c.accessible);
    const storesSuspendedCards = ready.filter((c) => isStoreCardSuspended(c, heartbeatCatalog));
    const heartbeatOnlineStores = ready.filter(
      (c) => !isStoreCardSuspended(c, heartbeatCatalog) && isCardAgentReachable(c)
    );
    const heartbeatOfflineStores = ready.filter(
      (c) => !isStoreCardSuspended(c, heartbeatCatalog) && !isCardAgentReachable(c)
    );
    const unreachable = ready.filter(
      (c) => !isStoreCardSuspended(c, heartbeatCatalog) && !c.accessible
    );
    const allDevicesOffline = connected.filter(
      (c) => !isStoreCardSuspended(c, heartbeatCatalog) && (c.summary?.online ?? 0) <= 0
    );
    const partialCount = connected.filter((c) => {
      if (isStoreCardSuspended(c, heartbeatCatalog) || !isCardAgentReachable(c)) return false;
      const on = c.summary?.online ?? 0;
      const tot = c.summary?.total ?? 0;
      return on > 0 && on < tot;
    }).length;
    let devicesOnline = 0;
    let devicesTotal = 0;
    let devicesSuspended = 0;
    let devicesOfflineNetwork = 0;
    let devicesOccupied = 0;
    let devicesAvailable = 0;
    const devicesSuspendedEvents = [];
    const devicesOfflineNetworkEvents = [];
    const devicesOccupiedEvents = [];
    const devicesAvailableEvents = [];
    const storesOnlineEvents = [];
    const storesOfflineEvents = [];
    const storesPartialEvents = [];
    const storesSuspendedEvents = [];
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
      if (isStoreCardSuspended(card, heartbeatCatalog)) {
        storesSuspendedEvents.push({
          ...storeEntry,
          reason: card.storeNotice || STORE_SUSPENDED_NOTICE,
          agent_online: card.heartbeatAlive,
        });
      } else if (isCardAgentReachable(card)) {
        const healthPct = card.summary?.total
          ? Math.round(((card.summary?.online ?? 0) / card.summary.total) * 100)
          : 0;
        storesOnlineEvents.push({
          ...storeEntry,
          health_pct: healthPct,
        });
        const on = card.summary?.online ?? 0;
        const tot = card.summary?.total ?? 0;
        if (on > 0 && tot > 0 && on < tot) {
          storesPartialEvents.push({
            ...storeEntry,
            health_pct: healthPct,
          });
        }
      } else {
        storesOfflineEvents.push({
          ...storeEntry,
          kind: card.heartbeatAlive ? 'agent_unreachable' : 'heartbeat_offline',
          reason: card.agentProbeFailed
            ? card.error || 'Agente não respondeu'
            : card.heartbeatAlive
              ? card.error || 'Agente sem resposta HTTP'
              : 'Sem pulso do agente',
          offline_since: card.offlineSince || null,
        });
      }
      if (
        isCardAgentReachable(card) &&
        (card.summary?.online ?? 0) <= 0 &&
        (card.summary?.total ?? 0) > 0
      ) {
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
      devicesOccupied += stateCounts.occupied;
      devicesAvailable += stateCounts.available;
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
          } else if (isDeviceOccupied(dev)) {
            devicesOccupiedEvents.push({
              store: card.id,
              store_name: card.name || card.id.toUpperCase(),
              type_label: label,
              id: dev.id,
              status_label: dev.status_label || 'Ocupada',
            });
          } else if (isDeviceAvailable(dev)) {
            devicesAvailableEvents.push({
              store: card.id,
              store_name: card.name || card.id.toUpperCase(),
              type_label: label,
              id: dev.id,
              status_label: dev.status_label || 'Disponível',
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
        online: heartbeatOnlineStores.length,
        connected: connected.length,
        offline: heartbeatOfflineStores.length,
        partial: partialCount,
        suspended: storesSuspendedCards.length,
        pending: cards.filter((c) => c.loading).length,
        unreachable: unreachable.length,
        devices_all_offline: allDevicesOffline.length,
      },
      devices: {
        online: devicesOnline,
        total: devicesTotal,
        offline: devicesSuspended + devicesOfflineNetwork,
        suspended: devicesSuspended,
        occupied: devicesOccupied,
        available: devicesAvailable,
        offline_network: devicesOfflineNetwork,
        health_pct: devicesTotal ? Math.round((devicesOnline / devicesTotal) * 100) : 0,
      },
      events: {
        stores_online: storesOnlineEvents.sort((a, b) => a.store.localeCompare(b.store)),
        stores_offline: storesOfflineEvents.sort((a, b) => a.store.localeCompare(b.store)),
        stores_partial: storesPartialEvents.sort((a, b) => a.store.localeCompare(b.store)),
        stores_suspended: storesSuspendedEvents.sort((a, b) => a.store.localeCompare(b.store)),
        devices_suspended: devicesSuspendedEvents.sort((a, b) =>
          a.store.localeCompare(b.store) || String(a.id).localeCompare(String(b.id))
        ),
        devices_occupied: devicesOccupiedEvents.sort((a, b) =>
          a.store.localeCompare(b.store) || String(a.id).localeCompare(String(b.id))
        ),
        devices_available: devicesAvailableEvents.sort((a, b) =>
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

  function loadOnlineSinceMap() {
    try {
      return JSON.parse(localStorage.getItem(ONLINE_SINCE_KEY) || '{}');
    } catch {
      return {};
    }
  }

  function saveOnlineSinceMap(map) {
    localStorage.setItem(ONLINE_SINCE_KEY, JSON.stringify(map));
  }

  const GATEWAY_CACHE_KEY = 'lav60:gateway:v1';
  const GATEWAY_CACHE_VERSION = 4;
  const GATEWAY_TTL_MS = 5 * 60 * 1000;

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

  function getStoreGatewayCacheEntry(storeId) {
    const sid = normalizeStoreId(storeId);
    return loadGatewayCacheRoot().stores[sid]?.gateway || null;
  }

  function setStoreGatewayCacheEntry(storeId, entry) {
    const sid = normalizeStoreId(storeId);
    if (!sid) return null;
    const root = loadGatewayCacheRoot();
    if (!root.stores[sid]) root.stores[sid] = {};
    const checkedAt = Date.now();
    root.stores[sid].gateway = {
      online: Boolean(entry.online),
      error: entry.error || null,
      checkedAt,
    };
    saveGatewayCacheRoot(root);
    return root.stores[sid].gateway;
  }

  function isGatewayCacheFresh(checkedAt, ttlMs = GATEWAY_TTL_MS) {
    return Number.isFinite(checkedAt) && Date.now() - checkedAt < ttlMs;
  }

  function formatGatewayCacheAge(checkedAt) {
    if (!Number.isFinite(checkedAt)) return '';
    const sec = Math.floor((Date.now() - checkedAt) / 1000);
    if (sec < 45) return 'agora';
    const min = Math.floor(sec / 60);
    if (min < 60) return min === 1 ? 'há 1 min' : `há ${min} min`;
    const hours = Math.floor(min / 60);
    return hours === 1 ? 'há 1 h' : `há ${hours} h`;
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
    return friendlyUserMessage(msg);
  }

  async function verifyStoreGatewayLed(storeId, fetchFn, { force = false } = {}) {
    const sid = normalizeStoreId(storeId);
    if (!sid) throw new Error('Loja inválida');
    if (typeof fetchFn !== 'function') throw new Error('fetchFn obrigatório');

    const cached = getStoreGatewayCacheEntry(sid);
    if (!force && cached && isGatewayCacheFresh(cached.checkedAt)) {
      return {
        online: Boolean(cached.online),
        error: cached.error || null,
        fromCache: true,
        checkedAt: cached.checkedAt,
      };
    }

    const res = await fetchFn(`/api/gateway/${encodeURIComponent(sid)}/verify`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const detail = data.detail || data.error || data.message || `HTTP ${res.status}`;
      const error = formatStoreGatewayError(sid, detail);
      setStoreGatewayCacheEntry(sid, { online: false, error });
      return { online: false, error, fromCache: false, checkedAt: Date.now() };
    }

    const online = data.gateway_online === true;
    const error = online ? null : formatStoreGatewayError(sid, data.gateway_error);
    const checkedAt = data.gateway_checked_at_ms || Date.now();
    setStoreGatewayCacheEntry(sid, { online, error });
    return { online, error, fromCache: false, checkedAt };
  }

  async function fetchStoreStatuses(fetchFn) {
    if (typeof fetchFn !== 'function') return [];
    const res = await fetchFn('/api/stores/status', {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return [];
    return Array.isArray(data.items) ? data.items : [];
  }

  function applyStoreStatusRows(rows) {
    if (!Array.isArray(rows)) return;
    rows.forEach((row) => {
      const sid = normalizeStoreId(row?.store);
      if (!sid || row.gateway_checked_at_ms == null) return;
      setStoreGatewayCacheEntry(sid, {
        online: row.gateway_online === true,
        error: row.gateway_error || null,
      });
    });
  }

  function syncStoreOfflineSince(cards) {
    const offlineMap = loadOfflineSinceMap();
    const onlineMap = loadOnlineSinceMap();
    const now = Date.now();
    let offlineChanged = false;
    let onlineChanged = false;

    cards.forEach((card) => {
      if (card.loading) return;

      if (!isCardAgentReachable(card)) {
        if (card.agent_offline_since_ms != null) {
          card.offlineSince = card.agent_offline_since_ms;
          if (offlineMap[card.id] !== card.agent_offline_since_ms) {
            offlineMap[card.id] = card.agent_offline_since_ms;
            offlineChanged = true;
          }
        } else if (!offlineMap[card.id]) {
          offlineMap[card.id] = now;
          offlineChanged = true;
          card.offlineSince = offlineMap[card.id];
        } else {
          card.offlineSince = offlineMap[card.id];
        }
        if (onlineMap[card.id]) {
          delete onlineMap[card.id];
          onlineChanged = true;
        }
        card.onlineSince = null;
      } else {
        if (offlineMap[card.id]) {
          delete offlineMap[card.id];
          offlineChanged = true;
        }
        card.offlineSince = null;
        if (card.agent_online_since_ms != null) {
          card.onlineSince = card.agent_online_since_ms;
          if (onlineMap[card.id] !== card.agent_online_since_ms) {
            onlineMap[card.id] = card.agent_online_since_ms;
            onlineChanged = true;
          }
        } else if (!onlineMap[card.id]) {
          onlineMap[card.id] = now;
          onlineChanged = true;
          card.onlineSince = onlineMap[card.id];
        } else {
          card.onlineSince = onlineMap[card.id];
        }
      }
    });

    if (offlineChanged) saveOfflineSinceMap(offlineMap);
    if (onlineChanged) saveOnlineSinceMap(onlineMap);
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

  function formatOnlineDuration(sinceMs) {
    return formatOfflineDuration(sinceMs);
  }

  function assemblePayload(cards, extra = {}) {
    const cat = heartbeatCatalog;
    const enriched = (cards || []).map((card) => {
      const withPolicy = reapplyStoreCardPolicy(card, cat);
      return enrichCardHeartbeatAlive(withPolicy, cat);
    });
    syncStoreOfflineSince(enriched);
    enriched.sort((a, b) => a.id.localeCompare(b.id));
    return {
      stores: enriched,
      dashboard: buildDashboard(enriched),
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
    return 120000;
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
  const agentProbeState = new Map();
  const AGENT_PROBE_FAIL_TTL_MS = 90000;
  let heartbeatMonitorStarted = false;
  let heartbeatEventSource = null;
  let heartbeatTimeoutTimer = null;
  let heartbeatPollTimer = null;
  let agentProbeTimer = null;
  let heartbeatStreamReconnectMs = 3000;
  let heartbeatPageStartedAt = Date.now();
  let heartbeatCatalog = null;
  let heartbeatOnUpdate = null;
  let heartbeatAuthToken = '';
  let lastStatusBulkMap = {};
  /** IDs suspensos no catálogo Lav60 — não perder ao aplicar saúde de rede / heartbeat. */
  let panelCatalogSuspendedIds = new Set();

  function rememberCatalogSuspension(catalog) {
    const set = new Set();
    (catalog?.suspended_store_ids || []).forEach((id) => {
      const sid = normalizeStoreId(id);
      if (sid) set.add(sid);
    });
    (catalog?.stores || []).forEach((store) => {
      if (String(store?.lav60_status || '').toLowerCase() === 'suspended') {
        const sid = normalizeStoreId(store.id);
        if (sid) set.add(sid);
      }
    });
    panelCatalogSuspendedIds = set;
    if (catalog && typeof catalog === 'object') {
      delete catalog._suspendedIdSet;
    }
  }

  function catalogStoreMeta(catalog, storeId) {
    const sid = normalizeStoreId(storeId);
    if (!sid) return { id: '', name: '' };
    const cat = catalog || heartbeatCatalog;
    const found = (cat?.stores || []).find((row) => normalizeStoreId(row.id) === sid);
    if (found) return found;
    if (panelCatalogSuspendedIds.has(sid)) {
      return { id: sid, name: sid.toUpperCase(), lav60_status: 'suspended' };
    }
    return { id: sid, name: sid.toUpperCase() };
  }

  function reapplyStoreCardPolicy(card, catalog) {
    if (!card || card.loading) return card;
    const cat = catalog || heartbeatCatalog;
    const meta = catalogStoreMeta(cat, card.id);
    const hb = heartbeatState.get(normalizeStoreId(card.id));
    return withStoreCardPolicy(card, meta, hb, cat);
  }

  function getStatusCacheDoc(storeId) {
    return lastStatusBulkMap[normalizeStoreId(storeId)] || null;
  }

  function setLastStatusBulkMap(bulk) {
    lastStatusBulkMap =
      bulk?.stores && typeof bulk.stores === 'object' ? { ...bulk.stores } : {};
  }

  function cardFromStatusCacheEntry(meta, doc, catalog) {
    if (!doc) return null;
    const id = normalizeStoreId(meta.id);
    const status = statusFromStatusCacheDoc(meta, doc, id);
    if (!status?.summary?.total) return null;
    const pulseStale = doc.alive === false;
    let card = buildStoreCard(
      meta,
      status,
      pulseStale ? friendlyUserMessage('Sem pulso recente do agente') : null,
      catalog,
      {
        fromCache: true,
        staleSnapshot: pulseStale,
        agentPulseStale: pulseStale,
        accessible: pulseStale ? false : undefined,
      }
    );
    const agentUrl = doc.agent_url || doc.config_snapshot?.agent_url;
    if (agentUrl) card.agent = normalizeAgentUrl(agentUrl);
    return applyStatusCacheAvailabilityMeta(card, doc);
  }

  function cardHasDeviceDots(card) {
    return Object.values(card?.devices || {}).some(
      (list) => Array.isArray(list) && list.length
    );
  }

  function isStoreHeartbeatAlive(hb, catalog) {
    if (!hb) return false;
    const timeoutMs = getHeartbeatTimeoutMs(catalog);
    const receivedAt = hb.receivedAt || 0;
    return Boolean(receivedAt && Date.now() - receivedAt <= timeoutMs);
  }

  function ingestHeartbeatEntry(storeId, entry) {
    const id = normalizeStoreId(storeId);
    if (!id) return;
    const prev = heartbeatState.get(id);
    const incomingAt =
      typeof entry?.received_at === 'number'
        ? entry.received_at * 1000
        : entry?.receivedAt || 0;
    const prevAt = prev?.receivedAt || 0;
    if (prev && incomingAt > 0 && prevAt > incomingAt) return;
    const receivedAt = incomingAt > 0 ? Math.max(incomingAt, prevAt) : prevAt || Date.now();
    const payload =
      incomingAt >= prevAt ? entry?.payload || entry : prev?.payload || entry?.payload || entry;
    const status = statusFromHeartbeatPayload(null, payload, id);
    heartbeatState.set(id, {
      receivedAt,
      payload,
      lastStatus: status || prev?.lastStatus || null,
      alive: Date.now() - receivedAt <= getHeartbeatTimeoutMs(heartbeatCatalog),
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
    const id = normalizeStoreId(payload.store || catalogId);
    const prev = heartbeatState.get(id);
    status.machines = mergeMachinesCatalog(
      payload?.machines,
      prev?.lastStatus?.machines,
      prev?.payload?.machines
    );
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
    return withStoreCardPolicy(
      attachAgentUrlToCard(
        buildStoreCard(meta, status, null, catalog, { fromHeartbeat: true }),
        hb
      ),
      meta,
      hb,
      catalog
    );
  }

  function heartbeatHasAgentPayload(hb) {
    if (!hb) return false;
    const payload = hb.payload || {};
    return Boolean(
      payload.agent_url ||
        payload.network?.summary?.total ||
        hb.lastStatus?.summary?.total ||
        (Array.isArray(payload.machines) && payload.machines.length)
    );
  }

  async function probeAgentConfigViaPanel(meta, catalog, token) {
    const catalogId = normalizeStoreId(meta.id);
    if (!shouldUsePanelAgentProxy(catalogId)) {
      return fetchStoreStatus(meta, catalog, token);
    }
    try {
      const res = await fetchWithTimeout(
        panelAgentConfigUrl(catalogId),
        {
          headers: authHeaders(token),
          credentials: 'same-origin',
        },
        getAgentProbeTimeoutMs(catalog)
      );
      if (!res.ok) {
        return { status: null, error: friendlyUserMessage(`HTTP ${res.status}`) };
      }
      const config = await res.json();
      if (!agentStoreMatchesCatalog(config.store, catalogId)) {
        return { status: null, error: noAgentMessage(catalogId) };
      }
      return { status: statusFromAgentConfig(config, catalogId), error: null };
    } catch (e) {
      return { status: null, error: connectionErrorMessage(e, catalogId) };
    }
  }

  function applyLiveCardSnapshot(card, meta, hb, catalog, status, extra = {}) {
    const fresh = withStoreCardPolicy(
      attachAgentUrlToCard(
        buildStoreCard(meta, status, null, catalog, {
          fromLiveProbe: true,
          agentPulseStale: false,
          staleSnapshot: false,
          agentProbeFailed: false,
          ...extra,
        }),
        hb
      ),
      meta,
      hb,
      catalog
    );
    Object.keys(fresh).forEach((key) => {
      card[key] = fresh[key];
    });
  }

  async function validateStoresWithAgentProbe(cards, catalog, token) {
    if (!shouldRunLiveAgentProbe()) return;
    const targets = selectAgentProbeTargets(cards, catalog);
    if (!targets.length) return;

    const results = await fetchAgentProbeBatch(
      targets.map((card) => card.id),
      token,
      catalog
    );
    targets.forEach((card) => {
      const row = results[normalizeStoreId(card.id)];
      if (row) applyAgentProbeBatchResult(card, row, catalog);
    });
  }

  function buildOfflineCardFromHeartbeat(meta, catalog, hb) {
    const id = normalizeStoreId(meta.id);
    const statusDoc = getStatusCacheDoc(id);
    const cachedMachines = mergeMachinesCatalog(statusDoc?.machines);
    let lastStatus =
      hb?.lastStatus || statusFromHeartbeatPayload(meta, hb?.payload, id) || null;
    if (lastStatus && cachedMachines.length) {
      lastStatus = { ...lastStatus, machines: mergeMachinesCatalog(lastStatus.machines, cachedMachines) };
    }
    if (lastStatus?.summary?.total) {
      return withStoreCardPolicy(
        attachAgentUrlToCard(
          buildStoreCard(meta, lastStatus, null, catalog, {
            agentPulseStale: true,
            staleSnapshot: true,
          }),
          hb
        ),
        meta,
        hb,
        catalog
      );
    }
    const cached = cardFromStatusCacheEntry(meta, statusDoc, catalog);
    if (cached) {
      return withStoreCardPolicy(
        {
          ...cached,
          accessible: false,
          staleSnapshot: true,
          error: friendlyUserMessage('Sem conexão com a loja'),
          state: 'unreachable',
        },
        meta,
        hb,
        catalog
      );
    }
    return withStoreCardPolicy(
      buildStoreCard(meta, null, 'Sem conexão com a loja', catalog),
      meta,
      hb,
      catalog
    );
  }

  function buildCardFromHeartbeat(meta, catalog) {
    const id = normalizeStoreId(meta.id);
    const hb = heartbeatState.get(id);
    const now = Date.now();

    function fromStatusCache() {
      return cardFromStatusCacheEntry(meta, getStatusCacheDoc(id), catalog);
    }

    function offlineFromCacheOrEmpty() {
      const cached = fromStatusCache();
      if (cached) {
        return {
          ...cached,
          accessible: false,
          state: 'unreachable',
          error: friendlyUserMessage('Sem conexão com a loja'),
          staleSnapshot: true,
        };
      }
      return buildStoreCard(meta, null, 'Sem conexão com a loja', catalog);
    }

    if (!hb) {
      const snapshotGraceMs = 12000;
      if (now - heartbeatPageStartedAt < snapshotGraceMs) {
        const cached = fromStatusCache();
        if (cached?.accessible) {
          return withStoreCardPolicy(
            {
              ...cached,
              accessible: false,
              state: 'unreachable',
              error: friendlyUserMessage('Sem conexão com a loja'),
              staleSnapshot: true,
            },
            meta,
            null,
            catalog
          );
        }
        if (cached) return withStoreCardPolicy(cached, meta, null, catalog);
        return withStoreCardPolicy(buildPlaceholderCard(meta, catalog), meta, null, catalog);
      }
      return withStoreCardPolicy(offlineFromCacheOrEmpty(), meta, null, catalog);
    }

    if (!isStoreHeartbeatAlive(hb, catalog)) {
      return buildOfflineCardFromHeartbeat(meta, catalog, hb);
    }

    const probeFailure = recentAgentProbeFailure(id);
    if (probeFailure) {
      return withStoreCardPolicy(
        buildStoreCard(
          meta,
          null,
          probeFailure.error || friendlyUserMessage('Agente não respondeu'),
          catalog,
          {
            accessible: false,
            fromLiveProbe: true,
            agentProbeFailed: true,
            agentUnavailable: isAgentUnavailableError(probeFailure.error),
          }
        ),
        meta,
        hb,
        catalog
      );
    }

    const status = statusFromHeartbeatPayload(meta, hb.payload, id) || hb.lastStatus;
    if (status?.summary?.total > 0) {
      return buildOnlineCardFromHeartbeat(meta, catalog, hb, status);
    }

    const cached = fromStatusCache();
    if (cached) return withStoreCardPolicy(cached, meta, hb, catalog);
    return withStoreCardPolicy(buildPlaceholderCard(meta, catalog), meta, hb, catalog);
  }

  function buildPayloadFromHeartbeats(catalog, extra = {}) {
    const list = catalog.stores || [];
    const cards = list.map((meta) => buildCardFromHeartbeat(meta, catalog));
    return assemblePayload(cards, { fromHeartbeat: true, ...extra });
  }

  function emitHeartbeatUpdate(extra = {}) {
    if (!heartbeatCatalog || !heartbeatOnUpdate) return;
    heartbeatCatalog = rebuildCatalogStores(heartbeatCatalog, null);
    rememberCatalogSuspension(heartbeatCatalog);
    const payload = buildPayloadFromHeartbeats(heartbeatCatalog, extra);
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
    if (agentProbeTimer) {
      clearInterval(agentProbeTimer);
      agentProbeTimer = null;
    }
  }

  async function pollAgentReachability() {
    if (!shouldRunLiveAgentProbe()) return;
    if (!heartbeatCatalog || !heartbeatMonitorStarted) return;

    const cards = (heartbeatCatalog.stores || [])
      .map((meta) => buildCardFromHeartbeat(meta, heartbeatCatalog))
      .filter((card) => cardNeedsAgentValidation(card, heartbeatCatalog));
    const targets = selectAgentProbeTargets(cards, heartbeatCatalog);
    if (!targets.length) return;

    const results = await fetchAgentProbeBatch(
      targets.map((card) => card.id),
      heartbeatAuthToken,
      heartbeatCatalog
    );
    targets.forEach((card) => {
      const row = results[normalizeStoreId(card.id)];
      if (!row) return;
      if (row.reachable) {
        recordAgentProbe(card.id, { ok: true });
      } else if (row.definite_offline) {
        recordAgentProbe(card.id, {
          ok: false,
          error: friendlyUserMessage(`HTTP ${row.status || 404}`),
        });
      } else if (row.transient_error) {
        recordAgentProbe(card.id, {
          ok: null,
          error: friendlyUserMessage(`HTTP ${row.status || 502}`),
          transient: true,
        });
      }
    });
    emitHeartbeatUpdate({ agentProbe: true });
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

    if (agentProbeTimer) clearInterval(agentProbeTimer);
    agentProbeTimer = setInterval(() => {
      void pollAgentReachability();
    }, 60000);
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
      onStatus(status, {
        live: true,
        receivedAt: entry.received_at || entry.receivedAt,
        payload,
      });
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
    status.machines = mergeMachinesCatalog(config?.machines);
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

  function shouldRefreshStore(_meta, _row, _hash, _catalog, force) {
    return force === true;
  }

  function getConcurrency(catalog) {
    return catalog?.refresh_concurrency || 15;
  }

  async function loadCatalog(options = {}) {
    const force = options.force === true ? '?force=1' : '';
    let res = await fetch(`/api/catalog${force}`, { cache: 'no-store', credentials: 'same-origin' });
    if (!res.ok) {
      res = await fetch(`./stores.json?_=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin' });
    }
    if (!res.ok) throw new Error('Configuração do painel indisponível');
    const catalog = await res.json();
    rememberCatalogSuspension(catalog);
    return catalog;
  }

  function storeMetaFromId(storeId, entry = null) {
    const id = normalizeStoreId(storeId);
    if (!id) return null;
    const payload = entry?.payload || entry || {};
    const name = String(payload.store_name || payload.name || id.toUpperCase()).trim();
    const lav60 =
      lav60StatusFromPayload(payload) ||
      (typeof entry?.lav60_status === 'string' ? entry.lav60_status.trim().toLowerCase() : null) ||
      (typeof payload.lav60_status === 'string' ? payload.lav60_status.trim().toLowerCase() : null);
    return {
      id,
      name: name || id.toUpperCase(),
      ...(lav60 ? { lav60_status: lav60 } : {}),
    };
  }

  function mergeCatalogStores(catalog, cacheMap) {
    const byId = new Map();
    const allowed = new Set((catalog?.stores || []).map((meta) => normalizeStoreId(meta.id)).filter(Boolean));
    (catalog?.stores || []).forEach((meta) => {
      const id = normalizeStoreId(meta.id);
      if (id) byId.set(id, { ...meta, id, name: meta.name || id.toUpperCase() });
    });
    Object.entries(cacheMap || {}).forEach(([id, row]) => {
      const sid = normalizeStoreId(id);
      if (!sid || byId.has(sid)) return;
      if (allowed.size && !allowed.has(sid)) return;
      const card = row?.card;
      byId.set(sid, {
        id: sid,
        name: card?.name || sid.toUpperCase(),
      });
    });
    const stores = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    return { ...(catalog || {}), stores };
  }

  function rebuildCatalogStores(catalog, cacheMap = null) {
    const byId = new Map();
    const allowed = new Set((catalog?.stores || []).map((meta) => normalizeStoreId(meta.id)).filter(Boolean));
    (catalog?.stores || []).forEach((meta) => {
      const id = normalizeStoreId(meta.id);
      if (id) byId.set(id, { ...meta, id, name: meta.name || id.toUpperCase() });
    });
    heartbeatState.forEach((hb, id) => {
      const sid = normalizeStoreId(id);
      if (!sid) return;
      if (allowed.size && !allowed.has(sid)) return;
      const prev = byId.get(sid) || {};
      const suspendedIds = catalogSuspendedIdSet(catalog);
      const fromHb = storeMetaFromId(id, {
        payload: hb.payload,
        lav60_status: suspendedIds.has(sid)
          ? 'suspended'
          : lav60StatusFromPayload(hb.payload) || prev.lav60_status,
      });
      byId.set(sid, { ...prev, ...fromHb });
    });
    Object.entries(cacheMap || {}).forEach(([id, row]) => {
      const sid = normalizeStoreId(id);
      if (!sid || byId.has(sid)) return;
      if (allowed.size && !allowed.has(sid)) return;
      const card = row?.card;
      byId.set(sid, {
        id: sid,
        name: card?.name || sid.toUpperCase(),
      });
    });
    const stores = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    const merged = { ...(catalog || {}), stores };
    delete merged._suspendedIdSet;
    return merged;
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

    const useProxy = ep.panelProxy || shouldUsePanelAgentProxy(catalogId);
    const storeId = normalizeStoreId(ep.storeId || catalogId);
    const agentBase = ep.base ? normalizeAgentUrl(ep.base).replace(/\/$/, '') : window.location.origin;
    const configUrl = useProxy
      ? panelAgentConfigUrl(catalogId)
      : `${agentBase}/api/agent/config`;

    let config;
    try {
      const res = await fetchWithTimeout(
        configUrl,
        {
          headers: useProxy ? { Accept: 'application/json' } : authHeaders(token),
          credentials: useProxy ? 'same-origin' : 'omit',
        },
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
      if (Array.isArray(status.machines)) {
        status.machines = mergeMachinesCatalog(status.machines, config.machines);
      } else if (config.machines?.length) {
        status.machines = mergeMachinesCatalog(config.machines);
      }
      return { status: applyFrontendDeviceVisibility(status), error: null };
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

  async function refreshOneStore(meta, catalog, token, _hash, endpointOverride = null) {
    const { status, error } = await fetchStoreStatus(meta, catalog, token, endpointOverride);
    if (status && !status.summary) attachSummary(status);
    return buildStoreCard(meta, status, error, catalog, { fromCache: false });
  }

  function machinesFromCardDevices(card) {
    if (!card?.devices) return [];
    const out = [];
    ['washers', 'dryers', 'dosers'].forEach((key) => {
      const dtype = DEVICE_GROUP_TYPE[key];
      (card.devices[key] || []).forEach((dev) => {
        if (!dev?.id) return;
        const normalized = normalizeMachineRecord({ ...dev, type: dev.type || dtype });
        out.push(normalized || { ...dev, type: dtype });
      });
    });
    return out;
  }

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
    status.machines = mergeMachinesCatalog(card.machines, machinesFromCardDevices(card));
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
    const machines = mergeMachinesCatalog(status?.machines);
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
    if (!meta?.id || !catalog) return null;
    const id = normalizeStoreId(meta.id);
    const doc = await fetchStoreStatusCache(id, catalog);
    if (!doc?.hit) return null;
    const status = statusFromStatusCacheDoc(meta, doc, id);
    if (!status) return null;
    const card = cardFromStatusCacheEntry(meta, doc, catalog);
    if (!card) return null;
    return {
      card,
      status,
      cachedAt: doc.updated_at_ms || null,
      fresh: doc.alive === true,
    };
  }

  /**
   * Dashboard: recebe heartbeats dos agentes via painel (push).
   * options: { force, onUpdate }
   */
  async function enrichOfflineCardsFromCache(cards, catalog, bulk) {
    const storesMap = bulk?.stores;
    if (!bulk?.available || !storesMap) return;
    const acId = catalog?.ac_id || '110';

    cards.forEach((card) => {
      if (card.accessible || card.loading) return;
      const hasDots = Object.values(card.devices || {}).some(
        (list) => Array.isArray(list) && list.length
      );
      if (hasDots) return;

      const doc = storesMap[normalizeStoreId(card.id)];
      if (!doc) return;
      const status = statusFromStatusCacheDoc({ id: card.id, name: card.name }, doc, card.id);
      if (!status) return;

      reconcileStatusSummary(status, acId);
      card.devices = buildDeviceDots(status, acId);
      card.summary = status.summary || null;
      card.timestamp = status.timestamp || null;
      card.staleSnapshot = true;
      applyStatusCacheAvailabilityMeta(card, doc);
    });
  }

  async function loadAllStores(token, options = {}) {
    const { onUpdate } = options;
    const loadGeneration = ++storesLoadGeneration;
    let catalog = await loadCatalog({ force: true });
    heartbeatPageStartedAt = Date.now();
    catalog = rebuildCatalogStores(catalog, null);
    rememberCatalogSuspension(catalog);
    heartbeatCatalog = catalog;

    function emitBootstrapPaint(cards, extra = {}) {
      if (!onUpdate || !cards?.length || loadGeneration !== storesLoadGeneration) return;
      onUpdate(
        assemblePayload(cards, {
          fromCache: true,
          live: false,
          refreshing: true,
          ...extra,
        })
      );
    }

    const statusBulkPromise = fetchStoresStatusCacheBulk(catalog);
    const heartbeatPromise = fetchHeartbeatsSnapshot();

    statusBulkPromise
      .then((bulk) => {
        if (loadGeneration !== storesLoadGeneration) return;
        setLastStatusBulkMap(bulk);
        if (!bulk?.available || !bulk?.stores) return;
        emitBootstrapPaint(buildCardsFromStatusCacheBulk(catalog, bulk), {
          source: 'firebase',
          fromFirebase: true,
        });
      })
      .catch(() => {});

    const [snapshot, statusBulk] = await Promise.all([heartbeatPromise, statusBulkPromise]);
    if (loadGeneration !== storesLoadGeneration) return null;
    setLastStatusBulkMap(statusBulk);
    ingestHeartbeatSnapshot(snapshot);

    let cards = (catalog.stores || []).map((meta) => buildCardFromHeartbeat(meta, catalog));

    enrichCardsFromStatusCache(cards, catalog, statusBulk);
    await validateStoresWithAgentProbe(cards, catalog, token);
    enrichOfflineCardsFromCache(cards, catalog, statusBulk);
    cards = reapplyAllStoreCardPolicies(cards, catalog);

    const payload = assemblePayload(cards, {
      fromHeartbeat: true,
      fromCache: false,
      live: true,
      refreshing: false,
      heartbeatTimeoutSeconds: snapshot.timeout_seconds,
    });

    if (onUpdate) onUpdate(payload);

    startHeartbeatMonitor(
      catalog,
      (partial) => {
        if (loadGeneration !== storesLoadGeneration) return;
        if (onUpdate) onUpdate({ ...partial, live: true, fromCache: false });
      },
      token
    );
    return payload;
  }

  async function loadStoreCached(meta, catalog, token, options = {}) {
    const id = normalizeStoreId(meta.id);
    const force = options.force === true;

    if (!force) {
      const doc = await fetchStoreStatusCache(id, catalog);
      const status = statusFromStatusCacheDoc(meta, doc, id);
      if (doc?.hit && status?.summary?.total) {
        const card = cardFromStatusCacheEntry(meta, doc, catalog);
        return { card: card || buildStoreCard(meta, status, null, catalog, { fromCache: true }), status, fromCache: true };
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
    if (ep.unmatched || (!ep.base && !ep.panelProxy)) {
      throw new Error(noAgentMessage(meta.id));
    }
    const storeId = normalizeStoreId(meta.id);
    const useProxy = ep.panelProxy || shouldUsePanelAgentProxy(storeId);
    const configUrl = useProxy
      ? panelAgentConfigUrl(storeId)
      : `${normalizeAgentUrl(ep.base).replace(/\/$/, '')}/api/agent/config`;
    const res = await fetch(configUrl, {
      headers: useProxy ? { Accept: 'application/json' } : authHeaders(token),
      credentials: useProxy ? 'same-origin' : 'omit',
    });
    if (!res.ok) {
      throw new Error(friendlyUserMessage(`Config: HTTP ${res.status}`));
    }
    const data = await res.json();
    if (Array.isArray(data.machines)) {
      data.machines = mergeMachinesCatalog(data.machines);
    }
    return { ...data, washer_dosage_options: WASHER_DOSAGE_OPTIONS };
  }

  const AGENT_FAIL_STATUSES = new Set([
    'error',
    'failed',
    'failure',
    'timeout',
    'offline',
    'refused',
    'rejected',
    'unavailable',
    'unreachable',
  ]);

  const AGENT_FAIL_MESSAGE =
    /falhou|failed|not released|n[aã]o liber|did not respond|n[aã]o respondeu|timeout|unreachable|erro ao|could not|unable to|indispon|was not|sem resposta/i;

  function inferAgentOperationKind(method, path) {
    const p = String(path || '').toLowerCase();
    if (String(method || '').toUpperCase() !== 'POST') return null;
    if (/\/dryer\//.test(p)) return 'dryer_release';
    if (/\/washer\//.test(p)) return 'washer_release';
    return null;
  }

  function agentOperationFailureMessage(data) {
    if (!data || typeof data !== 'object') return 'Resposta inválida do agente.';
    if (data.success === false || data.ok === false || data.released === false) {
      return String(data.error || data.message || data.detail || 'Operação recusada pelo equipamento.').trim();
    }
    const status = String(data.status || data.result || '').trim().toLowerCase();
    if (AGENT_FAIL_STATUSES.has(status)) {
      return String(data.message || data.error || data.detail || 'Operação não concluída.').trim();
    }
    const text = String(data.message || data.detail || data.error || data.hint || data.reason || '').trim();
    if (text && AGENT_FAIL_MESSAGE.test(text)) return text;
    return null;
  }

  function evaluateAgentReleaseResponse(data, kind) {
    const fail = agentOperationFailureMessage(data);
    if (fail) return { ok: false, error: fail };
    if (kind === 'dryer_release' || kind === 'washer_release') return { ok: true };
    return { ok: true };
  }

  function releaseStatusFromPayload(payload) {
    if (!payload || typeof payload !== 'object') return '';
    const nested = [payload, payload.machine, payload.device, payload.dryer, payload.washer, payload.data].filter(
      (item) => item && typeof item === 'object'
    );
    for (const item of nested) {
      const st = normalizeMachineStatus(
        item.status || item.machine_status || item.state || item.operational_status
      );
      if (st) return st;
    }
    return '';
  }

  function agentStatusPayloadIndicatesRelease(payload) {
    if (!payload || typeof payload !== 'object') return false;
    if (payload.released === true) return true;
    if (payload.running === true || payload.busy === true || payload.in_use === true) return true;
    const st = releaseStatusFromPayload(payload);
    return st === 'occupied';
  }

  function machineListEntryIndicatesRelease(machines, deviceType, deviceId) {
    const id = normalizeStoreId(deviceId);
    const dtype = String(deviceType || '').toLowerCase();
    if (!id || !Array.isArray(machines)) return false;
    const record = machines.find(
      (item) => normalizeStoreId(item?.id) === id && machineRecordType(item) === dtype
    );
    return record ? agentStatusPayloadIndicatesRelease(record) : false;
  }

  /** Aguarda o agente concluir os pulsos antes de consultar status (secadora). */
  function dryerReleaseVerifyDelayMs(minutes) {
    const m = Number(minutes);
    if (!Number.isFinite(m) || m <= 0) return 1500;
    const pulses = m >= 45 ? 3 : m >= 30 ? 2 : 1;
    return pulses * 1000 + 800;
  }

  function agentPostConfirmsFirstRelease(data) {
    if (!data || typeof data !== 'object') return false;
    if (agentOperationFailureMessage(data)) return false;

    const completed = Number(data.completed_releases);
    if (Number.isFinite(completed) && completed >= 1) return true;

    if (data.released === true) return true;
    if (data.success === true || data.ok === true) return true;

    if (
      data.background_processing === true &&
      data.machine &&
      data.minutes != null &&
      (Number(data.response) === 200 || data.response == null)
    ) {
      return true;
    }

    const msg = String(data.message || data.detail || '').toLowerCase();
    return /started|iniciad|liberad|released|sucesso|successfully/.test(msg);
  }

  function agentPostExplicitlyReleased(data) {
    return agentPostConfirmsFirstRelease(data);
  }

  function delayMs(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  const RELEASE_VERIFY_INTERVAL_MS = 1000;
  const RELEASE_VERIFY_ATTEMPTS = 15;

  async function verifyAgentDeviceRelease(
    meta,
    catalog,
    token,
    deviceType,
    deviceId,
    endpointOverride = null,
    options = {}
  ) {
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

    const devicePath = `/status/${dtype}/${id}`;
    const storePath = '/status';
    let initialDelay = Number(options.initialDelayMs);
    if (!Number.isFinite(initialDelay) || initialDelay < 0) {
      initialDelay = dtype === 'dryer' ? dryerReleaseVerifyDelayMs(options.minutes) : 500;
    }
    if (initialDelay > 0) await delayMs(initialDelay);

    for (let attempt = 0; attempt < RELEASE_VERIFY_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await delayMs(RELEASE_VERIFY_INTERVAL_MS);

      const payload = await agentRequest(
        meta,
        catalog,
        token,
        'GET',
        devicePath,
        undefined,
        endpointOverride,
        { validateOperation: false, verifyRelease: false }
      );
      if (
        agentStatusPayloadIndicatesRelease(payload) ||
        machineListEntryIndicatesRelease(payload?.machines, dtype, id)
      ) {
        return { ...payload, release_verified: true };
      }
      const fail = agentOperationFailureMessage(payload);
      if (fail) throw new Error(fail);

      try {
        const storePayload = await agentRequest(
          meta,
          catalog,
          token,
          'GET',
          storePath,
          undefined,
          endpointOverride,
          { validateOperation: false, verifyRelease: false }
        );
        if (machineListEntryIndicatesRelease(storePayload?.machines, dtype, id)) {
          return { ...storePayload, release_verified: true };
        }
      } catch {
        /* status completo indisponível — continua polling */
      }
    }

    if (options.postData && agentPostExplicitlyReleased(options.postData)) {
      return { ...options.postData, release_verified: true, release_confirm_source: 'agent_post' };
    }

    const label = dtype === 'dryer' ? 'secadora' : 'lavadora';
    throw new Error(
      `Liberação não confirmada — a ${label} ${id.toUpperCase()} não indicou ciclo iniciado. Verifique na loja antes de tentar de novo.`
    );
  }

  async function agentRequest(meta, catalog, token, method, path, body, endpointOverride = null, options = {}) {
    const ep = endpointOverride || (await discoverAgentEndpoint(meta, catalog, token));
    if (ep.unmatched || (!ep.base && !ep.panelProxy)) {
      throw new Error(noAgentMessage(meta.id));
    }
    const storeId = normalizeStoreId(ep.storeId || meta.id);
    const useProxy = ep.panelProxy || shouldUsePanelAgentProxy(storeId);
    let url;
    if (useProxy) {
      if (path.startsWith('/api/')) {
        url = panelAgentConfigUrl(storeId);
      } else {
        const sub = path.startsWith('/') ? path.slice(1) : path;
        url = panelAgentGatewayUrl(storeId, sub);
      }
    } else {
      const agentBase = normalizeAgentUrl(ep.base).replace(/\/$/, '');
      if (path.startsWith('/api/')) {
        url = `${agentBase}${path}`;
      } else {
        const sub = path.startsWith('/') ? path : `/${path}`;
        url = `${agentBase}/${storeId}${sub}`;
      }
    }
    const opts = {
      method,
      headers: useProxy
        ? {
            Accept: 'application/json',
            ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
          }
        : authHeaders(token, body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      credentials: useProxy ? 'same-origin' : 'omit',
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

    const validate = options.validateOperation !== false;
    const kind =
      options.operationKind || (validate ? inferAgentOperationKind(method, path) : null);

    if (validate && kind && kind.includes('release')) {
      const verdict = evaluateAgentReleaseResponse(data, kind);
      if (!verdict.ok) throw new Error(verdict.error);

      const match = String(path).match(/\/(washer|dryer)\/([^/?#]+)/i);
      if (agentPostConfirmsFirstRelease(data)) {
        return {
          ...data,
          release_verified: true,
          release_confirm_source: 'agent_first_pulse',
          machine: data.machine || (match ? match[2] : undefined),
          minutes: data.minutes ?? body?.minutes,
        };
      }

      if (options.verifyRelease !== false) {
        if (match) {
          const verified = await verifyAgentDeviceRelease(
            meta,
            catalog,
            token,
            match[1],
            match[2],
            endpointOverride,
            {
              minutes: body?.minutes,
              postData: data,
            }
          );
          return { ...data, ...(verified || {}), release_verified: true };
        }
      }
    }

    return data;
  }

  window.Lav60 = {
    WASHER_DOSAGE_OPTIONS,
    ensureDefaultAgentToken,
    isAgentTokenConfiguredOnServer,
    shouldUsePanelAgentProxy,
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
    fetchStoreStatusCache,
    fetchStoresStatusCacheBulk,
    statusFromStatusCacheDoc,
    configFromStatusCacheDoc,
    resolveAgentEndpointFromStatusCache,
    enrichCardsFromStatusCache,
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
    mergeMachinesCatalog,
    normalizeMachineCapacity,
    machineModelLabel,
    doserWasherLink,
    enrichDoserMeta,
    normalizeMachineStatus,
    machineStatusPillClass,
    canOperateMachineStatus,
    isNetworkMapOnline,
    machineStatusImpliesReachable,
    resolveDeviceOnline,
    reconcileNetworkFromMachines,
    machineMetaRows,
    machineMetaFacts,
    machineMetaTitle,
    deviceUnifiedStatus,
    devicesFromMachines,
    syncConfigDevices,
    isDeviceVisibleInFrontend,
    isDeviceRegisteredInCatalog,
    isDoserMirroredToWasher,
    applyFrontendDeviceVisibility,
    resolveStoreLav60Status,
    isStoreLav60Suspended,
    isStoreCardSuspended,
    lav60StatusFromPayload,
    buildStoreCard,
    findStoreInCatalog,
    storeMetaFromId,
    rebuildCatalogStores,
    mergeCatalogStores,
    fetchAgentConfig,
    agentRequest,
    inferAgentOperationKind,
    agentOperationFailureMessage,
    agentStatusPayloadIndicatesRelease,
    machineListEntryIndicatesRelease,
    dryerReleaseVerifyDelayMs,
    agentPostConfirmsFirstRelease,
    agentPostExplicitlyReleased,
    verifyAgentDeviceRelease,
    attachSummary,
    formatOfflineDuration,
    formatOnlineDuration,
    getStoreGatewayCacheEntry,
    setStoreGatewayCacheEntry,
    isGatewayCacheFresh,
    formatGatewayCacheAge,
    formatStoreGatewayError,
    verifyStoreGatewayLed,
    fetchStoreStatuses,
    applyStoreStatusRows,
    GATEWAY_TTL_MS,
  };
})();
