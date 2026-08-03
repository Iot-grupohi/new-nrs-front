(() => {
  'use strict';

  // A coluna lateral dos consoles usa position:sticky e precisa saber a altura
  // real da topbar. No SPA usa o portal-topbar (mobile). Nas páginas standalone
  // usa o .topbar do agente.
  function trackTopbarOffset() {
    const isSPA = !!document.getElementById('appView');
    const topbar = isSPA
      ? document.getElementById('portalTopbar')
      : document.querySelector('.page-agent-console .topbar');

    const apply = () => {
      if (isSPA) {
        // No SPA, desktop não tem topbar visível; mobile tem portal-topbar.
        const portalTopbar = document.getElementById('portalTopbar');
        const visible = portalTopbar && getComputedStyle(portalTopbar).display !== 'none';
        const height = visible ? Math.round(portalTopbar.getBoundingClientRect().height) : 0;
        document.documentElement.style.setProperty('--topbar-offset', `${height}px`);
        return;
      }
      if (!topbar) return;
      const height = Math.round(topbar.getBoundingClientRect().height);
      if (height > 0) {
        document.documentElement.style.setProperty('--topbar-offset', `${height}px`);
      }
    };

    apply();

    const observeTarget = topbar || document.getElementById('portalTopbar');
    if (observeTarget && typeof ResizeObserver === 'function') {
      new ResizeObserver(apply).observe(observeTarget);
    } else {
      window.addEventListener('resize', apply, { passive: true });
    }
  }

  function init() {
    if (!document.body.classList.contains('page-agent-console')) return;
    trackTopbarOffset();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // Exposto para o router chamar após injetar a view de agente no SPA.
  window.Lav60AgentConsole = { reinit: init };
})();
