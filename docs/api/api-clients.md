Documentacao de uso da Security API (escopo report_read)
Este documento descreve, de forma geral, como uma aplicacao cliente deve autenticar e consumir endpoints protegidos da API usando OAuth2 Client Credentials.
Publico-alvo: times de integracao, backend, dados e parceiros que vao consumir a API.


1) Visao geral
A Security API usa o fluxo OAuth2 client_credentials:
A integracao recebe credenciais (client_id e client_secret).
A integracao solicita um access_token em /oauth/token.
A integracao chama endpoints protegidos com Authorization: Bearer <token>.
O backend valida token, status da aplicacao e escopos.


2) Pre-requisitos
Antes de consumir os endpoints, e necessario:
Ter uma Security API cadastrada no painel.
A Security API estar ativa.
O escopo necessario (ex.: report_read) estar permitido para essa credencial.
Possuir:
client_id
client_secret
URL base do ambiente (staging/producao)


3) Autenticacao: obter access token
Endpoint
POST /oauth/token
Headers
Content-Type: application/x-www-form-urlencoded
Body (form-urlencoded)
grant_type=client_credentials
client_id=<seu_client_id>
client_secret=<seu_client_secret>
scope=report_read
Exemplo cURL
curl -X POST "https://staging.lavenderia60minutos.com.br/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=SEU_CLIENT_ID" \
  -d "client_secret=SEU_CLIENT_SECRET" \
  -d "scope=report_read"
Exemplo de resposta (sucesso)
{
  "access_token": "eyJ...",
  "token_type": "Bearer",
  "expires_in": 7200,
  "scope": "report_read",
  "created_at": 1720610000
}


4) Consumo de endpoint protegido
Depois de obter o token, envie no header Authorization.
Header obrigatorio
Authorization: Bearer <access_token>
Exemplo cURL
curl -X GET "https://staging.lavenderia60minutos.com.br/api/v1/reports/seu_endpoint" \
  -H "Authorization: Bearer SEU_ACCESS_TOKEN" \
  -H "Content-Type: application/json"
Pode trocar "seu_endpoint" por "customers", "credit_purchases", "sales"


5) Regras de autorizacao
Para a requisicao ser aceita, todos os itens abaixo devem ser verdadeiros:
Token existe e nao expirou.
Token nao foi revogado.
Security API vinculada ao token esta ativa.
Token possui o escopo exigido pelo endpoint (ex.: report_read).
Se algum desses itens falhar, a API retorna erro (401 ou 403).


6) Tratamento de erros comuns
401 Unauthorized
Causas comuns:
Token ausente.
Token invalido.
Token expirado.
Security API inativa.
Acao recomendada:
Gerar novo token.
Validar se a credencial esta ativa.
403 Forbidden
Causa comum:
Token valido, mas sem escopo necessario (report_read).
Acao recomendada:
Revisar escopos configurados para a Security API.
429 Too Many Requests
Causa comum:
Excesso de chamadas no endpoint de token (/oauth/token).
Acao recomendada:
Implementar retry com backoff exponencial.
Reaproveitar token ate proximo da expiracao.


7) Boas praticas de integracao
Nao expor client_secret em frontend.
Armazenar credenciais em cofre de segredos.
Reutilizar token em memoria/cache ate perto da expiracao.
Logar apenas metadados (nao logar token/secret em texto puro).
Usar HTTPS sempre.
Implementar observabilidade para 401/403/429.


8) Fluxo recomendado (resumo operacional)
Solicite token (/oauth/token).
Guarde access_token com tempo de expiracao.
Envie Bearer token nas chamadas de relatorio.
Ao receber 401, gere novo token e tente novamente.
Ao receber 403, revise escopo da credencial.


9) Checklist para homologacao (staging)
Security API criada no painel.
Security API ativa.
Escopo report_read habilitado.
Token emitido com sucesso.
Endpoint de relatorio responde com Bearer token.
Erros 401/403/429 tratados pela integracao.


10) Observacao importante sobre escopos
O nome exato do escopo aceito depende da configuracao do backend da API no ambiente.
Se report_read nao estiver habilitado no servidor, use o escopo configurado oficialmente para os endpoints de relatorio e atualize esta documentacao.
Guia completo (Next.js) para consumir endpoints com escopo report_read
Este guia mostra um fluxo completo em Next.js (App Router) para:
Obter token OAuth2 via client_credentials
Reutilizar token com cache simples
Consumir endpoints protegidos com escopo report_read
Expor uma rota interna segura para o front-end


1) Pré-requisitos
Uma Security API criada no painel do Portal
client_id e client_secret da integração
Escopo habilitado: report_read
Base URL do ambiente (staging/prod), por exemplo:
https://staging.lavenderia60minutos.com.br
Observação: se o backend ainda estiver com outro escopo (ex.: integrations_read), troque report_read pelo escopo vigente.


