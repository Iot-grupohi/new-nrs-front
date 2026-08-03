(() => {
  'use strict';

  const MAX_HISTORY = 10;
  let chatAbort = null;
  let streamAbort = null;
  let chatReady = false;
  let aiAvailable = false;
  let aiModel = '';
  let chatHistory = [];
  let sending = false;
  let aiQueryCounter = 0;
  const aiQueryById = new Map();

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

  function clearWelcome() {
    const box = $('supportChatMessages');
    if (!box) return;
    box.querySelector('.support-chat__welcome')?.remove();
    box.querySelector('.support-chat__empty')?.remove();
  }

  function renderWelcome() {
    const box = $('supportChatMessages');
    if (!box) return;
    box.innerHTML = `
      <div class="support-chat__welcome">
        <p class="support-chat__welcome-title">Como posso ajudar?</p>
        <p class="support-chat__welcome-text">Busca local nos runbooks — sem tokens. Se precisar, use <strong>Explicar com IA</strong> (opt-in).</p>
      </div>`;
  }

  function registerAiQuery(message) {
    const id = String(++aiQueryCounter);
    aiQueryById.set(id, message);
    return id;
  }

  function typingDotsHtml() {
    return '<span class="support-chat__dots" aria-hidden="true"><span></span><span></span><span></span></span>';
  }

  function showTypingIndicator(label = 'Assistente') {
    clearWelcome();
    const box = $('supportChatMessages');
    if (!box) return null;

    const item = document.createElement('article');
    item.className = 'support-chat__message support-chat__message--assistant support-chat__message--typing';
    item.innerHTML = `
      <span class="support-chat__message-label">${escapeHtml(label)}</span>
      <div class="support-chat__message-body">${typingDotsHtml()}</div>`;
    box.appendChild(item);
    scrollMessagesToBottom();
    return item;
  }

  function renderSourcesPanel(sources) {
    const wrap = $('supportChatSources');
    const empty = $('supportChatSourcesEmpty');
    if (!wrap) return;

    if (!sources?.length) {
      wrap.innerHTML = '';
      empty?.classList.remove('hidden');
      return;
    }

    empty?.classList.add('hidden');
    wrap.innerHTML = sources.map((source) => (
      `<button type="button" class="support-chat__source support-chat-panel__chip" data-support-chat-open="${escapeHtml(source.category_id)}:${escapeHtml(source.procedure_id)}">
        ${escapeHtml(source.title || source.procedure_id)}
      </button>`
    )).join('');
  }

  function clearSourcesPanel() {
    renderSourcesPanel([]);
  }

  function renderUserMessage(content) {
    const box = $('supportChatMessages');
    if (!box) return;
    clearWelcome();

    const item = document.createElement('article');
    item.className = 'support-chat__message support-chat__message--user';
    item.innerHTML = `
      <span class="support-chat__message-label">Você</span>
      <div class="support-chat__message-body">${formatAssistantText(content)}</div>`;
    box.appendChild(item);
    scrollMessagesToBottom();
  }

  function renderAiOfferHtml(query) {
    if (!query || !aiAvailable) return '';
    const id = registerAiQuery(query);
    return `
      <div class="support-chat__ai-actions">
        <button type="button" class="btn btn--ghost btn--sm support-chat__ai-btn" data-support-chat-ai-id="${id}">
          Explicar com IA
        </button>
        <span class="support-chat__ai-hint">Usa tokens · só se precisar</span>
      </div>`;
  }

  function renderAssistantAnswer({ reply, html, sources, offerAi, query }) {
    const box = $('supportChatMessages');
    if (!box) return;

    const item = document.createElement('article');
    item.className = 'support-chat__message support-chat__message--assistant';

    const introHtml = reply ? `<p class="support-chat__intro">${formatAssistantText(reply)}</p>` : '';
    const runbookHtml = html ? `<div class="support-chat__runbook">${html}</div>` : '';
    const bodyHtml = !html && reply
      ? `<div class="support-chat__message-body">${formatAssistantText(reply)}</div>`
      : `<div class="support-chat__message-body">${introHtml}${runbookHtml}</div>`;
    const aiOfferHtml = offerAi ? renderAiOfferHtml(query) : '';

    item.innerHTML = `
      <span class="support-chat__message-label">Assistente</span>
      ${bodyHtml}${aiOfferHtml}`;

    box.appendChild(item);
    renderSourcesPanel(sources);
    scrollMessagesToBottom();
  }

  function createStreamingMessage() {
    clearWelcome();
    const box = $('supportChatMessages');
    if (!box) return null;

    const item = document.createElement('article');
    item.className = 'support-chat__message support-chat__message--assistant support-chat__message--ai support-chat__message--streaming';
    item.innerHTML = `
      <span class="support-chat__message-label">Assistente · IA</span>
      <div class="support-chat__message-body">
        <span class="support-chat__stream-text"></span><span class="support-chat__cursor" aria-hidden="true"></span>
      </div>`;
    box.appendChild(item);
    scrollMessagesToBottom();
    return item;
  }

  function updateStreamingMessage(item, text) {
    const el = item?.querySelector('.support-chat__stream-text');
    if (el) el.innerHTML = formatAssistantText(text);
    scrollMessagesToBottom();
  }

  function finalizeStreamingMessage(item, text) {
    item?.querySelector('.support-chat__cursor')?.remove();
    item?.classList.remove('support-chat__message--streaming');
    updateStreamingMessage(item, text);
  }

  function renderSuggestions() {
    const wrap = $('supportChatSuggestions');
    if (!wrap) return;
    const suggestions = (catalog()?.searchSuggestions || []).slice(0, 22);
    wrap.innerHTML = suggestions.map((term) => (
      `<button type="button" class="support-suggestion-chip support-chat-panel__chip" data-support-chat-suggest="${escapeHtml(term)}">${escapeHtml(term)}</button>`
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

  function answerLocally(message) {
    const builder = catalog()?.buildLocalAnswer;
    if (typeof builder === 'function') {
      return builder(message);
    }
    return {
      reply: 'Base de conhecimento indisponível.',
      html: '',
      sources: [],
      bestScore: 0,
      ambiguous: false,
    };
  }

  function shouldOfferAi(result) {
    if (!aiAvailable) return false;
    const score = result?.bestScore ?? 0;
    const count = result?.sources?.length ?? 0;
    if (count === 0) return true;
    if (score < 4) return true;
    if (result?.ambiguous) return true;
    return false;
  }

  function buildAiContext(message) {
    const searchFn = catalog()?.searchForChat;
    if (typeof searchFn !== 'function') return [];
    return searchFn(message, 8);
  }

  function trimHistory() {
    if (chatHistory.length > MAX_HISTORY * 2) {
      chatHistory = chatHistory.slice(-MAX_HISTORY * 2);
    }
  }

  function delay(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  async function parseSseStream(response, onEvent) {
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Streaming indisponível');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        const line = part.split('\n').find((row) => row.startsWith('data: '));
        if (!line) continue;
        try {
          onEvent(JSON.parse(line.slice(6)));
        } catch {
          /* ignore malformed chunk */
        }
      }
    }
  }

  async function explainWithAi(message, triggerBtn) {
    const text = String(message || '').trim();
    if (!text || !aiAvailable || sending) return;

    triggerBtn?.setAttribute('disabled', 'true');
    sending = true;
    setComposerEnabled(false);
    setStatus('Consultando IA com runbooks…', 'info');

    streamAbort?.abort();
    streamAbort = new AbortController();

    const typingEl = showTypingIndicator('Assistente · IA');
    let streamItem = null;
    let fullReply = '';
    let sources = [];

    try {
      const context = buildAiContext(text);
      const res = await panelFetch('/api/support/chat/stream', {
        method: 'POST',
        body: JSON.stringify({
          message: text,
          history: chatHistory.slice(-MAX_HISTORY),
          context,
        }),
        signal: streamAbort.signal,
        headers: { Accept: 'text/event-stream' },
      });

      typingEl?.remove();

      if (!res.ok) {
        await explainWithAiFallback(text, context, res);
        return;
      }

      streamItem = createStreamingMessage();
      let donePayload = null;

      await parseSseStream(res, (event) => {
        if (event.type === 'token') {
          fullReply += String(event.content || '');
          updateStreamingMessage(streamItem, fullReply);
          setStatus('Digitando resposta com IA…', 'info');
        } else if (event.type === 'done') {
          donePayload = event;
        } else if (event.type === 'error') {
          throw new Error(event.message || 'Erro ao consultar IA');
        }
      });

      const reply = String(donePayload?.reply || fullReply || '').trim() || 'Sem resposta.';
      sources = donePayload?.sources || [];
      finalizeStreamingMessage(streamItem, reply);
      renderSourcesPanel(sources);

      chatHistory.push({ role: 'user', content: text });
      chatHistory.push({ role: 'assistant', content: reply });
      trimHistory();

      setStatus(`IA · ${donePayload?.model || aiModel}`, 'ok');
    } catch (err) {
      typingEl?.remove();
      streamItem?.remove();

      if (err?.name === 'AbortError') return;

      try {
        await explainWithAiFallback(text, buildAiContext(text));
      } catch (fallbackErr) {
        renderAssistantAnswer({
          reply: String(fallbackErr?.message || err?.message || 'Não foi possível consultar a IA.'),
          html: '',
          sources: [],
          offerAi: false,
        });
        setStatus('Erro ao consultar IA.', 'error');
        triggerBtn?.removeAttribute('disabled');
      }
    } finally {
      sending = false;
      setComposerEnabled(chatReady);
      $('supportChatInput')?.focus();
    }
  }

  async function explainWithAiFallback(message, context, failedResponse = null) {
    if (failedResponse && failedResponse.status !== 404 && failedResponse.status !== 405) {
      let detail = 'Não foi possível consultar a IA.';
      try {
        const err = await failedResponse.json();
        detail = err.detail || detail;
      } catch {
        /* ignore */
      }
      throw new Error(detail);
    }

    const res = await panelFetch('/api/support/chat', {
      method: 'POST',
      body: JSON.stringify({
        message,
        history: chatHistory.slice(-MAX_HISTORY),
        context,
      }),
      signal: streamAbort?.signal,
    });

    if (!res.ok) {
      let detail = 'Não foi possível consultar a IA.';
      try {
        const err = await res.json();
        detail = err.detail || detail;
      } catch {
        /* ignore */
      }
      throw new Error(detail);
    }

    const data = await res.json();
    const reply = String(data.reply || '').trim() || 'Sem resposta.';
    renderAssistantAnswer({
      reply,
      html: '',
      sources: data.sources || [],
      offerAi: false,
    });
    renderSourcesPanel(data.sources || []);

    chatHistory.push({ role: 'user', content: message });
    chatHistory.push({ role: 'assistant', content: reply });
    trimHistory();
    setStatus(`IA · ${data.model || aiModel}`, 'ok');
  }

  async function sendMessage(rawMessage) {
    const message = String(rawMessage || '').trim();
    if (!message || sending || !chatReady) return;

    const input = $('supportChatInput');
    sending = true;
    setComposerEnabled(false);
    renderUserMessage(message);
    if (input) input.value = '';

    const typingEl = showTypingIndicator();
    setStatus('Buscando nos runbooks…', 'info');

    try {
      await delay(280);
      typingEl?.remove();

      const result = answerLocally(message);
      const offerAi = shouldOfferAi(result);
      renderAssistantAnswer({
        ...result,
        offerAi,
        query: message,
      });

      if (offerAi) {
        setStatus('Resposta local · clique em "Explicar com IA" se precisar', 'info');
      } else {
        setStatus('Base local · sem tokens de IA', 'ok');
      }
    } catch (err) {
      typingEl?.remove();
      renderAssistantAnswer({
        reply: String(err?.message || 'Não foi possível consultar a base local.'),
        html: '',
        sources: [],
        offerAi: aiAvailable,
        query: message,
      });
      setStatus('Erro ao consultar a base local.', 'error');
    } finally {
      sending = false;
      setComposerEnabled(chatReady);
      $('supportChatInput')?.focus();
    }
  }

  async function loadStatus() {
    const panel = $('supportChat');
    if (!panel) return;

    const count = catalog()?.listAllProcedureRecords?.().length || 0;
    chatReady = count > 0;
    aiAvailable = false;
    aiModel = '';

    try {
      const res = await panelFetch('/api/support/chat/status', { signal: chatAbort?.signal });
      if (res.ok) {
        const data = await res.json();
        aiAvailable = Boolean(data.available);
        aiModel = String(data.model || '');
      }
    } catch {
      aiAvailable = false;
      aiModel = '';
    }

    panel.classList.toggle('support-chat--disabled', !chatReady);
    setComposerEnabled(chatReady);

    if (chatReady) {
      const aiHint = aiAvailable ? ` · IA opt-in (${aiModel || 'disponível'})` : ' · IA indisponível';
      setStatus(`Base local · ${count} runbooks${aiHint}`, 'ok');
    } else {
      setStatus('Carregue data/support-knowledge.json para ativar o assistente.', 'warn');
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
      streamAbort?.abort();
      streamAbort = null;
      sending = false;
      chatHistory = [];
      aiQueryById.clear();
      renderWelcome();
      clearSourcesPanel();
      const aiHint = aiAvailable ? ' · IA opt-in' : '';
      setStatus(chatReady ? `Base local · sem tokens de IA${aiHint}` : 'Carregue data/support-knowledge.json.', chatReady ? 'ok' : 'warn');
      setComposerEnabled(chatReady);
      $('supportChatInput')?.focus();
    }, { signal });

    $('supportChatSuggestions')?.addEventListener('click', (event) => {
      const chip = event.target.closest('[data-support-chat-suggest]');
      if (!chip || sending) return;
      const term = chip.dataset.supportChatSuggest || '';
      const input = $('supportChatInput');
      if (input) input.value = term;
      sendMessage(term);
    }, { signal });

    $('supportChatMessages')?.addEventListener('click', (event) => {
      const aiBtn = event.target.closest('[data-support-chat-ai-id]');
      if (aiBtn && !sending) {
        const query = aiQueryById.get(aiBtn.dataset.supportChatAiId || '');
        if (query) explainWithAi(query, aiBtn);
        return;
      }
      const openBtn = event.target.closest('[data-support-chat-open]');
      if (!openBtn) return;
      const [categoryId, procedureId] = String(openBtn.dataset.supportChatOpen || '').split(':');
      if (!categoryId || !procedureId) return;
      window.Lav60SupportPage?.openProcedure?.(categoryId, procedureId);
    }, { signal });

    $('supportChatPanel')?.addEventListener('click', handleSourceClick, { signal });
    $('supportChatSources')?.addEventListener('click', handleSourceClick, { signal });

    function handleSourceClick(event) {
      const btn = event.target.closest('[data-support-chat-open]');
      if (!btn) return;
      const [categoryId, procedureId] = String(btn.dataset.supportChatOpen || '').split(':');
      if (!categoryId || !procedureId) return;
      window.Lav60SupportPage?.openProcedure?.(categoryId, procedureId);
    }
  }

  async function init() {
    if (!$('supportChat')) return;
    chatAbort?.abort();
    streamAbort?.abort();
    chatAbort = new AbortController();
    streamAbort = null;
    sending = false;
    chatHistory = [];
    aiQueryById.clear();

    renderWelcome();
    renderSuggestions();
    bindEvents(chatAbort.signal);
    await loadStatus();
    $('supportChatInput')?.focus();
  }

  function destroy() {
    chatAbort?.abort();
    streamAbort?.abort();
    chatAbort = null;
    streamAbort = null;
    sending = false;
    chatReady = false;
    aiAvailable = false;
    chatHistory = [];
    aiQueryById.clear();
  }

  window.Lav60SupportChat = { init, destroy, reloadStatus: loadStatus };
})();
