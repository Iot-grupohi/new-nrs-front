(() => {
  'use strict';

  function escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function normalizeStoreId(value) {
    return String(value || '').trim().toLowerCase();
  }

  function storeDisplayName(meta) {
    const sid = normalizeStoreId(meta?.id || meta?.store);
    const name = String(meta?.name || '').trim();
    if (!name) return sid.toUpperCase();
    if (normalizeStoreId(name) === sid) return sid.toUpperCase();
    return `${name} (${sid.toUpperCase()})`;
  }

  function normalizeQuery(value) {
    return String(value || '').trim().toLowerCase();
  }

  function mountHubList(options = {}) {
    const {
      listEl,
      searchEl,
      metaEl,
      countEl,
      getItems,
      getHref,
      getSubtext,
      onSelect,
      emptyText = 'Nenhuma loja online no momento.',
      disabled = false,
    } = options;

    function applySearchFilter() {
      if (!searchEl || !listEl) return;
      const q = normalizeQuery(searchEl.value);
      listEl.querySelectorAll('.agent-hub-store-list__row[data-search]').forEach((row) => {
        const blob = row.dataset.search || '';
        row.classList.toggle('agent-hub-store-list__row--hidden', Boolean(q && !blob.includes(q)));
      });
    }

    function renderItems(items) {
      const list = [...(Array.isArray(items) ? items : [])].sort((a, b) =>
        String(a.id || a.store || '').localeCompare(String(b.id || b.store || ''))
      );
      if (countEl) countEl.textContent = String(list.length);
      if (metaEl) {
        if (disabled) {
          metaEl.textContent = 'Canal indisponível neste painel';
        } else if (!list.length) {
          metaEl.textContent = 'Aguardando atualização do painel…';
        } else if (list.length === 1) {
          metaEl.textContent = '1 loja disponível · clique para abrir o console';
        } else {
          metaEl.textContent = `${list.length} lojas disponíveis · clique para abrir o console`;
        }
      }
      if (!listEl) return;

      const toolbar = searchEl?.closest('.agent-hub__toolbar');
      if (disabled || !list.length) {
        toolbar?.classList.add('hidden');
        listEl.innerHTML = `<p class="agent-hub__empty">${escapeHtml(disabled ? 'Canal indisponível neste painel.' : emptyText)}</p>`;
        return;
      }

      toolbar?.classList.remove('hidden');
      listEl.innerHTML = `<ul class="agent-hub-store-list" role="list">
        ${list
          .map((item) => {
            const sid = normalizeStoreId(item.id || item.store);
            if (!sid) return '';
            const display = storeDisplayName(item);
            const sub = typeof getSubtext === 'function' ? getSubtext(item) : 'Online';
            const searchBlob = `${sid} ${item.name || ''}`.toLowerCase();
            const inner = `
              <span class="agent-hub-store-list__name">${escapeHtml(display)}</span>
              <span class="agent-hub-store-list__sub">${escapeHtml(sub)}</span>
              <span class="agent-hub-store-list__action" aria-hidden="true">›</span>`;

            if (typeof onSelect === 'function') {
              return `<li class="agent-hub-store-list__row" role="listitem" data-search="${escapeHtml(searchBlob)}">
                <button type="button" class="agent-hub-store-list__item" data-store="${escapeHtml(sid)}">${inner}</button>
              </li>`;
            }

            const href = typeof getHref === 'function' ? getHref(sid, item) : '#';
            return `<li class="agent-hub-store-list__row" role="listitem" data-search="${escapeHtml(searchBlob)}">
              <a class="agent-hub-store-list__item" href="${escapeHtml(href)}">${inner}</a>
            </li>`;
          })
          .join('')}
      </ul>`;

      if (typeof onSelect === 'function') {
        listEl.querySelectorAll('[data-store]').forEach((btn) => {
          btn.addEventListener('click', () => onSelect(btn.dataset.store));
        });
      }

      applySearchFilter();
    }

    function refresh() {
      const items = typeof getItems === 'function' ? getItems() : [];
      renderItems(items);
    }

    if (searchEl && !searchEl.dataset.bound) {
      searchEl.dataset.bound = '1';
      searchEl.addEventListener('input', applySearchFilter);
    }

    refresh();

    return { refresh, renderItems };
  }

  window.Lav60AgentHubStores = {
    mountHubList,
    storeDisplayName,
  };
})();
