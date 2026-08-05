// wallet.js — Gestão da carteira fictícia (saldo, posições, trades)
// Fase 4: init, buy, sell, reset, posições, histórico de trades
// Persistência em localStorage com prefixo pm_

import { saveToStorage, loadFromStorage, generateId } from './utils.js';

const STORAGE_KEY = 'wallet';
const INITIAL_BALANCE = 1000;

/**
 * Inicializa a carteira se não existir em localStorage.
 * Schema: { balance, initialBalance, positions: [], trades: [] }
 */
export function init() {
  const wallet = loadFromStorage(STORAGE_KEY, null);
  if (!wallet) {
    const fresh = { balance: INITIAL_BALANCE, initialBalance: INITIAL_BALANCE, positions: [], trades: [] };
    saveToStorage(STORAGE_KEY, fresh);
  }
  return getWallet();
}

/**
 * Retorna a carteira completa.
 * @returns {Object} — { balance, initialBalance, positions: [], trades: [] }
 */
export function getWallet() {
  const wallet = loadFromStorage(STORAGE_KEY, null);
  if (!wallet) return init();
  // Garante que positions e trades sejam arrays
  if (!Array.isArray(wallet.positions)) wallet.positions = [];
  if (!Array.isArray(wallet.trades)) wallet.trades = [];
  return wallet;
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
export function buy(params) {
  const { marketId, marketQuestion, outcome, shares, price } = params;
  const qty = Math.floor(Number(shares));
  const unitPrice = parseFloat(price);

  if (!marketId || !outcome || !qty || qty <= 0) {
    return { success: false, message: 'Parâmetros inválidos' };
  }
  if (isNaN(unitPrice) || unitPrice <= 0 || unitPrice > 1) {
    return { success: false, message: 'Preço inválido (deve estar entre 0 e 1)' };
  }

  const totalCost = qty * unitPrice;
  const wallet = getWallet();

  if (totalCost > wallet.balance) {
    return { success: false, message: `Saldo insuficiente. Você precisa de $${totalCost.toFixed(2)}, mas tem $${wallet.balance.toFixed(2)}.` };
  }

  wallet.balance -= totalCost;

  // Procura ou cria a posição
  let position = wallet.positions.find(p => p.marketId === String(marketId) && p.outcome === outcome);
  if (!position) {
    position = {
      marketId: String(marketId),
      marketQuestion,
      outcome,
      shares: qty,
      avgPrice: unitPrice,
      costBasis: totalCost
    };
    wallet.positions.push(position);
  } else {
    // Preço médio ponderado pelo número de shares
    const newShares = position.shares + qty;
    position.avgPrice = ((position.avgPrice * position.shares + unitPrice * qty) / newShares);
    position.shares = newShares;
    position.costBasis = (position.avgPrice * position.shares);
    position.marketQuestion = marketQuestion || position.marketQuestion;
  }

  // Registra o trade
  const trade = {
    id: generateId(),
    marketId: String(marketId),
    marketQuestion,
    outcome,
    side: 'buy',
    shares: qty,
    price: unitPrice,
    totalCost: totalCost,
    timestamp: new Date().toISOString()
  };
  wallet.trades.push(trade);

  save(wallet);

  return { success: true, message: `Comprou ${qty} shares de "${outcome}" por $${totalCost.toFixed(2)}`, trade, position };
}

/**
 * Vende shares de uma posição existente.
 * Atualiza saldo, remove ou reduz posição. Registra trade.
 *
 * @param {Object} params — { marketId, outcome, shares, price }
 * @returns {Object} — { success: boolean, message: string, trade? }
 */
export function sell(params) {
  const { marketId, outcome, shares, price } = params;
  const qty = Math.floor(Number(shares));
  const unitPrice = parseFloat(price);

  if (!marketId || !outcome || !qty || qty <= 0) {
    return { success: false, message: 'Parâmetros inválidos' };
  }
  if (isNaN(unitPrice) || unitPrice < 0 || unitPrice > 1) {
    return { success: false, message: 'Preço inválido (deve estar entre 0 e 1)' };
  }

  const totalReturn = qty * unitPrice;
  const wallet = getWallet();

  const position = wallet.positions.find(p => p.marketId === String(marketId) && p.outcome === outcome);
  if (!position) {
    return { success: false, message: 'Posição não encontrada' };
  }
  if (qty > position.shares) {
    return { success: false, message: `Você só tem ${position.shares} shares dessa posição.` };
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

  save(wallet);

  return { success: true, message: `Vendeu ${qty} shares de "${outcome}" por $${totalReturn.toFixed(2)}`, trade };
}

/**
 * Reinicia a carteira ao saldo inicial. Limpa posições e trades.
 * @param {number} [initialBalance=1000]
 */
export function reset(initialBalance = INITIAL_BALANCE) {
  const fresh = { balance: initialBalance, initialBalance, positions: [], trades: [] };
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
