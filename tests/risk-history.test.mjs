import test from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(key) { return this.map.has(key) ? this.map.get(key) : null; }
  setItem(key, value) { this.map.set(key, String(value)); }
  removeItem(key) { this.map.delete(key); }
  clear() { this.map.clear(); }
}

globalThis.localStorage = new MemoryStorage();

const wallet = await import('../js/wallet.js');
const history = await import('../js/market-history.js');
const bot = await import('../js/bot.js');

const closeTo = (actual, expected, epsilon = 1e-9) => {
  assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} ≉ ${expected}`);
};

test('histórico persiste snapshots e limita preço a 0..1', () => {
  history.clearMarketHistory();
  const markets = [{ id: 'm1', outcomes: [{ name: 'Yes', price: 1.2 }, { name: 'No', price: -0.2 }] }];
  history.recordMarketSnapshots(markets, { timestamp: 100_000 });
  history.recordMarketSnapshots([{ id: 'm1', outcomes: [{ name: 'Yes', price: 0.7 }, { name: 'No', price: 0.3 }] }], { timestamp: 160_000 });

  const yes = history.getPriceHistory('m1', 'Yes');
  const no = history.getPriceHistory('m1', 'No');
  assert.equal(yes.length, 2);
  assert.equal(no.length, 2);
  closeTo(yes[0].price, 1);
  closeTo(no[0].price, 0);
  closeTo(yes[1].price, 0.7);
});

test('histórico coalesce pontos muito próximos para controlar localStorage', () => {
  history.clearMarketHistory();
  history.recordMarketSnapshots([{ id: 'm1', outcomes: [{ name: 'Yes', price: 0.4 }] }], { timestamp: 100_000 });
  history.recordMarketSnapshots([{ id: 'm1', outcomes: [{ name: 'Yes', price: 0.5 }] }], { timestamp: 110_000 });
  const points = history.getPriceHistory('m1', 'Yes');
  assert.equal(points.length, 1);
  closeTo(points[0].price, 0.5);
});

test('limite por posição reduz orçamento do Auto-Trader', () => {
  localStorage.clear();
  wallet.reset(1000);
  bot.clearLog();
  const config = bot.saveConfig({
    enabled: true,
    strategy: 'meanReversion',
    porTrade: 50,
    maxOpenPositions: 10,
    minPriceToBuy: 0.01,
    maxPriceToBuy: 0.75,
    profitTarget: 20,
    stopLoss: 25,
    intervalMs: 60_000,
    maxDailyLossPct: 5,
    maxMarketExposurePct: 10,
    maxPositionPct: 5,
    cooldownAfterLossMin: 0,
  });
  const markets = [{ id: 'm1', question: 'Teste', outcomes: [{ name: 'Yes', price: 0.1 }, { name: 'No', price: 0.9 }] }];
  const actions = bot._evaluateNewEntries(markets, config);
  assert.equal(actions[0].action, 'buy');
  const position = wallet.getPosition('m1', 'Yes');
  assert.ok(position);
  closeTo(position.shares * position.avgPrice, 50);
});

test('stop-loss alimenta perda diária e cooldown', () => {
  localStorage.clear();
  wallet.reset(1000);
  bot.clearLog();
  wallet.buy({ marketId: 'm1', marketQuestion: 'Teste', outcome: 'Yes', shares: 100, price: 0.5 });
  const config = bot.saveConfig({
    enabled: true,
    strategy: 'momentum',
    porTrade: 5,
    maxOpenPositions: 10,
    minPriceToBuy: 0.01,
    maxPriceToBuy: 0.75,
    profitTarget: 20,
    stopLoss: 10,
    intervalMs: 60_000,
    maxDailyLossPct: 0.5,
    maxMarketExposurePct: 15,
    maxPositionPct: 10,
    cooldownAfterLossMin: 10,
  });
  const markets = [{ id: 'm1', question: 'Teste', outcomes: [{ name: 'Yes', price: 0.4 }, { name: 'No', price: 0.6 }] }];
  const actions = bot._managePositions(markets, config);
  assert.equal(actions[0].action, 'sell');
  closeTo(actions[0].pnl, -10);

  const risk = bot.getRiskState(markets, config);
  assert.equal(risk.dailyLossBreached, true);
  assert.equal(risk.inCooldown, true);
  closeTo(risk.dailyRealizedPnl, -10);
});

test('limpar log visual não remove bloqueio de risco; reset da carteira remove', () => {
  localStorage.clear();
  wallet.reset(1000);
  bot.clearLog();
  wallet.buy({ marketId: 'm2', marketQuestion: 'Risco', outcome: 'Yes', shares: 100, price: 0.5 });
  const config = bot.saveConfig({
    enabled: true,
    strategy: 'momentum',
    porTrade: 5,
    maxOpenPositions: 10,
    minPriceToBuy: 0.01,
    maxPriceToBuy: 0.75,
    profitTarget: 20,
    stopLoss: 10,
    intervalMs: 60_000,
    maxDailyLossPct: 0.5,
    maxMarketExposurePct: 15,
    maxPositionPct: 10,
    cooldownAfterLossMin: 10,
  });
  const markets = [{ id: 'm2', question: 'Risco', outcomes: [{ name: 'Yes', price: 0.4 }, { name: 'No', price: 0.6 }] }];
  bot._managePositions(markets, config);

  bot.clearLog();
  assert.equal(bot.getLog().length, 0);
  const protectedRisk = bot.getRiskState(markets, config);
  assert.equal(protectedRisk.dailyLossBreached, true);
  assert.equal(protectedRisk.inCooldown, true);
  closeTo(protectedRisk.dailyRealizedPnl, -10);

  wallet.reset(1000);
  bot.clearLog();
  const resetRisk = bot.getRiskState(markets, config);
  assert.equal(resetRisk.dailyLossBreached, false);
  assert.equal(resetRisk.inCooldown, false);
  closeTo(resetRisk.dailyRealizedPnl, 0);
});

test('parada de emergência desabilita o bot e registra evento', () => {
  localStorage.clear();
  bot.saveConfig({ enabled: true });
  const result = bot.emergencyStop('teste de emergência');
  assert.equal(result.stopped, true);
  assert.equal(bot.getConfig().enabled, false);
  assert.equal(bot.getLog(1)[0].action, 'risk-stop');
});
