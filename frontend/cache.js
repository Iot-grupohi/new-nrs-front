(() => {
  'use strict';

  const DB_NAME = 'lav60_dashboard';
  const DB_VERSION = 1;
  const STORE_CARDS = 'store_cards';

  let dbPromise = null;

  function supportsIndexedDB() {
    return typeof indexedDB !== 'undefined';
  }

  function openDb() {
    if (!supportsIndexedDB()) return Promise.resolve(null);
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains(STORE_CARDS)) {
            db.createObjectStore(STORE_CARDS, { keyPath: 'id' });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }

  function idbTx(storeName, mode) {
    return openDb().then((db) => {
      if (!db) return null;
      return db.transaction(storeName, mode).objectStore(storeName);
    });
  }

  function idbRequest(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  const memoryFallback = new Map();

  async function getAll() {
    const store = await idbTx(STORE_CARDS, 'readonly');
    if (store) {
      const rows = await idbRequest(store.getAll());
      return rows || [];
    }
    return [...memoryFallback.values()];
  }

  async function getStore(id) {
    const key = String(id).toLowerCase();
    const store = await idbTx(STORE_CARDS, 'readonly');
    if (store) {
      const row = await idbRequest(store.get(key));
      return row || null;
    }
    return memoryFallback.get(key) || null;
  }

  async function getMany(ids) {
    const out = {};
    await Promise.all(
      ids.map(async (id) => {
        const key = String(id).toLowerCase();
        const row = await getStore(key);
        if (row) out[key] = row;
      })
    );
    return out;
  }

  async function setStore(id, card, catalogHash, status = null) {
    const key = String(id).toLowerCase();
    const row = {
      id: key,
      card,
      status,
      cachedAt: Date.now(),
      catalogHash,
    };
    const store = await idbTx(STORE_CARDS, 'readwrite');
    if (store) {
      await idbRequest(store.put(row));
    } else {
      memoryFallback.set(key, row);
    }
    return row;
  }

  async function setMany(entries, catalogHash) {
    const store = await idbTx(STORE_CARDS, 'readwrite');
    if (store) {
      await Promise.all(
        entries.map(([id, card]) => {
          const key = String(id).toLowerCase();
          return idbRequest(
            store.put({ id: key, card, cachedAt: Date.now(), catalogHash })
          );
        })
      );
    } else {
      entries.forEach(([id, card]) => {
        memoryFallback.set(String(id).toLowerCase(), {
          id: String(id).toLowerCase(),
          card,
          cachedAt: Date.now(),
          catalogHash,
        });
      });
    }
  }

  async function setManyWithStatus(entries, catalogHash) {
    const db = await openDb();
    if (!db) {
      entries.forEach(([id, card, status]) => {
        const key = String(id).toLowerCase();
        memoryFallback.set(key, {
          id: key,
          card,
          status: status || null,
          cachedAt: Date.now(),
          catalogHash,
        });
      });
      return;
    }

    const chunkSize = 100;
    for (let i = 0; i < entries.length; i += chunkSize) {
      const chunk = entries.slice(i, i + chunkSize);
      await new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_CARDS, 'readwrite');
        const store = tx.objectStore(STORE_CARDS);
        chunk.forEach(([id, card, status]) => {
          const key = String(id).toLowerCase();
          store.put({
            id: key,
            card,
            status: status || null,
            cachedAt: Date.now(),
            catalogHash,
          });
        });
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  }

  async function clearAll() {
    const store = await idbTx(STORE_CARDS, 'readwrite');
    if (store) await idbRequest(store.clear());
    memoryFallback.clear();
  }

  function catalogHash(stores) {
    return stores
      .map((s) => `${s.id}:${s.agent || ''}:${s.name || ''}`)
      .sort()
      .join('|');
  }

  function isFresh(row, hash, ttlMs) {
    if (!row || row.catalogHash !== hash) return false;
    return Date.now() - row.cachedAt < ttlMs;
  }

  window.Lav60Cache = {
    getStore,
    getAll,
    getMany,
    setStore,
    setMany,
    setManyWithStatus,
    clearAll,
    catalogHash,
    isFresh,
  };
})();
