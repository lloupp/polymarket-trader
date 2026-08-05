// portfolio.js — Posição, P&L, dashboard e gráfico de pizza (Canvas)
// Fase 5: gráfico de alocação da carteira, cálculos de P&L não-realizado,
//          helpers de portfolio reutilizáveis pelo app e pelo bot (Fase 9).

import { formatUSD, formatPercent, formatPrice } from './utils.js';
import { getWallet, getPositions } from './wallet.js';

// ===== Cores do gráfico de pizza (paleta do tema) =====
const PIE_COLORS = [
  '#3b82f6',  // blue
  '#8b5cf6',  // purple
  '#22c55e',  // green
  '#f59e0b',  // accent (amber)
  '#ef4444',  // red
  '#06b6d4',  // cyan
  '#ec4899',  // pink
  '#84cc16',  // lime
  '#f97316',  // orange
  '#a855f7',  // violet
  '#14b8a6',  // teal
  '#eab308',  // yellow
];

/**
 * Calcula o preço atual de uma posição a partir dos mercados carregados.
 * @param {Object} position — posição do wallet
 * @param {Array} markets — state.markets (mercados carregados)
 * @returns {number} — preço atual (0-1); fallback para avgPrice se mercado não encontrado
 */
export function getCurrentPrice(position, markets) {
  const market = markets.find(m => String(m.id) === String(position.marketId));
  const outcomeObj = market?.outcomes.find(o => o.name === position.outcome);
  return outcomeObj?.price ?? position.avgPrice;
}

/**
 * Calcula métricas derivadas de uma posição (NÃO persistidas).
 * @param {Object} position — { marketId, marketQuestion, outcome, shares, avgPrice, costBasis }
 * @param {Array} markets — state.markets
 * @returns {Object} — { currentPrice, marketValue, pnl, pnlPercent, costBasis }
 */
export function computePositionMetrics(position, markets) {
  const currentPrice = getCurrentPrice(position, markets);
  const marketValue = position.shares * currentPrice;
  const pnl = (currentPrice - position.avgPrice) * position.shares;
  const pnlPercent = position.avgPrice > 0
    ? ((currentPrice - position.avgPrice) / position.avgPrice) * 100
    : 0;
  return {
    currentPrice,
    marketValue,
    pnl,
    pnlPercent,
    costBasis: position.costBasis
  };
}

/**
 * Calcula métricas agregadas do portfólio inteiro.
 * @param {Array} markets — state.markets
 * @returns {Object} — { openCount, invested, currentValue, unrealizedPnl, unrealizedPnlPercent, balance, totalEquity }
 */
export function computePortfolioSummary(markets) {
  const wallet = getWallet();
  const positions = wallet.positions;
  const openCount = positions.length;
  let invested = 0;
  let currentValue = 0;

  for (const p of positions) {
    invested += p.costBasis;
    const currentPrice = getCurrentPrice(p, markets);
    currentValue += p.shares * currentPrice;
  }

  const unrealizedPnl = currentValue - invested;
  const unrealizedPnlPercent = invested > 0 ? (unrealizedPnl / invested) * 100 : 0;
  const totalEquity = wallet.balance + currentValue;  // saldo + valor das posições

  return {
    openCount,
    invested,
    currentValue,
    unrealizedPnl,
    unrealizedPnlPercent,
    balance: wallet.balance,
    totalEquity,
    initialBalance: wallet.initialBalance
  };
}

/**
 * Retorna os dados de alocação da carteira para o gráfico de pizza.
 * Ordenado por valor de mercado decrescente.
 * @param {Array} markets — state.markets
 * @returns {Array} — [{ label, value, color, percent }]
 */
export function getAllocationData(markets) {
  const positions = getPositions();
  if (positions.length === 0) return [];

  // Agrupa por marketId (pode ter Yes e No do mesmo mercado)
  const allocMap = new Map();
  let totalValue = 0;

  for (const p of positions) {
    const currentPrice = getCurrentPrice(p, markets);
    const value = p.shares * currentPrice;
    totalValue += value;

    const key = String(p.marketId);
    if (allocMap.has(key)) {
      const entry = allocMap.get(key);
      entry.value += value;
      entry.outcomes.push(p.outcome);
    } else {
      allocMap.set(key, {
        marketId: key,
        question: p.marketQuestion,
        value: value,
        outcomes: [p.outcome]
      });
    }
  }

  // Ordena por valor decrescente
  const sorted = [...allocMap.values()].sort((a, b) => b.value - a.value);

  // Limita a 11 fatias (top 10 + "Outros")
  let result;
  if (sorted.length > 11) {
    const top10 = sorted.slice(0, 10);
    const rest = sorted.slice(10);
    const othersValue = rest.reduce((sum, e) => sum + e.value, 0);
    result = [...top10, { question: 'Outros', value: othersValue, isOthers: true }];
  } else {
    result = sorted;
  }

  return result.map((entry, i) => ({
    label: entry.isOthers ? 'Outros' : truncateLabel(entry.question, 40),
    fullLabel: entry.question,
    value: entry.value,
    color: entry.isOthers ? '#64748b' : PIE_COLORS[i % PIE_COLORS.length],
    percent: totalValue > 0 ? (entry.value / totalValue) * 100 : 0
  }));
}

