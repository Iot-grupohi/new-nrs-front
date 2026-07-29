(() => {
  'use strict';

  const STATUS_STYLES = {
    online: { color: '#22c55e', label: 'Online' },
    offline: { color: '#f97316', label: 'Offline' },
    partial: { color: '#eab308', label: 'Parcial' },
    suspended: { color: '#64748b', label: 'Suspensa' },
    unknown: { color: '#94a3b8', label: 'Carregando' },
  };

  let map = null;
  let clusterGroup = null;
  let locationsById = new Map();
  let activeFilter = 'all';
  let helpers = {};
  let panelFetchFn = null;
  let loaded = false;

  const $ = (id) => document.getElementById(id);

  function escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function storeStatus(store) {
    if (!store) return 'unknown';
    if (typeof helpers.resolveStoreDisplayState === 'function') {
      const state = helpers.resolveStoreDisplayState(store);
      if (state === 'suspended') return 'suspended';
      if (state === 'partial') return 'partial';
      if (state === 'ok') return 'online';
      if (state === 'offline' || state === 'unreachable') return 'offline';
      return 'unknown';
    }
    return 'unknown';
  }

  function fixLeafletRef() {
    return window.L;
  }

  function markerIconSafe(status) {
    const L = fixLeafletRef();
    const style = STATUS_STYLES[status] || STATUS_STYLES.unknown;
    return L.divIcon({
      className: 'dashboard-store-map__marker',
      html: `<span style="background:${style.color}"></span>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7],
    });
  }

  function updateMeta(stores) {
    const meta = $('dashboardStoreMapMeta');
    if (!meta) return;
    const counts = { online: 0, offline: 0, partial: 0, suspended: 0, unknown: 0 };
    stores.forEach((store) => {
      counts[storeStatus(store)] += 1;
    });
    meta.textContent = `${counts.online} online · ${counts.offline} offline · ${counts.partial} parciais · ${counts.suspended} suspensas`;
  }

  function renderMarkers(stores) {
    const L = fixLeafletRef();
    if (!map || !clusterGroup || !L) return;

    clusterGroup.clearLayers();
    const list = Array.isArray(stores) ? stores : [];
    updateMeta(list);

    list.forEach((store) => {
      const sid = String(store.id || '').toLowerCase();
      const loc = locationsById.get(sid);
      if (!loc) return;

      const status = storeStatus(store);
      if (activeFilter !== 'all' && status !== activeFilter) return;

      const style = STATUS_STYLES[status] || STATUS_STYLES.unknown;
      const href = typeof helpers.storePageHref === 'function'
        ? helpers.storePageHref(sid)
        : `store.html?store=${encodeURIComponent(sid)}`;
      const cityLine = [loc.city, loc.state].filter(Boolean).join(' · ');
      const summary = store.summary || {};
      const devicesLine = summary.total
        ? `${summary.online ?? 0}/${summary.total} equipamentos online`
        : 'Equipamentos indisponíveis';

      const marker = L.marker([loc.lat, loc.lng], { icon: markerIconSafe(status) });
      marker.bindPopup(`
        <div class="dashboard-store-map__popup">
          <strong>${escapeHtml(store.name || sid.toUpperCase())}</strong>
          <span class="dashboard-store-map__popup-status" style="color:${style.color}">${escapeHtml(style.label)}</span>
          ${cityLine ? `<span>${escapeHtml(cityLine)}</span>` : ''}
          <span>${escapeHtml(devicesLine)}</span>
          <a href="${escapeHtml(href)}">Abrir loja →</a>
        </div>
      `);
      clusterGroup.addLayer(marker);
    });
  }

  function setFilter(filter) {
    activeFilter = filter || 'all';
    document.querySelectorAll('[data-dashboard-map-filter]').forEach((btn) => {
      btn.classList.toggle('chip--active', btn.dataset.dashboardMapFilter === activeFilter);
    });
    renderMarkers(helpers.getStores?.() || []);
  }

  function ensureMap() {
    const root = $('dashboardStoreMapCanvas');
    const L = fixLeafletRef();
    if (!root || !L || map) return;

    map = L.map(root, {
      scrollWheelZoom: false,
      zoomControl: true,
    }).setView([-14.235, -51.9253], 4);

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap',
      maxZoom: 18,
    }).addTo(map);

    clusterGroup = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 42,
    });
    map.addLayer(clusterGroup);
  }

  async function loadLocations() {
    if (!panelFetchFn || loaded) return;
    const meta = $('dashboardStoreMapMeta');
    try {
      const res = await panelFetchFn('/api/stores/map-locations');
      if (!res.ok) throw new Error('Mapa indisponível');
      const data = await res.json();
      locationsById = new Map(
        (data.stores || []).map((row) => [String(row.id || '').toLowerCase(), row])
      );
      loaded = true;
      if (meta && !data.details_cached) {
        meta.textContent = `${data.count || 0} lojas · refinando localização em segundo plano…`;
      }
    } catch (err) {
      if (meta) meta.textContent = err.message || 'Não foi possível carregar o mapa.';
    }
  }

  function bindEvents(signal) {
    document.querySelectorAll('[data-dashboard-map-filter]').forEach((btn) => {
      btn.addEventListener('click', () => setFilter(btn.dataset.dashboardMapFilter), { signal });
    });
  }

  async function init(options = {}) {
    if (!$('dashboardStoreMap')) return;
    panelFetchFn = options.panelFetch || null;
    helpers = {
      resolveStoreDisplayState: options.resolveStoreDisplayState,
      getStores: options.getStores,
      storePageHref: options.storePageHref,
    };
    activeFilter = 'all';
    bindEvents(options.signal || { aborted: false });
    ensureMap();
    await loadLocations();
    renderMarkers(options.getStores?.() || []);
    setTimeout(() => map?.invalidateSize(), 120);
  }

  function update(stores) {
    if (!$('dashboardStoreMap')) return;
    ensureMap();
    renderMarkers(stores || helpers.getStores?.() || []);
  }

  function destroy() {
    if (map) {
      map.remove();
      map = null;
    }
    clusterGroup = null;
    locationsById = new Map();
    loaded = false;
    activeFilter = 'all';
    helpers = {};
    panelFetchFn = null;
  }

  window.Lav60DashboardStoreMap = { init, update, destroy, setFilter };
})();
