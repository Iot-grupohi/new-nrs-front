/**
 * Simplifica variáveis Postman: uma base (serverUrl) + storeCode.
 * Uso: node scripts/simplify-postman-vars.js
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const postmanDir = path.join(__dirname, "..", "..", "postman");

function transformJson(text) {
  return text
    .replaceAll("{{tunnelBaseUrl}}", "{{serverUrl}}/powpay/{{storeCode}}")
    .replaceAll("{{gatewayBaseUrl}}", "{{serverUrl}}/gateway")
    .replaceAll("{{base_url}}", "{{serverUrl}}/totem")
    .replaceAll("{{baseUrl}}", "{{serverUrl}}")
    .replaceAll("{{storeCodeLower}}", "{{storeCode}}")
    .replaceAll("{{store_code}}", "{{storeCode}}");
}

function simplifyCollectionVars(vars) {
  const drop = new Set([
    "tunnelBaseUrl",
    "domainSuffix",
    "gatewayBaseUrl",
    "base_url",
    "baseUrl",
    "storeCodeLower",
    "store_code",
    "panelBaseUrl",
    "server_url",
  ]);
  const kept = vars.filter((v) => !drop.has(v.key));
  const has = (k) => kept.some((v) => v.key === k);
  if (!has("serverUrl")) {
    kept.unshift({ key: "serverUrl", value: "http://127.0.0.1:3100" });
  }
  if (!has("storeCode")) {
    kept.push({ key: "storeCode", value: "pb05" });
  }
  return kept;
}

function processFile(filePath) {
  if (!filePath.endsWith(".json")) return;
  let raw = fs.readFileSync(filePath, "utf8");
  raw = transformJson(raw);
  const data = JSON.parse(raw);

  if (data.variable) {
    data.variable = simplifyCollectionVars(data.variable);
  }

  if (data.info?.description && filePath.includes("Powpay")) {
    // Descrição limpa é mantida manualmente no JSON; não append duplicado.
  }

  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
  console.log("Updated:", path.basename(filePath));
}

// Environment minimal
const envPath = path.join(postmanDir, "Lav60-Unified.postman_environment.json");
const env = {
  id: "lav60-unified-env",
  name: "Lav60 Unified (local)",
  values: [
    { key: "serverUrl", value: "http://127.0.0.1:3100", type: "default", enabled: true },
    { key: "storeCode", value: "pb05", type: "default", enabled: true },
    { key: "x_token", value: "", type: "secret", enabled: true },
    { key: "gateway_token", value: "", type: "secret", enabled: true },
    { key: "cloudflare_token", value: "", type: "secret", enabled: true },
    { key: "token", value: "", type: "secret", enabled: true },
    { key: "startDate", value: "01/07/2026", type: "default", enabled: true },
    { key: "endDate", value: "10/07/2026", type: "default", enabled: true },
    { key: "tax_id_number", value: "", type: "default", enabled: true },
    { key: "password", value: "", type: "secret", enabled: true },
    { key: "customer_jwt", value: "", type: "secret", enabled: true },
    { key: "customer_id", value: "", type: "default", enabled: true },
    { key: "access_token", value: "", type: "secret", enabled: true },
    { key: "client_id", value: "", type: "secret", enabled: true },
    { key: "client_secret", value: "", type: "secret", enabled: true },
    { key: "coupon_code", value: "", type: "default", enabled: true },
    { key: "product_id", value: "", type: "default", enabled: true },
    { key: "machine_code", value: "432", type: "default", enabled: true },
    { key: "washerId", value: "321", type: "default", enabled: true },
    { key: "dryerId", value: "765", type: "default", enabled: true },
    { key: "doserId", value: "432", type: "default", enabled: true },
  ],
  _postman_variable_scope: "environment",
};

fs.writeFileSync(envPath, JSON.stringify(env, null, 2));
console.log("Updated: Lav60-Unified.postman_environment.json");

for (const file of fs.readdirSync(postmanDir)) {
  processFile(path.join(postmanDir, file));
}

console.log("Done.");
