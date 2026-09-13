import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWalkForwardOptions,
  walkForwardValidate,
  runPassiveFavoriteBenchmark,
  runCostStressMatrix,
} from '../js/backtest-advanced.js';

function dataset(length = 90) {
  return Array.from({ length }, (_, i) => {
    const yes1 = 0.10 + (i % 12) * 0.012;
    const yes2 = 0.30 + ((i * 3) % 10) * 0.015;
    return {
      timestamp: 1_700_000_000_000 + i * 3_600_000,
      markets: [
        { id: 'm1', question: 'M1', outcomes: [{ name: 'Yes', price: yes1 }, { name: 'No', price: 1 - yes1 }] },
        { id: 'm2', question: 'M2', outcomes: [{ name: 'Yes', price: yes2 }, { name: 'No', price: 1 - yes2 }] },
      ],
    };
  });
}

const config = {
  strategy: 'meanReversion',
  initialBalance: 1000,
  porTrade: 10,
  maxOpenPositions: 5,
  minPriceToBuy: 0.01,
  maxPriceToBuy: 0.75,
  profitTarget: 15,
  stopLoss: 30,
  maxDailyLossPct: 50,
  maxMarketExposurePct: 100,
  maxPositionPct: 100,
  cooldownAfterLossMin: 0,
  feeBps: 0,
  slippageBps: 0,
  warmupBars: 5,
  outOfSamplePct: 30,
  seed: 42,
};

test('normaliza janelas walk-forward proporcionais ao dataset', () => {
  const opts = normalizeWalkForwardOptions(100, { trainPct: 50, testPct: 20 }, config);
  assert.equal(opts.trainBars, 50);
  assert.equal(opts.testBars, 20);
  assert.equal(opts.stepBars, 20);
});

test('walk-forward usa testes externos não sobrepostos e split exato', () => {
  const data = dataset(100);
  const wf = walkForwardValidate(data, config, { trainPct: 50, testPct: 20, selectionMode: 'fixed' });
  assert.equal(wf.folds.length, 2);
  assert.equal(wf.folds[0].testStart, data[50].timestamp);
  assert.equal(wf.folds[0].testEnd, data[69].timestamp);
  assert.equal(wf.folds[1].testStart, data[70].timestamp);
  assert.ok(wf.folds[0].testEnd < wf.folds[1].testStart);
  assert.equal(wf.assumptions.outerTestsNonOverlapping, true);
});

test('seleção aninhada do primeiro fold não depende do teste externo', () => {
  const original = dataset(100);
  const mutated = structuredClone(original);
  for (let i = 50; i < 70; i++) {
    for (const market of mutated[i].markets) {
      market.outcomes[0].price = 0.99;
      market.outcomes[1].price = 0.01;
    }
  }
  const options = { trainPct: 50, testPct: 20, selectionMode: 'nestedBest', innerOosPct: 30 };
  const a = walkForwardValidate(original, config, options);
  const b = walkForwardValidate(mutated, config, options);
  assert.equal(a.folds[0].selectedStrategy, b.folds[0].selectedStrategy);
  assert.deepEqual(a.folds[0].innerSelection, b.folds[0].innerSelection);
});

test('benchmark passivo decide no início OOS e executa na barra seguinte', () => {
  const data = dataset(60);
  const benchmark = runPassiveFavoriteBenchmark(data, { ...config, outOfSamplePct: 30 });
  const buy = benchmark.trades.find(trade => trade.side === 'buy');
  assert.ok(buy);
  assert.equal(buy.signalTimestamp, data[benchmark.splitIndex].timestamp);
  assert.equal(buy.timestamp, data[benchmark.splitIndex + 1].timestamp);
  assert.equal(benchmark.validationStart, data[benchmark.splitIndex].timestamp);
});

test('walk-forward produz benchmark e alpha em todos os folds', () => {
  const wf = walkForwardValidate(dataset(100), config, { trainPct: 50, testPct: 20 });
  assert.equal(wf.folds.every(fold => Number.isFinite(fold.benchmarkReturnPct)), true);
  assert.equal(wf.folds.every(fold => Math.abs(fold.alphaPct - (fold.returnPct - fold.benchmarkReturnPct)) < 1e-9), true);
  assert.ok(Number.isFinite(wf.summary.compoundedAlphaPct));
});

test('stress de custos gera matriz completa e resume pior cenário', () => {
  const stress = runCostStressMatrix(
    dataset(100),
    config,
    { trainPct: 50, testPct: 20 },
    { feeBpsGrid: [0, 50], slippageBpsGrid: [0, 100] },
  );
  assert.equal(stress.rows.length, 4);
  assert.equal(stress.summary.scenarios, 4);
  assert.ok(stress.summary.worstReturnPct <= stress.summary.bestReturnPct);
  assert.ok(stress.summary.positiveScenarioPct >= 0 && stress.summary.positiveScenarioPct <= 100);
  assert.ok(stress.summary.beatBenchmarkScenarioPct >= 0 && stress.summary.beatBenchmarkScenarioPct <= 100);
});
