// bot.js — Motor de Negociação Autônoma (Auto-Trader)
// Fase 9: bot que negocia sozinho na carteira fictícia via setInterval.
// Estratégias: momentum, reversão à média, comprar barato amplo, value betting
//              (EV), Kelly criterion (½-Kelly), aleatória.
// Gestão de posições: take-profit e stop-loss automáticos.
// Persistência: pm_bot_config (config), pm_bot_log (log de ações),
//                pm_market_history (histórico de preços para momentum/Kelly/EV).

import { saveToStorage, loadFromStorage } from './utils.js';
import { getWallet, buy as walletBuy, sell as walletSell, getPositions, getPosition } from './wallet.js';
import { computePositionMetrics, getCurrentPrice } from './portfolio.js';

// ===== Chaves de localStorage =====
const BOT_CONFIG_KEY = 'bot_config';
const BOT_LOG_KEY = 'bot_log';
const MARKET_HISTORY_KEY = 'market_history';
const MAX_LOG_ENTRIES = 500;
const MAX_HISTORY_PER_MARKET = 30;

// ===== Configuração padrão =====
const DEFAULT_CONFIG = {
  enabled: false,
  strategy: 'momentum',        // 'momentum' | 'meanReversion' | 'bargainHunting' | 'valueBetting' | 'kelly' | 'random'
  porTrade: 5,                 // % do saldo por operação
  maxOpenPositions: 10,
  minPriceToBuy: 0.05,
  maxPriceToBuy: 0.75,
  profitTarget: 20,            // % de lucro para vender (take-profit)
  stopLoss: 25,                // % de prejuízo para vender (stop-loss)
  intervalMs: 60_000,          // intervalo de avaliação (ms)
};

// ===== Estado do bot (não persistido) =====
let _intervalHandle = null;
let _tickCount = 0;
let _onTickCallback = null;    // callback para UI atualizar após cada tick
let _onActionCallback = null;  // callback para UI quando uma ação é executada

// ============================================================
//  CONFIG
// ============================================================

/**
 * Lê a config do bot do localStorage (ou cria com defaults).
 * @returns {Object} — config do bot
 */
export function getConfig() {
  return loadFromStorage(BOT_CONFIG_KEY, { ...DEFAULT_CONFIG });
}

/**
 * Salva a config do bot.
 * @param {Object} config — nova config
 */
export function saveConfig(config) {
  saveToStorage(BOT_CONFIG_KEY, config);
  return config;
}

/**
 * Atualiza campos específicos da config (merge).
 * @param {Object} partial — { campo: valor, ... }
 * @returns {Object} — config atualizada
 */
export function updateConfig(partial) {
  const current = getConfig();
  const merged = { ...current, ...partial };
  saveToStorage(BOT_CONFIG_KEY, merged);
  return merged;
}

/**
 * Reseta a config para os defaults.
 * @returns {Object}
 */
export function resetConfig() {
  return saveConfig({ ...DEFAULT_CONFIG });
}

// ============================================================
//  LOG
// ============================================================

/**
 * Lê o log de ações do bot (mais recente primeiro).
 * @param {number} limit — número máximo de entradas (default 50)
 * @returns {Array} — [{ timestamp, action, market, outcome, shares, price, note }]
 */
export function getLog(limit = 50) {
  const log = loadFromStorage(BOT_LOG_KEY, []);
  if (!Array.isArray(log)) return [];
  return log.slice(0, limit);
}

/**
 * Adiciona uma entrada ao log do bot.
 * @param {Object} entry — { action, market, outcome, shares, price, note }
 */
function addLogEntry(entry) {
  const log = loadFromStorage(BOT_LOG_KEY, []);
  if (!Array.isArray(log)) {
    // log corrompido — reinicia
    const fresh = [];
    fresh.push({ timestamp: new Date().toISOString(), ...entry });
    saveToStorage(BOT_LOG_KEY, fresh);
    return;
  }
  log.unshift({ timestamp: new Date().toISOString(), ...entry });
  // Trunca para evitar exceder quota
  if (log.length > MAX_LOG_ENTRIES) log.length = MAX_LOG_ENTRIES;
  saveToStorage(BOT_LOG_KEY, log);
}

