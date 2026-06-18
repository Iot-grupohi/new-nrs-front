(() => {
  'use strict';

  const NAV_ITEMS = [
    { id: 'dashboard', href: 'index.html', label: 'Dashboard', icon: '▣' },
    { id: 'lojas', href: 'lojas.html', label: 'Lojas', icon: '◫' },
    { id: 'registros', href: 'records.html', label: 'Registros', icon: '☰' },
  ];

  function escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function buildSidebar(activeNav) {
    const aside = document.createElement('aside');
    aside.className = 'sidebar';
    aside.setAttribute('aria-label', 'Menu principal');

    const navLinks = NAV_ITEMS.map((item) => {
      const active = item.id === activeNav;
      return `
        <a
          href="${escapeHtml(item.href)}"
          class="sidebar__link${active ? ' sidebar__link--active' : ''}"
          ${active ? 'aria-current="page"' : ''}
        >
          <span class="sidebar__icon" aria-hidden="true">${item.icon}</span>
          <span class="sidebar__label">${escapeHtml(item.label)}</span>
        </a>`;
    }).join('');

    aside.innerHTML = `
      <div class="sidebar__brand">
        <span class="sidebar__logo" aria-hidden="true">L60</span>
        <div class="sidebar__identity">
          <strong class="sidebar__title">LAV60</strong>
          <span class="sidebar__eyebrow">Painel central</span>
        </div>
      </div>
      <nav class="sidebar__nav" aria-label="Navegação">
        ${navLinks}
      </nav>
      <div class="sidebar__footer" id="sidebarUser"></div>`;

    return aside;
  }

  function initPanelLayout() {
    const layout = document.querySelector('.app-layout');
    if (!layout || layout.dataset.sidebarReady === '1') return;

    const activeNav = layout.dataset.nav || '';
    layout.insertBefore(buildSidebar(activeNav), layout.firstChild);
    layout.dataset.sidebarReady = '1';
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initPanelLayout);
  } else {
    initPanelLayout();
  }

  window.Lav60Sidebar = { initPanelLayout };
})();
