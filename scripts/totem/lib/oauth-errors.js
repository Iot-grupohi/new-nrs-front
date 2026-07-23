export function explainOAuthError(status, data) {
  const code = data?.error;
  const description = data?.error_description || data?.message || "";

  if (status === 401 && code === "invalid_client") {
    return [
      `OAuth falhou (401): ${description}`,
      "",
      "O CLIENT_ID ou CLIENT_SECRET não foi aceito neste ambiente.",
      "",
      "Verifique no painel Lav60:",
      "1. Security API está **ativa**",
      "2. Credenciais são do ambiente **staging** (não produção)",
      "3. CLIENT_ID e CLIENT_SECRET copiados sem espaços extras",
      "4. Escopo **report_read** habilitado para essa credencial",
      "",
      "Teste: npm run oauth:test",
    ].join("\n");
  }

  if (status === 403) {
    return [
      `OAuth falhou (403): ${description}`,
      "",
      "Token ou credencial sem escopo report_read.",
    ].join("\n");
  }

  return `OAuth falhou (${status}): ${description || code || "erro desconhecido"}`;
}
