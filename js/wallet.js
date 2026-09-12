// wallet.js — Gestão da carteira fictícia (saldo, posições, trades)
// Fase 4: init, buy, sell, reset, posições, histórico de trades
// Persistência em localStorage com prefixo pm_

import { saveToStorage, loadFromStorage, generateId } from './utils.js';

const STORAGE_KEY = 'wallet';
const INITIAL_BALANCE = 1000;

function freshWallet(initialBalance = INITIAL_BALANCE) {
  return { balance: initialBalance, initialBalance, positions: [], trades: [] };
}

function normalizeWallet(wallet) {
  if (!wallet || typeof wallet !== 'object' || Array.isArray(wallet)) return null;

  let changed = false;
  const normalized = wallet;

  const initialBalance = Number(normalized.initialBalance);
  if (!Number.isFinite(initialBalance) || initialBalance <= 0) {
    normalized.initialBalance = INITIAL_BALANCE;
    changed = true;
  } else {
    normalized.initialBalance = initialBalance;
  }

  const balance = Number(normalized.balance);
  if (!Number.isFinite(balance) || balance < 0) {
    normalized.balance = normalized.initialBalance;
    changed = true;
  } else {
    normalized.balance = balance;
  }

  if (!Array.isArray(normalized.positions)) {
    normalized.positions = [];
    changed = true;
  }
  if (!Array.isArray(normalized.trades)) {
    normalized.trades = [];
    changed = true;
  }

  return { wallet: normalized, changed };
}

/**
 * Inicializa a carteira se não existir em localStorage.
 * Schema: { balance, initialBalance, positions: [], trades: [] }
 */
export function init() {
  const stored = loadFromStorage(STORAGE_KEY, null);
  const normalized = normalizeWallet(stored);
  if (!normalized) {
    const fresh = freshWallet();
    saveToStorage(STORAGE_KEY, fresh);
    return fresh;
  }
  if (normalized.changed) saveToStorage(STORAGE_KEY, normalized.wallet);
  return normalized.wallet;
}

/**
 * Retorna a carteira completa.
 * @returns {Object} — { balance, initialBalance, positions: [], trades: [] }
 */
export function getWallet() {
  const stored = loadFromStorage(STORAGE_KEY, null);
  const normalized = normalizeWallet(stored);
  if (!normalized) return init();
  if (normalized.changed) saveToStorage(STORAGE_KEY, normalized.wallet);
  return normalized.wallet;
}

/**
 * Salva a carteira no localStorage.
 */
function save(wallet) {
  return saveToStorage(STORAGE_KEY, wallet);
}

/**
 * @returns {number} — saldo atual
 */
export function getBalance() {
  return getWallet().balance;
}

/**
 * Procura uma posição existente num mercado + outcome.
 * @returns {Object|null}
 */
export function getPosition(marketId, outcome) {
  const wallet = getWallet();
  return wallet.positions.find(p => p.marketId === String(marketId) && p.outcome === outcome) || null;
}

/**
 * Compra shares de um outcome num mercado.
 * Atualiza saldo e cria/atualiza posição. Registra trade.
 *
 * @param {Object} params — { marketId, marketQuestion, outcome, shares, price }
 * @returns {Object} — { success: boolean, message: string, trade?, position? }
 */
