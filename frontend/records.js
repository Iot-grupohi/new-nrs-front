(() => {
  'use strict';

  const PAGE_SIZE = 40;
  let actionLabels = {};
  let deviceLabels = {};
  let catalogStores = [];
  let items = [];
  let nextBeforeMs = null;
  let hasMore = false;
  let loading = false;
  let searchTimer = null;

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
      action: $('filterAction').value.trim(),
      success: $('filterSuccess').value.trim(),
      q: $('filterSearch').value.trim(),
    };
  }

  function buildQueryParams(filters, beforeMs) {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    if (filters.store) params.set('store', filters.store);
    if (filters.action) params.set('action', filters.action);
    if (filters.success === 'true') params.set('success', 'true');
    if (filters.success === 'false') params.set('success', 'false');
    if (filters.q) params.set('q', filters.q);
    if (beforeMs) params.set('before_ms', String(beforeMs));
    return params.toString();
  }

  async function fetchLogs({ append = false, beforeMs = null } = {}) {
    if (loading) return;
    loading = true;
    setLoadingState(!append);

    try {
      const filters = currentFilters();
      const query = buildQueryParams(filters, append ? beforeMs : null);
      const res = await fetch(`/api/audit/logs?${query}`, { credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data.detail || `Erro ao carregar registros (HTTP ${res.status})`);
      }

      actionLabels = data.action_labels || actionLabels;
      deviceLabels = data.device_labels || deviceLabels;
      const batch = data.items || [];
      items = append ? items.concat(batch) : batch;
      hasMore = Boolean(data.has_more);
      nextBeforeMs = data.next_before_ms || (batch.length ? batch[batch.length - 1].ts_ms : null);

      populateActionFilter();
      renderTable();
      updateMeta();
    } catch (e) {
      if (!append) {
        items = [];
        renderTable();
      }
      showToast(e.message || 'Falha ao carregar registros', false);
    } finally {
      loading = false;
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

  function updateMeta() {
    const collection = 'audit_logs';
    $('recordsMeta').textContent = items.length
      ? `${items.length} registro(s) exibido(s)${hasMore ? '+' : ''}`
      : collection;
    $('recordsFooter').classList.toggle('hidden', !hasMore);
    $('btnLoadMore').disabled = !hasMore;
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
      $('recordsFooter').classList.add('hidden');
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
  }

  async function loadCatalog() {
    const res = await fetch('stores.json', { credentials: 'same-origin' });
    if (!res.ok) throw new Error('Não foi possível carregar stores.json');
    const data = await res.json();
    catalogStores = data.stores || [];
    populateStoreFilter();
  }

  function initFilters() {
    ['filterStore', 'filterAction', 'filterSuccess'].forEach((id) => {
      $(id).addEventListener('change', () => fetchLogs());
    });

    $('filterSearch').addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => fetchLogs(), 350);
    });

    $('btnRefresh').addEventListener('click', () => fetchLogs());
    $('btnLoadMore').addEventListener('click', () => {
      if (hasMore && nextBeforeMs) fetchLogs({ append: true, beforeMs: nextBeforeMs });
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
    initFilters();
    initAuthUi();
    try {
      await loadCatalog();
      await fetchLogs();
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
