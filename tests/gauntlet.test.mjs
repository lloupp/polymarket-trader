import test from 'node:test';
import assert from 'node:assert/strict';

class MemoryStorage {
  constructor() { this.map = new Map(); }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

globalThis.localStorage = new MemoryStorage();
const closeTo = (actual, expected, epsilon = 1e-9) => assert.ok(Math.abs(actual - expected) <= epsilon, `${actual} ≉ ${expected}`);

const wallet = await import('../js/wallet.js');
const portfolio = await import('../js/portfolio.js');
const api = await import('../js/api.js');
const trades = await import('../js/trades.js');

test('compra preserva equity quando preço não muda', () => {
  wallet.reset(1000);
  const result = wallet.buy({ marketId: 'm1', marketQuestion: 'Q?', outcome: 'Yes', shares: 100, price: 0.4 });
  assert.equal(result.success, true);
  const markets = [{ id: 'm1', outcomes: [{ name: 'Yes', price: 0.4 }] }];
  const summary = portfolio.computePortfolioSummary(markets);
  closeTo(summary.balance, 960);
  closeTo(summary.currentValue, 40);
  closeTo(summary.totalEquity, 1000);
  closeTo(summary.unrealizedPnl, 0);
});

test('P&L agregado reflete mark-to-market', () => {
  wallet.reset(1000);
  wallet.buy({ marketId: 'm1', marketQuestion: 'Q?', outcome: 'Yes', shares: 100, price: 0.4 });
  const markets = [{ id: 'm1', outcomes: [{ name: 'Yes', price: 0.55 }] }];
  const summary = portfolio.computePortfolioSummary(markets);
  closeTo(summary.totalEquity, 1015);
  closeTo(summary.unrealizedPnl, 15);
});

test('wallet rejeita quantidades e preços não finitos', () => {
  wallet.reset(1000);
  assert.equal(wallet.buy({ marketId: 'm1', outcome: 'Yes', shares: Infinity, price: 0.4 }).success, false);
  assert.equal(wallet.buy({ marketId: 'm1', outcome: 'Yes', shares: 2, price: Infinity }).success, false);
  assert.equal(wallet.sell({ marketId: 'm1', outcome: 'Yes', shares: NaN, price: 0.4 }).success, false);
});

test('wallet normaliza storage corrompido', () => {
  localStorage.setItem('pm_wallet', JSON.stringify({ balance: 'oops', positions: {}, trades: null }));
  const normalized = wallet.getWallet();
  assert.equal(normalized.balance, 1000);
  assert.equal(normalized.initialBalance, 1000);
  assert.deepEqual(normalized.positions, []);
  assert.deepEqual(normalized.trades, []);
});

test('mapMarket aceita id zero e limita preços ao intervalo 0..1', () => {
  const mapped = api._internal.mapMarket({
    id: 0,
    question: 'Teste',
    outcomes: '["Yes","No"]',
    outcomePrices: '["1.2","-0.2"]',
    active: true,
    closed: false,
    volume: '-10',
    liquidity: '-20'
  }, { tags: [] });
  assert.equal(mapped.id, '0');
  assert.equal(mapped.outcomes[0].price, 1);
  assert.equal(mapped.outcomes[1].price, 0);
  assert.equal(mapped.volume, 0);
  assert.equal(mapped.liquidity, 0);
});

test('refreshPrices preserva a referência entregue à aplicação', async () => {
  api.clearCache();
  let call = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/events')) {
      call++;
      const yes = call === 1 ? '0.40' : '0.65';
      return {
        ok: true,
        async json() {
          return [{
            tags: [],
            markets: [{
              id: 'm1', question: 'Q?', outcomes: '["Yes","No"]',
              outcomePrices: `["${yes}","${(1 - Number(yes)).toFixed(2)}"]`,
              active: true, closed: false, volume: '100', liquidity: '50'
            }]
          }];
        }
      };
    }
    throw new Error(`fetch inesperado: ${url}`);
  };

  const original = await api.fetchMarkets({ force: true });
  closeTo(original[0].outcomes[0].price, 0.4);
  assert.equal(await api.refreshPrices(), true);
  closeTo(original[0].outcomes[0].price, 0.65);
});

test('estatísticas usam custo médio em vendas parciais', () => {
  const history = [
    { marketId: 'm1', outcome: 'Yes', side: 'buy', shares: 10, price: 0.4, totalCost: 4, timestamp: '2026-01-01T00:00:00Z' },
    { marketId: 'm1', outcome: 'Yes', side: 'buy', shares: 10, price: 0.6, totalCost: 6, timestamp: '2026-01-01T00:01:00Z' },
    { marketId: 'm1', outcome: 'Yes', side: 'sell', shares: 10, price: 0.7, totalCost: 7, timestamp: '2026-01-01T00:02:00Z' }
  ];
  const stats = trades.computeStats(history);
  closeTo(stats.totalPnL, 2);
  closeTo(stats.winRate, 100);
});

test('equity curve reduz custo-base, não receita de venda', () => {
  const history = [
    { marketId: 'm1', outcome: 'Yes', side: 'buy', shares: 10, price: 0.5, totalCost: 5, timestamp: '2026-01-01T00:00:00Z' },
    { marketId: 'm1', outcome: 'Yes', side: 'sell', shares: 5, price: 0.8, totalCost: 4, timestamp: '2026-01-01T00:01:00Z' }
  ];
  const curve = trades.buildEquityCurve(history, 1000);
  closeTo(curve.at(-1).equity, 1001.5);
});

test('tabela de trades escapa atributos HTML', () => {
  const html = trades.renderTradesTable([{
    timestamp: '2026-01-01T00:00:00Z', side: 'buy', marketQuestion: '"><img src=x onerror=alert(1)>',
    outcome: 'Yes', shares: 1, price: 0.5, totalCost: 0.5
  }]);
  assert.equal(html.includes('<img src=x'), false);
  assert.equal(html.includes('&quot;&gt;&lt;img'), true);
});
