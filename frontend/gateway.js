(() => {
  'use strict';

  const { loadCatalog, friendlyUserMessage } = window.Lav60;
  const { guardPage, mountUserMenu, panelFetch } = window.Lav60Auth;

  const $ = (id) => document.getElementById(id);
  const MAX_LOG = 10;

  let gatewayConfig = null;
  let catalog = null;
  let currentStore = '';
  let statusData = null;
  let actionBusy = false;
  const washerAm = {};
  const probingDevices = new Set();

  const STATUS_PATHS = {
    washer: (id) => `status/washer/${id}`,
    dryer: (id) => `status/dryer/${id}`,
    doser: (id) => `status/doser/${id}`,
    ac: () => 'status/ac',
  };

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

  function deviceEndpointPath(deviceType, machine) {
    const build = STATUS_PATHS[deviceType];
    if (!build) return '';
    return build(machine);
  }

  function fullGatewayPath(subpath) {
    return currentStore ? `${currentStore}/${subpath.replace(/^\//, '')}` : subpath;
  }

  function updateStoreEndpointMeta() {
    const el = $('storeEndpointMeta');
    if (!el) return;
    el.textContent = currentStore
      ? `GET ${currentStore}/status/{tipo}/{id}`
      : 'Endpoint: selecione a loja';
  }

  async function loadGatewayConfig() {
    const res = await panelFetch('/api/gateway/config');
    if (!res.ok) throw new Error('Configuração do gateway indisponível');
    gatewayConfig = await res.json();
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

  function resetStatusData() {
    statusData = {
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

  function disabledIfOffline(online) {
    return online === false ? ' disabled' : '';
  }

  function blockedIfOffline(online) {
    return online === false ? ' device-card--blocked' : '';
  }

  function renderEndpointHint(deviceType, machine) {
    const path = deviceEndpointPath(deviceType, machine);
    if (!currentStore || !path) return '';
    return `<p class="device-card__endpoint"><code>GET ${escapeHtml(fullGatewayPath(path))}</code></p>`;
  }

  function renderPingButton(deviceType, machine) {
    const key = machine ? `${deviceType}:${machine}` : deviceType;
    const loading = probingDevices.has(key);
    const machineAttr = machine ? ` data-machine="${escapeHtml(machine)}"` : '';
    const text = loading ? 'Verificando…' : 'Verificar online';
    return `<button type="button" class="btn btn--sm btn--ghost device-card__ping" data-action="device-ping" data-device-type="${escapeHtml(deviceType)}"${machineAttr}${loading ? ' disabled aria-busy="true"' : ''}>${text}</button>`;
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
      if (!statusData) resetStatusData();

      if (online === true || online === false) {
        if (deviceType === 'ac') statusData.ac = online;
        else statusData[`${deviceType}s`][machine] = online;
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

  function isDeviceBlocked(type, machine) {
    if (!statusData) return false;
    if (type === 'ac') return statusData.ac === false;
    const block = statusData[`${type}s`];
    return block && machine in block && block[machine] === false;
  }

  function renderWashers() {
    const ids = gatewayConfig?.washers || [];
    $('washersCount').textContent = String(ids.length);
    $('washersGrid').innerHTML = ids
      .map((id) => {
        const online = statusData?.washers?.[id];
        const am = washerAm[id] || '';
        const amOptions = (gatewayConfig?.washer_am_options || []).map(
          (v) => `<option value="${escapeHtml(v)}"${am === v ? ' selected' : ''}>${escapeHtml(v)}</option>`
        );
        return `<article class="device-card device-card--tile${blockedIfOffline(online)}">
          <div class="device-card__head">
            <div class="device-card__title-row">
              <span class="device-card__id">${escapeHtml(id)}</span>
              ${onlinePill(online)}
            </div>
          </div>
          ${renderEndpointHint('washer', id)}
          <div class="device-card__ping-row">${renderPingButton('washer', id)}</div>
          <div class="device-card__actions device-card__actions--washer">
            <select class="device-card__select" data-am-for="${escapeHtml(id)}" aria-label="Dosagem AM"${disabledIfOffline(online)}>
              <option value="">Sem AM</option>
              ${amOptions.join('')}
            </select>
            <button type="button" class="btn btn--primary device-card__release-btn" data-action="washer-release" data-machine="${escapeHtml(id)}"${disabledIfOffline(online)}>Liberar</button>
          </div>
        </article>`;
      })
      .join('');
  }

  function renderDryers() {
    const ids = gatewayConfig?.dryers || [];
    const minutes = gatewayConfig?.dryer_minutes || [15, 30, 45];
    $('dryersCount').textContent = String(ids.length);
    $('dryersGrid').innerHTML = ids
      .map((id) => {
        const online = statusData?.dryers?.[id];
        const btns = minutes
          .map(
            (m) =>
              `<button type="button" class="btn btn--warning" data-action="dryer-start" data-machine="${escapeHtml(id)}" data-minutes="${m}"${disabledIfOffline(online)}>${m} min</button>`
          )
          .join('');
        return `<article class="device-card device-card--tile${blockedIfOffline(online)}">
          <div class="device-card__head">
            <div class="device-card__title-row">
              <span class="device-card__id">${escapeHtml(id)}</span>
              ${onlinePill(online)}
            </div>
          </div>
          ${renderEndpointHint('dryer', id)}
          <div class="device-card__ping-row">${renderPingButton('dryer', id)}</div>
          <div class="device-card__actions device-card__actions--dryer">${btns}</div>
        </article>`;
      })
      .join('');
  }

  function renderDosers() {
    const ids = gatewayConfig?.dosers || [];
    $('dosersCount').textContent = String(ids.length);
    $('dosersGrid').innerHTML = ids
      .map((id) => {
        const online = statusData?.dosers?.[id];
        return `<article class="device-card device-card--tile device-card--doser${blockedIfOffline(online)}">
          <div class="device-card__head">
            <div class="device-card__title-row">
              <span class="device-card__id">${escapeHtml(id)}</span>
              ${onlinePill(online)}
            </div>
          </div>
          ${renderEndpointHint('doser', id)}
          <div class="device-card__ping-row">${renderPingButton('doser', id)}</div>
          <div class="device-card__actions device-card__actions--doser">
            <div class="device-card__action-grid device-card__action-grid--3">
              <button type="button" class="btn btn--ghost" data-action="doser-rele" data-machine="${escapeHtml(id)}" data-type="rele1on"${disabledIfOffline(online)}>Sabão</button>
              <button type="button" class="btn btn--ghost" data-action="doser-rele" data-machine="${escapeHtml(id)}" data-type="rele2on"${disabledIfOffline(online)}>Floral</button>
              <button type="button" class="btn btn--ghost" data-action="doser-rele" data-machine="${escapeHtml(id)}" data-type="rele3on"${disabledIfOffline(online)}>Sport</button>
            </div>
            <div class="device-card__action-row">
              <button type="button" class="btn btn--primary device-card__action-wide" data-action="doser-consulta" data-machine="${escapeHtml(id)}"${disabledIfOffline(online)}>Consulta tempos</button>
            </div>
            <div class="device-card__action-grid device-card__action-grid--3">
              <button type="button" class="btn btn--success" data-action="doser-amaciante" data-machine="${escapeHtml(id)}"${disabledIfOffline(online)}>Amaciante</button>
              <button type="button" class="btn btn--success" data-action="doser-dosagem" data-machine="${escapeHtml(id)}"${disabledIfOffline(online)}>Dosagem</button>
              <button type="button" class="btn btn--ghost" data-action="doser-device-status" data-machine="${escapeHtml(id)}"${disabledIfOffline(online)}>HTTP status</button>
            </div>
          </div>
        </article>`;
      })
      .join('');
  }

  function renderAc() {
    const temps = gatewayConfig?.ac_temperatures || ['18', '22', 'off'];
    const online = statusData?.ac;
    const labels = { 18: '18°C', 22: '22°C', off: 'Desligar' };
    $('acGrid').innerHTML = `<article class="device-card device-card--tile${blockedIfOffline(online)}">
      <div class="device-card__head">
        <div class="device-card__title-row">
          <span class="device-card__id">AC</span>
          ${onlinePill(online)}
        </div>
      </div>
      ${renderEndpointHint('ac')}
      <div class="device-card__ping-row">${renderPingButton('ac')}</div>
      <div class="device-card__actions device-card__actions--ac">
        ${temps
          .map(
            (t) =>
              `<button type="button" class="btn btn--primary" data-action="ac-set" data-temp="${escapeHtml(t)}"${disabledIfOffline(online)}>${escapeHtml(labels[t] || t)}</button>`
          )
          .join('')}
      </div>
    </article>`;
  }

  function renderLed() {
    const disabled = currentStore ? '' : ' disabled';
    $('ledGrid').innerHTML = `<article class="device-card device-card--tile">
      <div class="device-card__head">
        <div class="device-card__title-row">
          <span class="device-card__id">LED</span>
        </div>
      </div>
      <p class="device-card__endpoint"><code>POST ${escapeHtml(currentStore ? `${currentStore}/led/on` : '{loja}/led/on')}</code></p>
      <div class="device-card__actions">
        <button type="button" class="btn btn--success" data-action="led-on"${disabled}>Ligar</button>
        <button type="button" class="btn btn--ghost" data-action="led-off"${disabled}>Desligar</button>
      </div>
    </article>`;
  }

  function renderDevices() {
    if (!gatewayConfig) return;
    renderWashers();
    renderDryers();
    renderDosers();
    renderAc();
    renderLed();
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
    resetStatusData();
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

  async function handlePanelClick(event) {
    const btn = event.target.closest('[data-action]');
    if (!btn || actionBusy) return;

    const action = btn.dataset.action;
    const machine = btn.dataset.machine;

    if (action === 'device-ping') {
      await probeDeviceOnline(btn.dataset.deviceType, machine || null);
      return;
    }

    if (action === 'washer-release') {
      if (isDeviceBlocked('washer', machine)) {
        showToast(`Lavadora ${machine} offline — verifique antes`, false);
        return;
      }
      const am = washerAm[machine] || '';
      const label = am ? `Lavadora ${machine} + ${am}` : `Lavadora ${machine}`;
      if (!confirm(`Confirmar liberação da lavadora ${machine}?`)) return;
      await runAction(label, () =>
        runGatewayAction(label, `washer/${machine}`, 'POST', am ? { am } : undefined)
      );
      return;
    }

    if (action === 'dryer-start') {
      if (isDeviceBlocked('dryer', machine)) {
        showToast(`Secadora ${machine} offline — verifique antes`, false);
        return;
      }
      const minutes = Number(btn.dataset.minutes);
      if (!confirm(`Iniciar secadora ${machine} por ${minutes} min?`)) return;
      await runAction(`Secadora ${machine} ${minutes}min`, () =>
        runGatewayAction(`Secadora ${machine}`, `dryer/${machine}`, 'POST', { minutes })
      );
      return;
    }

    if (action === 'ac-set') {
      if (isDeviceBlocked('ac')) {
        showToast('AC offline — verifique antes', false);
        return;
      }
      const temp = btn.dataset.temp;
      const label = temp === 'off' ? 'AC desligar' : `AC ${temp}°C`;
      if (!confirm(`Confirmar ${label}?`)) return;
      await runAction(label, () => runGatewayAction(label, 'ac', 'POST', { temperature: temp }));
      return;
    }

    if (action === 'doser-rele') {
      if (isDeviceBlocked('doser', machine)) {
        showToast(`Dosadora ${machine} offline — verifique antes`, false);
        return;
      }
      const type = btn.dataset.type;
      if (!confirm(`Acionar ${type} na dosadora ${machine}?`)) return;
      await runAction(`Dosador ${machine} ${type}`, () =>
        runGatewayAction(`Dosador ${machine}`, `doser/${machine}`, 'POST', { type })
      );
      return;
    }

    if (action === 'doser-consulta') {
      if (isDeviceBlocked('doser', machine)) {
        showToast(`Dosadora ${machine} offline — verifique antes`, false);
        return;
      }
      await runAction(`Consulta ${machine}`, () =>
        runGatewayAction(`Consulta ${machine}`, `doser/${machine}/consulta`, 'GET')
      );
      return;
    }

    if (action === 'doser-amaciante') {
      if (isDeviceBlocked('doser', machine)) {
        showToast(`Dosadora ${machine} offline — verifique antes`, false);
        return;
      }
      if (!confirm(`Amaciante na dosadora ${machine}?`)) return;
      await runAction(`Amaciante ${machine}`, () =>
        runGatewayAction(`Amaciante ${machine}`, `doser/${machine}/amaciante`, 'POST')
      );
      return;
    }

    if (action === 'doser-dosagem') {
      if (isDeviceBlocked('doser', machine)) {
        showToast(`Dosadora ${machine} offline — verifique antes`, false);
        return;
      }
      if (!confirm(`Dosagem na dosadora ${machine}?`)) return;
      await runAction(`Dosagem ${machine}`, () =>
        runGatewayAction(`Dosagem ${machine}`, `doser/${machine}/dosagem`, 'POST')
      );
      return;
    }

    if (action === 'doser-device-status') {
      await runAction(`Device status ${machine}`, () =>
        runGatewayAction(`Device status ${machine}`, `doser/${machine}/device-status`, 'GET')
      );
      return;
    }

    if (action === 'led-on') {
      await runAction('LED ligar', () => runGatewayAction('LED ligar', 'led/on', 'POST'));
      return;
    }

    if (action === 'led-off') {
      await runAction('LED desligar', () => runGatewayAction('LED desligar', 'led/off', 'POST'));
    }
  }

  async function init() {
    const ok = await guardPage({ returnPath: `gateway.html${window.location.search}` });
    if (!ok) return;
    await mountUserMenu($('headerUserMenu'));

    try {
      await loadGatewayConfig();
      catalog = await loadCatalog();
      populateStoreSelect();
      resetStatusData();
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
    $('devicesPanel').addEventListener('click', handlePanelClick);
    $('ledGrid').addEventListener('click', handlePanelClick);
    $('acGrid').addEventListener('click', handlePanelClick);
    $('devicesPanel').addEventListener('change', (e) => {
      const sel = e.target.closest('[data-am-for]');
      if (!sel) return;
      washerAm[sel.dataset.amFor] = sel.value;
    });
  }

  init().catch((err) => {
    document.body.classList.remove('auth-pending');
    gatewayDebug('init erro', err.message);
    showToast(err.message || 'Erro ao iniciar', false);
  });

  gatewayDebug('gateway.js carregado — debug no console (F12)');
})();
