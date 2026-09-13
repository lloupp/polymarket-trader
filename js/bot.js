// bot.js — Auto-Trader de simulação com estratégias e guardrails de risco

import { saveToStorage, loadFromStorage } from './utils.js';
import { getWallet, buy as walletBuy, sell as walletSell, getPositions, getPosition } from './wallet.js';
import { computePositionMetrics, computePortfolioSummary } from './portfolio.js';
import {
  getMarketHistory,
  getPriceHistory,
  clearMarketHistory,
  recordMarketSnapshots,
} from './market-history.js';

const BOT_CONFIG_KEY = 'bot_config';
const BOT_LOG_KEY = 'bot_log';
const MAX_LOG_ENTRIES = 500;
const STRATEGIES = new Set(['momentum', 'meanReversion', 'bargainHunting', 'valueBetting', 'kelly', 'random']);

const DEFAULT_CONFIG = {
  enabled: false,
  strategy: 'momentum',
  porTrade: 5,
  maxOpenPositions: 10,
  minPriceToBuy: 0.05,
  maxPriceToBuy: 0.75,
  profitTarget: 20,
  stopLoss: 25,
  intervalMs: 60_000,
  maxDailyLossPct: 5,
  maxMarketExposurePct: 15,
  maxPositionPct: 10,
  cooldownAfterLossMin: 10,
};

let _intervalHandle = null;
let _tickCount = 0;
let _onTickCallback = null;
let _onActionCallback = null;

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
};

function normalizeConfig(config = {}) {
  const merged = { ...DEFAULT_CONFIG, ...(config && typeof config === 'object' ? config : {}) };
  let minPrice = clamp(merged.minPriceToBuy, 0.01, 0.99, DEFAULT_CONFIG.minPriceToBuy);
  let maxPrice = clamp(merged.maxPriceToBuy, 0.01, 1, DEFAULT_CONFIG.maxPriceToBuy);
  if (minPrice > maxPrice) [minPrice, maxPrice] = [maxPrice, minPrice];
  return {
    enabled: Boolean(merged.enabled),
    strategy: STRATEGIES.has(merged.strategy) ? merged.strategy : DEFAULT_CONFIG.strategy,
    porTrade: clamp(merged.porTrade, 1, 50, DEFAULT_CONFIG.porTrade),
    maxOpenPositions: Math.round(clamp(merged.maxOpenPositions, 1, 50, DEFAULT_CONFIG.maxOpenPositions)),
    minPriceToBuy: minPrice,
    maxPriceToBuy: maxPrice,
    profitTarget: clamp(merged.profitTarget, 1, 200, DEFAULT_CONFIG.profitTarget),
    stopLoss: clamp(merged.stopLoss, 1, 100, DEFAULT_CONFIG.stopLoss),
    intervalMs: Math.round(clamp(merged.intervalMs, 10_000, 3_600_000, DEFAULT_CONFIG.intervalMs)),
    maxDailyLossPct: clamp(merged.maxDailyLossPct, 0.5, 50, DEFAULT_CONFIG.maxDailyLossPct),
    maxMarketExposurePct: clamp(merged.maxMarketExposurePct, 1, 100, DEFAULT_CONFIG.maxMarketExposurePct),
    maxPositionPct: clamp(merged.maxPositionPct, 1, 100, DEFAULT_CONFIG.maxPositionPct),
    cooldownAfterLossMin: clamp(merged.cooldownAfterLossMin, 0, 1_440, DEFAULT_CONFIG.cooldownAfterLossMin),
  };
}

export function getConfig() {
  return normalizeConfig(loadFromStorage(BOT_CONFIG_KEY, { ...DEFAULT_CONFIG }));
}

export function saveConfig(config) {
  const normalized = normalizeConfig(config);
  saveToStorage(BOT_CONFIG_KEY, normalized);
  return normalized;
}

export function updateConfig(partial) {
  return saveConfig({ ...getConfig(), ...(partial || {}) });
}

export function resetConfig() {
  return saveConfig({ ...DEFAULT_CONFIG });
}

export function getLog(limit = 50) {
  const log = loadFromStorage(BOT_LOG_KEY, []);
  return Array.isArray(log) ? log.slice(0, Math.max(0, limit)) : [];
}

