# Polymarket Gamma API — Documentação da Pesquisa

## Visão Geral

A **Gamma API** (`gamma-api.polymarket.com`) é a API pública do Polymarket.
- **Sem autenticação** — gratuita, sem API key
- **Formato:** JSON
- **Host:** `https://gamma-api.polymarket.com`
- **CDN:** Cloudflare (recomendado cache no cliente)

## Endpoints Identificados

### 1. `GET /markets` — Lista de Mercados

Retorna uma lista de mercados individuais (cada mercado é uma questão binária ou
múltipla com outcomes).

**Parâmetros de query:**

| Parâmetro | Tipo | Descrição |
|-----------|------|-----------|
| `limit` | int | Número de resultados (default 20, max 100) |
| `offset` | int | Paginação (default 0) |
| `active` | bool | `true` = apenas mercados ativos |
| `closed` | bool | `false` = exclui mercados fechados |
| `tag` | string | Filtrar por tag (funciona melhor em `/events`) |
| `order` | string | Campo para ordenar: `volume`, `liquidity`, `createdAt` |
| `ascending` | bool | `false` = decrescente (mais relevante primeiro) |
| `end_date_min` | ISO 8601 | Mercados que terminam após esta data |
| `slug` | string | Buscar por slug do mercado |

**Campos importantes do retorno:**

```json
{
  "id": "559651",
  "question": "Xi Jinping out before 2027?",
  "slug": "xi-jinping-out-before-2027",
  "outcomes": "[\"Yes\", \"No\"]",           // JSON string!
  "outcomePrices": "[\"0.0425\", \"0.9575\"]", // JSON string!
  "volume": "11697520.24",
  "liquidity": "255219.61",
  "active": true,
  "closed": false,
  "endDate": "2026-12-31T00:00:00Z",
  "startDate": "2025-07-03T20:37:00.228Z",
  "image": "https://...",
  "bestBid": 0.042,
  "bestAsk": 0.043,
  "lastTradePrice": 0.043,
  "volume24hr": 28703.74,
  "volume1wk": 104056.45,
  "volume1mo": 733365.17,
  "oneDayPriceChange": -0.001,
  "competitive": 0.83
}
```

**⚠️ Atenção:** `outcomes` e `outcomePrices` são **strings JSON** — precisam
ser parseadas com `JSON.parse()` no JavaScript.

### 2. `GET /events` — Lista de Eventos (Grupos de Mercados)

Um evento agrupa múltiplos mercados relacionados (ex: "Presidential Election
Winner 2028" tem 128 mercados individuais).

**Parâmetros:** iguais aos de `/markets`, mas `tag` funciona melhor aqui.

**Retorno:** array de eventos, cada um com `markets: [...]` aninhado:

```json
{
  "id": "31552",
  "title": "Presidential Election Winner 2028",
  "slug": "presidential-election-winner-2028",
  "volume": "676985731.69",
  "active": true,
  "closed": false,
  "markets": [
    {
      "id": "...",
      "question": "Will JD Vance win the 2028 US Presidential Election?",
      "outcomes": "[\"Yes\", \"No\"]",
      "outcomePrices": "[\"0.2095\", \"0.7905\"]",
      ...
    }
  ]
}
```

### 3. `GET /tags` — Lista de Tags Disponíveis

Retorna todas as tags/categorias disponíveis para filtro.
**Sem paginação** — retorna um array grande (centenas de tags).

```json
{
  "id": "100344",
  "label": "House Races",
  "slug": "house-races"
}
```

### 4. `GET /markets/{id}` — Mercado por ID

Retorna um único mercado pelo seu ID numérico.

### 5. `GET /events/{id}` — Evento por ID

Retorna um único evento pelo seu ID numérico.

## Estratégia para o App

### Endpoint primário (app)
```
GET /events?limit=50&active=true&closed=false&order=volume&ascending=false
```

Usar `/events` em vez de `/markets` porque:
1. Agrupa mercados relacionados em um card visual
2. O filtro `tag` funciona corretamente
3. Volume agregado do evento é mais representativo

### Parsing de outcomes no JS
```javascript
const outcomes = JSON.parse(market.outcomes);      // ["Yes", "No"]
const prices = JSON.parse(market.outcomePrices);    // ["0.0425", "0.9575"]
const outcomePairs = outcomes.map((name, i) => ({
  name,
  price: parseFloat(prices[i])
}));
```

### Tags principais (para filtro de categoria)
- `politics` — eleições, geopolítica
- `crypto` — Bitcoin, Ethereum, DeFi
- `sports` — futebol, basquete, MMA
- `economics` — Fed, inflation, GDP
- `entertainment` — Oscars, Emmys, Grammy
- `world` — eventos globais
- `ai` — modelos de IA, benchmarks

## Como Shares Funcionam no Polymarket

### Preço = Probabilidade
- Cada share custa entre **$0 e $1**
- O preço reflete a probabilidade implícita do mercado
- Ex: share "Yes" a $0.65 → mercado acha 65% de chance

### Payout na Resolução
- Se o outcome **vencer**: cada share paga **$1.00**
- Se o outcome **perder**: cada share vale **$0.00**
- Lucro = ($1.00 - preço de compra) × shares (se acertou)
- Prejuízo = preço de compra × shares (se errou)

### Compra
- **Custo total** = shares × preço
- Ex: comprar 100 shares de "Yes" a $0.65 → custo $65.00
- Se "Yes" ganhar: 100 × $1.00 = $100 → lucro $35.00

### Venda
- **Retorno** = shares × preço atual
- Ex: vender 100 shares a $0.80 → retorna $80.00
- P&L = (preço atual - preço médio) × shares

### P&L em Tempo Real
- P&L = (preço atual - preço médio) × shares
- P&L % = P&L / custo total × 100
- `marketValue` = shares × preço atual
- `costBasis` = shares × preço médio

## CORS

A Gamma API **suporta CORS** para requisições do navegador (header
`Access-Control-Allow-Origin: *` confirmado pelo Cloudflare). O app pode
fazer `fetch()` direto sem proxy.

## Rate Limiting

- Sem rate limit documentado, mas Cloudflare pode rate-limitar
- **Recomendação:** cache no cliente (localStorage) por 30-60s
- Refresh a cada 60s, não real-time

## Links de Referência

- Gamma API: `https://gamma-api.polymarket.com`
- CLOB API (ordens reais, não usada neste app de simulação): `https://clob.polymarket.com`
- Docs oficiais: `https://docs.polymarket.com`
- Site: `https://polymarket.com`
