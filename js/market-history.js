// market-history.js — histórico persistente de preços e gráficos compactos

import { saveToStorage, loadFromStorage } from './utils.js';

const STORAGE_KEY = 'market_history';
const MAX_HISTORY_PER_OUTCOME = 240;
const MAX_MARKETS = 60;
const MIN_POINT_INTERVAL_MS = 30_000;

function safeHistory() {
  const hist = loadFromStorage(STORAGE_KEY, {});
  return hist && typeof hist === 'object' && !Array.isArray(hist) ? hist : {};
}

function cleanPoint(point) {
  const timestamp = Number(point?.timestamp);
  const price = Number(point?.price);
  if (!Number.isFinite(timestamp) || !Number.isFinite(price)) return null;
  return { timestamp, price: Math.max(0, Math.min(1, price)) };
}

export function getMarketHistory() {
  const hist = safeHistory();
  const normalized = {};
  for (const [key, points] of Object.entries(hist)) {
    if (!Array.isArray(points)) continue;
    const cleaned = points.map(cleanPoint).filter(Boolean).slice(-MAX_HISTORY_PER_OUTCOME);
    if (cleaned.length) normalized[key] = cleaned;
  }
  return normalized;
}

export function getPriceHistory(marketId, outcome) {
  const hist = getMarketHistory();
  return hist[`${String(marketId)}|${String(outcome)}`] || [];
}

function pruneMarkets(hist) {
  const latestByMarket = new Map();
  for (const [key, points] of Object.entries(hist)) {
    if (!Array.isArray(points) || !points.length) continue;
    const separator = key.indexOf('|');
    const marketId = separator >= 0 ? key.slice(0, separator) : key;
    const latest = Number(points.at(-1)?.timestamp) || 0;
    latestByMarket.set(marketId, Math.max(latestByMarket.get(marketId) || 0, latest));
  }

  if (latestByMarket.size <= MAX_MARKETS) return hist;
  const keep = new Set(
    [...latestByMarket.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_MARKETS)
      .map(([marketId]) => marketId)
  );

  for (const key of Object.keys(hist)) {
    const separator = key.indexOf('|');
    const marketId = separator >= 0 ? key.slice(0, separator) : key;
    if (!keep.has(marketId)) delete hist[key];
  }
  return hist;
}

export function recordMarketSnapshots(markets, { limit = 50, timestamp = Date.now() } = {}) {
  if (!Array.isArray(markets) || markets.length === 0) return 0;
  const safeTimestamp = Number.isFinite(Number(timestamp)) ? Number(timestamp) : Date.now();
  const hist = getMarketHistory();
  let recorded = 0;

  for (const market of markets.slice(0, Math.max(1, limit))) {
    if (market?.id === undefined || !Array.isArray(market.outcomes)) continue;
    for (const outcome of market.outcomes) {
      const price = Number(outcome?.price);
      if (!outcome?.name || !Number.isFinite(price)) continue;
      const key = `${String(market.id)}|${String(outcome.name)}`;
      const points = Array.isArray(hist[key]) ? hist[key] : [];
      const next = { timestamp: safeTimestamp, price: Math.max(0, Math.min(1, price)) };
      const last = points.at(-1);

      if (last && safeTimestamp - Number(last.timestamp) < MIN_POINT_INTERVAL_MS) {
        points[points.length - 1] = next;
      } else {
        points.push(next);
      }

      hist[key] = points.slice(-MAX_HISTORY_PER_OUTCOME);
      recorded++;
    }
  }

  pruneMarkets(hist);
  saveToStorage(STORAGE_KEY, hist);
  return recorded;
}

export function clearMarketHistory() {
  saveToStorage(STORAGE_KEY, {});
}

export function getOutcomeChange(marketId, outcome, lookbackPoints = 10) {
  const points = getPriceHistory(marketId, outcome);
  if (points.length < 2) return 0;
  const end = points.at(-1).price;
  const start = points[Math.max(0, points.length - Math.max(2, lookbackPoints))].price;
  return end - start;
}

function drawLine(ctx, points, width, height, strokeStyle) {
  if (!points.length) return;
  ctx.strokeStyle = strokeStyle;
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = points.length === 1 ? width / 2 : (index / (points.length - 1)) * width;
    const y = height - Math.max(0, Math.min(1, point.price)) * height;
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();
}

export function drawMarketSparkline(canvas, marketId) {
  if (!canvas?.getContext) return;
  const yes = getPriceHistory(marketId, 'Yes').slice(-60);
  const no = getPriceHistory(marketId, 'No').slice(-60);
  const dpr = globalThis.window?.devicePixelRatio || 1;
  const width = canvas.clientWidth || 280;
  const height = canvas.clientHeight || 64;
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(height * dpr));
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  ctx.strokeStyle = 'rgba(139,145,158,0.16)';
  ctx.lineWidth = 1;
  for (const ratio of [0.25, 0.5, 0.75]) {
    const y = height * ratio;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }

  drawLine(ctx, yes, width, height, '#22c55e');
  drawLine(ctx, no, width, height, '#ef4444');
}
