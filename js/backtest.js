// backtest.js — motor puro de backtesting sem look-ahead

const STRATEGIES = ['momentum', 'meanReversion', 'bargainHunting', 'valueBetting', 'kelly', 'random'];

const DEFAULTS = {
  strategy: 'momentum',
  initialBalance: 1000,
  porTrade: 5,
  maxOpenPositions: 10,
  minPriceToBuy: 0.05,
  maxPriceToBuy: 0.75,
  profitTarget: 20,
  stopLoss: 25,
  maxDailyLossPct: 5,
  maxMarketExposurePct: 15,
  maxPositionPct: 10,
  cooldownAfterLossMin: 10,
  feeBps: 0,
  slippageBps: 25,
  warmupBars: 5,
  outOfSamplePct: 30,
  seed: 42,
};

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

export function normalizeBacktestConfig(input = {}) {
  const merged = { ...DEFAULTS, ...(input && typeof input === 'object' ? input : {}) };
  let minPrice = clamp(merged.minPriceToBuy, 0.001, 0.999, DEFAULTS.minPriceToBuy);
  let maxPrice = clamp(merged.maxPriceToBuy, 0.001, 1, DEFAULTS.maxPriceToBuy);
  if (minPrice > maxPrice) [minPrice, maxPrice] = [maxPrice, minPrice];
  return {
    strategy: STRATEGIES.includes(merged.strategy) ? merged.strategy : DEFAULTS.strategy,
    initialBalance: clamp(merged.initialBalance, 1, 1e9, DEFAULTS.initialBalance),
    porTrade: clamp(merged.porTrade, 0.1, 100, DEFAULTS.porTrade),
    maxOpenPositions: Math.round(clamp(merged.maxOpenPositions, 1, 1000, DEFAULTS.maxOpenPositions)),
    minPriceToBuy: minPrice,
    maxPriceToBuy: maxPrice,
    profitTarget: clamp(merged.profitTarget, 0.1, 1000, DEFAULTS.profitTarget),
    stopLoss: clamp(merged.stopLoss, 0.1, 100, DEFAULTS.stopLoss),
    maxDailyLossPct: clamp(merged.maxDailyLossPct, 0.1, 100, DEFAULTS.maxDailyLossPct),
    maxMarketExposurePct: clamp(merged.maxMarketExposurePct, 0.1, 100, DEFAULTS.maxMarketExposurePct),
    maxPositionPct: clamp(merged.maxPositionPct, 0.1, 100, DEFAULTS.maxPositionPct),
    cooldownAfterLossMin: clamp(merged.cooldownAfterLossMin, 0, 10080, DEFAULTS.cooldownAfterLossMin),
    feeBps: clamp(merged.feeBps, 0, 1000, DEFAULTS.feeBps),
    slippageBps: clamp(merged.slippageBps, 0, 5000, DEFAULTS.slippageBps),
    warmupBars: Math.round(clamp(merged.warmupBars, 1, 10000, DEFAULTS.warmupBars)),
    outOfSamplePct: clamp(merged.outOfSamplePct, 10, 90, DEFAULTS.outOfSamplePct),
    seed: Math.trunc(clamp(merged.seed, 1, 2147483646, DEFAULTS.seed)),
  };
}

