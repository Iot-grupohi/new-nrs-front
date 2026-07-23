API - POST /api/v1/payments/pix_to_hipag
Descrição
Cria um pagamento PIX via HiPag para compra de créditos no totem. O endpoint valida a conta HiBank da loja, envia a requisição de pagamento para o HiPag e cria automaticamente uma compra de crédito associada ao cliente autenticado.
Endpoint
POST /api/v1/payments/pix_to_hipag
Autenticação
Requer dupla autenticação:
Token da API via header:
   X-Token: {seu_token_api}
Token JWT do Cliente via header:
   Authorization: Bearer {jwt_token_do_cliente}
Status Code: 401 Unauthorized se algum dos tokens não for fornecido ou for inválido.
Parâmetros do Body
Parâmetro
Tipo
Obrigatório
Descrição
store_code
String
Sim
Código da loja (ex: "LOJA01")
amount
Float
Sim
Valor total do pagamento
product_id
String (UUID)
Não
ID do produto (para compras de produtos específicos)
coupon_code
String
Não
Código do cupom de desconto

Formato de Resposta
Sucesso (200 OK)
A resposta retorna o objeto JSON da API HiPag:
{
  "data": {
    "id": "uuid-do-pagamento",
    "status": "pending",
    "amount": 50.00,
    "pix_qr_code": "00020126360014BR.GOV.BCB.PIX...",
    "pix_qr_code_base64": "iVBORw0KGgoAAAANSUhEUgAA...",
    "expires_at": "2024-01-15T11:30:00Z",
    "created_at": "2024-01-15T10:30:00Z"
  }
}
Nota: A estrutura exata da resposta depende da API HiPag e pode variar. O campo data.id é usado como referência para criar a compra de crédito.
Campos Comuns da Resposta HiPag
Campo
Tipo
Descrição
data.id
String
ID único do pagamento no HiPag (usado como id_ref na compra de crédito)
data.status
String
Status do pagamento: "pending", "paid", "expired", etc.
data.amount
Float
Valor do pagamento
data.pix_qr_code
String
Código PIX em formato texto (para gerar QR Code)
data.pix_qr_code_base64
String
QR Code PIX em formato base64 (imagem)
data.expires_at
String
Data/hora de expiração do QR Code PIX (ISO 8601)
data.created_at
String
Data/hora de criação do pagamento (ISO 8601)

Comportamento Interno
Após receber a resposta do HiPag, o sistema:
Verifica se já existe uma compra de crédito com o mesmo id_ref (evita duplicatas)
Cria uma nova CreditPurchase com:
customer_id: ID do cliente autenticado
status: 1 (not_paid)
send_invoice: false
store_id: ID da loja encontrada
payments_total_value: Valor do pagamento
id_ref: ID retornado pelo HiPag
origin: "physical_store"
purchase_ref: "MATERA_PIX"
product_id: ID do produto (se fornecido)