/**
 * Desenha o gráfico de pizza (donut) no canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {Array} data — retorno de getAllocationData()
 * @param {number} totalValue — valor total do portfólio (para o centro)
 */
export function drawAllocationPie(canvas, data, totalValue) {
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');

  // DPI handling para telas HiDPI
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 280;
  const cssH = canvas.clientHeight || 280;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.scale(dpr, dpr);

  const cx = cssW / 2;
  const cy = cssH / 2;
  const outerR = Math.min(cssW, cssH) / 2 - 8;
  const innerR = outerR * 0.55;  // donut hole

  // Limpa
  ctx.clearRect(0, 0, cssW, cssH);

  if (!data || data.length === 0 || totalValue <= 0) {
    // Estado vazio
    ctx.beginPath();
    ctx.arc(cx, cy, outerR, 0, Math.PI * 2);
    ctx.arc(cx, cy, innerR, 0, Math.PI * 2);
    ctx.fillStyle = '#1e2535';
    ctx.fill();

    ctx.fillStyle = '#8b919e';
    ctx.font = '0.85rem sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Sem posições', cx, cy);
    return;
  }

  // Desenha fatias
  let startAngle = -Math.PI / 2;  // começa no topo
  for (const slice of data) {
    const angle = (slice.percent / 100) * Math.PI * 2;
    const endAngle = startAngle + angle;

    ctx.beginPath();
    ctx.arc(cx, cy, outerR, startAngle, endAngle);
    ctx.arc(cx, cy, innerR, endAngle, startAngle, true);
    ctx.closePath();
    ctx.fillStyle = slice.color;
    ctx.fill();

    startAngle = endAngle;
  }

  // Centro: valor total
  ctx.fillStyle = '#e4e7ef';
  ctx.font = 'bold 1rem sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(formatUSD(totalValue), cx, cy - 8);

  ctx.fillStyle = '#8b919e';
  ctx.font = '0.7rem sans-serif';
  ctx.fillText('Valor Total', cx, cy + 12);
}

/**
 * Renderiza a legenda do gráfico de pizza.
 * @param {HTMLElement} legendEl — container da legenda
 * @param {Array} data — retorno de getAllocationData()
 */
export function renderAllocationLegend(legendEl, data) {
  if (!legendEl) return;
  if (!data || data.length === 0) {
    legendEl.innerHTML = '';
    return;
  }

  legendEl.innerHTML = data.map(d => `
    <div class="legend-item">
      <span class="legend-color" style="background: ${d.color};"></span>
      <span class="legend-label" title="${escapeHtml(d.fullLabel)}">${escapeHtml(d.label)}</span>
      <span class="legend-value">${formatUSD(d.value)}</span>
      <span class="legend-percent">${d.percent.toFixed(1)}%</span>
    </div>
  `).join('');
}

/**
 * Gera o HTML das cards de posição para o portfolio tab.
 * Usa computePositionMetrics para P&L em tempo real.
 * @param {Array} markets — state.markets
 * @returns {string} — HTML das position cards
 */
export function renderPositionCards(markets) {
  const positions = getPositions();
  if (positions.length === 0) return '';

  const summary = computePortfolioSummary(markets);

  return positions.map(p => {
    const m = computePositionMetrics(p, markets);
    const allocPercent = summary.currentValue > 0
      ? (m.marketValue / summary.currentValue) * 100
      : 0;

    return `
      <div class="position-card" data-market-id="${p.marketId}" data-outcome="${p.outcome}">
        <div class="position-card-header">
          <p class="position-card-question">${escapeHtml(p.marketQuestion)}</p>
          <span class="position-outcome-badge ${p.outcome === 'Yes' ? 'yes' : 'no'}">${p.outcome}</span>
        </div>
        <div class="position-card-stats">
          <div class="position-stat">
            <span class="position-stat-label">Shares</span>
            <span class="position-stat-value">${p.shares}</span>
          </div>
          <div class="position-stat">
            <span class="position-stat-label">Preço Médio</span>
            <span class="position-stat-value">${formatPrice(p.avgPrice)}</span>
          </div>
          <div class="position-stat">
            <span class="position-stat-label">Preço Atual</span>
            <span class="position-stat-value">${formatPrice(m.currentPrice)}</span>
          </div>
          <div class="position-stat">
            <span class="position-stat-label">Valor Atual</span>
            <span class="position-stat-value">${formatUSD(m.marketValue)}</span>
          </div>
          <div class="position-stat">
            <span class="position-stat-label">P&L</span>
            <span class="position-stat-value ${m.pnl > 0 ? 'pnl-positive' : m.pnl < 0 ? 'pnl-negative' : ''}">
              ${formatUSD(m.pnl)} (${formatPercent(m.pnlPercent)})
            </span>
          </div>
        </div>
        <div class="position-alloc-bar">
          <div class="position-alloc-fill" style="width: ${allocPercent}%; background: var(--blue);"></div>
        </div>
        <div class="position-alloc-label">
          ${allocPercent.toFixed(1)}% do portfólio
        </div>
        <div class="position-card-actions">
          <button class="position-sell-btn" data-market-id="${p.marketId}" data-outcome="${p.outcome}">
            Vender
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// ===== Helpers =====
function truncateLabel(str, maxLen) {
  if (!str) return '';
  return str.length > maxLen ? str.substring(0, maxLen) + '…' : str;
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
