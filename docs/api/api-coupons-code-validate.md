API - POST /api/v1/coupons/:code/validate
Descrição
Valida se um cupom pode ser usado por um cliente em uma loja. O endpoint busca cliente, loja e cupom, executa check_availability! (regras de vigência, loja, cliente, estoque, etc.) e retorna os dados do cupom serializados. Não converte o cupom em compra de crédito (trecho convert_to_credit_purchase! está comentado).
Endpoint
POST /api/v1/coupons/{code}/validate
{code}: código do cupom (path parameter), ex.: ABC1234.
Autenticação
Token da API via header: X-Token: {seu_token_api}
Status Code: 401 Unauthorized se o token não for enviado ou for inválido.
Parâmetros
Parâmetro
Onde
Tipo
Obrigatório
Descrição
code
Path
String
Sim
Código do cupom a validar.
customer_id
Body
String (UUID)
Sim
ID do cliente.
store_code
Body
String
Sim
Código da loja.

(No Grape, customer_id e store_code costumam ir no JSON do body do POST.)
Formato de resposta
Sucesso (200 OK)
Objeto único em data (entidade WebApp::Entities::CouponEntity):
{
 "data": {
   "id": "uuid-do-cupom",
   "type": "coupons",
   "attributes": {
     "code": "ABC1234",
     "apply-method": "cash",
     "coupon-type": "bonus",
     "value": "20.00",
     "start_time": "09:00",
     "end_time": "18:00"
   }
 }
}
Nota: apply-method e coupon-type vêm dos enums do modelo (apply_method: absolute, percent, cash; coupon_type: bonus, discount). value é formatado com duas casas decimais. start_time e end_time aparecem como hora HH:MM (podem ser null se não houver no registro).
Campos comuns da resposta
Campo
Tipo
Descrição
data.id
String (UUID)
ID do cupom
data.type
String
Sempre coupons
data.attributes.code
String
Código do cupom
data.attributes.apply-method
String
Forma de aplicação (absolute, percent, cash)
data.attributes.coupon-type
String
Tipo (bonus, discount)
data.attributes.value
String
Valor com 2 decimais
data.attributes.start_time
String / null
Horário inicial permitido (HH:MM)
data.attributes.end_time
String / null
Horário final permitido (HH:MM)

Erros
Status
Quando
401 Unauthorized
X-Token ausente ou inválido.
404 Not Found
Cliente não encontrado (customer_id) ou cupom não encontrado (code). Corpo típico: { "error": { "message": "404 Not Found - ..." } } (mensagem do ActiveRecord).
400 Bad Request
Cupom indisponível para o cliente/loja (Coupon::CouponUnvailableError → mensagem "Coupon is invalid for this customer in this store"), ou qualquer outro StandardError. Corpo: { "error": { "message": "400 Bad Request - ..." } }.



Obs: Validado por esse endpoint, é só colocar nos endpoints de compras de crédito que o cliente for utilizar. 
