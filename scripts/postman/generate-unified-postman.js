import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..", "..");

function req(name, url, opts = {}) {
  const headers = [];
  if (opts.token === "gateway") headers.push({ key: "X-Token", value: "{{gateway_token}}" });
  if (opts.token === "cloudflare") headers.push({ key: "X-Token", value: "{{cloudflare_token}}" });
  if (opts.token === "x") headers.push({ key: "X-Token", value: "{{x_token}}" });
  if (opts.bearer) headers.push({ key: "Authorization", value: "Bearer {{customer_jwt}}" });
  if (opts.oauth) headers.push({ key: "Authorization", value: "Bearer {{access_token}}" });
  if (opts.contentType) headers.push({ key: "Content-Type", value: "application/json" });
  if (opts.form) headers.push({ key: "Content-Type", value: "application/x-www-form-urlencoded" });
  if (opts.extraHeaders) headers.push(...opts.extraHeaders);

  return {
    name,
    request: {
      ...(opts.noauth ? { auth: { type: "noauth" } } : {}),
      method: opts.method || "GET",
      header: headers,
      ...(opts.body
        ? { body: { mode: "raw", raw: opts.body, options: { raw: { language: opts.form ? "text" : "json" } } } }
        : {}),
      url,
    },
    response: [],
  };
}

function folder(name, items, description) {
  return description ? { name, description, item: items } : { name, item: items };
}

