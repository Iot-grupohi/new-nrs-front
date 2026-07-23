(() => {
  'use strict';

  const TEMPO_LABELS = { sabao: 'Sabão', floral: 'Floral', sport: 'Sport' };
  const RELE_LABELS = { 1: 'Sabão', 2: 'Floral', 3: 'Sport' };
  const DOSER_TYPE_LABELS = { rele1on: 'Sabão', rele2on: 'Floral', rele3on: 'Sport' };

  function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = String(text ?? '');
    return d.innerHTML;
  }

  function dosageLabel(am) {
    const options = window.Lav60?.WASHER_DOSAGE_OPTIONS || [];
    const opt = options.find((o) => o.value === am);
    return opt ? opt.label : am;
  }

  function renderInfoRows(rows) {
    if (!rows.length) return '';
    return `<dl class="confirm-info">${rows
      .map(
        ([label, value]) =>
          `<div class="confirm-info__row"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`
      )
      .join('')}</dl>`;
  }

  function renderTemposGrid(tempos) {
    return `<div class="confirm-tempos">${['sabao', 'floral', 'sport']
      .map((key) => {
        const val = tempos[key];
        return `<div class="confirm-tempos__item">
          <span class="confirm-tempos__label">${TEMPO_LABELS[key]}</span>
          <strong class="confirm-tempos__value">${val != null ? val : '—'}</strong>
          <span class="confirm-tempos__unit">seg</span>
        </div>`;
      })
      .join('')}</div>`;
  }

  function cleanConfirmMessage(message) {
    if (!message) return '';
    return String(message)
      .replace(/\s*—\s*washer.*?$/i, '')
      .replace(/\s*\(.*background.*\)/i, '')
      .replace(/\bOK\b\s*—?\s*/gi, '')
      .trim();
  }

  function formatConfirmMessage(label, data) {
    if (data.tempos) return 'Consulta realizada com sucesso.';
    if (data.message) return cleanConfirmMessage(data.message) || `${label} concluído.`;
    return `${label} concluído com sucesso.`;
  }

  function buildConfirmView(label, data) {
    if (data.tempos && typeof data.tempos === 'object') {
      return {
        title: 'Consulta de tempos',
        message: data.machine ? `Dosadora ${data.machine}` : '',
        bodyHtml: renderTemposGrid(data.tempos),
      };
    }

    if (data.seconds != null && data.machine) {
      const rows = [['Equipamento', data.machine]];
      if (data.rele) rows.push(['Produto', RELE_LABELS[data.rele] || `Relé ${data.rele}`]);
      rows.push(['Tempo', `${data.seconds} seg`]);
      return {
        title: 'Tempo configurado',
        message: 'Configuração aplicada com sucesso.',
        bodyHtml: renderInfoRows(rows),
      };
    }

    if (data.doser || data.washer) {
      const rows = [['Lavadora', data.machine || '—']];
      if (data.doser) rows.push(['Dosagem', dosageLabel(data.doser)]);
      rows.push(['Status', data.background_processing ? 'Liberação em andamento' : 'Liberada']);
      return {
        title: 'Lavadora liberada',
        message: '',
        bodyHtml: renderInfoRows(rows),
      };
    }

    if (data.minutes != null) {
      return {
        title: 'Secadora liberada',
        message: '',
        bodyHtml: renderInfoRows([
          ['Equipamento', data.machine || '—'],
          ['Duração', `${data.minutes} min`],
        ]),
      };
    }

    if (data.type && data.machine) {
      return {
        title: 'Dosadora acionada',
        message: '',
        bodyHtml: renderInfoRows([
          ['Equipamento', data.machine],
          ['Produto', DOSER_TYPE_LABELS[data.type] || data.type],
        ]),
      };
    }

    if (label === 'AC' || String(label).toLowerCase().includes('ar-condicionado')) {
      const temp = data.payload ?? data.temperature;
      const tempLabel = temp === 'off' ? 'Desligado' : `${temp}°C`;
      return {
        title: 'Ar-condicionado',
        message: '',
        bodyHtml: renderInfoRows([['Temperatura', tempLabel]]),
      };
    }

    const rows = [];
    if (data.machine) rows.push(['Equipamento', data.machine]);
    let message = cleanConfirmMessage(data.message);
    if (!rows.length && !message) {
      message = `${label} concluído com sucesso.`;
    }

    return {
      title: 'Comando confirmado',
      message: rows.length ? message : message || `${label} concluído com sucesso.`,
      bodyHtml: rows.length ? renderInfoRows(rows) : '',
    };
  }

  function createConfirmUI({ $, onToast }) {
    let actionPromptResolver = null;

    function hideActionConfirm() {
      $('confirmModal')?.classList.add('hidden');
    }

    function hideActionPrompt(confirmed) {
      $('actionPromptModal')?.classList.add('hidden');
      if (!actionPromptResolver) return;
      const resolve = actionPromptResolver;
      actionPromptResolver = null;
      resolve(Boolean(confirmed));
    }

    function showActionConfirm(label, data) {
      const status = data._httpStatus || 200;
      if (status !== 200) {
        if (typeof onToast === 'function') onToast(formatConfirmMessage(label, data), true);
        return;
      }

      const view = buildConfirmView(label, data);
      $('confirmTitle').textContent = view.title;
      $('confirmMessage').textContent = view.message || '';

      const bodyEl = $('confirmBody');
      if (view.bodyHtml) {
        bodyEl.innerHTML = view.bodyHtml;
        bodyEl.classList.remove('hidden');
      } else {
        bodyEl.innerHTML = '';
        bodyEl.classList.add('hidden');
      }

      $('confirmStatus').textContent = 'Confirmado';
      $('confirmModal').classList.remove('hidden');
    }

    function confirmAction(message, rows = [], options = {}) {
      return new Promise((resolve) => {
        if (actionPromptResolver) hideActionPrompt(false);
        actionPromptResolver = resolve;

        const heading = options.heading || 'Confirmar operação';
        let promptMessage = '';
        if (typeof message === 'string' && message.trim()) {
          promptMessage = message.trim();
        } else if (Array.isArray(rows) && rows.length) {
          promptMessage = 'Revise os dados abaixo e confirme a operação.';
        } else {
          promptMessage = 'Deseja executar esta ação na loja?';
        }

        $('actionPromptTitle').textContent = heading;
        $('actionPromptMessage').textContent = promptMessage;

        const bodyEl = $('actionPromptBody');
        if (Array.isArray(rows) && rows.length) {
          bodyEl.innerHTML = renderInfoRows(rows);
          bodyEl.classList.remove('hidden');
        } else {
          bodyEl.innerHTML = '';
          bodyEl.classList.add('hidden');
        }

        $('actionPromptModal').classList.remove('hidden');
      });
    }

    function bindConfirmEvents() {
      $('confirmOk')?.addEventListener('click', hideActionConfirm);
      $('confirmModal')?.querySelector('.confirm-modal__backdrop')?.addEventListener('click', hideActionConfirm);
      $('actionPromptOk')?.addEventListener('click', () => hideActionPrompt(true));
      $('actionPromptCancel')?.addEventListener('click', () => hideActionPrompt(false));
      $('actionPromptModal')
        ?.querySelector('[data-action-prompt-dismiss]')
        ?.addEventListener('click', () => hideActionPrompt(false));
      document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        if (!$('actionPromptModal')?.classList.contains('hidden')) {
          hideActionPrompt(false);
          return;
        }
        if (!$('confirmModal')?.classList.contains('hidden')) {
          hideActionConfirm();
        }
      });
    }

    return { confirmAction, showActionConfirm, hideActionConfirm, bindConfirmEvents, buildConfirmView };
  }

  function btn(text, className, onclick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn btn--sm ${className || ''}`;
    b.textContent = text;
    if (onclick) b.addEventListener('click', onclick);
    return b;
  }

  function createChoicePicker(options, { columns = 3, requireSelection = false } = {}) {
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
      buttons,
      getValue: () => selected,
      hasSelection: () => selected != null,
      onChange(fn) {
        listeners.push(fn);
      },
      setDisabled(disabled) {
        buttons.forEach((item) => {
          item.disabled = disabled;
        });
      },
    };
  }

  function syncReleaseButtonWithPicker(releaseBtn, picker, operable = true) {
    if (!releaseBtn || !picker) return;
    const update = () => {
      releaseBtn.disabled = !operable || !picker.hasSelection();
    };
    picker.onChange(update);
    update();
  }

  function appendReleaseButton(container, { label = 'Liberar', className = 'btn--primary', onRelease, dataset = {}, disabled = false }) {
    const releaseBtn = btn(label, `device-card__release-btn ${className}`, onRelease);
    Object.entries(dataset).forEach(([key, value]) => {
      releaseBtn.dataset[key] = value;
    });
    releaseBtn.disabled = disabled;
    container.appendChild(releaseBtn);
    return releaseBtn;
  }

  function appendActionGrid(container, columns, buttons) {
    const grid = document.createElement('div');
    grid.className = `device-card__action-grid device-card__action-grid--${columns}`;
    buttons.forEach((button) => grid.appendChild(button));
    container.appendChild(grid);
    return grid;
  }

  function createDeviceUI(Lav60) {
    const { deviceUnifiedStatus, machineMetaFacts, canOperateMachineStatus } = Lav60;

    function canOperateMachine(meta, online) {
      if (online !== true) return false;
      return canOperateMachineStatus(meta?.status);
    }

    function deviceStatusHint(ctx) {
      if (ctx.probing) return 'Verificando conexão…';
      if (!ctx.online) return 'Sem conexão na rede';
      if (!ctx.operable) return ctx.statusInfo.label;
      return '';
    }

    function resolveStatusInfo(online, meta, options = {}) {
      if (options.probing || online === null) {
        return {
          label: options.probing ? 'Verificando…' : 'Não verificado',
          tone: 'checking',
          pillClass: 'pill--warn',
        };
      }
      return deviceUnifiedStatus(Boolean(online), meta);
    }

    function createDeviceCard(id, online, fillActions, meta, options = {}) {
      const statusInfo = resolveStatusInfo(online, meta, options);
      const operable = canOperateMachine(meta, online === null ? false : online) && !options.probing;
      const capacity = meta?.capacity && meta.capacity !== '—' ? meta.capacity : '';
      const facts = machineMetaFacts(meta);

      const card = document.createElement('article');
      card.className = [
        'device-card',
        'device-card--tile',
        `device-card--${statusInfo.tone}`,
        online === true ? 'device-card--online' : online === false ? 'device-card--offline' : '',
      ]
        .filter(Boolean)
        .join(' ');

      if (!operable) {
        card.classList.add('device-card--blocked');
        card.setAttribute('aria-disabled', 'true');
      }

      const factsHtml = facts.length
        ? `<p class="device-card__facts">${facts.map((f) => escapeHtml(f)).join('<span class="device-card__sep">·</span>')}</p>`
        : '';

      card.innerHTML = `
        <header class="device-card__head">
          <div class="device-card__title-row">
            <h3 class="device-card__id">${escapeHtml(String(id))}</h3>
            ${capacity ? `<span class="device-card__cap">${escapeHtml(capacity)}</span>` : ''}
          </div>
          <span class="device-card__status pill ${statusInfo.pillClass}">${escapeHtml(statusInfo.label)}</span>
        </header>
        ${factsHtml}
        <div class="device-card__actions"></div>
      `;

      const actions = card.querySelector('.device-card__actions');
      const ctx = { operable, online: online === true, statusInfo, probing: Boolean(options.probing) };
      fillActions(actions, card, ctx);

      if (!operable) {
        actions.querySelectorAll('button, input, select, textarea').forEach((el) => {
          el.disabled = true;
        });
      }

      return card;
    }

    function buildDoserCardContent(actions, id, ctx, runAction, { runDoserCommand, runDoserConsult, runDoserSetTime }) {
      actions.classList.add('device-card__actions--doser');

      const picker = createChoicePicker(
        [
          { value: 'rele1on', label: 'Sabão' },
          { value: 'rele2on', label: 'Floral' },
          { value: 'rele3on', label: 'Sport' },
        ],
        { columns: 3, requireSelection: true }
      );
      if (!ctx.operable) picker.setDisabled(true);
      actions.appendChild(picker.root);

      const releaseBtn = appendReleaseButton(actions, {
        label: 'Acionar',
        disabled: true,
        onRelease: () => {
          if (!picker.hasSelection()) return;
          const type = picker.getValue();
          runAction(`Dosadora ${id}`, () => runDoserCommand(id, type), {
            action: 'doser_command',
            label: `Dosadora ${id} · ${DOSER_TYPE_LABELS[type] || type}`,
            confirmHeading: 'Confirmar acionamento',
            confirmRows: [
              ['Equipamento', `Dosadora ${id}`],
              ['Produto', DOSER_TYPE_LABELS[type] || type],
            ],
            method: 'POST',
            path: `/doser/${id}`,
            payload: { type },
            device_type: 'doser',
            device_id: String(id),
          });
        },
      });
      syncReleaseButtonWithPicker(releaseBtn, picker, ctx.operable);

      const consultRow = document.createElement('div');
      consultRow.className = 'device-card__action-row';
      consultRow.appendChild(
        btn('Consultar tempos salvos', 'btn--ghost device-card__action-wide', () =>
          runAction(`Consulta dosadora ${id}`, () => runDoserConsult(id), {
            action: 'doser_consult',
            label: `Consulta dosadora ${id}`,
            confirmHeading: 'Confirmar consulta',
            confirmMessage: 'Deseja consultar os tempos salvos desta dosadora?',
            confirmRows: [['Equipamento', `Dosadora ${id}`]],
            method: 'GET',
            path: `/doser/${id}/consulta`,
            device_type: 'doser',
            device_id: String(id),
          })
        )
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

      const secUnit = document.createElement('span');
      secUnit.className = 'device-card__time-unit';
      secUnit.textContent = 'seg';

      timeField.appendChild(secInput);
      timeField.appendChild(secUnit);
      panel.appendChild(timeField);

      const setButtons = ['sabao', 'floral', 'sport'].map((kind) => {
        const kindLabel = TEMPO_LABELS[kind] || kind;
        return btn(kindLabel, 'btn--ghost', () => {
          const seconds = parseFloat(secInput.value) || 5;
          runAction(`Ajuste dosadora ${id}`, () => runDoserSetTime(id, kind, seconds), {
            action: 'doser_settime',
            label: `Ajuste de tempo · dosadora ${id} · ${kindLabel}`,
            confirmHeading: 'Confirmar ajuste',
            confirmMessage: 'Revise os dados abaixo e confirme o ajuste de tempo.',
            confirmRows: [
              ['Equipamento', `Dosadora ${id}`],
              ['Produto', kindLabel],
              ['Tempo', `${seconds} seg`],
            ],
            method: 'POST',
            path: `/doser/${id}/settime/${kind}`,
            payload: { seconds },
            device_type: 'doser',
            device_id: String(id),
          });
        });
      });
      appendActionGrid(panel, 3, setButtons);
      actions.appendChild(panel);
    }

    return {
      createDeviceCard,
      canOperateMachine,
      deviceStatusHint,
      buildDoserCardContent,
      btn,
      createChoicePicker,
      syncReleaseButtonWithPicker,
      appendReleaseButton,
      appendActionGrid,
      resolveStatusInfo,
    };
  }

  function countOnline(map) {
    if (!map) return { on: 0, total: 0 };
    const vals = Object.values(map);
    return { on: vals.filter((v) => v === true).length, total: vals.length };
  }

  function setSectionCount(element, map) {
    if (!element) return;
    const { on, total } = countOnline(map);
    element.textContent = total ? `${on}/${total} online` : '—';
  }

  window.Lav60DeviceUI = {
    TEMPO_LABELS,
    RELE_LABELS,
    DOSER_TYPE_LABELS,
    escapeHtml,
    dosageLabel,
    renderInfoRows,
    renderTemposGrid,
    buildConfirmView,
    createConfirmUI,
    createDeviceUI,
    countOnline,
    setSectionCount,
  };
})();
