// api.js — Buscar mercados do Polymarket (Gamma API)
// Fase 3: integração com Gamma API (/events), fallback p/ sample-markets.json,
//          cache em memória (60s), auto-refresh, categorização client-side.

// ===== Configuração =====
const GAMMA_API = 'https://gamma-api.polymarket.com';
const CACHE_MS = 60_000;      // 60 segundos — conforme quick-reference
const DEFAULT_LIMIT = 50;

// ===== Cache em memória =====
let _marketsCache = null;     // mercados já no schema do app
let _lastFetch = 0;
let _fetchingPromise = null;  // evita requests duplicados paralelos

// ===== Mapeamento de categorias (slug-de-tag → categoria do app) =====
// Polymarket usa tags granulares; nós mapeamos para categorias de UX.
// Ordem importa: a primeira categoria encontrada vence (politics > world).
const CATEGORY_PATTERNS = [
  {
    cat: 'politics',
    slugs: new Set([
      'politics', 'elections', 'geopolitics', 'us-presidential-election',
      'world-elections', 'global-elections', 'main-election', 'primaries',
      'united-states', 'president', 'society', 'us-politics'
    ])
  },
  {
    cat: 'crypto',
    slugs: new Set([
      'crypto', 'bitcoin', 'ethereum', 'blockchain', 'defi', 'token',
      'solana', 'binance', 'xrp', 'ripple', 'polygon', 'avalanche',
      'cardano', 'dogecoin', 'litecoin', 'litecoin-futures'
    ])
  },
  {
    cat: 'sports',
    slugs: new Set([
      'sports', 'basketball', 'football', 'soccer', 'mma', 'tennis',
      'nfl', 'nba', 'mlb', 'nhl', 'f1', 'formula1', 'golf', 'boxing',
      'cricket', 'baseball', 'hockey', 'ucl', 'uefa', 'premier-league',
      'la-liga', 'serie-a', 'nascar', 'esports', 'cs2', 'valorant'
    ])
  },
  {
    cat: 'economics',
    slugs: new Set([
      'economics', 'fed', 'inflation', 'recession', 'gdp', 'interest-rates',
      'employment', 'finance', 'cpi', 'tariffs', 'trade', 'stock-market',
      'sp500', 'nasdaq', 'earn-4'
    ])
  },
  {
    cat: 'entertainment',
    slugs: new Set([
      'entertainment', 'pop-culture', 'oscars', 'movies', 'awards',
      'grammys', 'emmys', 'music', 'tv-shows', 'celebrity', 'hollywood',
      'taylor-swift', 'video-games', 'gaming'
    ])
  },
  {
    cat: 'world',
    slugs: new Set([
      'world', 'international-affairs', 'middle-east', 'europe', 'asia',
      'africa', 'russia', 'china', 'ukraine', 'israel', 'iran', 'venezuela',
      'nato', 'diplomacy-ceasefire'
    ])
  },
  {
    cat: 'ai',
    slugs: new Set([
      'ai', 'openai', 'gemini', 'gpt', 'llm', 'anthropic', 'claude',
      'midjourney', 'stable-diffusion', 'huggingface', 'machine-learning',
      'ai-products'
    ])
  }
];

/**
 * Determina a categoria do app a partir das tags do evento.
 * @param {Array<{slug: string}>} eventTags — tags do evento pai
 * @returns {string} — categoria do app (politics|crypto|sports|economics|
 *                     entertainment|world|ai|general)
 */
function categorize(eventTags) {
  if (!Array.isArray(eventTags)) return 'general';
  const tagSlugs = eventTags.map(t => (t && t.slug) || '').filter(Boolean);
  for (const { cat, slugs } of CATEGORY_PATTERNS) {
    for (const s of tagSlugs) {
      if (slugs.has(s)) return cat;
    }
  }
  return 'general';
}

/**
 * Converte um mercado cru da API (dentro de event.markets) para o schema do app.
 * Trata a pegadinha crítica: outcomes e outcomePrices são JSON STRINGS.
 * @param {Object} m — mercado cru da Gamma API
 * @param {Object} event — evento pai (para categoria e título)
 * @returns {Object|null} — { id, question, slug, category, outcomes[], volume,
 *                            liquidity, endDate, active }
 */
