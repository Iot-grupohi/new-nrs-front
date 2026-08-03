(() => {
  'use strict';

  const KNOWLEDGE_URL = '/data/support-knowledge.json?v=1';

  let MAP_REGIONS = [];
  let BASE_CATEGORIES = [];
  let knowledgeLoaded = false;
  let knowledgeLoadPromise = null;

  function normalizeMapRegions(regions) {
    return (regions || []).map((region) => ({
      ...region,
      embedUrl: `https://www.google.com/maps/d/embed?mid=${encodeURIComponent(region.mid)}`,
    }));
  }

  async function loadKnowledgeBase(force = false) {
    if (knowledgeLoaded && !force) return { ok: true };
    if (knowledgeLoadPromise && !force) return knowledgeLoadPromise;

    const cache = window.Lav60Cache;
    const cacheKey = cache?.KEYS?.supportKnowledge || 'lav60:support:knowledge';
    const ttlMs = cache?.getTtl?.('supportKnowledge') || 30 * 60 * 1000;

    if (!force && cache?.getFresh) {
      const cached = cache.getFresh(cacheKey, ttlMs);
      if (cached?.categories) {
        BASE_CATEGORIES = Array.isArray(cached.categories) ? cached.categories : [];
        MAP_REGIONS = normalizeMapRegions(cached.map_regions);
        knowledgeLoaded = true;
        return { ok: true, version: cached.version || 1, fromCache: true };
      }
    }

    knowledgeLoadPromise = (async () => {
      try {
        const fetcher = window.Lav60Auth?.panelFetch
          || ((url) => fetch(url, { credentials: 'same-origin' }));
        const res = await fetcher(KNOWLEDGE_URL, {
          headers: { Accept: 'application/json' },
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        BASE_CATEGORIES = Array.isArray(data.categories) ? data.categories : [];
        MAP_REGIONS = normalizeMapRegions(data.map_regions);
        knowledgeLoaded = true;
        cache?.put?.(cacheKey, data, { persist: true });
        return { ok: true, version: data.version || 1 };
      } catch (err) {
        console.error('[support] Falha ao carregar data/support-knowledge.json', err);
        BASE_CATEGORIES = [];
        MAP_REGIONS = [];
        knowledgeLoaded = false;
        return { ok: false };
      } finally {
        knowledgeLoadPromise = null;
      }
    })();

    return knowledgeLoadPromise;
  }

  let CATEGORIES = [];
  let canEdit = false;
  const customCategoryIds = new Set();
  const customProcedureKeys = new Set();

  function cloneCategories(source) {
    return JSON.parse(JSON.stringify(source || []));
  }

  function resetCategories() {
    CATEGORIES = cloneCategories(BASE_CATEGORIES);
  }

  function trackCustomMeta(meta = {}) {
    customCategoryIds.clear();
    customProcedureKeys.clear();
    (meta.category_ids || []).forEach((id) => customCategoryIds.add(id));
    (meta.procedure_keys || []).forEach((key) => customProcedureKeys.add(key));
  }

  function mergeCustomStore(store = {}) {
    resetCategories();
    const byId = Object.fromEntries(CATEGORIES.map((cat) => [cat.id, cat]));

    for (const category of store.categories || []) {
      if (!category?.id) continue;
      const procedures = (category.procedures || []).map((proc) => ({ ...proc, custom: true }));
      if (byId[category.id]) {
        byId[category.id].procedures.push(...procedures);
        continue;
      }
      const customCategory = {
        ...category,
        custom: true,
        procedures,
      };
      CATEGORIES.push(customCategory);
      byId[category.id] = customCategory;
    }

    for (const entry of store.procedures || []) {
      const categoryId = entry?.category_id;
      const category = byId[categoryId];
      if (!category || !entry?.id) continue;
      category.procedures.push({
        id: entry.id,
        title: entry.title,
        keywords: entry.keywords || [],
        body: entry.body || '',
        custom: true,
      });
    }
  }

  function applyCustomPayload(data) {
    mergeCustomStore(data.store || {});
    trackCustomMeta(data.meta || {});
    canEdit = Boolean(data.can_edit);
    return {
      ok: true,
      canEdit,
      persistence: data.persistence || null,
    };
  }

  function invalidateCustomCache() {
    const cache = window.Lav60Cache;
    cache?.forget?.(cache?.KEYS?.supportCustom || 'lav60:support:custom');
  }

  async function loadCustomEntries(force = false) {
    const knowledge = await loadKnowledgeBase(force === true);
    resetCategories();
    canEdit = false;
    trackCustomMeta();

    const cache = window.Lav60Cache;
    const cacheKey = cache?.KEYS?.supportCustom || 'lav60:support:custom';
    const ttlMs = cache?.getTtl?.('supportCustom') || 5 * 60 * 1000;

    if (!force && cache?.getFresh) {
      const cached = cache.getFresh(cacheKey, ttlMs);
      if (cached?.store !== undefined) {
        const applied = applyCustomPayload(cached);
        return { ...applied, knowledgeOk: knowledge.ok, fromCache: true };
      }
    }

    try {
      const fetcher = window.Lav60Auth?.panelFetch || ((url) => fetch(url, { credentials: 'same-origin' }));
      const fetchCustom = async () => {
      const res = await fetcher('/api/support/custom');
        if (!res.ok) return null;
        return res.json();
      };
      const data = cache?.dedupe
        ? await cache.dedupe(`${cacheKey}:fetch`, fetchCustom)
        : await fetchCustom();
      if (!data) return { ok: knowledge.ok, knowledgeOk: knowledge.ok };
      cache?.put?.(cacheKey, data, { persist: true });
      const applied = applyCustomPayload(data);
      return { ...applied, knowledgeOk: knowledge.ok };
    } catch {
      return { ok: knowledge.ok, knowledgeOk: knowledge.ok };
    }
  }

  function isCustomProcedure(categoryId, procedureId) {
    return customProcedureKeys.has(`${categoryId}:${procedureId}`);
  }

  function isCustomCategory(categoryId) {
    return customCategoryIds.has(categoryId);
  }

  function findProcedure(categoryId, procedureId) {
    const category = CATEGORIES.find((item) => item.id === categoryId);
    if (!category) return null;

    const procedure = category.procedures.find((item) => item.id === procedureId);
    if (!procedure) return null;

    return {
      ...procedure,
      categoryId: category.id,
      categoryTitle: category.title,
      categoryGroup: category.group,
      categoryIcon: category.icon,
    };
  }

  const STOP_WORDS = new Set([
    'a', 'o', 'as', 'os', 'de', 'da', 'do', 'das', 'dos', 'e', 'em', 'no', 'na', 'nos', 'nas',
    'um', 'uma', 'uns', 'umas', 'para', 'por', 'com', 'que', 'qual', 'quais', 'como', 'onde',
    'se', 'ao', 'aos', 'e', 'eh', 'sao', 'ser', 'esta', 'este', 'essa', 'esse', 'the', 'ja',
  ]);

  const TOKEN_SYNONYMS = {
    maquina: ['maquina', 'maquinas', 'lavadora', 'lavadoras', 'secadora', 'secadoras', 'equipamento'],
    erro: ['erro', 'erros', 'codigo', 'codigos', 'falha', 'falhas', 'de1', 'oe', 'ue', 'fe', 'le', 'ie'],
    cartao: ['cartao', 'maquineta', 'pinpad', 'microtef', 'pagamento', 'credito', 'debito'],
    offline: ['offline', 'fora', 'rede', 'ping', 'conexao', 'internet'],
    loja: ['loja', 'lojas', 'unidade', 'mapa', 'localizacao', 'endereco', 'onde', 'fica'],
    roupa: ['roupa', 'roupas', 'manchada', 'manchadas', 'cheiro', 'lavagem'],
    cupom: ['cupom', 'cupons', 'desconto', 'promocao'],
    ar: ['ar', 'arcondicionado', 'clima', 'temperatura', 'sensor'],
    totem: ['totem', 'notebook', 'computador', 'ativacao'],
    noteiro: ['noteiro', 'cedula', 'cedulas', 'dinheiro', 'saldo'],
  };

  const CHAT_CONTEXT_MAX_CHARS = 20000;

  function normalizeText(value) {
    return String(value || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim();
  }

  function extractStoreCode(query) {
    const match = String(query || '').match(/\b([a-z]{2}\d{2,4})\b/i);
    return match ? match[1].toLowerCase() : '';
  }

  function regionForStoreCode(code) {
    if (!code || code.length < 2) return null;
    const uf = code.slice(0, 2).toUpperCase();
    return MAP_REGIONS.find((region) => (
      region.states.split(/\s*-\s*/).some((part) => part.trim().toUpperCase() === uf)
    )) || null;
  }

  function expandQueryTokens(query) {
    const normalized = normalizeText(query);
    const rawTokens = normalized.split(/[^a-z0-9]+/).filter((token) => token.length > 1);
    const tokens = new Set(rawTokens.filter((token) => !STOP_WORDS.has(token)));

    rawTokens.forEach((token) => {
      Object.entries(TOKEN_SYNONYMS).forEach(([key, synonyms]) => {
        if (synonyms.includes(token) || token.includes(key) || key.includes(token)) {
          synonyms.forEach((syn) => tokens.add(syn));
        }
      });
    });

    const storeCode = extractStoreCode(query);
    if (storeCode) tokens.add(storeCode);

    return [...tokens];
  }

  function stripProcedureBody(html) {
    return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  function listAllProcedureRecords() {
    const rows = [];
    for (const category of CATEGORIES) {
      for (const procedure of category.procedures || []) {
        rows.push({
          category_id: category.id,
          category_title: category.title,
          category_group: category.group,
          category_summary: category.summary || '',
          procedure_id: procedure.id,
          title: procedure.title,
          keywords: procedure.keywords || [],
          body_raw: procedure.body || '',
          body: stripProcedureBody(procedure.body),
        });
      }
    }
    return rows;
  }

  function scoreProcedure(record, tokens, normalizedQuery) {
    const searchable = normalizeText([
      record.category_id,
      record.category_title,
      record.category_summary,
      record.procedure_id,
      record.title,
      ...(record.keywords || []),
      record.body,
    ].join(' '));

    let score = 0;

    tokens.forEach((token) => {
      if (!token) return;
      if (searchable.includes(token)) score += 2;
      if (record.title && normalizeText(record.title).includes(token)) score += 3;
      if ((record.keywords || []).some((kw) => normalizeText(kw).includes(token))) score += 2;
    });

    if (normalizedQuery && normalizeText(record.title).includes(normalizedQuery)) score += 6;
    if (normalizedQuery.length > 8 && searchable.includes(normalizedQuery)) score += 4;

    const storeCode = extractStoreCode(normalizedQuery);
    if (storeCode && record.category_id === 'lojas-rede') score += 8;

    if (/erro|codigo|de1|oe|ue|fe|le|ie/.test(normalizedQuery) && record.procedure_id === 'codigos-erro') {
      score += 10;
    }
    if (/offline|ping|rede/.test(normalizedQuery) && record.procedure_id === 'maquinas-offline') {
      score += 6;
    }
    if (/cartao|maquineta|microtef|pinpad/.test(normalizedQuery) && record.category_id === 'maquineta') {
      score += 5;
    }

    return score;
  }

  function buildStoreContextItem(storeCode) {
    const region = regionForStoreCode(storeCode);
    const catalogStore = (
      window.Lav60?.heartbeatCatalog?.stores
      || window.Lav60SupportStores?.stores
      || []
    ).find(
      (store) => String(store.id || '').toLowerCase() === storeCode,
    );
    const name = catalogStore?.name || storeCode.toUpperCase();
    const status = catalogStore?.lav60_status === 'suspended' ? ' (suspensa no Lav60)' : '';
    const regionText = region
      ? `${region.title.replace('Lojas do ', '').replace('Lojas de ', '')} — estados ${region.states}`
      : 'consulte o mapa de lojas no painel';

    return {
      category_id: 'lojas-rede',
      category_title: 'Localização de lojas',
      procedure_id: 'mapa-localizacao',
      title: `Localização da loja ${storeCode.toUpperCase()}`,
      body: [
        `Loja ${storeCode.toUpperCase()} (${name})${status}.`,
        `Região: ${regionText}.`,
        'Para endereço exato, abra o Mapa de lojas no Suporte (região correspondente) ou consulte a ficha da loja no menu Lojas do painel.',
        'Os códigos usam UF + número (ex.: PB05 = Paraíba/Nordeste).',
      ].join(' '),
      score: 999,
    };
  }

  function truncateBody(text, maxLen) {
    const value = String(text || '').trim();
    if (value.length <= maxLen) return value;
    return `${value.slice(0, Math.max(0, maxLen - 1)).trim()}…`;
  }

  function estimateContextBlockLen(item) {
    const category = item.category_title || item.category_id || '';
    const title = item.title || '';
    const body = item.body || '';
    return `[${category}] ${title}\n${body}`.length + 8;
  }

  function buildChatContext(query, limit = 24) {
    const normalizedQuery = normalizeText(query);
    const tokens = expandQueryTokens(query);
    const records = listAllProcedureRecords();

    const scored = records
      .map((record) => ({
        ...record,
        score: scoreProcedure(record, tokens, normalizedQuery),
      }))
      .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));

    const bestScore = scored[0]?.score || 0;
    const selected = [];
    const seen = new Set();
    let usedChars = 0;

    function pushItem(item, bodyLimit) {
      const key = `${item.category_id}:${item.procedure_id}`;
      if (seen.has(key)) return false;

      const body = bodyLimit ? truncateBody(item.body, bodyLimit) : item.body;
      const candidate = {
        category_id: item.category_id,
        category_title: item.category_title,
        procedure_id: item.procedure_id,
        title: item.title,
        body,
        score: item.score || 0,
      };
      const blockLen = estimateContextBlockLen(candidate);
      if (usedChars + blockLen > CHAT_CONTEXT_MAX_CHARS) return false;

      seen.add(key);
      selected.push(candidate);
      usedChars += blockLen;
      return true;
    }

    const storeCode = extractStoreCode(query);
    if (storeCode || /onde fica|localiza|endereco|mapa de loja|mapa de lojas/.test(normalizedQuery)) {
      if (storeCode) {
        pushItem(buildStoreContextItem(storeCode), null);
      } else {
        const mapItem = scored.find((item) => item.procedure_id === 'mapa-localizacao')
          || records.find((item) => item.procedure_id === 'mapa-localizacao');
        if (mapItem) pushItem({ ...mapItem, score: 999 }, null);
      }
    }

    const prioritized = bestScore >= 4
      ? scored.slice(0, Math.max(6, limit))
      : scored;

    prioritized.forEach((item, index) => {
      const isTop = index < 3 && item.score > 0;
      const bodyLimit = isTop ? null : (bestScore >= 2 ? 900 : 650);
      pushItem(item, bodyLimit);
    });

    scored.forEach((item) => {
      if (selected.length >= limit) return;
      pushItem(item, 450);
    });

    if (!selected.length) {
      records.slice(0, limit).forEach((item) => pushItem({ ...item, score: 0 }, 600));
    }

    return selected;
  }

  function buildKnowledgeIndex() {
    return listAllProcedureRecords().map((record) => ({
      category_id: record.category_id,
      category_title: record.category_title,
      procedure_id: record.procedure_id,
      title: record.title,
      keywords: record.keywords || [],
      summary: truncateBody(record.body, 220),
    }));
  }

  function search(query) {
    const normalized = normalizeText(query);
    if (!normalized) return [];

    const results = [];

    for (const category of CATEGORIES) {
      for (const procedure of category.procedures) {
        const searchable = normalizeText([
          category.id,
          category.title,
          category.summary,
          procedure.id,
          procedure.title,
          ...(procedure.keywords || []),
          stripProcedureBody(procedure.body),
        ].join(' '));

        if (searchable.includes(normalized) || expandQueryTokens(query).some((token) => searchable.includes(token))) {
          results.push({
            categoryId: category.id,
            procedureId: procedure.id,
            title: procedure.title,
            categoryTitle: category.title,
          });
        }
      }
    }

    return results;
  }

  function buildLocalAnswer(query) {
    const context = buildChatContext(query, 8);
    const ranked = [...context]
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score);
    const picks = (ranked.length ? ranked : context.slice(0, 1)).slice(0, 3);

    const toSource = (item) => ({
      category_id: item.category_id,
      procedure_id: item.procedure_id,
      title: item.title,
      category_title: item.category_title,
    });

    if (!picks.length) {
      return {
        reply: 'Não encontrei runbooks para essa pergunta. Tente termos como maquineta, lavadora offline, código DE1 ou use as sugestões ao lado.',
        html: '',
        sources: [],
        bestScore: 0,
        ambiguous: false,
      };
    }

    const best = picks[0];
    const showFullHtml = picks.length === 1 || best.score >= 6;

    if (showFullHtml) {
      const proc = findProcedure(best.category_id, best.procedure_id);
      return {
        reply: `**${best.title}** · ${best.category_title}`,
        html: proc?.body || '',
        sources: picks.map(toSource),
        bestScore: best.score,
        ambiguous: false,
      };
    }

    const reply = [
      'Encontrei estes runbooks relacionados:',
      ...picks.map((item, index) => (
        `${index + 1}. **${item.title}** (${item.category_title}) — ${truncateBody(item.body, 240)}`
      )),
      '',
      'Abra um runbook em "Runbooks citados" para ver o passo a passo completo.',
    ].join('\n');

    return {
      reply,
      html: '',
      sources: picks.map(toSource),
      bestScore: best.score,
      ambiguous: picks.length > 1 && best.score < 6,
    };
  }

  function searchForChat(query, limit = 8) {
    return buildChatContext(query, Math.max(limit, 12));
  }

  function searchSuggestions() {
    const titles = listAllProcedureRecords().map((record) => record.title);
    return [...new Set([
      ...titles,
      'maquineta offline',
      'códigos de erro DE1',
      'mapa de lojas',
      'onde fica a loja',
    ])].slice(0, 24);
  }

  window.Lav60SupportCatalog = {
    get MAP_REGIONS() { return MAP_REGIONS; },
    get CATEGORIES() { return CATEGORIES; },
    get BASE_CATEGORIES() { return BASE_CATEGORIES; },
    findProcedure,
    search,
    searchForChat,
    buildChatContext,
    buildLocalAnswer,
    buildKnowledgeIndex,
    listAllProcedureRecords,
    get searchSuggestions() { return searchSuggestions(); },
    loadKnowledgeBase,
    reloadKnowledgeBase: () => loadKnowledgeBase(true),
    loadCustomEntries,
    invalidateCustomCache,
    isCustomProcedure,
    isCustomCategory,
    get canEdit() { return canEdit; },
  };
})();
