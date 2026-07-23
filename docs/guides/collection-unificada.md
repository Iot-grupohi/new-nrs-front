# Collection unificada — Lav60 Unified API

Uma única collection Postman com **todas** as APIs expostas pelo servidor local.

## Arquivos

| Arquivo | Descrição |
|---------|-----------|
| [Lav60-Unified-API.postman_collection.json](../../postman/Lav60-Unified-API.postman_collection.json) | Collection completa |
| [Lav60-Unified.postman_environment.json](../../postman/Lav60-Unified.postman_environment.json) | Variáveis de ambiente |

Regenerar a collection (após alterar o servidor):

```powershell
npm run postman:generate
npm run postman:simplify
```

## Importar no Postman

1. **Import** → selecione os dois arquivos acima
2. Ative o environment **Lav60 Unified (local)**
3. Preencha os tokens nas variáveis do environment ou da collection

## Estrutura da collection

```
Lav60 Unified API
├── 0 — Servidor (descoberta)     GET /, /api/routes, /health, metadados
├── 1 — Portal (/api/v1)          lojas, máquinas, relatório créditos
├── 2 — Totem (/totem)            login, lojas, produtos, cupom, PIX, venda
├── 3 — OAuth / Security          oauth/token, reports/*
├── 4 — Gateway MQTT (/gateway)   status, comandos, dosadora
└── 5 — Powpay (/powpay)          saúde, túnel, status, comandos
```

## Variáveis principais

| `serverUrl` | `LAV60_SERVER_URL` | `http://127.0.0.1:3100` |
| `storeCode` | — | `pb05` — única variável de loja |
| `x_token` | `X_TOKEN` | Portal + Totem |
| `gateway_token` | `GATEWAY_API_TOKEN` | MQTT Gateway |
| `cloudflare_token` | `CLOUDFLARE_API_TOKEN` | Powpay |

## Scripts automáticos

A collection salva automaticamente:

- `customer_jwt` e `customer_id` após **POST login (CPF)**
- `access_token` após **POST oauth/token**

## Fluxos sugeridos (Runner)

### Totem completo

```
2 — Totem → Login → Conta → Stores → Products → Venda
```

### Portal + relatório

```
1 — Portal → stores/codes → machines → report_credit_purchases/summary
```

### Controle remoto

```
4 — Gateway → status → POST lavadora
5 — Powpay  → health → tunnel-status → status → POST lavadora
```

## Collections individuais

As 11 collections separadas continuam disponíveis em `postman/` para uso focado. A **Unified** substitui todas quando você quer um único ponto de entrada.

Ver [servidor-unificado.md](./servidor-unificado.md) e [README.md](../README.md).
