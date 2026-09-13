import test from 'node:test';
import assert from 'node:assert/strict';
import {
  runBacktest,
  compareStrategies,
  blockBootstrapReturnCI,
  normalizeDataset,
} from '../js/backtest.js';
import { buildDatasetFromSeries, fetchHistoricalUniverse } from '../js/backtest-data.js';

function datasetFromYes(prices, stepMs = 60_000) {
  return prices.map((price, index) => ({
    timestamp: 1_700_000_000_000 + index * stepMs,
    markets: [{
      id: 'm1',
      question: 'Teste',
      outcomes: [
        { name: 'Yes', price },
        { name: 'No', price: 1 - price },
      ],
    }],
  }));
}

const baseConfig = {
  strategy: 'meanReversion',
  initialBalance: 1000,
  porTrade: 10,
  maxOpenPositions: 5,
  minPriceToBuy: 0.01,
  maxPriceToBuy: 0.75,
  profitTarget: 1000,
  stopLoss: 100,
  maxDailyLossPct: 50,
  maxMarketExposurePct: 100,
  maxPositionPct: 100,
  cooldownAfterLossMin: 0,
  feeBps: 0,
  slippageBps: 0,
  warmupBars: 1,
  outOfSamplePct: 30,
  seed: 42,
};

test('executa entrada na barra seguinte, não no preço que gerou o sinal', () => {
  const data = datasetFromYes([0.4, 0.1, 0.2, 0.2, 0.2]);
  const result = runBacktest(data, baseConfig);
  const buy = result.trades.find(t => t.side === 'buy');
  assert.ok(buy);
  assert.equal(buy.signalTimestamp, data[1].timestamp);
  assert.equal(buy.timestamp, data[2].timestamp);
  assert.equal(buy.rawPrice, 0.2);
  assert.equal(buy.price, 0.2);
});

test('não abre posição na última barra apenas para liquidá-la imediatamente', () => {
  const data = datasetFromYes([0.4, 0.4, 0.1, 0.2]);
  const result = runBacktest(data, baseConfig);
  assert.equal(result.trades.filter(t => t.side === 'buy').length, 0);
  assert.equal(result.assumptions.noEntriesOnFinalFillBar, true);
});

test('slippage e taxas reduzem o resultado e são contabilizados', () => {
  const data = datasetFromYes([0.4, 0.1, 0.2, 0.3, 0.4, 0.5]);
  const clean = runBacktest(data, { ...baseConfig, profitTarget: 20, slippageBps: 0, feeBps: 0 });
  const costly = runBacktest(data, { ...baseConfig, profitTarget: 20, slippageBps: 100, feeBps: 50 });
  assert.ok(costly.fullMetrics.endEquity < clean.fullMetrics.endEquity);
  assert.ok(costly.fullMetrics.totalFees > 0);
  assert.ok(costly.fullMetrics.slippageCost > 0);
});

test('random é reproduzível com a mesma seed e não compra quando escolheu venda aleatória', () => {
  const data = datasetFromYes(Array.from({ length: 60 }, (_, i) => 0.35 + (i % 4) * 0.02));
  const cfg = { ...baseConfig, strategy: 'random', warmupBars: 2, seed: 77, profitTarget: 1000 };
  const a = runBacktest(data, cfg);
  const b = runBacktest(data, cfg);
  assert.deepEqual(a.trades, b.trades);
  const buysByTime = new Set(a.trades.filter(t => t.side === 'buy').map(t => t.timestamp));
  const randomSells = a.trades.filter(t => t.side === 'sell' && t.reason === 'random-strategy-sell');
  assert.ok(randomSells.length > 0);
  for (const sell of randomSells) assert.equal(buysByTime.has(sell.timestamp), false);
});

test('normalização ordena e remove timestamps inválidos', () => {
  const data = normalizeDataset([
    { timestamp: 200, markets: [{ id: 1, outcomes: [{ name: 'Yes', price: 0.4 }] }] },
    { timestamp: 'x', markets: [] },
    { timestamp: 100, markets: [{ id: 1, outcomes: [{ name: 'Yes', price: 0.3 }] }] },
  ]);
  assert.deepEqual(data.map(row => row.timestamp), [100, 200]);
});

test('alinhamento histórico faz forward-fill apenas depois da primeira observação', () => {
  const series = [
    { marketId: 'm1', outcome: 'Yes', points: [{ timestamp: 60_000, price: 0.4 }, { timestamp: 180_000, price: 0.6 }] },
    { marketId: 'm1', outcome: 'No', points: [{ timestamp: 120_000, price: 0.6 }, { timestamp: 180_000, price: 0.4 }] },
  ];
  const defs = [{ id: 'm1', question: 'Teste', outcomes: [{ name: 'Yes' }, { name: 'No' }] }];
  const data = buildDatasetFromSeries(series, defs, { fidelityMinutes: 1 });
  assert.equal(data[0].timestamp, 120_000);
  assert.equal(data[0].markets[0].outcomes.find(o => o.name === 'Yes').price, 0.4);
  assert.equal(data[0].markets[0].outcomes.find(o => o.name === 'No').price, 0.6);
});

