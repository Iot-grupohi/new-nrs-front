(() => {
  'use strict';

  // No SPA (index.html): usa hash routing. Standalone: link direto para o arquivo HTML.
  const isSPA = !!document.getElementById('appView');

  const AGENT_PAGES = {
    get01: {
      id: 'get01',
      href: isSPA ? 'index.html#/agent-get01' : 'agent-get01.html',
      label: 'GET01',
      tag: 'Cloudflare',
      title: 'GET01 — Cloudflare',
    },
    get02: {
      id: 'get02',
      href: isSPA ? 'index.html#/agent-get02' : 'gateway.html',
      label: 'GET02',
      tag: 'MQTT',
      title: 'GET02 — MQTT',
    },
  };

  function renderAgentNav(activeId) {
    const mount = document.getElementById('agentNavMount');
    if (!mount) return;

    const nav = document.createElement('nav');
    nav.className = 'agent-nav';
    nav.setAttribute('aria-label', 'Agentes de operação');

    Object.values(AGENT_PAGES).forEach((page) => {
      const href = page.href;
      const link = document.createElement('a');
      link.href = href;
      link.className = 'agent-nav__link';
      if (page.id === activeId) {
        link.classList.add('agent-nav__link--active');
        link.setAttribute('aria-current', 'page');
      }
      link.innerHTML = `<span class="agent-nav__code">${page.label}</span><span class="agent-nav__tag">${page.tag}</span>`;
      nav.appendChild(link);
    });

    mount.replaceChildren(nav);
  }

  window.Lav60AgentNav = {
    render: renderAgentNav,
    pages: AGENT_PAGES,
  };
})();
