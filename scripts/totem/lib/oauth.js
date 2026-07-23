import { fail, getConfig } from "./client.js";
import { formatOAuthEnvHelp, validateOAuthEnv } from "./oauth-env-check.js";
import { explainOAuthError } from "./oauth-errors.js";

export async function getOAuthToken(config = getConfig()) {
  const envIssues = validateOAuthEnv(config);
  if (envIssues.length > 0) {
    fail([...envIssues, formatOAuthEnvHelp()].join("\n"));
  }

  const clientId = config.clientId;
  const clientSecret = config.clientSecret;
  const scope = config.oauthScope || "report_read";

  if (!clientId || !clientSecret) {
    fail(
      [
        "Credenciais OAuth ausentes no .env",
        "Adicione CLIENT_ID e CLIENT_SECRET da Security API (painel Lav60).",
        "Escopo necessário: report_read",
      ].join("\n")
    );
  }

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  });

  const response = await fetch(`${config.baseUrl}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    fail(`OAuth — resposta inválida (${response.status}): ${text}`);
  }

  if (!response.ok) {
    fail(explainOAuthError(response.status, data));
  }

  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
    scope: data.scope,
  };
}

export async function fetchSalesReport(params = {}, config = getConfig()) {
  const { accessToken } = await getOAuthToken(config);

  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      query.set(key, String(value));
    }
  }

  const queryString = query.toString();
  const url = `${config.baseUrl}/api/v1/reports/sales${queryString ? `?${queryString}` : ""}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    },
  });

  const text = await response.text();

  if (response.status === 404) {
    fail(
      [
        "Endpoint /api/v1/reports/sales não encontrado (404).",
        "Possíveis causas:",
        "- Rota ainda não habilitada neste ambiente (staging)",
        "- Security API sem acesso ao relatório de vendas",
        "",
        "Verifique com o suporte Lav60 se report_read inclui sales neste ambiente.",
      ].join("\n")
    );
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    fail(`Relatório de vendas — resposta inválida (${response.status}): ${text.slice(0, 300)}`);
  }

  if (!response.ok) {
    const message = data?.error?.message || data?.message || text;
    fail(`Relatório de vendas falhou (${response.status}): ${message}`);
  }

  return data;
}
