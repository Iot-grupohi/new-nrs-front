(() => {
  'use strict';

  const btnMenu = document.getElementById('btnPortalMenu');
  const backdrop = document.getElementById('portalBackdrop');
  const topbarTitle = document.getElementById('portalTopbarTitle');
  const footerLabel = document.getElementById('portalFooterLabel');

  const FOOTER_LABELS = {
    dashboard: 'LAV60 · Painel operacional',
    lojas: 'LAV60 · Monitoramento de lojas',
    registros: 'LAV60 · Registros de auditoria',
    suporte: 'LAV60 · Suporte operacional',
    'infra-vps': 'LAV60 · Infraestrutura · VPS',
    'infra-database': 'LAV60 · Infraestrutura · Database',
    'monitor-sites': 'LAV60 · Monitoramento de sites',
  };

  function closeMobileNav() {
    document.body.classList.remove('portal-nav-open');
  }

  function toggleMobileNav() {
    document.body.classList.toggle('portal-nav-open');
  }

  btnMenu?.addEventListener('click', toggleMobileNav);
  backdrop?.addEventListener('click', closeMobileNav);

  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMobileNav();
  });

  function setPageTitle(fullTitle) {
    const short = String(fullTitle || '')
      .replace(/^LAV60\s*[—–-]\s*/i, '')
      .trim();
    if (topbarTitle) topbarTitle.textContent = short || 'Painel';
  }

  function setFooter(routeName) {
    if (footerLabel) {
      footerLabel.textContent = FOOTER_LABELS[routeName] || FOOTER_LABELS.dashboard;
    }
    const sitesUpdated = document.getElementById('sitesMonitorUpdatedAt');
    if (sitesUpdated) {
      sitesUpdated.classList.toggle('hidden', routeName !== 'monitor-sites');
      if (routeName !== 'monitor-sites') sitesUpdated.textContent = '';
    }
    const recordsTotal = document.getElementById('recordsAppFooterTotal');
    if (recordsTotal && routeName !== 'registros') {
      recordsTotal.textContent = '';
    }
  }

  window.Lav60PortalLayout = {
    setPageTitle,
    setFooter,
    closeMobileNav,
  };
})();
