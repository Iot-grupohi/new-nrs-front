(() => {
  'use strict';

  const MAX_HISTORY = 10;
  let chatAbort = null;
  let chatAvailable = false;
  let chatModel = '';
  let chatHistory = [];
  let sending = false;

  function $(id) {
    return document.getElementById(id);
  }

  function catalog() {
    return window.Lav60SupportCatalog;
  }

  function panelFetch(url, options = {}) {
    const fetcher = window.Lav60Auth?.panelFetch
      || ((target, opts) => fetch(target, { ...opts, credentials: 'same-origin' }));
    return fetcher(url, {
      ...options,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });
  }

  function escapeHtml(text) {
    return String(text ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatAssistantText(text) {
    return escapeHtml(text)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }

  function scrollMessagesToBottom() {
    const box = $('supportChatMessages');
    if (!box) return;
    box.scrollTop = box.scrollHeight;
  }

  function renderMessage(role, content, extras = {}) {
    const box = $('supportChatMessages');
    if (!box) return;

    const empty = box.querySelector('.support-chat__empty');
    if (empty) empty.remove();

    const item = document.createElement('article');
    item.className = `support-chat__message support-chat__message--${role}`;
    item.innerHTML = `
      <span class="support-chat__message-label">${role === 'user' ? 'Você' : 'Assistente'}</span>
      <div class="support-chat__message-body">${formatAssistantText(content)}</div>
    `;

    if (extras.sources?.length) {
      const sources = document.createElement('div');
      sources.className = 'support-chat__sources';
      sources.innerHTML = extras.sources.map((source) => (
        `<button type="button" class="support-chat__source" data-support-chat-open="${escapeHtml(source.category_id)}:${escapeHtml(source.procedure_id)}">
          ${escapeHtml(source.title || source.procedure_id)}
        </button>`
      )).join('');
      item.appendChild(sources);
    }

    box.appendChild(item);
    scrollMessagesToBottom();
  }

  function renderSuggestions() {
    const wrap = $('supportChatSuggestions');
    if (!wrap) return;
    const suggestions = (catalog()?.searchSuggestions || []).slice(0, 8);
    wrap.innerHTML = suggestions.map((term) => (
      `<button type="button" class="support-suggestion-chip" data-support-chat-suggest="${escapeHtml(term)}">${escapeHtml(term)}</button>`
    )).join('');
  }

  function setStatus(text, kind = 'info') {
    const el = $('supportChatStatus');
    if (!el) return;
    el.textContent = text || '';
    el.dataset.kind = kind;
  }

  function setComposerEnabled(enabled) {
    $('supportChatInput')?.toggleAttribute('disabled', !enabled);
    $('supportChatSend')?.toggleAttribute('disabled', !enabled || sending);
  }

  function buildContext(message) {
    const searchFn = catalog()?.searchForChat;
    if (typeof searchFn !== 'function') return [];
    return searchFn(message, 8);
  }

  async function sendMessage(rawMessage) {
    const message = String(rawMessage || '').trim();
    if (!message || sending || !chatAvailable) return;

    const input = $('supportChatInput');
    sending = true;
    setComposerEnabled(false);
    renderMessage('user', message);
    chatHistory.push({ role: 'user', content: message });
    if (input) input.value = '';

    const typing = document.createElement('article');
    typing.className = 'support-chat__message support-chat__message--assistant support-chat__message--typing';
    typing.innerHTML = `
      <span class="support-chat__message-label">Assistente</span>
      <div class="support-chat__message-body"><span class="support-chat__typing">Analisando runbooks…</span></div>
    `;
    $('supportChatMessages')?.appendChild(typing);
    scrollMessagesToBottom();

    try {
      const context = buildContext(message);
      const res = await panelFetch('/api/support/chat', {
        method: 'POST',
        body: JSON.stringify({
          message,
          history: chatHistory.slice(-MAX_HISTORY),
          context,
        }),
        signal: chatAbort?.signal,
      });

      typing.remove();

      if (!res.ok) {
        let detail = 'Não foi possível consultar o assistente.';
        try {
          const err = await res.json();
          detail = err.detail || detail;
        } catch {
          /* ignore */
        }
        renderMessage('assistant', detail);
        setStatus(detail, 'error');
        chatHistory.pop();
        return;
      }

      const data = await res.json();
      const reply = String(data.reply || '').trim() || 'Sem resposta.';
      renderMessage('assistant', reply, { sources: data.sources || [] });
      chatHistory.push({ role: 'assistant', content: reply });
      if (chatHistory.length > MAX_HISTORY * 2) {
        chatHistory = chatHistory.slice(-MAX_HISTORY * 2);
      }
      setStatus(`Modelo: ${data.model || chatModel}`, 'ok');
    } catch (err) {
      typing.remove();
      if (err?.name === 'AbortError') return;
      const detail = 'Falha de rede ao consultar o assistente.';
      renderMessage('assistant', detail);
      setStatus(detail, 'error');
      chatHistory.pop();
    } finally {
      sending = false;
      setComposerEnabled(chatAvailable);
      $('supportChatInput')?.focus();
    }
  }

  async function loadStatus() {
    const panel = $('supportChat');
    if (!panel) return;

    try {
      const res = await panelFetch('/api/support/chat/status', { signal: chatAbort?.signal });
      if (!res.ok) throw new Error('status');
      const data = await res.json();
      chatAvailable = Boolean(data.available);
      chatModel = String(data.model || '');
    } catch {
      chatAvailable = false;
      chatModel = '';
    }

    panel.classList.toggle('support-chat--disabled', !chatAvailable);
    setComposerEnabled(chatAvailable);

    if (chatAvailable) {
      setStatus(`Assistente ativo · ${chatModel}`, 'ok');
    } else {
      setStatus('Configure OPENAI_API_KEY no servidor para ativar o assistente.', 'warn');
    }
  }

  function bindEvents(signal) {
    $('supportChatForm')?.addEventListener('submit', (event) => {
      event.preventDefault();
      sendMessage($('supportChatInput')?.value || '');
    }, { signal });

    $('supportChatInput')?.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        sendMessage(event.target.value || '');
      }
    }, { signal });

    $('supportChatClear')?.addEventListener('click', () => {
      chatHistory = [];
      const box = $('supportChatMessages');
      if (box) {
        box.innerHTML = '<p class="support-chat__empty">Faça uma pergunta sobre equipamentos, pagamentos ou atendimento SAC.</p>';
      }
      setStatus(chatAvailable ? `Assistente ativo · ${chatModel}` : 'Configure OPENAI_API_KEY no servidor para ativar o assistente.', chatAvailable ? 'ok' : 'warn');
    }, { signal });

    $('supportChatSuggestions')?.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-support-chat-suggest]');
      if (!chip) return;
      const term = chip.dataset.supportChatSuggest || '';
      const input = $('supportChatInput');
      if (input) input.value = term;
      sendMessage(term);
    }, { signal });

    $('supportChatMessages')?.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-support-chat-open]');
      if (!btn) return;
      const [categoryId, procedureId] = String(btn.dataset.supportChatOpen || '').split(':');
      if (!categoryId || !procedureId) return;
      window.Lav60SupportPage?.openProcedure?.(categoryId, procedureId);
    }, { signal });
  }

  async function init() {
    if (!$('supportChat')) return;
    chatAbort?.abort();
    chatAbort = new AbortController();
    chatHistory = [];
    sending = false;

    const box = $('supportChatMessages');
    if (box) {
      box.innerHTML = '<p class="support-chat__empty">Faça uma pergunta sobre equipamentos, pagamentos ou atendimento SAC.</p>';
    }

    renderSuggestions();
    bindEvents(chatAbort.signal);
    await loadStatus();
    $('supportChatInput')?.focus();
  }

  function destroy() {
    chatAbort?.abort();
    chatAbort = null;
    chatHistory = [];
    sending = false;
  }

  window.Lav60SupportChat = { init, destroy };
})();