function mapMarket(m, event) {
  try {
    if (!m || !m.id || !m.question) return null;
    // ⚠️ Pegadinha: outcomes e outcomePrices são JSON strings
    let outcomes = [];
    if (typeof m.outcomes === 'string') {
      const names = JSON.parse(m.outcomes);
      let prices = [];
      if (typeof m.outcomePrices === 'string') {
        prices = JSON.parse(m.outcomePrices);
      } else if (Array.isArray(m.outcomePrices)) {
        prices = m.outcomePrices;
      }
      outcomes = names.map((name, i) => ({
        name,
        price: parseFloat(prices[i]) || 0
      }));
    } else if (Array.isArray(m.outcomes)) {
      outcomes = m.outcomes.map((name, i) => ({
        name: String(name),
        price: parseFloat(m.outcomePrices?.[i]) || 0
      }));
    }
    if (outcomes.length < 1) return null;

    return {
      id: String(m.id),
      question: m.question,
      slug: m.slug || '',
      category: categorize(event?.tags) || event?.slug || 'general',
      outcomes,
      volume: parseFloat(m.volume) || 0,
      liquidity: parseFloat(m.liquidity) || 0,
      endDate: m.endDate || null,
      active: m.active && !m.closed
    };
  } catch (err) {
    console.warn('api.js: erro ao mapear mercado', m?.id, err);
    return null;
  }
}

/**
 * Faz fetch na Gamma API e retorna mercados no schema do app.
 * Em caso de falha, usa o cache em memória (mesmo stale).
 * Se não houver cache, cai no sample-markets.json local.
 *
 * @param {Object} opts — { limit=50, force=false, tag=null }
 * @returns {Promise<Array>} — mercados no schema do app
 */
export async function fetchMarkets(opts = {}) {
  const limit = opts.limit || DEFAULT_LIMIT;
  const force = !!opts.force;
  const tag = opts.tag || null;

  // Cache válido?
  if (!force && _marketsCache && (Date.now() - _lastFetch) < CACHE_MS) {
    return _marketsCache;
  }

  // Já há um fetch em andamento? Reutiliza para não duplicar.
  if (_fetchingPromise && (Date.now() - _lastFetch) < CACHE_MS * 3) {
    return _fetchingPromise;
  }

  _fetchingPromise = (async () => {
    try {
      let url = `${GAMMA_API}/events?limit=${limit}&active=true&closed=false&order=volume&ascending=false`;
      if (tag) url += `&tag=${encodeURIComponent(tag)}`;

      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const events = await res.json();

      const markets = [];
      for (const ev of (Array.isArray(events) ? events : [])) {
        const evMarkets = ev.markets || [];
        for (const m of evMarkets) {
          const mapped = mapMarket(m, ev);
          if (mapped && mapped.active) markets.push(mapped);
        }
      }

      if (markets.length === 0) {
        throw new Error('API retornou 0 mercados');
      }

      _marketsCache = markets;
      _lastFetch = Date.now();
      console.log(`api.js: ${markets.length} mercados carregados da Gamma API`);
      return markets;
    } catch (err) {
      console.warn('api.js: Gamma API falhou, usando fallback:', err.message);

      // Cache stale em memória é melhor que nada
      if (_marketsCache && _marketsCache.length > 0) {
        console.log('api.js: usando cache stale (', _marketsCache.length, 'mercados)');
        return _marketsCache;
      }

      // Sem cache — usa sample-markets.json offline
      try {
        const localRes = await fetch('data/sample-markets.json');
        if (!localRes.ok) throw new Error('sample não carregou');
        const sample = await localRes.json();
        _marketsCache = Array.isArray(sample) ? sample : [];
        _lastFetch = Date.now();
        console.log('api.js: fallback para sample-markets.json (', _marketsCache.length, 'mercados)');
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
 * Atualiza apenas os preços dos mercados que já estão em cache.
 * Mais leve que fetchMarkets — mantém o mesmo array referência para
 * que os cards de mercado atualizem sem re-renderizar tudo.
 *
 * @returns {Promise<boolean>} — true se atualizou com sucesso
 */
export async function refreshPrices() {
  try {
    const fresh = await fetchMarkets({ force: true });
    // Atualiza prices dos mercados em cache, preservando referências
    if (_marketsCache && fresh) {
      const priceMap = new Map(fresh.map(m => [m.id, m]));
      for (const m of _marketsCache) {
        const upd = priceMap.get(m.id);
        if (upd && upd.outcomes) {
          m.outcomes = upd.outcomes;
          m.volume = upd.volume;
          m.liquidity = upd.liquidity;
        }
      }
      return true;
    }
    return false;
  } catch (err) {
    console.warn('api.js: refreshPrices falhou:', err);
    return false;
  }
}

/**
 * Limpa o cache em memória (usado no reset da carteira).
 */
export function clearCache() {
  _marketsCache = null;
  _lastFetch = 0;
  _fetchingPromise = null;
}

/**
 * Retorna a lista de categorias suportadas pelo app.
 * @returns {string[]}
 */
export function getCategories() {
  return ['politics', 'crypto', 'sports', 'economics', 'entertainment', 'world', 'ai', 'general'];
}

// Exporta helpers de teste (não expostos ao escopo global em produção)
export const _internal = { categorize, mapMarket, CATEGORY_PATTERNS };
