# Documentação de Endpoints — Lav60 App

Referência completa dos endpoints consumidos pelo aplicativo **Lavanderia 60 Minutos**. Os caminhos abaixo são relativos à **Base URL** configurada em `src/services/api.ts`.

---

## Índice

1. [Configuração e autenticação](#configuração-e-autenticação)
2. [Códigos de erro](#códigos-de-erro)
3. [Autenticação e sessão](#autenticação-e-sessão)
4. [Usuários](#usuários)
5. [Administradores e lojas](#administradores-e-lojas)
6. [Dashboard (Home)](#dashboard-home)
7. [Faturamento e receitas](#faturamento-e-receitas)
8. [Vendas](#vendas)
9. [Compras de crédito](#compras-de-crédito)
10. [Despesas](#despesas)
11. [Faturas (invoices)](#faturas-invoices)
12. [Notificações](#notificações)
13. [Máquinas e dosadoras (Blynk)](#máquinas-e-dosadoras-blynk)
14. [E-commerce HiPlim — Sale HiPlim](#e-commerce-hiplim--sale-hi_plim)
15. [Integração Omie](#integração-omie)
16. [Pagamentos HiPlim](#pagamentos-hiplim)
17. [APIs externas](#apis-externas)
18. [Serviços do app (referência)](#serviços-do-app-referência)

---

## Configuração e autenticação

### Base URL

| Variável | Padrão |
|----------|--------|
| `API_BASE_URL` | `https://sistema.lavanderia60minutos.com.br` |

### Headers padrão (todas as requisições)

| Header | Valor | Obrigatório |
|--------|-------|-------------|
| `Content-Type` | `application/json` | Sim (exceto upload de avatar e `update_order`) |
| `X-Token` | Valor de `API_TOKEN` (`.env`) | Sim |
| `Authorization` | `Bearer {access_token}` | Após login (maioria dos endpoints autenticados) |

### Exemplo com cURL

```bash
curl -X GET \
  "https://sistema.lavanderia60minutos.com.br/api/v1/stores/by_admin_id?admin_id=123" \
  -H "Content-Type: application/json" \
  -H "X-Token: SEU_API_TOKEN" \
  -H "Authorization: Bearer SEU_ACCESS_TOKEN"
```

### Fluxo de autenticação no app

1. Login via `GET /api/v1/sign_in/authenticate_multi_account`
2. Armazena `access_token` e define `Authorization: Bearer ...`
3. Registra nome do dispositivo via `PATCH /api/v1/sign_in/access_token/device_name`
4. Sincroniza token de push via `PATCH /api/v1/sign_in/token_notification`
5. Em `401` ou `403` (exceto rotas de sign_in), o app faz logout automático

---

## Códigos de erro

Tratamento centralizado em `src/services/api.ts`:

| Status | Comportamento no app |
|--------|----------------------|
| `401` | Logout — "Não autorizado. Faça login novamente." |
| `403` | Logout — "Sessão expirada." |
| `404` | Toast com `data.message` ou "Recurso não encontrado." |
| `422` | Toast com erros de validação (`data.errors` ou `data.message`) |
| `500` / sem status | Toast — "Erro no servidor. Tente novamente mais tarde." |

---

## Autenticação e sessão

### `GET /api/v1/sign_in/authenticate_multi_account`

Autentica o administrador (suporte a múltiplas contas/lojas).

**Query params**

| Parâmetro | Tipo | Obrigatório | Descrição |
|-----------|------|-------------|-----------|
| `email` | string | Sim | E-mail (URL-encoded) |
| `password` | string | Sim | Senha (URL-encoded) |

**Resposta (exemplo)**

```json
{
  "access_token": "eyJhbGciOiJIUzI1NiJ9...",
  "admin": {
    "data": {
      "id": "1",
      "name": "Franqueado",
      "status": "active",
      "type": "admin",
      "role": "franchisee",
      "stores": [
        {
          "code": "LOJA01",
          "tax_id_number": "12345678000199"
        }
      ]
    }
  }
}
```

**Uso no app:** `src/contexts/AuthContext.tsx` — `signIn()`

---

### `PATCH /api/v1/sign_in/access_token/device_name`

Registra o nome do dispositivo após o login.

**Query params**

| Parâmetro | Tipo | Obrigatório |
|-----------|------|-------------|
| `device_name` | string | Sim |

**Body:** vazio `{}`

**Headers:** `X-Token` + `Authorization: Bearer {token}`

**Uso no app:** `AuthContext.signIn()`

---

### `PATCH /api/v1/sign_in/token_notification`

Sincroniza o token FCM/APNs para notificações push.

**Body (JSON)**

```json
{
  "email": "usuario@email.com",
  "token_notification": "fcm_ou_apns_token"
}
```

**Headers:** `X-Token` + `Authorization`

**Uso no app:** `src/push/pushTokenService.ts`

---

## Usuários

Endpoints legados fora do prefixo `/api/v1`.

### `POST /users`

Cadastro de novo usuário.

**Body (JSON)**

```json
{
  "name": "Nome Completo",
  "email": "email@exemplo.com",
  "password": "senha123"
}
```

**Uso no app:** `src/screens/sessions/SignUp.tsx` — após cadastro, chama `signIn()`.

---

### `PUT /users/`

Atualiza dados do perfil do usuário logado.

**Body (JSON)**

```json
{
  "name": "Novo Nome",
  "email": "email@exemplo.com",
  "password": "nova_senha",
  "old_password": "senha_atual",
  "confirm_password": "nova_senha"
}
```

Campos de senha são opcionais (só enviados ao alterar senha).

**Headers:** `Authorization: Bearer {token}`

**Uso no app:** `src/screens/Profile.tsx`

---

### `PATCH /users/avatar`

Upload de foto de perfil.

**Body:** `multipart/form-data` com campo `avatar` (arquivo de imagem)

**Headers:** `Content-Type: multipart/form-data` + `Authorization`

**Resposta:** `{ "avatar": "nome_do_arquivo.jpg" }`

**URL da imagem:** `{API_BASE_URL}/avatar/{avatar}`

**Uso no app:** `src/screens/Profile.tsx`

---

## Administradores e lojas

### `GET /api/v1/admins/by_admin_id`

Retorna dados do administrador logado.

**Query params**

| Parâmetro | Tipo | Obrigatório |
|-----------|------|-------------|
| `admin_id` | string | Sim |

**Resposta:** `{ "data": { "id", "name", "role", "store_code", ... } }`

**Uso no app:** `AuthContext.loadUserData()`, `Home.handleUpdateAdminRole()`

---

### `GET /api/v1/stores/by_admin_id`

Lista lojas vinculadas ao administrador.

**Query params**

| Parâmetro | Tipo | Obrigatório |
|-----------|------|-------------|
| `admin_id` | string | Sim |

**Resposta:** `{ "data": [ { "id", "attributes": { "code", "name", "tax_id_number", ... } } ] }`

**Uso no app:** `AuthContext.loadStores()`, `Home.handleUpdateStoreCode()`

---

### `GET /api/v1/stores/get_company_id`

Retorna o ID da empresa para integração com chat de suporte.

**Query params**

| Parâmetro | Tipo | Obrigatório |
|-----------|------|-------------|
| `store_code` | string | Sim |

**Resposta:** `{ "data": "company_id" }`

**Uso no app:** `src/screens/Suport.tsx`

---

## Dashboard (Home)

Todos exigem `admin_id` e `store_code` na query string.

### Receitas agregadas

#### `GET /api/v1/revenues/by_admin_id`

**Query params**

| Parâmetro | Tipo | Obrigatório | Valores |
|-----------|------|-------------|---------|
| `admin_id` | string | Sim | ID do admin |
| `store_code` | string | Sim | Código da loja |
| `revenue_type` | string | Sim | Ver tabela abaixo |
| `year` | number | Condicional | Obrigatório para `yearly` e `monthly` com filtro |
| `month` | number | Condicional | Obrigatório para `monthly` com filtro |

**Valores de `revenue_type`**

| Valor | Descrição | Retorno |
|-------|-----------|---------|
| `yearly` | Faturamento anual | Valor ou lista (conforme contexto) |
| `monthly` | Faturamento mensal | Valor ou lista |
| `last_12_month` | Total últimos 12 meses | String/valor |
| `average_last_12_month` | Média últimos 12 meses | String/valor |

**Uso no app:** `Dashboard`, `InvoicingYearly`, `InvoicingMonthly`

---

#### `GET /api/v1/revenues/by_admin_id/last_12_months`

Série temporal dos últimos 12 meses (gráfico).

**Query params:** `admin_id`, `store_code`

**Uso no app:** `src/screens/panel/Dashboard.tsx`

---

### Indicadores da loja

| Endpoint | Descrição |
|----------|-----------|
| `GET /api/v1/home/by_admin_id/status_store_contract` | Status do contrato da loja |
| `GET /api/v1/home/by_admin_id/status_store_cleaner` | Status da limpeza / última limpeza |
| `GET /api/v1/home/by_admin_id/customer_frequency` | Frequência de clientes (gráfico pizza) |
| `GET /api/v1/home/by_admin_id/customer_gender` | Distribuição por gênero |
| `GET /api/v1/home/by_admin_id/customer_age` | Distribuição por faixa etária |

**Query params (todos):** `admin_id`, `store_code`

**Uso no app:** `src/screens/panel/Dashboard.tsx`

---

## Faturamento e receitas

Mesmos endpoints de receita documentados acima, usados em telas específicas:

| Tela | Endpoint | Filtros extras |
|------|----------|----------------|
| Faturamento anual | `GET /api/v1/revenues/by_admin_id` | `revenue_type=yearly&year={ano}` |
| Faturamento mensal | `GET /api/v1/revenues/by_admin_id` | `revenue_type=monthly&month={mes}&year={ano}` |

---

## Vendas

### `GET /api/v1/sales/by_admin_id`

Lista vendas do período.

**Query params**

| Parâmetro | Tipo | Obrigatório |
|-----------|------|-------------|
| `admin_id` | string | Sim |
| `store_code` | string | Sim |
| `month` | number | Sim |
| `year` | number | Sim |
| `day` | number | Não | Filtro por dia específico |

**Resposta:** Array de `SaleDTO` (campos incluem `store-code`, data, valor, etc.)

**Uso no app:** `src/screens/panel/financial/Sales.tsx`

---

### `GET /api/v1/sales/total_value/by_admin_id`

Total de vendas no período (mesmos query params de `sales/by_admin_id`).

**Resposta:** Valor total (string formatada ou numérica).

**Uso no app:** `Sales.tsx`

---

## Compras de crédito

### `GET /api/v1/credit_purchases/by_admin_id`

Lista compras de crédito (recargas).

**Query params**

| Parâmetro | Tipo | Obrigatório |
|-----------|------|-------------|
| `admin_id` | string | Sim |
| `store_code` | string | Sim |
| `month` | number | Sim |
| `year` | number | Sim |
| `day` | number | Não |

**Uso no app:** `Revenues.tsx`, `RevenuesHome.tsx`

---

### `GET /api/v1/credit_purchases/total_value/by_admin_id`

Total de compras de crédito no período (mesmos params).

**Uso no app:** `Revenues.tsx`, `RevenuesHome.tsx`

---

## Despesas

### `GET /api/v1/stores/expenditures/by_admin_id`

Lista despesas da loja.

**Query params**

| Parâmetro | Tipo | Obrigatório |
|-----------|------|-------------|
| `admin_id` | string | Sim |
| `store_code` | string | Sim |
| `month` | number | Não | Filtro por mês |
| `year` | number | Não | Filtro por ano |

Sem `month`/`year`: retorna despesas do período atual.

**Uso no app:** `src/screens/panel/financial/Expenses.tsx`

---

## Faturas (invoices)

### `GET /api/v1/invoices/by_admin_id`

Lista faturas/cobranças do administrador.

**Query params**

| Parâmetro | Tipo | Obrigatório | Valores |
|-----------|------|-------------|---------|
| `admin_id` | string | Sim | |
| `store_code` | string | Sim | |
| `status` | string | Não | `not_paid`, `overdue`, `paid`, `waived`, `cancelled` |

**Resposta:** Array de faturas (`invoiceDTO`).

**Uso no app:** `Invoices.tsx`, `InvoicesHome.tsx`, `Home.checkPendingInvoices()`

---

### `GET /api/v1/invoices`

Consulta status de uma fatura específica (ex.: confirmação de pagamento PIX).

**Query params**

| Parâmetro | Tipo | Obrigatório |
|-----------|------|-------------|
| `invoice_id` | string/number | Sim |

**Resposta:** Objeto com `status` (ex.: `"Paga"`).

**Uso no app:** `src/screens/panel/financial/InvoicePix.tsx`

---

### PDF de fatura (URL estática)

Não é chamada via axios; abre no navegador:

```
{API_BASE_URL}/invoice_pdf/{invoice_id}.pdf   → tipo Invoice
{API_BASE_URL}/charge_pdf/{invoice_id}.pdf    → outros tipos
```

**Uso no app:** `InvoicePix.tsx`

---

## Notificações

### `GET /api/v1/notifications`

Lista notificações da loja.

**Query params**

| Parâmetro | Tipo | Obrigatório |
|-----------|------|-------------|
| `store_code` | string | Sim |

**Resposta:** Array de notificações ou `{ "data": [...] }`

**Uso no app:** `src/services/notificationsService.ts`

---

## Máquinas e dosadoras (Blynk)

### `GET /api/v1/machines`

Lista máquinas e tempos de dosagem da loja.

**Query params:** `store_code`

**Resposta:** `{ "data": [ { "attributes": { "name", "time_dosage" } } ] }`

**Uso no app:** `src/screens/MyStoreDetails.tsx`

---

### `PUT /api/v1/machines/update/dosage`

Atualiza o temporizador de dosagem de uma máquina.

**Body (JSON)**

```json
{
  "store_code": "LOJA01",
  "name": "432",
  "time_dosage": "30"
}
```

**Uso no app:** `MyStoreDetails.handleNewTimer()`

---

### `GET /api/v1/blynk/dosage_pump_clear`

Aciona limpeza das dosadoras.

**Query params:** `store_code`

**Uso no app:** `MyStoreDetails.handleCleanMachines()`

---

### `GET /api/v1/blynk/dosage_pump_activate`

Aciona uma dosadora específica.

**Query params**

| Parâmetro | Descrição |
|-----------|-----------|
| `store_code` | Código da loja |
| `machine` | ID da máquina (ex.: `432`, `543`, `654`) |
| `pump` | Identificador da bomba/dosadora |

**Uso no app:** `MyStoreDetails.handleOnPump()`

---

## E-commerce HiPlim — Sale HiPlim

Base: `/api/v1/sale_hi_plim`

Implementação: `ordersService.ts`, `deliveryAddressService.ts`, `productsService.ts`  
Tipagens: `src/types/saleHiPlim.ts`

---

### Produtos

#### `GET /api/v1/sale_hi_plim/products/fixed_products`

Lista produtos fixos do catálogo HiPlim.

- **Auth:** apenas `X-Token` (sem Bearer, conforme comentário no código)
- **Resposta:** array de produtos (formato Omie legado ou `Product` normalizado)

**Uso no app:** `productsService.getFixedProducts()`

---

#### `GET /api/v1/sale_hi_plim/products`

Lista produtos com paginação.

**Query params**

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `page` | number | Página |
| `per_page` | number | Itens por página |
| `active` | boolean | Filtrar ativos |

**Resposta**

```json
{
  "data": [ { "id", "code", "description", "price", "active", "image_url" } ],
  "pagination": { "current_page", "total_pages", "total_count", "per_page" }
}
```

---

### Pedidos

#### `GET /api/v1/sale_hi_plim/orders`

Lista pedidos.

**Query params:** `page`, `per_page`, `stage`, `admin_id`, `store_code`

---

#### `GET /api/v1/sale_hi_plim/orders/:id`

Detalhe de um pedido.

**Resposta:** `{ "data": Order }`

---

#### `POST /api/v1/sale_hi_plim/orders/create_order`

Cria um novo pedido.

**Body (JSON)**

```json
{
  "admin_id": "1",
  "store_code": "LOJA01",
  "items": [
    {
      "product_code": "12345",
      "quantity": 2,
      "unit_price": 29.90
    }
  ]
}
```

**Resposta**

```json
{
  "success": true,
  "message": "Pedido criado",
  "data": { "id", "order_number", "stage", "status", "total_value", "items", ... }
}
```

**Uso no app:** `ECommerce/Home.handleBuyProductsHiplim()`

---

#### `PUT /api/v1/sale_hi_plim/orders/update_order`

Atualiza itens de um pedido existente.

**Content-Type:** `application/x-www-form-urlencoded`

**Body (form-urlencoded)**

```
order_id=123
admin_id=1
store_code=LOJA01
items[][product_code]=12345
items[][quantity]=2
items[][unit_price]=29.90
```

> `order_id` deve ser o ID numérico interno (`numeric_id` ou `order_number`).

**Resposta:** `{ "success", "message", "data": Order }`

**Uso no app:** `ECommerce/OrderDetails.handleBuyProductsHiplim()`, `ordersService.updateOrder()`

---

### Endereços de entrega

#### `GET /api/v1/sale_hi_plim/delivery_addresses`

**Query params:** `store_code` (obrigatório), `page`, `per_page`, `state`

---

#### `GET /api/v1/sale_hi_plim/delivery_addresses/:id`

Retorna um endereço por ID.

---

#### `POST /api/v1/sale_hi_plim/delivery_addresses`

**Body (JSON)**

```json
{
  "store_code": "LOJA01",
  "company_name": "Razão Social",
  "street": "Rua Exemplo",
  "number": "100",
  "complement": "Sala 1",
  "neighborhood": "Centro",
  "zipcode": "01310100",
  "state": "SP",
  "city": "São Paulo",
  "phone": "11999999999"
}
```

---

#### `PUT /api/v1/sale_hi_plim/delivery_addresses/:id`

Atualiza endereço (body parcial ou completo, mesmos campos do POST).

---

#### `DELETE /api/v1/sale_hi_plim/delivery_addresses/:id`

Remove endereço.

**Resposta:** `{ "success": true, "message": "..." }`

---

## Integração Omie

Base: `/api/v1/omies`

Usados no fluxo de e-commerce HiPlim (produtos, clientes, pedidos, frete).

---

### `POST /api/v1/omies/consult_customer_by_cnpj`

Busca cliente Omie pelo CNPJ da loja.

**Body (JSON)**

```json
{
  "page": 1,
  "resgister_by_page": 1,
  "omie_customer_cnpj": "12345678000199"
}
```

**Resposta:** `{ "clientes_cadastro": [ { "codigo_cliente_omie", "enderecoEntrega", ... } ] }`

**Uso no app:** `ECommerce/Home`, `ECommerce/Details`

---

### `POST /api/v1/omies/update_customer`

Atualiza endereço de entrega do cliente no Omie.

**Body (JSON)**

```json
{
  "codigo_cliente_omie": 123456,
  "enderecoEntrega": {
    "entRazaoSocial": "Nome",
    "entEndereco": "Rua",
    "entNumero": "100",
    "entComplemento": "",
    "entBairro": "Bairro",
    "entCEP": "01310100",
    "entEstado": "SP",
    "entCidade": "São Paulo",
    "entSepararEndereco": "S",
    "entTelefone": "11999999999"
  }
}
```

**Uso no app:** `ECommerce/Details.handleUpdateCustomerHiplim()`

---

### `POST /api/v1/omies/consult_products`

Lista produtos/serviços no Omie.

**Body (JSON)**

```json
{
  "produto_servico_list_request": {
    "page": 1,
    "resgister_by_page": 50
  }
}
```

**Resposta:** `{ "produto_servico_cadastro": [ ... ] }` — filtrar `tipoItem === "00"` e `inativo === "N"` no app.

**Uso no app:** `ECommerce/Home.onGetProductsHiplim()`

---

### `GET /api/v1/omies/client/:taxId`

Resolve o ID Omie do cliente a partir do CNPJ/CPF.

**Path param:** `taxId` — CNPJ ou CPF da loja

**Resposta:** `{ "omie_admin_id": 123456 }`

**Uso no app:** `ECommerce/Order.tsx`

---

### `POST /api/v1/omies/consult_orders`

Lista pedidos de venda do cliente no Omie.

**Body (JSON)**

```json
{
  "page": 1,
  "resgister_by_page": 1000,
  "omie_customer_id": 123456
}
```

**Resposta:** `{ "pedido_venda_produto": [ ... ] }` ou objeto único

**Uso no app:** `ECommerce/Order.tsx`

---

### `POST /api/v1/omies/consult_order`

Consulta um pedido Omie por ID.

**Body (JSON)**

```json
{
  "omie_order_id": 987654
}
```

**Resposta:** `{ "pedido_venda_produto": { "cabecalho", "det", "frete", ... } }`

**Uso no app:** `ECommerce/Details`, `utils/waitForOmieOrder.ts`

---

### `POST /api/v1/omies/update_order`

Atualiza pedido no Omie (frete, itens, transportadora).

**Body (JSON)** — estrutura simplificada:

```json
{
  "order_id": "12345",
  "admin_id": "1",
  "store_code": "LOJA01",
  "body_order": {
    "cabecalho": {
      "codigo_pedido": 987654,
      "quantidade_itens": 3
    },
    "frete": {
      "codigo_transportadora": 123,
      "quantidade_volumes": 5,
      "modalidade": "0",
      "outras_despesas": 0
    },
    "informacoes_adicionais": {
      "codigo_categoria": "1.01.03",
      "codigo_conta_corrente": 9797285866,
      "consumidor_final": "S",
      "enviar_email": "N"
    },
    "det": [
      {
        "ide": { "codigo_item_integracao": "PROD001" },
        "produto": {
          "codigo_produto": "PROD001",
          "quantidade": "2",
          "valor_unitario": "29.90"
        }
      }
    ]
  }
}
```

**Uso no app:** `ECommerce/OrderDetails.handleBuyProductsHiplim()`

---

### `GET /api/v1/omies/transporter_by_state`

Consulta transportadora e valor mínimo de frete por cidade/UF.

**Query params**

| Parâmetro | Exemplo |
|-----------|---------|
| `city_and_state` | `São Paulo (SP)` ou `São Paulo` |

**Resposta:** `{ "data": { "attributes": { "id_ref", "min_price" } } }`

**Uso no app:** `ECommerce/Home.fetchFrete()`, `ECommerce/OrderDetails.fetchFrete()`

---

## Pagamentos HiPlim

### `POST /api/v1/payments/hiplim_pix`

Gera cobrança PIX para pedido HiPlim.

**Body (JSON)**

```json
{
  "amount": 150.00,
  "order_number": "12345",
  "code_order_number": "ABC123",
  "store_code": "LOJA01"
}
```

**Resposta:** `{ "data": { "id", "attributes": { "text_content", "qrcode_url" } } }`

**Uso no app:** `ECommerce/payment/Pix.tsx`

---

### `GET /api/v1/payments/status_hiplim_pix`

Verifica se o PIX foi pago.

**Query params**

| Parâmetro | Descrição |
|-----------|-----------|
| `payment_id` | ID retornado na criação do PIX |
| `order_number` | Número do pedido |
| `order_number_integration` | Código de integração |
| `code_order_number` | Código do pedido |

**Resposta:** `{ "data": "OK" }` quando pago.

**Uso no app:** `ECommerce/payment/Pix.handleConfirmPurchase()`

---

### `POST /api/v1/payments/card_hiplim`

Processa pagamento com cartão de crédito.

**Body (JSON)**

```json
{
  "customer_cnpj": "12345678000199",
  "customer_name": "Nome no Cartão",
  "store_code": "LOJA01",
  "amount": "154.47",
  "code_order_number": "ABC123",
  "order_number": "12345",
  "order_number_integration": "67890",
  "card_name": "Nome no Cartão",
  "card_number": "4111111111111111",
  "card_month": "12",
  "card_year": "2028",
  "card_cvv": "123",
  "card_billing_address_street": "Rua",
  "card_billing_address_number": "100",
  "card_billing_address_neighborhood": "Bairro",
  "card_billing_address_zip_code": "01310100",
  "card_billing_address_city": "São Paulo",
  "card_billing_address_state": "SP",
  "pay_installments": "1",
  "other_expenses": "4.47"
}
```

> Use `customer_cpf` em vez de `customer_cnpj` quando o documento tiver 11 dígitos.

**Resposta:** `{ "data": { "attributes": { "status": "paid" } } }`

**Uso no app:** `ECommerce/payment/Card.tsx`

---

## APIs externas

Serviços de terceiros usados diretamente pelo app (fora da API Lav60).

### ViaCEP — Consulta de CEP

```
GET https://viacep.com.br/ws/{cep}/json/
```

**Uso no app:** `src/components/AddressModal.tsx`

---

### DBFrete — Rastreamento de transportadora

**Login**

```
POST https://dbfreteapi.dyndns-web.com/login
```

**Rastreamento**

```
GET https://dbfreteapi.dyndns-web.com/ocorrencias/tracking/{chave_acesso}
```

**Uso no app:** `src/utils/transporter.ts`

---

## Serviços do app (referência)

| Arquivo | Endpoints encapsulados |
|---------|------------------------|
| `src/services/api.ts` | Cliente Axios, interceptors, base URL |
| `src/services/ordersService.ts` | Sale HiPlim — pedidos |
| `src/services/deliveryAddressService.ts` | Sale HiPlim — endereços |
| `src/services/productsService.ts` | Sale HiPlim — produtos |
| `src/services/notificationsService.ts` | Notificações |
| `src/push/pushTokenService.ts` | Token de push |
| `src/contexts/AuthContext.tsx` | Login, lojas, admin |

---

## Resumo rápido — todos os endpoints

| Método | Endpoint |
|--------|----------|
| GET | `/api/v1/sign_in/authenticate_multi_account` |
| PATCH | `/api/v1/sign_in/access_token/device_name` |
| PATCH | `/api/v1/sign_in/token_notification` |
| POST | `/users` |
| PUT | `/users/` |
| PATCH | `/users/avatar` |
| GET | `/api/v1/admins/by_admin_id` |
| GET | `/api/v1/stores/by_admin_id` |
| GET | `/api/v1/stores/get_company_id` |
| GET | `/api/v1/stores/expenditures/by_admin_id` |
| GET | `/api/v1/revenues/by_admin_id` |
| GET | `/api/v1/revenues/by_admin_id/last_12_months` |
| GET | `/api/v1/home/by_admin_id/status_store_contract` |
| GET | `/api/v1/home/by_admin_id/status_store_cleaner` |
| GET | `/api/v1/home/by_admin_id/customer_frequency` |
| GET | `/api/v1/home/by_admin_id/customer_gender` |
| GET | `/api/v1/home/by_admin_id/customer_age` |
| GET | `/api/v1/sales/by_admin_id` |
| GET | `/api/v1/sales/total_value/by_admin_id` |
| GET | `/api/v1/credit_purchases/by_admin_id` |
| GET | `/api/v1/credit_purchases/total_value/by_admin_id` |
| GET | `/api/v1/invoices/by_admin_id` |
| GET | `/api/v1/invoices` |
| GET | `/api/v1/notifications` |
| GET | `/api/v1/machines` |
| PUT | `/api/v1/machines/update/dosage` |
| GET | `/api/v1/blynk/dosage_pump_clear` |
| GET | `/api/v1/blynk/dosage_pump_activate` |
| GET | `/api/v1/sale_hi_plim/products/fixed_products` |
| GET | `/api/v1/sale_hi_plim/products` |
| GET | `/api/v1/sale_hi_plim/orders` |
| GET | `/api/v1/sale_hi_plim/orders/:id` |
| POST | `/api/v1/sale_hi_plim/orders/create_order` |
| PUT | `/api/v1/sale_hi_plim/orders/update_order` |
| GET | `/api/v1/sale_hi_plim/delivery_addresses` |
| GET | `/api/v1/sale_hi_plim/delivery_addresses/:id` |
| POST | `/api/v1/sale_hi_plim/delivery_addresses` |
| PUT | `/api/v1/sale_hi_plim/delivery_addresses/:id` |
| DELETE | `/api/v1/sale_hi_plim/delivery_addresses/:id` |
| POST | `/api/v1/omies/consult_customer_by_cnpj` |
| POST | `/api/v1/omies/update_customer` |
| POST | `/api/v1/omies/consult_products` |
| GET | `/api/v1/omies/client/:taxId` |
| POST | `/api/v1/omies/consult_orders` |
| POST | `/api/v1/omies/consult_order` |
| POST | `/api/v1/omies/update_order` |
| GET | `/api/v1/omies/transporter_by_state` |
| POST | `/api/v1/payments/hiplim_pix` |
| GET | `/api/v1/payments/status_hiplim_pix` |
| POST | `/api/v1/payments/card_hiplim` |

---

*Documentação gerada com base no código-fonte do app Lav60. Última revisão: julho/2026.*
