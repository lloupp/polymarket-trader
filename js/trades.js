// trades.js — Histórico de trades, estatísticas, exportação CSV e gráfico de performance
// Fase 6: log de trades com filtros, tabela, exportação CSV, gráfico de linha (Canvas),
//          estatísticas (win rate, melhor/pior trade, ticket médio).
// Importa de wallet.js e utils.js.

import { formatUSD, formatPercent, formatPrice } from './utils.js';
import { getTrades, getWallet } from './wallet.js';

// ===== Filtros do histórico =====
export const HISTORY_FILTERS = [
  { value: 'all',     label: 'Todos' },
  { value: 'buy',     label: 'Compras' },
  { value: 'sell',    label: 'Vendas' },
];

// ===== Cores do gráfico de linha =====
const CHART_COLORS = {
  line:        '#3b82f6',  // blue — linha de equity
  lineFill:    'rgba(59, 130, 246, 0.12)',
  lineFillBelow: 'rgba(59, 130, 246, 0.04)',
  grid:        'rgba(139, 145, 158, 0.1)',
  axis:        'rgba(139, 145, 158, 0.3)',
  text:        '#8b919e',
  textStrong:  '#e4e7ef',
  positive:    '#22c55e',
  negative:    '#ef4444',
  dotBuy:      '#22c55e',
  dotSell:     '#ef4444',
};

/**
 * Filtra a lista de trades pelo side especificado.
 * @param {Array} trades — trades do wallet (getTrades, mais recente primeiro)
 * @param {string} filter — 'all' | 'buy' | 'sell'
 * @returns {Array} — trades filtrados (mesma ordem)
 */
export function filterTrades(trades, filter) {
  if (!filter || filter === 'all') return trades;
  return trades.filter(t => t.side === filter);
}

/**
 * Calcula estatísticas completas a partir da lista de trades.
 * @param {Array} trades — todos os trades (ordem cronológica)
 * @returns {Object} — { totalTrades, totalBuys, totalSells, totalVolume,
 *                       winRate, bestTrade, worstTrade, avgTicket, totalPnL }
 */
export function computeStats(trades) {
  if (!trades || trades.length === 0) {
    return {
      totalTrades: 0,
      totalBuys: 0,
      totalSells: 0,
      totalVolume: 0,
      winRate: 0,
      bestTrade: null,
      worstTrade: null,
      avgTicket: 0,
      totalPnL: 0,
    };
  }

  // Ordernar cronologicamente (mais antigo primeiro) para cálculos
  const chrono = [...trades].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  let totalVolume = 0;
  let totalBuys = 0;
  let totalSells = 0;
  const sellPnLs = []; // P&L por venda (realizado)

  // Acumula custo base por marketId+outcome para calcular P&L de cada venda
  const costBasisMap = new Map(); // key: "marketId|outcome" → { totalCost, totalShares }

  for (const t of chrono) {
    const cost = t.totalCost || (t.shares * t.price);
    totalVolume += cost;

    if (t.side === 'buy') {
      totalBuys++;
      const key = `${t.marketId}|${t.outcome}`;
      const prev = costBasisMap.get(key) || { totalCost: 0, totalShares: 0 };
      prev.totalCost += cost;
      prev.totalShares += t.shares;
      costBasisMap.set(key, prev);
    } else if (t.side === 'sell') {
      totalSells++;
      const key = `${t.marketId}|${t.outcome}`;
      const basis = costBasisMap.get(key);
      if (basis && basis.totalShares > 0) {
        // P&L = retorno da venda - custo proporcional
        const costPortion = (t.shares / basis.totalShares) * basis.totalCost;
        const pnl = cost - costPortion;
        sellPnLs.push({ trade: t, pnl });

        // Reduz do accumulator
        basis.totalCost -= costPortion;
        basis.totalShares -= t.shares;
        costBasisMap.set(key, basis);
      }
    }
  }

  // Win rate = % de vendas com P&L > 0
  const winningSells = sellPnLs.filter(s => s.pnl > 0).length;
  const winRate = sellPnLs.length > 0 ? (winningSells / sellPnLs.length) * 100 : 0;

  // Melhor e pior trade (por P&L absoluto)
  let bestTrade = null;
  let worstTrade = null;
  for (const s of sellPnLs) {
    if (!bestTrade || s.pnl > bestTrade.pnl) bestTrade = s;
    if (!worstTrade || s.pnl < worstTrade.pnl) worstTrade = s;
  }

  const totalPnL = sellPnLs.reduce((sum, s) => sum + s.pnl, 0);
  const avgTicket = totalVolume / chrono.length;

  return {
    totalTrades: chrono.length,
    totalBuys,
    totalSells,
    totalVolume,
    winRate,
    bestTrade,
    worstTrade,
    avgTicket,
    totalPnL,
    sellCount: sellPnLs.length,
  };
}