test('forward-fill expira após limite de staleness para não inventar liquidez', () => {
  const series = [
    { marketId: 'm1', outcome: 'Yes', points: [{ timestamp: 0, price: 0.4 }] },
    { marketId: 'm1', outcome: 'No', points: [0, 60_000, 120_000, 180_000, 240_000, 300_000].map(timestamp => ({ timestamp, price: 0.6 })) },
  ];
  const defs = [{ id: 'm1', question: 'Teste', outcomes: [{ name: 'Yes' }, { name: 'No' }] }];
  const data = buildDatasetFromSeries(series, defs, { fidelityMinutes: 1, maxForwardFillBuckets: 3 });
  assert.deepEqual(data.map(row => row.timestamp), [0, 60_000, 120_000, 180_000]);
});

test('universo histórico pagina candidatos antes da seleção determinística', async () => {
  const calls = [];
  const start = Date.parse('2026-01-01T00:00:00Z') / 1000;
  const end = Date.parse('2026-02-01T00:00:00Z') / 1000;
  const row = id => ({
    id: String(id),
    question: `M${id}`,
    outcomes: '["Yes","No"]',
    clobTokenIds: `["y${id}","n${id}"]`,
    startDate: '2025-12-01T00:00:00Z',
    endDate: '2026-03-01T00:00:00Z',
  });
  const fetchImpl = async url => {
    const parsed = new URL(url);
    calls.push(parsed.searchParams.get('offset'));
    const closed = parsed.searchParams.get('closed') === 'true';
    const offset = Number(parsed.searchParams.get('offset'));
    let payload = [];
    if (closed && offset === 0) payload = Array.from({ length: 100 }, (_, i) => row(i));
    if (closed && offset === 100) payload = [row(100)];
    return { ok: true, status: 200, json: async () => payload };
  };
  const result = await fetchHistoricalUniverse({ startTs: start, endTs: end, maxMarkets: 5, seed: 9, fetchImpl });
  assert.equal(result.candidates, 101);
  assert.equal(result.markets.length, 5);
  assert.ok(calls.includes('100'));
});

test('gera métricas OOS e bootstrap por blocos quando há amostra suficiente', () => {
  const prices = Array.from({ length: 120 }, (_, i) => 0.1 + ((i % 20) / 100));
  const result = runBacktest(datasetFromYes(prices), { ...baseConfig, warmupBars: 5, outOfSamplePct: 30 });
  assert.ok(result.validationMetrics);
  const ci = blockBootstrapReturnCI(result.equityCurve.slice(-50), { iterations: 100, seed: 9 });
  assert.ok(ci);
  assert.equal(ci.iterations, 100);
  assert.ok(ci.low95 <= ci.high95);
});

test('comparação roda todas as estratégias sem compartilhar estado', () => {
  const prices = Array.from({ length: 40 }, (_, i) => 0.1 + (i % 10) * 0.01);
  const results = compareStrategies(datasetFromYes(prices), { ...baseConfig, warmupBars: 5 });
  assert.equal(results.length, 6);
  assert.equal(new Set(results.map(x => x.strategy)).size, 6);
});

test('validação OOS começa com capital limpo e sem posições herdadas do treino', () => {
  const data = datasetFromYes([0.4, 0.1, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]);
  const result = runBacktest(data, { ...baseConfig, warmupBars: 1, outOfSamplePct: 30, profitTarget: 1000 });
  assert.equal(result.validationEquityCurve[0].equity, 1000);
  assert.equal(result.validationMetrics.startEquity, 1000);
  assert.equal(result.assumptions.validationStartsFlat, true);
});

test('perda diária bloqueia novas entradas depois de stop-loss realizado', () => {
  const data = datasetFromYes([0.4, 0.1, 0.2, 0.1, 0.1, 0.1, 0.1, 0.1]);
  const result = runBacktest(data, {
    ...baseConfig,
    warmupBars: 1,
    stopLoss: 20,
    maxDailyLossPct: 0.1,
    cooldownAfterLossMin: 0,
    outOfSamplePct: 30,
  });
  const fullSells = result.trades.filter(t => t.side === 'sell');
  assert.ok(fullSells.some(t => t.reason === 'stop-loss'));
  assert.ok(result.fullMetrics.riskSkips > 0);
});