/**
 * Limpa o log do bot.
 */
export function clearLog() {
  saveToStorage(BOT_LOG_KEY, []);
}

// ============================================================
//  HISTÓRICO DE PREÇOS (para estratégia momentum)
// ============================================================

/**
 * Lê o histórico de preços por mercado.
 * @returns {Object} — { marketId: [{ timestamp, price }, ...] }
 */
export function getMarketHistory() {
  const hist = loadFromStorage(MARKET_HISTORY_KEY, {});
  return (hist && typeof hist === 'object') ? hist : {};
}

/**
 * Registra o preço atual de um mercado no histórico.
 * Mantém no máximo MAX_HISTORY_PER_MARKET entradas por mercado.
 * @param {string} marketId
 * @param {string} outcome
 * @param {number} price
 */
function recordPrice(marketId, outcome, price) {
  const hist = getMarketHistory();
  const key = `${marketId}|${outcome}`;
  if (!Array.isArray(hist[key])) hist[key] = [];
  hist[key].push({ timestamp: Date.now(), price });
  if (hist[key].length > MAX_HISTORY_PER_MARKET) {
    hist[key] = hist[key].slice(-MAX_HISTORY_PER_MARKET);
  }
  saveToStorage(MARKET_HISTORY_KEY, hist);
}

/**
 * Obtém o histórico de preços de um mercado+outcome.
 * @param {string} marketId
 * @param {string} outcome
 * @returns {Array} — [{ timestamp, price }, ...]
 */
export function getPriceHistory(marketId, outcome) {
  const hist = getMarketHistory();
  return hist[`${marketId}|${outcome}`] || [];
}

/**
 * Limpa todo o histórico de preços.
 */
export function clearMarketHistory() {
  saveToStorage(MARKET_HISTORY_KEY, {});
}

// ============================================================
//  ESTRATÉGIAS
// ============================================================

/**
 * Estratégia Momentum: compra Yes quando o preço está subindo.
 * Analisa os últimos preços registrados e procura tendência de alta.
 *
 * @param {Array} markets — mercados disponíveis (state.markets)
 * @param {Object} config — config do bot
 * @returns {Object|null} — { marketId, outcome, price, reason } ou null
 */
