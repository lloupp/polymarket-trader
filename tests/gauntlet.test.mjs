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

const wallet = await import('../js/wallet.js');
const portfolio = await import('../js/portfolio.js');
const api = await import('../js/api.js');

test('compra preserva equity quando preço não muda', () => {
  wallet.reset(1000);
  const result = wallet.buy({ marketId: 'm1', marketQuestion: 'Q?', outcome: 'Yes', shares: 100, price: 0.4 });
  assert.equal(result.success, true);
  const markets = [{ id: 'm1', outcomes: [{ name: 'Yes', price: 0.4 }] }];
  const summary = portfolio.computePortfolioSummary(markets);
  assert.equal(summary.balance, 960);
  assert.equal(summary.currentValue, 40);
  assert.equal(summary.totalEquity, 1000);
  assert.equal(summary.unrealizedPnl, 0);
});

test('P&L agregado reflete mark-to-market', () => {
  wallet.reset(1000);
  wallet.buy({ marketId: 'm1', marketQuestion: 'Q?', outcome: 'Yes', shares: 100, price: 0.4 });
  const markets = [{ id: 'm1', outcomes: [{ name: 'Yes', price: 0.55 }] }];
  const summary = portfolio.computePortfolioSummary(markets);
  assert.equal(summary.totalEquity, 1015);
  assert.equal(summary.unrealizedPnl, 15);
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
  assert.equal(original[0].outcomes[0].price, 0.4);
  assert.equal(await api.refreshPrices(), true);
  assert.equal(original[0].outcomes[0].price, 0.65);
});
