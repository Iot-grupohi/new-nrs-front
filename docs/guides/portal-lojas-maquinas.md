# Portal — lojas, máquinas e HiBank

Guia prático para consultar lojas, perfil, status HiBank e máquinas via **API Portal** (`sistema.lavanderia60minutos.com.br`).

---

## Visão geral

```
GET /api/v1/stores/codes     → códigos de todas as lojas
GET /api/v1/stores/{code}    → detalhe da loja
GET /api/v1/stores/{code}/profile → loja + HiBank (composto pelo servidor)
GET /api/v1/machines         → máquinas da loja
```

Diferente do totem: aqui os dados vêm do **painel/sistema**, não do fluxo de compra do cliente.

---

## URL base

| Modo | URL |
|------|-----|
| Via servidor local (recomendado) | `http://127.0.0.1:3100` |
| Upstream direto | `https://sistema.lavanderia60minutos.com.br` |

Postman: collection **Lav60 Api Portal - Python** · `baseUrl` = `http://127.0.0.1:3100`

---

## Pré-requisitos

```env
LAV60_UPSTREAM_URL=https://sistema.lavanderia60minutos.com.br
X_TOKEN=seu_token_portal
```

Header em todas as rotas: `X-Token: {token}`

---

## Passo 1 — Códigos de loja

```powershell
curl -H "X-Token: %X_TOKEN%" "http://127.0.0.1:3100/api/v1/stores/codes"
```

Resposta parseada (padrão):

```json
{
  "store_codes": ["PB05", "RN01", "..."],
  "count": 715,
  "cached": true
}
```

| Query | Efeito |
|-------|--------|
| `?force=1` | Ignora cache |
| `?parsed=0` | Resposta crua do upstream |

---

## Passo 2 — Detalhe e perfil

```powershell
curl -H "X-Token: %X_TOKEN%" "http://127.0.0.1:3100/api/v1/stores/PB05"
curl -H "X-Token: %X_TOKEN%" "http://127.0.0.1:3100/api/v1/stores/PB05/profile"
```

O endpoint `/profile` **não existe no upstream** — o servidor monta loja + `hibank_status` a partir dos atributos da loja.

---

## Passo 3 — HiBank

```powershell
curl -H "X-Token: %X_TOKEN%" "http://127.0.0.1:3100/api/v1/hi-banks/account?store_code=PB05"
```

---

## Passo 4 — Máquinas

```powershell
curl -H "X-Token: %X_TOKEN%" "http://127.0.0.1:3100/api/v1/machines?store_code=PB05"
```

Resposta parseada inclui `lav60_status` (`ok` / `suspended`) e lista de máquinas com `code`, `status`, `machine_type`.

Use os códigos reais retornados aqui na [venda no totem](./venda-totem.md) (`released_machine` / `machines[].code`).

---

## Onde entra no fluxo

| Contexto | Documento |
|----------|-----------|
| Comprar créditos / PIX / venda | Guias totem |
| Painel: loja ativa, HiBank, máquinas | **Este documento** |
| Relatório financeiro de créditos | [relatorio-creditos-portal.md](./relatorio-creditos-portal.md) |
| Liberar máquina remotamente | [controle-remoto-gateway.md](./controle-remoto-gateway.md) ou [controle-remoto-powpay.md](./controle-remoto-powpay.md) |

---

## Postman

1. Importe `postman/Lav60 Api Portal - Python.postman_collection.json`
2. `baseUrl` = `http://127.0.0.1:3100`
3. `token` = valor de `X_TOKEN`
4. `storeCode` = ex.: `PB05`

---

## Referências

- [servidor-api-portal.md](./servidor-api-portal.md)
- [servidor-unificado.md](./servidor-unificado.md)
- [api-get-stores.md](../api/api-get-stores.md) — spec totem (endpoint diferente)
