API - GET /api/v1/products

Descrição

Retorna a lista de produtos da aplicação Web App. Por padrão, o endpoint busca produtos do escopo totem.

Quando scope=new_totem, a resposta usa uma entidade específica que pode aplicar valor promocional por loja (store_code).

Endpoint

GET /api/v1/products

Autenticação
Requer autenticação por token da API via header: X-Token: {seu_token_api}

Status Code:

401 Unauthorized se o token não for fornecido ou for inválido.
Parâmetros de Query


Parâmetro
Tipo
Obrigatório
Descrição
scope
String
Não
Escopo do produto. Se não informado, usa totem. Ex.: totem, virtual_store, new_totem.


store_code
String
Não
Código da loja para validação de suspensão e cálculo promocional no caso de scope=new_totem.





Formato de Resposta

Sucesso (200 OK)
A resposta retorna um array em data com os produtos serializados.

Exemplo (scope padrão ou diferente de new_totem):

{
  "data": [
    {
      "id": 1,
      "type": "products",
      "attributes": {
        "name": "Lavagem 12kg",
        "value": "18.90",
        "product-type": "service",
        "billing-method-name": "avulso",
        "coupon_value": 5.0
      }
    }
  ]
}

Exemplo (scope=new_totem):

{
  "data": [
    {
      "id": 1,
      "type": "products",
      "attributes": {
        "name": "Lavagem 12kg",
        "value": "15.90",
        "product-type": "service"
      }
    }
  ]
}

Nota:

Em scope=new_totem, o campo value pode vir de promoção da loja (promotional_value_for_store) quando store_code é informado.
A estrutura exata pode variar conforme entidade e dados existentes no banco.

Campos Comuns da Resposta:

Campo	Tipo	Descrição
data[].id	Integer	ID do produto
data[].type	String	Tipo lógico retornado (products)
data[].attributes.name	String	Nome do produto
data[].attributes.value	String (decimal formatado)	Valor do produto com 2 casas decimais
data[].attributes.product-type	String	Tipo do produto (ex.: product, service)
Campos adicionais quando não for new_totem:

data[].attributes.billing-method-name
data[].attributes.coupon_value (quando houver cupom)

Erros Possíveis:

401 Unauthorized
Quando X-Token é inválido/ausente.

404 Not Found
Quando store_code é enviado e a loja não existe:

