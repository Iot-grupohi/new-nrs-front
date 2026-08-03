(() => {
  'use strict';

  /**
   * Cache TTL unificado do painel (vanilla JS).
   * - Memória (rápido na SPA) + sessionStorage (sobrevive a F5)
   * - Deduplicação de requisições concorrentes
   * - Helpers para stale-while-revalidate
   */

  const KEYS = {
    catalog: 'lav60:panel:catalog',
    catalogEtag: 'lav60:panel:catalog:etag',
    storesPayload: 'lav60:panel:stores-payload',
    heartbeatSnapshot: 'lav60:panel:heartbeat-snapshot',
    heartbeatsLive: 'lav60:panel:heartbeats-live',
    heartbeatsEtag: 'lav60:panel:heartbeats:etag',
    statusBulk: 'lav60:panel:status-bulk',
    statusBulkEtag: 'lav60:panel:status-bulk:etag',
    supportCustom: 'lav60:support:custom',
    supportKnowledge: 'lav60:support:knowledge',
  };

  /** TTLs configuráveis (ms). Ajuste aqui ou via setTtl. */
  const DEFAULT_TTLS = {
    catalog: 10 * 60 * 1000,
    storesPayload: 30 * 60 * 1000,
    /** Enquanto fresco: pinta do cache e não chama a API (SSE mantém ao vivo). */
    storesFresh: 2 * 60 * 1000,
    heartbeats: 5 * 1000,
    statusBulk: 60 * 1000,
    supportCustom: 5 * 60 * 1000,
    supportKnowledge: 30 * 60 * 1000,
  };

  const ttls = { ...DEFAULT_TTLS };
  const memory = new Map();
  const inflight = new Map();

  function setTtl(name, ms) {
    if (typeof ms === 'number' && ms > 0) ttls[name] = ms;
  }

  function getTtl(name) {
    return ttls[name] ?? DEFAULT_TTLS[name] ?? 5 * 60 * 1000;
  }

  function readSession(key) {
    try {
      const raw = sessionStorage.getItem(key);
      if (!raw) return null;
      const row = JSON.parse(raw);
      if (!row || row.data === undefined || !row.cachedAt) return null;
      return row;
    } catch {
      return null;
    }
  }

  function writeSession(key, data) {
    try {
      sessionStorage.setItem(key, JSON.stringify({ data, cachedAt: Date.now() }));
      return true;
    } catch {
      return false;
    }
  }

  function removeSession(key) {
    try {
      sessionStorage.removeItem(key);
    } catch {
      /* private mode */
    }
  }

  function peek(key) {
    const mem = memory.get(key);
    if (mem && mem.data !== undefined && mem.cachedAt) {
      return { data: mem.data, cachedAt: mem.cachedAt, source: 'memory' };
    }
    const row = readSession(key);
    if (!row) return null;
    memory.set(key, { data: row.data, cachedAt: row.cachedAt });
    return { data: row.data, cachedAt: row.cachedAt, source: 'session' };
  }

  function age(key) {
    const entry = peek(key);
    if (!entry) return null;
    return Date.now() - entry.cachedAt;
  }

  function isFresh(key, maxAgeMs) {
    const entryAge = age(key);
    if (entryAge == null) return false;
    return entryAge <= maxAgeMs;
  }

  function getFresh(key, maxAgeMs) {
    const entry = peek(key);
    if (!entry) return null;
    if (Date.now() - entry.cachedAt > maxAgeMs) return null;
    return entry.data;
  }

  function put(key, data, options = {}) {
    const persist = options.persist !== false;
    const cachedAt = Date.now();
    memory.set(key, { data, cachedAt });
    if (persist) writeSession(key, data);
    return { data, cachedAt };
  }

  function forget(keyOrPrefix) {
    if (!keyOrPrefix) return;
    memory.delete(keyOrPrefix);
    removeSession(keyOrPrefix);
    for (const key of [...memory.keys()]) {
      if (key.startsWith(keyOrPrefix)) memory.delete(key);
    }
    try {
      const toRemove = [];
      for (let i = 0; i < sessionStorage.length; i += 1) {
        const key = sessionStorage.key(i);
        if (key && (key === keyOrPrefix || key.startsWith(keyOrPrefix))) toRemove.push(key);
      }
      toRemove.forEach((key) => sessionStorage.removeItem(key));
    } catch {
      /* ignore */
    }
  }

  function invalidatePanelData() {
    forget(KEYS.catalog);
    forget(KEYS.storesPayload);
    forget(KEYS.heartbeatSnapshot);
    forget(KEYS.heartbeatsLive);
    forget(KEYS.statusBulk);
  }

  /**
   * Deduplica chamadas concorrentes à mesma chave.
   * Reutiliza a Promise em voo até ela resolver/rejeitar.
   */
  function dedupe(key, fetcher) {
    if (inflight.has(key)) return inflight.get(key);
    const promise = Promise.resolve()
      .then(fetcher)
      .finally(() => {
        inflight.delete(key);
      });
    inflight.set(key, promise);
    return promise;
  }

  /**
   * getOrFetch: cache hit fresco → retorna sem rede;
   * miss/force → fetch único (dedupe) e grava no cache.
   */
  async function getOrFetch(key, fetcher, options = {}) {
    const ttlMs = options.ttlMs ?? getTtl('catalog');
    const force = options.force === true;
    const persist = options.persist !== false;

    if (!force) {
      const hit = getFresh(key, ttlMs);
      if (hit !== null && hit !== undefined) {
        return { data: hit, fromCache: true, stale: false };
      }
    }

    const data = await dedupe(`${key}:fetch`, fetcher);
    put(key, data, { persist });
    return { data, fromCache: false, stale: false };
  }

  /**
   * Stale-while-revalidate:
   * - se houver cache (mesmo stale), devolve imediatamente
   * - se stale ou miss, dispara revalidate (dedupe) e opcionalmente aguarda
   */
  async function swr(key, fetcher, options = {}) {
    const ttlMs = options.ttlMs ?? getTtl('catalog');
    const freshMs = options.freshMs ?? ttlMs;
    const force = options.force === true;
    const persist = options.persist !== false;
    const waitForRevalidate = options.waitForRevalidate === true;

    const entry = !force ? peek(key) : null;
    const entryAge = entry ? Date.now() - entry.cachedAt : null;
    const fresh = entry && entryAge != null && entryAge <= freshMs;
    const usable = entry && entryAge != null && entryAge <= ttlMs;

    if (fresh) {
      return { data: entry.data, fromCache: true, stale: false, revalidating: false };
    }

    const revalidate = dedupe(`${key}:fetch`, async () => {
      const data = await fetcher();
      put(key, data, { persist });
      return data;
    });

    if (usable && !waitForRevalidate) {
      revalidate.catch(() => {});
      return { data: entry.data, fromCache: true, stale: true, revalidating: true, promise: revalidate };
    }

    const data = await revalidate;
    return { data, fromCache: false, stale: false, revalidating: false };
  }

  function getEtag(etagKey) {
    if (!etagKey) return null;
    const mem = memory.get(etagKey);
    if (typeof mem?.data === 'string') return mem.data;
    try {
      return sessionStorage.getItem(etagKey) || null;
    } catch {
      return null;
    }
  }

  function setEtag(etagKey, etag) {
    if (!etagKey || !etag) return;
    memory.set(etagKey, { data: etag, cachedAt: Date.now() });
    try {
      sessionStorage.setItem(etagKey, etag);
    } catch {
      /* ignore */
    }
  }

  /**
   * fetch com If-None-Match. Em 304, devolve o corpo local (fallback).
   * Retorna { data, fromCache, notModified, etag }.
   */
  async function fetchConditional(url, options = {}) {
    const {
      etagKey,
      fallback,
      force = false,
      fetchImpl = fetch,
      init = {},
    } = options;
    const headers = { Accept: 'application/json', ...(init.headers || {}) };
    const etag = !force ? getEtag(etagKey) : null;
    if (etag) headers['If-None-Match'] = etag;

    const res = await fetchImpl(url, {
      credentials: 'same-origin',
      ...init,
      headers,
      cache: force ? 'no-store' : (init.cache || 'default'),
    });

    if (res.status === 304 && fallback != null) {
      return { data: fallback, fromCache: true, notModified: true, etag, res };
    }
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      err.res = res;
      throw err;
    }
    const data = await res.json();
    const nextEtag = res.headers.get('ETag');
    if (etagKey && nextEtag) setEtag(etagKey, nextEtag);
    return { data, fromCache: false, notModified: false, etag: nextEtag, res };
  }

  window.Lav60Cache = {
    KEYS,
    DEFAULT_TTLS,
    getTtl,
    setTtl,
    peek,
    age,
    isFresh,
    getFresh,
    put,
    forget,
    invalidatePanelData,
    dedupe,
    getOrFetch,
    swr,
    getEtag,
    setEtag,
    fetchConditional,
  };
})();
