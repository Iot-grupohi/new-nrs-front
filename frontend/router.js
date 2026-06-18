(() => {
  'use strict';

  const ROUTES = {
    dashboard: {
      nav: 'dashboard',
      title: 'LAV60 — Dashboard',
      view: 'views/dashboard.html?v=6',
      pageClass: 'page-dashboard',
    },
    lojas: {
      nav: 'lojas',
      title: 'LAV60 — Lojas',
      view: 'views/lojas.html',
      pageClass: 'page-dashboard',
    },
    registros: {
      nav: 'registros',
      title: 'LAV60 — Registros',
      view: 'views/records.html',
      pageClass: 'page-records',
    },
  };

  const LEGACY_PATHS = {
    'lojas.html': 'lojas',
    'records.html': 'registros',
    'index.html': 'dashboard',
  };

  let currentRoute = null;
  let navigating = false;
  const viewCache = new Map();

  function parseRoute() {
    const hash = window.location.hash.replace(/^#\/?/, '').trim().toLowerCase();
    if (hash === 'lojas') return 'lojas';
    if (hash === 'registros' || hash === 'records') return 'registros';
    if (hash === 'dashboard' || hash === '') {
      const legacy = LEGACY_PATHS[window.location.pathname.split('/').pop() || ''];
      if (legacy && !window.location.hash) return legacy;
      return 'dashboard';
    }
    return 'dashboard';
  }

  function routeUrl(routeName) {
    return routeName === 'dashboard' ? 'index.html' : `index.html#/${routeName}`;
  }

  function updateSidebarActive(navId) {
    document.querySelectorAll('[data-route]').forEach((link) => {
      const active = link.dataset.route === navId;
      link.classList.toggle('sidebar__link--active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
  }

  async function fetchView(url) {
    if (viewCache.has(url)) return viewCache.get(url);
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) throw new Error(`Não foi possível carregar ${url}`);
    const html = await res.text();
    viewCache.set(url, html);
    return html;
  }

  async function destroyCurrentModule() {
    if (currentRoute === 'registros' && window.Lav60RecordsPage?.destroy) {
      await window.Lav60RecordsPage.destroy();
      return;
    }
    if ((currentRoute === 'dashboard' || currentRoute === 'lojas') && window.Lav60StoresPage?.destroy) {
      await window.Lav60StoresPage.destroy();
    }
  }

  async function initRouteModule(routeName) {
    if (routeName === 'registros') {
      await window.Lav60RecordsPage?.init?.();
      return;
    }
    await window.Lav60StoresPage?.init?.(routeName);
  }

  async function navigate(routeName, { replace = false, force = false } = {}) {
    const route = ROUTES[routeName];
    if (!route || navigating) return;
    if (!force && routeName === currentRoute) return;

    navigating = true;
    const appView = document.getElementById('appView');
    if (!appView) {
      navigating = false;
      return;
    }

    try {
      appView.classList.add('app-view--loading');

      if (currentRoute) {
        await destroyCurrentModule();
      }

      const html = await fetchView(route.view);
      appView.innerHTML = html;

      document.body.classList.remove('page-dashboard', 'page-records');
      document.body.classList.add(route.pageClass);
      document.title = route.title;
      updateSidebarActive(route.nav);

      const nextUrl = routeUrl(routeName);
      const state = { route: routeName };
      if (replace) history.replaceState(state, '', nextUrl);
      else history.pushState(state, '', nextUrl);

      currentRoute = routeName;
      await initRouteModule(routeName);
    } catch (e) {
      appView.innerHTML = `<div class="stores-empty-state"><p>${String(e.message || e)}</p></div>`;
      console.error('[LAV60 router]', e);
    } finally {
      appView.classList.remove('app-view--loading');
      navigating = false;
    }
  }

  function bindSidebarNav() {
    document.querySelectorAll('[data-route]').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        navigate(link.dataset.route);
      });
    });
  }

  function redirectLegacyEntry() {
    const page = window.location.pathname.split('/').pop() || '';
    const legacyRoute = LEGACY_PATHS[page];
    if (!legacyRoute || page === 'index.html') return false;
    const target = routeUrl(legacyRoute);
    history.replaceState({ route: legacyRoute }, '', target);
    return legacyRoute;
  }

  async function boot() {
    if (window.Lav60Auth) {
      const ok = await Lav60Auth.guardPage();
      if (!ok) return;
    }

    document.body.classList.remove('auth-pending');

    if (window.Lav60Auth) {
      await Lav60Auth.mountSidebarUser(document.getElementById('sidebarUser'));
    }

    bindSidebarNav();

    const appView = document.getElementById('appView');
    appView?.addEventListener('click', (event) => {
      const link = event.target.closest('a[data-route]');
      if (!link) return;
      event.preventDefault();
      navigate(link.dataset.route);
    });

    window.addEventListener('popstate', () => {
      navigate(parseRoute(), { replace: true, force: true });
    });

    const legacyRoute = redirectLegacyEntry();
    await navigate(legacyRoute || parseRoute(), { replace: true, force: true });
  }

  window.Lav60Router = { navigate, parseRoute, boot };

  boot();
})();
