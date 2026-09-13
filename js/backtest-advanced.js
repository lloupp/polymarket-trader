// backtest-advanced.js — walk-forward, stress de custos e benchmarks passivos

import {
  runBacktest,
  compareStrategies,
  normalizeDataset,
  normalizeBacktestConfig,
  computePerformanceMetrics,
} from './backtest.js';

const SELECTION_MODES = new Set(['fixed', 'nestedBest']);

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

function median(values) {
  const clean = values.map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!clean.length) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

function mean(values) {
  const clean = values.map(Number).filter(Number.isFinite);
  return clean.length ? clean.reduce((sum, value) => sum + value, 0) / clean.length : null;
}

function resolveSplitIndex(length, config) {
  const raw = Math.max(config.warmupBars + 1, Math.floor(length * (1 - config.outOfSamplePct / 100)));
  return Math.min(raw, length - 2);
}

function outOfSamplePctForSplit(length, splitIndex) {
  if (length < 3 || splitIndex < 1 || splitIndex > length - 2) throw new Error('Split walk-forward inválido.');
  const target = splitIndex + 0.25;
  const pct = 100 * (1 - target / length);
  if (pct < 10 || pct > 90) throw new Error('Janela walk-forward incompatível com os limites OOS do motor.');
  return pct;
}

export function normalizeWalkForwardOptions(datasetLength, input = {}, coreConfig = {}) {
  const n = Math.max(0, Math.floor(Number(datasetLength) || 0));
  const cfg = normalizeBacktestConfig(coreConfig);
  const trainPct = clamp(input.trainPct, 20, 80, 50);
  const testPct = clamp(input.testPct, 10, 35, 15);
  let trainBars = Math.max(cfg.warmupBars + 5, Math.floor(n * trainPct / 100));
  let testBars = Math.max(3, Math.floor(n * testPct / 100));
  if (trainBars + testBars > n) {
    trainBars = Math.max(cfg.warmupBars + 5, n - testBars);
  }
  if (trainBars + testBars > n) {
    testBars = Math.max(3, n - trainBars);
  }
  const selectionMode = SELECTION_MODES.has(input.selectionMode) ? input.selectionMode : 'fixed';
  return {
    trainPct,
    testPct,
    trainBars,
    testBars,
    stepBars: testBars,
    innerOosPct: clamp(input.innerOosPct, 15, 50, 30),
    selectionMode,
  };
}

function stitchCurves(folds, accessor, initialBalance) {
  let capital = initialBalance;
  const curve = [];
  for (const fold of folds) {
    const source = accessor(fold) || [];
    if (source.length < 2) continue;
    const startEquity = Number(source[0].equity);
    if (!(startEquity > 0)) continue;
    source.forEach((point, index) => {
      if (index === 0 && curve.length) return;
      const ratio = Number(point.equity) / startEquity;
      if (!Number.isFinite(ratio)) return;
      curve.push({ timestamp: point.timestamp, equity: capital * ratio });
    });
    const last = source.at(-1);
    if (last && Number.isFinite(Number(last.equity))) capital *= Number(last.equity) / startEquity;
  }
  return curve;
}

function maxDrawdownPct(curve) {
  let peak = -Infinity;
  let worst = 0;
  for (const point of curve) {
    const equity = Number(point?.equity);
    if (!Number.isFinite(equity)) continue;
    peak = Math.max(peak, equity);
    if (peak > 0) worst = Math.min(worst, (equity / peak - 1) * 100);
  }
  return worst;
}

function fillPrice(rawPrice, side, slippageBps) {
  const impact = slippageBps / 10000;
  return side === 'buy'
    ? Math.min(1, rawPrice * (1 + impact))
    : Math.max(0, rawPrice * (1 - impact));
}

function snapshotMarketMap(snapshot) {
  return new Map((snapshot?.markets || []).map(market => [String(market.id), market]));
}

