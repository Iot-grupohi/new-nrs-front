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
  let statusLoading = false;
  let actionBusy = false;
  const washerAm = {};
  const probingDevices = new Set();

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

  function setStatusLoading(value) {
    statusLoading = value;
    const btn = $('btnRefreshStatus');
    if (btn) {
      btn.disabled = value;
      btn.setAttribute('aria-busy', value ? 'true' : 'false');
    }
    $('summaryGrid')?.classList.toggle('gateway-panel--loading', value);
    $('devicesPanel')?.classList.toggle('gateway-panel--loading', value);
  }

  function appendLog(label, ok, payload) {
    const list = $('responseLog');
    if (!list) return;
    const item = document.createElement('li');
    item.className = `gateway-log__item ${ok ? 'gateway-log__item--ok' : 'gateway-log__item--err'}`;
    const preview =
      typeof payload === 'string'
        ? payload
        : JSON.stringify(payload, null, 0).slice(0, 280);
    item.innerHTML = `<time>${new Date().toLocaleTimeString('pt-BR')}</time>
      <strong>${escapeHtml(label)}</strong>
      <code>${escapeHtml(preview)}</code>`;
    list.prepend(item);
    while (list.children.length > MAX_LOG) list.removeChild(list.lastChild);
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
    const fetchOptions = {
      method,
      headers: { Accept: 'application/json' },
    };
    if (body !== undefined) {
      fetchOptions.headers['Content-Type'] = 'application/json';
      fetchOptions.body = JSON.stringify(body);
    }
    const res = await panelFetch(url, fetchOptions);
    let data;
    try {
      data = await res.json();
    } catch {
      data = { detail: `HTTP ${res.status}` };
    }
    if (!res.ok && !options.allowHttpError) {
      const err = new Error(readGatewayError(data, res.status));
      err.payload = data;
      err.httpStatus = res.status;
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

  function onlinePill(online) {
    if (online === true) return '<span class="device-card__status pill pill--on">Online</span>';
    if (online === false) return '<span class="device-card__status pill pill--off">Offline</span>';
    return '<span class="device-card__status pill pill--warn">Desconhecido</span>';
  }

  function isOperable(online) {
    return online === true;
  }

  function cardBlockedClass(online) {
    return online === false ? ' device-card--blocked' : '';
  }

  function disabledAttr(online) {
    return isOperable(online) ? '' : ' disabled';
  }

  function renderPingButton(deviceType, machine, options = {}) {
    const key = machine ? `${deviceType}:${machine}` : deviceType;
    const loading = probingDevices.has(key);
    const machineAttr = machine ? ` data-machine="${escapeHtml(machine)}"` : '';
    const text = loading ? 'Verificando…' : (options.label || 'Verificar online');
    return `<button type="button" class="btn btn--sm btn--ghost device-card__ping" data-action="device-ping" data-device-type="${escapeHtml(deviceType)}"${machineAttr}${loading ? ' disabled aria-busy="true"' : ''}>${escapeHtml(text)}</button>`;
  }

  function ensureStatusData() {
    if (statusData) return;
    statusData = {
      store: currentStore,
      esp_online: null,
      esp_error: null,
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
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true' || normalized === 'online' || normalized === '1' || normalized === 'yes') {
        return true;
      }
      if (normalized === 'false' || normalized === 'offline' || normalized === '0' || normalized === 'no') {
        return false;
      }
    }
    return null;
  }

  function extractOnlineFromProbeResult(result) {
    const data = result.data || {};
    const fromOnline = parseOnlineFlag(data.online);
    if (fromOnline !== null) return fromOnline;

    const fromStatus = parseOnlineFlag(data.status);
    if (fromStatus !== null) return fromStatus;

    const upstream = Number(data.upstream_status);
    if (upstream === 200) return true;
    if (upstream >= 400) return false;
    if (result.ok) return true;
    if (result.status >= 400) return false;
    return null;
  }

  function devicePingLabel(deviceType, machine) {
    const names = { washer: 'Lavadora', dryer: 'Secadora', doser: 'Dosadora', ac: 'Ar-condicionado' };
    const name = names[deviceType] || deviceType;
    return machine ? `${name} ${machine}` : name;
  }

  async function probeDeviceOnline(deviceType, machine) {
    if (!currentStore) {
      showToast('Selecione uma loja', false);
      return;
    }
    const key = machine ? `${deviceType}:${machine}` : deviceType;
    if (probingDevices.has(key)) return;

    const paths = {
      washer: `status/washer/${machine}`,
      dryer: `status/dryer/${machine}`,
      doser: `status/doser/${machine}`,
      ac: 'status/ac',
    };
    const path = paths[deviceType];
    if (!path) return;

    const label = devicePingLabel(deviceType, machine);
    probingDevices.add(key);
    renderDevices();

    try {
      const result = await gatewayRequest('GET', path, undefined, { allowHttpError: true });
      const online = extractOnlineFromProbeResult(result);
      ensureStatusData();

      if (deviceType === 'ac') {
        statusData.ac = online;
      } else {
        statusData[`${deviceType}s`][machine] = online;
      }

      if (online === true) {
        statusData.esp_online = true;
        statusData.esp_error = null;
      }

      appendLog(`Ping ${label}`, online === true, {
        ...result.data,
        http: result.status,
        online,
      });
      if (online === true) {
        showToast(`${label} — online`);
      } else if (online === false) {
        showToast(`${label} — offline`, false);
      } else {
        showToast(`${label} — resposta inconclusiva`, false);
      }
    } catch (err) {
      showToast(`Ping ${label}: ${friendlyUserMessage(err.message)}`, false);
      appendLog(`Ping ${label}`, false, err.payload || err.message);
    } finally {
      probingDevices.delete(key);
      renderDevices();
    }
  }

  function formatEspError(raw) {
    if (!raw) return 'Gateway ESP8266 não respondeu via MQTT.';
    const text = String(raw);
    const lower = text.toLowerCase();
    if (lower.includes('read timed out') || lower.includes('httpsconnectionpool')) {
      return 'Gateway MQTT demorou para responder. ESP8266 da loja pode estar offline ou fora do broker.';
    }
    if (lower.includes('did not respond')) {
      return text;
    }
    return friendlyUserMessage(text);
  }

  function updateEspStatus() {
    const meta = $('espStatusMeta');
    const alert = $('espAlert');
    if (!meta || !alert) return;

    if (!statusData) {
      meta.textContent = 'ESP8266: —';
      meta.className = 'gateway-meta';
      alert.classList.add('hidden');
      alert.textContent = '';
      return;
    }

    if (statusData.esp_online === true) {
      meta.textContent = 'ESP8266: online (MQTT)';
      meta.className = 'gateway-meta gateway-meta--ok';
      alert.classList.add('hidden');
      alert.textContent = '';
      return;
    }

    meta.textContent = 'ESP8266: offline ou sem resposta';
    meta.className = 'gateway-meta gateway-meta--err';
    alert.textContent = formatEspError(statusData.esp_error);
    alert.classList.remove('hidden');
  }

  function renderSummary() {
    const washers = gatewayConfig?.washers || [];
    const dryers = gatewayConfig?.dryers || [];
    const dosers = gatewayConfig?.dosers || [];
    const ids = [...washers, ...dryers, ...dosers];
    let online = 0;
    let total = ids.length + 1;

    washers.forEach((id) => {
      if (statusData?.washers?.[id] === true) online += 1;
    });
    dryers.forEach((id) => {
      if (statusData?.dryers?.[id] === true) online += 1;
    });
    dosers.forEach((id) => {
      if (statusData?.dosers?.[id] === true) online += 1;
    });
    if (statusData?.ac === true) online += 1;

    const pct = total ? Math.round((online / total) * 100) : 0;
    $('summaryOnline').textContent = String(online);
    $('summaryTotal').textContent = `de ${total} total`;
    $('summaryHealth').textContent = `${pct}%`;
    $('summaryHealthBar').style.width = `${pct}%`;
  }

  function renderWashers() {
    const grid = $('washersGrid');
    const ids = gatewayConfig?.washers || [];
    $('washersCount').textContent = String(ids.length);
    grid.innerHTML = ids
      .map((id) => {
        const online = statusData?.washers?.[id];
        const am = washerAm[id] || '';
        const amOptions = (gatewayConfig?.washer_am_options || []).map(
          (v) =>
            `<option value="${escapeHtml(v)}"${am === v ? ' selected' : ''}>${escapeHtml(v)}</option>`
        );
        return `<article class="device-card device-card--tile${cardBlockedClass(online)}">
          <div class="device-card__head">
            <div class="device-card__title-row">
              <span class="device-card__id">${escapeHtml(id)}</span>
              ${onlinePill(online)}
            </div>
            ${online === false ? '<p class="device-card__hint">Offline — comando bloqueado</p>' : ''}
          </div>
          <div class="device-card__ping-row">${renderPingButton('washer', id)}</div>
          <div class="device-card__actions device-card__actions--washer">
            <select class="device-card__select" data-am-for="${escapeHtml(id)}" aria-label="Dosagem AM"${disabledAttr(online)}>
              <option value="">Sem AM</option>
              ${amOptions.join('')}
            </select>
            <button type="button" class="btn btn--primary device-card__release-btn" data-action="washer-release" data-machine="${escapeHtml(id)}"${disabledAttr(online)}>Liberar</button>
          </div>
        </article>`;
      })
      .join('');
  }

  function renderDryers() {
    const grid = $('dryersGrid');
    const ids = gatewayConfig?.dryers || [];
    const minutes = gatewayConfig?.dryer_minutes || [15, 30, 45];
    $('dryersCount').textContent = String(ids.length);
    grid.innerHTML = ids
      .map((id) => {
        const online = statusData?.dryers?.[id];
        const btns = minutes
          .map(
            (m) =>
              `<button type="button" class="btn btn--warning" data-action="dryer-start" data-machine="${escapeHtml(id)}" data-minutes="${m}"${disabledAttr(online)}>${m} min</button>`
          )
          .join('');
        return `<article class="device-card device-card--tile${cardBlockedClass(online)}">
          <div class="device-card__head">
            <div class="device-card__title-row">
              <span class="device-card__id">${escapeHtml(id)}</span>
              ${onlinePill(online)}
            </div>
            ${online === false ? '<p class="device-card__hint">Offline — comando bloqueado</p>' : ''}
          </div>
          <div class="device-card__ping-row">${renderPingButton('dryer', id)}</div>
          <div class="device-card__actions device-card__actions--dryer">${btns}</div>
        </article>`;
      })
      .join('');
  }

  function renderDosers() {
    const grid = $('dosersGrid');
    const ids = gatewayConfig?.dosers || [];
    $('dosersCount').textContent = String(ids.length);
    grid.innerHTML = ids
      .map((id) => {
        const online = statusData?.dosers?.[id];
        return `<article class="device-card device-card--tile device-card--doser${cardBlockedClass(online)}">
          <div class="device-card__head">
            <div class="device-card__title-row">
              <span class="device-card__id">${escapeHtml(id)}</span>
              ${onlinePill(online)}
            </div>
            ${online === false ? '<p class="device-card__hint">Offline — consulta e comandos bloqueados</p>' : ''}
          </div>
          <div class="device-card__ping-row">${renderPingButton('doser', id)}</div>
          <div class="device-card__actions device-card__actions--doser">
            <div class="device-card__action-grid device-card__action-grid--3">
              <button type="button" class="btn btn--ghost" data-action="doser-rele" data-machine="${escapeHtml(id)}" data-type="rele1on"${disabledAttr(online)}>Sabão</button>
              <button type="button" class="btn btn--ghost" data-action="doser-rele" data-machine="${escapeHtml(id)}" data-type="rele2on"${disabledAttr(online)}>Floral</button>
              <button type="button" class="btn btn--ghost" data-action="doser-rele" data-machine="${escapeHtml(id)}" data-type="rele3on"${disabledAttr(online)}>Sport</button>
            </div>
            <div class="device-card__action-row">
              <button type="button" class="btn btn--primary device-card__action-wide" data-action="doser-consulta" data-machine="${escapeHtml(id)}"${disabledAttr(online)}>Consulta tempos</button>
            </div>
            <div class="device-card__action-grid device-card__action-grid--3">
              <button type="button" class="btn btn--success" data-action="doser-amaciante" data-machine="${escapeHtml(id)}"${disabledAttr(online)}>Amaciante</button>
              <button type="button" class="btn btn--success" data-action="doser-dosagem" data-machine="${escapeHtml(id)}"${disabledAttr(online)}>Dosagem</button>
              <button type="button" class="btn btn--ghost" data-action="doser-device-status" data-machine="${escapeHtml(id)}"${disabledAttr(online)}>HTTP status</button>
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
    $('acGrid').innerHTML = `<article class="device-card device-card--tile${cardBlockedClass(online)}">
      <div class="device-card__head">
        <div class="device-card__title-row">
          <span class="device-card__id">AC</span>
          ${onlinePill(online)}
        </div>
        ${online === false ? '<p class="device-card__hint">Offline — comando bloqueado</p>' : ''}
      </div>
      <div class="device-card__ping-row">${renderPingButton('ac')}</div>
      <div class="device-card__actions device-card__actions--ac">
        ${temps
          .map(
            (t) =>
              `<button type="button" class="btn btn--primary" data-action="ac-set" data-temp="${escapeHtml(t)}"${disabledAttr(online)}>${escapeHtml(labels[t] || t)}</button>`
          )
          .join('')}
      </div>
    </article>`;
  }

  function renderLed() {
    const espOk = statusData?.esp_online === true;
    $('ledGrid').innerHTML = `<article class="device-card device-card--tile${espOk ? '' : ' device-card--blocked'}">
      <div class="device-card__head">
        <div class="device-card__title-row">
          <span class="device-card__id">LED</span>
          ${onlinePill(espOk)}
        </div>
        ${!espOk ? '<p class="device-card__hint">ESP8266 offline — LED bloqueado</p>' : ''}
      </div>
      <div class="device-card__actions">
        <button type="button" class="btn btn--success" data-action="led-on"${disabledAttr(espOk)}>Ligar</button>
        <button type="button" class="btn btn--ghost" data-action="led-off"${disabledAttr(espOk)}>Desligar</button>
      </div>
    </article>`;
  }

  function renderDevices() {
    renderWashers();
    renderDryers();
    renderDosers();
    renderAc();
    renderLed();
    renderSummary();
    updateEspStatus();
  }

  async function refreshStatus() {
    if (!currentStore) {
      showToast('Selecione uma loja', false);
      return;
    }
    if (statusLoading) return;
    $('statusTime').textContent = 'Status: carregando…';
    setStatusLoading(true);
    try {
      const res = await panelFetch(`/api/gateway/${encodeURIComponent(currentStore)}/status-summary`);
      const data = await res.json();
      if (!res.ok) throw new Error(readGatewayError(data, res.status));
      statusData = data;
      $('statusTime').textContent = `Status: ${new Date().toLocaleTimeString('pt-BR')}`;
      renderDevices();
      appendLog(`Status ${currentStore}`, true, statusData);
    } catch (err) {
      statusData = null;
      $('statusTime').textContent = 'Status: erro';
      renderDevices();
      showToast(err.message, false);
      appendLog(`Status ${currentStore}`, false, err.message);
    } finally {
      setStatusLoading(false);
    }
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

  function ensureDeviceOnline(type, machine) {
    if (!statusData) return true;
    if (type === 'ac') return isOperable(statusData.ac);
    if (type === 'esp') return statusData.esp_online === true;
    const block = statusData[`${type}s`] || statusData[type];
    if (typeof block === 'object' && block && machine in block) {
      return isOperable(block[machine]);
    }
    return true;
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
      await refreshStatus().catch(() => {});
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
    const url = new URL(window.location.href);
    url.searchParams.set('store', next);
    window.history.replaceState({}, '', url);
    statusData = null;
    renderDevices();
    refreshStatus().catch(() => {});
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
      if (!ensureDeviceOnline('washer', machine)) {
        showToast(`Lavadora ${machine} offline`, false);
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
      if (!ensureDeviceOnline('dryer', machine)) {
        showToast(`Secadora ${machine} offline`, false);
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
      if (!ensureDeviceOnline('ac')) {
        showToast('Ar-condicionado offline', false);
        return;
      }
      const temp = btn.dataset.temp;
      const label = temp === 'off' ? 'AC desligar' : `AC ${temp}°C`;
      if (!confirm(`Confirmar ${label}?`)) return;
      await runAction(label, () => runGatewayAction(label, 'ac', 'POST', { temperature: temp }));
      return;
    }

    if (action === 'doser-rele') {
      if (!ensureDeviceOnline('doser', machine)) {
        showToast(`Dosadora ${machine} offline`, false);
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
      if (!ensureDeviceOnline('doser', machine)) {
        showToast(`Dosadora ${machine} offline — consulta indisponível`, false);
        return;
      }
      await runAction(`Consulta ${machine}`, () =>
        runGatewayAction(`Consulta ${machine}`, `doser/${machine}/consulta`, 'GET')
      );
      return;
    }

    if (action === 'doser-amaciante') {
      if (!ensureDeviceOnline('doser', machine)) {
        showToast(`Dosadora ${machine} offline`, false);
        return;
      }
      if (!confirm(`Amaciante na dosadora ${machine}?`)) return;
      await runAction(`Amaciante ${machine}`, () =>
        runGatewayAction(`Amaciante ${machine}`, `doser/${machine}/amaciante`, 'POST')
      );
      return;
    }

    if (action === 'doser-dosagem') {
      if (!ensureDeviceOnline('doser', machine)) {
        showToast(`Dosadora ${machine} offline`, false);
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
      if (!ensureDeviceOnline('esp')) {
        showToast('ESP8266 offline — LED indisponível', false);
        return;
      }
      await runAction('LED ligar', () => runGatewayAction('LED ligar', 'led/on', 'POST'));
      return;
    }

    if (action === 'led-off') {
      if (!ensureDeviceOnline('esp')) {
        showToast('ESP8266 offline — LED indisponível', false);
        return;
      }
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
    } catch (err) {
      showToast(err.message, false);
    }

    renderDevices();
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
    $('btnRefreshStatus').addEventListener('click', () => refreshStatus());
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
    showToast(err.message || 'Erro ao iniciar', false);
  });
})();