function strategyMomentum(markets, config) {
  const candidates = [];

  for (const m of markets) {
    for (const o of m.outcomes) {
      if (!o.name || o.price == null) continue;
      // Filtra por range de preço
      if (o.price < config.minPriceToBuy || o.price > config.maxPriceToBuy) continue;

      const history = getPriceHistory(m.id, o.name);
      if (history.length < 3) continue; // precisa de histórico mínimo

      // Compara preço atual com preço de 2 ticks atrás
      const prevPrice = history[history.length - 3].price;
      const currentPrice = o.price;
      const priceChange = currentPrice - prevPrice;

      // Tendência de alta: preço subiu pelo menos 2 centavos (0.02)
      if (priceChange >= 0.02) {
        candidates.push({
          marketId: m.id,
          marketQuestion: m.question,
          outcome: o.name,
          price: currentPrice,
          reason: `Momentum: ${o.name} subiu ${(priceChange * 100).toFixed(1)}¢ nos últimos ticks`,
          score: priceChange,
        });
      }
    }
  }

  if (candidates.length === 0) return null;

  // Escolhe o com maior score (maior subida)
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

/**
 * Estratégia Reversão à Média: compra o outcome barato (< 0.25)
 * esperando correção para cima.
 *
 * @param {Array} markets
 * @param {Object} config
 * @returns {Object|null}
 */
function strategyMeanReversion(markets, config) {
  const maxPrice = Math.min(0.25, config.maxPriceToBuy);
  const minPrice = config.minPriceToBuy;
  const candidates = [];

  for (const m of markets) {
    for (const o of m.outcomes) {
      if (!o.name || o.price == null) continue;
      if (o.price < minPrice || o.price > maxPrice) continue;

      candidates.push({
        marketId: m.id,
        marketQuestion: m.question,
        outcome: o.name,
        price: o.price,
        reason: `Reversão à média: ${o.name} a ${(o.price * 100).toFixed(1)}¢ (< 25¢) — esperando correção`,
        // Score: quanto mais barato, melhor (prioriza os mais distantes da média)
        score: 0.25 - o.price,
      });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

/**
 * Estratégia Comprar Barato Amplo: distribui pequenas compras em
 * outcomes com preço < 0.15.
 *
 * @param {Array} markets
 * @param {Object} config
 * @returns {Object|null}
 */
function strategyBargainHunting(markets, config) {
  const maxPrice = Math.min(0.15, config.maxPriceToBuy);
  const minPrice = config.minPriceToBuy;
  const positions = getPositions();
  const ownedMarkets = new Set(positions.map(p => `${p.marketId}|${p.outcome}`));

  const candidates = [];
  for (const m of markets) {
    for (const o of m.outcomes) {
      if (!o.name || o.price == null) continue;
      if (o.price < minPrice || o.price > maxPrice) continue;
      // Evita comprar onde já tem posição
      if (ownedMarkets.has(`${m.id}|${o.name}`)) continue;

      candidates.push({
        marketId: m.id,
        marketQuestion: m.question,
        outcome: o.name,
        price: o.price,
        reason: `Comprar barato: ${o.name} a ${(o.price * 100).toFixed(1)}¢ (< 15¢)`,
        score: 0.15 - o.price,
      });
    }
  }

  if (candidates.length === 0) return null;
  // Escolhe aleatoriamente entre os 3 mais baratos (diversificação)
  candidates.sort((a, b) => b.score - a.score);
  const topN = candidates.slice(0, 3);
  return topN[Math.floor(Math.random() * topN.length)];
}

/**
 * Estratégia Value Betting (Expected Value): cria uma "estimativa de
 * probabilidade justa" do mercado a partir do preço atual + histórico
 * e compra outcomes cujo preço está bem abaixo-band da estimativa.
 *
 * EV = (probEstimada × payout) − preço
 * Compra se EV > 0 (preço subestimado).
 *
 * A "estimativa de probabilidade justa" usa uma média entre o preço atual
 * e a média dos últimos preços históricos (suavização). Em mercados de
 * predição, o preço é a probabilidade implícita; se a nossa estimativa
 * suavizada é maior que o preço atual, há edge.
 *
 * @param {Array} markets
 * @param {Object} config
 * @returns {Object|null}
 */
function strategyValueBetting(markets, config) {
  const candidates = [];

  for (const m of markets) {
    for (const o of m.outcomes) {
      if (!o.name || o.price == null) continue;
      if (o.price < config.minPriceToBuy || o.price > config.maxPriceToBuy) continue;

      const history = getPriceHistory(m.id, o.name);
      // Precisa de pelo menos 5 pontos de histórico para estimar
      if (history.length < 5) continue;

      // Estimativa de prob justa: média dos últimos 5 preços (suavização)
      const recent = history.slice(-5).map(h => h.price);
      const fairProb = recent.reduce((s, p) => s + p, 0) / recent.length;

      // EV = prob_justa × retorno - preço
      // (payout = 1.0 em mercados de predição)
      const ev = (fairProb * 1.0) - o.price;
      const evPercent = (ev / o.price) * 100;

      // Compra se EV > 5% (margem de segurança para ruído)
      if (evPercent > 5) {
        candidates.push({
          marketId: m.id,
          marketQuestion: m.question,
          outcome: o.name,
          price: o.price,
          reason: `Value Bet: ${o.name} a ${(o.price * 100).toFixed(1)}¢, EV=+${evPercent.toFixed(1)}% (prob justa ${(fairProb * 100).toFixed(1)}¢)`,
          score: evPercent,
        });
      }
    }
  }

  if (candidates.length === 0) return null;
  // Escolhe o de maior EV
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

/**
 * Estratégia Kelly Criterion: calcula a fração ótima do bankroll para
 * apostar em cada outcome baseada na edge estimada (EV) e varia o
 * tamanho do trade dinamicamente. Retorna o outcome com maior f* de Kelly.
 *
 * f* = (p × b - q) / b
 * onde:
 *   p = probabilidade estimada de ganhar (prob justa suavizada)
 *   q = 1 - p (probabilidade de perder)
 *   b = (1 - preço) / preço (odds decimal relativa: quanto ganha por $1 investido)
 *
 * Recomenda apostar se f* > 0 (edge positivo). Usa meio-Kelly (f* / 2)
 * para reduzir volatilidade (prática padrão em trading real).
 *
 * @param {Array} markets
 * @param {Object} config
 * @returns {Object|null} — Pick com campo extra kellyFraction recomendada
 */
function strategyKelly(markets, config) {
  const candidates = [];

  for (const m of markets) {
    for (const o of m.outcomes) {
      if (!o.name || o.price == null) continue;
      if (o.price < config.minPriceToBuy || o.price > config.maxPriceToBuy) continue;

      const history = getPriceHistory(m.id, o.name);
      if (history.length < 5) continue;

      // Estimativa p via média suavizada dos últimos 5 preços
      const recent = history.slice(-5).map(h => h.price);
      const p = recent.reduce((s, pr) => s + pr, 0) / recent.length;
      const q = 1 - p;

      // Odds b: se preço é 0.30, paga 1/0.30 = 3.33x; b = (1-price)/price
      const price = o.price;
      if (price <= 0 || price >= 1) continue;
      const b = (1 - price) / price;

      // fKelly = (p × b - q) / b — pode ser negativo (sem edge)
      const fKelly = (p * b - q) / b;
      // Meio-Kelly para reduzir volatilidade
      const fHalf = fKelly / 2;

      // Só recomenda se f* > 0 (tem edge) e meio-Kelly >= 1% do saldo
      if (fHalf > 0.01) {
        candidates.push({
          marketId: m.id,
          marketQuestion: m.question,
          outcome: o.name,
          price: price,
          reason: `Kelly f*=${(fKelly * 100).toFixed(1)}% (½Kelly ${(fHalf * 100).toFixed(1)}%) — p estim ${(p * 100).toFixed(1)}¢ vs preço ${(price * 100).toFixed(1)}¢`,
          score: fHalf, // maior fHalf = melhor
          kellyFraction: fHalf, // exposto para evaluateNewEntries usar
        });
      }
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0];
}

/**
 * Estratégia Aleatória: compra ou vende aleatoriamente (toy).
 * ~60% chance de comprar, ~40% de vender (se tem posições).
 *
 * @param {Array} markets
 * @param {Object} config
 * @returns {Object|null} — para comprar: { marketId, outcome, price, reason, action: 'buy' }
 *                          para vender: { marketId, outcome, price, reason, action: 'sell', shares }
 */
function strategyRandom(markets, config) {
  const positions = getPositions();
  const roll = Math.random();

  // 40% chance de tentar vender se tem posições
  if (roll < 0.4 && positions.length > 0) {
    const pos = positions[Math.floor(Math.random() * positions.length)];
    const wallet = getWallet();
    const market = markets.find(m => String(m.id) === String(pos.marketId));
    const outcomeObj = market?.outcomes.find(o => o.name === pos.outcome);
    const currentPrice = outcomeObj?.price ?? pos.avgPrice;

    return {
      action: 'sell',
      marketId: pos.marketId,
      marketQuestion: pos.marketQuestion,
      outcome: pos.outcome,
      price: currentPrice,
      shares: pos.shares,
      reason: `Aleatório: vendeu ${pos.shares} shares de ${pos.outcome}`,
    };
  }

  // 60% chance (ou 100% se não há posições) — compra
  const candidates = [];
  for (const m of markets) {
    for (const o of m.outcomes) {
      if (!o.name || o.price == null) continue;
      if (o.price < config.minPriceToBuy || o.price > config.maxPriceToBuy) continue;
      candidates.push({
        marketId: m.id,
        marketQuestion: m.question,
        outcome: o.name,
        price: o.price,
      });
    }
  }

  if (candidates.length === 0) return null;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  return {
    action: 'buy',
    ...pick,
    reason: `Aleatório: comprou ${pick.outcome} a ${(pick.price * 100).toFixed(1)}¢`,
  };
}

// ============================================================
//  GESTÃO DE POSIÇÕES (take-profit / stop-loss)
// ============================================================

/**
 * Avalia todas as posições abertas e executa take-profit ou stop-loss
 * conforme a config do bot.
 *
 * @param {Array} markets — state.markets (para preços atuais)
 * @param {Object} config — config do bot
 * @returns {Array} — ações executadas [{ action, marketId, outcome, shares, price, reason }]
 */
function managePositions(markets, config) {
  const actions = [];
  const positions = getPositions();
  if (positions.length === 0) return actions;

  for (const pos of positions) {
    const market = markets.find(m => String(m.id) === String(pos.marketId));
    const outcomeObj = market?.outcomes.find(o => o.name === pos.outcome);
    const currentPrice = outcomeObj?.price ?? pos.avgPrice;

    if (!outcomeObj) continue; // mercado não encontrado — não pode gerenciar

    const metrics = computePositionMetrics(pos, markets);
    const pnlPercent = metrics.pnlPercent;

    // Take-profit: vende tudo se P&L >= profitTarget%
    if (pnlPercent >= config.profitTarget) {
      const result = walletSell({
        marketId: pos.marketId,
        outcome: pos.outcome,
        shares: pos.shares,
        price: currentPrice,
      });

      if (result.success) {
        const action = {
          action: 'sell',
          marketId: pos.marketId,
          marketQuestion: pos.marketQuestion,
          outcome: pos.outcome,
          shares: pos.shares,
          price: currentPrice,
          reason: `Take-profit: ${pnlPercent.toFixed(1)}% ≥ ${config.profitTarget}% — vendeu ${pos.shares} shares`,
        };
        actions.push(action);
        addLogEntry(action);
      }
    }
    // Stop-loss: vende tudo se P&L <= -stopLoss%
    else if (pnlPercent <= -config.stopLoss) {
      const result = walletSell({
        marketId: pos.marketId,
        outcome: pos.outcome,
        shares: pos.shares,
        price: currentPrice,
      });

      if (result.success) {
        const action = {
          action: 'sell',
          marketId: pos.marketId,
          marketQuestion: pos.marketQuestion,
          outcome: pos.outcome,
          shares: pos.shares,
          price: currentPrice,
          reason: `Stop-loss: ${pnlPercent.toFixed(1)}% ≤ -${config.stopLoss}% — vendeu ${pos.shares} shares`,
        };
        actions.push(action);
        addLogEntry(action);
      }
    }
  }

  return actions;
}

// ============================================================
//  NOVAS ENTRADAS (compra de novos mercados)
// ============================================================

/**
 * Avalia novos mercados para entrar, conforme a estratégia selecionada.
 *
 * @param {Array} markets — state.markets
 * @param {Object} config — config do bot
 * @returns {Array} — ações executadas [{ action, marketId, outcome, shares, price, reason }]
 */
function evaluateNewEntries(markets, config) {
  const actions = [];

  // Verifica limites
  const positions = getPositions();
  if (positions.length >= config.maxOpenPositions) {
    actions.push({
      action: 'skip',
      reason: `Máximo de ${config.maxOpenPositions} posições abertas atingido`,
    });
    return actions;
  }

  const wallet = getWallet();
  if (wallet.balance <= 0) {
    actions.push({
      action: 'skip',
      reason: 'Saldo insuficiente',
    });
    return actions;
  }

  // Calcula quanto gastar por operação
  const tradeBudget = (wallet.balance * config.porTrade) / 100;
  if (tradeBudget < 0.01) {
    actions.push({
      action: 'skip',
      reason: `Orçamento por trade (${tradeBudget}) muito baixo`,
    });
    return actions;
  }

  // Executa a estratégia selecionada
  let pick = null;
  let isSellAction = false;

  switch (config.strategy) {
    case 'momentum':
      pick = strategyMomentum(markets, config);
      break;
    case 'meanReversion':
      pick = strategyMeanReversion(markets, config);
      break;
    case 'bargainHunting':
      pick = strategyBargainHunting(markets, config);
      break;
    case 'valueBetting':
      pick = strategyValueBetting(markets, config);
      break;
    case 'kelly':
      pick = strategyKelly(markets, config);
      break;
    case 'random':
      pick = strategyRandom(markets, config);
      isSellAction = pick?.action === 'sell';
      break;
    default:
      pick = strategyMomentum(markets, config);
  }

  if (!pick) {
    actions.push({
      action: 'skip',
      reason: `Estratégia "${config.strategy}" não encontrou oportunidades`,
    });
    return actions;
  }

  // Executa a ação
  if (isSellAction) {
    // Estratégia aleatória pode decidir vender
    const result = walletSell({
      marketId: pick.marketId,
      outcome: pick.outcome,
      shares: pick.shares,
      price: pick.price,
    });

    if (result.success) {
      const action = {
        action: 'sell',
        marketId: pick.marketId,
        marketQuestion: pick.marketQuestion,
        outcome: pick.outcome,
        shares: pick.shares,
        price: pick.price,
        reason: pick.reason,
      };
      actions.push(action);
      addLogEntry(action);
    } else {
      actions.push({ action: 'error', reason: result.message });
    }
  } else {
    // Compra — calcula quantas shares dá para comprar com o orçamento
    const price = pick.price;
    if (price <= 0 || price > 1) {
      actions.push({ action: 'skip', reason: `Preço inválido: ${price}` });
      return actions;
    }

    // Para Kelly: o orçamento do trade é multiplicado pela fração kelly
    // (meio-Kelly já está embutida no kellyFraction). Cap em 25% do saldo
    // para evitar over-bet mesmo com f* alto.
    let effectiveBudget = tradeBudget;
    if (config.strategy === 'kelly' && pick.kellyFraction) {
      const kellyCap = Math.min(pick.kellyFraction, 0.25); // max 25% do saldo
      effectiveBudget = wallet.balance * kellyCap;
      // Mínimo do orçamento padrão e do Kelly cap
      effectiveBudget = Math.max(effectiveBudget, tradeBudget * 0.5);
    }

    const maxShares = Math.floor(effectiveBudget / price);
    if (maxShares < 1) {
      actions.push({
        action: 'skip',
        reason: `Orçamento (${effectiveBudget.toFixed(2)}) insuficiente para comprar a ${(price * 100).toFixed(1)}¢`,
      });
      return actions;
    }

    const result = walletBuy({
      marketId: pick.marketId,
      marketQuestion: pick.marketQuestion,
      outcome: pick.outcome,
      shares: maxShares,
      price: price,
    });

    if (result.success) {
      const action = {
        action: 'buy',
        marketId: pick.marketId,
        marketQuestion: pick.marketQuestion,
        outcome: pick.outcome,
        shares: maxShares,
        price: price,
        reason: pick.reason || `Comprou ${maxShares} shares de ${pick.outcome} a ${(price * 100).toFixed(1)}¢`,
      };
      actions.push(action);
      addLogEntry(action);
    } else {
      actions.push({ action: 'error', reason: result.message });
    }
  }

  return actions;
}

// ============================================================
//  CICLO DE AVALIAÇÃO (tick)
// ============================================================

/**
 * Executa um ciclo de avaliação do bot.
 * 1. Verifica se está ligado e há saldo disponível
 * 2. Registra preços atuais no histórico (para momentum)
 * 3. Gestão de posições: aplica take-profit/stop-loss
 * 4. Novas entradas: avalia mercados e aplica a estratégia escolhida
 *
 * @param {Array} markets — state.markets (mercados carregados)
 * @returns {Object} — { tick, actions: [], summary: string }
 */
export function tick(markets) {
  _tickCount++;
  const config = getConfig();
  const allActions = [];

  if (!config.enabled) {
    return { tick: _tickCount, actions: [], summary: 'Bot desligado' };
  }

  if (!markets || markets.length === 0) {
    return { tick: _tickCount, actions: [], summary: 'Sem mercados carregados' };
  }

  // 1. Registra preços no histórico (para estratégia momentum)
  for (const m of markets.slice(0, 20)) { // limita a 20 mercados para economizar storage
    for (const o of m.outcomes) {
      if (o.name && o.price != null) {
        recordPrice(m.id, o.name, o.price);
      }
    }
  }

  // 2. Gestão de posições existentes (take-profit / stop-loss)
  const manageActions = managePositions(markets, config);
  allActions.push(...manageActions);

  // 3. Novas entradas (avalia mercados conforme estratégia)
  const entryActions = evaluateNewEntries(markets, config);
  allActions.push(...entryActions);

  // 4. Log de tick mesmo se não houve ações (para debug)
  const realActions = allActions.filter(a => a.action !== 'skip' && a.action !== 'error');
  const skipActions = allActions.filter(a => a.action === 'skip');
  const errorActions = allActions.filter(a => a.action === 'error');

  // Se não houve trades, loga um skip para debug (apenas no console, não no pm_bot_log)
  if (realActions.length === 0) {
    const skipReasons = skipActions.map(s => s.reason).join('; ') || 'Nenhuma oportunidade';
    console.log(`bot.js tick #${_tickCount}: ${skipReasons}`);
  }

  const summary = realActions.length > 0
    ? `${realActions.length} ação(ões) executada(s)`
    : skipActions.length > 0
      ? skipActions[0].reason
      : 'Nenhuma ação';

  // 5. Callbacks para UI
  if (_onActionCallback && realActions.length > 0) {
    _onActionCallback(realActions);
  }
  if (_onTickCallback) {
    _onTickCallback({ tick: _tickCount, summary, actions: realActions });
  }

  return { tick: _tickCount, actions: realActions, summary };
}

// ============================================================
//  START / STOP (controle do setInterval)
// ============================================================

/**
 * Inicia o ciclo de avaliação via setInterval.
 * @param {Array} getMarketsFn — função que retorna state.markets (passada pelo app)
 * @param {Object} callbacks — { onTick, onAction }
 */
export function start(getMarketsFn, callbacks = {}) {
  const config = getConfig();
  if (_intervalHandle) stop(); // já rodando — reinicia

  // Atualiza config com callbacks
  _onTickCallback = callbacks.onTick || null;
  _onActionCallback = callbacks.onAction || null;

  // Marca como ligado
  updateConfig({ enabled: true });

  // Primeiro tick imediato
  const markets = getMarketsFn();
  tick(markets);

  // Agenda ticks subsequentes
  _intervalHandle = setInterval(() => {
    if (document.hidden) return; // não roda se aba não visível
    const m = getMarketsFn();
    tick(m);
  }, config.intervalMs);

  console.log(`bot.js: iniciado (estratégia=${config.strategy}, intervalo=${config.intervalMs}ms)`);
  return _intervalHandle;
}

/**
 * Para o ciclo de avaliação.
 */
export function stop() {
  if (_intervalHandle) {
    clearInterval(_intervalHandle);
    _intervalHandle = null;
  }
  updateConfig({ enabled: false });
  _onTickCallback = null;
  _onActionCallback = null;
  console.log('bot.js: parado');
}

/**
 * Verifica se o bot está rodando.
 * @returns {boolean}
 */
export function isRunning() {
  return _intervalHandle !== null;
}

/**
 * Retorna o tick count atual.
 * @returns {number}
 */
export function getTickCount() {
  return _tickCount;
}

/**
 * Reseta o tick count (para reiniciar a contagem).
 */
export function resetTickCount() {
  _tickCount = 0;
}

// ============================================================
//  ESTATÍSTICAS DO BOT
// ============================================================

/**
 * Calcula estatísticas das ações do bot a partir do log.
 * @returns {Object} — { totalActions, totalBuys, totalSells, totalSkips, lastAction }
 */
export function getBotStats() {
  const log = getLog(MAX_LOG_ENTRIES);
  const totalBuys = log.filter(e => e.action === 'buy').length;
  const totalSells = log.filter(e => e.action === 'sell').length;
  const lastAction = log[0] || null;

  return {
    totalActions: log.length,
    totalBuys,
    totalSells,
    lastAction,
  };
}

// ============================================================
//  EXPORT DAS ESTRATÉGIAS (para testes lógicos)
// ============================================================

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

// ===== Aliases para consistência com o schema da skill =====
export { getConfig as getBotConfig };
export { saveConfig as setBotConfig };
export { updateConfig as updateBotConfig };
