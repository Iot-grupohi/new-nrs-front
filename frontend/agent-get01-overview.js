(() => {
  'use strict';

  const { normalizeStoreId, isAgentsDisabled, isStoreCardSuspended, isStoreAliveInHeartbeats } =
    window.Lav60;

  const GET01_KPI_CONFIG = {
    'get01-online': {
      title: 'Agentes online',
      empty: 'Nenhum agente GET01 online.',
    },
    'get01-offline': {
      title: 'Agentes offline',
      empty: 'Nenhuma loja no catálogo.',
    },
  };

  let getStores = () => [];
  let activeKpi = null;
  let eventsAbort = null;

  const $ = (id) => document.getElementById(id);

  function escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function getScopeStores() {
    return getStores().filter((meta) => {
      if (!meta) return false;
      if (typeof isStoreCardSuspended === 'function' && isStoreCardSuspended(meta)) return false;
      return String(meta.lav60_status || '').toLowerCase() !== 'suspended';
    });
  }

  function storeDisplayName(entry) {
    const sid = normalizeStoreId(entry?.store || entry?.id);
    const name = entry?.name;
    if (name) return `${name} (${sid.toUpperCase()})`;
    return sid.toUpperCase();
  }

  function storePageHref(storeId) {
    const sid = encodeURIComponent(normalizeStoreId(storeId));
    if (document.getElementById('appView')) {
      return `index.html?store=${sid}#/store`;
    }
    return `store.html?store=${sid}`;
  }

  function isGet01AgentOnline(meta) {
    if (meta?.heartbeatAlive === true) return true;
    const sid = normalizeStoreId(meta?.id || meta?.store);
    return sid ? isStoreAliveInHeartbeats(sid) : false;
  }

  function buildGet01Lists() {
    const online = [];
    const offline = [];
    const agentsOff = isAgentsDisabled(null);

    getScopeStores().forEach((meta) => {
      const sid = normalizeStoreId(meta.id);
      if (!sid) return;
      const heartbeatAlive = isGet01AgentOnline(meta);
      const entry = {
        store: sid,
        name: meta.name,
        heartbeatAlive,
      };
      if (!agentsOff && heartbeatAlive) {
        online.push(entry);
      } else {
        offline.push(entry);
      }
    });

    const sort = (a, b) => a.store.localeCompare(b.store);
    online.sort(sort);
    offline.sort(sort);
    return { online, offline };
  }

  function offlineDetail(entry) {
    if (isAgentsDisabled(null)) return 'GET01 indisponível no painel';
    if (entry.heartbeatAlive) return 'Agente online';
    return 'Agente offline';
  }

  function renderOnlineEvents(items) {
    if (!items?.length) return '';
    return `<ul class="kpi-event-list kpi-event-list--stores">
      ${items
        .map(
          (entry) => `
        <li class="kpi-event-item">
          <a class="kpi-event-item__store" href="${storePageHref(entry.store)}">${escapeHtml(storeDisplayName(entry))}</a>
          <span class="kpi-event-item__sub">Online</span>
        </li>`
        )
        .join('')}
    </ul>`;
  }

  function renderOfflineEvents(items) {
    if (!items?.length) return '';
    return `<ul class="kpi-event-list kpi-event-list--stores">
      ${items
        .map(
          (entry) => `
        <li class="kpi-event-item kpi-event-item--alert">
          <a class="kpi-event-item__store" href="${storePageHref(entry.store)}">${escapeHtml(storeDisplayName(entry))}</a>
          <span class="kpi-event-item__sub">${escapeHtml(offlineDetail(entry))}</span>
        </li>`
        )
        .join('')}
    </ul>`;
  }

  function renderKpiModalContent(kpiKey) {
    const config = GET01_KPI_CONFIG[kpiKey];
    const lists = buildGet01Lists();
    if (!config) return;

    let html = '';
    let count = 0;
    if (kpiKey === 'get01-online') {
      count = lists.online.length;
      html = renderOnlineEvents(lists.online);
    } else if (kpiKey === 'get01-offline') {
      count = lists.offline.length;
      html = renderOfflineEvents(lists.offline);
    }

    const titleEl = $('agentKpiModalTitle');
    const subtitleEl = $('agentKpiModalSubtitle');
    const bodyEl = $('agentKpiModalBody');
    if (titleEl) titleEl.textContent = config.title;
    if (subtitleEl) {
      subtitleEl.textContent = count > 0 ? `${count} registro(s)` : config.empty;
    }
    if (bodyEl) {
      bodyEl.innerHTML = html || `<p class="kpi-events-panel__empty">${escapeHtml(config.empty)}</p>`;
    }
    window.Lav60KpiModalSearch?.syncAfterRender?.(count);
  }

  function updateShareBar(online, total) {
    const pct = total ? Math.round((online / total) * 100) : 0;

    const pctEl = $('get01SharePct');
    if (pctEl) pctEl.textContent = total ? `${pct}%` : '—';

    const fillEl = $('get01ShareFill');
    if (fillEl) {
      fillEl.style.width = `${total ? pct : 0}%`;
      fillEl.dataset.level = pct >= 90 ? 'ok' : pct >= 70 ? 'warn' : 'danger';
    }

    const trackEl = $('get01ShareTrack');
    if (trackEl) trackEl.setAttribute('aria-valuenow', String(total ? pct : 0));

    const metaEl = $('get01ShareMeta');
    if (metaEl) {
      metaEl.textContent = total
        ? `${online} de ${total} loja(s) com agente online`
        : 'Nenhuma loja no catálogo';
    }
  }

  function updateKpis() {
    const lists = buildGet01Lists();
    const onlineEl = $('kpiGet01Online');
    const offlineEl = $('kpiGet01Offline');
    if (onlineEl) onlineEl.textContent = String(lists.online.length);
    if (offlineEl) offlineEl.textContent = String(lists.offline.length);
    updateShareBar(lists.online.length, lists.online.length + lists.offline.length);
    const metaEl = $('get01OverviewMeta');
    if (metaEl) {
      metaEl.textContent = `${lists.offline.length} loja(s) offline · clique no card para o relatório`;
    }
    if (activeKpi) renderKpiModalContent(activeKpi);
  }

  function resetActiveCard() {
    document.querySelectorAll('#get01Kpis [data-kpi]').forEach((el) => {
      el.classList.remove('stat-card--active');
      el.setAttribute('aria-expanded', 'false');
    });
  }

  function setActiveCard(kpiKey) {
    document.querySelectorAll('#get01Kpis [data-kpi]').forEach((el) => {
      const active = el.dataset.kpi === kpiKey;
      el.classList.toggle('stat-card--active', active);
      el.setAttribute('aria-expanded', active ? 'true' : 'false');
    });
  }

  function openKpiModal(kpiKey) {
    if (!GET01_KPI_CONFIG[kpiKey] || !$('agentKpiModal')) return;
    activeKpi = kpiKey;
    window.Lav60KpiModalSearch?.reset?.();
    renderKpiModalContent(kpiKey);
    setActiveCard(kpiKey);
    $('agentKpiModal').classList.remove('hidden');
    document.body.classList.add('agent-kpi-modal-open');
  }

  function closeKpiModal() {
    activeKpi = null;
    resetActiveCard();
    $('agentKpiModal')?.classList.add('hidden');
    document.body.classList.remove('agent-kpi-modal-open');
    window.Lav60KpiModalSearch?.hide?.();
  }

  function bindEvents() {
    eventsAbort?.abort();
    eventsAbort = new AbortController();
    const { signal } = eventsAbort;
    const root = $('get01Overview');
    if (!root) return;

    root.addEventListener(
      'click',
      (e) => {
        const card = e.target.closest('[data-kpi]');
        if (!card || !card.closest('#get01Kpis')) return;
        openKpiModal(card.dataset.kpi);
      },
      { signal }
    );

    root.addEventListener(
      'keydown',
      (e) => {
        const card = e.target.closest('[data-kpi]');
        if (!card || !card.closest('#get01Kpis') || (e.key !== 'Enter' && e.key !== ' ')) return;
        e.preventDefault();
        openKpiModal(card.dataset.kpi);
      },
      { signal }
    );

    document.querySelectorAll('[data-agent-kpi-dismiss]').forEach((el) => {
      el.addEventListener('click', closeKpiModal, { signal });
    });

    document.addEventListener(
      'keydown',
      (e) => {
        if (e.key !== 'Escape') return;
        if ($('agentKpiModal')?.classList.contains('hidden')) return;
        if (!activeKpi || !GET01_KPI_CONFIG[activeKpi]) return;
        closeKpiModal();
      },
      { signal }
    );
  }

  function mount(options = {}) {
    getStores = typeof options.getStores === 'function' ? options.getStores : () => [];
    bindEvents();
    updateKpis();
  }

  function destroy() {
    activeKpi = null;
    eventsAbort?.abort();
    eventsAbort = null;
    closeKpiModal();
  }

  function getOnlineStoreMetas() {
    const onlineIds = new Set(
      buildGet01Lists()
        .online.map((entry) => normalizeStoreId(entry.store))
        .filter(Boolean)
    );
    return getScopeStores().filter((meta) => onlineIds.has(normalizeStoreId(meta.id)));
  }

  window.Lav60Get01Overview = {
    mount,
    destroy,
    render: updateKpis,
    closeKpiModal,
    getOnlineStoreMetas,
  };
})();
