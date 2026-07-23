(() => {
  'use strict';

  const ROUTES = {
    dashboard: {
      nav: 'dashboard',
      title: 'LAV60 — Dashboard',
      view: 'views/dashboard.html?v=21',
      pageClass: 'page-dashboard',
    },
    lojas: {
      nav: 'lojas',
      title: 'LAV60 — Lojas',
      view: 'views/lojas.html?v=4',
      pageClass: 'page-dashboard page-lojas',
    },
    registros: {
      nav: 'registros',
      title: 'LAV60 — Registros',
      view: 'views/records.html',
      pageClass: 'page-records',
    },
    'infra-vps': {
      nav: 'infra-vps',
      title: 'LAV60 — Infraestrutura · VPS',
      view: 'views/infra-vps.html?v=5',
      pageClass: 'page-records page-infra-metrics',
    },
    'infra-database': {
      nav: 'infra-database',
      title: 'LAV60 — Infraestrutura · Database',
      view: 'views/infra-database.html?v=9',
      pageClass: 'page-records page-infra-metrics',
    },
    suporte: {
      nav: 'suporte',
      title: 'LAV60 — Suporte / Runbooks',
      view: 'views/support.html?v=5',
      pageClass: 'page-records page-support',
    },
    'monitor-sites': {
      nav: 'monitor-sites',
      title: 'LAV60 — Monitoramento de sites',
      view: 'views/sites-monitor.html?v=2',
      pageClass: 'page-records page-sites-monitor',
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
    if (hash === 'infra/database' || hash === 'infra-database' || hash === 'infra/banco') {
      return 'infra-database';
    }
    if (
      hash === 'infra/vps'
      || hash === 'infra'
      || hash === 'infraestrutura'
      || hash === 'servidores'
      || hash === 'infra-vps'
    ) {
      return 'infra-vps';
    }
    if (
      hash === 'suporte'
      || hash === 'suporte/runbooks'
      || hash === 'runbooks'
      || hash === 'helpdesk'
    ) {
      return 'suporte';
    }
    if (
      hash === 'monitor-sites'
      || hash === 'monitoramento-sites'
      || hash === 'sites'
      || hash === 'monitor/sites'
    ) {
      return 'monitor-sites';
    }
    if (hash === 'dashboard' || hash === '') {
      const legacy = LEGACY_PATHS[window.location.pathname.split('/').pop() || ''];
      if (legacy && !window.location.hash) return legacy;
      return 'dashboard';
    }
    return 'dashboard';
  }

  function routeUrl(routeName) {
    if (routeName === 'dashboard') return 'index.html';
    if (routeName === 'infra-vps') return 'index.html#/infra/vps';
    if (routeName === 'infra-database') return 'index.html#/infra/database';
    if (routeName === 'suporte') return 'index.html#/suporte';
    if (routeName === 'monitor-sites') return 'index.html#/monitor-sites';
    return `index.html#/${routeName}`;
  }

  function updateSidebarActive(navId) {
    document.querySelectorAll('.sidebar__nav > .sidebar__link[data-route]').forEach((link) => {
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
    if (currentRoute === 'infra-vps' && window.Lav60InfraVpsPage?.destroy) {
      await window.Lav60InfraVpsPage.destroy();
      return;
    }
    if (currentRoute === 'infra-database' && window.Lav60InfraDatabasePage?.destroy) {
      await window.Lav60InfraDatabasePage.destroy();
      return;
    }
    if (currentRoute === 'suporte' && window.Lav60SupportPage?.destroy) {
      await window.Lav60SupportPage.destroy();
      return;
    }
    if (currentRoute === 'monitor-sites' && window.Lav60SitesMonitorPage?.destroy) {
      await window.Lav60SitesMonitorPage.destroy();
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
    if (routeName === 'infra-vps') {
      await window.Lav60InfraVpsPage?.init?.();
      return;
    }
    if (routeName === 'infra-database') {
      await window.Lav60InfraDatabasePage?.init?.();
      return;
    }
    if (routeName === 'suporte') {
      await window.Lav60SupportPage?.init?.();
      return;
    }
    if (routeName === 'monitor-sites') {
      await window.Lav60SitesMonitorPage?.init?.();
      return;
    }
    await window.Lav60StoresPage?.init?.(routeName);
  }

  function bindPageBackButtons(root = document) {
    root.querySelectorAll('[data-page-back]').forEach((btn) => {
      if (btn.dataset.pageBackBound === '1') return;
      btn.dataset.pageBackBound = '1';
      btn.addEventListener('click', () => {
        const target = btn.dataset.pageBack;
        if (target && ROUTES[target]) navigate(target);
      });
    });
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

      document.body.classList.remove(
        'page-dashboard',
        'page-records',
        'page-infra-metrics',
        'page-support',
        'page-sites-monitor'
      );
      String(route.pageClass || '')
        .split(/\s+/)
        .filter(Boolean)
        .forEach((cls) => document.body.classList.add(cls));
      document.title = route.title;
      updateSidebarActive(route.nav);
      window.Lav60PortalLayout?.setPageTitle?.(route.title);
      window.Lav60PortalLayout?.setFooter?.(routeName);
      window.Lav60PortalLayout?.closeMobileNav?.();

      const nextUrl = routeUrl(routeName);
      const state = { route: routeName };
      if (replace) history.replaceState(state, '', nextUrl);
      else history.pushState(state, '', nextUrl);

      currentRoute = routeName;
      bindPageBackButtons(appView);
      await initRouteModule(routeName);
    } catch (e) {
      appView.innerHTML = `<div class="stores-empty-state"><p>${String(e.message || e)}</p></div>`;
    } finally {
      appView.classList.remove('app-view--loading');
      navigating = false;
    }
  }

  function bindSidebarNav() {
    document.querySelectorAll('[data-route]').forEach((link) => {
      link.addEventListener('click', (event) => {
        const routeName = link.dataset.route;
        if (!ROUTES[routeName]) return;
        event.preventDefault();
        navigate(routeName);
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
      if (!link || !ROUTES[link.dataset.route]) return;
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
