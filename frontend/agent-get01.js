(() => {
  'use strict';

  const {
    loadCatalog,
    loadAllStores,
    ensureDefaultAgentToken,
    hydrateStoresPayloadFromCache,
    stopHeartbeatMonitor,
    isAgentsDisabled,
    isStoreAliveInHeartbeats,
    isStoreCardSuspended,
    normalizeStoreId,
  } = window.Lav60;
  const { guardPage, mountUserMenu } = window.Lav60Auth;

  let allStores = [];
  let catalog = null;
  let get01HubList = null;
  let get01Disabled = false;
  let get01RefreshBound = false;

  const $ = (id) => document.getElementById(id);

  function showToast(message, ok = true) {
    const el = $('toast');
    if (!el) return;
    el.textContent = message;
    el.classList.toggle('toast--err', !ok);
    el.classList.remove('hidden');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => el.classList.add('hidden'), 4000);
  }

  function storePageHref(storeId) {
    const sid = encodeURIComponent(normalizeStoreId(storeId));
    if (document.getElementById('appView')) {
      return `index.html?store=${sid}#/store`;
    }
    return `store.html?store=${sid}`;
  }

  function isStoreInGet01Scope(meta) {
    if (!meta) return false;
    if (typeof isStoreCardSuspended === 'function' && isStoreCardSuspended(meta)) return false;
    return String(meta.lav60_status || '').toLowerCase() !== 'suspended';
  }

  function isGet01StoreOnline(meta) {
    if (!isStoreInGet01Scope(meta)) return false;
    if (isAgentsDisabled(null)) return false;
    if (meta?.heartbeatAlive === true) return true;
    const sid = normalizeStoreId(meta?.id);
    return sid ? isStoreAliveInHeartbeats(sid) : false;
  }

  function onlineStoresForGet01() {
    const fromOverview = window.Lav60Get01Overview?.getOnlineStoreMetas?.();
    if (Array.isArray(fromOverview)) return fromOverview;

    const cardById = new Map(
      (allStores || []).map((store) => [normalizeStoreId(store.id), store])
    );
    return (catalog?.stores || []).filter((meta) => {
      if (!isStoreInGet01Scope(meta)) return false;
      const sid = normalizeStoreId(meta.id);
      const card = cardById.get(sid);
      if (card?.heartbeatAlive === true) return true;
      if (card?.heartbeatAlive === false) return false;
      return isGet01StoreOnline(meta);
    });
  }

  function mountGet01HubList() {
    if (!window.Lav60AgentHubStores?.mountHubList) return;
    get01HubList = Lav60AgentHubStores.mountHubList({
      listEl: $('get01StoreList'),
      searchEl: $('get01StoreSearch'),
      metaEl: $('get01StoreHubMeta'),
      countEl: $('get01StoreHubCount'),
      getItems: onlineStoresForGet01,
      getHref: (sid) => storePageHref(sid),
      getSubtext: () => 'Agente online',
      disabled: get01Disabled,
      emptyText: 'Nenhuma loja com agente GET01 online.',
    });
  }

  function refreshGet01HubList() {
    if (get01HubList) {
      get01HubList.refresh();
      return;
    }
    mountGet01HubList();
  }

  function applyGet01Stores(data) {
    allStores = data?.stores || [];
    window.Lav60Get01Overview?.render?.();
    refreshGet01HubList();
  }

  async function refreshGet01Data() {
    const btn = $('btnRefreshGet01');
    btn?.setAttribute('disabled', 'disabled');
    try {
      const token = await ensureDefaultAgentToken();
      await loadAllStores(token, {
        force: true,
        onUpdate: (partial) => applyGet01Stores(partial),
      });
      window.Lav60Get01Overview?.render?.();
      refreshGet01HubList();
    } catch (err) {
      showToast(err.message || 'Falha ao atualizar', false);
    } finally {
      btn?.removeAttribute('disabled');
    }
  }

  function bindGet01Refresh() {
    if (get01RefreshBound) return;
    const btn = $('btnRefreshGet01');
    if (!btn) return;
    get01RefreshBound = true;
    btn.addEventListener('click', () => {
      void refreshGet01Data();
    });
  }

  async function init() {
    // No SPA, a autenticação já foi tratada pelo router.js boot().
    // Nas páginas standalone, continua funcionando via chamada direta.
    if (!document.getElementById('appView')) {
      const returnPath = `agent-get01.html${window.location.search}`;
      const ok = await guardPage({ returnPath });
      if (!ok) return;
    }

    window.Lav60AgentNav?.render?.('get01');
    if ($('headerUserMenu')) await mountUserMenu($('headerUserMenu'));

    window.addEventListener('beforeunload', () => stopHeartbeatMonitor(), { once: true });

    get01Disabled = isAgentsDisabled(null);
    $('get01DisabledAlert')?.classList.toggle('hidden', !get01Disabled);
    $('agentPageHub')?.classList.toggle('hidden', get01Disabled);

    try {
      catalog = await loadCatalog();
      window.Lav60Get01Overview?.mount({
        getStores: () => catalog?.stores || [],
      });
      mountGet01HubList();
      bindGet01Refresh();

      const cached = hydrateStoresPayloadFromCache();
      if (cached?.stores?.length) {
        applyGet01Stores(cached);
      }

      const token = await ensureDefaultAgentToken();
      await loadAllStores(token, {
        onUpdate: (partial) => applyGet01Stores(partial),
      });

      refreshGet01HubList();
    } catch (err) {
      showToast(err.message || 'Falha ao carregar lojas', false);
    }
  }

  function destroy() {
    get01HubList = null;
    get01RefreshBound = false;
  }

  // No SPA: exposto para o router chamar via Lav60AgentGet01Page.init()
  // Em standalone: auto-executa imediatamente
  if (document.getElementById('appView')) {
    window.Lav60AgentGet01Page = {
      init: () => init().catch((err) => {
        document.body.classList.remove('auth-pending');
        showToast(err.message || 'Erro ao iniciar', false);
      }),
      destroy,
    };
  } else {
    init().catch((err) => {
      document.body.classList.remove('auth-pending');
      showToast(err.message || 'Erro ao iniciar', false);
    });
  }
})();