export function normalizeDataset(dataset) {
  if (!Array.isArray(dataset)) return [];
  const byTime = new Map();
  for (const row of dataset) {
    const timestamp = Number(row?.timestamp);
    if (!Number.isFinite(timestamp)) continue;
    const markets = [];
    for (const market of Array.isArray(row?.markets) ? row.markets : []) {
      if (market?.id == null) continue;
      const outcomes = (Array.isArray(market.outcomes) ? market.outcomes : [])
        .map(outcome => ({ name: String(outcome?.name ?? ''), price: Number(outcome?.price) }))
        .filter(outcome => outcome.name && Number.isFinite(outcome.price) && outcome.price >= 0 && outcome.price <= 1);
      if (!outcomes.length) continue;
      markets.push({ id: String(market.id), question: String(market.question || market.id), outcomes });
    }
    if (markets.length) byTime.set(timestamp, { timestamp, markets });
  }
  return [...byTime.values()].sort((a, b) => a.timestamp - b.timestamp);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function marketMap(snapshot) {
  return new Map((snapshot?.markets || []).map(market => [String(market.id), market]));
}

function outcomePrice(snapshot, marketId, outcome) {
  const market = marketMap(snapshot).get(String(marketId));
  const item = market?.outcomes?.find(entry => entry.name === outcome);
  const price = Number(item?.price);
  return Number.isFinite(price) ? price : null;
}

function positionKey(marketId, outcome) {
  return `${String(marketId)}|${String(outcome)}`;
}

function markPosition(position, snapshot) {
  const price = outcomePrice(snapshot, position.marketId, position.outcome);
  const marked = price == null ? position.lastPrice : price;
  return { price: marked, value: position.shares * marked };
}

function portfolioSnapshot(state, snapshot) {
  let grossExposure = 0;
  for (const position of state.positions.values()) grossExposure += markPosition(position, snapshot).value;
  const equity = state.cash + grossExposure;
  return { equity, grossExposure, cash: state.cash, positions: state.positions.size };
}

function updateHistory(history, snapshot) {
  for (const market of snapshot.markets) {
    for (const outcome of market.outcomes) {
      const key = positionKey(market.id, outcome.name);
      const points = history.get(key) || [];
      points.push({ timestamp: snapshot.timestamp, price: outcome.price });
      history.set(key, points);
    }
  }
}

function eligibleOutcomes(snapshot, config) {
  const items = [];
  for (const market of snapshot.markets) {
    for (const outcome of market.outcomes) {
      if (outcome.price < config.minPriceToBuy || outcome.price > config.maxPriceToBuy) continue;
      items.push({ market, outcome });
    }
  }
  return items;
}

function estimateProbability(history, marketId, outcome) {
  const points = (history.get(positionKey(marketId, outcome)) || []).slice(-5);
  if (points.length < 5) return null;
  return points.reduce((sum, point) => sum + point.price, 0) / points.length;
}

function selectSignal(snapshot, config, history, state, rng) {
  const eligible = eligibleOutcomes(snapshot, config);
  if (!eligible.length) return null;

  if (config.strategy === 'momentum') {
    const candidates = [];
    for (const { market, outcome } of eligible) {
      const points = history.get(positionKey(market.id, outcome.name)) || [];
      if (points.length < 3) continue;
      const change = outcome.price - points.at(-3).price;
      if (change >= 0.02) candidates.push({ market, outcome, score: change, reason: 'Momentum' });
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }

  if (config.strategy === 'meanReversion') {
    const candidates = eligible
      .filter(({ outcome }) => outcome.price <= Math.min(0.25, config.maxPriceToBuy))
      .map(item => ({ ...item, score: 0.25 - item.outcome.price, reason: 'Reversão à média' }))
      .sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }

  if (config.strategy === 'bargainHunting') {
    const candidates = eligible
      .filter(({ market, outcome }) => outcome.price <= Math.min(0.15, config.maxPriceToBuy) && !state.positions.has(positionKey(market.id, outcome.name)))
      .map(item => ({ ...item, score: 0.15 - item.outcome.price, reason: 'Comprar barato' }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    return candidates.length ? candidates[Math.floor(rng() * candidates.length)] : null;
  }

  if (config.strategy === 'valueBetting' || config.strategy === 'kelly') {
    const candidates = [];
    for (const { market, outcome } of eligible) {
      const p = estimateProbability(history, market.id, outcome.name);
      if (p == null || outcome.price <= 0 || outcome.price >= 1) continue;
      const edge = (p - outcome.price) / outcome.price;
      if (config.strategy === 'valueBetting') {
        if (edge > 0.05) candidates.push({ market, outcome, score: edge, reason: 'Value Betting' });
      } else {
        const q = 1 - p;
        const b = (1 - outcome.price) / outcome.price;
        const halfKelly = ((p * b - q) / b) / 2;
        if (halfKelly > 0.01) candidates.push({ market, outcome, score: halfKelly, kellyFraction: halfKelly, reason: '½-Kelly' });
      }
    }
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }

  if (config.strategy === 'random') {
    const item = eligible[Math.floor(rng() * eligible.length)];
    return item ? { ...item, score: 0, reason: 'Aleatória' } : null;
  }

  return null;
}

function dayKey(timestamp) {
  const d = new Date(timestamp);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

function dailyRealizedPnl(state, timestamp) {
  return state.dailyPnl.get(dayKey(timestamp)) || 0;
}

function riskBlocked(state, config, timestamp) {
  const lossLimit = config.initialBalance * config.maxDailyLossPct / 100;
  if (dailyRealizedPnl(state, timestamp) <= -lossLimit) return 'daily-loss';
  if (state.lastLossAt != null && timestamp < state.lastLossAt + config.cooldownAfterLossMin * 60_000) return 'cooldown';
  return null;
}

function exposureFor(state, snapshot, predicate) {
  let total = 0;
  for (const position of state.positions.values()) {
    if (!predicate(position)) continue;
    total += markPosition(position, snapshot).value;
  }
  return total;
}

function fillPrice(rawPrice, side, slippageBps) {
  const impact = slippageBps / 10000;
  if (side === 'buy') return Math.min(1, rawPrice * (1 + impact));
  return Math.max(0, rawPrice * (1 - impact));
}

function recordTrade(state, trade) {
  state.trades.push(trade);
  state.totalFees += trade.fee || 0;
  state.slippageCost += trade.slippageCost || 0;
  state.turnover += trade.notional || 0;
}

function executeSell(state, order, nextSnapshot, config) {
  const key = positionKey(order.marketId, order.outcome);
  const position = state.positions.get(key);
  if (!position) return false;
  const rawPrice = outcomePrice(nextSnapshot, order.marketId, order.outcome);
  if (rawPrice == null) {
    state.rejectedOrders++;
    return false;
  }
  const price = fillPrice(rawPrice, 'sell', config.slippageBps);
  const shares = position.shares;
  const notional = shares * price;
  const fee = notional * config.feeBps / 10000;
  const allocatedEntryFees = position.entryFees;
  const pnl = notional - fee - shares * position.avgPrice - allocatedEntryFees;
  const slippageCost = shares * Math.max(0, rawPrice - price);
  state.cash += notional - fee;
  state.positions.delete(key);
  const day = dayKey(nextSnapshot.timestamp);
  state.dailyPnl.set(day, (state.dailyPnl.get(day) || 0) + pnl);
  if (pnl < 0) state.lastLossAt = nextSnapshot.timestamp;
  recordTrade(state, {
    side: 'sell', marketId: order.marketId, marketQuestion: position.marketQuestion, outcome: order.outcome,
    timestamp: nextSnapshot.timestamp, signalTimestamp: order.signalTimestamp, shares, rawPrice, price,
    notional, fee, slippageCost, pnl, reason: order.reason,
  });
  return true;
}

function executeBuy(state, order, nextSnapshot, config) {
  const rawPrice = outcomePrice(nextSnapshot, order.marketId, order.outcome);
  if (rawPrice == null) {
    state.rejectedOrders++;
    return false;
  }
  const price = fillPrice(rawPrice, 'buy', config.slippageBps);
  const shares = order.shares;
  const notional = shares * price;
  const fee = notional * config.feeBps / 10000;
  if (shares < 1 || notional + fee > state.cash + 1e-9) {
    state.rejectedOrders++;
    return false;
  }
  const key = positionKey(order.marketId, order.outcome);
  const existing = state.positions.get(key);
  if (existing) {
    const totalShares = existing.shares + shares;
    existing.avgPrice = (existing.avgPrice * existing.shares + price * shares) / totalShares;
    existing.shares = totalShares;
    existing.entryFees += fee;
    existing.lastPrice = price;
  } else {
    state.positions.set(key, {
      marketId: order.marketId, marketQuestion: order.marketQuestion, outcome: order.outcome,
      shares, avgPrice: price, entryFees: fee, lastPrice: price, openedAt: nextSnapshot.timestamp,
    });
  }
  const slippageCost = shares * Math.max(0, price - rawPrice);
  state.cash -= notional + fee;
  recordTrade(state, {
    side: 'buy', marketId: order.marketId, marketQuestion: order.marketQuestion, outcome: order.outcome,
    timestamp: nextSnapshot.timestamp, signalTimestamp: order.signalTimestamp, shares, rawPrice, price,
    notional, fee, slippageCost, pnl: null, reason: order.reason,
  });
  return true;
}

function plannedExitOrders(state, snapshot, config) {
  const orders = [];
  for (const position of state.positions.values()) {
    const price = outcomePrice(snapshot, position.marketId, position.outcome);
    if (price == null || position.avgPrice <= 0) continue;
    const pnlPct = (price - position.avgPrice) / position.avgPrice * 100;
    if (pnlPct >= config.profitTarget) {
      orders.push({ side: 'sell', marketId: position.marketId, outcome: position.outcome, signalTimestamp: snapshot.timestamp, reason: 'take-profit' });
    } else if (pnlPct <= -config.stopLoss) {
      orders.push({ side: 'sell', marketId: position.marketId, outcome: position.outcome, signalTimestamp: snapshot.timestamp, reason: 'stop-loss' });
    }
  }
  return orders;
}

function plannedEntryOrder(state, snapshot, config, history, rng) {
  const blocked = riskBlocked(state, config, snapshot.timestamp);
  if (blocked) {
    state.riskSkips++;
    return null;
  }
  if (state.positions.size >= config.maxOpenPositions) return null;
  const signal = selectSignal(snapshot, config, history, state, rng);
  if (!signal) return null;

  const currentPrice = signal.outcome.price;
  const portfolio = portfolioSnapshot(state, snapshot);
  const equity = portfolio.equity;
  const marketId = String(signal.market.id);
  const outcome = signal.outcome.name;
  const marketExposure = exposureFor(state, snapshot, pos => pos.marketId === marketId);
  const positionExposure = exposureFor(state, snapshot, pos => pos.marketId === marketId && pos.outcome === outcome);

  let budget = state.cash * config.porTrade / 100;
  if (config.strategy === 'kelly' && Number(signal.kellyFraction) > 0) {
    const kellyBudget = state.cash * Math.min(signal.kellyFraction, 0.25);
    budget = Math.max(budget * 0.5, kellyBudget);
  }
  budget = Math.min(
    budget,
    Math.max(0, equity * config.maxMarketExposurePct / 100 - marketExposure),
    Math.max(0, equity * config.maxPositionPct / 100 - positionExposure),
    state.cash,
  );
  const shares = Math.floor(budget / currentPrice);
  if (shares < 1) return null;
  return {
    side: 'buy', marketId, marketQuestion: signal.market.question, outcome, shares,
    signalTimestamp: snapshot.timestamp, signalPrice: currentPrice, reason: signal.reason,
  };
}

function liquidateAtEnd(state, snapshot, config) {
  for (const position of [...state.positions.values()]) {
    const rawPrice = outcomePrice(snapshot, position.marketId, position.outcome);
    if (rawPrice == null) continue;
    const price = fillPrice(rawPrice, 'sell', config.slippageBps);
    const notional = position.shares * price;
    const fee = notional * config.feeBps / 10000;
    const pnl = notional - fee - position.shares * position.avgPrice - position.entryFees;
    const slippageCost = position.shares * Math.max(0, rawPrice - price);
    state.cash += notional - fee;
    state.positions.delete(positionKey(position.marketId, position.outcome));
    const day = dayKey(snapshot.timestamp);
    state.dailyPnl.set(day, (state.dailyPnl.get(day) || 0) + pnl);
    if (pnl < 0) state.lastLossAt = snapshot.timestamp;
    recordTrade(state, {
      side: 'sell', marketId: position.marketId, marketQuestion: position.marketQuestion, outcome: position.outcome,
      timestamp: snapshot.timestamp, signalTimestamp: snapshot.timestamp, shares: position.shares,
      rawPrice, price, notional, fee, slippageCost, pnl, reason: 'forced-final-liquidation',
    });
  }
}

function calcDrawdown(curve) {
  let peak = -Infinity;
  let maxDrawdown = 0;
  let currentDuration = 0;
  let maxDuration = 0;
  const series = [];
  for (const point of curve) {
    peak = Math.max(peak, point.equity);
    const dd = peak > 0 ? (point.equity - peak) / peak : 0;
    if (dd < 0) currentDuration++;
    else currentDuration = 0;
    maxDuration = Math.max(maxDuration, currentDuration);
    maxDrawdown = Math.min(maxDrawdown, dd);
    series.push({ timestamp: point.timestamp, drawdownPct: dd * 100 });
  }
  return { maxDrawdownPct: maxDrawdown * 100, maxDrawdownDurationBars: maxDuration, series };
}

function returnsFromCurve(curve) {
  const returns = [];
  for (let i = 1; i < curve.length; i++) {
    const prev = curve[i - 1].equity;
    const curr = curve[i].equity;
    if (prev > 0 && Number.isFinite(curr)) returns.push(curr / prev - 1);
  }
  return returns;
}

function sampleStd(values) {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(Math.max(0, variance));
}

function annualizationFactor(curve) {
  if (curve.length < 3) return null;
  const diffs = [];
  for (let i = 1; i < curve.length; i++) {
    const d = curve[i].timestamp - curve[i - 1].timestamp;
    if (d > 0) diffs.push(d);
  }
  if (!diffs.length) return null;
  diffs.sort((a, b) => a - b);
  const medianMs = diffs[Math.floor(diffs.length / 2)];
  return (365.25 * 24 * 60 * 60 * 1000) / medianMs;
}

function riskRatios(curve) {
  const returns = returnsFromCurve(curve);
  if (returns.length < 20) return { sharpe: null, sortino: null };
  const annual = annualizationFactor(curve);
  if (!annual || annual <= 0) return { sharpe: null, sortino: null };
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const std = sampleStd(returns);
  const downside = returns.filter(r => r < 0);
  const downsideDeviation = downside.length >= 2 ? Math.sqrt(downside.reduce((sum, r) => sum + r * r, 0) / downside.length) : 0;
  return {
    sharpe: std > 0 ? mean / std * Math.sqrt(annual) : null,
    sortino: downsideDeviation > 0 ? mean / downsideDeviation * Math.sqrt(annual) : null,
  };
}

function tradeStats(trades) {
  const closed = trades.filter(t => t.side === 'sell' && Number.isFinite(t.pnl));
  const wins = closed.filter(t => t.pnl > 0);
  const losses = closed.filter(t => t.pnl < 0);
  const grossWins = wins.reduce((sum, t) => sum + t.pnl, 0);
  const grossLosses = Math.abs(losses.reduce((sum, t) => sum + t.pnl, 0));
  return {
    closedTrades: closed.length,
    winRatePct: closed.length ? wins.length / closed.length * 100 : 0,
    profitFactor: grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? Infinity : 0),
    expectancy: closed.length ? closed.reduce((sum, t) => sum + t.pnl, 0) / closed.length : 0,
  };
}

export function computePerformanceMetrics(curve, trades, initialBalance, extras = {}) {
  if (!curve.length) return null;
  const start = curve[0].equity;
  const end = curve.at(-1).equity;
  const dd = calcDrawdown(curve);
  const ratios = riskRatios(curve);
  const t = tradeStats(trades);
  const averageGrossExposurePct = curve.reduce((sum, p) => sum + (p.equity > 0 ? p.grossExposure / p.equity * 100 : 0), 0) / curve.length;
  return {
    startEquity: start,
    endEquity: end,
    netProfit: end - start,
    returnPct: start > 0 ? (end / start - 1) * 100 : 0,
    maxDrawdownPct: dd.maxDrawdownPct,
    maxDrawdownDurationBars: dd.maxDrawdownDurationBars,
    drawdownSeries: dd.series,
    sharpe: ratios.sharpe,
    sortino: ratios.sortino,
    averageGrossExposurePct,
    ...t,
    totalFees: extras.totalFees || 0,
    slippageCost: extras.slippageCost || 0,
    turnover: extras.turnover || 0,
    rejectedOrders: extras.rejectedOrders || 0,
    riskSkips: extras.riskSkips || 0,
    initialBalance,
  };
}

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * p;
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (index - lo);
}

export function blockBootstrapReturnCI(curve, { iterations = 500, seed = 42 } = {}) {
  const returns = returnsFromCurve(curve);
  if (returns.length < 20) return null;
  const blockSize = Math.max(2, Math.round(Math.sqrt(returns.length)));
  const rng = mulberry32(seed);
  const samples = [];
  for (let iter = 0; iter < iterations; iter++) {
    const selected = [];
    while (selected.length < returns.length) {
      const start = Math.floor(rng() * returns.length);
      for (let j = 0; j < blockSize && selected.length < returns.length; j++) {
        selected.push(returns[(start + j) % returns.length]);
      }
    }
    const cumulative = selected.reduce((factor, r) => factor * (1 + r), 1) - 1;
    samples.push(cumulative * 100);
  }
  samples.sort((a, b) => a - b);
  return {
    low95: percentile(samples, 0.025),
    median: percentile(samples, 0.5),
    high95: percentile(samples, 0.975),
    iterations,
    blockSize,
  };
}

function createState(config) {
  return {
    cash: config.initialBalance,
    positions: new Map(),
    trades: [],
    dailyPnl: new Map(),
    lastLossAt: null,
    totalFees: 0,
    slippageCost: 0,
    turnover: 0,
    rejectedOrders: 0,
    riskSkips: 0,
  };
}

function plannedRandomSell(state, snapshot, config, rng, alreadyExiting) {
  if (config.strategy !== 'random' || !state.positions.size || rng() >= 0.4) return null;
  const candidates = [...state.positions.values()].filter(position => !alreadyExiting.has(positionKey(position.marketId, position.outcome)));
  if (!candidates.length) return null;
  const position = candidates[Math.floor(rng() * candidates.length)];
  return {
    side: 'sell', marketId: position.marketId, outcome: position.outcome,
    signalTimestamp: snapshot.timestamp, reason: 'random-strategy-sell',
  };
}

function simulate(dataset, config, tradeStartIndex) {
  const rng = mulberry32(config.seed);
  const state = createState(config);
  const history = new Map();
  const equityCurve = [];
  let started = false;

  for (let i = 0; i < dataset.length - 1; i++) {
    const current = dataset[i];
    const next = dataset[i + 1];
    updateHistory(history, current);
    if (i < tradeStartIndex) continue;
    started = true;
    const before = portfolioSnapshot(state, current);
    equityCurve.push({ timestamp: current.timestamp, ...before });

    const exits = plannedExitOrders(state, current, config);
    const exiting = new Set(exits.map(order => positionKey(order.marketId, order.outcome)));
    const randomSell = plannedRandomSell(state, current, config, rng, exiting);
    if (randomSell) {
      exits.push(randomSell);
      exiting.add(positionKey(randomSell.marketId, randomSell.outcome));
    }

    const hasStopLoss = exits.some(order => order.reason === 'stop-loss');
    const entry = hasStopLoss ? null : plannedEntryOrder(state, current, config, history, rng);
    if (hasStopLoss) state.riskSkips++;

    for (const order of exits) executeSell(state, order, next, config);
    if (entry) executeBuy(state, entry, next, config);
  }

  const last = dataset.at(-1);
  updateHistory(history, last);
  if (started) {
    liquidateAtEnd(state, last, config);
    equityCurve.push({ timestamp: last.timestamp, ...portfolioSnapshot(state, last) });
  }
  return { state, equityCurve };
}

export function runBacktest(inputDataset, inputConfig = {}) {
  const dataset = normalizeDataset(inputDataset);
  const config = normalizeBacktestConfig(inputConfig);
  if (dataset.length < config.warmupBars + 3) {
    throw new Error(`Dados insuficientes: ${dataset.length} barras; mínimo ${config.warmupBars + 3}.`);
  }

  const splitIndex = Math.max(config.warmupBars + 1, Math.floor(dataset.length * (1 - config.outOfSamplePct / 100)));
  const safeSplitIndex = Math.min(splitIndex, dataset.length - 2);
  const validationStart = dataset[safeSplitIndex].timestamp;

  const full = simulate(dataset, config, config.warmupBars);
  const validation = simulate(dataset, config, safeSplitIndex);
  const fullMetrics = computePerformanceMetrics(full.equityCurve, full.state.trades, config.initialBalance, full.state);
  const validationMetrics = computePerformanceMetrics(validation.equityCurve, validation.state.trades, config.initialBalance, validation.state);
  const confidence = validationMetrics ? blockBootstrapReturnCI(validation.equityCurve, { seed: config.seed }) : null;

  return {
    config,
    bars: dataset.length,
    trainingBars: safeSplitIndex,
    validationBars: dataset.length - safeSplitIndex,
    startTimestamp: dataset[0].timestamp,
    endTimestamp: dataset.at(-1).timestamp,
    validationStart,
    equityCurve: full.equityCurve,
    trades: full.state.trades,
    validationEquityCurve: validation.equityCurve,
    validationTrades: validation.state.trades,
    fullMetrics,
    validationMetrics,
    confidence,
    assumptions: {
      signalUsesOnlyCurrentAndPast: true,
      executionDelayBars: 1,
      feeBps: config.feeBps,
      slippageBps: config.slippageBps,
      forcedLiquidationAtEnd: true,
      orderBookDepthModeled: false,
      validationStartsFlat: true,
      preValidationBarsUsedOnlyForSignalWarmup: true,
    },
  };
}

export function compareStrategies(dataset, config = {}) {
  return STRATEGIES.map(strategy => {
    const result = runBacktest(dataset, { ...config, strategy });
    return { strategy, result };
  }).sort((a, b) => (b.result.validationMetrics?.returnPct ?? -Infinity) - (a.result.validationMetrics?.returnPct ?? -Infinity));
}

export { STRATEGIES, DEFAULTS as DEFAULT_BACKTEST_CONFIG };