export function buy(params = {}) {
  const { marketId, marketQuestion, outcome, shares, price } = params;
  const qty = Math.floor(Number(shares));
  const unitPrice = Number(price);

  if (marketId === undefined || marketId === null || String(marketId).trim() === '' ||
      typeof outcome !== 'string' || outcome.trim() === '' ||
      !Number.isFinite(qty) || qty <= 0) {
    return { success: false, message: 'Parâmetros inválidos' };
  }
  if (!Number.isFinite(unitPrice) || unitPrice <= 0 || unitPrice > 1) {
    return { success: false, message: 'Preço inválido (deve estar entre 0 e 1)' };
  }

  const totalCost = qty * unitPrice;
  if (!Number.isFinite(totalCost) || totalCost <= 0) {
    return { success: false, message: 'Custo da operação inválido' };
  }

  const wallet = getWallet();
  if (totalCost > wallet.balance + Number.EPSILON) {
    return { success: false, message: `Saldo insuficiente. Você precisa de $${totalCost.toFixed(2)}, mas tem $${wallet.balance.toFixed(2)}.` };
  }

  wallet.balance = Math.max(0, wallet.balance - totalCost);

  // Procura ou cria a posição
  let position = wallet.positions.find(p => p.marketId === String(marketId) && p.outcome === outcome);
  if (!position) {
    position = {
      marketId: String(marketId),
      marketQuestion: marketQuestion || '',
      outcome,
      shares: qty,
      avgPrice: unitPrice,
      costBasis: totalCost
    };
    wallet.positions.push(position);
  } else {
    // Preço médio ponderado pelo custo real acumulado.
    const previousShares = Number(position.shares) || 0;
    const previousCost = Number.isFinite(Number(position.costBasis))
      ? Number(position.costBasis)
      : (Number(position.avgPrice) || 0) * previousShares;
    const newShares = previousShares + qty;
    const newCostBasis = previousCost + totalCost;
    position.shares = newShares;
    position.costBasis = newCostBasis;
    position.avgPrice = newCostBasis / newShares;
    position.marketQuestion = marketQuestion || position.marketQuestion;
  }

  // Registra o trade
  const trade = {
    id: generateId(),
    marketId: String(marketId),
    marketQuestion: marketQuestion || '',
    outcome,
    side: 'buy',
    shares: qty,
    price: unitPrice,
    totalCost,
    timestamp: new Date().toISOString()
  };
  wallet.trades.push(trade);

  if (!save(wallet)) {
    return { success: false, message: 'Não foi possível persistir a operação no navegador.' };
  }

  return { success: true, message: `Comprou ${qty} shares de "${outcome}" por $${totalCost.toFixed(2)}`, trade, position };
}

/**
 * Vende shares de uma posição existente.
 * Atualiza saldo, remove ou reduz posição. Registra trade.
 *
 * @param {Object} params — { marketId, outcome, shares, price }
 * @returns {Object} — { success: boolean, message: string, trade? }
 */
export function sell(params = {}) {
  const { marketId, outcome, shares, price } = params;
  const qty = Math.floor(Number(shares));
  const unitPrice = Number(price);

  if (marketId === undefined || marketId === null || String(marketId).trim() === '' ||
      typeof outcome !== 'string' || outcome.trim() === '' ||
      !Number.isFinite(qty) || qty <= 0) {
    return { success: false, message: 'Parâmetros inválidos' };
  }
  if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 1) {
    return { success: false, message: 'Preço inválido (deve estar entre 0 e 1)' };
  }

  const totalReturn = qty * unitPrice;
  if (!Number.isFinite(totalReturn) || totalReturn < 0) {
    return { success: false, message: 'Retorno da operação inválido' };
  }

  const wallet = getWallet();
  const position = wallet.positions.find(p => p.marketId === String(marketId) && p.outcome === outcome);
  if (!position) {
    return { success: false, message: 'Posição não encontrada' };
  }
  if (!Number.isFinite(Number(position.shares)) || qty > position.shares) {
    return { success: false, message: `Você só tem ${position.shares || 0} shares dessa posição.` };
  }

  wallet.balance += totalReturn;

  // Registra trade de venda
  const trade = {
    id: generateId(),
    marketId: String(marketId),
    marketQuestion: position.marketQuestion,
    outcome,
    side: 'sell',
    shares: qty,
    price: unitPrice,
    totalCost: totalReturn,
    timestamp: new Date().toISOString()
  };
  wallet.trades.push(trade);

  // Remove ou reduz a posição
  if (qty >= position.shares) {
    wallet.positions = wallet.positions.filter(p => !(p.marketId === String(marketId) && p.outcome === outcome));
  } else {
    position.shares -= qty;
    position.costBasis = position.avgPrice * position.shares;
  }

  if (!save(wallet)) {
    return { success: false, message: 'Não foi possível persistir a operação no navegador.' };
  }

  return { success: true, message: `Vendeu ${qty} shares de "${outcome}" por $${totalReturn.toFixed(2)}`, trade };
}

/**
 * Reinicia a carteira ao saldo inicial. Limpa posições e trades.
 * @param {number} [initialBalance=1000]
 */
export function reset(initialBalance = INITIAL_BALANCE) {
  const requested = Number(initialBalance);
  const safeBalance = Number.isFinite(requested) && requested > 0 ? requested : INITIAL_BALANCE;
  const fresh = freshWallet(safeBalance);
  save(fresh);
  return fresh;
}

/**
 * @returns {Array} — lista de trades ordenados do mais recente para o mais antigo
 */
export function getTrades() {
  const wallet = getWallet();
  return [...wallet.trades].reverse(); // mais recente primeiro
}

/**
 * @returns {Array} — lista de posições abertas
 */
export function getPositions() {
  return getWallet().positions;
}