/**
 * Gera dados para o gráfico de performance (linha de equity ao longo do tempo).
 * Cada ponto = (timestamp, equity) onde equity = saldo relativo + valor de posições
 * naquele momento (replay dos trades).
 *
 * @param {Array} trades — todos os trades em ordem cronológica
 * @param {number} initialBalance — saldo inicial
 * @returns {Array} — [{ timestamp, equity, balance, action }]
 */
export function buildEquityCurve(trades, initialBalance) {
  if (!trades || trades.length === 0) {
    return [{ timestamp: null, equity: initialBalance, balance: initialBalance, action: 'start' }];
  }

  // Ordena cronologicamente
  const chrono = [...trades].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  const points = [];
  let balance = initialBalance;
  let invested = 0;

  // Ponto inicial
  points.push({ timestamp: null, equity: initialBalance, balance: initialBalance, action: 'start' });

  for (const t of chrono) {
    const cost = t.totalCost || (t.shares * t.price);
    if (t.side === 'buy') {
      balance -= cost;
      invested += cost;
    } else {
      balance += cost;
      invested -= cost;
      // invested nunca negativo
      if (invested < 0) invested = 0;
    }
    points.push({
      timestamp: t.timestamp,
      equity: balance + invested,
      balance,
      action: t.side,
    });
  }

  return points;
}

/**
 * Desenha o gráfico de performance (linha) em um canvas.
 * @param {HTMLCanvasElement} canvas
 * @param {Array} data — retorno de buildEquityCurve()
 * @param {number} initialBalance — para linha de referência
 */