function addLogEntry(entry) {
  const current = loadFromStorage(BOT_LOG_KEY, []);
  const log = Array.isArray(current) ? current : [];
  log.unshift({ timestamp: new Date().toISOString(), ...entry });
  if (log.length > MAX_LOG_ENTRIES) log.length = MAX_LOG_ENTRIES;
  saveToStorage(BOT_LOG_KEY, log);
}

export function clearLog() {
  saveToStorage(BOT_LOG_KEY, []);
}

function eligibleOutcomes(markets, config) {
  const list = [];
  for (const market of Array.isArray(markets) ? markets : []) {
    for (const outcome of Array.isArray(market?.outcomes) ? market.outcomes : []) {
      const price = Number(outcome?.price);
      if (!outcome?.name || !Number.isFinite(price)) continue;
      if (price < config.minPriceToBuy || price > config.maxPriceToBuy) continue;
      list.push({ market, outcome: { ...outcome, price } });
    }
  }
  return list;
}

function strategyMomentum(markets, config) {
  const candidates = [];
  for (const { market, outcome } of eligibleOutcomes(markets, config)) {
    const history = getPriceHistory(market.id, outcome.name);
    if (history.length < 3) continue;
    const previous = Number(history.at(-3)?.price);
    const change = outcome.price - previous;
    if (Number.isFinite(change) && change >= 0.02) {
      candidates.push({
        marketId: market.id,
        marketQuestion: market.question,
        outcome: outcome.name,
        price: outcome.price,
        score: change,
        reason: `Momentum: ${outcome.name} subiu ${(change * 100).toFixed(1)}¢ nos últimos pontos`,
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function strategyMeanReversion(markets, config) {
  const candidates = eligibleOutcomes(markets, config)
    .filter(({ outcome }) => outcome.price <= Math.min(0.25, config.maxPriceToBuy))
    .map(({ market, outcome }) => ({
      marketId: market.id,
      marketQuestion: market.question,
      outcome: outcome.name,
      price: outcome.price,
      score: 0.25 - outcome.price,
      reason: `Reversão à média: ${outcome.name} a ${(outcome.price * 100).toFixed(1)}¢`,
    }));
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function strategyBargainHunting(markets, config) {
  const owned = new Set(getPositions().map(p => `${p.marketId}|${p.outcome}`));
  const candidates = eligibleOutcomes(markets, config)
    .filter(({ market, outcome }) => outcome.price <= Math.min(0.15, config.maxPriceToBuy) && !owned.has(`${market.id}|${outcome.name}`))
    .map(({ market, outcome }) => ({
      marketId: market.id,
      marketQuestion: market.question,
      outcome: outcome.name,
      price: outcome.price,
      score: 0.15 - outcome.price,
      reason: `Comprar barato: ${outcome.name} a ${(outcome.price * 100).toFixed(1)}¢`,
    }));
  candidates.sort((a, b) => b.score - a.score);
  const top = candidates.slice(0, 3);
  return top.length ? top[Math.floor(Math.random() * top.length)] : null;
}

function estimatedProbability(marketId, outcome) {
  const recent = getPriceHistory(marketId, outcome).slice(-5).map(p => Number(p.price)).filter(Number.isFinite);
  if (recent.length < 5) return null;
  return recent.reduce((sum, price) => sum + price, 0) / recent.length;
}

function strategyValueBetting(markets, config) {
  const candidates = [];
  for (const { market, outcome } of eligibleOutcomes(markets, config)) {
    const fairProb = estimatedProbability(market.id, outcome.name);
    if (fairProb == null || outcome.price <= 0) continue;
    const evPercent = ((fairProb - outcome.price) / outcome.price) * 100;
    if (evPercent > 5) {
      candidates.push({
        marketId: market.id,
        marketQuestion: market.question,
        outcome: outcome.name,
        price: outcome.price,
        score: evPercent,
        reason: `Value Bet: EV +${evPercent.toFixed(1)}% (estimativa ${(fairProb * 100).toFixed(1)}¢)`,
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function strategyKelly(markets, config) {
  const candidates = [];
  for (const { market, outcome } of eligibleOutcomes(markets, config)) {
    const p = estimatedProbability(market.id, outcome.name);
    const price = outcome.price;
    if (p == null || price <= 0 || price >= 1) continue;
    const q = 1 - p;
    const b = (1 - price) / price;
    const fullKelly = (p * b - q) / b;
    const halfKelly = fullKelly / 2;
    if (halfKelly > 0.01) {
      candidates.push({
        marketId: market.id,
        marketQuestion: market.question,
        outcome: outcome.name,
        price,
        score: halfKelly,
        kellyFraction: halfKelly,
        reason: `Kelly: ½-Kelly ${(halfKelly * 100).toFixed(1)}%`,
      });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0] || null;
}

function strategyRandom(markets, config) {
  const positions = getPositions();
  if (positions.length && Math.random() < 0.4) {
    const pos = positions[Math.floor(Math.random() * positions.length)];
    const market = (markets || []).find(m => String(m.id) === String(pos.marketId));
    const outcome = market?.outcomes?.find(o => o.name === pos.outcome);
    const price = Number.isFinite(Number(outcome?.price)) ? Number(outcome.price) : Number(pos.avgPrice);
    return {
      action: 'sell',
      marketId: pos.marketId,
      marketQuestion: pos.marketQuestion,
      outcome: pos.outcome,
      price,
      shares: pos.shares,
      reason: `Aleatório: venda de ${pos.outcome}`,
    };
  }
  const candidates = eligibleOutcomes(markets, config);
  if (!candidates.length) return null;
  const { market, outcome } = candidates[Math.floor(Math.random() * candidates.length)];
  return {
    action: 'buy',
    marketId: market.id,
    marketQuestion: market.question,
    outcome: outcome.name,
    price: outcome.price,
    reason: `Aleatório: compra de ${outcome.name}`,
  };
}

function selectStrategy(markets, config) {
  switch (config.strategy) {
    case 'meanReversion': return strategyMeanReversion(markets, config);
    case 'bargainHunting': return strategyBargainHunting(markets, config);
    case 'valueBetting': return strategyValueBetting(markets, config);
    case 'kelly': return strategyKelly(markets, config);
    case 'random': return strategyRandom(markets, config);
    case 'momentum':
    default: return strategyMomentum(markets, config);
  }
}

function sumExposure(positions, markets, predicate) {
  return positions.filter(predicate).reduce((sum, position) => {
    const metrics = computePositionMetrics(position, markets);
    return sum + (Number.isFinite(Number(metrics.marketValue)) ? Math.max(0, Number(metrics.marketValue)) : 0);
  }, 0);
}

export function getRiskState(markets, config = getConfig(), now = Date.now()) {
  const normalized = normalizeConfig(config);
  const wallet = getWallet();
  const log = getLog(MAX_LOG_ENTRIES);
  const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const dayStart = new Date(nowMs);
  dayStart.setHours(0, 0, 0, 0);
  const dayStartMs = dayStart.getTime();
  const dailyRealizedPnl = log.reduce((sum, entry) => {
    const ts = Date.parse(entry?.timestamp);
    const pnl = Number(entry?.pnl);
    return entry?.action === 'sell' && Number.isFinite(ts) && ts >= dayStartMs && Number.isFinite(pnl) ? sum + pnl : sum;
  }, 0);
  const dailyLossLimit = Math.max(0, Number(wallet.initialBalance) || 0) * normalized.maxDailyLossPct / 100;
  const dailyLossBreached = dailyLossLimit > 0 && dailyRealizedPnl <= -dailyLossLimit;

  const lastLoss = log.find(entry => entry?.action === 'sell' && Number(entry?.pnl) < 0 && Number.isFinite(Date.parse(entry?.timestamp)));
  const lastLossAt = lastLoss ? Date.parse(lastLoss.timestamp) : null;
  const cooldownMs = normalized.cooldownAfterLossMin * 60_000;
  const cooldownUntil = lastLossAt == null ? null : lastLossAt + cooldownMs;
  const cooldownRemainingMs = cooldownUntil && cooldownUntil > nowMs ? cooldownUntil - nowMs : 0;
  const summary = computePortfolioSummary(Array.isArray(markets) ? markets : []);

  return {
    dailyRealizedPnl,
    dailyLossLimit,
    dailyLossBreached,
    lastLossAt,
    cooldownUntil,
    cooldownRemainingMs,
    inCooldown: cooldownRemainingMs > 0,
    equity: Number(summary.totalEquity) || 0,
  };
}

function managePositions(markets, config) {
  const actions = [];
  for (const pos of [...getPositions()]) {
    const market = (markets || []).find(m => String(m.id) === String(pos.marketId));
    const outcome = market?.outcomes?.find(o => o.name === pos.outcome);
    if (!outcome || !Number.isFinite(Number(outcome.price))) continue;
    const price = Number(outcome.price);
    const metrics = computePositionMetrics(pos, markets);
    const pnlPercent = Number(metrics.pnlPercent) || 0;
    let reason = null;
    if (pnlPercent >= config.profitTarget) reason = `Take-profit: ${pnlPercent.toFixed(1)}% ≥ ${config.profitTarget}%`;
    else if (pnlPercent <= -config.stopLoss) reason = `Stop-loss: ${pnlPercent.toFixed(1)}% ≤ -${config.stopLoss}%`;
    if (!reason) continue;

    const result = walletSell({ marketId: pos.marketId, outcome: pos.outcome, shares: pos.shares, price });
    if (!result.success) {
      actions.push({ action: 'error', reason: result.message });
      continue;
    }
    const action = {
      action: 'sell',
      marketId: pos.marketId,
      marketQuestion: pos.marketQuestion,
      outcome: pos.outcome,
      shares: pos.shares,
      price,
      pnl: Number(metrics.pnl) || 0,
      reason: `${reason} — vendeu ${pos.shares} shares`,
    };
    actions.push(action);
    addLogEntry(action);
  }
  return actions;
}

function evaluateNewEntries(markets, config) {
  const actions = [];
  const positions = getPositions();
  const wallet = getWallet();
  const risk = getRiskState(markets, config);

  if (risk.dailyLossBreached) {
    return [{ action: 'skip', reason: `Limite diário de perda atingido (${risk.dailyRealizedPnl.toFixed(2)})` }];
  }
  if (risk.inCooldown) {
    const minutes = Math.max(1, Math.ceil(risk.cooldownRemainingMs / 60_000));
    return [{ action: 'skip', reason: `Cooldown após perda ativo por mais ${minutes} min` }];
  }
  if (positions.length >= config.maxOpenPositions) {
    return [{ action: 'skip', reason: `Máximo de ${config.maxOpenPositions} posições abertas atingido` }];
  }
  if (!Number.isFinite(Number(wallet.balance)) || wallet.balance <= 0) {
    return [{ action: 'skip', reason: 'Saldo insuficiente' }];
  }

  const pick = selectStrategy(markets, config);
  if (!pick) return [{ action: 'skip', reason: `Estratégia "${config.strategy}" não encontrou oportunidades` }];

  if (pick.action === 'sell') {
    const existing = getPosition(pick.marketId, pick.outcome);
    const pnl = existing ? (Number(pick.price) - Number(existing.avgPrice)) * Number(pick.shares) : 0;
    const result = walletSell({ marketId: pick.marketId, outcome: pick.outcome, shares: pick.shares, price: pick.price });
    if (!result.success) return [{ action: 'error', reason: result.message }];
    const action = { ...pick, action: 'sell', pnl: Number.isFinite(pnl) ? pnl : 0 };
    actions.push(action);
    addLogEntry(action);
    return actions;
  }

  const price = Number(pick.price);
  if (!Number.isFinite(price) || price <= 0 || price > 1) return [{ action: 'skip', reason: `Preço inválido: ${pick.price}` }];

  let effectiveBudget = wallet.balance * config.porTrade / 100;
  if (config.strategy === 'kelly' && Number(pick.kellyFraction) > 0) {
    const halfKellyBudget = wallet.balance * Math.min(Number(pick.kellyFraction), 0.25);
    effectiveBudget = Math.max(effectiveBudget * 0.5, halfKellyBudget);
  }

  const equity = Math.max(0, risk.equity);
  const marketExposure = sumExposure(positions, markets, p => String(p.marketId) === String(pick.marketId));
  const positionExposure = sumExposure(positions, markets, p => String(p.marketId) === String(pick.marketId) && p.outcome === pick.outcome);
  const marketRoom = Math.max(0, equity * config.maxMarketExposurePct / 100 - marketExposure);
  const positionRoom = Math.max(0, equity * config.maxPositionPct / 100 - positionExposure);
  effectiveBudget = Math.min(effectiveBudget, marketRoom, positionRoom, wallet.balance);

  if (effectiveBudget < price) {
    return [{ action: 'skip', reason: 'Limite de exposição/posição impede nova entrada' }];
  }

  const shares = Math.floor(effectiveBudget / price);
  if (shares < 1) return [{ action: 'skip', reason: 'Orçamento insuficiente para comprar 1 share' }];
  const result = walletBuy({
    marketId: pick.marketId,
    marketQuestion: pick.marketQuestion,
    outcome: pick.outcome,
    shares,
    price,
  });
  if (!result.success) return [{ action: 'error', reason: result.message }];

  const action = {
    action: 'buy',
    marketId: pick.marketId,
    marketQuestion: pick.marketQuestion,
    outcome: pick.outcome,
    shares,
    price,
    reason: pick.reason || `Comprou ${shares} shares de ${pick.outcome}`,
  };
  actions.push(action);
  addLogEntry(action);
  return actions;
}

export function tick(markets) {
  _tickCount++;
  const config = getConfig();
  if (!config.enabled) return { tick: _tickCount, actions: [], summary: 'Bot desligado' };
  if (!Array.isArray(markets) || markets.length === 0) return { tick: _tickCount, actions: [], summary: 'Sem mercados carregados' };

  recordMarketSnapshots(markets, { limit: 50 });
  const allActions = [...managePositions(markets, config), ...evaluateNewEntries(markets, config)];
  const realActions = allActions.filter(a => a.action !== 'skip' && a.action !== 'error');
  const skipActions = allActions.filter(a => a.action === 'skip');
  const summary = realActions.length
    ? `${realActions.length} ação(ões) executada(s)`
    : (skipActions[0]?.reason || 'Nenhuma ação');

  if (_onActionCallback && realActions.length) _onActionCallback(realActions);
  if (_onTickCallback) _onTickCallback({ tick: _tickCount, summary, actions: realActions });
  return { tick: _tickCount, actions: realActions, summary };
}

export function start(getMarketsFn, callbacks = {}) {
  const config = getConfig();
  if (_intervalHandle) stop();
  _onTickCallback = callbacks.onTick || null;
  _onActionCallback = callbacks.onAction || null;
  updateConfig({ enabled: true });
  tick(getMarketsFn());
  _intervalHandle = setInterval(() => {
    if (globalThis.document?.hidden) return;
    tick(getMarketsFn());
  }, config.intervalMs);
  return _intervalHandle;
}

export function stop() {
  if (_intervalHandle) clearInterval(_intervalHandle);
  _intervalHandle = null;
  updateConfig({ enabled: false });
  _onTickCallback = null;
  _onActionCallback = null;
}

export function emergencyStop(reason = 'Parada de emergência acionada') {
  addLogEntry({ action: 'risk-stop', reason });
  stop();
  return { stopped: true, reason };
}

export function isRunning() {
  return _intervalHandle !== null;
}

export function getTickCount() {
  return _tickCount;
}

export function resetTickCount() {
  _tickCount = 0;
}

export function getBotStats() {
  const log = getLog(MAX_LOG_ENTRIES);
  return {
    totalActions: log.length,
    totalBuys: log.filter(e => e.action === 'buy').length,
    totalSells: log.filter(e => e.action === 'sell').length,
    totalRiskStops: log.filter(e => e.action === 'risk-stop').length,
    lastAction: log[0] || null,
  };
}

export const _strategies = {
  momentum: strategyMomentum,
  meanReversion: strategyMeanReversion,
  bargainHunting: strategyBargainHunting,
  valueBetting: strategyValueBetting,
  kelly: strategyKelly,
  random: strategyRandom,
};

export const _managePositions = managePositions;
export const _evaluateNewEntries = evaluateNewEntries;
export { getMarketHistory, getPriceHistory, clearMarketHistory };
export { getConfig as getBotConfig };
export { saveConfig as setBotConfig };
export { updateConfig as updateBotConfig };
