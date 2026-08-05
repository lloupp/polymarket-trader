// utils.js — Funções utilitárias

export function formatCurrency(value) {
  return new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(value || 0);
}

export function formatUSD(value) {
  // Formata com separador de milhares: $1,000.00
  return '$' + (value || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

export function formatPercent(value) {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${(value || 0).toFixed(2)}%`;
}

export function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

export function saveToStorage(key, data) {
  try {
    localStorage.setItem(`pm_${key}`, JSON.stringify(data));
    return true;
  } catch (e) { return false; }
}

export function loadFromStorage(key, fallback = null) {
  try {
    const data = localStorage.getItem(`pm_${key}`);
    return data ? JSON.parse(data) : fallback;
  } catch (e) { return fallback; }
}

export function formatPrice(price) {
  if (price === undefined || price === null) return '—';
  return (price * 100).toFixed(1) + '¢';
}
