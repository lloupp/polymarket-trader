// api.js — Buscar mercados do Polymarket (Gamma API)
// Fase 3: integração com Gamma API (/events), fallback p/ sample-markets.json,
//          cache em memória (60s), auto-refresh, categorização client-side.

// ===== Configuração =====
const GAMMA_API = 'https://gamma-api.polymarket.com';
const CACHE_MS = 60_000;
const DEFAULT_LIMIT = 50;

// ===== Cache em memória =====
let _marketsCache = null;
let _lastFetch = 0;
let _fetchingPromise = null;

const CATEGORY_PATTERNS = [
  { cat: 'politics', slugs: new Set(['politics','elections','geopolitics','us-presidential-election','world-elections','global-elections','main-election','primaries','united-states','president','society','us-politics']) },
  { cat: 'crypto', slugs: new Set(['crypto','bitcoin','ethereum','blockchain','defi','token','solana','binance','xrp','ripple','polygon','avalanche','cardano','dogecoin','litecoin','litecoin-futures']) },
  { cat: 'sports', slugs: new Set(['sports','basketball','football','soccer','mma','tennis','nfl','nba','mlb','nhl','f1','formula1','golf','boxing','cricket','baseball','hockey','ucl','uefa','premier-league','la-liga','serie-a','nascar','esports','cs2','valorant']) },
  { cat: 'economics', slugs: new Set(['economics','fed','inflation','recession','gdp','interest-rates','employment','finance','cpi','tariffs','trade','stock-market','sp500','nasdaq','earn-4']) },
  { cat: 'entertainment', slugs: new Set(['entertainment','pop-culture','oscars','movies','awards','grammys','emmys','music','tv-shows','celebrity','hollywood','taylor-swift','video-games','gaming']) },
  { cat: 'world', slugs: new Set(['world','international-affairs','middle-east','europe','asia','africa','russia','china','ukraine','israel','iran','venezuela','nato','diplomacy-ceasefire']) },
  { cat: 'ai', slugs: new Set(['ai','openai','gemini','gpt','llm','anthropic','claude','midjourney','stable-diffusion','huggingface','machine-learning','ai-products']) }
];

function categorize(eventTags) {
  if (!Array.isArray(eventTags)) return 'general';
  const tagSlugs = eventTags.map(t => (t && t.slug) || '').filter(Boolean);
  for (const { cat, slugs } of CATEGORY_PATTERNS) {
    for (const s of tagSlugs) if (slugs.has(s)) return cat;
  }
  return 'general';
}

function parsePrice(value) {
  const price = Number.parseFloat(value);
  if (!Number.isFinite(price)) return 0;
  return Math.min(1, Math.max(0, price));
}

function mapMarket(m, event) {
  try {
    if (!m || m.id == null || !m.question) return null;
    let names = [];
    if (typeof m.outcomes === 'string') names = JSON.parse(m.outcomes);
    else if (Array.isArray(m.outcomes)) names = m.outcomes;
    if (!Array.isArray(names) || names.length < 1) return null;

    let prices = [];
    if (typeof m.outcomePrices === 'string') prices = JSON.parse(m.outcomePrices);
    else if (Array.isArray(m.outcomePrices)) prices = m.outcomePrices;

    const outcomes = names.map((name, i) => ({ name: String(name), price: parsePrice(prices[i]) }));
    return {
      id: String(m.id),
      question: String(m.question),
      slug: m.slug || '',
      category: categorize(event?.tags),
      outcomes,
      volume: Math.max(0, Number.parseFloat(m.volume) || 0),
      liquidity: Math.max(0, Number.parseFloat(m.liquidity) || 0),
      endDate: m.endDate || null,
      active: Boolean(m.active) && !m.closed
    };
  } catch (err) {
    console.warn('api.js: erro ao mapear mercado', m?.id, err);
    return null;
  }
}

export async function fetchMarkets(opts = {}) {
  const requestedLimit = Number(opts.limit);
  const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
    ? Math.min(500, Math.floor(requestedLimit))
    : DEFAULT_LIMIT;
  const force = Boolean(opts.force);
  const tag = opts.tag || null;

  if (!force && _marketsCache && (Date.now() - _lastFetch) < CACHE_MS) return _marketsCache;
  if (_fetchingPromise) return _fetchingPromise;

  _fetchingPromise = (async () => {
    try {
      let url = `${GAMMA_API}/events?limit=${limit}&active=true&closed=false&order=volume&ascending=false`;
      if (tag) url += `&tag=${encodeURIComponent(tag)}`;

      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const events = await res.json();

      const markets = [];
      for (const ev of (Array.isArray(events) ? events : [])) {
        for (const m of (Array.isArray(ev.markets) ? ev.markets : [])) {
          const mapped = mapMarket(m, ev);
          if (mapped?.active) markets.push(mapped);
        }
      }
      if (markets.length === 0) throw new Error('API retornou 0 mercados');

      _marketsCache = markets;
      _lastFetch = Date.now();
      return markets;
    } catch (err) {
      console.warn('api.js: Gamma API falhou, usando fallback:', err.message);
      if (_marketsCache?.length) return _marketsCache;

      try {
        const localRes = await fetch('data/sample-markets.json');
        if (!localRes.ok) throw new Error('sample não carregou');
        const sample = await localRes.json();
        _marketsCache = Array.isArray(sample) ? sample : [];
        _lastFetch = Date.now();
        return _marketsCache;
      } catch (localErr) {
        console.error('api.js: fallback local também falhou:', localErr);
        return [];
      }
    } finally {
      _fetchingPromise = null;
    }
  })();

  return _fetchingPromise;
}

/**
 * Atualiza preços preservando a identidade do array/objetos já entregues à UI.
 * Isso é essencial porque app.js e o bot mantêm referências a state.markets.
 */
export async function refreshPrices() {
  const previous = _marketsCache;
  try {
    const fresh = await fetchMarkets({ force: true });
    if (!Array.isArray(fresh) || fresh.length === 0) return false;

    if (!Array.isArray(previous) || previous.length === 0 || previous === fresh) {
      _marketsCache = fresh;
      return true;
    }

    const freshMap = new Map(fresh.map(m => [String(m.id), m]));
    for (const market of previous) {
      const updated = freshMap.get(String(market.id));
      if (!updated) continue;
      market.outcomes = updated.outcomes;
      market.volume = updated.volume;
      market.liquidity = updated.liquidity;
      market.endDate = updated.endDate;
      market.active = updated.active;
      market.category = updated.category;
    }

    // Preserva a referência original usada por state.markets.
    _marketsCache = previous;
    _lastFetch = Date.now();
    return true;
  } catch (err) {
    console.warn('api.js: refreshPrices falhou:', err);
    if (previous) _marketsCache = previous;
    return false;
  }
}

export function clearCache() {
  _marketsCache = null;
  _lastFetch = 0;
  _fetchingPromise = null;
}

export function getCategories() {
  return ['politics', 'crypto', 'sports', 'economics', 'entertainment', 'world', 'ai', 'general'];
}

export const _internal = { categorize, mapMarket, CATEGORY_PATTERNS, parsePrice };
