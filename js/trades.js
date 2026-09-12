// trades.js — Histórico, estatísticas, CSV e gráfico de performance

import { formatUSD, formatPrice } from './utils.js';

export const HISTORY_FILTERS = [
  { value: 'all', label: 'Todos' },
  { value: 'buy', label: 'Compras' },
  { value: 'sell', label: 'Vendas' },
];

const CHART_COLORS = {
  line: '#3b82f6', lineFill: 'rgba(59, 130, 246, 0.12)', lineFillBelow: 'rgba(59, 130, 246, 0.04)',
  grid: 'rgba(139, 145, 158, 0.1)', axis: 'rgba(139, 145, 158, 0.3)', text: '#8b919e',
  dotBuy: '#22c55e', dotSell: '#ef4444',
};

const tradeTotal = (t) => {
  const explicit = Number(t?.totalCost);
  if (Number.isFinite(explicit)) return explicit;
  const shares = Number(t?.shares);
  const price = Number(t?.price);
  return Number.isFinite(shares) && Number.isFinite(price) ? shares * price : 0;
};

const tradeKey = (t) => `${String(t?.marketId ?? '')}|${String(t?.outcome ?? '')}`;

export function filterTrades(trades, filter) {
  const safe = Array.isArray(trades) ? trades : [];
  if (!filter || filter === 'all') return safe;
  return safe.filter(t => t.side === filter);
}

export function computeStats(trades) {
  const chrono = (Array.isArray(trades) ? [...trades] : [])
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

  if (chrono.length === 0) {
    return { totalTrades: 0, totalBuys: 0, totalSells: 0, totalVolume: 0, winRate: 0,
      bestTrade: null, worstTrade: null, avgTicket: 0, totalPnL: 0, sellCount: 0 };
  }

  let totalVolume = 0;
  let totalBuys = 0;
  let totalSells = 0;
  const sellPnLs = [];
  const basis = new Map();

  for (const t of chrono) {
    const total = Math.max(0, tradeTotal(t));
    totalVolume += total;
    const shares = Math.max(0, Number(t.shares) || 0);
    const key = tradeKey(t);

    if (t.side === 'buy') {
      totalBuys++;
      const prev = basis.get(key) || { cost: 0, shares: 0 };
      prev.cost += total;
      prev.shares += shares;
      basis.set(key, prev);
    } else if (t.side === 'sell') {
      totalSells++;
      const pos = basis.get(key);
      if (!pos || pos.shares <= 0 || shares <= 0) continue;
      const soldShares = Math.min(shares, pos.shares);
      const avgCost = pos.cost / pos.shares;
      const costPortion = avgCost * soldShares;
      const proceeds = shares > 0 ? total * (soldShares / shares) : 0;
      const pnl = proceeds - costPortion;
      sellPnLs.push({ trade: t, pnl });
      pos.cost = Math.max(0, pos.cost - costPortion);
      pos.shares = Math.max(0, pos.shares - soldShares);
      basis.set(key, pos);
    }
  }

  const winners = sellPnLs.filter(s => s.pnl > 0).length;
  const bestTrade = sellPnLs.reduce((best, item) => !best || item.pnl > best.pnl ? item : best, null);
  const worstTrade = sellPnLs.reduce((worst, item) => !worst || item.pnl < worst.pnl ? item : worst, null);
  const totalPnL = sellPnLs.reduce((sum, s) => sum + s.pnl, 0);

  return {
    totalTrades: chrono.length,
    totalBuys,
    totalSells,
    totalVolume,
    winRate: sellPnLs.length ? (winners / sellPnLs.length) * 100 : 0,
    bestTrade,
    worstTrade,
    avgTicket: totalVolume / chrono.length,
    totalPnL,
    sellCount: sellPnLs.length,
  };
}

/**
 * Reconstrói equity usando custo-base das posições abertas. Sem snapshots de preço
 * históricos não é possível marcar posições a mercado no passado; portanto a curva
 * mostra P&L realizado sem inventar preços intermediários.
 */
