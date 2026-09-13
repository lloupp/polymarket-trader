import { test, expect } from '@playwright/test';

function gammaPayload(yesPrice) {
  const noPrice = (1 - yesPrice).toFixed(2);
  return [{
    tags: [],
    markets: [{
      id: 'e2e-market',
      question: 'Mercado determinístico para E2E?',
      outcomes: '["Yes","No"]',
      outcomePrices: `["${yesPrice.toFixed(2)}","${noPrice}"]`,
      active: true,
      closed: false,
      volume: '10000',
      liquidity: '2500',
    }],
  }];
}

test('compra, venda, refresh, histórico e parada de emergência', async ({ page }) => {
  let apiCalls = 0;
  await page.addInitScript(() => localStorage.clear());
  await page.route('https://gamma-api.polymarket.com/**', async route => {
    apiCalls++;
    const yesPrice = apiCalls === 1 ? 0.40 : 0.65;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(gammaPayload(yesPrice)),
    });
  });

  await page.goto('/');
  const card = page.locator('.market-card').first();
  await expect(card).toBeVisible();
  await expect(card.locator('.outcome-btn.yes .outcome-price')).toHaveText('40.0¢');

  const canvas = card.locator('.market-sparkline');
  await expect(canvas).toBeVisible();
  const canvasSize = await canvas.evaluate(el => ({ width: el.width, height: el.height }));
  expect(canvasSize.width).toBeGreaterThan(0);
  expect(canvasSize.height).toBeGreaterThan(0);
  const storedHistory = await page.evaluate(() => JSON.parse(localStorage.getItem('pm_market_history') || '{}'));
  expect(Object.keys(storedHistory).some(key => key.startsWith('e2e-market|'))).toBeTruthy();

  await card.locator('.outcome-btn.yes').click();
  await expect(page.locator('#modal-buy')).toBeVisible();
  await page.locator('#buy-shares-input').fill('10');
  await page.locator('#buy-confirm').click();
  await expect(page.locator('#header-balance')).toHaveText('$996.00');

  await page.locator('button[data-tab="portfolio"]').click();
  await expect(page.locator('#positions-list .position-card')).toHaveCount(1);
  await page.locator('.position-sell-btn').click();
  await expect(page.locator('#modal-sell')).toBeVisible();
  await page.locator('#sell-confirm').click();
  await expect(page.locator('#header-balance')).toHaveText('$1,000.00');

  await page.locator('button[data-tab="markets"]').click();
  await page.locator('#btn-refresh-prices').click();
  await expect(card.locator('.outcome-btn.yes .outcome-price')).toHaveText('65.0¢');

  await page.locator('button[data-tab="bot"]').click();
  await expect(page.locator('#bot-max-daily-loss')).toBeVisible();
  await expect(page.locator('#bot-max-market-exposure')).toBeVisible();
  await expect(page.locator('#btn-bot-emergency')).toBeVisible();
  await page.locator('#bot-max-position').fill('7');
  await page.locator('#btn-bot-save-config').click();
  const savedConfig = await page.evaluate(() => JSON.parse(localStorage.getItem('pm_bot_config') || '{}'));
  expect(savedConfig.maxPositionPct).toBe(7);

  await page.locator('#btn-bot-toggle').click();
  await expect(page.locator('#bot-status-text')).toHaveText('Rodando...');
  await page.locator('#btn-bot-emergency').click();
  await expect(page.locator('#bot-status-text')).toHaveText('Desligado');
  await expect(page.locator('#bot-log-container')).toContainText('Parada de emergência');
});
