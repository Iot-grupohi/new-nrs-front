API - GET /api/v1/stores
Descrição
Retorna a lista de lojas cadastradas no sistema. Permite filtrar por status e exclui automaticamente lojas de desenvolvimento em ambiente de produção.
Endpoint
GET /api/v1/stores
Autenticação
Requer autenticação via header:
X-Token: {seu_token_api}
Status Code: 401 Unauthorized se o token não for fornecido ou for inválido.
Parâmetros de Query
Parâmetro
Tipo
Obrigatório
Descrição
status
String
Não
Filtra lojas por status. Valores aceitos: active, suspended, implantation, point, rental, paused, cancellation

Valores possíveis para status:
active - Loja ativa
suspended - Loja suspensa
implantation - Em implantação
point - Ponto
rental - Locação
paused - Pausada
cancellation - Distrato
Comportamento
As lojas são ordenadas por código (code) em ordem crescente.
Formato de Resposta
Sucesso (200 OK)
A resposta segue o padrão JSON:API com a estrutura:
{
  "data": [
    {
      "id": "uuid-da-loja",
      "type": "stores",
      "attributes": {
        "name": "Nome da Loja",
        "code": "LOJA01",
        "tax_id_number": "12.345.678/0001-90",
        "city": "São Paulo",
        "state": "SP",
        "opening-time": "08:00:00",
        "closing-time": "22:00:00",
        "reboot-time": "03:00:00",
        "zipcode": "01234-567",
        "power-air": "low",
        "accept-cash": true,
        "accept-card": true,
        "machine-type": "single",
        "dosage-model": "dry_contact",
        "execute-machine-method": "totem",
        "pinpad-serial": "ABC123",
        "tef-code": "001",
        "water-level": 1,
        "soap-level": 1,
        "softener-level": 1,
        "status": "active",
        "need-to-update": false,
        "pagarme-id-ref": "ref_123",
        "updated-at": "2024-01-15T10:30:00Z",
        "authorized-users": ["123.456.789-00", "987.654.321-00"],
        "sport-softener": true,
        "floral-softener": true,
        "fractional-time": 30,
        "double-dosage": false,
        "hibank-status": "active"
      }
    }
  ]
}
Campos do Response
Campo
Tipo
Descrição


id
UUID
Identificador único da loja


type
String
Sempre retorna "stores"


attributes.name
String
Nome da loja


attributes.code
String
Código único da loja


attributes.tax_id_number
String
CNPJ da loja


attributes.city
String \
null
Nome da cidade
attributes.state
String \
null
Sigla do estado (ex: "SP")
attributes.opening-time
String \
null
Horário de abertura (formato ISO time)
attributes.closing-time
String \
null
Horário de fechamento (formato ISO time)
attributes.reboot-time
String \
null
Horário de reinicialização formatado
attributes.zipcode
String
CEP


attributes.power-air
String \
null
Nível do ar-condicionado: "low", "mid", "high"
attributes.accept-cash
Boolean
Aceita pagamento em dinheiro


attributes.accept-card
Boolean
Aceita pagamento com cartão


attributes.machine-type
String
Tipo de máquina: "single" ou "multiple"


attributes.dosage-model
String
Modelo de dosagem


attributes.execute-machine-method
String
Método de execução: "totem" ou "blynk"


attributes.pinpad-serial
String \
null
Serial do pinpad
attributes.tef-code
String \
null
Código TEF
attributes.water-level
Integer
Nível de água (default: 1)


attributes.soap-level
Integer
Nível de sabão (default: 1)


attributes.softener-level
Integer
Nível de amaciante (default: 1)


attributes.status
String
Status da loja (ver valores acima)


attributes.need-to-update
Boolean
Indica se a loja precisa de atualização


attributes.pagarme-id-ref
String \
null
Referência do Pagarme
attributes.updated-at
String
Data/hora da última atualização (ISO 8601)


attributes.authorized-users
Array[String]
Lista de CPFs de usuários autorizados


attributes.sport-softener
Boolean
Usa amaciante esportivo


attributes.floral-softener
Boolean
Usa amaciante floral


attributes.fractional-time
Integer \
null
Tempo fracionado
attributes.double-dosage
Boolean
Dosagem dupla


attributes.hibank-status
String \
null
Status do HiBank (apenas se houver HiBank associado)





