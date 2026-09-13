import { test, expect } from '@playwright/test';

function currentEventsPayload() {
  return [{
    tags: [],
    markets: [{
      id: 'current-market',
      question: 'Mercado atual?',
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
    question: 'Mercado histórico para walk-forward?',
    outcomes: '["Yes","No"]',
    clobTokenIds: '["yes-token","no-token"]',
    startDate: new Date(now - 40 * 86400_000).toISOString(),
    endDate: new Date(now + 5 * 86400_000).toISOString(),
    closed: false,
  };
}

function historyPayload(isYes) {
  const nowSec = Math.floor(Date.now() / 1000);
  const start = nowSec - 96 * 3600;
  return {
    history: Array.from({ length: 96 }, (_, i) => {
      const yes = 0.10 + (i % 16) * 0.01;
      return { t: start + i * 3600, p: Number((isYes ? yes : 1 - yes).toFixed(4)) };
    }),
  };
}

test('walk-forward e stress de custos rodam no navegador', async ({ page }) => {
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
  await page.locator('button[data-tab="backtest"]').click();
  await expect(page.locator('#bt-advanced-panel')).toBeVisible();

  await page.locator('#bt-markets').fill('1');
  await page.locator('#bt-strategy').selectOption('meanReversion');
  await page.locator('#bt-wf-train').fill('50');
  await page.locator('#bt-wf-test').fill('20');
  await page.locator('#bt-wf-run').click();

  await expect(page.locator('#bt-advanced-progress')).toContainText('Walk-forward concluído');
  await expect(page.locator('#bt-wf-metrics .bt-metric-card')).toHaveCount(6);
  await expect(page.locator('#bt-wf-folds tbody tr')).toHaveCount(2);
  await expect(page.locator('#bt-wf-audit')).toContainText('Folds externos sem sobreposição');
  const canvas = await page.locator('#bt-wf-chart').evaluate(el => ({ width: el.width, height: el.height }));
  expect(canvas.width).toBeGreaterThan(0);
  expect(canvas.height).toBeGreaterThan(0);

  await page.locator('#bt-stress-run').click();
  await expect(page.locator('#bt-advanced-progress')).toContainText('Stress concluído');
  await expect(page.locator('#bt-stress-results')).toContainText('Stress de custos');
  await expect(page.locator('#bt-stress-results .bt-metric-card')).toHaveCount(4);
  await expect(page.locator('#bt-stress-results tbody tr')).toHaveCount(4);
});
