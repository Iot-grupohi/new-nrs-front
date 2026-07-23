# Relatório de compras de crédito (Portal)

Consulta compras de crédito (PIX, cartão, loja física) por loja e período — API **Portal**, autenticada com `X-Token`.

> Não confundir com [histórico de vendas OAuth](./historico-vendas.md) (Security API) nem com catálogo de [produtos](./listar-produtos.md).

---

## Visão geral

```
GET /api/v1/report_credit_purchases          → lista paginada + total_credits
GET /api/v1/report_credit_purchases/summary  → KPIs + comparação de período
```

O servidor enriquece respostas com `total_credits` e implementa `/summary` localmente (upstream não expõe).

---

## URL base

```
http://127.0.0.1:3100
```

Postman: **Lav60 Api Portal - Python**

---

## Parâmetros

| Parâmetro | Obrigatório | Exemplo | Descrição |
|-----------|-------------|---------|-----------|
| `store_code` | sim | `PB05` | Código da loja |
| `start_date` | não* | `01/07/2026` | DD/MM/YYYY |
| `end_date` | não* | `10/07/2026` | DD/MM/YYYY |
| `page` | não | `1` | Página |
| `per_page` | não | `20` | Itens por página |
| `all=1` | não | — | Busca todas as páginas |
| `raw=1` | não | — | JSON cru do upstream |
| `compare=1` | summary | — | Compara com período anterior |

\* Para `/summary`, `start_date` e `end_date` são obrigatórios.

---

## Exemplos

### Página única

```powershell
curl -H "X-Token: %X_TOKEN%" ^
  "http://127.0.0.1:3100/api/v1/report_credit_purchases?store_code=PB05&start_date=01/07/2026&end_date=10/07/2026&page=1&per_page=20"
```

### Todas as páginas + total

```powershell
curl -H "X-Token: %X_TOKEN%" ^
  "http://127.0.0.1:3100/api/v1/report_credit_purchases?store_code=PB05&start_date=01/07/2026&end_date=10/07/2026&all=1"
```

### Resumo com comparação

```powershell
curl -H "X-Token: %X_TOKEN%" ^
  "http://127.0.0.1:3100/api/v1/report_credit_purchases/summary?store_code=PB05&start_date=01/07/2026&end_date=10/07/2026&compare=1"
```

Resposta típica do summary:

```json
{
  "store_code": "PB05",
  "total_credits": 10750.0,
  "summary": {
    "transactions": 214,
    "by_payment_method": { "PIX": 180, "CARD": 34 }
  },
  "comparison": {
    "previous_total_credits": 9200.0,
    "change": 1550.0,
    "change_percent": 16.85
  }
}
```

---

## Diferença entre relatórios

| Relatório | Auth | O que mostra |
|-----------|------|--------------|
| **Compras de crédito** (este doc) | `X-Token` | Recargas PIX/cartão na loja |
| **Vendas OAuth** | OAuth2 `report_read` | Vendas/lavagens (se habilitado) |
| **Produtos totem** | `X-Token` | Catálogo para compra |

---

## Postman

Pastas **Relatório de créditos** e **Summary** na collection Portal.

Variáveis: `storeCode`, `startDate`, `endDate`, `token`.

---

## Referências

- Spec: [api-report-credit-purchases.md](../api/api-report-credit-purchases.md)
- [portal-lojas-maquinas.md](./portal-lojas-maquinas.md)
- [historico-vendas.md](./historico-vendas.md)
