import { test, expect } from '@playwright/test';

function currentEventsPayload() {
  return [{
    tags: [],
    markets: [{
      id: 'current-market',
      question: 'Mercado atual para carregar a aplicação?',
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.40","0.60"]',
      active: true,
      closed: false,
      volume: '10000',
      liquidity: '2500',
    }],
  }];
}

function historicalMarket() {
  const now = Date.now();
  return {
    id: 'hist-market',
    question: 'Mercado histórico determinístico?',
    outcomes: '["Yes","No"]',
    clobTokenIds: '["yes-token","no-token"]',
    startDate: new Date(now - 25 * 86400_000).toISOString(),
    endDate: new Date(now + 5 * 86400_000).toISOString(),
    closed: false,
  };
}

function historyPayload(isYes) {
  const nowSec = Math.floor(Date.now() / 1000);
  const start = nowSec - 60 * 3600;
  const history = Array.from({ length: 60 }, (_, i) => {
    const yes = 0.12 + (i % 12) * 0.012;
    return { t: start + i * 3600, p: Number((isYes ? yes : 1 - yes).toFixed(4)) };
  });
  return { history };
}

test('backtest rigoroso roda OOS e compara estratégias no navegador', async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());

  await page.route('https://gamma-api.polymarket.com/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/events') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(currentEventsPayload()) });
    }
    if (url.pathname === '/markets') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([historicalMarket()]) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });

  await page.route('https://clob.polymarket.com/prices-history**', async route => {
    const url = new URL(route.request().url());
    const token = url.searchParams.get('market');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(historyPayload(token === 'yes-token')),
    });
  });

  await page.goto('/');
  await expect(page.locator('.market-card').first()).toBeVisible();
  await expect(page.locator('button[data-tab="backtest"]')).toBeVisible();
  await page.locator('button[data-tab="backtest"]').click();
  await expect(page.locator('#tab-backtest')).toHaveClass(/active/);

  await page.locator('#bt-markets').fill('1');
  await page.locator('#bt-strategy').selectOption('meanReversion');
  await page.locator('#bt-fee').fill('5');
  await page.locator('#bt-slippage').fill('25');
  await page.locator('#bt-run').click();

  await expect(page.locator('#bt-results')).toBeVisible();
  await expect(page.locator('#bt-progress')).toContainText('Concluído');
  await expect(page.locator('#bt-meta')).toContainText('validação');
  await expect(page.locator('#bt-audit')).toContainText('Execução atrasada em 1 barra');
  await expect(page.locator('#bt-metrics .bt-metric-card')).toHaveCount(10);
  const canvasSize = await page.locator('#bt-equity-chart').evaluate(el => ({ width: el.width, height: el.height }));
  expect(canvasSize.width).toBeGreaterThan(0);
  expect(canvasSize.height).toBeGreaterThan(0);

  await page.locator('#bt-compare').click();
  await expect(page.locator('#bt-comparison tbody tr')).toHaveCount(6);
  await expect(page.locator('#bt-comparison')).toContainText('Comparação fora da amostra');
});
