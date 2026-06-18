(() => {
  'use strict';

  const PAGE_SIZE = 20;
  const CACHE_VERSION = '10';
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const CACHE_PREFIX = `lav60:records:v${CACHE_VERSION}:`;
  const FILTERS_KEY = `${CACHE_PREFIX}filters`;
  const OPERATORS_KEY = `${CACHE_PREFIX}operators`;
  const OPERATOR_STATS_KEY = `${CACHE_PREFIX}operator-stats`;

  let actionLabels = {};
  let deviceLabels = {};
  let catalogStores = [];
  let operatorOptions = [];
  let operatorStats = [];
  let operatorStatsTruncated = false;
  let recordsAbort = null;
  let items = [];
  let hasMore = false;
  let loading = false;
  let recordsReady = false;
  let currentPage = 1;
  let totalRecords = null;
  let totalTruncated = false;
  /** @type {Record<number, number|null>} cursor before_ms para abrir cada página (página 1 = null) */
  let pageCursors = { 1: null };
  /** @type {Record<number, { items: object[], hasMore: boolean, nextCursor: number|null }>} */
  let pageSnapshots = {};
  let auditUnavailable = null;

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

  function statsFilters() {
    const filters = currentFilters();
    return {
      store: filters.store,
      action: filters.action,
      success: filters.success,
    };
  }

  function statsCacheKey(filters) {
    return `${OPERATOR_STATS_KEY}:${filtersSignature(filters)}`;
  }

  function operatorDisplayName(op) {
    const name = String(op?.name || '').trim();
    const email = String(op?.email || '').trim();
    if (name && email && name.toLowerCase() !== email.toLowerCase()) {
      return name;
    }
    return email || name || 'Operador desconhecido';
  }

  function operatorSubtitle(op) {
    const email = String(op?.email || '').trim();
    const name = operatorDisplayName(op);
    if (email && name.toLowerCase() !== email.toLowerCase()) return email;
    return '';
  }

  function formatOperationCount(count) {
    const n = Number(count);
    if (!Number.isFinite(n) || n <= 0) return '0 operações';
    const label = n === 1 ? 'operação' : 'operações';
    return `${n.toLocaleString('pt-BR')} ${label}`;
  }

  function renderOperatorStats() {
    const leader = operatorStats[0];
    const topEl = $('recordsTopOperator');
    const metaEl = $('recordsTopOperatorMeta');
    const listEl = $('recordsOperatorRanking');

    if (topEl) {
      topEl.textContent = leader ? operatorDisplayName(leader) : '—';
    }
    if (metaEl) {
      if (!leader) {
        metaEl.textContent = 'Sem registros para os filtros atuais';
      } else {
        const parts = [formatOperationCount(leader.count)];
        const subtitle = operatorSubtitle(leader);
        if (subtitle) parts.unshift(subtitle);
        if (operatorStatsTruncated) parts.push('amostra limitada a 10.000 registros');
        metaEl.textContent = parts.join(' · ');
      }
    }

    if (!listEl) return;
    listEl.innerHTML = '';
    if (operatorStats.length <= 1) {
      listEl.classList.add('hidden');
      return;
    }

    const maxCount = Math.max(...operatorStats.map((row) => Number(row.count) || 0), 1);
    operatorStats.forEach((row, index) => {
      const li = document.createElement('li');
      li.className = 'records-ranking__item';
      const pct = Math.max(8, Math.round(((Number(row.count) || 0) / maxCount) * 100));
      li.innerHTML = `
        <span class="records-ranking__rank">${index + 1}º</span>
        <div class="records-ranking__body">
          <div class="records-ranking__head">
            <span class="records-ranking__name">${escapeHtml(operatorDisplayName(row))}</span>
            <span class="records-ranking__count">${escapeHtml(formatOperationCount(row.count))}</span>
          </div>
          <div class="records-ranking__bar" aria-hidden="true"><span style="width:${pct}%"></span></div>
        </div>`;
      listEl.appendChild(li);
    });
    listEl.classList.remove('hidden');
  }

  function currentFilters() {
    return {
      store: $('filterStore').value.trim(),
      operator: $('filterOperator').value.trim(),
      action: $('filterAction').value.trim(),
      success: $('filterSuccess').value.trim(),
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
  }

  function isAuditUnavailable(data) {
    return data?.available === false || data?.detail === 'audit_unavailable';
  }

  function renderAuditUnavailable(payload) {
    auditUnavailable = payload || { detail: 'audit_unavailable' };
    items = [];
    hasMore = false;
    recordsReady = true;
    loading = false;
    renderTable();
    updateMeta();
    syncRecordsView();

    const banner = $('recordsAuditBanner');
    const hint = auditUnavailable.hint || 'Auditoria indisponível. Contacte o suporte técnico.';
    if (banner) {
      banner.classList.remove('hidden');
      banner.innerHTML = `<strong>Auditoria indisponível</strong><p>${escapeHtml(hint)}</p>`;
    }
    const subtitle = $('recordsSubtitle');
    if (subtitle) subtitle.textContent = 'Firestore não configurado no servidor';
  }

  function clearAuditUnavailable() {
    auditUnavailable = null;
    $('recordsAuditBanner')?.classList.add('hidden');
    const subtitle = $('recordsSubtitle');
    if (subtitle) subtitle.textContent = 'Auditoria Firestore das ações no painel';
  }

  function resetPagination() {
    currentPage = 1;
    pageCursors = { 1: null };
    pageSnapshots = {};
    totalRecords = null;
    totalTruncated = false;
  }

  function syncRecordsView() {
    const hasItems = items.length > 0;
    const initialLoading = !hasItems && (!recordsReady || loading);
    const tableRefreshing = loading && hasItems;
    const showEmpty = recordsReady && !loading && !hasItems;

    let view = 'loading';
    if (showEmpty) view = 'empty';
    else if (hasItems) view = tableRefreshing ? 'refreshing' : 'ready';

    const body = $('recordsPanelBody');
    if (body) body.dataset.view = view;

    $('recordsLoading')?.classList.toggle('hidden', !initialLoading);
    $('recordsEmpty')?.classList.toggle('hidden', !showEmpty);
    $('recordsTableWrap')?.classList.toggle('hidden', !hasItems);
    $('recordsTableOverlay')?.classList.toggle('hidden', !tableRefreshing);
    body?.classList.toggle('records-panel__body--busy', tableRefreshing);

    if (showEmpty) {
      if (auditUnavailable) {
        $('recordsEmptyText').textContent = 'Registros indisponíveis até configurar a auditoria no VPS.';
      } else {
        $('recordsEmptyText').textContent = 'Nenhum registro encontrado para os filtros selecionados.';
      }
    }
  }

  function savePageSnapshot(page) {
    pageSnapshots[page] = {
      items: items.slice(),
      hasMore,
      nextCursor: pageCursors[page + 1] ?? null,
    };
  }

  function restorePageSnapshot(page) {
    const snap = pageSnapshots[page];
    if (!snap) return false;
    currentPage = page;
    items = snap.items.slice();
    hasMore = snap.hasMore;
    if (snap.nextCursor != null) {
      pageCursors[page + 1] = snap.nextCursor;
    }
    renderTable();
    return true;
  }

  function buildQueryParams(filters, page) {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    if (page === 1 && totalRecords != null) params.set('skip_total', '1');
    if (filters.store) params.set('store', filters.store);
    if (filters.operator) params.set('operator', filters.operator);
    if (filters.action) params.set('action', filters.action);
    if (filters.success === 'true') params.set('success', 'true');
    if (filters.success === 'false') params.set('success', 'false');
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
    currentPage = page;
    savePageSnapshot(page);
    recordsReady = true;
    renderTable();
    updateMeta();
  }

  async function fetchLogs({ page = currentPage, force = false, silent = false } = {}) {
    if (loading && !silent) return;
    // Refresh silencioso da página 1 não deve resetar a navegação na página 2+
    if (silent && page !== currentPage) return;

    const filters = currentFilters();
    saveFiltersToSession(filters);

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
      if (!silent) {
        currentPage = page;
        savePageSnapshot(page);
        recordsReady = true;
      }
      renderTable();
      updateMeta();
      if (!silent) {
        fetchLogs({ page, force: true, silent: true });
      }
      return;
    }

    loading = !silent;
    if (!silent) syncRecordsView();

    try {
      const query = buildQueryParams(filters, page);
      const res = await fetch(`/api/audit/logs?${query}`, { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (isAuditUnavailable(data)) {
        renderAuditUnavailable(data);
        return;
      }
      if (!res.ok) {
        const hint = data.hint ? ` — ${data.hint}` : '';
        const reason = data.reason ? ` (${data.reason})` : '';
        throw new Error((data.detail || 'Erro ao carregar registros') + reason + hint);
      }

      if (silent && page !== currentPage) return;

      clearAuditUnavailable();
      applyPagePayload(data, page, filters);
      writePageCache(filters, page, {
        items,
        hasMore,
        nextPageCursor: hasMore ? pageCursors[page + 1] : null,
      });
    } catch (e) {
      if (!silent) {
        items = [];
        recordsReady = true;
        renderTable();
        updateMeta();
        showToast(e.message || 'Falha ao carregar registros', false);
      }
    } finally {
      if (!silent) {
        loading = false;
        recordsReady = true;
        syncRecordsView();
        updateMeta();
      }
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

    syncRecordsView();
    updateMeta();
  }

  async function loadCatalog() {
    const res = await fetch('/api/catalog', {
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!res.ok) throw new Error('Não foi possível carregar lojas do painel');
    const data = await res.json();
    catalogStores = data.stores || [];
    populateStoreFilter();
  }

  async function loadOperatorStats({ force = false } = {}) {
    const filters = statsFilters();

    if (!force) {
      const cached = readSessionJson(statsCacheKey(filters));
      if (cached?.operators && Date.now() - (cached.at || 0) <= CACHE_TTL_MS) {
        operatorStats = cached.operators;
        operatorStatsTruncated = Boolean(cached.truncated);
        renderOperatorStats();
        return;
      }
    }

    try {
      const params = new URLSearchParams();
      params.set('limit', '5');
      if (filters.store) params.set('store', filters.store);
      if (filters.action) params.set('action', filters.action);
      if (filters.success === 'true') params.set('success', 'true');
      if (filters.success === 'false') params.set('success', 'false');

      const res = await fetch(`/api/audit/operator-stats?${params}`, { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        operatorStats = [];
        operatorStatsTruncated = false;
        renderOperatorStats();
        return;
      }

      operatorStats = Array.isArray(data.operators) ? data.operators : [];
      operatorStatsTruncated = Boolean(data.truncated);
      writeSessionJson(statsCacheKey(filters), {
        at: Date.now(),
        operators: operatorStats,
        truncated: operatorStatsTruncated,
      });
      renderOperatorStats();
    } catch {
      operatorStats = [];
      operatorStatsTruncated = false;
      renderOperatorStats();
    }
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

  function bindClick(id, fn, signal) {
    const el = $(id);
    if (el) el.addEventListener('click', fn, { signal });
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
    loadOperatorStats({ force: true });
    fetchLogs({ page: 1, force: true });
  }

  function initFilters(signal) {
    ['filterStore', 'filterOperator', 'filterAction', 'filterSuccess'].forEach((id) => {
      const el = $(id);
      if (el) el.addEventListener('change', onFiltersChanged, { signal });
    });

    bindClick('btnRefresh', () => {
      resetPagination();
      loadOperators({ force: true });
      loadOperatorStats({ force: true });
      fetchLogs({ page: 1, force: true });
    }, signal);

    bindClick('btnPrevPage', () => {
      if (currentPage <= 1 || loading) return;
      const targetPage = currentPage - 1;
      if (restorePageSnapshot(targetPage)) return;
      fetchLogs({ page: targetPage });
    }, signal);

    bindClick('btnNextPage', () => {
      if (loading) return;
      if (!hasMore && !pageCursors[currentPage + 1]) return;
      fetchLogs({ page: currentPage + 1 });
    }, signal);
  }

  function destroy() {
    recordsAbort?.abort();
    recordsAbort = null;
  }

  async function init() {
    destroy();
    recordsAbort = new AbortController();
    const { signal } = recordsAbort;

    clearLegacyRecordsCache();
    initFilters(signal);
    restoreFiltersFromSession();
    syncRecordsView();
    try {
      await loadCatalog();
      await loadOperators();
      await loadOperatorStats();
      await fetchLogs({ page: 1 });
    } catch (e) {
      recordsReady = true;
      syncRecordsView();
      showToast(e.message || 'Erro ao iniciar página', false);
      $('recordsEmpty')?.classList.remove('hidden');
      $('recordsLoading')?.classList.add('hidden');
      $('recordsEmptyText').textContent = e.message || 'Erro ao carregar';
    }
  }

  window.Lav60RecordsPage = { init, destroy };
})();
