// backtest-data.js — coleta e alinha séries históricas oficiais da Polymarket CLOB

const CLOB_API = 'https://clob.polymarket.com';
const GAMMA_API = 'https://gamma-api.polymarket.com';
const UNIVERSE_PAGE_SIZE = 100;
const MAX_UNIVERSE_PAGES = 5;
const DEFAULT_MAX_FORWARD_FILL_BUCKETS = 3;

function clampInt(value, min, max, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function cleanHistory(payload) {
  const rows = Array.isArray(payload?.history) ? payload.history : [];
  const byTime = new Map();
  for (const row of rows) {
    const seconds = Number(row?.t);
    const price = Number(row?.p);
    if (!Number.isFinite(seconds) || !Number.isFinite(price)) continue;
    byTime.set(Math.round(seconds * 1000), Math.max(0, Math.min(1, price)));
  }
  return [...byTime.entries()]
    .map(([timestamp, price]) => ({ timestamp, price }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

export async function fetchTokenHistory(tokenId, { startTs, endTs, fidelityMinutes = 60, fetchImpl = fetch, signal } = {}) {
  if (!tokenId) throw new Error('Token CLOB ausente.');
  const start = Math.floor(Number(startTs));
  const end = Math.floor(Number(endTs));
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end) throw new Error('Janela histórica inválida.');
  const fidelity = clampInt(fidelityMinutes, 1, 1440, 60);
  const params = new URLSearchParams({
    market: String(tokenId),
    startTs: String(start),
    endTs: String(end),
    fidelity: String(fidelity),
  });
  const response = await fetchImpl(`${CLOB_API}/prices-history?${params}`, { signal });
  if (!response.ok) throw new Error(`CLOB histórico HTTP ${response.status}`);
  return cleanHistory(await response.json());
}

function parseArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function resolveMarketTokens(market, { fetchImpl = fetch, signal } = {}) {
  if (Array.isArray(market?.outcomes) && market.outcomes.length >= 2 && market.outcomes.every(outcome => outcome?.tokenId)) {
    return {
      id: String(market.id),
      question: String(market.question || market.id),
      outcomes: market.outcomes.map(outcome => ({ name: String(outcome.name), tokenId: String(outcome.tokenId) })),
    };
  }
  if (market?.id == null) return null;
  const response = await fetchImpl(`${GAMMA_API}/markets/${encodeURIComponent(String(market.id))}`, { signal });
  if (!response.ok) throw new Error(`Gamma market ${market.id} HTTP ${response.status}`);
  const detail = await response.json();
  const names = parseArray(detail?.outcomes);
  const tokenIds = parseArray(detail?.clobTokenIds);
  if (names.length < 2 || tokenIds.length !== names.length) return null;
  return {
    id: String(detail.id ?? market.id),
    question: String(detail.question || market.question || market.id),
    outcomes: names.map((name, index) => ({ name: String(name), tokenId: String(tokenIds[index]) })),
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= items.length) break;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function hashSelectionKey(value, seed = 42) {
  let hash = (2166136261 ^ Number(seed)) >>> 0;
  for (const char of String(value)) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash;
}

function marketFromGamma(detail) {
  const names = parseArray(detail?.outcomes);
  const tokenIds = parseArray(detail?.clobTokenIds);
  if (detail?.id == null || names.length < 2 || tokenIds.length !== names.length) return null;
  return {
    id: String(detail.id),
    question: String(detail.question || detail.id),
    startDate: detail.startDate || detail.startDateIso || null,
    endDate: detail.endDate || detail.endDateIso || null,
    outcomes: names.map((name, index) => ({ name: String(name), tokenId: String(tokenIds[index]) })),
  };
}

export async function fetchHistoricalUniverse({
  startTs,
  endTs,
  maxMarkets = 5,
  seed = 42,
  fetchImpl = fetch,
  signal,
} = {}) {
  const start = new Date(Number(startTs) * 1000);
  const end = new Date(Number(endTs) * 1000);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start >= end) throw new Error('Janela do universo histórico inválida.');
  const base = {
    limit: String(UNIVERSE_PAGE_SIZE),
    order: 'startDate',
    ascending: 'true',
    start_date_max: end.toISOString(),
    end_date_min: start.toISOString(),
  };
  const load = async closed => {
    const all = [];
    for (let page = 0; page < MAX_UNIVERSE_PAGES; page++) {
      const params = new URLSearchParams({
        ...base,
        closed: String(closed),
        offset: String(page * UNIVERSE_PAGE_SIZE),
      });
      const response = await fetchImpl(`${GAMMA_API}/markets?${params}`, { signal });
      if (!response.ok) throw new Error(`Gamma universo HTTP ${response.status}`);
      const payload = await response.json();
      const rows = Array.isArray(payload) ? payload : [];
      all.push(...rows.map(marketFromGamma).filter(Boolean));
      if (rows.length < UNIVERSE_PAGE_SIZE) break;
    }
    return all;
  };
  const [closed, open] = await Promise.all([load(true), load(false)]);
  const deduped = new Map([...closed, ...open].map(market => [market.id, market]));
  const candidates = [...deduped.values()]
    .filter(market => {
      const marketStart = market.startDate ? Date.parse(market.startDate) : -Infinity;
      const marketEnd = market.endDate ? Date.parse(market.endDate) : Infinity;
      return marketStart <= end.getTime() && marketEnd >= start.getTime();
    })
    .sort((a, b) => hashSelectionKey(a.id, seed) - hashSelectionKey(b.id, seed));
  return {
    candidates: candidates.length,
    markets: candidates.slice(0, clampInt(maxMarkets, 1, 10, 5)),
    selection: 'deterministic-seeded-overlap-sample',
    pagesScannedPerState: MAX_UNIVERSE_PAGES,
  };
}

async function eligibleMarkets(markets, maxMarkets, options) {
  const selected = (Array.isArray(markets) ? markets : []).slice(0, Math.max(maxMarkets * 3, maxMarkets));
  const resolved = await mapWithConcurrency(selected, 4, async market => {
    try { return await resolveMarketTokens(market, options); }
    catch { return null; }
  });
  return resolved.filter(Boolean).slice(0, maxMarkets);
}

export function buildDatasetFromSeries(series, marketDefs, {
  fidelityMinutes = 60,
  maxForwardFillBuckets = DEFAULT_MAX_FORWARD_FILL_BUCKETS,
} = {}) {
  const bucketMs = clampInt(fidelityMinutes, 1, 1440, 60) * 60_000;
  const maxStalenessMs = clampInt(maxForwardFillBuckets, 0, 100, DEFAULT_MAX_FORWARD_FILL_BUCKETS) * bucketMs;
  const marketById = new Map(marketDefs.map(market => [String(market.id), market]));
  const buckets = new Set();
  const normalized = new Map();

  for (const item of series) {
    const key = `${String(item.marketId)}|${String(item.outcome)}`;
    const points = [];
    for (const row of Array.isArray(item.points) ? item.points : []) {
      const ts = Number(row.timestamp);
      const price = Number(row.price);
      if (!Number.isFinite(ts) || !Number.isFinite(price)) continue;
      const bucket = Math.floor(ts / bucketMs) * bucketMs;
      buckets.add(bucket);
      points.push({ timestamp: bucket, price: Math.max(0, Math.min(1, price)) });
    }
    points.sort((a, b) => a.timestamp - b.timestamp);
    const deduped = new Map(points.map(point => [point.timestamp, point.price]));
    normalized.set(key, [...deduped.entries()].map(([timestamp, price]) => ({ timestamp, price })));
  }

  const timeline = [...buckets].sort((a, b) => a - b);
  const cursors = new Map();
  const lastPrices = new Map();
  const lastSeen = new Map();
  const dataset = [];

  for (const timestamp of timeline) {
    const markets = [];
    for (const [marketId, market] of marketById) {
      const outcomes = [];
      for (const outcomeDef of market.outcomes) {
        const key = `${marketId}|${outcomeDef.name}`;
        const points = normalized.get(key) || [];
        let index = cursors.get(key) || 0;
        while (index < points.length && points[index].timestamp <= timestamp) {
          lastPrices.set(key, points[index].price);
          lastSeen.set(key, points[index].timestamp);
          index++;
        }
        cursors.set(key, index);
        const seenAt = lastSeen.get(key);
        const freshEnough = Number.isFinite(seenAt) && timestamp - seenAt <= maxStalenessMs;
        if (lastPrices.has(key) && freshEnough) outcomes.push({ name: outcomeDef.name, price: lastPrices.get(key) });
      }
      if (outcomes.length === market.outcomes.length) {
        markets.push({ id: marketId, question: market.question || marketId, outcomes });
      }
    }
    if (markets.length) dataset.push({ timestamp, markets });
  }
  return dataset;
}

export async function fetchHistoricalDataset(markets, {
  days = 30,
  fidelityMinutes = 60,
  maxMarkets = 5,
  endTimeMs = Date.now(),
  fetchImpl = fetch,
  signal,
  onProgress,
  universeMode = 'historical',
  seed = 42,
  maxForwardFillBuckets = DEFAULT_MAX_FORWARD_FILL_BUCKETS,
} = {}) {
  const count = clampInt(maxMarkets, 1, 10, 5);
  const endTs = Math.floor(Number(endTimeMs) / 1000);
  const startTs = endTs - clampInt(days, 1, 3650, 30) * 86400;
  const selectionSeed = clampInt(seed, 1, 2147483646, 42);
  let selected;
  let universeMeta;
  if (universeMode === 'current') {
    selected = await eligibleMarkets(markets, count, { fetchImpl, signal });
    universeMeta = { mode: 'current', candidates: Array.isArray(markets) ? markets.length : 0, selection: 'current-loaded-markets' };
  } else {
    const historical = await fetchHistoricalUniverse({ startTs, endTs, maxMarkets: count, seed: selectionSeed, fetchImpl, signal });
    selected = historical.markets;
    universeMeta = {
      mode: 'historical',
      candidates: historical.candidates,
      selection: historical.selection,
      pagesScannedPerState: historical.pagesScannedPerState,
    };
  }
  if (!selected.length) throw new Error('Nenhum mercado elegível encontrado para a janela histórica.');
  const tasks = [];
  for (const market of selected) {
    for (const outcome of market.outcomes) tasks.push({ market, outcome });
  }

  let completed = 0;
  const series = await mapWithConcurrency(tasks, 4, async ({ market, outcome }) => {
    const points = await fetchTokenHistory(outcome.tokenId, { startTs, endTs, fidelityMinutes, fetchImpl, signal });
    completed++;
    onProgress?.({ completed, total: tasks.length, marketId: market.id, outcome: outcome.name, points: points.length });
    return { marketId: market.id, outcome: outcome.name, points };
  });

  const seriesByMarket = new Map();
  for (const item of series) {
    const list = seriesByMarket.get(String(item.marketId)) || [];
    list.push(item);
    seriesByMarket.set(String(item.marketId), list);
  }
  const usable = selected.filter(market => {
    const rows = seriesByMarket.get(String(market.id)) || [];
    return rows.length === market.outcomes.length && rows.every(row => row.points.length >= 3);
  });
  const marketDefs = usable.map(market => ({
    id: String(market.id),
    question: String(market.question || market.id),
    outcomes: market.outcomes.map(outcome => ({ name: String(outcome.name), tokenId: String(outcome.tokenId) })),
  }));
  const usableIds = new Set(marketDefs.map(market => market.id));
  const usableSeries = series.filter(item => usableIds.has(String(item.marketId)));
  const boundedForwardFill = clampInt(maxForwardFillBuckets, 0, 100, DEFAULT_MAX_FORWARD_FILL_BUCKETS);
  const dataset = buildDatasetFromSeries(usableSeries, marketDefs, {
    fidelityMinutes,
    maxForwardFillBuckets: boundedForwardFill,
  });
  if (!marketDefs.length || dataset.length < 10) throw new Error(`Histórico insuficiente após alinhamento (${dataset.length} barras, ${marketDefs.length} mercados). Tente janela/fidelidade maior.`);
  return {
    dataset,
    markets: marketDefs,
    source: 'Polymarket CLOB /prices-history',
    startTs,
    endTs,
    fidelityMinutes: clampInt(fidelityMinutes, 1, 1440, 60),
    maxForwardFillBuckets: boundedForwardFill,
    universe: { ...universeMeta, selected: selected.length, usable: marketDefs.length, selectedIds: selected.map(market => String(market.id)) },
  };
}

export const _internal = {
  cleanHistory,
  eligibleMarkets,
  mapWithConcurrency,
  parseArray,
  hashSelectionKey,
  marketFromGamma,
  DEFAULT_MAX_FORWARD_FILL_BUCKETS,
};