2) Estrutura sugerida no Next.js
src/
  app/
    api/
      reports/
        route.ts
    reports/
      page.tsx
  lib/
    portal-auth.ts
    portal-reports.ts


3) Variáveis de ambiente (.env.local)
PORTAL_BASE_URL=https://staging.lavenderia60minutos.com.br
PORTAL_CLIENT_ID=seu_client_id
PORTAL_CLIENT_SECRET=seu_client_secret
PORTAL_SCOPE=report_read
Nunca exponha essas variáveis no client-side (não usar prefixo NEXT_PUBLIC_).


4) Cliente OAuth2 (token) - src/lib/portal-auth.ts
type OAuthTokenResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  created_at: number;
};

let cachedToken: { token: string; expiresAt: number } | null = null;

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

export async function getPortalAccessToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < cachedToken.expiresAt) {
    return cachedToken.token;
  }

  const baseUrl = getRequiredEnv("PORTAL_BASE_URL");
  const clientId = getRequiredEnv("PORTAL_CLIENT_ID");
  const clientSecret = getRequiredEnv("PORTAL_CLIENT_SECRET");
  const scope = process.env.PORTAL_SCOPE || "report_read";

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  });

  const response = await fetch(`${baseUrl}/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Falha ao obter token OAuth (${response.status}): ${errorText}`);
  }

  const tokenData = (await response.json()) as OAuthTokenResponse;

  // Renova um pouco antes de expirar para evitar corrida
  const refreshSafetyMs = 30_000;
  cachedToken = {
    token: tokenData.access_token,
    expiresAt: now + tokenData.expires_in * 1000 - refreshSafetyMs,
  };

  return cachedToken.token;
}


5) Cliente para endpoints de relatório - src/lib/portal-reports.ts
import { getPortalAccessToken } from "./portal-auth";

function getRequiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}`);
  return value;
}

export async function fetchPortalReport<T>(path: string): Promise<T> {
  const baseUrl = getRequiredEnv("PORTAL_BASE_URL");
  const accessToken = await getPortalAccessToken();

  const response = await fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Erro ao consultar relatório (${response.status}): ${errorText}`);
  }

  return (await response.json()) as T;
}


6) Rota interna no Next.js (server-side) - src/app/api/reports/route.ts
import { NextResponse } from "next/server";
import { fetchPortalReport } from "@/lib/portal-reports";

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const endpoint = searchParams.get("endpoint");

    if (!endpoint) {
      return NextResponse.json(
        { error: "Parâmetro 'endpoint' é obrigatório." },
        { status: 400 }
      );
    }

    // Exemplo de whitelist para evitar uso indevido da rota
    const allowedEndpoints = [
      "/api/v1/integrations/health",
      // Adicione aqui endpoints reais de relatório protegidos por report_read
      // "/api/v1/reports/..."
    ];

    if (!allowedEndpoints.includes(endpoint)) {
      return NextResponse.json(
        { error: "Endpoint não permitido." },
        { status: 403 }
      );
    }

    const data = await fetchPortalReport(endpoint);
    return NextResponse.json(data);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Erro inesperado";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}


7) Página consumindo a rota interna - src/app/reports/page.tsx
async function getReportData() {
  const response = await fetch(
    `${process.env.NEXT_PUBLIC_APP_URL ?? ""}/api/reports?endpoint=/api/v1/integrations/health`,
    { cache: "no-store" }
  );

  if (!response.ok) {
    throw new Error("Falha ao carregar relatório");
  }

  return response.json();
}

export default async function ReportsPage() {
  const data = await getReportData();

  return (
    <main>
      <h1>Relatórios</h1>
      <pre>{JSON.stringify(data, null, 2)}</pre>
    </main>
  );
}
Em produção, prefira montar URL absoluta por configuração de ambiente segura no servidor.


8) Teste rápido via cURL
8.1 Obter token
curl -X POST "https://staging.lavenderia60minutos.com.br/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=SEU_CLIENT_ID" \
  -d "client_secret=SEU_CLIENT_SECRET" \
  -d "scope=report_read"
8.2 Chamar endpoint protegido
curl -X GET "https://staging.lavenderia60minutos.com.br/api/v1/integrations/health" \
  -H "Authorization: Bearer SEU_ACCESS_TOKEN"


9) Erros comuns e diagnóstico
401 Unauthorized
Token inválido/expirado
Security API inativa
Authorization sem Bearer correto
403 Forbidden
Token sem escopo report_read
429 Too Many Requests
Limite no /oauth/token excedido


10) Checklist de segurança
Guardar client_secret apenas no servidor
Não logar token/secret em texto puro
Usar whitelist de endpoints permitidos
Implementar retry com backoff para falhas transitórias
Monitorar respostas 401/403/429


11) Resumo
No Next.js, o padrão recomendado é:
token OAuth gerado no server-side
cache simples de token para evitar chamadas desnecessárias
front-end consumindo rota interna (/api/reports)
backend do Portal protegendo endpoints por escopo (report_read)
