(() => {
  'use strict';

  const { loadCatalog, friendlyUserMessage, WASHER_DOSAGE_OPTIONS } = window.Lav60;
  const { guardPage, mountUserMenu, panelFetch } = window.Lav60Auth;

  const $ = (id) => document.getElementById(id);
  const MAX_LOG = 10;

  const TEMPO_LABELS = { sabao: 'Sabão', floral: 'Floral', sport: 'Sport' };
  const DOSER_TYPE_LABELS = { rele1on: 'Sabão', rele2on: 'Floral', rele3on: 'Sport' };

  const STATUS_PATHS = {
    washer: (id) => `status/washer/${id}`,
    dryer: (id) => `status/dryer/${id}`,
    doser: (id) => `status/doser/${id}`,
    ac: () => 'status/ac',
  };

  let gatewayConfig = null;
  let catalog = null;
  let currentStore = '';
  let pingStatus = null;
  let actionBusy = false;
  const probingDevices = new Set();

  function gatewayDebug(label, payload) {
    const ts = new Date().toISOString().slice(11, 23);
    if (payload !== undefined) console.log(`[LAV60 Gateway ${ts}] ${label}`, payload);
    else console.log(`[LAV60 Gateway ${ts}] ${label}`);
  }

  function normalizeStoreId(value) {
    return String(value || '').trim().toLowerCase();
  }

  function escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function showToast(message, ok = true) {
    const el = $('toast');
    el.textContent = friendlyUserMessage(message);
    el.className = `toast ${ok ? 'toast--ok' : 'toast--err'}`;
    el.classList.remove('hidden');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => el.classList.add('hidden'), 4500);
  }

  function appendLog(label, ok, payload) {
    const list = $('responseLog');
    if (!list) return;
    const item = document.createElement('li');
    item.className = `gateway-log__item ${ok ? 'gateway-log__item--ok' : 'gateway-log__item--err'}`;
    const preview =
      typeof payload === 'string' ? payload : JSON.stringify(payload, null, 0).slice(0, 320);
    item.innerHTML = `<time>${new Date().toLocaleTimeString('pt-BR')}</time>
      <strong>${escapeHtml(label)}</strong>
      <code>${escapeHtml(preview)}</code>`;
    list.prepend(item);
    while (list.children.length > MAX_LOG) list.removeChild(list.lastChild);
  }

  function storeSelected() {
    return Boolean(currentStore);
  }

  function deviceEndpointPath(deviceType, machine) {
    const build = STATUS_PATHS[deviceType];
    return build ? build(machine) : '';
  }

  function fullGatewayPath(subpath) {
    return currentStore ? `${currentStore}/${subpath.replace(/^\//, '')}` : subpath;
  }

  function updateStoreEndpointMeta() {
    const el = $('storeEndpointMeta');
    if (!el) return;
    el.textContent = currentStore
      ? `Base: /api/gateway/${currentStore}/…`
      : 'Endpoint: selecione a loja';
  }

  async function loadGatewayConfig() {
    const res = await panelFetch('/api/gateway/config');
    if (!res.ok) throw new Error('Configuração do gateway indisponível');
    gatewayConfig = await res.json();
    gatewayConfig.washer_dosage_options = WASHER_DOSAGE_OPTIONS;
    const base = gatewayConfig.base_url || 'https://gateway.lav60.com';
    $('gatewayBaseUrl').textContent = base.replace(/^https?:\/\//, '');
    $('tokenAlert').classList.toggle('hidden', Boolean(gatewayConfig.token_configured));
    return gatewayConfig;
  }

  function readGatewayError(data, status) {
    if (!data) return `HTTP ${status}`;
    return data.detail || data.error || data.message || `HTTP ${status}`;
  }

  async function gatewayRequest(method, subpath, body, options = {}) {
    if (!currentStore) throw new Error('Selecione uma loja');
    const url = `/api/gateway/${encodeURIComponent(currentStore)}/${subpath.replace(/^\//, '')}`;
    const fetchOptions = { method, headers: { Accept: 'application/json' } };
    if (body !== undefined) {
      fetchOptions.headers['Content-Type'] = 'application/json';
      fetchOptions.body = JSON.stringify(body);
    }
    gatewayDebug(`→ ${method} ${fullGatewayPath(subpath)}`, body !== undefined ? { body } : undefined);
    const started = performance.now();
    const res = await panelFetch(url, fetchOptions);
    let data;
    try {
      data = await res.json();
    } catch {
      data = { detail: `HTTP ${res.status}` };
    }
    gatewayDebug(`← ${method} ${fullGatewayPath(subpath)} HTTP ${res.status} (${Math.round(performance.now() - started)}ms)`, data);
    if (!res.ok && !options.allowHttpError) {
      const err = new Error(readGatewayError(data, res.status));
      err.payload = data;
      throw err;
    }
    return { data, ok: res.ok, status: res.status };
  }

  async function checkApiHealth() {
    $('apiHealthMeta').textContent = 'API: verificando…';
    try {
      const res = await panelFetch('/api/gateway/health');
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      $('apiHealthMeta').textContent = `API: online (${data.message || 'OK'})`;
      $('apiHealthMeta').className = 'gateway-meta gateway-meta--ok';
      appendLog('Health API', true, data);
      return data;
    } catch (err) {
      $('apiHealthMeta').textContent = `API: offline — ${err.message}`;
      $('apiHealthMeta').className = 'gateway-meta gateway-meta--err';
      appendLog('Health API', false, err.message);
      throw err;
    }
  }

  function resetPingStatus() {
    pingStatus = {
      washers: Object.fromEntries((gatewayConfig?.washers || []).map((id) => [id, null])),
      dryers: Object.fromEntries((gatewayConfig?.dryers || []).map((id) => [id, null])),
      dosers: Object.fromEntries((gatewayConfig?.dosers || []).map((id) => [id, null])),
      ac: null,
    };
  }

  function parseOnlineFlag(value) {
    if (value === true || value === 1) return true;
    if (value === false || value === 0) return false;
    if (typeof value === 'string') {
      const n = value.trim().toLowerCase();
      if (n === 'true' || n === 'online' || n === '1') return true;
      if (n === 'false' || n === 'offline' || n === '0') return false;
    }
    return null;
  }

  function extractOnlineFromProbeResult(result) {
    const data = result.data || {};
    const fromOnline = parseOnlineFlag(data.online);
    if (fromOnline !== null) return fromOnline;
    const upstream = Number(data.upstream_status);
    if (upstream === 200) return true;
    if (upstream >= 400) return false;
    if (result.ok) return true;
    return null;
  }

  function onlinePill(online) {
    if (online === true) return '<span class="device-card__status pill pill--on">Online</span>';
    if (online === false) return '<span class="device-card__status pill pill--off">Offline</span>';
    return '<span class="device-card__status pill pill--warn">Não verificado</span>';
  }

  function btn(text, className, onclick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn btn--sm ${className || ''}`;
    b.textContent = text;
    if (onclick) b.addEventListener('click', onclick);
    return b;
  }

  function createChoicePicker(options, { columns = 3, requireSelection = false, disabled = false } = {}) {
    const wrap = document.createElement('div');
    wrap.className = `device-card__choice-grid device-card__choice-grid--${columns}`;
    let selected = requireSelection ? null : options[0]?.value ?? '';
    const buttons = [];
    const listeners = [];

    function notifyChange() {
      listeners.forEach((fn) => fn(selected));
    }

    options.forEach((opt) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'device-card__choice';
      if (opt.wide) b.classList.add('device-card__choice--wide');
      if (!requireSelection && String(opt.value) === String(selected)) {
        b.classList.add('device-card__choice--active');
      }
      b.textContent = opt.label;
      b.dataset.choiceValue = String(opt.value);
      b.disabled = disabled;
      b.addEventListener('click', () => {
        if (b.disabled) return;
        selected = opt.value;
        buttons.forEach((item) => {
          item.classList.toggle('device-card__choice--active', item.dataset.choiceValue === String(selected));
        });
        notifyChange();
      });
      buttons.push(b);
      wrap.appendChild(b);
    });

    return {
      root: wrap,
      getValue: () => selected,
      hasSelection: () => selected != null,
      onChange(fn) {
        listeners.push(fn);
      },
      setDisabled(value) {
        buttons.forEach((item) => {
          item.disabled = value;
        });
      },
    };
  }

  function syncReleaseButtonWithPicker(releaseBtn, picker) {
    if (!releaseBtn || !picker) return;
    const update = () => {
      releaseBtn.disabled = !storeSelected() || !picker.hasSelection();
    };
    picker.onChange(update);
    update();
  }

  function appendReleaseButton(container, { label = 'Liberar', className = 'btn--primary', onRelease, disabled = false }) {
    const releaseBtn = btn(label, `device-card__release-btn ${className}`, onRelease);
    releaseBtn.disabled = disabled || !storeSelected();
    container.appendChild(releaseBtn);
    return releaseBtn;
  }

  function appendEndpointHint(container, deviceType, machine) {
    const path = deviceEndpointPath(deviceType, machine);
    if (!currentStore || !path) return;
    const p = document.createElement('p');
    p.className = 'device-card__endpoint';
    p.innerHTML = `<code>GET ${escapeHtml(fullGatewayPath(path))}</code>`;
    container.appendChild(p);
  }

  function appendPingRow(container, deviceType, machine) {
    const row = document.createElement('div');
    row.className = 'device-card__ping-row';
    const key = machine ? `${deviceType}:${machine}` : deviceType;
    const loading = probingDevices.has(key);
    const pingBtn = btn(loading ? 'Verificando…' : 'Verificar online', 'btn--ghost device-card__ping', () =>
      probeDeviceOnline(deviceType, machine || null)
    );
    pingBtn.disabled = loading || !storeSelected();
    row.appendChild(pingBtn);
    container.appendChild(row);
  }

  function devicePingLabel(deviceType, machine) {
    const names = { washer: 'Lavadora', dryer: 'Secadora', doser: 'Dosadora', ac: 'AC' };
    const name = names[deviceType] || deviceType;
    return machine ? `${name} ${machine}` : name;
  }

  async function probeDeviceOnline(deviceType, machine) {
    if (!currentStore) {
      showToast('Selecione uma loja', false);
      return;
    }
    const path = deviceEndpointPath(deviceType, machine);
    if (!path) return;

    const key = machine ? `${deviceType}:${machine}` : deviceType;
    if (probingDevices.has(key)) return;

    const label = devicePingLabel(deviceType, machine);
    probingDevices.add(key);
    renderDevices();

    try {
      const result = await gatewayRequest('GET', path, undefined, { allowHttpError: true });
      const online = extractOnlineFromProbeResult(result);
      if (!pingStatus) resetPingStatus();
      if (online === true || online === false) {
        if (deviceType === 'ac') pingStatus.ac = online;
        else pingStatus[`${deviceType}s`][machine] = online;
      }
      appendLog(`Ping ${label}`, online === true, { path: fullGatewayPath(path), ...result.data, online });
      if (online === true) showToast(`${label} — online`);
      else if (online === false) showToast(`${label} — offline`, false);
      else showToast(`${label} — resposta inconclusiva`, false);
    } catch (err) {
      showToast(`Ping ${label}: ${friendlyUserMessage(err.message)}`, false);
      appendLog(`Ping ${label}`, false, err.payload || err.message);
    } finally {
      probingDevices.delete(key);
      renderDevices();
    }
  }

  function createDeviceShell(id, online, fillContent) {
    const card = document.createElement('article');
    card.className = 'device-card device-card--tile';
    card.innerHTML = `
      <header class="device-card__head">
        <div class="device-card__title-row">
          <h3 class="device-card__id">${escapeHtml(String(id))}</h3>
        </div>
      </header>
    `;
    const head = card.querySelector('.device-card__head');
    head.insertAdjacentHTML('beforeend', onlinePill(online));
    fillContent(card);
    return card;
  }

  async function runGatewayAction(label, subpath, method = 'POST', body) {
    const result = await gatewayRequest(method, subpath, body);
    if (!result.ok) {
      const err = new Error(readGatewayError(result.data, result.status));
      err.payload = result.data;
      throw err;
    }
    return result.data;
  }

  async function runAction(label, fn) {
    if (actionBusy) return;
    if (!currentStore) {
      showToast('Selecione uma loja', false);
      return;
    }
    actionBusy = true;
    try {
      const data = await fn();
      showToast(`${label} — OK`);
      appendLog(label, true, data);
      return data;
    } catch (err) {
      showToast(`${label}: ${friendlyUserMessage(err.message)}`, false);
      appendLog(label, false, err.payload || err.message);
    } finally {
      actionBusy = false;
    }
  }

  function dosageLabel(am) {
    const opt = WASHER_DOSAGE_OPTIONS.find((o) => o.value === am);
    return opt?.label || am || 'Sem cheiro';
  }

  function renderWashers() {
    const grid = $('washersGrid');
    grid.innerHTML = '';
    const ids = gatewayConfig?.washers || [];
    $('washersCount').textContent = String(ids.length);
    const disabled = !storeSelected();

    ids.forEach((id) => {
      const online = pingStatus?.washers?.[id] ?? null;
      const card = createDeviceShell(id, online, (shell) => {
        appendEndpointHint(shell, 'washer', id);
        appendPingRow(shell, 'washer', id);

        const actions = document.createElement('div');
        actions.className = 'device-card__actions device-card__actions--washer';

        const dosageOptions = (gatewayConfig.washer_dosage_options || WASHER_DOSAGE_OPTIONS).map((o) => ({ ...o }));
        const picker = createChoicePicker(dosageOptions, { columns: 2, requireSelection: true, disabled });
        actions.appendChild(picker.root);

        const releaseBtn = appendReleaseButton(actions, {
          disabled: true,
          onRelease: () => {
            if (!picker.hasSelection()) return;
            const am = picker.getValue();
            const amLabel = am ? dosageLabel(am) : 'Sem cheiro';
            if (!confirm(`Confirmar liberação da lavadora ${id}?\nDosagem: ${amLabel}`)) return;
            runAction(`Lavadora ${id}`, () =>
              runGatewayAction(`Lavadora ${id}`, `washer/${id}`, 'POST', am ? { am } : {})
            );
          },
        });
        syncReleaseButtonWithPicker(releaseBtn, picker);
        shell.appendChild(actions);
      });
      card.dataset.washerId = id;
      grid.appendChild(card);
    });
  }

  function renderDryers() {
    const grid = $('dryersGrid');
    grid.innerHTML = '';
    const ids = gatewayConfig?.dryers || [];
    const minutes = gatewayConfig?.dryer_minutes || [15, 30, 45];
    $('dryersCount').textContent = String(ids.length);
    const disabled = !storeSelected();

    ids.forEach((id) => {
      const online = pingStatus?.dryers?.[id] ?? null;
      const card = createDeviceShell(id, online, (shell) => {
        appendEndpointHint(shell, 'dryer', id);
        appendPingRow(shell, 'dryer', id);

        const actions = document.createElement('div');
        actions.className = 'device-card__actions device-card__actions--dryer';

        const minuteOptions = minutes.map((min) => ({ value: String(min), label: `${min} min` }));
        const picker = createChoicePicker(minuteOptions, { columns: 3, requireSelection: true, disabled });
        actions.appendChild(picker.root);

        const releaseBtn = appendReleaseButton(actions, {
          disabled: true,
          onRelease: () => {
            if (!picker.hasSelection()) return;
            const mins = Number(picker.getValue());
            if (!confirm(`Iniciar secadora ${id} por ${mins} min?`)) return;
            runAction(`Secadora ${id} · ${mins} min`, () =>
              runGatewayAction(`Secadora ${id}`, `dryer/${id}`, 'POST', { minutes: mins })
            );
          },
        });
        syncReleaseButtonWithPicker(releaseBtn, picker);
        shell.appendChild(actions);
      });
      card.dataset.dryerId = id;
      grid.appendChild(card);
    });
  }

  function buildDoserActions(actions, id) {
    actions.classList.add('device-card__actions--doser');
    const disabled = !storeSelected();

    const picker = createChoicePicker(
      [
        { value: 'rele1on', label: 'Sabão' },
        { value: 'rele2on', label: 'Floral' },
        { value: 'rele3on', label: 'Sport' },
      ],
      { columns: 3, requireSelection: true, disabled }
    );
    actions.appendChild(picker.root);

    const releaseBtn = appendReleaseButton(actions, {
      label: 'Acionar',
      disabled: true,
      onRelease: () => {
        if (!picker.hasSelection()) return;
        const type = picker.getValue();
        const product = DOSER_TYPE_LABELS[type] || type;
        if (!confirm(`Acionar ${product} na dosadora ${id}?`)) return;
        runAction(`Dosadora ${id} · ${product}`, () =>
          runGatewayAction(`Dosadora ${id}`, `doser/${id}`, 'POST', { type })
        );
      },
    });
    syncReleaseButtonWithPicker(releaseBtn, picker);

    const consultRow = document.createElement('div');
    consultRow.className = 'device-card__action-row';
    consultRow.appendChild(
      btn('Consultar tempos salvos', 'btn--ghost device-card__action-wide', () => {
        if (!confirm(`Consultar tempos da dosadora ${id}?`)) return;
        runAction(`Consulta dosadora ${id}`, () =>
          runGatewayAction(`Consulta ${id}`, `doser/${id}/consulta`, 'GET')
        );
      })
    );
    actions.appendChild(consultRow);

    const panel = document.createElement('div');
    panel.className = 'device-card__panel';

    const panelLabel = document.createElement('span');
    panelLabel.className = 'device-card__panel-label';
    panelLabel.textContent = 'Ajuste de tempo';
    panel.appendChild(panelLabel);

    const timeField = document.createElement('div');
    timeField.className = 'device-card__time-field';

    const secInput = document.createElement('input');
    secInput.type = 'number';
    secInput.min = '1';
    secInput.max = '3600';
    secInput.value = '5';
    secInput.className = 'device-card__input';
    secInput.title = 'Segundos';
    secInput.setAttribute('aria-label', 'Segundos de dosagem');
    secInput.disabled = disabled;

    const secUnit = document.createElement('span');
    secUnit.className = 'device-card__time-unit';
    secUnit.textContent = 'seg';

    timeField.appendChild(secInput);
    timeField.appendChild(secUnit);
    panel.appendChild(timeField);

    const setGrid = document.createElement('div');
    setGrid.className = 'device-card__action-grid device-card__action-grid--3';
    ['sabao', 'floral', 'sport'].forEach((kind) => {
      const kindLabel = TEMPO_LABELS[kind] || kind;
      const setBtn = btn(kindLabel, 'btn--ghost', () => {
        const seconds = parseFloat(secInput.value) || 5;
        if (!confirm(`Ajustar ${kindLabel} da dosadora ${id} para ${seconds} seg?`)) return;
        runAction(`Ajuste ${id} · ${kindLabel}`, () =>
          runGatewayAction(`Ajuste ${id}`, `doser/${id}/settime/${kind}`, 'POST', { seconds })
        );
      });
      setBtn.disabled = disabled;
      setGrid.appendChild(setBtn);
    });
    panel.appendChild(setGrid);
    actions.appendChild(panel);
  }

  function renderDosers() {
    const grid = $('dosersGrid');
    grid.innerHTML = '';
    const ids = gatewayConfig?.dosers || [];
    $('dosersCount').textContent = String(ids.length);

    ids.forEach((id) => {
      const online = pingStatus?.dosers?.[id] ?? null;
      const card = createDeviceShell(id, online, (shell) => {
        appendEndpointHint(shell, 'doser', id);
        appendPingRow(shell, 'doser', id);
        const actions = document.createElement('div');
        actions.className = 'device-card__actions';
        buildDoserActions(actions, id);
        shell.appendChild(actions);
      });
      card.classList.add('device-card--doser');
      grid.appendChild(card);
    });
  }

  function renderAc() {
    const grid = $('acGrid');
    grid.innerHTML = '';
    const temps = gatewayConfig?.ac_temperatures || ['18', '22', 'off'];
    const online = pingStatus?.ac ?? null;
    const disabled = !storeSelected();

    const card = createDeviceShell('AC', online, (shell) => {
      appendEndpointHint(shell, 'ac');
      appendPingRow(shell, 'ac');

      const actions = document.createElement('div');
      actions.className = 'device-card__actions device-card__actions--ac';

      const tempOptions = temps.map((temp) => ({
        value: temp,
        label: temp === 'off' ? 'Desligar' : `${temp}°C`,
      }));
      const picker = createChoicePicker(tempOptions, { columns: 3, requireSelection: true, disabled });
      actions.appendChild(picker.root);

      const releaseBtn = appendReleaseButton(actions, {
        label: 'Acionar',
        disabled: true,
        onRelease: () => {
          if (!picker.hasSelection()) return;
          const temp = picker.getValue();
          const tempLabel = temp === 'off' ? 'Desligar' : `${temp}°C`;
          if (!confirm(`Confirmar AC · ${tempLabel}?`)) return;
          runAction(`AC · ${tempLabel}`, () =>
            runGatewayAction(`AC · ${tempLabel}`, 'ac', 'POST', { temperature: temp })
          );
        },
      });
      syncReleaseButtonWithPicker(releaseBtn, picker);
      shell.appendChild(actions);
    });
    grid.appendChild(card);
  }

  function renderLed() {
    const grid = $('ledGrid');
    grid.innerHTML = '';
    const disabled = !storeSelected();

    const card = createDeviceShell('LED', null, (shell) => {
      const p = document.createElement('p');
      p.className = 'device-card__endpoint';
      p.innerHTML = `<code>POST ${escapeHtml(currentStore ? `${currentStore}/led/on` : '{loja}/led/on')}</code>`;
      shell.appendChild(p);

      const actions = document.createElement('div');
      actions.className = 'device-card__actions';
      const onBtn = btn('Ligar', 'btn--success', () => {
        runAction('LED ligar', () => runGatewayAction('LED ligar', 'led/on', 'POST'));
      });
      const offBtn = btn('Desligar', 'btn--ghost', () => {
        runAction('LED desligar', () => runGatewayAction('LED desligar', 'led/off', 'POST'));
      });
      onBtn.disabled = disabled;
      offBtn.disabled = disabled;
      actions.appendChild(onBtn);
      actions.appendChild(offBtn);
      shell.appendChild(actions);
    });
    grid.appendChild(card);
  }

  function renderDevices() {
    if (!gatewayConfig) return;
    renderWashers();
    renderDryers();
    renderDosers();
    renderAc();
    renderLed();
  }

  function applyStore(fromUser = true) {
    const manual = normalizeStoreId($('storeManual').value);
    const selected = normalizeStoreId($('storeSelect').value);
    const next = manual || selected;
    if (!next) {
      if (fromUser) showToast('Informe o código da loja', false);
      return;
    }
    currentStore = next;
    const meta = (catalog?.stores || []).find((s) => s.id === next);
    const title = meta?.name ? `${meta.name} (${next.toUpperCase()})` : next.toUpperCase();
    $('storeMeta').textContent = `Loja: ${title}`;
    $('storeSelect').value = next;
    $('storeManual').value = next;
    updateStoreEndpointMeta();
    const url = new URL(window.location.href);
    url.searchParams.set('store', next);
    window.history.replaceState({}, '', url);
    resetPingStatus();
    renderDevices();
    gatewayDebug('Loja aplicada', { store: currentStore });
  }

  function populateStoreSelect() {
    const select = $('storeSelect');
    const stores = catalog?.stores || [];
    select.innerHTML = '<option value="">Selecione…</option>';
    stores.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = s.name ? `${s.name} (${s.id.toUpperCase()})` : s.id.toUpperCase();
      select.appendChild(opt);
    });
  }

  async function init() {
    const ok = await guardPage({ returnPath: `gateway.html${window.location.search}` });
    if (!ok) return;
    await mountUserMenu($('headerUserMenu'));

    try {
      await loadGatewayConfig();
      catalog = await loadCatalog();
      populateStoreSelect();
      resetPingStatus();
      renderDevices();
    } catch (err) {
      showToast(err.message, false);
    }

    checkApiHealth().catch(() => {});

    const initial = normalizeStoreId(new URLSearchParams(window.location.search).get('store'));
    if (initial) {
      $('storeManual').value = initial;
      $('storeSelect').value = initial;
      applyStore(false);
    }

    $('btnApplyStore').addEventListener('click', () => applyStore(true));
    $('storeSelect').addEventListener('change', () => {
      $('storeManual').value = $('storeSelect').value;
    });
    $('storeManual').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') applyStore(true);
    });
    $('btnApiHealth').addEventListener('click', () => checkApiHealth().catch(() => {}));
    $('btnClearLog').addEventListener('click', () => {
      $('responseLog').innerHTML = '';
    });
  }

  init().catch((err) => {
    document.body.classList.remove('auth-pending');
    gatewayDebug('init erro', err.message);
    showToast(err.message || 'Erro ao iniciar', false);
  });

  gatewayDebug('gateway.js carregado — sem verificação em massa');
})();
