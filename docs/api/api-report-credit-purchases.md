API - GET /api/v1/report_credit_purchases
Descrição
Retorna um relatório de compras de crédito filtrado por loja e período de datas. Os resultados são paginados e incluem informações sobre pagamentos, produtos e notas fiscais associadas.
Endpoint
GET /api/v1/report_credit_purchases
Autenticação
Requer autenticação via header:
X-Token: {seu_token_api}
Status Code: 401 Unauthorized se o token não for fornecido ou for inválido.
Parâmetros de Query
Parâmetro
Tipo
Obrigatório
Descrição
store_code
String 
Sim
Codigo da loja para filtrar as compras de crédito
start_date
String
Não
Data inicial no formato DD/MM/YYYY. Se fornecido, filtra a partir do início deste dia. Se não houver end_date, filtra até o momento atual
end_date
String
Não
Data final no formato DD/MM/YYYY. Se fornecido, filtra até o final deste dia. Se não houver start_date, filtra desde 5 anos atrás até esta data
page
Integer
Não
Número da página para paginação (padrão: 1)
per_page
Integer
Não
Quantidade de itens por página (padrão: 20)

Comportamento dos Filtros de Data
Se apenas start_date for fornecido: filtra do início do dia de start_date até o momento atual
Se apenas end_date for fornecido: filtra desde 5 anos atrás até o final do dia de end_date
Se ambos forem fornecidos: filtra do início do dia de start_date até o final do dia de end_date
Se nenhum for fornecido: filtra apenas o dia atual (início até fim do dia)
Formato de Resposta
Sucesso (200 OK)
A resposta segue o padrão JSON:API com a estrutura:
{
  "data": [
    {
      "id": "uuid-da-compra-de-credito",
      "type": "report-credit-purchase",
      "attributes": {
        "code": "CP001",
        "store-id": "uuid-da-loja",
        "store-code": "LOJA01",
        "customer-id": "uuid-do-cliente",
        "customer-full-name": "João Silva",
        "created-at": "2024-01-15T10:30:00Z",
        "payment-method": "Cartão de Crédito",
        "product-id": "uuid-do-produto",
        "product-name": "Créditos Totem",
        "nsu": "123456",
        "total-value": 50.00,
        "nfse-id": "uuid-da-nfse",
        "nfse-status": "concluido",
        "nfse-id-ref": "NFSE123456",
        "origin": "physical_store"
      }
    }
  ],
  "meta": {
    "total": 150,
    "total_value": 7500.00,
    "page": 1,
    "per_page": 20,
    "total_pages": 8
  }
}
Campos do Response
Campo
Tipo
Descrição


id
UUID
Identificador único da compra de crédito


type
String
Sempre retorna "report-credit-purchase"


attributes.code
String
Código único da compra de crédito


attributes.store-id
UUID
ID da loja onde a compra foi realizada


attributes.store-code
String
Código da loja


attributes.customer-id
UUID
ID do cliente


attributes.customer-full-name
String
Nome completo do cliente


attributes.created-at
String
Data e hora de criação da compra (ISO 8601)


attributes.payment-method
String
Método de pagamento legível (ex: "Cartão de Crédito", "Dinheiro", "PIX", etc.)


attributes.product-id
UUID \
null
ID do produto (null para créditos de totem)
attributes.product-name
String
Nome do produto ou "Créditos Totem" se não houver produto


attributes.nsu
String \
null
Número Sequencial Único do pagamento
attributes.total-value
Decimal
Valor total da compra


attributes.nfse-id
UUID \
null
ID da nota fiscal de serviço eletrônica
attributes.nfse-status
String \
null
Status da NFS-e: "concluido", "processando", "rejeitado", etc.
attributes.nfse-id-ref
String \
null
Referência externa da NFS-e
attributes.origin
String
Origem da compra: "physical_store", "ecommerce", "appstore"



Campos do Meta (Paginação e Totais)
Campo
Tipo
Descrição
meta.total
Integer
Total de registros encontrados no período
meta.total_value
Decimal
Soma total dos valores das compras no período
meta.page
Integer
Página atual
meta.per_page
Integer
Itens por página
meta.total_pages
Integer
Total de páginas disponíveis