const collection = {
  info: {
    _postman_id: "a1b2c3d4-unified-lav60-api",
    name: "Lav60 Unified API",
    description: [
      "Collection unificada — **todas** as APIs via servidor local `lav60_api_server.py`.",
      "",
      "## Servidor",
      "```",
      "python lav60_api_server.py",
      "http://127.0.0.1:3100",
      "```",
      "",
      "## Prefixos",
      "| Pasta | Prefixo | Token |",
      "|-------|---------|-------|",
      "| Portal | `/api/v1` | `x_token` |",
      "| Totem | `/totem` | `x_token` + `customer_jwt` |",
      "| OAuth | `/totem/oauth` | `client_id` / `client_secret` |",
      "| Gateway MQTT | `/gateway` | `gateway_token` |",
      "| Powpay | `/powpay/{loja}` | `cloudflare_token` |",
      "",
      "Environment: `postman/Lav60-Unified.postman_environment.json`",
      "",
      "Docs: `docs/guides/collection-unificada.md` · `docs/guides/servidor-unificado.md`",
    ].join("\n"),
    schema: "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
  },
  item: [
    folder(
      "0 — Servidor (descoberta)",
      [
        req("GET / (mapa de rotas)", "{{serverUrl}}/"),
        req("GET /api/routes", "{{serverUrl}}/api/routes"),
        req("GET /health", "{{serverUrl}}/health"),
        req("GET /api/v1/upstream (portal)", "{{serverUrl}}/api/v1/upstream"),
        req("GET /api/v1/gateway (meta)", "{{serverUrl}}/api/v1/gateway"),
        req("GET /api/v1/powpay (meta)", "{{serverUrl}}/api/v1/powpay?store_code={{storeCode}}"),
        req("GET /api/v1/totem (meta)", "{{serverUrl}}/api/v1/totem"),
      ].map((r) => ({ ...r, request: { ...r.request, auth: { type: "noauth" } } })),
      "Rotas públicas — sem autenticação."
    ),
    folder(
      "1 — Portal (/api/v1)",
      [
        folder("Lojas e máquinas", [
          req("GET stores/codes", "{{serverUrl}}/api/v1/stores/codes", { token: "x" }),
          req("GET stores/codes?force=1", "{{serverUrl}}/api/v1/stores/codes?force=1", { token: "x" }),
          req("GET stores/{{storeCode}}", "{{serverUrl}}/api/v1/stores/{{storeCode}}", { token: "x" }),
          req("GET stores/{{storeCode}}/profile", "{{serverUrl}}/api/v1/stores/{{storeCode}}/profile", { token: "x" }),
          req("GET hi-banks/account", "{{serverUrl}}/api/v1/hi-banks/account?store_code={{storeCode}}", { token: "x" }),
          req("GET machines", "{{serverUrl}}/api/v1/machines?store_code={{storeCode}}", { token: "x" }),
        ]),
        folder("Relatório créditos", [
          req(
            "GET report_credit_purchases",
            "{{serverUrl}}/api/v1/report_credit_purchases?store_code={{storeCode}}&start_date={{startDate}}&end_date={{endDate}}&page=1&per_page=20",
            { token: "x" }
          ),
          req(
            "GET report_credit_purchases?all=1",
            "{{serverUrl}}/api/v1/report_credit_purchases?store_code={{storeCode}}&start_date={{startDate}}&end_date={{endDate}}&all=1",
            { token: "x" }
          ),
          req(
            "GET report_credit_purchases/summary",
            "{{serverUrl}}/api/v1/report_credit_purchases/summary?store_code={{storeCode}}&start_date={{startDate}}&end_date={{endDate}}&compare=1",
            { token: "x" }
          ),
        ]),
      ],
      "Upstream: sistema.lavanderia60minutos.com.br"
    ),
    folder(
      "2 — Totem (/totem)",
      [
        folder("Login e conta", [
          req("POST login (CPF)", "{{serverUrl}}/totem/api/v1/customers/auth/login", {
            method: "POST",
            token: "x",
            contentType: true,
            body: JSON.stringify({ tax_id_number: "{{tax_id_number}}", password: "{{password}}" }, null, 2),
          }),
          req("GET conta cliente", "{{serverUrl}}/totem/api/v1/customers/bubble/customer", { token: "x", bearer: true }),
        ]),
        folder("Catálogo", [
          req("GET stores", "{{serverUrl}}/totem/api/v1/stores", { token: "x" }),
          req("GET stores?status=active", "{{serverUrl}}/totem/api/v1/stores?status=active", { token: "x" }),
          req("GET products", "{{serverUrl}}/totem/api/v1/products", { token: "x" }),
          req("GET products totem loja", "{{serverUrl}}/totem/api/v1/products?scope=new_totem&store_code={{storeCode}}", { token: "x" }),
        ]),
        folder("Cupom, PIX e venda", [
          req("POST validar cupom", "{{serverUrl}}/totem/api/v1/coupons/{{coupon_code}}/validate", {
            method: "POST",
            token: "x",
            contentType: true,
            body: JSON.stringify({ customer_id: "{{customer_id}}", store_code: "{{storeCode}}" }, null, 2),
          }),
          req("POST PIX", "{{serverUrl}}/totem/api/v1/payments/pix_to_hipag", {
            method: "POST",
            token: "x",
            bearer: true,
            contentType: true,
            body: JSON.stringify({ store_code: "{{storeCode}}", amount: 50.0, product_id: "{{product_id}}" }, null, 2),
          }),
          req("POST venda totem", "{{serverUrl}}/totem/api/v1/sales/totem_sales", {
            method: "POST",
            token: "x",
            bearer: true,
            contentType: true,
            body: JSON.stringify(
              {
                store_code: "{{storeCode}}",
                released_machine: false,
                sale_items: [
                  {
                    value: "25.00",
                    quantity: "1",
                    product_id: "{{product_id}}",
                    soap_type: "floral",
                    machines: [{ code: "{{machine_code}}" }],
                  },
                ],
                payments: [{ value: "25.00", payment_method: "credits" }],
              },
              null,
              2
            ),
          }),
        ]),
      ],
      "Upstream: staging.lavanderia60minutos.com.br"
    ),
    folder(
      "3 — OAuth / Security (/totem)",
      [
        req("POST oauth/token", "{{serverUrl}}/totem/oauth/token", {
          method: "POST",
          noauth: true,
          form: true,
          body: "grant_type=client_credentials&client_id={{client_id}}&client_secret={{client_secret}}&scope=report_read",
        }),
        req("GET reports/sales", "{{serverUrl}}/totem/api/v1/reports/sales?store_code={{storeCode}}", { oauth: true }),
        req("GET reports/customers", "{{serverUrl}}/totem/api/v1/reports/customers", { oauth: true }),
        req("GET reports/credit_purchases", "{{serverUrl}}/totem/api/v1/reports/credit_purchases", { oauth: true }),
        req("GET integrations/health", "{{serverUrl}}/totem/api/v1/integrations/health", { oauth: true }),
      ],
      "OAuth2 client_credentials"
    ),
    folder(
      "4 — Gateway MQTT (/gateway)",
      [
        folder("Saúde", [req("GET / (online)", "{{serverUrl}}/gateway/", { noauth: true })]),
        folder("Status", [
          req("GET status completo", "{{serverUrl}}/gateway/{{storeCode}}/status", { token: "gateway" }),
          req("GET status washer", "{{serverUrl}}/gateway/{{storeCode}}/status/washer/{{washerId}}", { token: "gateway" }),
          req("GET status dryer", "{{serverUrl}}/gateway/{{storeCode}}/status/dryer/{{dryerId}}", { token: "gateway" }),
          req("GET status doser", "{{serverUrl}}/gateway/{{storeCode}}/status/doser/{{doserId}}", { token: "gateway" }),
          req("GET status ac", "{{serverUrl}}/gateway/{{storeCode}}/status/ac", { token: "gateway" }),
        ]),
        folder("Comandos", [
          req("POST lavadora", "{{serverUrl}}/gateway/{{storeCode}}/washer/{{washerId}}", {
            method: "POST",
            token: "gateway",
            contentType: true,
            body: JSON.stringify({ am: "am01-1" }, null, 2),
          }),
          req("POST secadora 30min", "{{serverUrl}}/gateway/{{storeCode}}/dryer/{{dryerId}}", {
            method: "POST",
            token: "gateway",
            contentType: true,
            body: JSON.stringify({ minutes: 30 }, null, 2),
          }),
          req("POST ar-condicionado 22C", "{{serverUrl}}/gateway/{{storeCode}}/ac", {
            method: "POST",
            token: "gateway",
            contentType: true,
            body: JSON.stringify({ temperature: "22" }, null, 2),
          }),
          req("POST LED on", "{{serverUrl}}/gateway/{{storeCode}}/led/on", { method: "POST", token: "gateway" }),
        ]),
        folder("Dosadora", [
          req("POST dosadora type", "{{serverUrl}}/gateway/{{storeCode}}/doser/{{doserId}}", {
            method: "POST",
            token: "gateway",
            contentType: true,
            body: JSON.stringify({ type: "softener1" }, null, 2),
          }),
          req("GET consulta tempos", "{{serverUrl}}/gateway/{{storeCode}}/doser/{{doserId}}/consulta", { token: "gateway" }),
        ]),
      ],
      "Upstream: gateway.lav60.com"
    ),
    folder(
      "5 — Powpay Cloudflare (/powpay)",
      [
        folder("Saúde e túnel", [
          req("GET /health", "{{serverUrl}}/powpay/{{storeCode}}/health", { noauth: true }),
          req("GET tunnel-status", "{{serverUrl}}/powpay/{{storeCode}}/tunnel-status", { noauth: true }),
          req("GET api/agent/config", "{{serverUrl}}/powpay/{{storeCode}}/api/agent/config", { noauth: true }),
        ]),
        folder("Status e rede", [
          req("GET status completo", "{{serverUrl}}/powpay/{{storeCode}}/{{storeCode}}/status", { token: "cloudflare" }),
          req("GET devices", "{{serverUrl}}/powpay/{{storeCode}}/{{storeCode}}/devices", { token: "cloudflare" }),
          req("GET api/network-status", "{{serverUrl}}/powpay/{{storeCode}}/api/network-status", { token: "cloudflare" }),
          req("GET ping-status", "{{serverUrl}}/powpay/{{storeCode}}/ping-status", { token: "cloudflare" }),
        ]),
        folder("Comandos", [
          req("POST lavadora", "{{serverUrl}}/powpay/{{storeCode}}/{{storeCode}}/washer/{{washerId}}", {
            method: "POST",
            token: "cloudflare",
            contentType: true,
            body: JSON.stringify({ am: "am01-1" }, null, 2),
          }),
          req("POST secadora 30min", "{{serverUrl}}/powpay/{{storeCode}}/{{storeCode}}/dryer/{{dryerId}}", {
            method: "POST",
            token: "cloudflare",
            contentType: true,
            body: JSON.stringify({ minutes: 30 }, null, 2),
          }),
          req("POST dosadora bomba", "{{serverUrl}}/powpay/{{storeCode}}/{{storeCode}}/doser/{{doserId}}/bomba", {
            method: "POST",
            token: "cloudflare",
            contentType: true,
            body: JSON.stringify({ pump: 1 }, null, 2),
          }),
        ]),
      ],
      "Upstream: {loja}.powpay.com.br"
    ),
  ],
  event: [
    {
      listen: "test",
      script: {
        type: "text/javascript",
        exec: [
          "const path = pm.request.url.getPath();",
          "if (path.includes('/customers/auth/login') && pm.response.code === 200) {",
          "  const j = pm.response.json();",
          "  if (j.token) pm.collectionVariables.set('customer_jwt', j.token);",
          "  if (j.id) pm.collectionVariables.set('customer_id', j.id);",
          "}",
          "if (path.includes('/oauth/token') && pm.response.code === 200) {",
          "  const j = pm.response.json();",
          "  if (j.access_token) pm.collectionVariables.set('access_token', j.access_token);",
          "}",
        ],
      },
    },
  ],
  variable: [
    { key: "serverUrl", value: "http://127.0.0.1:3100" },
    { key: "x_token", value: "COLE_X_TOKEN_AQUI" },
    { key: "gateway_token", value: "COLE_GATEWAY_API_TOKEN_AQUI" },
    { key: "cloudflare_token", value: "COLE_CLOUDFLARE_API_TOKEN_AQUI" },
    { key: "storeCode", value: "pb05" },
    { key: "startDate", value: "01/07/2026" },
    { key: "endDate", value: "10/07/2026" },
    { key: "tax_id_number", value: "" },
    { key: "password", value: "" },
    { key: "customer_jwt", value: "" },
    { key: "customer_id", value: "" },
    { key: "access_token", value: "" },
    { key: "client_id", value: "" },
    { key: "client_secret", value: "" },
    { key: "coupon_code", value: "CODIGO" },
    { key: "product_id", value: "" },
    { key: "machine_code", value: "432" },
    { key: "washerId", value: "321" },
    { key: "dryerId", value: "765" },
    { key: "doserId", value: "432" },
  ],
};

const out = path.join(root, "postman", "Lav60-Unified-API.postman_collection.json");
fs.writeFileSync(out, JSON.stringify(collection, null, 2));
console.log("Generated:", out);