function getOutcomePrice(snapshot, marketId, outcome) {
  const market = snapshotMarketMap(snapshot).get(String(marketId));
  const row = market?.outcomes?.find(item => item.name === outcome);
  const price = Number(row?.price);
  return Number.isFinite(price) ? price : null;
}

export function runPassiveFavoriteBenchmark(inputDataset, inputConfig = {}) {
  const dataset = normalizeDataset(inputDataset);
  const config = normalizeBacktestConfig(inputConfig);
  if (dataset.length < config.warmupBars + 3) throw new Error('Dados insuficientes para benchmark.');
  const splitIndex = resolveSplitIndex(dataset.length, config);
  const signal = dataset[splitIndex];
  const fill = dataset[splitIndex + 1];
  const candidates = [];
  for (const market of signal.markets) {
    const ranked = [...market.outcomes].sort((a, b) => b.price - a.price);
    const favorite = ranked[0];
    if (!favorite) continue;
    const fillRaw = getOutcomePrice(fill, market.id, favorite.name);
    if (fillRaw == null || fillRaw <= 0 || fillRaw >= 1) continue;
    candidates.push({ marketId: String(market.id), marketQuestion: market.question, outcome: favorite.name, signalPrice: favorite.price });
  }

  let cash = config.initialBalance;
  let totalFees = 0;
  let slippageCost = 0;
  let turnover = 0;
  const trades = [];
  const positions = new Map();
  const allocation = candidates.length ? config.initialBalance / candidates.length : 0;
  const feeRate = config.feeBps / 10000;

  for (const candidate of candidates) {
    const rawPrice = getOutcomePrice(fill, candidate.marketId, candidate.outcome);
    const price = fillPrice(rawPrice, 'buy', config.slippageBps);
    const shares = Math.floor(allocation / (price * (1 + feeRate)));
    if (shares < 1) continue;
    const notional = shares * price;
    const fee = notional * feeRate;
    if (notional + fee > cash + 1e-9) continue;
    cash -= notional + fee;
    totalFees += fee;
    slippageCost += shares * Math.max(0, price - rawPrice);
    turnover += notional;
    positions.set(`${candidate.marketId}|${candidate.outcome}`, { ...candidate, shares, avgPrice: price, entryFee: fee, lastPrice: rawPrice });
    trades.push({ side: 'buy', timestamp: fill.timestamp, signalTimestamp: signal.timestamp, shares, rawPrice, price, notional, fee, slippageCost: shares * Math.max(0, price - rawPrice), pnl: null, reason: 'passive-favorite-entry', ...candidate });
  }

  const curve = [{ timestamp: signal.timestamp, equity: config.initialBalance, grossExposure: 0, cash: config.initialBalance, positions: 0 }];
  for (let i = splitIndex + 1; i < dataset.length; i++) {
    const snapshot = dataset[i];
    let grossExposure = 0;
    for (const position of positions.values()) {
      const price = getOutcomePrice(snapshot, position.marketId, position.outcome);
      if (price != null) position.lastPrice = price;
      grossExposure += position.shares * position.lastPrice;
    }
    curve.push({ timestamp: snapshot.timestamp, equity: cash + grossExposure, grossExposure, cash, positions: positions.size });
  }

  const last = dataset.at(-1);
  for (const [key, position] of [...positions.entries()]) {
    const rawPrice = getOutcomePrice(last, position.marketId, position.outcome);
    if (rawPrice == null) continue;
    const price = fillPrice(rawPrice, 'sell', config.slippageBps);
    const notional = position.shares * price;
    const fee = notional * feeRate;
    const pnl = notional - fee - position.shares * position.avgPrice - position.entryFee;
    const slip = position.shares * Math.max(0, rawPrice - price);
    cash += notional - fee;
    totalFees += fee;
    slippageCost += slip;
    turnover += notional;
    trades.push({ side: 'sell', timestamp: last.timestamp, signalTimestamp: last.timestamp, shares: position.shares, rawPrice, price, notional, fee, slippageCost: slip, pnl, reason: 'passive-favorite-exit', marketId: position.marketId, marketQuestion: position.marketQuestion, outcome: position.outcome });
    positions.delete(key);
  }
  if (curve.length) {
    const unresolvedValue = [...positions.values()].reduce((sum, p) => sum + p.shares * p.lastPrice, 0);
    curve[curve.length - 1] = { timestamp: last.timestamp, equity: cash + unresolvedValue, grossExposure: unresolvedValue, cash, positions: positions.size };
  }
  const metrics = computePerformanceMetrics(curve, trades, config.initialBalance, { totalFees, slippageCost, turnover });
  return { curve, trades, metrics, candidates: candidates.length, unresolvedPositions: positions.size, splitIndex, validationStart: signal.timestamp };
}

