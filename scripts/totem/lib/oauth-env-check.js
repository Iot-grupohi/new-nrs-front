export function validateOAuthEnv(config) {
  const issues = [];

  const uuidPattern =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const jwtPattern = /^eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+$/;

  if (!config.clientId || !config.clientSecret) {
    issues.push("Defina CLIENT_ID e CLIENT_SECRET no .env");
    return issues;
  }

  if (uuidPattern.test(config.clientId)) {
    issues.push(
      "CLIENT_ID parece ser o UUID do cliente (customer_id), não da Security API."
    );
  }

  if (jwtPattern.test(config.clientSecret)) {
    issues.push(
      "CLIENT_SECRET parece ser o JWT do login do cliente — use o secret da Security API do painel."
    );
  }

  if (config.clientId === config.customerId && config.customerId) {
    issues.push("CLIENT_ID está igual ao CUSTOMER_ID — são credenciais diferentes.");
  }

  return issues;
}

export function formatOAuthEnvHelp() {
  return [
    "",
    "Credenciais corretas (painel Lav60 → Security API):",
    "  CLIENT_ID     = identificador da integração (ex: thzIFwGb8v...)",
    "  CLIENT_SECRET = secret gerado no painel (não é senha do cliente)",
    "",
    "NÃO use aqui:",
    "  customer_id  (UUID retornado no login)",
    "  JWT token    (retornado no npm run access)",
    "  X_TOKEN      (token da API do totem)",
  ].join("\n");
}