export function drawPerformanceChart(canvas, data, initialBalance) {
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');

  // DPI handling
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600;
  const cssH = canvas.clientHeight || 220;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.scale(dpr, dpr);

  // Limpa
  ctx.clearRect(0, 0, cssW, cssH);

  // Margens
  const mLeft   = 56;
  const mRight   = 16;
  const mTop    = 16;
  const mBottom = 30;
  const plotW = cssW - mLeft - mRight;
  const plotH = cssH - mTop - mBottom;

  // Determina range Y
  const equities = data.map(d => d.equity);
  let minY = Math.min(...equities);
  let maxY = Math.max(...equities);

  // Inclui initialBalance no range para a linha de referência
  minY = Math.min(minY, initialBalance);
  maxY = Math.max(maxY, initialBalance);

  // Padding de 5%
  const yRange = maxY - minY || 1;
  minY -= yRange * 0.05;
  maxY += yRange * 0.05;

  // Funções de mapeamento
  const xStep = data.length > 1 ? plotW / (data.length - 1) : 0;
  const mapX = (i) => mLeft + (data.length > 1 ? i * xStep : plotW / 2);
  const mapY = (val) => mTop + plotH - ((val - minY) / (maxY - minY)) * plotH;

  // ===== Grid horizontal + labels Y =====
  ctx.strokeStyle = CHART_COLORS.grid;
  ctx.lineWidth = 1;
  ctx.fillStyle = CHART_COLORS.text;
  ctx.font = '0.65rem sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';

  const gridSteps = 4;
  for (let i = 0; i <= gridSteps; i++) {
    const yVal = minY + (maxY - minY) * (i / gridSteps);
    const y = mapY(yVal);
    ctx.beginPath();
    ctx.moveTo(mLeft, y);
    ctx.lineTo(mLeft + plotW, y);
    ctx.stroke();
    ctx.fillText('$' + yVal.toFixed(0), mLeft - 6, y);
  }

  // ===== Linha de referência (initialBalance) =====
  const refY = mapY(initialBalance);
  ctx.strokeStyle = CHART_COLORS.axis;
  ctx.setLineDash([4, 4]);
  ctx.beginPath();
  ctx.moveTo(mLeft, refY);
  ctx.lineTo(mLeft + plotW, refY);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = CHART_COLORS.text;
  ctx.font = '0.6rem sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Inicial', mLeft + 4, refY - 5);

  // ===== Linha de equity =====
  if (data.length < 2) {
    // Só ponto inicial
    ctx.fillStyle = CHART_COLORS.line;
    ctx.beginPath();
    ctx.arc(mapX(0), mapY(data[0].equity), 4, 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  // Fill abaixo da linha
  ctx.beginPath();
  ctx.moveTo(mapX(0), mapY(data[0].equity));
  for (let i = 1; i < data.length; i++) {
    ctx.lineTo(mapX(i), mapY(data[i].equity));
  }
  ctx.lineTo(mapX(data.length - 1), mapY(minY) + 0); // bottom right
  ctx.lineTo(mapX(0), mapY(minY) + 0);  // bottom left
  ctx.closePath();
  // Gradient fill
  const grad = ctx.createLinearGradient(0, mTop, 0, mTop + plotH);
  grad.addColorStop(0, CHART_COLORS.lineFill);
  grad.addColorStop(1, CHART_COLORS.lineFillBelow);
  ctx.fillStyle = grad;
  ctx.fill();

  // Linha
  ctx.strokeStyle = CHART_COLORS.line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(mapX(0), mapY(data[0].equity));
  for (let i = 1; i < data.length; i++) {
    ctx.lineTo(mapX(i), mapY(data[i].equity));
  }
  ctx.stroke();

  // ===== Pontos (dots) =====
  for (let i = 1; i < data.length; i++) {
    const d = data[i];
    const cx = mapX(i);
    const cy = mapY(d.equity);
    ctx.beginPath();
    ctx.arc(cx, cy, 3, 0, Math.PI * 2);
    ctx.fillStyle = d.action === 'buy' ? CHART_COLORS.dotBuy : CHART_COLORS.dotSell;
    ctx.fill();
  }

  // ===== Labels X (timestamps) =====
  ctx.fillStyle = CHART_COLORS.text;
  ctx.font = '0.6rem sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  // Mostra primeiro, meio e último timestamp
  const labelIndices = data.length <= 3
    ? data.map((_, i) => i)
    : [0, Math.floor(data.length / 2), data.length - 1];

  for (const i of labelIndices) {
    if (i === 0) {
      ctx.fillText('Início', mapX(i), mTop + plotH + 6);
    } else {
      const d = data[i];
      if (d.timestamp) {
        const dt = new Date(d.timestamp);
        const label = dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
          + ' ' + dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
        ctx.fillText(label, mapX(i), mTop + plotH + 6);
      }
    }
  }
}

/**
 * Converte uma lista de trades para conteúdo CSV.
 * @param {Array} trades — lista de trades
 * @returns {string} — conteúdo CSV (com header)
 */
export function tradesToCSV(trades) {
  const header = 'Data,Tipo,Mercado,Outcome,Shares,Preço,Total,ID\n';
  const rows = trades.map(t => {
    const dt = new Date(t.timestamp).toLocaleString('pt-BR');
    const side = t.side === 'buy' ? 'Compra' : 'Venda';
    // Escapa aspas no nome do mercado
    const question = `"${(t.marketQuestion || '').replace(/"/g, '""')}"`;
    const price = t.price.toFixed(4);
    const total = (t.totalCost || (t.shares * t.price)).toFixed(2);
    return `${dt},${side},${question},${t.outcome},${t.shares},${price},${total},${t.id}`;
  });
  return header + rows.join('\n');
}

/**
 * Dispara o download de um CSV no navegador.
 * @param {string} csvContent — conteúdo CSV
 * @param {string} filename — nome do arquivo
 */
export function downloadCSV(csvContent, filename = 'polymarket-trades.csv') {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

/**
 * Gera o HTML completo da seção de estatísticas do histórico.
 * @param {Object} stats — retorno de computeStats()
 * @returns {string} — HTML das stat cards
 */
export function renderStatsCards(stats) {
  const winRateColor = stats.winRate >= 50 ? 'pnl-positive' : (stats.sellCount > 0 ? 'pnl-negative' : '');
  const totalPnLColor = stats.totalPnL > 0 ? 'pnl-positive' : (stats.totalPnL < 0 ? 'pnl-negative' : '');

  const bestTradeText = stats.bestTrade
    ? `${formatUSD(stats.bestTrade.pnl)}`
    : '—';
  const worstTradeText = stats.worstTrade
    ? `${formatUSD(stats.worstTrade.pnl)}`
    : '—';

  return `
    <div class="stat-card">
      <span class="stat-label">Total de Trades</span>
      <span class="stat-value">${stats.totalTrades}</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">Volume Total</span>
      <span class="stat-value">${formatUSD(stats.totalVolume)}</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">Ticket Médio</span>
      <span class="stat-value">${formatUSD(stats.avgTicket)}</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">Win Rate</span>
      <span class="stat-value ${winRateColor}">
        ${stats.sellCount > 0 ? stats.winRate.toFixed(1) + '%' : '—'}
      </span>
    </div>
    <div class="stat-card">
      <span class="stat-label">Melhor Trade</span>
      <span class="stat-value pnl-positive">${bestTradeText}</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">Pior Trade</span>
      <span class="stat-value pnl-negative">${worstTradeText}</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">P&L Realizado</span>
      <span class="stat-value ${totalPnLColor}">${formatUSD(stats.totalPnL)}</span>
    </div>
  `;
}

/**
 * Gera o HTML da tabela de trades.
 * @param {Array} trades — lista de trades (mais recente primeiro, já filtrada)
 * @returns {string} — HTML da tabela
 */
export function renderTradesTable(trades) {
  if (!trades || trades.length === 0) {
    return '<p class="empty-msg">Nenhum trade encontrado com os filtros atuais.</p>';
  }

  const header = `
    <table class="history-table">
      <thead>
        <tr>
          <th>Data</th>
          <th>Tipo</th>
          <th>Mercado</th>
          <th>Outcome</th>
          <th class="num">Shares</th>
          <th class="num">Preço</th>
          <th class="num">Total</th>
        </tr>
      </thead>
      <tbody>
  `;

  const rows = trades.map(t => {
    const dt = new Date(t.timestamp);
    const dateStr = dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
      + ' ' + dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const sideLabel = t.side === 'buy' ? 'Compra' : 'Venda';
    const sideClass = t.side === 'buy' ? 'trade-buy' : 'trade-sell';
    const total = t.totalCost || (t.shares * t.price);

    // Trunca pergunta longa
    const question = t.marketQuestion || '—';
    const truncQ = question.length > 45 ? question.substring(0, 45) + '…' : question;

    return `
      <tr>
        <td class="trade-date">${dateStr}</td>
        <td><span class="trade-side-badge ${sideClass}">${sideLabel}</span></td>
        <td class="trade-question" title="${escapeHtmlAttr(question)}">${escapeHtml(truncQ)}</td>
        <td><span class="trade-outcome-badge ${t.outcome === 'Yes' ? 'yes' : 'no'}">${t.outcome}</span></td>
        <td class="num">${t.shares}</td>
        <td class="num">${formatPrice(t.price)}</td>
        <td class="num">${formatUSD(total)}</td>
      </tr>
    `;
  }).join('');

  const footer = '</tbody></table>';
  return header + rows + footer;
}

// ===== Helpers =====
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function escapeHtmlAttr(str) {
  if (!str) return '';
  return str.replace(/"/g, '"').replace(/</g, '<').replace(/>/g, '>');
}
