# LAV60 — Painel operacional

Documentação da interface web servida por `panel_server.py` (`frontend/`).

## Navegação

| Rota | Descrição |
|------|-----------|
| `/` ou `index.html` | Dashboard — cards das lojas em `stores.json` |
| `store.html?store={id}` | Operação de uma loja (ex.: `pb05`) |
| `records.html` | Histórico de auditoria |
| `login.html` | Login Firebase (quando configurado) |

O dashboard redireciona para login se Firebase Auth estiver ativo e não houver sessão.

---

## Dashboard (`index.html`)

- Lista lojas de `frontend/stores.json` (`id`, `name`).
- Status **online/offline** vem do heartbeat do agente (`POST /api/heartbeat`), não de polling direto ao agente.
- SSE em `GET /api/heartbeats/stream` atualiza os cards em tempo real.
- Ao abrir uma loja offline por muito tempo, o painel pode bloquear o acesso e redirecionar ao dashboard.

---

## Página da loja (`store.html`)

### Resumo no topo

- **Online** — equipamentos com ping OK no último heartbeat.
- **Saúde** — percentual online/total.
- **Última verificação** — timestamp do heartbeat.

### Seções de equipamentos

Cada card mostra:

- **Número** do equipamento e badge de capacidade (ex.: GIANT).
- **Status** com cor:
  - Verde — Disponível / Online
  - Vermelho — Sem rede (offline)
  - Laranja — Ocupada
  - Roxo — Suspensa
- Metadados: IP, litros, tempo de espera (quando disponíveis na API).

Cards **offline** ou **ocupados** mantêm o mesmo layout (botões visíveis, porém desabilitados). A borda e o fundo dos cards seguem paleta neutra; apenas o badge de status usa cor.

### Lavadoras e secadoras — Liberar

1. Escolha uma opção (dosagem ou minutos). Nenhuma opção vem pré-selecionada.
2. O botão **Liberar** só habilita após a seleção.
3. Ao clicar em **Liberar**, abre modal **Confirmar liberação** com equipamento e parâmetros.
4. **Confirmar** envia o comando ao agente; **Cancelar** ou `Esc` aborta.
5. Após sucesso, modal de confirmação com resumo da operação.

**Dosagens (lavadoras):** Floral simples/dupla, Sport simples/dupla, Sem cheiro (largura dupla).

**Tempos (secadoras):** 15, 30 ou 45 min (configurável via agente).

Durante ciclo ativo (lock local no browser), controles ficam bloqueados e aparece contagem regressiva. Botão **Ativar botões** remove o lock manualmente (com registro em auditoria).

### Dosadoras e ar-condicionado — Acionar

Mesmo fluxo das lavadoras/secadoras, com rótulo **Acionar**:

1. Selecionar produto (Sabão / Floral / Sport) ou temperatura (18°C, 22°C, Desligar).
2. **Acionar** habilita só após seleção.
3. Modal **Confirmar acionamento** antes de executar.

A seção de dosadora inclui ainda:

- **Consultar tempos salvos** — GET no agente (com confirmação genérica).
- **Ajuste de tempo** — painel para `settime` sabão/floral/sport.

### Modais

| Modal | ID | Uso |
|-------|-----|-----|
| Confirmação pré-ação | `#actionPromptModal` | Mensagem amigável + detalhes na tabela (sem termos técnicos como Settime) |
| Sucesso pós-ação | `#confirmModal` | Resumo após comando OK |
| Toast | `#toast` | Erros e avisos rápidos |

### Link para registros

Ícone **Registros** no topo abre `records.html` (auditoria global, não filtrada pela loja atual por padrão).

---

## Página de registros (`records.html`)

Lista eventos gravados no Firestore via `GET /api/audit/logs`.

### Colunas

| Coluna | Conteúdo |
|--------|----------|
| Data / hora | Timestamp do evento (`ts` / `ts_ms`) |
| Operador | E-mail (nome completo no `title` ao passar o mouse) |
| Loja | ID em maiúsculas |
| Equipamento | LAVADORA, SECADORA, DOSADORA, AR-CONDICIONADO (— para login/logout) |
| Código | Número da máquina (— para AC e eventos de auth) |
| Ação | Texto descritivo da operação |
| Tempo secagem | Apenas secadoras: 15 / 30 / 45 min |

### Filtros

- Loja, tipo de ação, sucesso/falha, busca textual.
- Paginação: 40 registros por página, botão **Carregar mais** (`before_ms`).

Requer Firebase Admin configurado no painel. Sem service account, a API retorna `503 audit_unavailable`.

---

## Autenticação

Quando `FIREBASE_*` está no `.env`:

- Login via `login.html` → `POST /api/auth/session` com `idToken`.
- Rotas `/api/audit/*` e demais `/api/*` (exceto auth público e heartbeat) exigem sessão.
- Login e logout geram eventos em `audit_logs`.

Bootstrap do painel: `GET /api/panel/bootstrap` retorna `default_agent_token` para chamadas ao agente.

---

## Cache e tempo real

- Status da loja vem preferencialmente do **heartbeat** (hub no painel).
- `cache.js` / IndexedDB guardam snapshot para carregamento rápido.
- Ao operar equipamento, a página força refresh do status no agente.

---

## Arquivos frontend relevantes

| Arquivo | Responsabilidade |
|---------|------------------|
| `api.js` | HTTP ao agente, heartbeat, catálogo, helpers de status |
| `store.js` | Cards, modais, liberar/acionar, locks de ciclo |
| `stores.js` | Dashboard de lojas |
| `records.js` | Tabela de auditoria |
| `auth.js` | Sessão Firebase |
| `audit.js` | Envio de eventos ao painel |
| `app.css` | Estilos globais e páginas |
