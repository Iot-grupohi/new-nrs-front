API - GET /api/v1/customers/bubble/customer
Descrição
Retorna os dados completos do cliente autenticado. Endpoint usado pelo Bubble.io para obter informações do cliente logado no sistema.
Endpoint
GET /api/v1/customers/bubble/customer
Autenticação
Requer dupla autenticação:
Token da API via header:
   X-Token: {seu_token_api}
Token JWT do Cliente via header:
   Authorization: Bearer {jwt_token_do_cliente}
Status Code: 401 Unauthorized se algum dos tokens não for fornecido ou for inválido.
Parâmetros
Este endpoint não requer parâmetros. O cliente é identificado automaticamente através do token JWT fornecido no header Authorization.
Formato de Resposta
Sucesso (200 OK)
A resposta retorna os dados completos do cliente no formato JSON:API:
{
  "data": {
    "id": "uuid-do-cliente",
    "type": "customers",
    "attributes": {
      "first-name": "João",
      "last-name": "Silva",
      "email": "joao.silva@example.com",
      "phone": "11987654321",
      "country-code": "BR",
      "tax-id-number": "123.456.789-00",
      "birthdate": "1990-01-15",
      "gender": 1,
      "zipcode": "01234-567",
      "registration-store-code": "LOJA01",
      "foreigner": false,
      "tax-id-number-validated": true,
      "tax-id-number-queried": true,
      "password-digest": "$2a$12$...",
      "status": 0,
      "credits": "150.50",
      "credit-purchase-validate": true,
      "birthdate-coupon-last-used-at": "2024-01-15T10:30:00Z",
      "virtual-store": false,
      "created-at": "2023-01-15T10:30:00Z",
      "updated-at": "2024-01-15T10:30:00Z",
      "gclid": null
    }
  }
}
Campos do Response
Campo
Tipo
Descrição


data.id
UUID
Identificador único do cliente


data.type
String
Sempre retorna "customers"


attributes.first-name
String
Primeiro nome do cliente


attributes.last-name
String
Sobrenome do cliente


attributes.email
String
Email do cliente


attributes.phone
String \
null
Telefone do cliente
attributes.country-code
String \
null
Código do país
attributes.tax-id-number
String
CPF ou CNPJ do cliente


attributes.birthdate
String \
null
Data de nascimento (formato ISO 8601)
attributes.gender
Integer
Gênero: 0 (outro), 1 (feminino), 2 (masculino)


attributes.zipcode
String \
null
CEP do cliente
attributes.registration-store-code
String \
null
Código da loja onde o cliente se registrou
attributes.foreigner
Boolean
Indica se o cliente é estrangeiro


attributes.tax-id-number-validated
Boolean
Indica se o CPF/CNPJ foi validado


attributes.tax-id-number-queried
Boolean
Indica se o CPF/CNPJ foi consultado


attributes.password-digest
String
Hash da senha (nunca retorna a senha em texto claro)


attributes.status
Integer
Status do cliente: 0 (ativo), 1 (suspenso), etc.


attributes.credits
String
Saldo de créditos do cliente (formato decimal com 2 casas)


attributes.credit-purchase-validate
Boolean
Indica se a compra de crédito precisa ser validada


attributes.birthdate-coupon-last-used-at
String \
null
Data/hora do último uso do cupom de aniversário (ISO 8601)
attributes.virtual-store
Boolean
Indica se o cliente tem acesso à loja virtual


attributes.created-at
String
Data/hora de criação do cadastro (ISO 8601)


attributes.updated-at
String
Data/hora da última atualização (ISO 8601)


attributes.gclid
String \
null
Google Click ID (para rastreamento de campanhas)

Nota: O campo credits_account não é incluído nesta resposta (parâmetro include_credits_account: false).


