import "dotenv/config";
import { fail, getConfig } from "./lib/client.js";
import { formatOAuthEnvHelp, validateOAuthEnv } from "./lib/oauth-env-check.js";
import { getOAuthToken } from "./lib/oauth.js";

async function main() {
  const config = getConfig();
  const envIssues = validateOAuthEnv(config);

  console.log("Teste OAuth2 (Security API)\n");
  console.log(`BASE_URL : ${config.baseUrl}`);
  console.log(`CLIENT_ID: ${config.clientId ? `${config.clientId.slice(0, 6)}...` : "(vazio)"}`);
  console.log(`SCOPE    : ${config.oauthScope || "report_read"}\n`);

  if (envIssues.length > 0) {
    fail([...envIssues, formatOAuthEnvHelp()].join("\n"));
  }

  const token = await getOAuthToken(config);

  if (!token.accessToken) {
    throw new Error("Resposta OAuth sem access_token");
  }

  console.log("OAuth OK\n");
  console.log(`Token obtido (expira em ${token.expiresIn ?? "?"}s)`);
  console.log(`Escopo: ${token.scope ?? "(não informado)"}`);
}

main().catch(() => {
  process.exitCode = 1;
});
