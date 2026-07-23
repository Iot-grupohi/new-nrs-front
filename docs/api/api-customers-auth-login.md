API - POST /api/v1/customers/auth/login
Descrição
Autentica um cliente no sistema usando email ou CPF/CNPJ e senha. Retorna um token JWT válido por 30 minutos que pode ser usado para autenticar requisições subsequentes do cliente.
Endpoint
POST /api/v1/customers/auth/login
Autenticação
Requer autenticação via header:
X-Token: {seu_token_api}
Status Code: 401 Unauthorized se o token não for fornecido ou for inválido.
Parâmetros do Body
Parâmetro
Tipo
Obrigatório
Descrição
email
String
Condicional*
Email do cliente
tax_id_number
String
Condicional*
CPF ou CNPJ do cliente
password
String
Sim
Senha do cliente

\* É necessário fornecer exatamente um dos parâmetros: email ou tax_id_number (não ambos).
Formato de Resposta
Sucesso (200 OK)
A resposta retorna um token JWT e informações básicas do cliente:
{
  "data": {
    "id": "uuid-do-cliente",
    "email": "joao.silva@example.com",
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "time": "2024-01-15T11:00:00Z"
  }
}
Campos do Response
Campo
Tipo
Descrição
data.id
UUID
Identificador único do cliente
data.email
String
Email do cliente autenticado
data.token
String
Token JWT para autenticação em requisições subsequentes
data.time
String
Data/hora de expiração do token (ISO 8601) - 30 minutos após a criação

Uso do Token
O token retornado deve ser usado no header Authorization em requisições subsequentes:
Authorization: Bearer {token}
O token é válido por 30 minutos a partir do momento da criação.