export function buildEquityCurve(trades, initialBalance) {
  const start = Number(initialBalance);
  const safeInitial = Number.isFinite(start) ? start : 0;
  const chrono = (Array.isArray(trades) ? [...trades] : [])
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  const points = [{ timestamp: null, equity: safeInitial, balance: safeInitial, action: 'start' }];
  if (!chrono.length) return points;

  let balance = safeInitial;
  const basis = new Map();

  for (const t of chrono) {
    const total = Math.max(0, tradeTotal(t));
    const shares = Math.max(0, Number(t.shares) || 0);
    const key = tradeKey(t);

    if (t.side === 'buy') {
      balance -= total;
      const pos = basis.get(key) || { cost: 0, shares: 0 };
      pos.cost += total;
      pos.shares += shares;
      basis.set(key, pos);
    } else if (t.side === 'sell') {
      balance += total;
      const pos = basis.get(key);
      if (pos && pos.shares > 0 && shares > 0) {
        const soldShares = Math.min(shares, pos.shares);
        const costPortion = (pos.cost / pos.shares) * soldShares;
        pos.cost = Math.max(0, pos.cost - costPortion);
        pos.shares = Math.max(0, pos.shares - soldShares);
        basis.set(key, pos);
      }
    }

    const openCostBasis = [...basis.values()].reduce((sum, p) => sum + p.cost, 0);
    points.push({ timestamp: t.timestamp, equity: balance + openCostBasis, balance, action: t.side });
  }
  return points;
}

export function drawPerformanceChart(canvas, data, initialBalance) {
  if (!canvas?.getContext) return;
  const ctx = canvas.getContext('2d');
  const safeData = Array.isArray(data) && data.length ? data : [{ equity: initialBalance, action: 'start' }];
  const dpr = globalThis.window?.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600;
  const cssH = canvas.clientHeight || 220;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);

  const left = 56, right = 16, top = 16, bottom = 30;
  const plotW = Math.max(1, cssW - left - right);
  const plotH = Math.max(1, cssH - top - bottom);
  const values = safeData.map(d => Number(d.equity) || 0);
  let minY = Math.min(...values, initialBalance);
  let maxY = Math.max(...values, initialBalance);
  const range = maxY - minY || 1;
  minY -= range * 0.05;
  maxY += range * 0.05;
  const x = i => left + (safeData.length > 1 ? i * plotW / (safeData.length - 1) : plotW / 2);
  const y = value => top + plotH - ((value - minY) / (maxY - minY)) * plotH;

  ctx.strokeStyle = CHART_COLORS.grid;
  ctx.fillStyle = CHART_COLORS.text;
  ctx.font = '0.65rem sans-serif';
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (let i = 0; i <= 4; i++) {
    const value = minY + (maxY - minY) * i / 4;
    const py = y(value);
    ctx.beginPath(); ctx.moveTo(left, py); ctx.lineTo(left + plotW, py); ctx.stroke();
    ctx.fillText('$' + value.toFixed(0), left - 6, py);
  }

  ctx.strokeStyle = CHART_COLORS.axis;
  ctx.setLineDash([4, 4]);
  ctx.beginPath(); ctx.moveTo(left, y(initialBalance)); ctx.lineTo(left + plotW, y(initialBalance)); ctx.stroke();
  ctx.setLineDash([]);

  if (safeData.length === 1) {
    ctx.fillStyle = CHART_COLORS.line;
    ctx.beginPath(); ctx.arc(x(0), y(safeData[0].equity), 4, 0, Math.PI * 2); ctx.fill();
    return;
  }

  ctx.beginPath();
  ctx.moveTo(x(0), y(safeData[0].equity));
  for (let i = 1; i < safeData.length; i++) ctx.lineTo(x(i), y(safeData[i].equity));
  ctx.lineTo(x(safeData.length - 1), y(minY)); ctx.lineTo(x(0), y(minY)); ctx.closePath();
  const grad = ctx.createLinearGradient(0, top, 0, top + plotH);
  grad.addColorStop(0, CHART_COLORS.lineFill); grad.addColorStop(1, CHART_COLORS.lineFillBelow);
  ctx.fillStyle = grad; ctx.fill();

  ctx.strokeStyle = CHART_COLORS.line; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x(0), y(safeData[0].equity));
  for (let i = 1; i < safeData.length; i++) ctx.lineTo(x(i), y(safeData[i].equity));
  ctx.stroke();

  for (let i = 1; i < safeData.length; i++) {
    ctx.fillStyle = safeData[i].action === 'buy' ? CHART_COLORS.dotBuy : CHART_COLORS.dotSell;
    ctx.beginPath(); ctx.arc(x(i), y(safeData[i].equity), 3, 0, Math.PI * 2); ctx.fill();
  }

  // Mantém orientação temporal do gráfico sem poluir quando há muitos pontos.
  ctx.fillStyle = CHART_COLORS.text;
  ctx.font = '0.6rem sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  const labelIndices = safeData.length <= 3
    ? safeData.map((_, i) => i)
    : [0, Math.floor(safeData.length / 2), safeData.length - 1];
  for (const i of labelIndices) {
    if (i === 0 || !safeData[i].timestamp) {
      ctx.fillText('Início', x(i), top + plotH + 6);
      continue;
    }
    const dt = new Date(safeData[i].timestamp);
    const label = dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' +
      dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    ctx.fillText(label, x(i), top + plotH + 6);
  }
}

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function tradesToCSV(trades) {
  const header = 'Data,Tipo,Mercado,Outcome,Shares,Preço,Total,ID\n';
  const rows = (Array.isArray(trades) ? trades : []).map(t => [
    new Date(t.timestamp).toLocaleString('pt-BR'),
    t.side === 'buy' ? 'Compra' : 'Venda',
    t.marketQuestion || '', t.outcome || '', t.shares ?? '',
    Number(t.price).toFixed(4), tradeTotal(t).toFixed(2), t.id || ''
  ].map(csvCell).join(','));
  return header + rows.join('\n');
}

