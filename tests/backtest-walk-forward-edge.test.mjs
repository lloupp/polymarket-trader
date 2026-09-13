import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeWalkForwardOptions, walkForwardValidate } from '../js/backtest-advanced.js';

function dataset(length = 40) {
  return Array.from({ length }, (_, i) => ({
    timestamp: 1_700_000_000_000 + i * 3_600_000,
    markets: [{
      id: 'm1',
      question: 'Teste',
      outcomes: [
        { name: 'Yes', price: 0.1 + (i % 8) * 0.01 },
        { name: 'No', price: 0.9 - (i % 8) * 0.01 },
      ],
    }],
  }));
}

const config = {
  strategy: 'meanReversion',
  warmupBars: 5,
  initialBalance: 1000,
  maxDailyLossPct: 50,
  maxMarketExposurePct: 100,
  maxPositionPct: 100,
  cooldownAfterLossMin: 0,
};

test('janela externa é limitada a no mínimo 10%', () => {
  const options = normalizeWalkForwardOptions(100, { trainPct: 50, testPct: 5 }, config);
  assert.equal(options.testPct, 10);
  assert.equal(options.testBars, 10);
});

test('walk-forward rigoroso rejeita configuração com apenas um fold externo', () => {
  assert.throws(
    () => walkForwardValidate(dataset(40), config, { trainPct: 80, testPct: 20 }),
    /pelo menos dois folds externos/,
  );
});