function chooseStrategy(trainSlice, config, innerOosPct) {
  const rows = compareStrategies(trainSlice, { ...config, outOfSamplePct: innerOosPct });
  const winner = rows.find(row => row.result.validationMetrics) || rows[0];
  return {
    strategy: winner?.strategy || config.strategy,
    innerRows: rows.map(row => ({
      strategy: row.strategy,
      returnPct: row.result.validationMetrics?.returnPct ?? null,
      maxDrawdownPct: row.result.validationMetrics?.maxDrawdownPct ?? null,
    })),
  };
}

export function walkForwardValidate(inputDataset, inputConfig = {}, inputOptions = {}) {
  const dataset = normalizeDataset(inputDataset);
  const config = normalizeBacktestConfig(inputConfig);
  const options = normalizeWalkForwardOptions(dataset.length, inputOptions, config);
  if (dataset.length < options.trainBars + options.testBars) throw new Error('Dados insuficientes para walk-forward.');

  const folds = [];
  for (let start = 0, index = 0; start + options.trainBars + options.testBars <= dataset.length; start += options.stepBars, index++) {
    const trainEnd = start + options.trainBars;
    const testEnd = trainEnd + options.testBars;
    const trainSlice = dataset.slice(start, trainEnd);
    const foldSlice = dataset.slice(start, testEnd);
    const selected = options.selectionMode === 'nestedBest'
      ? chooseStrategy(trainSlice, config, options.innerOosPct)
      : { strategy: config.strategy, innerRows: null };
    const oosPct = outOfSamplePctForSplit(foldSlice.length, options.trainBars);
    const foldConfig = { ...config, strategy: selected.strategy, outOfSamplePct: oosPct };
    const result = runBacktest(foldSlice, foldConfig);
    const expectedValidationStart = foldSlice[options.trainBars].timestamp;
    if (result.validationStart !== expectedValidationStart) throw new Error('Invariante walk-forward violada: split OOS deslocado.');
    const benchmark = runPassiveFavoriteBenchmark(foldSlice, foldConfig);
    const returnPct = result.validationMetrics?.returnPct ?? 0;
    const benchmarkReturnPct = benchmark.metrics?.returnPct ?? 0;
    folds.push({
      index: index + 1,
      trainStart: trainSlice[0].timestamp,
      trainEnd: trainSlice.at(-1).timestamp,
      testStart: expectedValidationStart,
      testEnd: foldSlice.at(-1).timestamp,
      selectedStrategy: selected.strategy,
      innerSelection: selected.innerRows,
      result,
      benchmark,
      returnPct,
      benchmarkReturnPct,
      alphaPct: returnPct - benchmarkReturnPct,
    });
  }
  if (folds.length < 2) throw new Error('Walk-forward rigoroso requer pelo menos dois folds externos.');

  const strategyCurve = stitchCurves(folds, fold => fold.result.validationEquityCurve, config.initialBalance);
  const benchmarkCurve = stitchCurves(folds, fold => fold.benchmark.curve, config.initialBalance);
  const strategyFactor = folds.reduce((factor, fold) => factor * (1 + fold.returnPct / 100), 1);
  const benchmarkFactor = folds.reduce((factor, fold) => factor * (1 + fold.benchmarkReturnPct / 100), 1);
  const selectedCounts = {};
  for (const fold of folds) selectedCounts[fold.selectedStrategy] = (selectedCounts[fold.selectedStrategy] || 0) + 1;
  const returns = folds.map(fold => fold.returnPct);
  const alphas = folds.map(fold => fold.alphaPct);
  const summary = {
    folds: folds.length,
    compoundedReturnPct: (strategyFactor - 1) * 100,
    benchmarkCompoundedReturnPct: (benchmarkFactor - 1) * 100,
    compoundedAlphaPct: (strategyFactor - benchmarkFactor) * 100,
    averageFoldReturnPct: mean(returns),
    medianFoldReturnPct: median(returns),
    worstFoldReturnPct: Math.min(...returns),
    bestFoldReturnPct: Math.max(...returns),
    positiveFoldPct: folds.filter(fold => fold.returnPct > 0).length / folds.length * 100,
    beatBenchmarkPct: folds.filter(fold => fold.alphaPct > 0).length / folds.length * 100,
    medianAlphaPct: median(alphas),
    maxStitchedDrawdownPct: maxDrawdownPct(strategyCurve),
    benchmarkMaxDrawdownPct: maxDrawdownPct(benchmarkCurve),
    selectedCounts,
  };
  return {
    config,
    options,
    folds,
    strategyCurve,
    benchmarkCurve,
    summary,
    assumptions: {
      outerTestsNonOverlapping: options.stepBars === options.testBars,
      strategySelectionUsesTrainingOnly: true,
      outerFoldStartsFlat: true,
      benchmarkSignalAtTestStartExecutesNextBar: true,
    },
  };
}