export function downloadCSV(csvContent, filename = 'polymarket-trades.csv') {
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.style.display = 'none';
  document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
}

export function renderStatsCards(stats) {
  const winRateColor = stats.winRate >= 50 ? 'pnl-positive' : (stats.sellCount > 0 ? 'pnl-negative' : '');
  const pnlColor = stats.totalPnL > 0 ? 'pnl-positive' : (stats.totalPnL < 0 ? 'pnl-negative' : '');
  const best = stats.bestTrade ? formatUSD(stats.bestTrade.pnl) : '—';
  const worst = stats.worstTrade ? formatUSD(stats.worstTrade.pnl) : '—';
  return `
    <div class="stat-card"><span class="stat-label">Total de Trades</span><span class="stat-value">${stats.totalTrades}</span></div>
    <div class="stat-card"><span class="stat-label">Volume Total</span><span class="stat-value">${formatUSD(stats.totalVolume)}</span></div>
    <div class="stat-card"><span class="stat-label">Ticket Médio</span><span class="stat-value">${formatUSD(stats.avgTicket)}</span></div>
    <div class="stat-card"><span class="stat-label">Win Rate</span><span class="stat-value ${winRateColor}">${stats.sellCount > 0 ? stats.winRate.toFixed(1) + '%' : '—'}</span></div>
    <div class="stat-card"><span class="stat-label">Melhor Trade</span><span class="stat-value pnl-positive">${best}</span></div>
    <div class="stat-card"><span class="stat-label">Pior Trade</span><span class="stat-value pnl-negative">${worst}</span></div>
    <div class="stat-card"><span class="stat-label">P&L Realizado</span><span class="stat-value ${pnlColor}">${formatUSD(stats.totalPnL)}</span></div>`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

export function renderTradesTable(trades) {
  const safe = Array.isArray(trades) ? trades : [];
  if (!safe.length) return '<p class="empty-msg">Nenhum trade encontrado com os filtros atuais.</p>';
  const rows = safe.map(t => {
    const dt = new Date(t.timestamp);
    const dateStr = dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' +
      dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const sideLabel = t.side === 'buy' ? 'Compra' : 'Venda';
    const sideClass = t.side === 'buy' ? 'trade-buy' : 'trade-sell';
    const question = String(t.marketQuestion || '—');
    const truncQ = question.length > 45 ? question.substring(0, 45) + '…' : question;
    const outcome = String(t.outcome || '—');
    return `<tr>
      <td class="trade-date">${escapeHtml(dateStr)}</td>
      <td><span class="trade-side-badge ${sideClass}">${sideLabel}</span></td>
      <td class="trade-question" title="${escapeHtml(question)}">${escapeHtml(truncQ)}</td>
      <td><span class="trade-outcome-badge ${outcome === 'Yes' ? 'yes' : 'no'}">${escapeHtml(outcome)}</span></td>
      <td class="num">${escapeHtml(t.shares)}</td><td class="num">${formatPrice(t.price)}</td><td class="num">${formatUSD(tradeTotal(t))}</td>
    </tr>`;
  }).join('');
  return `<table class="history-table"><thead><tr><th>Data</th><th>Tipo</th><th>Mercado</th><th>Outcome</th><th class="num">Shares</th><th class="num">Preço</th><th class="num">Total</th></tr></thead><tbody>${rows}</tbody></table>`;
}
