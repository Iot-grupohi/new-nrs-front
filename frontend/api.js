(() => {
  'use strict';

  const OFFLINE_SINCE_KEY = 'lav60_offline_since';
  const ONLINE_SINCE_KEY = 'lav60_online_since';
  /** Último estado de pulso por loja — detecta transição online→offline no painel. */
  const storeAgentPulseState = new Map();
  const DEFAULT_CACHE_TTL_MS = 5 * 60 * 1000;
  const TtlCache = () => window.Lav60Cache || null;
  const STORES_PAYLOAD_CACHE_KEY = 'lav60:panel:stores-payload';
  const HEARTBEAT_SNAPSHOT_CACHE_KEY = 'lav60:panel:heartbeat-snapshot';
  const CATALOG_CACHE_KEY = 'lav60:panel:catalog';
  const STORES_PAYLOAD_CACHE_TTL_MS = 30 * 60 * 1000;
  const STORES_FRESH_TTL_MS = 2 * 60 * 1000;
  const HEARTBEAT_SNAPSHOT_CACHE_TTL_MS = 5 * 60 * 1000;
  const CATALOG_CACHE_TTL_MS = 10 * 60 * 1000;
  const HEARTBEATS_LIVE_TTL_MS = 5 * 1000;
  const HEARTBEAT_POLL_MS = 8 * 1000;
  const HEARTBEAT_TICK_MS = 3 * 1000;
  const STATUS_BULK_CACHE_TTL_MS = 60 * 1000;

  /** Agentes locais Powpay/heartbeat (GET01). */
  const PANEL_AGENTS_DISABLED = false;
  const PANEL_MQTT_GATEWAY_ENABLED = true;

  function isAgentsDisabled(catalog) {
    return PANEL_AGENTS_DISABLED || catalog?.agents_disabled === true;
  }

  function isMqttGatewayEnabled(catalog) {
    if (!PANEL_MQTT_GATEWAY_ENABLED) return false;
    if (catalog?.mqtt_gateway_enabled === false) return false;
    return true;
  }

  let cachedAgentToken = null;
  let cachedAgentTokenConfigured = false;
  let panelBootstrapCache = null;
  let storesLoadGeneration = 0;
  let catalogMemory = null;
  let catalogMemoryAt = 0;
  let catalogInflight = null;

  async function fetchPanelBootstrap() {
    if (panelBootstrapCache) return panelBootstrapCache;
    const cache = TtlCache();
    const key = 'lav60:panel:bootstrap';
    const ttlMs = 30 * 60 * 1000;
    const cached = cache?.getFresh?.(key, ttlMs);
    if (cached) {
      panelBootstrapCache = cached;
      return panelBootstrapCache;
    }
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
      cache?.put?.(key, panelBootstrapCache, { persist: true });
      return panelBootstrapCache;
    } catch {
      panelBootstrapCache = {};
      return panelBootstrapCache;
    }
  }

  /**
   * Bootstrap do servidor: o token do agente NÃO é mais enviado ao browser.
   * O proxy /api/stores/.../gateway injeta CLOUDFLARE_API_TOKEN no servidor.
   * Retorna string vazia; use isAgentTokenConfiguredOnServer() para UI.
   */
  async function ensureDefaultAgentToken() {
    if (cachedAgentToken !== null) return cachedAgentToken;
    const boot = await fetchPanelBootstrap();
    cachedAgentTokenConfigured = Boolean(boot?.agent_token_configured);
    cachedAgentToken = '';
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

  /** Validação HTTP ao agente — painel central (VPS) e dev local no modo túnel /health. */
  function shouldRunLiveAgentProbe(catalog) {
    const cat = catalog || heartbeatCatalog || catalogMemory;
    if (isRtdbOnlyPanel(cat)) return false;
    if (isCentralPanelHost()) return true;
    if (isPanelOnLocalMachine() && isPowpayHealthPanel(cat)) return true;
    return false;
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
        agentProbeStatusCache.set(id, status);
        applyLiveCardSnapshot(card, meta, hb, catalog, status, { accessible: true });
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
    if (isAgentsDisabled(catalog)) return null;
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

  async function fetchStoresStatusCacheBulk(catalog, options = {}) {
    const force = options.force === true;
    const fields = options.fields || 'dashboard';
    const cache = TtlCache();
    const key = `${cache?.KEYS?.statusBulk || 'lav60:panel:status-bulk'}:${fields}`;
    const ttlMs = cache?.getTtl?.('statusBulk') || STATUS_BULK_CACHE_TTL_MS;

    if (!force && cache?.getFresh) {
      const hit = cache.getFresh(key, ttlMs);
      if (hit) return hit;
    }

    const timeoutMs = Math.min(12000, (getHeartbeatTimeoutMs(catalog) || 8000) + 4000);
    const etagKey = `${cache?.KEYS?.statusBulkEtag || 'lav60:panel:status-bulk:etag'}:${fields}`;
    const fallback = cache?.peek?.(key)?.data || null;
    const bulkUrl = `${panelStoresStatusCacheBulkUrl()}?fields=${encodeURIComponent(fields)}`;
    const fetcher = async () => {
      try {
        if (cache?.fetchConditional) {
          const result = await cache.fetchConditional(bulkUrl, {
            etagKey,
            fallback,
            force,
            fetchImpl: (url, init) => fetchWithTimeout(url, init, timeoutMs),
          });
          return result.data;
        }
        const res = await fetchWithTimeout(
          bulkUrl,
          { credentials: 'same-origin' },
          timeoutMs
        );
        if (!res.ok) return null;
        return res.json();
      } catch {
        return fallback;
      }
    };

    if (cache?.dedupe) {
      const data = await cache.dedupe(`${key}:fetch`, fetcher);
      if (data && cache.put) cache.put(key, data, { persist: true });
      return data;
    }
    return fetcher();
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
    const id = normalizeStoreId(storeId);
    const hb = heartbeatState.get(id);
    if (
      hb &&
      isRtdbOnlyPanel(heartbeatCatalog) &&
      resolveHeartbeatSource(hb.source, hb.payload?.heartbeat_source) === 'rtdb' &&
      rtdbPulseFresh(hb, heartbeatCatalog)
    ) {
      return null;
    }
    const row = agentProbeState.get(id);
    if (!row || row.ok !== false || row.transient) return null;
    if (Date.now() - row.at > maxAgeMs) return null;
    return row;
  }

  function shouldRunRtdbHealthProbe(catalog) {
    // Status do agente vem só do pulso RTDB — health HTTP não altera online/offline.
    return false;
  }

  function powpayHealthProbeUrl(storeId) {
    return `${window.location.origin}/powpay/${normalizeStoreId(storeId)}/health`;
  }

  async function probePowpayHealth(storeId) {
    const id = normalizeStoreId(storeId);
    if (!id) return { ok: false, status: 0, transient: true, definite_offline: false };
    if (!shouldRunRtdbHealthProbe(heartbeatCatalog) && !isPowpayHealthPanel(heartbeatCatalog)) {
      return { ok: null, status: 0, transient: true, definite_offline: false, skipped: true };
    }
    let outcome;
    try {
      const res = await fetchWithTimeout(
        powpayHealthProbeUrl(id),
        { credentials: 'same-origin', headers: { Accept: 'application/json' } },
        10000
      );
      // 404/530 no túnel Powpay não provam agente offline (RTDB pode estar vivo).
      const definite_offline = [401, 403].includes(res.status);
      const transient =
        !definite_offline &&
        (res.status === 0 || res.status === 404 || res.status === 530 || res.status >= 502);
      outcome = {
        ok: res.ok && res.status >= 200 && res.status < 400,
        status: res.status,
        transient,
        definite_offline,
      };
    } catch {
      outcome = { ok: false, status: 0, transient: true, definite_offline: false };
    }
    applyRtdbHealthProbeResult(id, outcome);
    return outcome;
  }

  function rtdbHealthProbeDue(storeId) {
    const row = rtdbHealthByStore.get(normalizeStoreId(storeId));
    if (!row?.checkedAt) return true;
    return Date.now() - row.checkedAt >= RTDB_HEALTH_PROBE_MIN_MS;
  }

  function noteRtdbHeartbeatSeen(storeId, hb) {
    const id = normalizeStoreId(storeId);
    if (!id || !hb) return;
    const pulseMs = heartbeatAgentPulseMs(hb) || Date.now();
    const prev = rtdbHealthByStore.get(id) || {};
    rtdbHealthByStore.set(id, {
      ...prev,
      rtdbPulseMs: pulseMs,
      rtdbSeenAt: Date.now(),
    });
    if (rtdbPulseFresh(hb, heartbeatCatalog)) {
      agentProbeState.delete(id);
    }
  }

  function applyRtdbHealthProbeResult(storeId, result) {
    const id = normalizeStoreId(storeId);
    const prev = rtdbHealthByStore.get(id) || { failStreak: 0 };
    const now = Date.now();
    const hb = heartbeatState.get(id);
    const pulseFresh = Boolean(hb && rtdbPulseFresh(hb, heartbeatCatalog));
    let ok = result?.ok === true;
    let failStreak = ok ? 0 : (prev.failStreak || 0) + 1;
    let definite = Boolean(result?.definite_offline);

    if (!ok && result?.transient && !definite && failStreak < 2 && prev.ok === true) {
      ok = true;
      failStreak = prev.failStreak || 0;
    }

    if ((pulseFresh || isRtdbOnlyPanel(heartbeatCatalog)) && !ok) {
      rtdbHealthByStore.set(id, {
        ...prev,
        ok: prev.ok === true ? true : null,
        checkedAt: now,
        status: result?.status || 0,
        transient: Boolean(result?.transient),
        definite: false,
        failStreak: Math.min(failStreak, 1),
        tunnelReachable: false,
        rtdbPulseMs: heartbeatAgentPulseMs(hb) || prev.rtdbPulseMs || 0,
        rtdbSeenAt: now,
      });
      return;
    }

    rtdbHealthByStore.set(id, {
      ok: ok ? true : definite || failStreak >= 2 ? false : prev.ok ?? null,
      checkedAt: now,
      status: result?.status || 0,
      transient: Boolean(result?.transient),
      definite,
      failStreak,
      tunnelReachable: ok,
      rtdbPulseMs: prev.rtdbPulseMs || (hb ? heartbeatAgentPulseMs(hb) : 0) || 0,
      rtdbSeenAt: prev.rtdbSeenAt || now,
    });
  }

  function applyRtdbHealthToCard(card, result, catalog) {
    const id = normalizeStoreId(card.id);
    const meta = catalogStoreMeta(catalog, id);
    const hb = heartbeatState.get(id);
    const row = rtdbHealthByStore.get(id);

    if (row?.ok === true) {
      recordAgentProbe(id, { ok: true });
      card.agentProbeFailed = false;
      card.agentUnavailable = false;
      card.error = null;
      if ((card.summary?.total ?? 0) > 0 || cardHasDeviceDots(card)) {
        card.accessible = true;
        card.state = storeHealthState(card.summary, null);
      }
      return;
    }

    if (row?.ok === false && (row.definite || (row.failStreak || 0) >= 2)) {
      if (hb && rtdbPulseFresh(hb, catalog)) {
        card.tunnelUnreachable = true;
        return;
      }
      applyAgentProbeFailure(
        card,
        meta,
        hb,
        catalog,
        friendlyUserMessage(`Health HTTP ${result?.status || 'fail'}`)
      );
    }
  }

  function selectRtdbHealthProbeTargets(cards, catalog) {
    return (cards || [])
      .filter((card) => {
        if (!card || card.loading || isStoreCardSuspended(card, catalog)) return false;
        const id = normalizeStoreId(card.id);
        const hb = heartbeatState.get(id);
        if (!hb || resolveHeartbeatSource(hb.source, hb.payload?.heartbeat_source) !== 'rtdb') {
          return false;
        }
        if (!rtdbPulseFresh(hb, catalog)) return false;
        return rtdbHealthProbeDue(id);
      })
      .slice(0, MAX_AGENT_PROBES_PER_CYCLE);
  }

  async function validateRtdbStoresWithHealthProbe(cards, catalog) {
    if (!shouldRunRtdbHealthProbe(catalog)) return;
    const targets = selectRtdbHealthProbeTargets(cards, catalog);
    if (!targets.length) return;

    for (const card of targets) {
      const result = await probePowpayHealth(card.id);
      applyRtdbHealthToCard(card, result, catalog);
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
  }

  async function pollRtdbHealthProbes() {
    if (!shouldRunRtdbHealthProbe(heartbeatCatalog)) return;
    if (!heartbeatCatalog || !heartbeatMonitorStarted) return;

    const cards = (heartbeatCatalog.stores || []).map((meta) =>
      buildCardFromHeartbeat(meta, heartbeatCatalog)
    );
    await validateRtdbStoresWithHealthProbe(cards, heartbeatCatalog);
    emitHeartbeatUpdate({ healthProbe: true });
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
    if (card.fromLiveProbe && !card.agentPulseStale && !card.staleSnapshot && cardHasDeviceDots(card)) {
      return false;
    }

    const id = normalizeStoreId(card.id);
    const hb = heartbeatState.get(id);
    const hbAlive = Boolean(hb && isStoreHeartbeatAlive(hb, catalog));

    if (hbAlive && !cardHasDeviceDots(card)) return true;
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
    const source = resolveHeartbeatSource(card.heartbeatSource, doc.heartbeat_source);
    if (source) card.heartbeatSource = source;
    return card;
  }

  function enrichCardsFromStatusCache(cards, catalog, bulk) {
    if (isRtdbOnlyPanel(catalog)) return;
    const storesMap = bulk?.stores;
    if (!bulk?.available || !storesMap || typeof storesMap !== 'object') return;

    for (const card of cards) {
      const lacksDots = !cardHasDeviceDots(card);
      if (card.accessible && !card.agentPulseStale && card.fromLiveProbe && !lacksDots) continue;
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
        accessible: pulseStale ? false : true,
      });
      applyStatusCacheAvailabilityMeta(card, doc);
    }
    cards.forEach((card, index) => {
      cards[index] = reapplyStoreCardPolicy(card, catalog);
    });
  }

  function enrichPayloadFromStatusCache(cards, catalog) {
    if (isRtdbOnlyPanel(catalog)) return cards;
    if (!lastStatusBulkMap || !Object.keys(lastStatusBulkMap).length) return cards;
    const bulk = { available: true, stores: lastStatusBulkMap };
    enrichCardsFromStatusCache(cards, catalog, bulk);
    enrichOfflineCardsFromCache(cards, catalog, bulk);
    return cards;
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

  function heartbeatEntryToState(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const payload =
      entry.payload && typeof entry.payload === 'object' ? entry.payload : entry;
    let receivedAt = 0;
    if (typeof entry.received_at === 'number' && Number.isFinite(entry.received_at)) {
      receivedAt =
        entry.received_at > 1e12 ? entry.received_at : Math.round(entry.received_at * 1000);
    } else if (typeof entry.receivedAt === 'number' && Number.isFinite(entry.receivedAt)) {
      receivedAt = entry.receivedAt;
    }
    const source = resolveHeartbeatSource(
      entry.heartbeat_source,
      payload?.heartbeat_source,
      entry.source
    );
    const state = {
      receivedAt,
      payload,
      source,
      backendAlive: entry.alive === true,
    };
    const pulseMs = heartbeatAgentPulseMs(state);
    if (pulseMs > 0) state.receivedAt = Math.max(receivedAt || 0, pulseMs);
    return state;
  }

  function isHeartbeatEntryAlive(entry, catalog) {
    if (!entry) return false;
    const cat = catalog || heartbeatCatalog;
    if (isBackendPulsePanel(cat) || isRtdbOnlyPanel(cat)) {
      const hb = heartbeatEntryToState(entry);
      return Boolean(hb && isStoreHeartbeatAlive(hb, cat));
    }
    const timeoutMs = getHeartbeatTimeoutMs(cat);
    const receivedAt =
      typeof entry.received_at === 'number'
        ? entry.received_at > 1e12
          ? entry.received_at
          : entry.received_at * 1000
        : entry.receivedAt || 0;
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
  function looksLikeUuid(value) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value || '').trim());
  }

  function looksLikeIpAddress(value) {
    return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(String(value || '').trim());
  }

  /** Remove entradas duplicadas quando o catálogo já tem ID (432) e IP (192.168.x). */
  function dedupeMachinesByAddress(machines) {
    const list = normalizeMachinesList(machines);
    const hasNumericByType = {};
    list.forEach((m) => {
      const t = machineRecordType(m);
      const id = normalizeStoreId(m.id);
      if (id && !looksLikeIpAddress(id)) hasNumericByType[t] = true;
    });
    return list.filter((m) => {
      const t = machineRecordType(m);
      const id = normalizeStoreId(m.id);
      if (looksLikeIpAddress(id) && hasNumericByType[t]) return false;
      return true;
    });
  }

  function remapNetworkBlockToCatalogIds(block, machines, mtype) {
    const next = { ...(block || {}) };
    dedupeMachinesByAddress(machines).forEach((meta) => {
      if (machineRecordType(meta) !== mtype) return;
      const mid = normalizeStoreId(meta.id);
      if (looksLikeIpAddress(mid)) return;
      const addr = String(meta.address || meta.ip || '').trim();
      if (!addr || !looksLikeIpAddress(addr)) return;
      if (!Object.prototype.hasOwnProperty.call(next, addr)) return;
      if (!Object.prototype.hasOwnProperty.call(next, mid)) {
        next[mid] = next[addr];
      }
      if (mid !== addr) delete next[addr];
    });
    return next;
  }

  function preferCatalogDeviceIds(idSet, machines, dtype) {
    const catalog = dedupeMachinesByAddress(machines).filter(
      (m) => machineRecordType(m) === dtype
    );
    const numericIds = [
      ...new Set(
        catalog
          .filter((m) => !looksLikeIpAddress(normalizeStoreId(m.id)))
          .map((m) => normalizeStoreId(m.id))
          .filter(Boolean)
      ),
    ];
    if (numericIds.length) return numericIds.sort();
    return [...idSet].sort();
  }

  const MACHINE_TYPE_LABELS = {
    washer: 'Lavadora',
    dryer: 'Secadora',
    doser: 'Dosadora',
    ac: 'Ar-condicionado',
  };

  function machineOperationalId(record) {
    if (!record || typeof record !== 'object') return '';
    const code = String(record.code || '').trim();
    const rawId = String(record.id || '').trim();
    if (code && !looksLikeUuid(code)) return normalizeStoreId(code);
    if (rawId && !looksLikeUuid(rawId) && !looksLikeIpAddress(rawId)) {
      return normalizeStoreId(rawId);
    }
    const candidates = [record.name, record.label, record.display_name];
    for (const raw of candidates) {
      const val = String(raw || '').trim();
      if (!val || looksLikeUuid(val) || looksLikeIpAddress(val)) continue;
      return normalizeStoreId(val);
    }
    const addr = String(record.address || record.ip || '').trim();
    if (addr && !looksLikeUuid(addr)) return normalizeStoreId(addr);
    return normalizeStoreId(rawId);
  }

  function machineDisplayTitle(id, meta) {
    const dtype = machineRecordType(meta);
    const typeLabel =
      meta?.machine_type_label || MACHINE_TYPE_LABELS[dtype] || (dtype ? dtype : '');
    const name = String(meta?.display_name || meta?.label || meta?.name || meta?.code || '').trim();
    if (name && !looksLikeUuid(name)) {
      if (/^\d+$/.test(name) && typeLabel) return `${typeLabel} ${name}`;
      return name;
    }
    const normId = String(id || meta?.id || '').trim();
    if (normId && !looksLikeUuid(normId)) {
      if (/^\d+$/.test(normId) && typeLabel) return `${typeLabel} ${normId}`;
      return normId;
    }
    if (typeLabel && normId) return `${typeLabel} ${normId.slice(0, 8)}…`;
    return normId || '—';
  }

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

  const TITAN_DRYER_MINUTES = 60;

  function isTitanDryer(meta) {
    if (machineRecordType(meta) !== 'dryer') return false;
    if (machineModelLabel(meta) === 'titan') return true;
    return normalizeStoreId(meta?.id) === '210';
  }

  /** Secadora TITAN: um único pulso de 60 min; GIANT: opções do config (15/30/45). */
  function dryerMinuteChoices(meta, minutesList) {
    if (isTitanDryer(meta)) {
      return [{ value: String(TITAN_DRYER_MINUTES), label: '60 min' }];
    }
    const list = Array.isArray(minutesList) && minutesList.length ? minutesList : [15, 30, 45];
    return list.map((min) => ({ value: String(min), label: `${min} min` }));
  }

  function dryerChoicePickerColumns(meta) {
    return isTitanDryer(meta) ? 1 : 3;
  }

  function dryerChoiceRequireSelection(_meta) {
    return true;
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
      dosage: 'doser',
    };
    return aliases[value] || value;
  }

  function normalizeMachineRecord(record) {
    if (!record?.id && !record?.name && !record?.code) return null;
    const dtype = machineRecordType(record);
    const operationalId = machineOperationalId(record);
    if (!operationalId) return null;
    const catalogId = looksLikeUuid(record.id) ? String(record.id).trim() : record.catalog_id || null;
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
    const friendlyName = String(record.display_name || record.label || record.name || record.code || '').trim();
    return {
      ...record,
      id: operationalId,
      catalog_id: catalogId,
      code: record.code || record.name || operationalId,
      name: friendlyName && !looksLikeUuid(friendlyName) ? friendlyName : operationalId,
      display_name: friendlyName && !looksLikeUuid(friendlyName) ? friendlyName : null,
      type: dtype,
      machine_type_label: record.machine_type_label || MACHINE_TYPE_LABELS[dtype] || dtype,
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
    return dedupeMachinesByAddress([...merged.values()]).sort(
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
    if (Object.keys(map).length > 0) return false;
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
    const machines = dedupeMachinesByAddress(normalizeMachinesList(next.machines));
    next.machines = machines;
    if (!machines.length) return next;

    next.washers = remapNetworkBlockToCatalogIds(next.washers, machines, 'washer');
    next.dryers = remapNetworkBlockToCatalogIds(next.dryers, machines, 'dryer');

    ['washers', 'dryers', 'dosers'].forEach((key) => {
      const mtype = DEVICE_GROUP_TYPE[key];
      const block = { ...(next[key] || {}) };
      machines.forEach((meta) => {
        if (machineRecordType(meta) !== mtype) return;
        const id = normalizeStoreId(meta.id);
        if (!Object.prototype.hasOwnProperty.call(block, id)) {
          block[id] = false;
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

  function catalogTitanMachine(machines, dtype) {
    return (machines || []).find(
      (m) => machineRecordType(m) === dtype && machineModelLabel(m) === 'titan'
    );
  }

  function catalogHasTitanOfType(machines, dtype) {
    return Boolean(catalogTitanMachine(machines, dtype));
  }

  function canonicalFixedExtraId(dtype) {
    const rule = HIDE_WHEN_OFFLINE.find((row) => row.type === dtype);
    return rule ? normalizeStoreId(rule.id) : null;
  }

  function resolveFixedExtraNetworkOnline(dtype, machineId, network) {
    const mid = normalizeStoreId(machineId);
    const key =
      dtype === 'washer' ? 'washers' : dtype === 'dryer' ? 'dryers' : dtype === 'doser' ? 'dosers' : null;
    if (!key || !network) return false;
    const block = network[key] || {};
    if (isNetworkMapOnline(block[mid])) return true;
    const titan = catalogTitanMachine(network.machines, dtype);
    if (!titan) return false;
    const titanId = normalizeStoreId(titan.id);
    if (titanId !== mid && isNetworkMapOnline(block[titanId])) return true;
    const addr = String(titan.address || titan.ip || '').trim();
    if (addr && isNetworkMapOnline(block[normalizeStoreId(addr)])) return true;
    return false;
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
      if (
        machines.some(
          (m) => machineRecordType(m) === dtype && normalizeStoreId(m.id) === mid
        )
      ) {
        return true;
      }
      const canonicalId = canonicalFixedExtraId(dtype);
      return Boolean(canonicalId && mid === canonicalId && catalogHasTitanOfType(machines, dtype));
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
    return resolveFixedExtraNetworkOnline(dtype, mid, network);
  }

  async function fetchPortalMachinesCatalog(storeId) {
    const sid = normalizeStoreId(storeId);
    if (!sid) return [];
    const urls = [
      `/api/stores/${encodeURIComponent(sid)}/machines`,
      `/api/gateway/machines/${encodeURIComponent(sid)}`,
      `/api/gateway/${encodeURIComponent(sid)}/machines`,
    ];
    for (const url of urls) {
      try {
        const res = await fetch(url, {
          credentials: 'same-origin',
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) continue;
        const data = await res.json();
        if (Array.isArray(data.machines) && data.machines.length) {
          return normalizeMachinesList(data.machines);
        }
      } catch {
        /* tenta próxima rota */
      }
    }
    return [];
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
    const catalog = dedupeMachinesByAddress(machines || []);
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
      washers: preferCatalogDeviceIds(ids.washers, catalog, 'washer').sort(),
      dryers: preferCatalogDeviceIds(ids.dryers, catalog, 'dryer').sort(),
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
    if (dev?.online !== true) return false;
    return normalizeMachineStatus(dev.status) !== 'suspended';
  }

  function isDeviceSuspended(dev) {
    if (dev?.online !== true) return false;
    return normalizeMachineStatus(dev?.status) === 'suspended';
  }

  function isDeviceOccupied(dev) {
    if (dev?.online !== true) return false;
    return normalizeMachineStatus(dev?.status) === 'occupied';
  }

  function isDeviceAvailable(dev) {
    if (dev?.online !== true) return false;
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
      if ((rollup.online ?? 0) <= 0) {
        ['washers', 'dryers', 'dosers'].forEach((key) => {
          if (status[key] && typeof status[key] === 'object') {
            status[key] = Object.fromEntries(Object.keys(status[key]).map((id) => [id, false]));
          }
        });
        status.ac = false;
      }
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
    const set = new Set(panelCatalogSuspendedIds);
    if (!cat) return set;
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
    return set;
  }

  function isStoreCardSuspended(card, catalog) {
    if (!card) return false;
    const sid = normalizeStoreId(card.id);
    if (sid && catalogSuspendedIdSet(catalog).has(sid)) return true;
    if (card.loading) return false;
    return Boolean(
      card.storeSuspended ||
        card.lav60Status === 'suspended' ||
        card.lav60_status === 'suspended' ||
        card.state === 'suspended'
    );
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

    let result = card;
    if (isStoreLav60Suspended(meta, hb, catalog)) {
      const hbAlive = hb && isStoreHeartbeatAlive(hb, catalog);
      const base = {
        ...card,
        lav60Status: 'suspended',
        storeSuspended: true,
      };

      if (!hbAlive) {
        result = {
          ...base,
          state: 'suspended',
          accessible: false,
          storeNotice: STORE_SUSPENDED_NOTICE,
        };
      } else {
        result = {
          ...base,
          state: 'suspended',
          accessible: true,
          agentUnavailable: false,
          loading: false,
          error: null,
          storeNotice: STORE_SUSPENDED_NOTICE,
        };
      }
    }

    return attachHeartbeatSource(result, hb);
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
    const suspended = catalogSuspendedIdSet(catalog).has(normalizeStoreId(meta?.id));
    return buildStoreCard(meta, null, null, catalog, {
      accessible: false,
      state: suspended ? 'suspended' : 'unknown',
      loading: suspended ? false : true,
      error: null,
    });
  }

  /** Card mínimo do catálogo — sem spinner (lista grande de lojas). */
  function buildCatalogPlaceholderCard(meta, catalog) {
    return buildStoreCard(meta, null, null, catalog, {
      accessible: false,
      state: 'unreachable',
      loading: false,
      error: isAgentsDisabled(catalog)
        ? 'Comunicação com agentes desativada'
        : null,
      staleSnapshot: true,
      agentsDisabled: isAgentsDisabled(catalog),
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

  function heartbeatReceivedAtMs(entry) {
    const raw = entry?.received_at ?? entry?.receivedAt;
    if (typeof raw !== 'number' || !Number.isFinite(raw)) return 0;
    if (raw > 1e12) return raw;
    if (raw > 1e9) return Math.round(raw * 1000);
    return Math.round(raw * 1000);
  }

  function isStorePulseOnline(card, catalog) {
    if (!card || card.loading || isStoreCardSuspended(card, catalog || heartbeatCatalog)) {
      return false;
    }
    return card.heartbeatAlive === true;
  }

  function isCardAgentReachable(card) {
    if (!card || card.loading || isStoreCardSuspended(card, heartbeatCatalog)) return false;
    if (card.agentProbeFailed || card.agentUnavailable) return false;
    if (card.accessible === false) return false;
    return card.heartbeatAlive === true;
  }

  function supplementSuspendedStoreEvents(storesSuspendedEvents, all, suspendedIdSet, catalog) {
    const cardById = new Map(all.map((card) => [normalizeStoreId(card.id), card]));
    const seen = new Set(storesSuspendedEvents.map((entry) => normalizeStoreId(entry.store)));
    suspendedIdSet.forEach((sid) => {
      if (seen.has(sid)) return;
      const card = cardById.get(sid);
      const meta = catalogStoreMeta(catalog, sid);
      const hb = heartbeatState.get(sid);
      const hbAlive = Boolean(hb && isStoreHeartbeatAlive(hb, catalog));
      storesSuspendedEvents.push({
        store: sid,
        store_name: meta.name || sid.toUpperCase(),
        state: 'suspended',
        summary_online: card?.summary?.online ?? 0,
        summary_total: card?.summary?.total ?? 0,
        reason: card?.storeNotice || STORE_SUSPENDED_NOTICE,
        agent_online: card?.heartbeatAlive ?? hbAlive,
      });
    });
  }

  function supplementStoresPulseEvents(
    storesOnlineEvents,
    storesOfflineEvents,
    all,
    suspendedIdSet,
    catalog
  ) {
    const cardById = new Map(all.map((card) => [normalizeStoreId(card.id), card]));
    const onlineIds = new Set(storesOnlineEvents.map((e) => normalizeStoreId(e.store)));
    const offlineIds = new Set(storesOfflineEvents.map((e) => normalizeStoreId(e.store)));
    const scopeIds = new Set();
    (catalog?.stores || []).forEach((meta) => {
      const sid = normalizeStoreId(meta.id);
      if (sid && !suspendedIdSet.has(sid)) scopeIds.add(sid);
    });
    all.forEach((card) => {
      const sid = normalizeStoreId(card.id);
      if (sid && !suspendedIdSet.has(sid)) scopeIds.add(sid);
    });

    scopeIds.forEach((sid) => {
      const card = cardById.get(sid);
      if (card?.loading) return;

      const meta = catalogStoreMeta(catalog, sid);
      const hb = heartbeatState.get(sid);
      const pulseOnline = card
        ? isStorePulseOnline(card, catalog)
        : Boolean(hb && isStoreHeartbeatAlive(hb, catalog));

      if (pulseOnline) {
        if (onlineIds.has(sid)) return;
        const summaryOnline = card?.summary?.online ?? 0;
        const summaryTotal = card?.summary?.total ?? 0;
        storesOnlineEvents.push({
          store: sid,
          store_name: meta.name || sid.toUpperCase(),
          state: card?.state || 'online',
          summary_online: summaryOnline,
          summary_total: summaryTotal,
          health_pct: summaryTotal ? Math.round((summaryOnline / summaryTotal) * 100) : 0,
        });
        onlineIds.add(sid);
        return;
      }

      if (offlineIds.has(sid)) return;
      storesOfflineEvents.push({
        store: sid,
        store_name: meta.name || sid.toUpperCase(),
        state: card?.state || 'unreachable',
        summary_online: card?.summary?.online ?? 0,
        summary_total: card?.summary?.total ?? 0,
        kind: card?.heartbeatAlive ? 'agent_unreachable' : 'heartbeat_offline',
        reason: card
          ? card.agentProbeFailed
            ? card.error || 'Agente não respondeu'
            : card.heartbeatAlive
              ? card.error || 'Agente sem resposta HTTP'
              : 'Sem pulso do agente'
          : 'Sem conexão com a loja',
        offline_since: card?.offlineSince || null,
      });
      offlineIds.add(sid);
    });
  }

  function uniqueStoreEventCount(events) {
    return new Set((events || []).map((entry) => normalizeStoreId(entry.store)).filter(Boolean)).size;
  }

  function buildDashboard(cards) {
    const all = cards || [];
    const ready = all.filter((c) => !c.loading);
    const connected = ready.filter((c) => c.accessible);
    const suspendedIdSet = catalogSuspendedIdSet(heartbeatCatalog);
    const unreachable = ready.filter(
      (c) => !suspendedIdSet.has(normalizeStoreId(c.id)) && !c.accessible
    );
    const allDevicesOffline = connected.filter(
      (c) => !suspendedIdSet.has(normalizeStoreId(c.id)) && (c.summary?.online ?? 0) <= 0
    );
    const partialCount = connected.filter((c) => {
      if (suspendedIdSet.has(normalizeStoreId(c.id)) || !isCardAgentReachable(c)) return false;
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
      if (suspendedIdSet.has(normalizeStoreId(card.id))) {
        storesSuspendedEvents.push({
          ...storeEntry,
          reason: card.storeNotice || STORE_SUSPENDED_NOTICE,
          agent_online: card.heartbeatAlive,
        });
      } else if (isStorePulseOnline(card, heartbeatCatalog)) {
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

    supplementSuspendedStoreEvents(storesSuspendedEvents, all, suspendedIdSet, heartbeatCatalog);
    supplementStoresPulseEvents(
      storesOnlineEvents,
      storesOfflineEvents,
      all,
      suspendedIdSet,
      heartbeatCatalog
    );
    const suspendedCount = Math.max(
      storesSuspendedEvents.length,
      Number(heartbeatCatalog?.suspended_count) || 0,
      panelCatalogSuspendedIds.size
    );

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
        online: uniqueStoreEventCount(storesOnlineEvents),
        connected: connected.length,
        offline: uniqueStoreEventCount(storesOfflineEvents),
        partial: partialCount,
        suspended: suspendedCount,
        pending: all.filter((c) => c.loading).length,
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
  const GATEWAY_CACHE_VERSION = 5;
  let storeStatusFetchAt = 0;
  let storeStatusFetchInflight = null;
  let storeStatusLastRows = [];
  let storeStatusAuthBlockedUntil = 0;
  const STORE_STATUS_MIN_MS = 90_000;
  const STORE_STATUS_AUTH_BACKOFF_MS = 60_000;
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
      apiOnline: entry.apiOnline === true,
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

  function syncGatewayVerifyToPanels(storeId, result) {
    const sid = normalizeStoreId(storeId);
    if (!sid || !result || result.skipped) return;
    window.Lav60GatewayOverview?.noteStoreStatus?.(sid, {
      online: result.online === true,
      apiOnline: result.apiOnline === true,
      error: result.error || null,
      checkedAt: result.checkedAt || Date.now(),
      gatewayOfflineSinceMs: result.online === true ? null : result.checkedAt || Date.now(),
    });
  }

  function publishGatewayVerifyResult(storeId, result) {
    syncGatewayVerifyToPanels(storeId, result);
    return result;
  }

  async function verifyStoreGatewayLed(storeId, fetchFn, { force = false } = {}) {
    const sid = normalizeStoreId(storeId);
    if (!sid) throw new Error('Loja inválida');
    if (typeof fetchFn !== 'function') throw new Error('fetchFn obrigatório');

    const catalog = catalogMemory || heartbeatCatalog;
    const catalogStores = catalog?.stores;
    if (Array.isArray(catalogStores) && catalogStores.length) {
      const inCatalog = catalogStores.some((meta) => normalizeStoreId(meta.id) === sid);
      if (!inCatalog) {
        const error = formatStoreGatewayError(sid, 'not found');
        return publishGatewayVerifyResult(sid, {
          online: false,
          error,
          fromCache: false,
          checkedAt: Date.now(),
          apiOnline: false,
          skipped: true,
        });
      }
    }

    const cached = getStoreGatewayCacheEntry(sid);
    if (!force && cached && isGatewayCacheFresh(cached.checkedAt)) {
      return publishGatewayVerifyResult(sid, {
        online: Boolean(cached.online),
        error: cached.error || null,
        fromCache: true,
        checkedAt: cached.checkedAt,
        apiOnline: Boolean(cached.apiOnline ?? cached.online),
      });
    }

    const res = await fetchFn(`/api/gateway/${encodeURIComponent(sid)}/verify`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok) {
      const detail = data.detail || data.error || data.message || `HTTP ${res.status}`;
      const error = formatStoreGatewayError(sid, detail);
      setStoreGatewayCacheEntry(sid, { online: false, error, apiOnline: false });
      return publishGatewayVerifyResult(sid, {
        online: false,
        error,
        fromCache: false,
        checkedAt: Date.now(),
        apiOnline: false,
      });
    }

    const online = data.gateway_online === true;
    const apiOnline = data.gateway_api_online === true;
    const error = online ? null : formatStoreGatewayError(sid, data.gateway_error);
    const checkedAt = data.gateway_checked_at_ms || Date.now();
    setStoreGatewayCacheEntry(sid, { online, error, apiOnline: apiOnline || online });
    return publishGatewayVerifyResult(sid, {
      online,
      error,
      fromCache: false,
      checkedAt,
      apiOnline: apiOnline || online,
    });
  }

  async function fetchStoreStatuses(fetchFn, options = {}) {
    if (typeof fetchFn !== 'function') return [];
    if (!canAccessPanelApis()) return storeStatusLastRows;
    const force = options.force === true;
    const now = Date.now();
    if (!force && now < storeStatusAuthBlockedUntil) return storeStatusLastRows;
    if (!force && storeStatusFetchInflight) return storeStatusFetchInflight;
    if (!force && now - storeStatusFetchAt < STORE_STATUS_MIN_MS) {
      return storeStatusLastRows;
    }

    storeStatusFetchInflight = (async () => {
      try {
        const res = await fetchFn('/api/stores/status', {
          method: 'GET',
          headers: { Accept: 'application/json' },
        });
        if (res.status === 401) {
          window.Lav60Auth?.markPanelSessionInvalid?.();
          storeStatusAuthBlockedUntil = Date.now() + STORE_STATUS_AUTH_BACKOFF_MS;
          return storeStatusLastRows;
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return storeStatusLastRows;
        const rows = Array.isArray(data.items) ? data.items : [];
        storeStatusLastRows = rows;
        storeStatusFetchAt = Date.now();
        storeStatusAuthBlockedUntil = 0;
        return rows;
      } catch {
        return storeStatusLastRows;
      } finally {
        storeStatusFetchInflight = null;
      }
    })();

    return storeStatusFetchInflight;
  }

  function applyStoreStatusRows(rows) {
    if (!Array.isArray(rows)) return;
    rows.forEach((row) => {
      const sid = normalizeStoreId(row?.store);
      if (!sid || row.gateway_checked_at_ms == null) return;
      setStoreGatewayCacheEntry(sid, {
        online: row.gateway_online === true,
        apiOnline: row.gateway_api_online === true,
        error: row.gateway_error || null,
      });
    });
  }

  function isStorePulseOnlineCard(card, catalog) {
    if (!card || card.loading || isStoreCardSuspended(card, catalog || heartbeatCatalog)) {
      return false;
    }
    return card.heartbeatAlive === true;
  }

  function resolveStoreOfflineSinceMs(card, sid, prev, offlineMap, nowMs) {
    const backendOffline =
      card.agent_offline_since_ms != null ? Number(card.agent_offline_since_ms) : null;
    const backendOnline =
      card.agent_online_since_ms != null ? Number(card.agent_online_since_ms) : null;
    const lastOnlineAt = Math.max(
      prev?.lastOnlineAt ?? 0,
      backendOnline && !Number.isNaN(backendOnline) ? backendOnline : 0
    ) || null;
    const cachedOffline = offlineMap[sid] != null ? Number(offlineMap[sid]) : null;

    if (prev?.online === true) {
      return nowMs;
    }
    if (lastOnlineAt) {
      if (backendOffline && backendOffline < lastOnlineAt) return nowMs;
      if (cachedOffline && cachedOffline < lastOnlineAt) return nowMs;
      if (!backendOffline && !cachedOffline) return nowMs;
    }
    if (backendOffline && !Number.isNaN(backendOffline)) return backendOffline;
    if (cachedOffline && !Number.isNaN(cachedOffline)) return cachedOffline;
    return nowMs;
  }

  function syncStoreOfflineSince(cards) {
    const offlineMap = loadOfflineSinceMap();
    let offlineChanged = false;
    const cat = heartbeatCatalog;
    const nowMs = Date.now();

    cards.forEach((card) => {
      if (card.loading) return;

      const sid = normalizeStoreId(card.id);
      if (!sid) return;

      const agentOnline = isRtdbOnlyPanel(cat)
        ? isStorePulseOnlineCard(card, cat)
        : isCardAgentReachable(card);
      const prev = storeAgentPulseState.get(sid);

      if (!agentOnline) {
        const offlineSince = resolveStoreOfflineSinceMs(card, sid, prev, offlineMap, nowMs);
        card.offlineSince = offlineSince;
        if (offlineMap[sid] !== offlineSince) {
          offlineMap[sid] = offlineSince;
          offlineChanged = true;
        }
        card.onlineSince = null;
        storeAgentPulseState.set(sid, {
          online: false,
          lastOnlineAt: prev?.lastOnlineAt ?? null,
        });
      } else {
        const lastOnlineAt =
          card.agent_online_since_ms != null
            ? Number(card.agent_online_since_ms)
            : prev?.lastOnlineAt ?? nowMs;
        if (offlineMap[sid]) {
          delete offlineMap[sid];
          offlineChanged = true;
        }
        card.offlineSince = null;
        card.onlineSince = card.agent_online_since_ms ?? lastOnlineAt;
        storeAgentPulseState.set(sid, {
          online: true,
          lastOnlineAt: Number.isFinite(lastOnlineAt) ? lastOnlineAt : nowMs,
        });
      }
    });

    if (offlineChanged) saveOfflineSinceMap(offlineMap);
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

  function isPowpayHealthPanel(catalog) {
    if (panelPowpayHealth === true) return true;
    const cat = catalog || heartbeatCatalog;
    return cat?.heartbeat_powpay_health === true || cat?.health_probe === true;
  }

  function isRtdbOnlyPanel(catalog) {
    if (isPowpayHealthPanel(catalog)) return false;
    if (panelRtdbOnly === true) return true;
    const cat = catalog || heartbeatCatalog;
    return cat?.heartbeat_rtdb_only === true;
  }

  function isBackendPulsePanel(catalog) {
    return isPowpayHealthPanel(catalog) || isRtdbOnlyPanel(catalog);
  }

  function backendPulseSource(catalog) {
    if (isPowpayHealthPanel(catalog)) return 'health';
    if (isRtdbOnlyPanel(catalog)) return 'rtdb';
    return null;
  }

  function syncPanelPulseFlags(value) {
    if (!value || typeof value !== 'object') return;
    if (value.heartbeat_powpay_health != null || value.health_probe != null) {
      panelPowpayHealth =
        value.heartbeat_powpay_health === true || value.health_probe === true;
    }
    if (value.heartbeat_rtdb_only != null || value.rtdb_only != null) {
      panelRtdbOnly = (value.heartbeat_rtdb_only ?? value.rtdb_only) === true;
    }
    if (heartbeatCatalog && typeof heartbeatCatalog === 'object') {
      heartbeatCatalog = {
        ...heartbeatCatalog,
        heartbeat_powpay_health: panelPowpayHealth,
        heartbeat_rtdb_only: panelRtdbOnly,
      };
    }
  }

  function syncPanelRtdbOnlyFlag(value) {
    syncPanelPulseFlags(
      typeof value === 'boolean' ? { heartbeat_rtdb_only: value } : value
    );
  }

  function countPayloadPending(payload) {
    if (!payload) return 0;
    const dashPending = payload.dashboard?.stores?.pending;
    if (typeof dashPending === 'number') return dashPending;
    return (payload.stores || []).filter((store) => store.loading).length;
  }

  function shouldPersistStoresPayloadCache(payload) {
    if (!payload?.stores?.length || !payload.timestamp) return false;
    if (payload.refreshing) return false;
    return countPayloadPending(payload) === 0;
  }

  function storesPayloadTtlMs() {
    return TtlCache()?.getTtl?.('storesPayload') || STORES_PAYLOAD_CACHE_TTL_MS;
  }

  function storesFreshTtlMs() {
    return TtlCache()?.getTtl?.('storesFresh') || STORES_FRESH_TTL_MS;
  }

  function catalogTtlMs(catalog) {
    if (catalog?.cache_ttl_seconds) return catalog.cache_ttl_seconds * 1000;
    return TtlCache()?.getTtl?.('catalog') || CATALOG_CACHE_TTL_MS;
  }

  function saveStoresPayloadCache(payload) {
    if (!shouldPersistStoresPayloadCache(payload)) return;
    const data = {
      stores: payload.stores,
      dashboard: payload.dashboard,
      timestamp: payload.timestamp,
      heartbeat_rtdb_only: payload.heartbeat_rtdb_only ?? panelRtdbOnly,
      heartbeat_powpay_health: payload.heartbeat_powpay_health ?? panelPowpayHealth,
    };
    const cache = TtlCache();
    if (cache?.put) {
      cache.put(STORES_PAYLOAD_CACHE_KEY, data, { persist: true });
      return;
    }
    try {
      sessionStorage.setItem(
        STORES_PAYLOAD_CACHE_KEY,
        JSON.stringify({ data, cachedAt: Date.now() })
      );
    } catch {
      /* quota / private mode */
    }
  }

  function peekStoresPayloadCache(maxAgeMs = storesPayloadTtlMs()) {
    const cache = TtlCache();
    if (cache?.peek) {
      const entry = cache.peek(STORES_PAYLOAD_CACHE_KEY);
      if (!entry?.data?.stores?.length || !entry.cachedAt) return null;
      if (Date.now() - entry.cachedAt > maxAgeMs) {
        cache.forget(STORES_PAYLOAD_CACHE_KEY);
        return null;
      }
      if (countPayloadPending(entry.data) > 0) {
        cache.forget(STORES_PAYLOAD_CACHE_KEY);
        return null;
      }
      return entry;
    }
    try {
      const raw = sessionStorage.getItem(STORES_PAYLOAD_CACHE_KEY);
      if (!raw) return null;
      const row = JSON.parse(raw);
      if (!row?.data?.stores?.length || !row.cachedAt) return null;
      if (Date.now() - row.cachedAt > maxAgeMs) {
        sessionStorage.removeItem(STORES_PAYLOAD_CACHE_KEY);
        return null;
      }
      if (countPayloadPending(row.data) > 0) {
        sessionStorage.removeItem(STORES_PAYLOAD_CACHE_KEY);
        return null;
      }
      return row;
    } catch {
      return null;
    }
  }

  function loadStoresPayloadCache(maxAgeMs = storesPayloadTtlMs()) {
    return peekStoresPayloadCache(maxAgeMs)?.data || null;
  }

  function isStoresPayloadFresh(freshMs = storesFreshTtlMs()) {
    const entry = peekStoresPayloadCache();
    if (!entry) return false;
    return Date.now() - entry.cachedAt <= freshMs;
  }

  function saveHeartbeatSnapshotCache(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    const cache = TtlCache();
    if (cache?.put) {
      cache.put(HEARTBEAT_SNAPSHOT_CACHE_KEY, snapshot, { persist: true });
      return;
    }
    try {
      sessionStorage.setItem(
        HEARTBEAT_SNAPSHOT_CACHE_KEY,
        JSON.stringify({ data: snapshot, cachedAt: Date.now() })
      );
    } catch {
      /* quota / private mode */
    }
  }

  function loadHeartbeatSnapshotCache(maxAgeMs = HEARTBEAT_SNAPSHOT_CACHE_TTL_MS) {
    const cache = TtlCache();
    if (cache?.getFresh) {
      return cache.getFresh(HEARTBEAT_SNAPSHOT_CACHE_KEY, maxAgeMs);
    }
    try {
      const raw = sessionStorage.getItem(HEARTBEAT_SNAPSHOT_CACHE_KEY);
      if (!raw) return null;
      const row = JSON.parse(raw);
      if (!row?.data || !row.cachedAt) return null;
      if (Date.now() - row.cachedAt > maxAgeMs) return null;
      return row.data;
    } catch {
      return null;
    }
  }

  function invalidateCatalogCache() {
    catalogMemory = null;
    catalogMemoryAt = 0;
    catalogInflight = null;
    TtlCache()?.forget?.(CATALOG_CACHE_KEY);
  }

  function invalidatePanelStoresCache() {
    invalidateCatalogCache();
    TtlCache()?.forget?.(STORES_PAYLOAD_CACHE_KEY);
    TtlCache()?.forget?.(HEARTBEAT_SNAPSHOT_CACHE_KEY);
    TtlCache()?.forget?.(TtlCache()?.KEYS?.heartbeatsLive || 'lav60:panel:heartbeats-live');
    TtlCache()?.forget?.(TtlCache()?.KEYS?.statusBulk || 'lav60:panel:status-bulk');
  }

  /** Pinta dashboard/lojas imediatamente a partir do cache da sessão (F5). */
  function hydrateStoresPayloadFromCache() {
    const snapshot = loadHeartbeatSnapshotCache();
    if (snapshot) {
      syncPanelPulseFlags(snapshot);
      ingestHeartbeatSnapshot(snapshot);
    }

    const cached = loadStoresPayloadCache();
    if (!cached) return quickPaintFromHeartbeatSnapshotCache();

    syncPanelPulseFlags(cached);
    if (isRtdbOnlyPanel(cached) && heartbeatState.size > 0) {
      const metas = (cached.stores || []).map((store) => ({
        id: store.id,
        name: store.name || store.id,
        lav60_status: store.lav60Status || store.lav60_status,
      }));
      return rebuildCardsFromHeartbeatCatalog(
        {
          ...cached,
          stores: metas.length ? metas : cached.stores,
        },
        {
          fromCache: true,
          live: true,
          sessionCache: true,
          refreshing: true,
        }
      );
    }

    return {
      ...cached,
      fromCache: true,
      live: true,
      sessionCache: true,
      refreshing: true,
    };
  }

  function quickPaintFromHeartbeatSnapshotCache() {
    const snapshot = loadHeartbeatSnapshotCache();
    if (!snapshot) return null;
    syncPanelPulseFlags(snapshot);
    ingestHeartbeatSnapshot(snapshot);
    if (!isBackendPulsePanel()) return null;
    return rebuildCardsFromHeartbeatCatalog(
      {
        stores: [],
        heartbeat_rtdb_only: snapshot.rtdb_only ?? panelRtdbOnly,
        heartbeat_powpay_health: snapshot.heartbeat_powpay_health,
      },
      {
        fromCache: true,
        live: true,
        sessionCache: true,
        refreshing: true,
      }
    );
  }

  function isBackendPulseEntry(entry, catalog) {
    const expected = backendPulseSource(catalog || heartbeatCatalog);
    if (!expected) return true;
    return (
      resolveHeartbeatSource(entry?.heartbeat_source, entry?.payload?.heartbeat_source, entry?.source) ===
      expected
    );
  }

  function isRtdbHeartbeatEntry(entry) {
    return isBackendPulseEntry(entry, { heartbeat_rtdb_only: true });
  }

  function isBackendPulseStore(storeId, catalog) {
    const sid = normalizeStoreId(storeId);
    const hb = heartbeatState.get(sid);
    if (!hb) return false;
    const expected = backendPulseSource(catalog || heartbeatCatalog);
    if (!expected) return false;
    if (expected === 'health' && isStoreHeartbeatAlive(hb, catalog || heartbeatCatalog)) {
      const src = resolveHeartbeatSource(hb.source, hb.payload?.heartbeat_source);
      return src === 'health' || src === 'post';
    }
    return resolveHeartbeatSource(hb.source, hb.payload?.heartbeat_source) === expected;
  }

  function filterBackendPulseCards(cards, catalog) {
    if (!isBackendPulsePanel(catalog)) return cards || [];
    const expected = backendPulseSource(catalog);
    return (cards || []).filter((card) => {
      if (card.loading) return true;
      if (isStoreCardSuspended(card, catalog)) return true;
      if (card.heartbeatSource === expected) return true;
      if (isBackendPulseStore(card.id, catalog)) return true;
      return false;
    });
  }

  function isRtdbHeartbeatStore(storeId) {
    return isBackendPulseStore(storeId, { heartbeat_rtdb_only: true });
  }

  function filterRtdbOnlyCards(cards, catalog) {
    return filterBackendPulseCards(cards, catalog);
  }

  function assemblePayload(cards, extra = {}) {
    const cat = heartbeatCatalog;
    const scoped = filterRtdbOnlyCards(cards, cat);
    const enriched = scoped.map((card) => {
      const withPolicy = reapplyStoreCardPolicy(card, cat);
      return enrichCardHeartbeatAlive(withPolicy, cat);
    });
    syncStoreOfflineSince(enriched);
    enriched.sort((a, b) => a.id.localeCompare(b.id));
    return {
      stores: enriched,
      dashboard: buildDashboard(enriched),
      timestamp: new Date().toISOString(),
      heartbeat_rtdb_only: isRtdbOnlyPanel(cat),
      heartbeat_powpay_health: isPowpayHealthPanel(cat),
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
    return 45000;
  }

  /** Intervalo de consulta à rede local do agente GET01 (store.html). */
  function getNetworkCheckIntervalMs(catalog) {
    const seconds =
      catalog?.network_check_interval_seconds ||
      catalog?.network_check_interval ||
      15;
    return Math.max(5000, Number(seconds) * 1000);
  }

  /** Tempo sem heartbeat antes do card do dashboard mostrar offline (>= timeout técnico). */
  function getOfflineDisplayDelayMs(catalog) {
    const timeoutMs = getHeartbeatTimeoutMs(catalog);
    if (catalog?.offline_display_delay_seconds) {
      return Math.max(catalog.offline_display_delay_seconds * 1000, timeoutMs);
    }
    return timeoutMs;
  }

  const heartbeatState = new Map();
  const agentProbeState = new Map();
  /** Status de rede obtido via probe HTTP ao agente (persiste entre rebuilds de card). */
  const agentProbeStatusCache = new Map();
  const AGENT_PROBE_FAIL_TTL_MS = 90000;
  /** Confirmação GET /powpay/{loja}/health após pulso RTDB (Firebase). */
  const rtdbHealthByStore = new Map();
  const RTDB_HEALTH_OK_TTL_MS = 90000;
  const RTDB_HEALTH_PROBE_MIN_MS = 45000;
  let rtdbHealthTimer = null;
  let panelRtdbOnly = false;
  let panelPowpayHealth = false;
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
    if (!catalog || typeof catalog !== 'object') return;
    const fromApi = new Set();
    (catalog.suspended_store_ids || []).forEach((id) => {
      const sid = normalizeStoreId(id);
      if (sid) fromApi.add(sid);
    });
    panelCatalogSuspendedIds = fromApi;
    try {
      if (fromApi.size) {
        sessionStorage.setItem(
          'lav60:catalog:suspended-ids',
          JSON.stringify([...fromApi].sort())
        );
      } else {
        sessionStorage.removeItem('lav60:catalog:suspended-ids');
      }
    } catch {
      /* private mode */
    }
  }

  function restoreCatalogSuspension() {
    /* Suspensão vem só do catálogo Lav60 (/api/catalog), não acumula no sessionStorage. */
  }

  /** Garante lav60_status suspensa no catálogo após merge com heartbeat. */
  function applyCatalogSuspensionMeta(catalog) {
    if (!catalog || typeof catalog !== 'object') return catalog;
    rememberCatalogSuspension(catalog);
    if (!panelCatalogSuspendedIds.size) return catalog;
    catalog.suspended_store_ids = [...panelCatalogSuspendedIds].sort();
    catalog.suspended_count = panelCatalogSuspendedIds.size;
    const byId = new Map(
      (catalog.stores || []).map((store) => [normalizeStoreId(store.id), store])
    );
    panelCatalogSuspendedIds.forEach((sid) => {
      const existing = byId.get(sid);
      if (existing) {
        byId.set(sid, { ...existing, lav60_status: 'suspended' });
      } else {
        byId.set(sid, { id: sid, name: sid.toUpperCase(), lav60_status: 'suspended' });
      }
    });
    catalog.stores = [...byId.values()].sort((a, b) =>
      normalizeStoreId(a.id).localeCompare(normalizeStoreId(b.id))
    );
    return catalog;
  }

  function syncCatalogSuspension(catalog) {
    return applyCatalogSuspensionMeta(catalog);
  }

  restoreCatalogSuspension();

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
    if (!card) return card;
    const cat = catalog || heartbeatCatalog;
    const sid = normalizeStoreId(card.id);
    const catalogSuspended = sid && catalogSuspendedIdSet(cat).has(sid);
    if (card.loading && !catalogSuspended) return card;
    const meta = catalogStoreMeta(cat, card.id);
    const hb = heartbeatState.get(sid);
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
        accessible: pulseStale ? false : true,
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

  function heartbeatPostPulseMs(hb) {
    const raw = hb?.payload?.post_received_at_ms;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return 0;
    return raw > 1e12 ? raw : Math.round(raw * 1000);
  }

  function rtdbPulseFresh(hb, catalog) {
    if (!hb) return false;
    const pulseMs = heartbeatAgentPulseMs(hb);
    if (!pulseMs) return false;
    return Date.now() - pulseMs <= getHeartbeatTimeoutMs(catalog || heartbeatCatalog);
  }

  function isStoreHeartbeatAlive(hb, catalog) {
    if (!hb) return false;
    const cat = catalog || heartbeatCatalog;
    const storeId = normalizeStoreId(hb.payload?.store);
    const source = resolveHeartbeatSource(hb.source, hb.payload?.heartbeat_source);

    if (isRtdbOnlyPanel(cat)) {
      if (source === 'rtdb' || source === 'post' || !source) {
        if (rtdbPulseFresh(hb, cat)) return true;
        const pulseMs = heartbeatAgentPulseMs(hb) || hb.receivedAt || 0;
        const timeoutMs = getHeartbeatTimeoutMs(cat);
        if (pulseMs && Date.now() - pulseMs <= timeoutMs) return true;
        if (hb.backendAlive === true) return true;
      }
      return false;
    }

    const timeoutMs = getHeartbeatTimeoutMs(cat);
    const healthPulseMs =
      source === 'rtdb'
        ? heartbeatAgentPulseMs(hb)
        : hb.receivedAt || heartbeatReceivedAtMs(hb) || 0;
    const postPulseMs =
      source === 'health' || source === 'post' ? heartbeatPostPulseMs(hb) : 0;
    const pulseMs = Math.max(healthPulseMs, postPulseMs);
    return Boolean(pulseMs && Date.now() - pulseMs <= timeoutMs);
  }

  function resolveHeartbeatSource(...candidates) {
    for (const value of candidates) {
      const normalized = String(value || '').trim().toLowerCase();
      if (normalized === 'rtdb' || normalized === 'post' || normalized === 'health') return normalized;
    }
    return null;
  }

  function attachHeartbeatSource(card, hb) {
    if (!card) return card;
    const source = resolveHeartbeatSource(
      card.heartbeatSource,
      hb?.source,
      hb?.payload?.heartbeat_source
    );
    if (!source) return card;
    return card.heartbeatSource === source ? card : { ...card, heartbeatSource: source };
  }

  function markNetworkDevicesOffline(network) {
    if (!network || typeof network !== 'object') return network;
    const out = { ...network };
    ['washers', 'dryers', 'dosers'].forEach((key) => {
      const map = out[key];
      if (map && typeof map === 'object') {
        out[key] = Object.fromEntries(Object.keys(map).map((id) => [id, false]));
      }
    });
    out.ac = false;
    return out;
  }

  function networkSummariesMatch(a, b) {
    if (!a || !b) return false;
    return (a.total ?? 0) === (b.total ?? 0) && (a.online ?? 0) === (b.online ?? 0);
  }

  function applySummaryToExistingStatus(prevStatus, summary, network, payload) {
    if (!prevStatus || !summary) return null;
    if ((summary.online ?? 0) > 0) return null;
    const next = {
      ...prevStatus,
      timestamp: network?.timestamp || prevStatus.timestamp || new Date().toISOString(),
      machines: mergeMachinesCatalog(
        payload?.machines,
        prevStatus.machines,
        prevStatus.machines
      ),
    };
    ['washers', 'dryers', 'dosers'].forEach((key) => {
      if (next[key] && typeof next[key] === 'object') {
        next[key] = Object.fromEntries(Object.keys(next[key]).map((id) => [id, false]));
      }
    });
    next.ac = false;
    return applyFrontendDeviceVisibility(next);
  }

  function normalizeMergedNetwork(network, machines) {
    if (!network || typeof network !== 'object') return network;
    let out = { ...network };
    if ((out.summary?.online ?? 0) <= 0) {
      out = markNetworkDevicesOffline(out);
    }
    const status = applyFrontendDeviceVisibility(
      {
        washers: out.washers || {},
        dryers: out.dryers || {},
        dosers: out.dosers || {},
        ac: Boolean(out.ac),
        machines: machines || [],
        timestamp: out.timestamp || null,
        summary: out.summary || null,
      },
      '110'
    );
    return {
      ...out,
      washers: status.washers || {},
      dryers: status.dryers || {},
      dosers: status.dosers || {},
      ac: status.ac,
      summary: status.summary || null,
    };
  }

  function mergeHeartbeatPayload(prevPayload, nextPayload) {
    const prev = prevPayload && typeof prevPayload === 'object' ? prevPayload : null;
    const next = nextPayload && typeof nextPayload === 'object' ? nextPayload : null;
    if (!next) return prev || {};
    if (!prev) return next;

    const merged = { ...prev, ...next };
    if ((!Array.isArray(next.machines) || !next.machines.length) && Array.isArray(prev.machines)) {
      merged.machines = prev.machines;
    }
    const prevNetwork = prev.network;
    const nextNetwork = next.network;

    if (!nextNetwork || typeof nextNetwork !== 'object') {
      if (prevNetwork && typeof prevNetwork === 'object') {
        merged.network = prevNetwork;
      }
      return merged;
    }

    if (networkPayloadHasDevices(nextNetwork)) {
      merged.network = normalizeMergedNetwork(nextNetwork, merged.machines || prev?.machines);
      return merged;
    }

    const nextSum = nextNetwork.summary;
    if (!nextSum || (nextSum.total ?? 0) <= 0) {
      merged.network = nextNetwork;
      return merged;
    }

    if (prevNetwork && networkHasDeviceMaps(prevNetwork)) {
      let network = { ...prevNetwork };
      if ((nextSum.online ?? 0) <= 0) {
        network = markNetworkDevicesOffline(network);
      }
      merged.network = normalizeMergedNetwork(network, merged.machines || prev?.machines);
      return merged;
    }

    merged.network = normalizeMergedNetwork(
      { ...nextNetwork, summary: nextSum },
      merged.machines || prev?.machines
    );
    return merged;
  }

  function resolveCardStatusFromHeartbeat(meta, hb, catalog) {
    if (!hb) return null;
    const id = normalizeStoreId(meta.id);
    let status = statusFromHeartbeatPayload(meta, hb.payload, id) || hb.lastStatus || null;
    if (status?.summary?.total > 0) return status;
    const network = hb.payload?.network;
    if (!network || typeof network !== 'object') return status;
    if (networkPayloadHasDevices(network) || (network.summary?.total ?? 0) > 0) {
      status = statusFromHeartbeatPayload(meta, hb.payload, id) || status;
    }
    return status?.summary?.total > 0 ? status : status;
  }

  function isRtdbStoreOperable(hb, catalog) {
    return isRtdbOnlyPanel(catalog) && isStoreHeartbeatAlive(hb, catalog);
  }

  function rebuildCardsFromHeartbeatCatalog(catalog, extra = {}) {
    const cat = syncCatalogSuspension(rebuildCatalogStores(catalog, null));
    heartbeatCatalog = cat;
    const cards = (cat.stores || []).map((meta) => buildCardFromHeartbeat(meta, cat));
    return assemblePayload(cards, { fromHeartbeat: true, ...extra });
  }

  function ingestHeartbeatEntry(storeId, entry) {
    const id = normalizeStoreId(storeId);
    if (!id) return;
    const prev = heartbeatState.get(id);
    const incomingAt = heartbeatReceivedAtMs(entry);
    const prevAt = prev?.receivedAt || 0;
    if (prev && incomingAt > 0 && prevAt > incomingAt) return;
    const rawPayload =
      incomingAt >= prevAt ? entry?.payload || entry : prev?.payload || entry?.payload || entry;
    const payload =
      incomingAt >= prevAt ? mergeHeartbeatPayload(prev?.payload, rawPayload) : rawPayload;
    const source = resolveHeartbeatSource(
      entry?.heartbeat_source,
      payload?.heartbeat_source,
      prev?.source
    );
    const pulseMs = source === 'rtdb' ? heartbeatAgentPulseMs({ payload, source }) : 0;
    const receivedAt =
      pulseMs > 0
        ? pulseMs
        : incomingAt > 0
          ? Math.max(incomingAt, prevAt)
          : prevAt || Date.now();
    const status = statusFromHeartbeatPayload(null, payload, id);
    if (isBackendPulsePanel() && source !== backendPulseSource()) return;
    heartbeatState.set(id, {
      receivedAt,
      payload,
      lastStatus: status || prev?.lastStatus || null,
      alive: Date.now() - receivedAt <= getHeartbeatTimeoutMs(heartbeatCatalog),
      backendAlive: entry?.alive === true,
      source,
    });
    if (source === 'rtdb') {
      noteRtdbHeartbeatSeen(id, heartbeatState.get(id));
    }
  }

  function purgeHeartbeatStateNotInSnapshot(snapshot) {
    const items = snapshot?.heartbeats;
    if (!items || typeof items !== 'object') return;
    if (snapshot?.rtdb?.last_sync_error) return;
    const liveIds = new Set(
      Object.keys(items)
        .map(normalizeStoreId)
        .filter(Boolean)
    );
    // Snapshot vazio é sinal de hiato transitório no RTDB (token refresh, throttle).
    // Não remove nada — evita que todo o painel vire "offline" por falha momentânea.
    if (liveIds.size === 0) return;
    const expectedSource = isRtdbOnlyPanel() ? 'rtdb' : backendPulseSource();
    heartbeatState.forEach((hb, id) => {
      const source = resolveHeartbeatSource(hb.source, hb.payload?.heartbeat_source);
      if (isRtdbOnlyPanel()) {
        if (!liveIds.has(id)) {
          heartbeatState.delete(id);
          rtdbHealthByStore.delete(id);
          agentProbeState.delete(id);
        }
        return;
      }
      if (expectedSource && source === expectedSource && !liveIds.has(id)) {
        heartbeatState.delete(id);
        agentProbeState.delete(id);
      }
    });
  }

  function ingestHeartbeatSnapshot(snapshot) {
    syncPanelPulseFlags(snapshot);
    purgeHeartbeatStateNotInSnapshot(snapshot);
    const backendPulse = isBackendPulsePanel();
    const pulseSource = backendPulseSource();
    if (backendPulse && pulseSource) {
      heartbeatState.forEach((hb, id) => {
        if (resolveHeartbeatSource(hb.source, hb.payload?.heartbeat_source) !== pulseSource) {
          heartbeatState.delete(id);
        }
      });
    } else if (isRtdbOnlyPanel()) {
      heartbeatState.forEach((hb, id) => {
        if (resolveHeartbeatSource(hb.source, hb.payload?.heartbeat_source) !== 'rtdb') {
          heartbeatState.delete(id);
        }
      });
    }
    const items = snapshot?.heartbeats || snapshot || {};
    Object.entries(items).forEach(([storeId, entry]) => {
      if (backendPulse && !isBackendPulseEntry(entry)) return;
      if (isRtdbOnlyPanel() && !isRtdbHeartbeatEntry(entry)) return;
      ingestHeartbeatEntry(storeId, entry);
    });
  }

  function networkHasDeviceMaps(network) {
    if (!network || typeof network !== 'object') return false;
    return ['washers', 'dryers', 'dosers'].some(
      (key) => network[key] && Object.keys(network[key]).length > 0
    );
  }

  function networkPayloadHasDevices(network) {
    return networkHasDeviceMaps(network);
  }

  function summaryFromNetworkMaps(network, acId = '110') {
    const status = {
      washers: network?.washers || {},
      dryers: network?.dryers || {},
      dosers: network?.dosers || {},
      ac: Boolean(network?.ac),
      machines: network?.machines || [],
      timestamp: network?.timestamp || null,
    };
    return reconcileStatusSummary(applyFrontendDeviceVisibility(status, acId), acId).summary;
  }

  function heartbeatAgentPulseMs(hb) {
    if (!hb) return 0;
    const payload = hb.payload || {};
    const source = resolveHeartbeatSource(hb.source, payload?.heartbeat_source);
    const rawHb = payload.heartbeat;
    if (typeof rawHb === 'number' && Number.isFinite(rawHb)) {
      return rawHb > 1e12 ? rawHb : Math.round(rawHb * 1000);
    }
    if (rawHb && typeof rawHb === 'object') {
      for (const key of ['timestamp', 'updated_at_ms', 'received_at_ms', 'ts']) {
        const value = rawHb[key];
        if (typeof value === 'number' && Number.isFinite(value)) {
          return value > 1e12 ? value : Math.round(value * 1000);
        }
      }
    }
    const pcStatus = payload.pc_status;
    if (pcStatus && typeof pcStatus.timestamp === 'number' && Number.isFinite(pcStatus.timestamp)) {
      const ts = pcStatus.timestamp;
      return ts > 1e12 ? ts : Math.round(ts * 1000);
    }
    if (source !== 'rtdb') {
      const network = payload.network;
      if (network?.timestamp) {
        const parsed = Date.parse(network.timestamp);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
    for (const key of ['timestamp', 'updated_at_ms', 'received_at_ms']) {
      const value = payload[key];
      if (typeof value === 'number' && Number.isFinite(value)) {
        return value > 1e12 ? value : Math.round(value * 1000);
      }
    }
    if (hb.receivedAt) return hb.receivedAt;
    return heartbeatReceivedAtMs({ received_at: payload.received_at }) || 0;
  }

  function statusFromHeartbeatPayload(meta, payload, catalogId) {
    const network = payload?.network;
    if (!network || typeof network !== 'object') return null;

    const hasDevices = networkPayloadHasDevices(network);
    const summary = network.summary;
    const hasSummary = Boolean(summary && (summary.total ?? 0) > 0);
    const id = normalizeStoreId(payload.store || catalogId);
    const prev = heartbeatState.get(id);

    if (!hasDevices && hasSummary) {
      const machines = mergeMachinesCatalog(
        payload?.machines,
        prev?.lastStatus?.machines,
        prev?.payload?.machines
      );
      if (prev?.lastStatus && networkPayloadHasDevices(prev.lastStatus)) {
        const fromPrev = applySummaryToExistingStatus(
          prev.lastStatus,
          summary,
          network,
          payload
        );
        if (fromPrev) return fromPrev;
      }
      if (machines.length) {
        const summaryOnly = {
          store: id,
          timestamp: network.timestamp || payload.timestamp || new Date().toISOString(),
          summary: { ...summary },
          machines,
        };
        if (!summaryOnly.summary?.total) attachSummary(summaryOnly);
        return applyFrontendDeviceVisibility(summaryOnly);
      }
      if (prev?.lastStatus?.summary?.total) {
        const fromSummary = applySummaryToExistingStatus(
          prev.lastStatus,
          summary,
          network,
          payload
        );
        if (fromSummary) return fromSummary;
      }
      const summaryStatus = {
        store: id,
        washers: network.washers || {},
        dryers: network.dryers || {},
        dosers: network.dosers || {},
        ac: Boolean(network.ac),
        timestamp: network.timestamp || payload.timestamp || new Date().toISOString(),
        summary: { ...summary },
        machines,
      };
      return applyFrontendDeviceVisibility(summaryStatus);
    }

    if (!hasDevices) return null;

    const status = {
      store: id,
      washers: network.washers || {},
      dryers: network.dryers || {},
      dosers: network.dosers || {},
      ac: Boolean(network.ac),
      timestamp: network.timestamp || payload.timestamp || new Date().toISOString(),
      summary: network.summary || null,
    };
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
        buildStoreCard(meta, status, null, catalog, {
          fromHeartbeat: true,
          accessible: true,
          agentPulseStale: false,
          staleSnapshot: false,
        }),
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
    if (shouldRunRtdbHealthProbe(catalog)) {
      await validateRtdbStoresWithHealthProbe(cards, catalog);
      return;
    }
    if (!shouldRunLiveAgentProbe(catalog)) return;
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
    if (isRtdbOnlyPanel(catalog)) {
      return withStoreCardPolicy(
        buildStoreCard(meta, null, 'Sem conexão com a loja', catalog, {
          agentPulseStale: true,
          staleSnapshot: true,
        }),
        meta,
        hb,
        catalog
      );
    }
    const statusDoc = getStatusCacheDoc(id);
    const cachedMachines = mergeMachinesCatalog(statusDoc?.machines);
    let lastStatus =
      hb?.lastStatus || statusFromHeartbeatPayload(meta, hb?.payload, id) || null;
    if (lastStatus && cachedMachines.length) {
      lastStatus = { ...lastStatus, machines: mergeMachinesCatalog(lastStatus.machines, cachedMachines) };
    }
    if (lastStatus?.summary?.total) {
      const acId = catalog?.ac_id || '110';
      lastStatus = applyFrontendDeviceVisibility(lastStatus, acId);
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
      if (isRtdbOnlyPanel(catalog)) return null;
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
      const snapshotGraceMs = isPowpayHealthPanel(catalog) ? 90000 : 12000;
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

    const probeFailure = isRtdbOnlyPanel(catalog)
      ? null
      : hb && rtdbPulseFresh(hb, catalog)
        ? null
        : recentAgentProbeFailure(id);
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

    const status = resolveCardStatusFromHeartbeat(meta, hb, catalog);
    if (status?.summary?.total > 0) {
      return buildOnlineCardFromHeartbeat(meta, catalog, hb, status);
    }

    const probedStatus = agentProbeStatusCache.get(id);
    if (probedStatus?.summary?.total) {
      return buildOnlineCardFromHeartbeat(meta, catalog, hb, probedStatus);
    }

    if (!isRtdbOnlyPanel(catalog)) {
      const cached = fromStatusCache();
      if (cached?.summary?.total) {
        return withStoreCardPolicy(
          {
            ...cached,
            accessible: true,
            staleSnapshot: true,
            agentPulseStale: false,
            error: null,
            state: storeHealthState(cached.summary, null),
          },
          meta,
          hb,
          catalog
        );
      }
    }

    const rtdbOnline = isRtdbStoreOperable(hb, catalog);
    const hasDeviceSummary = Boolean(status?.summary?.total);
    return withStoreCardPolicy(
      attachAgentUrlToCard(
        buildStoreCard(meta, status, null, catalog, {
          fromHeartbeat: true,
          loading: false,
          accessible: rtdbOnline || hasDeviceSummary,
          state: hasDeviceSummary
            ? storeHealthState(status.summary, null)
            : rtdbOnline
              ? 'ok'
              : 'unreachable',
        }),
        hb
      ),
      meta,
      hb,
      catalog
    );
  }

  function applyAgentProbeBatchToCards(cards, results, catalog) {
    if (!results || typeof results !== 'object') return;
    (cards || []).forEach((card) => {
      const row = results[normalizeStoreId(card.id)];
      if (row) applyAgentProbeBatchResult(card, row, catalog);
    });
  }

  function buildPayloadFromHeartbeats(catalog, extra = {}) {
    const list = catalog.stores || [];
    let cards = list.map((meta) => {
      const card = buildCardFromHeartbeat(meta, catalog);
      const probed = agentProbeStatusCache.get(normalizeStoreId(meta.id));
      if (!cardHasDeviceDots(card) && probed?.summary?.total) {
        const hb = heartbeatState.get(normalizeStoreId(meta.id));
        return buildOnlineCardFromHeartbeat(meta, catalog, hb, probed);
      }
      return card;
    });
    cards = enrichPayloadFromStatusCache(cards, catalog);
    cards = reapplyAllStoreCardPolicies(cards, catalog);
    return assemblePayload(cards, { fromHeartbeat: true, ...extra });
  }

  function emitHeartbeatUpdate(extra = {}) {
    if (!heartbeatCatalog || !heartbeatOnUpdate) return;
    heartbeatCatalog = syncCatalogSuspension(rebuildCatalogStores(heartbeatCatalog, null));
    const payload = buildPayloadFromHeartbeats(heartbeatCatalog, extra);
    heartbeatOnUpdate(payload);
  }

  function canAccessPanelApis() {
    const auth = window.Lav60Auth;
    if (!auth || typeof auth.isPanelSessionOk !== 'function') return false;
    return auth.isPanelSessionOk();
  }

  function openHeartbeatEventSource() {
    const open = window.Lav60PanelApi?.openEventSource;
    if (typeof open === 'function') return open('/api/heartbeats/stream');
    return new EventSource('/api/heartbeats/stream');
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
    if (rtdbHealthTimer) {
      clearInterval(rtdbHealthTimer);
      rtdbHealthTimer = null;
    }
  }

  async function pollAgentReachability() {
    if (shouldRunRtdbHealthProbe(heartbeatCatalog)) {
      await pollRtdbHealthProbes();
      return;
    }
    if (!shouldRunLiveAgentProbe(heartbeatCatalog)) return;
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
    applyAgentProbeBatchToCards(targets, results, heartbeatCatalog);
    emitHeartbeatUpdate({ agentProbe: true });
  }

  function connectHeartbeatStream() {
    if (!heartbeatMonitorStarted) return;
    if (!canAccessPanelApis()) {
      stopHeartbeatMonitor();
      return;
    }
    if (heartbeatEventSource) {
      heartbeatEventSource.close();
      heartbeatEventSource = null;
    }
    heartbeatEventSource = openHeartbeatEventSource();
    heartbeatEventSource.onmessage = (event) => {
      heartbeatStreamReconnectMs = 3000;
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'heartbeat') {
          ingestHeartbeatEntry(msg.store, msg);
          bustHeartbeatsLiveCache();
          emitHeartbeatUpdate({ live: true });
        } else if (msg.type === 'heartbeat_removed') {
          const sid = normalizeStoreId(msg.store);
          if (sid) {
            heartbeatState.delete(sid);
            rtdbHealthByStore.delete(sid);
            agentProbeState.delete(sid);
          }
          bustHeartbeatsLiveCache();
          emitHeartbeatUpdate({ live: true, removed: sid });
        } else if (msg.type === 'snapshot') {
          ingestHeartbeatSnapshot(msg);
          bustHeartbeatsLiveCache();
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
      // Sem sessão (logout/expiração): não reconectar em loop gerando 401.
      if (!canAccessPanelApis()) {
        stopHeartbeatMonitor();
        return;
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
    const pollMs = isRtdbOnlyPanel(catalog)
      ? Math.max(10000, (catalog?.heartbeat_interval_seconds || 15) * 1000)
      : 20000;
    heartbeatPollTimer = setInterval(pollHeartbeatsSnapshot, pollMs);

    connectHeartbeatStream();

    if (heartbeatTimeoutTimer) clearInterval(heartbeatTimeoutTimer);
    heartbeatTimeoutTimer = setInterval(() => {
      emitHeartbeatUpdate({ tick: true });
    }, 5000);

    if (shouldRunLiveAgentProbe(catalog)) {
      if (agentProbeTimer) clearInterval(agentProbeTimer);
      agentProbeTimer = setInterval(() => {
        void pollAgentReachability();
      }, 60000);
    } else if (shouldRunRtdbHealthProbe(catalog)) {
      void pollRtdbHealthProbes();
      if (rtdbHealthTimer) clearInterval(rtdbHealthTimer);
      rtdbHealthTimer = setInterval(() => {
        void pollRtdbHealthProbes();
      }, RTDB_HEALTH_PROBE_MIN_MS);
    }
  }

  function bustHeartbeatsLiveCache() {
    const cache = TtlCache();
    if (!cache?.forget) return;
    const base = cache?.KEYS?.heartbeatsLive || 'lav60:panel:heartbeats-live';
    cache.forget(`${base}:lite`);
    cache.forget(`${base}:full`);
  }

  async function pollHeartbeatsSnapshot() {
    try {
      const snap = await fetchHeartbeatsSnapshot({ lite: false });
      ingestHeartbeatSnapshot(snap);
      if (shouldRunRtdbHealthProbe(heartbeatCatalog)) {
        await pollRtdbHealthProbes();
      } else {
        emitHeartbeatUpdate({ poll: true });
      }
    } catch {
      /* painel indisponível */
    }
  }

  async function fetchHeartbeatsSnapshot(options = {}) {
    const force = options.force === true;
    const catalog = options.catalog || heartbeatCatalog;
    const rtdb = isRtdbOnlyPanel(catalog);
    // GET01 (RTDB): snapshot completo com mapas de rede — cards já nascem com totais.
    const lite = options.lite != null ? Boolean(options.lite) : !rtdb;
    if (PANEL_AGENTS_DISABLED) {
      return {
        heartbeats: {},
        timeout_seconds: 45,
        lite: Boolean(lite),
        agents_disabled: true,
      };
    }
    const cache = TtlCache();
    const key = `${cache?.KEYS?.heartbeatsLive || 'lav60:panel:heartbeats-live'}:${lite ? 'lite' : 'full'}`;
    const ttlMs = cache?.getTtl?.('heartbeats') || HEARTBEATS_LIVE_TTL_MS;
    const fallback = cache?.getFresh?.(key, HEARTBEAT_SNAPSHOT_CACHE_TTL_MS)
      || loadHeartbeatSnapshotCache()
      || null;

    if (!canAccessPanelApis()) {
      if (fallback) return fallback;
      return {
        heartbeats: {},
        timeout_seconds: 45,
        lite: Boolean(lite),
        auth_required: true,
      };
    }

    if (!force && cache?.getFresh) {
      const hit = cache.getFresh(key, ttlMs);
      if (hit) return hit;
    }

    const etagKey = `${cache?.KEYS?.heartbeatsEtag || 'lav60:panel:heartbeats:etag'}:${lite ? 'lite' : 'full'}`;
    const url = lite ? '/api/heartbeats?lite=1' : '/api/heartbeats';
    const fetcher = async () => {
      if (cache?.fetchConditional) {
        try {
          const result = await cache.fetchConditional(url, {
            etagKey,
            fallback,
            force,
          });
          saveHeartbeatSnapshotCache(result.data);
          cache.put?.(key, result.data, { persist: false });
          return result.data;
        } catch (err) {
          if (err?.status === 401) {
            window.Lav60Auth?.markPanelSessionInvalid?.();
            stopHeartbeatMonitor();
            if (fallback) return fallback;
          }
          if (fallback) return fallback;
          throw err.status ? new Error('Painel de heartbeat indisponível — execute .\\serve.ps1') : err;
        }
      }
      const res = await fetch(url, { credentials: 'same-origin' });
      if (res.status === 401) {
        window.Lav60Auth?.markPanelSessionInvalid?.();
        stopHeartbeatMonitor();
        if (fallback) return fallback;
        return {
          heartbeats: {},
          timeout_seconds: 45,
          lite: Boolean(lite),
          auth_required: true,
        };
      }
      if (!res.ok) {
        throw new Error('Painel de heartbeat indisponível — execute .\\serve.ps1');
      }
      const data = await res.json();
      saveHeartbeatSnapshotCache(data);
      if (cache?.put) cache.put(key, data, { persist: false });
      return data;
    };

    if (cache?.dedupe) return cache.dedupe(`${key}:fetch`, fetcher);
    return fetcher();
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

    function deliver(entry, options = {}) {
      if (stopped) return;
      const payload = entry?.payload || entry;
      const status =
        payload && entry ? statusFromHeartbeatPayload(null, payload, id) : null;
      const alive =
        options.alive ??
        Boolean(entry && isHeartbeatEntryAlive(entry, catalog));
      onStatus(status?.summary?.total ? status : null, {
        live: true,
        receivedAt: entry?.received_at || entry?.receivedAt,
        payload: payload || null,
        alive,
        entry: entry || null,
      });
    }

    async function bootstrap() {
      try {
        const snap = await fetchHeartbeatsSnapshot({ lite: false });
        const entry = snap.heartbeats?.[id];
        if (entry) deliver(entry);
        else deliver(null, { alive: false });
      } catch {
        /* painel indisponível */
      }
    }

    function connect() {
      if (stopped) return;
      if (!canAccessPanelApis()) {
        stopped = true;
        return;
      }
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      eventSource = openHeartbeatEventSource();
      eventSource.onmessage = (event) => {
        if (stopped) return;
        streamReconnectMs = 3000;
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'heartbeat' && normalizeStoreId(msg.store) === id) {
            deliver(msg);
          } else if (msg.type === 'heartbeat_removed' && normalizeStoreId(msg.store) === id) {
            deliver(null, { alive: false });
          } else if (msg.type === 'snapshot') {
            const entry = msg.heartbeats?.[id];
            if (entry) deliver(entry);
            else deliver(null, { alive: false });
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
        if (!canAccessPanelApis()) {
          stopped = true;
          return;
        }
        const delay = streamReconnectMs;
        streamReconnectMs = Math.min(Math.round(streamReconnectMs * 1.5), 30000);
        setTimeout(connect, delay);
      };
    }

    async function pollOnce() {
      if (stopped || !canAccessPanelApis()) return;
      try {
        const snap = await fetchHeartbeatsSnapshot();
        const entry = snap.heartbeats?.[id];
        if (entry) deliver(entry);
        else deliver(null, { alive: false });
      } catch {
        /* painel indisponível */
      }
    }

    if (!canAccessPanelApis()) {
      return () => {
        stopped = true;
      };
    }

    if (skipInitialBootstrap) {
      connect();
    } else {
      bootstrap().then(connect);
    }
    if (!skipInitialPoll) {
      pollOnce();
    }
    pollTimer = setInterval(pollOnce, HEARTBEAT_POLL_MS);

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
    const snap = await fetchHeartbeatsSnapshot({ lite: false });
    const entry = snap.heartbeats?.[id];
    if (!entry || !isHeartbeatEntryAlive(entry, catalog)) {
      return { status: null, error: 'Sem heartbeat recente do agente' };
    }
    const status = resolveCardStatusFromHeartbeat(meta, { payload: entry.payload || entry }, catalog)
      || statusFromHeartbeatPayload(meta, entry.payload || entry, id);
    if (!status?.summary?.total) {
      return { status: null, error: 'Aguardando leitura de equipamentos' };
    }
    return { status, error: null };
  }

  function isStoreAliveInHeartbeats(storeId, catalog) {
    const id = normalizeStoreId(storeId);
    const hb = heartbeatState.get(id);
    if (!hb) return false;
    return isStoreHeartbeatAlive(hb, catalog || heartbeatCatalog);
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
    const force = options.force === true;
    const ttlMs = catalogTtlMs(catalogMemory);
    const cache = TtlCache();

    if (!force) {
      if (catalogMemory && Date.now() - catalogMemoryAt <= ttlMs) {
        syncPanelPulseFlags(catalogMemory);
        return syncCatalogSuspension(catalogMemory);
      }
      const cached = cache?.getFresh?.(CATALOG_CACHE_KEY, ttlMs);
      if (cached) {
        catalogMemory = cached;
        catalogMemoryAt = Date.now();
        syncPanelPulseFlags(cached);
        return syncCatalogSuspension(cached);
      }
    }

    if (catalogInflight && !force) return catalogInflight;

    catalogInflight = (async () => {
      const qs = force ? '?force=1' : '';
      const etagKey = cache?.KEYS?.catalogEtag || 'lav60:panel:catalog:etag';
      const stale = cache?.peek?.(CATALOG_CACHE_KEY)?.data || catalogMemory;
      try {
        if (cache?.fetchConditional) {
          const result = await cache.fetchConditional(`/api/catalog${qs}`, {
            etagKey,
            fallback: stale,
            force,
          });
          const catalog = syncCatalogSuspension(result.data);
          syncPanelPulseFlags(catalog);
          catalogMemory = catalog;
          catalogMemoryAt = Date.now();
          cache.put?.(CATALOG_CACHE_KEY, catalog, { persist: true });
          if (catalog?.cache_ttl_seconds) {
            cache.setTtl?.('catalog', catalog.cache_ttl_seconds * 1000);
          }
          return catalog;
        }
      } catch {
        /* fallback abaixo */
      }

      let res = await fetch(`/api/catalog${qs}`, { cache: 'no-store', credentials: 'same-origin' });
      if (!res.ok) {
        res = await fetch(`./stores.json?_=${Date.now()}`, { cache: 'no-store', credentials: 'same-origin' });
      }
      if (!res.ok) throw new Error('Configuração do painel indisponível');
      const catalog = syncCatalogSuspension(await res.json());
      syncPanelPulseFlags(catalog);
      catalogMemory = catalog;
      catalogMemoryAt = Date.now();
      cache?.put?.(CATALOG_CACHE_KEY, catalog, { persist: true });
      if (catalog?.cache_ttl_seconds) {
        cache?.setTtl?.('catalog', catalog.cache_ttl_seconds * 1000);
      }
      return catalog;
    })().finally(() => {
      catalogInflight = null;
    });

    return catalogInflight;
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
    const backendPulse = isBackendPulsePanel(catalog);
    const pulseSource = backendPulseSource(catalog);

    if (!backendPulse) {
      const allowed = new Set((catalog?.stores || []).map((meta) => normalizeStoreId(meta.id)).filter(Boolean));
      (catalog?.stores || []).forEach((meta) => {
        const id = normalizeStoreId(meta.id);
        if (id) byId.set(id, { ...meta, id, name: meta.name || id.toUpperCase() });
      });
    }

    heartbeatState.forEach((hb, id) => {
      const sid = normalizeStoreId(id);
      if (!sid) return;
      if (
        backendPulse &&
        pulseSource &&
        resolveHeartbeatSource(hb.source, hb.payload?.heartbeat_source) !== pulseSource
      ) {
        return;
      }
      if (!backendPulse) {
        const allowed = new Set((catalog?.stores || []).map((meta) => normalizeStoreId(meta.id)).filter(Boolean));
        if (allowed.size && !allowed.has(sid)) return;
      }
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
      if (backendPulse) return;
      const allowed = new Set((catalog?.stores || []).map((meta) => normalizeStoreId(meta.id)).filter(Boolean));
      if (allowed.size && !allowed.has(sid)) return;
      const card = row?.card;
      byId.set(sid, {
        id: sid,
        name: card?.name || sid.toUpperCase(),
      });
    });
    const stores = [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
    const merged = { ...(catalog || {}), stores };
    return syncCatalogSuspension(merged);
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
    if (isRtdbOnlyPanel(catalog)) return;
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
    cards.forEach((card, index) => {
      cards[index] = reapplyStoreCardPolicy(card, catalog);
    });
  }

  async function loadAllStores(token, options = {}) {
    const { onUpdate } = options;
    const loadGeneration = ++storesLoadGeneration;
    let catalog = await loadCatalog({ force: options.force === true });
    heartbeatPageStartedAt = Date.now();
    catalog = syncCatalogSuspension(rebuildCatalogStores(catalog, null));
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
    const heartbeatPromise = fetchHeartbeatsSnapshot({ force: true, lite: false });

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
    if (isAgentsDisabled(catalog)) {
      throw new Error('Comunicação com agentes locais desativada neste painel.');
    }
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
      data.machines = dedupeMachinesByAddress(mergeMachinesCatalog(data.machines));
    }
    if (data.devices && Array.isArray(data.machines) && data.machines.length) {
      data.devices = devicesFromMachines(data.machines, data.last_network_check || data);
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
    if (isAgentsDisabled(catalog)) {
      throw new Error('Comunicação com agentes locais desativada neste painel.');
    }
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
    data._httpStatus = res.status;
    data._httpOk = res.ok;
    if (!res.ok) {
      if (options.allowHttpError) {
        return data;
      }
      throw new Error(friendlyUserMessage(data.detail || data.message || data.error || `HTTP ${res.status}`, ''));
    }

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
    getPollIntervalMs: (catalog) => getNetworkCheckIntervalMs(catalog),
    getNetworkCheckIntervalMs,
    getHeartbeatTimeoutMs,
    isHeartbeatEntryAlive,
    networkPayloadHasDevices,
    lav60Debug,
    fetchHeartbeatsSnapshot,
    probePowpayHealth,
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
    hydrateStoresPayloadFromCache,
    countPayloadPending,
    saveStoresPayloadCache,
    isStoresPayloadFresh,
    invalidateCatalogCache,
    invalidatePanelStoresCache,
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
    isTitanDryer,
    dryerMinuteChoices,
    dryerChoicePickerColumns,
    dryerChoiceRequireSelection,
    TITAN_DRYER_MINUTES,
    machineDisplayTitle,
    looksLikeUuid,
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
    fetchPortalMachinesCatalog,
    isDoserMirroredToWasher,
    applyFrontendDeviceVisibility,
    resolveStoreLav60Status,
    isStoreLav60Suspended,
    isStoreCardSuspended,
    lav60StatusFromPayload,
    buildStoreCard,
    findStoreInCatalog,
    storeMetaFromId,
    isAgentsDisabled,
    isMqttGatewayEnabled,
    PANEL_AGENTS_DISABLED,
    PANEL_MQTT_GATEWAY_ENABLED,
    isPowpayHealthPanel,
    isRtdbOnlyPanel,
    isBackendPulsePanel,
    backendPulseSource,
    isRtdbHeartbeatStore,
    filterRtdbOnlyCards,
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
