(() => {
  'use strict';

  const PAGE_SIZE = 20;
  const CACHE_VERSION = '7';
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const CACHE_PREFIX = `lav60:records:v${CACHE_VERSION}:`;
  const FILTERS_KEY = `${CACHE_PREFIX}filters`;
  const OPERATORS_KEY = `${CACHE_PREFIX}operators`;

  let actionLabels = {};
  let deviceLabels = {};
  let catalogStores = [];
  let operatorOptions = [];
  let items = [];
  let hasMore = false;
  let loading = false;
  let searchTimer = null;
  let currentPage = 1;
  let totalRecords = null;
  let totalTruncated = false;
  /** @type {Record<number, number|null>} cursor before_ms para abrir cada página (página 1 = null) */
  let pageCursors = { 1: null };

  const $ = (id) => document.getElementById(id);

  function showToast(message, ok = true) {
    const el = $('toast');
    el.textContent = message;
    el.className = `toast ${ok ? 'toast--ok' : 'toast--err'}`;
    el.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.add('hidden'), 4500);
  }

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text ?? '';
    return d.innerHTML;
  }

  function formatDateTime(iso, tsMs) {
    const date = iso ? new Date(iso) : (tsMs ? new Date(tsMs) : null);
    if (!date || Number.isNaN(date.getTime())) return '—';
    return date.toLocaleString('pt-BR', {
      day: '2-digit',
      month: '2-digit',
      year: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function actionLabel(action) {
    return actionLabels[action] || action || 'Operação';
  }

  const DOSER_PRODUCT_LABELS = {
    rele1on: 'Sabão',
    rele2on: 'Amaciante Floral',
    rele3on: 'Amaciante Sport',
  };

  const WASHER_DOSAGE_LABELS = {
    '': 'Sem cheiro',
    'am01-1': 'Floral simples',
    'am01-2': 'Floral dupla',
    'am02-1': 'Sport simples',
    'am02-2': 'Sport dupla',
  };

  const EQUIPMENT_TYPE_LABELS = {
    washer: 'LAVADORA',
    dryer: 'SECADORA',
    doser: 'DOSADORA',
    ac: 'AR-CONDICIONADO',
  };

  function payloadOf(row) {
    return row?.payload && typeof row.payload === 'object' ? row.payload : {};
  }

  function equipmentType(row) {
    const type = String(row?.device_type || '').toLowerCase();
    if (type) return EQUIPMENT_TYPE_LABELS[type] || type.toUpperCase();
    return '—';
  }

  function equipmentCode(row) {
    const type = String(row?.device_type || '').toLowerCase();
    if (!type || type === 'ac' || !row?.device_id) return '—';
    return String(row.device_id).toUpperCase();
  }

  function storeLabel(row) {
    const store = String(row?.store || '').trim();
    return store ? store.toUpperCase() : '—';
  }

  function actionCellText(row) {
    const type = String(row?.device_type || '').toLowerCase();
    const payload = payloadOf(row);
    const action = String(row?.action || '');

    if (type === 'doser') {
      const kind = payload.type;
      if (kind === 'rele1on') return 'Sabão';
      if (kind === 'rele2on') return 'Amaciante Floral';
      if (kind === 'rele3on') return 'Amaciante Sport';
      if (kind) return DOSER_PRODUCT_LABELS[kind] || kind;
      if (action === 'doser_consult') return 'Consulta';
      if (action === 'doser_settime') return 'Ajuste tempo';
      return '—';
    }

    if (type === 'washer') {
      const am = payload.am;
      if (am == null || am === '') return 'Sem cheiro';
      return WASHER_DOSAGE_LABELS[am] || am;
    }

    if (type === 'ac') {
      const temp = payload.temperature;
      if (String(temp).toLowerCase() === 'off') return 'Desligar';
      if (temp != null && String(temp).trim() !== '') return `${String(temp).trim()}°C`;
      return '—';
    }

    if (type === 'dryer') return 'Liberar';

    if (action === 'auth_login') return 'Login';
    if (action === 'auth_logout') return 'Logout';
    if (action === 'washer_unlock' || action === 'dryer_unlock') return 'Reativar botões';

    return action ? actionLabel(action) : '—';
  }

  function dryingTime(row) {
    const type = String(row?.device_type || '').toLowerCase();
    if (type !== 'dryer') return '—';
    const payload = payloadOf(row);
    const response = row?.response && typeof row.response === 'object' ? row.response : {};
    const mins = payload.minutes ?? response.minutes;
    if (mins == null || mins === '') return '—';
    return `${mins} min`;
  }

  function currentFilters() {
    return {
      store: $('filterStore').value.trim(),
      operator: $('filterOperator').value.trim(),
      action: $('filterAction').value.trim(),
      success: $('filterSuccess').value.trim(),
      q: $('filterSearch').value.trim(),
    };
  }

  function filtersSignature(filters) {
    return JSON.stringify(filters);
  }

  function pageCacheKey(filters, page) {
    return `${CACHE_PREFIX}page:${filtersSignature(filters)}:${page}`;
  }

  function totalCacheKey(filters) {
    return `${CACHE_PREFIX}total:${filtersSignature(filters)}`;
  }

  function readTotalCache(filters) {
    const entry = readSessionJson(totalCacheKey(filters));
    if (!entry || Date.now() - (entry.at || 0) > CACHE_TTL_MS) return null;
    return entry;
  }

  function writeTotalCache(filters, total, truncated) {
    writeSessionJson(totalCacheKey(filters), {
      at: Date.now(),
      total,
      totalTruncated: truncated,
    });
  }

  function readSessionJson(key) {
    try {
      const raw = sessionStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function writeSessionJson(key, value) {
    try {
      sessionStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* quota / private mode */
    }
  }

  function readPageCache(filters, page) {
    const entry = readSessionJson(pageCacheKey(filters, page));
    if (!entry || Date.now() - (entry.at || 0) > CACHE_TTL_MS) return null;
    return entry;
  }

  function writePageCache(filters, page, payload) {
    writeSessionJson(pageCacheKey(filters, page), {
      at: Date.now(),
      items: payload.items,
      hasMore: payload.hasMore,
      nextPageCursor: payload.nextPageCursor,
      page,
      filters,
    });
  }

  function saveFiltersToSession(filters) {
    writeSessionJson(FILTERS_KEY, { at: Date.now(), filters });
  }

  function restoreFiltersFromSession() {
    const entry = readSessionJson(FILTERS_KEY);
    if (!entry?.filters) return;
    const f = entry.filters;
    if ($('filterStore')) $('filterStore').value = f.store || '';
    if ($('filterOperator')) $('filterOperator').value = f.operator || '';
    if ($('filterAction')) $('filterAction').value = f.action || '';
    if ($('filterSuccess')) $('filterSuccess').value = f.success || '';
    if ($('filterSearch')) $('filterSearch').value = f.q || '';
  }

  function resetPagination() {
    currentPage = 1;
    pageCursors = { 1: null };
    totalRecords = null;
    totalTruncated = false;
  }

  function buildQueryParams(filters, page) {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    if (filters.store) params.set('store', filters.store);
    if (filters.operator) params.set('operator', filters.operator);
    if (filters.action) params.set('action', filters.action);
    if (filters.success === 'true') params.set('success', 'true');
    if (filters.success === 'false') params.set('success', 'false');
    if (filters.q) params.set('q', filters.q);
    const beforeMs = page > 1 ? pageCursors[page] : null;
    if (beforeMs) params.set('before_ms', String(beforeMs));
    return params.toString();
  }

  function nextPageCursor(data, pageItems) {
    if (data?.next_before_ms != null) return data.next_before_ms;
    const last = pageItems[pageItems.length - 1];
    return last?.ts_ms ?? null;
  }

  function applyTotalFromData(data, filters) {
    if (data.total == null) return;
    totalRecords = Number(data.total);
    totalTruncated = Boolean(data.total_truncated);
    writeTotalCache(filters, totalRecords, totalTruncated);
  }

  function applyPagePayload(data, page, filters) {
    actionLabels = data.action_labels || actionLabels;
    deviceLabels = data.device_labels || deviceLabels;
    const batch = Array.isArray(data.items) ? data.items : [];
    items = batch.slice(0, PAGE_SIZE);
    hasMore = Boolean(data.has_more);
    applyTotalFromData(data, filters);
    if (hasMore) {
      const cursor = nextPageCursor(data, items);
      if (cursor != null) {
        pageCursors[page + 1] = cursor;
      } else {
        delete pageCursors[page + 1];
        hasMore = false;
      }
    } else {
      delete pageCursors[page + 1];
    }
    populateActionFilter();
    renderTable();
    updateMeta();
  }

  async function fetchLogs({ page = currentPage, force = false, silent = false } = {}) {
    if (loading && !silent) return;
    // Refresh silencioso da página 1 não deve resetar a navegação na página 2+
    if (silent && page !== currentPage) return;

    const filters = currentFilters();
    saveFiltersToSession(filters);

    if (!silent) {
      currentPage = page;
    }

    if (page > 1 && (pageCursors[page] == null || pageCursors[page] === undefined)) {
      showToast('Não há mais páginas nesta direção', false);
      return;
    }

    const cached = !force ? readPageCache(filters, page) : null;
    if (cached) {
      if (silent && page !== currentPage) return;
      items = (cached.items || []).slice(0, PAGE_SIZE);
      hasMore = Boolean(cached.hasMore);
      if (cached.nextPageCursor) {
        pageCursors[page + 1] = cached.nextPageCursor;
      }
      if (page === 1) {
        const totalCached = readTotalCache(filters);
        if (totalCached && totalCached.total != null) {
          totalRecords = totalCached.total;
          totalTruncated = Boolean(totalCached.totalTruncated);
        }
      }
      renderTable();
      updateMeta();
      if (!silent) {
        fetchLogs({ page, force: true, silent: true });
      }
      return;
    }

    loading = !silent;
    if (!silent) setLoadingState(!items.length);

    try {
      const query = buildQueryParams(filters, page);
      const res = await fetch(`/api/audit/logs?${query}`, { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const hint = data.hint ? ` — ${data.hint}` : '';
        const reason = data.reason ? ` (${data.reason})` : '';
        throw new Error((data.detail || 'Erro ao carregar registros') + reason + hint);
      }

      if (silent && page !== currentPage) return;

      applyPagePayload(data, page, filters);
      writePageCache(filters, page, {
        items,
        hasMore,
        nextPageCursor: hasMore ? pageCursors[page + 1] : null,
      });
    } catch (e) {
      if (!silent) {
        items = [];
        renderTable();
        updateMeta();
        showToast(e.message || 'Falha ao carregar registros', false);
      }
    } finally {
      if (!silent) loading = false;
      setLoadingState(false);
    }
  }

  function setLoadingState(isLoading) {
    $('recordsLoading').classList.toggle('hidden', !isLoading || items.length > 0);
    if (isLoading && !items.length) {
      $('recordsTableWrap').classList.add('hidden');
      $('recordsEmpty').classList.add('hidden');
    }
  }

  function formatTotalText() {
    if (totalRecords == null) {
      return loading ? 'Calculando total…' : '';
    }
    const n = Number(totalRecords).toLocaleString('pt-BR');
    const suffix = totalTruncated ? '+' : '';
    return `${n}${suffix} registro(s) no total`;
  }

  function updateMeta() {
    const totalText = formatTotalText();
    $('recordsMeta').textContent = items.length
      ? `${items.length} nesta página · ${PAGE_SIZE} por página${totalText ? ` · ${totalText}` : ''}`
      : (totalText || 'audit_logs');
    const pageInfo = $('recordsPageInfo');
    if (pageInfo) pageInfo.textContent = `Página ${currentPage}`;
    const totalInfo = $('recordsTotalInfo');
    if (totalInfo) totalInfo.textContent = totalText;
    const appTotal = $('recordsAppFooterTotal');
    if (appTotal) appTotal.textContent = totalText;
    const prev = $('btnPrevPage');
    const next = $('btnNextPage');
    if (prev) prev.disabled = currentPage <= 1 || loading;
    if (next) next.disabled = (!hasMore && !pageCursors[currentPage + 1]) || loading;
    const footer = $('recordsFooter');
    if (footer) {
      footer.classList.toggle('hidden', items.length === 0 && currentPage <= 1);
    }
  }

  function populateStoreFilter() {
    const select = $('filterStore');
    const current = select.value;
    select.innerHTML = '<option value="">Todas as lojas</option>';
    catalogStores.forEach((store) => {
      const opt = document.createElement('option');
      opt.value = store.id;
      opt.textContent = store.name || store.id.toUpperCase();
      select.appendChild(opt);
    });
    if (current) select.value = current;
  }

  function populateOperatorFilter() {
    const select = $('filterOperator');
    const current = select.value;
    select.innerHTML = '<option value="">Todos os operadores</option>';
    operatorOptions.forEach((op) => {
      const opt = document.createElement('option');
      opt.value = op.email;
      opt.textContent = op.name && op.name !== op.email ? `${op.name} (${op.email})` : op.email;
      select.appendChild(opt);
    });
    if (current && operatorOptions.some((op) => op.email === current)) {
      select.value = current;
    }
  }

  function populateActionFilter() {
    const select = $('filterAction');
    const current = select.value;
    const keys = Object.keys(actionLabels).sort((a, b) =>
      actionLabel(a).localeCompare(actionLabel(b), 'pt-BR')
    );
    select.innerHTML = '<option value="">Todos os tipos</option>';
    keys.forEach((key) => {
      const opt = document.createElement('option');
      opt.value = key;
      opt.textContent = actionLabel(key);
      select.appendChild(opt);
    });
    if (current && actionLabels[current]) select.value = current;
  }

  function renderTable() {
    const tbody = $('recordsTbody');
    tbody.innerHTML = '';

    if (!items.length) {
      $('recordsTableWrap').classList.add('hidden');
      $('recordsEmpty').classList.remove('hidden');
      $('recordsEmptyText').textContent = loading
        ? 'Carregando registros…'
        : 'Nenhum registro encontrado para os filtros selecionados.';
      updateMeta();
      return;
    }

    $('recordsEmpty').classList.add('hidden');
    $('recordsTableWrap').classList.remove('hidden');

    items.forEach((row) => {
      const tr = document.createElement('tr');
      tr.className = row.success === false ? 'records-table__row records-table__row--fail' : 'records-table__row';
      tr.innerHTML = `
        <td class="records-table__time">${escapeHtml(formatDateTime(row.ts, row.ts_ms))}</td>
        <td class="records-table__operator" title="${escapeHtml(row.operator_name || '')}">
          ${escapeHtml(row.operator_email || row.operator_name || '—')}
        </td>
        <td class="records-table__store">${escapeHtml(storeLabel(row))}</td>
        <td class="records-table__equip-type">${escapeHtml(equipmentType(row))}</td>
        <td class="records-table__equip-code">${escapeHtml(equipmentCode(row))}</td>
        <td class="records-table__action">${escapeHtml(actionCellText(row))}</td>
        <td class="records-table__dry-time">${escapeHtml(dryingTime(row))}</td>`;
      tbody.appendChild(tr);
    });
    updateMeta();
  }

  async function loadCatalog() {
    const res = await fetch('stores.json', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Não foi possível carregar stores.json');
    const data = await res.json();
    catalogStores = data.stores || [];
    populateStoreFilter();
  }

  async function loadOperators({ force = false } = {}) {
    if (!force) {
      const cached = readSessionJson(OPERATORS_KEY);
      if (cached?.operators && Date.now() - (cached.at || 0) <= CACHE_TTL_MS) {
        operatorOptions = cached.operators;
        populateOperatorFilter();
        return;
      }
    }

    try {
      const res = await fetch('/api/audit/operators', { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) return;
      operatorOptions = data.operators || [];
      writeSessionJson(OPERATORS_KEY, { at: Date.now(), operators: operatorOptions });
      populateOperatorFilter();
    } catch {
      /* filtro opcional */
    }
  }

  function bindClick(id, fn) {
    const el = $(id);
    if (el) el.addEventListener('click', fn);
  }

  function clearLegacyRecordsCache() {
    try {
      const versionKey = 'lav60:records:version';
      if (sessionStorage.getItem(versionKey) === CACHE_VERSION) return;
      Object.keys(sessionStorage).forEach((key) => {
        if (key.startsWith('lav60:records:')) sessionStorage.removeItem(key);
      });
      sessionStorage.setItem(versionKey, CACHE_VERSION);
    } catch {
      /* private mode */
    }
  }

  function onFiltersChanged() {
    resetPagination();
    items = [];
    fetchLogs({ page: 1, force: true });
  }

  function initFilters() {
    ['filterStore', 'filterOperator', 'filterAction', 'filterSuccess'].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('change', onFiltersChanged);
    });

    const search = $('filterSearch');
    if (search) {
      search.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(onFiltersChanged, 350);
      });
    }

    bindClick('btnRefresh', () => {
      resetPagination();
      loadOperators({ force: true });
      fetchLogs({ page: 1, force: true });
    });

    bindClick('btnPrevPage', () => {
      if (currentPage <= 1 || loading) return;
      fetchLogs({ page: currentPage - 1 });
    });

    bindClick('btnNextPage', () => {
      if (loading) return;
      if (!hasMore && !pageCursors[currentPage + 1]) return;
      fetchLogs({ page: currentPage + 1 });
    });
  }

  function initAuthUi() {
    if (!window.Lav60Auth) return;
    Lav60Auth.authEnabled().then(async (enabled) => {
      if (!enabled) return;
      await Lav60Auth.mountUserMenu($('headerUserMenu'));
    });
  }

  async function init() {
    clearLegacyRecordsCache();
    initFilters();
    initAuthUi();
    restoreFiltersFromSession();
    try {
      await loadCatalog();
      await loadOperators();
      await fetchLogs({ page: 1 });
    } catch (e) {
      showToast(e.message || 'Erro ao iniciar página', false);
      $('recordsLoading').classList.add('hidden');
      $('recordsEmpty').classList.remove('hidden');
      $('recordsEmptyText').textContent = e.message || 'Erro ao carregar';
    }
  }

  (async () => {
    if (window.Lav60Auth) {
      const ok = await Lav60Auth.guardPage({ returnPath: 'records.html' });
      if (!ok) return;
    }
    document.body.classList.remove('auth-pending');
    await init();
  })();
})();
