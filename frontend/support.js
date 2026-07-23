(() => {
  'use strict';

  const catalog = () => window.Lav60SupportCatalog;
  let pageAbort = null;
  let activeFilter = 'all';
  let activeCategoryId = null;
  let searchQuery = '';
  let canEditKnowledge = false;
  let persistenceInfo = null;
  let editorMode = 'create';
  let openProcedureRef = null;
  let editingCategoryId = null;

  function panelFetch(url, options = {}) {
    const fetcher = window.Lav60Auth?.panelFetch || ((target, opts) => fetch(target, { ...opts, credentials: 'same-origin' }));
    return fetcher(url, {
      ...options,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
  }

  function showToast(message, ok = true) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = message;
    el.className = `toast ${ok ? 'toast--ok' : 'toast--err'}`;
    el.classList.remove('hidden');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => el.classList.add('hidden'), 4500);
  }

  function updateEditControls() {
    $('supportAddBtn')?.classList.toggle('hidden', !canEditKnowledge);
  }

  function updatePersistenceMeta() {
    const meta = $('supportMeta');
    if (!meta || activeCategoryId) return;
    const cats = filteredCategories();
    const procCount = cats.reduce((sum, cat) => sum + (cat.procedures?.length || 0), 0);
    const base = `${cats.length} categorias · ${procCount} procedimentos`;
    if (persistenceInfo?.firestore) {
      meta.textContent = `${base} · Firebase`;
      return;
    }
    if (persistenceInfo && persistenceInfo.firestore === false) {
      meta.textContent = `${base} · apenas local`;
      return;
    }
    meta.textContent = base;
  }

  async function reloadCatalog() {
    const loaded = await catalog()?.loadCustomEntries?.();
    canEditKnowledge = Boolean(loaded?.canEdit);
    persistenceInfo = loaded?.persistence || null;
    updateEditControls();
    updatePersistenceMeta();
    if (activeCategoryId) renderCategory(activeCategoryId);
    else renderHub();
  }

  function populateEditorCategories(selectedId = '') {
    const select = $('supportEditorCategory');
    if (!select) return;
    const cats = catalog()?.CATEGORIES || [];
    const options = cats.map((cat) => (
      `<option value="${escapeHtml(cat.id)}"${cat.id === selectedId ? ' selected' : ''}>${escapeHtml(cat.title)}</option>`
    ));
    options.push('<option value="__new__">+ Nova categoria…</option>');
    select.innerHTML = options.join('');
    toggleNewCategoryFields(select.value === '__new__');
  }

  function toggleNewCategoryFields(showNew) {
    $('supportEditorNewCategoryWrap')?.classList.toggle('hidden', !showNew);
    $('supportEditorNewCategoryGroupWrap')?.classList.toggle('hidden', !showNew);
    const newTitle = $('supportEditorNewCategoryTitle');
    if (newTitle) newTitle.required = showNew;
  }

  function openEditor({ mode = 'create', categoryId = '', procedureId = '' } = {}) {
    if (!canEditKnowledge) return;
    editorMode = mode;
    populateEditorCategories(categoryId || activeCategoryId || '');

    const titleEl = $('supportEditorTitle');
    const eyebrowEl = $('supportEditorEyebrow');
    const submitBtn = $('supportEditorSubmit');
    const titleInput = $('supportEditorTitleInput');
    const keywordsInput = $('supportEditorKeywords');
    const bodyInput = $('supportEditorBody');
    const categorySelect = $('supportEditorCategory');

    if (mode === 'edit' && categoryId && procedureId) {
      const found = catalog()?.findProcedure(categoryId, procedureId);
      if (!titleEl || !found) return;
      if (titleEl) titleEl.textContent = 'Editar procedimento';
      if (eyebrowEl) eyebrowEl.textContent = found.categoryTitle || 'Procedimento customizado';
      if (submitBtn) submitBtn.textContent = 'Salvar alterações';
      if (titleInput) titleInput.value = found.title || '';
      if (keywordsInput) keywordsInput.value = (found.keywords || []).join(', ');
      if (bodyInput) bodyInput.value = found.body || '';
      if (categorySelect) {
        categorySelect.value = categoryId;
        categorySelect.disabled = true;
      }
      toggleNewCategoryFields(false);
      editorMode = 'edit';
      openProcedureRef = { categoryId, procedureId };
    } else {
      if (titleEl) titleEl.textContent = 'Adicionar procedimento';
      if (eyebrowEl) eyebrowEl.textContent = 'Novo procedimento';
      if (submitBtn) submitBtn.textContent = 'Salvar procedimento';
      if (titleInput) titleInput.value = '';
      if (keywordsInput) keywordsInput.value = '';
      if (bodyInput) bodyInput.value = '';
      if (categorySelect) {
        categorySelect.disabled = false;
        if (categoryId) categorySelect.value = categoryId;
        else if (activeCategoryId) categorySelect.value = activeCategoryId;
      }
      toggleNewCategoryFields(categorySelect?.value === '__new__');
      openProcedureRef = null;
    }

    $('supportEditorModal')?.classList.remove('hidden');
    document.body.classList.add('support-modal-open');
    titleInput?.focus();
  }

  function closeEditor() {
    $('supportEditorModal')?.classList.add('hidden');
    $('supportEditorForm')?.reset();
    const categorySelect = $('supportEditorCategory');
    if (categorySelect) categorySelect.disabled = false;
    toggleNewCategoryFields(false);
    if (
      $('supportModal')?.classList.contains('hidden')
      && $('supportMapModal')?.classList.contains('hidden')
      && $('supportCategoryModal')?.classList.contains('hidden')
    ) {
      document.body.classList.remove('support-modal-open');
    }
  }

  function openCategoryEditor(categoryId) {
    if (!canEditKnowledge || !catalog()?.isCustomCategory?.(categoryId)) return;
    const cat = categoryById(categoryId);
    if (!cat) return;

    editingCategoryId = categoryId;
    $('supportCategoryTitleInput').value = cat.title || '';
    $('supportCategorySummary').value = cat.summary || '';
    $('supportCategoryGroup').value = cat.group || 'helpdesk';
    $('supportCategoryIcon').value = cat.icon || '';
    $('supportCategoryModal')?.classList.remove('hidden');
    document.body.classList.add('support-modal-open');
    $('supportCategoryTitleInput')?.focus();
  }

  function closeCategoryEditor() {
    $('supportCategoryModal')?.classList.add('hidden');
    $('supportCategoryForm')?.reset();
    editingCategoryId = null;
    if (
      $('supportModal')?.classList.contains('hidden')
      && $('supportEditorModal')?.classList.contains('hidden')
      && $('supportMapModal')?.classList.contains('hidden')
    ) {
      document.body.classList.remove('support-modal-open');
    }
  }

  async function submitCategoryEditor(event) {
    event.preventDefault();
    if (!canEditKnowledge || !editingCategoryId) return;

    const title = $('supportCategoryTitleInput')?.value?.trim() || '';
    const summary = $('supportCategorySummary')?.value?.trim() || '';
    const group = $('supportCategoryGroup')?.value || 'helpdesk';
    const icon = $('supportCategoryIcon')?.value?.trim() || '';
    const submitBtn = $('supportCategorySubmit');

    if (!title) {
      showToast('Informe o título da categoria.', false);
      return;
    }

    if (submitBtn) submitBtn.disabled = true;
    try {
      const res = await panelFetch(`/api/support/categories/${encodeURIComponent(editingCategoryId)}`, {
        method: 'PUT',
        body: JSON.stringify({ title, summary, group, icon }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || 'Não foi possível salvar a categoria.');
      closeCategoryEditor();
      await reloadCatalog();
      showToast('Categoria atualizada.');
    } catch (error) {
      showToast(error.message || 'Erro ao salvar categoria.', false);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  async function deleteCategory() {
    if (!canEditKnowledge || !editingCategoryId) return;
    const cat = categoryById(editingCategoryId);
    const label = cat?.title || 'esta categoria';
    if (!window.confirm(`Excluir "${label}" e todos os procedimentos customizados dela?`)) return;

    try {
      const res = await panelFetch(`/api/support/categories/${encodeURIComponent(editingCategoryId)}`, {
        method: 'DELETE',
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || 'Não foi possível excluir.');
      closeCategoryEditor();
      activeCategoryId = null;
      await reloadCatalog();
      showToast('Categoria excluída.');
    } catch (error) {
      showToast(error.message || 'Erro ao excluir categoria.', false);
    }
  }

  async function submitEditor(event) {
    event.preventDefault();
    if (!canEditKnowledge) return;

    const categorySelect = $('supportEditorCategory');
    const categoryValue = categorySelect?.value || '';
    const title = $('supportEditorTitleInput')?.value?.trim() || '';
    const keywords = $('supportEditorKeywords')?.value?.trim() || '';
    const body = $('supportEditorBody')?.value?.trim() || '';
    const submitBtn = $('supportEditorSubmit');

    if (!title || !body) {
      showToast('Preencha título e conteúdo.', false);
      return;
    }

    if (submitBtn) submitBtn.disabled = true;
    try {
      if (editorMode === 'edit' && openProcedureRef) {
        const res = await panelFetch(
          `/api/support/procedures/${encodeURIComponent(openProcedureRef.categoryId)}/${encodeURIComponent(openProcedureRef.procedureId)}`,
          {
            method: 'PUT',
            body: JSON.stringify({ title, keywords, body }),
          },
        );
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || 'Não foi possível salvar.');
        closeEditor();
        closeProcedureModal();
        await reloadCatalog();
        showToast('Procedimento atualizado.');
        return;
      }

      if (categoryValue === '__new__') {
        const newTitle = $('supportEditorNewCategoryTitle')?.value?.trim() || '';
        const group = $('supportEditorNewCategoryGroup')?.value || 'helpdesk';
        if (!newTitle) {
          showToast('Informe o nome da nova categoria.', false);
          return;
        }
        const res = await panelFetch('/api/support/categories', {
          method: 'POST',
          body: JSON.stringify({
            title: newTitle,
            group,
            summary: `Procedimentos sobre ${newTitle}`,
            procedure: { title, keywords, body },
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || 'Não foi possível criar a categoria.');
      } else {
        const res = await panelFetch('/api/support/procedures', {
          method: 'POST',
          body: JSON.stringify({
            category_id: categoryValue,
            title,
            keywords,
            body,
          }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.detail || 'Não foi possível salvar.');
      }

      closeEditor();
      await reloadCatalog();
      showToast('Procedimento adicionado à base.');
    } catch (error) {
      showToast(error.message || 'Erro ao salvar procedimento.', false);
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  }

  async function deleteOpenProcedure() {
    if (!openProcedureRef || !canEditKnowledge) return;
    const found = catalog()?.findProcedure(openProcedureRef.categoryId, openProcedureRef.procedureId);
    const label = found?.title || 'este procedimento';
    if (!window.confirm(`Excluir "${label}" da base de conhecimento?`)) return;

    try {
      const res = await panelFetch(
        `/api/support/procedures/${encodeURIComponent(openProcedureRef.categoryId)}/${encodeURIComponent(openProcedureRef.procedureId)}`,
        { method: 'DELETE' },
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || 'Não foi possível excluir.');
      closeProcedureModal();
      await reloadCatalog();
      showToast('Procedimento excluído.');
    } catch (error) {
      showToast(error.message || 'Erro ao excluir procedimento.', false);
    }
  }

  function viewState() {
    if (activeCategoryId) return 'category';
    if (searchQuery.trim()) return 'search';
    return 'hub';
  }

  function updateHeader() {
    const header = $('supportHeader');
    const backLabel = $('supportHeaderBackLabel');
    const eyebrow = $('supportHeaderEyebrow');
    const title = $('supportHeaderTitle');
    const subtitle = $('supportHeaderSubtitle');
    const stats = $('supportHeaderStats');
    const iconWrap = $('supportHeaderIconWrap');
    const icon = $('supportHeaderIcon');
    const quickActions = $('supportQuickActions');
    const state = viewState();

    header?.classList.remove('support-header--category', 'support-header--search');
    quickActions?.classList.toggle('hidden', state !== 'hub');

    if (state === 'hub') {
      if (backLabel) backLabel.textContent = 'Painel LAV60';
      if (eyebrow) eyebrow.textContent = 'Central operacional';
      if (title) title.textContent = 'Suporte / Runbooks';
      if (subtitle) subtitle.textContent = 'Procedimentos operacionais e atendimento ao cliente';
      if (icon) {
        icon.src = '/fac/img/Icons/Helpdesk.svg';
        icon.alt = '';
      }
      iconWrap?.style.removeProperty('--support-accent');
      const cats = filteredCategories();
      const procCount = cats.reduce((sum, cat) => sum + (cat.procedures?.length || 0), 0);
      if (stats) stats.textContent = `${cats.length} categorias · ${procCount} procedimentos`;
      return;
    }

    if (state === 'search') {
      header?.classList.add('support-header--search');
      const hits = catalog()?.search(searchQuery.trim()) || [];
      if (backLabel) backLabel.textContent = 'Base de conhecimento';
      if (eyebrow) eyebrow.textContent = 'Resultados da busca';
      if (title) title.textContent = `“${searchQuery.trim()}”`;
      if (subtitle) subtitle.textContent = hits.length
        ? `${hits.length} procedimento(s) encontrado(s)`
        : 'Nenhum procedimento encontrado';
      if (icon) {
        icon.src = '/fac/img/Icons/Helpdesk.svg';
        icon.alt = '';
      }
      iconWrap?.style.setProperty('--support-accent', '#3b82f6');
      if (stats) stats.textContent = `${hits.length} resultado(s)`;
      return;
    }

    const cat = categoryById(activeCategoryId);
    if (!cat) return;

    const theme = categoryTheme(cat);
    header?.classList.add('support-header--category');
    header?.style.setProperty('--support-accent', theme.accent);
    iconWrap?.style.setProperty('--support-accent', theme.accent);

    if (backLabel) backLabel.textContent = 'Base de conhecimento';
    if (eyebrow) eyebrow.textContent = theme.label;
    if (title) title.textContent = cat.title;
    if (subtitle) subtitle.textContent = cat.summary || 'Procedimentos desta categoria';
    if (icon) {
      icon.src = normalizeIconSrc(cat.icon);
      icon.alt = cat.title;
    }
    if (stats) stats.textContent = `${cat.procedures?.length || 0} procedimento(s)`;
  }

  function goBack() {
    if (!$('supportEditorModal')?.classList.contains('hidden')) {
      closeEditor();
      return;
    }
    if (!$('supportModal')?.classList.contains('hidden')) {
      closeProcedureModal();
      return;
    }
    if (!$('supportMapModal')?.classList.contains('hidden')) {
      closeMapModal();
      return;
    }
    if (!$('supportCategoryModal')?.classList.contains('hidden')) {
      closeCategoryEditor();
      return;
    }

    const state = viewState();
    if (state === 'hub') {
      window.Lav60Router?.navigate('dashboard');
      return;
    }
    if (state === 'search') {
      searchQuery = '';
      const input = $('supportSearch');
      if (input) input.value = '';
    }
    renderHub();
  }

  function $(id) {
    return document.getElementById(id);
  }

  function escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function normalizeIconSrc(icon) {
    const value = String(icon || '').trim();
    if (!value) return '/fac/img/Icons/Helpdesk.svg';
    if (/^\/fac\/img\/Icons\/.+\.png$/i.test(value)) {
      return value.replace(/\.png$/i, '.svg');
    }
    return value;
  }

  function filteredCategories() {
    const cats = catalog()?.CATEGORIES || [];
    if (activeFilter === 'all') return cats;
    return cats.filter((cat) => cat.group === activeFilter);
  }

  function categoryById(id) {
    return (catalog()?.CATEGORIES || []).find((cat) => cat.id === id) || null;
  }

  function updateMeta() {
    if (activeCategoryId) {
      const meta = $('supportMeta');
      if (!meta) return;
      const cat = categoryById(activeCategoryId);
      meta.textContent = cat ? `${cat.procedures.length} procedimento(s)` : '—';
      return;
    }
    updatePersistenceMeta();
  }

  function renderSuggestions(container) {
    const suggestions = catalog()?.searchSuggestions || [];
    if (!suggestions.length) return '';
    return `
      <div class="support-suggestions">
        <span class="support-suggestions__label">Tópicos mais pesquisados</span>
        ${suggestions.map((term) => (
          `<button type="button" class="support-suggestion-chip" data-support-suggest="${escapeHtml(term)}">${escapeHtml(term)}</button>`
        )).join('')}
      </div>`;
  }

  function categoryTheme(cat) {
    const themes = {
      maquineta: { accent: '#3b82f6', label: 'Equipamentos', emoji: '💳' },
      lavadoras: { accent: '#06b6d4', label: 'Equipamentos', emoji: '🫧' },
      noteiro: { accent: '#22c55e', label: 'Equipamentos', emoji: '💵' },
      modem: { accent: '#8b5cf6', label: 'Equipamentos', emoji: '📡' },
      totem: { accent: '#6366f1', label: 'Equipamentos', emoji: '🖥️' },
      'ar-condicionado': { accent: '#0ea5e9', label: 'Equipamentos', emoji: '❄️' },
      roupas: { accent: '#f59e0b', label: 'HelpDesk SAC', emoji: '👕' },
      pagamento: { accent: '#ef4444', label: 'HelpDesk SAC', emoji: '💳' },
      'nota-fiscal': { accent: '#14b8a6', label: 'HelpDesk SAC', emoji: '🧾' },
      cadastro: { accent: '#a855f7', label: 'HelpDesk SAC', emoji: '👤' },
      infraestrutura: { accent: '#64748b', label: 'HelpDesk SAC', emoji: '🏗️' },
      'itens-esquecidos': { accent: '#f97316', label: 'HelpDesk SAC', emoji: '📍' },
      cupons: { accent: '#ec4899', label: 'HelpDesk SAC', emoji: '🎟️' },
    };
    const base = themes[cat.id] || { accent: '#3b82f6', label: cat.group === 'helpdesk' ? 'HelpDesk SAC' : 'Equipamentos', emoji: '📋' };
    return base;
  }

  function renderCategoryIcon(cat, className = 'support-card__icon') {
    const theme = categoryTheme(cat);
    return `
      <div class="support-card__icon-wrap" style="--support-accent: ${theme.accent}">
        <img class="${className}" src="${escapeHtml(normalizeIconSrc(cat.icon))}" alt="" loading="lazy"
          onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
        <span class="support-card__icon-fallback" aria-hidden="true">${theme.emoji}</span>
      </div>`;
  }

  function renderHub() {
    activeCategoryId = null;
    const root = $('supportContent');
    const title = $('supportPanelTitle');
    if (!root) return;

    if (title) title.textContent = 'Base de conhecimento';

    const q = searchQuery.trim().toLowerCase();
    if (q) {
      const hits = catalog()?.search(q) || [];
      if (!hits.length) {
        root.innerHTML = `<div class="stores-empty-state"><p>Nenhum procedimento encontrado para “${escapeHtml(searchQuery)}”.</p></div>`;
        updateMeta();
        updateHeader();
        return;
      }
      root.innerHTML = `
        <div class="support-search-results">
          ${hits.map((hit) => {
            const cat = categoryById(hit.categoryId);
            const theme = cat ? categoryTheme(cat) : null;
            return `
            <button type="button" class="support-search-hit" data-support-open="${escapeHtml(hit.categoryId)}:${escapeHtml(hit.procedureId)}">
              <div class="support-search-hit__icon" style="--support-accent: ${theme?.accent || '#3b82f6'}">
                ${cat ? `<img src="${escapeHtml(normalizeIconSrc(cat.icon))}" alt="" loading="lazy">` : '📋'}
              </div>
              <div class="support-search-hit__copy">
                <div class="support-search-hit__title">${escapeHtml(hit.title)}</div>
                <div class="support-search-hit__category">${escapeHtml(hit.categoryTitle)}</div>
              </div>
              <span class="support-search-hit__arrow">→</span>
            </button>`;
          }).join('')}
        </div>`;
      updateMeta();
      updateHeader();
      return;
    }

    const cats = filteredCategories();
    root.innerHTML = `
      ${renderSuggestions('')}
      <div class="support-grid">
        ${cats.map((cat) => {
          const theme = categoryTheme(cat);
          return `
          <button type="button" class="support-card" data-support-category="${escapeHtml(cat.id)}" style="--support-accent: ${theme.accent}">
            <div class="support-card__shine" aria-hidden="true"></div>
            <div class="support-card__top">
              ${renderCategoryIcon(cat)}
              <span class="support-card__badge">${escapeHtml(theme.label)}</span>
            </div>
            <div class="support-card__title">${escapeHtml(cat.title)}</div>
            <div class="support-card__summary">${escapeHtml(cat.summary || '')}</div>
            <div class="support-card__meta">
              <span>${cat.procedures?.length || 0} procedimento(s)</span>
              <span class="support-card__arrow">→</span>
            </div>
          </button>`;
        }).join('')}
      </div>`;
    updateMeta();
    updateHeader();
  }

  function renderCategory(categoryId) {
    const cat = categoryById(categoryId);
    const root = $('supportContent');
    const title = $('supportPanelTitle');
    if (!cat || !root) return;

    activeCategoryId = categoryId;
    if (title) title.textContent = cat.title;

    const isCustomCategory = Boolean(cat.custom || catalog()?.isCustomCategory?.(categoryId));
    const categoryActions = (isCustomCategory && canEditKnowledge)
      ? `<div class="support-category-actions">
          <button type="button" class="btn btn--ghost btn--sm" data-support-edit-category="${escapeHtml(categoryId)}">Editar categoria</button>
        </div>`
      : '';

    root.innerHTML = `
      <div class="support-category-hero" style="--support-accent: ${categoryTheme(cat).accent}">
        ${renderCategoryIcon(cat, 'support-category-hero__icon')}
        <div class="support-category-hero__copy">
          <span class="support-category-hero__badge">${escapeHtml(categoryTheme(cat).label)}</span>
          <p class="support-category-hero__summary">${escapeHtml(cat.summary || '')}</p>
        </div>
      </div>
      ${categoryActions}
      <div class="support-list">
        ${(cat.procedures || []).map((proc) => `
          <button type="button" class="support-procedure" data-support-open="${escapeHtml(cat.id)}:${escapeHtml(proc.id)}">
            <span class="support-procedure__bullet" aria-hidden="true"></span>
            <span class="support-procedure__title">${escapeHtml(proc.title)}</span>
            <span class="support-procedure__action">Abrir →</span>
          </button>
        `).join('')}
      </div>`;
    updateMeta();
    updateHeader();
  }

  function groupLabel(group) {
    if (group === 'helpdesk') return 'HelpDesk SAC';
    if (group === 'equipamentos') return 'Equipamentos';
    return 'Runbook';
  }

  function enhanceProcedureHtml(html) {
    const wrap = document.createElement('div');
    wrap.className = 'runbook';
    wrap.innerHTML = html || '';

    wrap.querySelectorAll('h4').forEach((heading) => {
      heading.classList.add('runbook__section-title');
    });

    wrap.querySelectorAll('ol').forEach((list) => {
      list.classList.add('runbook__steps');
    });

    wrap.querySelectorAll('ul').forEach((list) => {
      list.classList.add(list.closest('li') ? 'runbook__branch' : 'runbook__list');
    });

    wrap.querySelectorAll('p').forEach((para) => {
      para.classList.add('runbook__note');
    });

    wrap.querySelectorAll('strong').forEach((strong) => {
      const text = strong.textContent.trim();
      if (/^(sim|não|nao)$/i.test(text) || text.endsWith('?')) {
        strong.classList.add('runbook__decision');
      }
    });

    return wrap.innerHTML;
  }

  function openProcedure(categoryId, procedureId) {
    const found = catalog()?.findProcedure(categoryId, procedureId);
    if (!found) return;

    const modal = $('supportModal');
    const titleEl = $('supportModalTitle');
    const subtitleEl = $('supportModalSubtitle');
    const eyebrowEl = $('supportModalEyebrow');
    const groupEl = $('supportModalGroup');
    const bodyEl = $('supportModalBody');
    const iconWrap = $('supportModalIconWrap');
    const iconEl = $('supportModalIcon');

    if (groupEl) {
      groupEl.textContent = groupLabel(found.categoryGroup);
      groupEl.dataset.group = found.categoryGroup || '';
    }
    if (eyebrowEl) eyebrowEl.textContent = found.categoryTitle || categoryById(categoryId)?.title || 'Procedimento';
    if (titleEl) titleEl.textContent = found.title || '—';
    if (subtitleEl) subtitleEl.textContent = 'Siga os passos na ordem indicada';

    if (iconWrap && iconEl && found.categoryIcon) {
      iconEl.src = normalizeIconSrc(found.categoryIcon);
      iconEl.alt = found.categoryTitle || '';
      iconWrap.classList.remove('hidden');
    } else {
      iconWrap?.classList.add('hidden');
    }

    if (bodyEl) bodyEl.innerHTML = enhanceProcedureHtml(found.body || '<p>Conteúdo indisponível.</p>');

    openProcedureRef = { categoryId, procedureId };
    const isCustom = catalog()?.isCustomProcedure?.(categoryId, procedureId);
    $('supportModalEdit')?.classList.toggle('hidden', !isCustom || !canEditKnowledge);
    $('supportModalDelete')?.classList.toggle('hidden', !isCustom || !canEditKnowledge);

    modal?.classList.remove('hidden');
    document.body.classList.add('support-modal-open');
    bodyEl?.scrollTo?.(0, 0);
  }

  function closeProcedureModal() {
    $('supportModal')?.classList.add('hidden');
    openProcedureRef = null;
    $('supportModalEdit')?.classList.add('hidden');
    $('supportModalDelete')?.classList.add('hidden');
    if ($('supportEditorModal')?.classList.contains('hidden') && $('supportMapModal')?.classList.contains('hidden')) {
      document.body.classList.remove('support-modal-open');
    }
  }

  function renderMapModal() {
    const body = $('supportMapModalBody');
    const regions = catalog()?.MAP_REGIONS || [];
    if (!body) return;
    body.innerHTML = `
      <ul class="support-map-list">
        ${regions.map((region) => `
          <li>
            <a href="${escapeHtml(region.url)}" target="_blank" rel="noopener noreferrer">
              <span class="support-map-list__title">${escapeHtml(region.title)}</span>
              <span class="support-map-list__states">${escapeHtml(region.states)}</span>
            </a>
          </li>
        `).join('')}
      </ul>`;
    $('supportMapModal')?.classList.remove('hidden');
    document.body.classList.add('support-modal-open');
  }

  function closeMapModal() {
    $('supportMapModal')?.classList.add('hidden');
    if ($('supportModal')?.classList.contains('hidden')) {
      document.body.classList.remove('support-modal-open');
    }
  }

  function bindEvents(signal) {
    $('supportSearch')?.addEventListener('input', (event) => {
      searchQuery = event.target.value || '';
      renderHub();
    }, { signal });

    $('supportHeaderBack')?.addEventListener('click', goBack, { signal });

    $('supportModalBack')?.addEventListener('click', closeProcedureModal, { signal });

    $('supportMapBtn')?.addEventListener('click', renderMapModal, { signal });

    $('supportAddBtn')?.addEventListener('click', () => openEditor({ mode: 'create' }), { signal });
    $('supportEditorForm')?.addEventListener('submit', submitEditor, { signal });
    $('supportEditorCategory')?.addEventListener('change', (event) => {
      toggleNewCategoryFields(event.target.value === '__new__');
    }, { signal });
    $('supportModalEdit')?.addEventListener('click', () => {
      if (!openProcedureRef) return;
      openEditor({
        mode: 'edit',
        categoryId: openProcedureRef.categoryId,
        procedureId: openProcedureRef.procedureId,
      });
    }, { signal });
    $('supportModalDelete')?.addEventListener('click', deleteOpenProcedure, { signal });
    $('supportCategoryForm')?.addEventListener('submit', submitCategoryEditor, { signal });
    $('supportCategoryDeleteBtn')?.addEventListener('click', deleteCategory, { signal });

    document.querySelectorAll('[data-support-category-dismiss]').forEach((el) => {
      el.addEventListener('click', closeCategoryEditor, { signal });
    });

    document.querySelectorAll('[data-support-editor-dismiss]').forEach((el) => {
      el.addEventListener('click', closeEditor, { signal });
    });

    document.querySelectorAll('[data-support-dismiss]').forEach((el) => {
      el.addEventListener('click', closeProcedureModal, { signal });
    });

    document.querySelectorAll('[data-support-map-dismiss]').forEach((el) => {
      el.addEventListener('click', closeMapModal, { signal });
    });

    $('supportFilters')?.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-support-filter]');
      if (!chip) return;
      activeFilter = chip.dataset.supportFilter || 'all';
      document.querySelectorAll('[data-support-filter]').forEach((btn) => {
        btn.classList.toggle('chip--active', btn === chip);
      });
      renderHub();
    }, { signal });

    $('supportContent')?.addEventListener('click', (event) => {
      const suggest = event.target.closest('[data-support-suggest]');
      if (suggest) {
        searchQuery = suggest.dataset.supportSuggest || '';
        const input = $('supportSearch');
        if (input) input.value = searchQuery;
        renderHub();
        return;
      }

      const openBtn = event.target.closest('[data-support-open]');
      if (openBtn) {
        const [categoryId, procedureId] = String(openBtn.dataset.supportOpen || '').split(':');
        if (categoryId && procedureId) openProcedure(categoryId, procedureId);
        return;
      }

      const categoryBtn = event.target.closest('[data-support-category]');
      if (categoryBtn) {
        renderCategory(categoryBtn.dataset.supportCategory);
        return;
      }

      const editCategoryBtn = event.target.closest('[data-support-edit-category]');
      if (editCategoryBtn) {
        openCategoryEditor(editCategoryBtn.dataset.supportEditCategory);
      }
    }, { signal });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!$('supportEditorModal')?.classList.contains('hidden')) closeEditor();
      else if (!$('supportCategoryModal')?.classList.contains('hidden')) closeCategoryEditor();
      else if (!$('supportModal')?.classList.contains('hidden')) closeProcedureModal();
      else if (!$('supportMapModal')?.classList.contains('hidden')) closeMapModal();
    }, { signal });
  }

  async function init() {
    if (!catalog()) {
      const root = $('supportContent');
      if (root) {
        root.innerHTML = '<div class="stores-empty-state"><p>Catálogo de suporte indisponível.</p></div>';
      }
      return;
    }

    pageAbort?.abort();
    pageAbort = new AbortController();
    activeFilter = 'all';
    activeCategoryId = null;
    searchQuery = '';

    const input = $('supportSearch');
    if (input) input.value = '';

    const loaded = await catalog().loadCustomEntries();
    canEditKnowledge = Boolean(loaded?.canEdit);
    persistenceInfo = loaded?.persistence || null;

    bindEvents(pageAbort.signal);
    updateEditControls();
    updateHeader();
    updatePersistenceMeta();
    renderHub();
  }

  async function destroy() {
    pageAbort?.abort();
    pageAbort = null;
    closeEditor();
    closeCategoryEditor();
    closeProcedureModal();
    closeMapModal();
  }

  window.Lav60SupportPage = { init, destroy };
})();
