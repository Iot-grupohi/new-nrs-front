API - POST /api/v1/sales/totem_sales
Descrição
Cria uma venda a partir do totem físico. O endpoint valida o saldo do cliente, verifica a disponibilidade das máquinas, cria a venda com itens e pagamentos, debita o saldo do cliente e agenda a ativação das máquinas após o tempo de espera configurado.
Endpoint
POST /api/v1/sales/totem_sales
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
released_machine
Boolean
Não
Indica se a máquina deve ser liberada imediatamente (afeta o modo de ativação)
sale_items
Array
Sim
Array de itens da venda (ver estrutura abaixo)
payments
Array
Sim
Array de pagamentos (ver estrutura abaixo)

Estrutura de sale_items (Array)
Cada item do array deve conter:
Campo
Tipo
Obrigatório
Descrição
value
String
Sim
Valor unitário do item
quantity
String
Sim
Quantidade do item
product_id
String (UUID)
Sim
ID do produto
machines
Array
Sim
Array de máquinas a serem utilizadas (ver estrutura abaixo)
soap_type
String
Não
Tipo de sabão: "floral", "sport" ou "smelless"

Estrutura de machines (Array dentro de sale_items)
Cada máquina no array deve conter:
Campo
Tipo
Obrigatório
Descrição
code
String
Sim
Código/nome da máquina (ex: "M01", "L01")

Estrutura de payments (Array)
Cada pagamento no array deve conter:
Campo
Tipo
Obrigatório
Descrição
value
String
Sim
Valor do pagamento
payment_method
String
Sim
Método de pagamento (ex: "credits", "pix", "credit_card")

Cálculo do Valor Total
O valor total da compra é calculado como:
total = Σ (value × quantity × número_de_máquinas)
Para cada item, o valor é multiplicado pela quantidade e pelo número de máquinas associadas.
Formato de Resposta
Sucesso (200 OK)
A resposta retorna a venda criada no formato JSON:API:
{
  "data": {
    "id": "uuid-da-venda",
    "type": "sale",
    "attributes": {
      "store-code": "LOJA01",
      "store-id": "uuid-da-loja",
      "customer-id": "uuid-do-cliente",
      "total-value": "50.00",
      "created-at": "2024-01-15T10:30:00Z",
      "sale-items": [
        {
          "id": "uuid-do-item",
          "value": "25.00",
          "quantity": 2,
          "product_id": "uuid-do-produto",
          "machines": [...]
        }
      ]
    }
  }
}
Campos do Response
Campo
Tipo
Descrição
data.id
UUID
Identificador único da venda
data.type
String
Sempre retorna "sale"
attributes.store-code
String
Código da loja
attributes.store-id
UUID
ID da loja
attributes.customer-id
UUID
ID do cliente que realizou a compra
attributes.total-value
String
Valor total da venda (formato decimal com 2 casas)
attributes.created-at
String
Data/hora de criação da venda (ISO 8601)
attributes.sale-items
Array
Array de itens da venda com detalhes completos

Comportamento Interno
O endpoint realiza as seguintes operações:
Validação de Saldo: Verifica se o cliente tem saldo suficiente para cobrir o valor total da compra.
Validação de Máquinas: Verifica se todas as máquinas solicitadas estão disponíveis (status: 'available').
Reserva de Máquinas: Marca as máquinas como ocupadas (status: 'busy') para evitar conflitos.
Criação da Venda: Cria um registro de Sale com status 5 (concluída).
Criação dos Itens: Cria registros de SaleItem associados à venda e às máquinas.
Criação dos Pagamentos: Cria registros de Payment e AccountEntry para debitar o saldo do cliente.
Ativação das Máquinas: Agenda a ativação das máquinas após o tempo de espera configurado:
Secagem 45: 3 pulsos
Secagem 30: 2 pulsos
Outros produtos: 1 pulso
Rollback em Erro: Se ocorrer qualquer erro, todas as máquinas reservadas são liberadas automaticamente.