function uniqueSorted(values) {
  return [...new Set(values.map(Number).filter(Number.isFinite))].sort((a, b) => a - b);
}

export function runCostStressMatrix(inputDataset, inputConfig = {}, walkOptions = {}, stressOptions = {}) {
  const config = normalizeBacktestConfig(inputConfig);
  const fees = uniqueSorted([...(stressOptions.feeBpsGrid || [0, 25, 50, 100]), config.feeBps]);
  const slippages = uniqueSorted([...(stressOptions.slippageBpsGrid || [0, 25, 50, 100, 250]), config.slippageBps]);
  const rows = [];
  for (const feeBps of fees) {
    for (const slippageBps of slippages) {
      const wf = walkForwardValidate(inputDataset, { ...config, feeBps, slippageBps }, { ...walkOptions, selectionMode: 'fixed' });
      rows.push({
        feeBps,
        slippageBps,
        compoundedReturnPct: wf.summary.compoundedReturnPct,
        benchmarkReturnPct: wf.summary.benchmarkCompoundedReturnPct,
        alphaPct: wf.summary.compoundedAlphaPct,
        positiveFoldPct: wf.summary.positiveFoldPct,
        maxDrawdownPct: wf.summary.maxStitchedDrawdownPct,
        folds: wf.summary.folds,
      });
    }
  }
  const returns = rows.map(row => row.compoundedReturnPct);
  const alphas = rows.map(row => row.alphaPct);
  const sameFee = rows.filter(row => row.feeBps === config.feeBps && row.compoundedReturnPct > 0);
  return {
    feeGrid: fees,
    slippageGrid: slippages,
    rows,
    summary: {
      scenarios: rows.length,
      positiveScenarioPct: rows.filter(row => row.compoundedReturnPct > 0).length / rows.length * 100,
      beatBenchmarkScenarioPct: rows.filter(row => row.alphaPct > 0).length / rows.length * 100,
      worstReturnPct: Math.min(...returns),
      bestReturnPct: Math.max(...returns),
      worstAlphaPct: Math.min(...alphas),
      medianReturnPct: median(returns),
      maxPositiveSlippageAtConfiguredFeeBps: sameFee.length ? Math.max(...sameFee.map(row => row.slippageBps)) : null,
    },
  };
}

export { SELECTION_MODES };
