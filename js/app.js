// app.js — interface principal do Polymarket Trader

import { formatUSD, formatPercent, formatPrice } from './utils.js';
import { fetchMarkets, refreshPrices, clearCache } from './api.js';
import {
  init as initWallet,
  getBalance,
  getWallet,
  buy as walletBuy,
  sell as walletSell,
  reset as walletReset,
  getPositions,
  getPosition,
  getTrades,
} from './wallet.js';
import {
  computePortfolioSummary,
  getAllocationData,
  drawAllocationPie,
  renderAllocationLegend,
  renderPositionCards,
} from './portfolio.js';
import {
  filterTrades,
  computeStats,
  buildEquityCurve,
  drawPerformanceChart,
  renderStatsCards,
  renderTradesTable,
  tradesToCSV,
  downloadCSV,
} from './trades.js';
import {
  getConfig as getBotConfig,
  saveConfig as saveBotConfig,
  resetConfig as resetBotConfig,
  getLog as getBotLog,
  clearLog as clearBotLog,
  getBotStats,
  getRiskState as getBotRiskState,
  start as botStart,
  stop as botStop,
  emergencyStop as botEmergencyStop,
  isRunning as botIsRunning,
  resetTickCount,
  getTickCount,
} from './bot.js';
import { recordMarketSnapshots, drawMarketSparkline } from './market-history.js';

const AUTO_REFRESH_MS = 60_000;

const state = {
  markets: [],
  filteredMarkets: [],
  activeTab: 'markets',
  searchQuery: '',
  categoryFilter: '',
  dataSource: 'sample',
  lastUpdate: null,
  autoRefreshHandle: null,
  buyContext: null,
  sellContext: null,
  historyFilter: 'all',
};

async function init() {
  initWallet();
  bindEvents();
  bindTradeModals();
  bindHistoryEvents();
  bindKeyboardShortcuts();
  bindBotEvents();
  await loadMarkets();
  renderHeader();
  renderMarkets();
  renderBotPanel();
  startAutoRefresh();
}

function startAutoRefresh() {
  stopAutoRefresh();
  state.autoRefreshHandle = setInterval(async () => {
    if (state.activeTab !== 'markets' || document.hidden) return;
    await updatePrices();
  }, AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
  if (!state.autoRefreshHandle) return;
  clearInterval(state.autoRefreshHandle);
  state.autoRefreshHandle = null;
}

async function updatePrices() {
  const updated = await refreshPrices();
  if (!updated) {
    updateRefreshIndicator(true);
    return false;
  }
  recordMarketSnapshots(state.markets);
  state.lastUpdate = new Date();
  state.dataSource = 'api';
  updateRefreshIndicator();
  renderMarketsPricesOnly();
  showToast('Preços atualizados', 'success');
  return true;
}

function bindEvents() {
  document.querySelectorAll('.tab').forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

  document.getElementById('market-search')?.addEventListener('input', event => {
    state.searchQuery = String(event.target.value || '').toLowerCase();
    renderMarkets();
  });

  document.getElementById('market-filter')?.addEventListener('change', event => {
    state.categoryFilter = event.target.value || '';
    renderMarkets();
  });

  const btnRefresh = document.getElementById('btn-refresh-prices');
  btnRefresh?.addEventListener('click', async () => {
    btnRefresh.disabled = true;
    btnRefresh.textContent = '⟳ Atualizando...';
    try {
      await updatePrices();
    } finally {
      btnRefresh.disabled = false;
      btnRefresh.textContent = '⟳ Atualizar preços';
    }
  });

  document.getElementById('btn-reset')?.addEventListener('click', () => {
    document.getElementById('modal-reset').style.display = 'flex';
  });
  document.getElementById('reset-cancel')?.addEventListener('click', () => {
    document.getElementById('modal-reset').style.display = 'none';
  });
  document.getElementById('reset-confirm')?.addEventListener('click', () => {
    if (botIsRunning()) botStop();
    walletReset();
    clearCache();
    clearBotLog();
    document.getElementById('modal-reset').style.display = 'none';
    renderHeader();
    renderPortfolio();
    renderHistory();
    renderBotPanel();
    renderBotLog();
    loadMarkets().then(() => {
      renderMarkets();
      renderHeader();
    });
    showToast('Carteira reiniciada! Saldo: $1,000.00', 'info');
  });

  const resetModal = document.getElementById('modal-reset');
  resetModal?.addEventListener('click', event => {
    if (event.target === resetModal) resetModal.style.display = 'none';
  });
  const buyModal = document.getElementById('modal-buy');
  buyModal?.addEventListener('click', event => {
    if (event.target === buyModal) closeBuyModal();
  });
  const sellModal = document.getElementById('modal-sell');
  sellModal?.addEventListener('click', event => {
    if (event.target === sellModal) closeSellModal();
  });
}

function switchTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll('.tab').forEach(tab => {
    const active = tab.dataset.tab === tabName;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-content').forEach(content => content.classList.toggle('active', content.id === `tab-${tabName}`));
  if (tabName === 'portfolio') renderPortfolio();
  if (tabName === 'history') renderHistory();
  if (tabName === 'bot') {
    renderBotPanel();
    renderBotLog();
  }
}

async function loadMarkets() {
  const loading = document.getElementById('markets-loading');
  const list = document.getElementById('markets-list');
  try {
    if (loading) {
      loading.style.display = 'grid';
      loading.innerHTML = renderSkeletons(6);
    }
    if (list) list.style.display = 'none';
    const markets = await fetchMarkets({ limit: 50 });
    state.markets = markets;
    state.filteredMarkets = [...markets];
    state.lastUpdate = new Date();
    recordMarketSnapshots(markets);

    if (markets.length) {
      try {
        const response = await fetch('data/sample-markets.json');
        if (response.ok) {
          const sample = await response.json();
          const sampleIds = new Set(sample.map(m => String(m.id)));
          state.dataSource = sampleIds.has(String(markets[0]?.id)) ? 'sample' : 'api';
        } else state.dataSource = 'api';
      } catch {
        state.dataSource = 'api';
      }
    }
    updateRefreshIndicator();
  } catch (error) {
    console.error('Erro ao carregar mercados:', error);
    state.markets = [];
    state.filteredMarkets = [];
    showToast('Erro ao carregar mercados. Verifique a conexão.', 'error');
  } finally {
    if (loading) loading.style.display = 'none';
    if (list) list.style.display = 'grid';
  }
}

function updateRefreshIndicator(error = false) {
  const indicator = document.getElementById('refresh-indicator');
  if (!indicator) return;
  const time = state.lastUpdate
    ? state.lastUpdate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';
  const source = { api: '🟢 Gamma API', sample: '🟡 Dados de exemplo', 'cache-stale': '🟠 Cache (offline)' }[state.dataSource] || '—';
  indicator.innerHTML = error
    ? '<span class="ri-error">🔴 Falha ao atualizar</span>'
    : `<span class="ri-source">${source}</span><span class="ri-time">atualizado às ${time}</span><span class="ri-history">histórico local ativo</span>`;
}

function filterMarkets() {
  state.filteredMarkets = state.markets.filter(market => {
    const question = String(market.question || '').toLowerCase();
    return (!state.searchQuery || question.includes(state.searchQuery)) &&
      (!state.categoryFilter || market.category === state.categoryFilter);
  });
}

function renderHeader() {
  const wallet = getWallet();
  const summary = computePortfolioSummary(state.markets);
  const balance = document.getElementById('header-balance');
  const pnl = document.getElementById('header-pnl');
  if (balance) balance.textContent = formatUSD(wallet.balance);
  const pnlValue = summary.totalEquity - wallet.initialBalance;
  const pnlPercent = wallet.initialBalance > 0 ? pnlValue / wallet.initialBalance * 100 : 0;
  if (pnl) {
    pnl.textContent = `${formatUSD(pnlValue)} (${formatPercent(pnlPercent)})`;
    pnl.classList.remove('positive', 'negative');
    if (pnlValue > 0) pnl.classList.add('positive');
    else if (pnlValue < 0) pnl.classList.add('negative');
  }
}

function renderMarketsPricesOnly() {
  const list = document.getElementById('markets-list');
  if (!list || !state.markets.length) return;
  const marketMap = new Map(state.markets.map(market => [String(market.id), market]));
  list.querySelectorAll('.market-card').forEach(card => {
    const market = marketMap.get(card.dataset.marketId);
    if (!market) return;
    const yes = market.outcomes.find(o => o.name === 'Yes') || market.outcomes[0];
    const no = market.outcomes.find(o => o.name === 'No') || market.outcomes[1];
    const yesPrice = card.querySelector('.outcome-btn.yes .outcome-price');
    const noPrice = card.querySelector('.outcome-btn.no .outcome-price');
    if (yesPrice) yesPrice.textContent = formatPrice(yes?.price);
    if (noPrice) noPrice.textContent = formatPrice(no?.price);
    const meta = card.querySelector('.market-meta');
    if (meta) meta.innerHTML = marketMetaHtml(market);
  });
  renderMarketCharts();
  renderHeader();
  if (state.activeTab === 'portfolio') renderPortfolio();
  if (state.activeTab === 'bot') renderBotStats();
}

function marketMetaHtml(market) {
  const volume = Number(market.volume) || 0;
  const volumeStr = volume >= 1_000_000
    ? '$' + (volume / 1_000_000).toFixed(2) + 'M'
    : volume >= 1_000 ? '$' + (volume / 1_000).toFixed(1) + 'K' : '$' + volume.toFixed(2);
  return `<span>Vol: ${volumeStr}</span><span>Liq: $${(Number(market.liquidity) || 0).toFixed(0)}</span>`;
}

function renderMarkets() {
  filterMarkets();
  const list = document.getElementById('markets-list');
  const empty = document.getElementById('markets-empty');
  if (!list) return;
  if (!state.filteredMarkets.length) {
    list.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';
  list.innerHTML = state.filteredMarkets.map(renderMarketCard).join('');
  list.querySelectorAll('.outcome-btn').forEach(button => button.addEventListener('click', () => openBuyModal(button.dataset.marketId, button.dataset.outcome)));
  renderMarketCharts();
}

function renderMarketCard(market) {
  const yes = market.outcomes.find(o => o.name === 'Yes') || market.outcomes[0];
  const no = market.outcomes.find(o => o.name === 'No') || market.outcomes[1];
  const id = escapeHtml(market.id);
  return `
    <article class="market-card" data-market-id="${id}">
      <div class="market-card-top">
        <p class="market-question">${escapeHtml(market.question)}</p>
        <span class="market-category">${escapeHtml(market.category || 'general')}</span>
      </div>
      <div class="market-sparkline-wrap">
        <canvas class="market-sparkline" data-market-chart="${id}" role="img" aria-label="Histórico local dos preços Yes e No"></canvas>
        <div class="market-chart-legend"><span class="yes">Yes</span><span class="no">No</span></div>
      </div>
      <div class="market-outcomes">
        <button class="outcome-btn yes" data-market-id="${id}" data-outcome="Yes"><span class="outcome-name">Yes</span><span class="outcome-price">${formatPrice(yes?.price)}</span></button>
        <button class="outcome-btn no" data-market-id="${id}" data-outcome="No"><span class="outcome-name">No</span><span class="outcome-price">${formatPrice(no?.price)}</span></button>
      </div>
      <div class="market-meta">${marketMetaHtml(market)}</div>
    </article>`;
}

function renderMarketCharts() {
  document.querySelectorAll('.market-sparkline[data-market-chart]').forEach(canvas => {
    drawMarketSparkline(canvas, canvas.dataset.marketChart);
  });
}

function openBuyModal(marketId, outcome) {
  const market = state.markets.find(m => String(m.id) === String(marketId));
  if (!market) return showToast('Mercado não encontrado', 'error');
  const outcomeObj = market.outcomes.find(o => o.name === outcome) || market.outcomes[0];
  if (!outcomeObj) return showToast('Outcome não disponível', 'error');
  state.buyContext = { marketId: String(marketId), marketQuestion: market.question, outcome: outcomeObj.name, price: outcomeObj.price };
  document.getElementById('buy-market-question').textContent = market.question;
  const outcomeDisplay = document.getElementById('buy-outcome-display');
  outcomeDisplay.textContent = outcomeObj.name;
  outcomeDisplay.classList.remove('yes', 'no');
  outcomeDisplay.classList.add(outcomeObj.name === 'Yes' ? 'yes' : 'no');
  document.getElementById('buy-price-display').textContent = formatPrice(outcomeObj.price);
  const sharesInput = document.getElementById('buy-shares-input');
  sharesInput.value = 10;
  const existing = getPosition(marketId, outcomeObj.name);
  const tag = document.getElementById('buy-position-tag');
  if (existing) {
    tag.style.display = 'inline-block';
    tag.textContent = `Você já tem ${existing.shares} shares a ${formatPrice(existing.avgPrice)}`;
  } else tag.style.display = 'none';
  updateBuyPreview();
  document.getElementById('modal-buy').style.display = 'flex';
  setTimeout(() => { sharesInput.focus(); sharesInput.select(); }, 50);
}

function updateBuyPreview() {
  if (!state.buyContext) return;
  const shares = Math.max(0, Math.floor(Number(document.getElementById('buy-shares-input').value) || 0));
  const cost = shares * state.buyContext.price;
  const balance = getBalance();
  const after = balance - cost;
  document.getElementById('buy-cost-display').textContent = formatUSD(cost);
  const afterEl = document.getElementById('buy-balance-after');
  afterEl.textContent = formatUSD(after);
  afterEl.style.color = after < 0 ? 'var(--red)' : 'var(--text-primary)';
  const warning = document.getElementById('buy-warning');
  const confirm = document.getElementById('buy-confirm');
  if (cost > balance || shares <= 0) {
    warning.style.display = 'block';
    warning.textContent = cost > balance
      ? `Saldo insuficiente. Você precisa de ${formatUSD(cost)}, mas tem ${formatUSD(balance)}.`
      : 'Quantidade deve ser maior que zero.';
    confirm.disabled = true;
  } else {
    warning.style.display = 'none';
    confirm.disabled = false;
  }
}

function closeBuyModal() {
  document.getElementById('modal-buy').style.display = 'none';
  state.buyContext = null;
}

function confirmBuy() {
  if (!state.buyContext) return;
  const shares = Math.max(0, Math.floor(Number(document.getElementById('buy-shares-input').value) || 0));
  if (shares <= 0) return showToast('Quantidade inválida', 'error');
  const result = walletBuy({ ...state.buyContext, shares });
  if (!result.success) {
    const warning = document.getElementById('buy-warning');
    warning.style.display = 'block';
    warning.textContent = result.message;
    return showToast(result.message, 'error');
  }
  closeBuyModal();
  renderHeader();
  renderPortfolio();
  renderBotStats();
  if (state.activeTab === 'history') renderHistory();
  showToast(result.message, 'success');
}

function openSellModal(marketId, outcome) {
  const position = getPosition(marketId, outcome);
  if (!position) return showToast('Posição não encontrada', 'error');
  const market = state.markets.find(m => String(m.id) === String(marketId));
  const outcomeObj = market?.outcomes.find(o => o.name === outcome);
  const currentPrice = outcomeObj?.price ?? position.avgPrice;
  state.sellContext = { marketId: String(marketId), marketQuestion: position.marketQuestion, outcome, price: currentPrice, avgPrice: position.avgPrice, shares: position.shares };
  document.getElementById('sell-market-question').textContent = position.marketQuestion;
  document.getElementById('sell-position-tag').textContent = `${position.shares} shares — posição aberta`;
  const outcomeDisplay = document.getElementById('sell-outcome-display');
  outcomeDisplay.textContent = outcome;
  outcomeDisplay.classList.remove('yes', 'no');
  outcomeDisplay.classList.add(outcome === 'Yes' ? 'yes' : 'no');
  document.getElementById('sell-price-display').textContent = formatPrice(currentPrice);
  document.getElementById('sell-avg-price').textContent = formatPrice(position.avgPrice);
  const sharesInput = document.getElementById('sell-shares-input');
  sharesInput.value = position.shares;
  sharesInput.max = position.shares;
  updateSellPreview();
  document.getElementById('modal-sell').style.display = 'flex';
  setTimeout(() => { sharesInput.focus(); sharesInput.select(); }, 50);
}

function updateSellPreview() {
  if (!state.sellContext) return;
  const shares = Math.max(0, Math.floor(Number(document.getElementById('sell-shares-input').value) || 0));
  const totalReturn = shares * state.sellContext.price;
  const pnl = (state.sellContext.price - state.sellContext.avgPrice) * shares;
  const pnlPercent = state.sellContext.avgPrice > 0 ? (state.sellContext.price - state.sellContext.avgPrice) / state.sellContext.avgPrice * 100 : 0;
  document.getElementById('sell-return-display').textContent = formatUSD(totalReturn);
  const pnlEl = document.getElementById('sell-pnl-display');
  pnlEl.textContent = `${formatUSD(pnl)} (${formatPercent(pnlPercent)})`;
  pnlEl.classList.remove('positive', 'negative');
  if (pnl > 0) pnlEl.classList.add('positive');
  else if (pnl < 0) pnlEl.classList.add('negative');
  const warning = document.getElementById('sell-warning');
  const confirm = document.getElementById('sell-confirm');
  if (shares <= 0 || shares > state.sellContext.shares) {
    warning.style.display = 'block';
    warning.textContent = shares <= 0 ? 'Quantidade deve ser maior que zero.' : `Você só tem ${state.sellContext.shares} shares dessa posição.`;
    confirm.disabled = true;
  } else {
    warning.style.display = 'none';
    confirm.disabled = false;
  }
}

function closeSellModal() {
  document.getElementById('modal-sell').style.display = 'none';
  state.sellContext = null;
}

function confirmSell() {
  if (!state.sellContext) return;
  const shares = Math.max(0, Math.floor(Number(document.getElementById('sell-shares-input').value) || 0));
  if (shares <= 0) return showToast('Quantidade inválida', 'error');
  const { marketId, outcome, price } = state.sellContext;
  const result = walletSell({ marketId, outcome, shares, price });
  if (!result.success) {
    const warning = document.getElementById('sell-warning');
    warning.style.display = 'block';
    warning.textContent = result.message;
    return showToast(result.message, 'error');
  }
  closeSellModal();
  renderHeader();
  renderPortfolio();
  renderBotStats();
  if (state.activeTab === 'history') renderHistory();
  showToast(result.message, 'success');
}

function bindTradeModals() {
  document.getElementById('buy-cancel')?.addEventListener('click', closeBuyModal);
  document.getElementById('buy-confirm')?.addEventListener('click', confirmBuy);
  document.getElementById('buy-shares-input')?.addEventListener('input', updateBuyPreview);
  document.getElementById('sell-cancel')?.addEventListener('click', closeSellModal);
  document.getElementById('sell-confirm')?.addEventListener('click', confirmSell);
  document.getElementById('sell-shares-input')?.addEventListener('input', updateSellPreview);
}

function renderPortfolio() {
  const positions = getPositions();
  const list = document.getElementById('positions-list');
  const empty = document.getElementById('portfolio-empty');
  const chart = document.getElementById('port-chart-section');
  if (!list) return;
  const summary = computePortfolioSummary(state.markets);
  document.getElementById('port-open-positions').textContent = summary.openCount;
  document.getElementById('port-invested').textContent = formatUSD(summary.invested);
  document.getElementById('port-current-value').textContent = formatUSD(summary.currentValue);
  const pnl = document.getElementById('port-unrealized-pnl');
  pnl.textContent = `${formatUSD(summary.unrealizedPnl)} (${formatPercent(summary.unrealizedPnlPercent)})`;
  pnl.classList.remove('pnl-positive', 'pnl-negative');
  if (summary.unrealizedPnl > 0) pnl.classList.add('pnl-positive');
  else if (summary.unrealizedPnl < 0) pnl.classList.add('pnl-negative');
  document.getElementById('port-total-equity').textContent = formatUSD(summary.totalEquity);

  if (!positions.length) {
    list.innerHTML = '';
    if (empty) empty.style.display = 'block';
    if (chart) chart.style.display = 'none';
    return;
  }
  if (empty) empty.style.display = 'none';
  if (chart) chart.style.display = 'flex';
  list.innerHTML = renderPositionCards(state.markets);
  list.querySelectorAll('.position-sell-btn').forEach(button => button.addEventListener('click', () => openSellModal(button.dataset.marketId, button.dataset.outcome)));
  const allocation = getAllocationData(state.markets);
  drawAllocationPie(document.getElementById('port-allocation-canvas'), allocation, summary.currentValue);
  renderAllocationLegend(document.getElementById('port-allocation-legend'), allocation);
}

function renderHistory() {
  const trades = getTrades();
  const wallet = getWallet();
  const stats = document.getElementById('history-stats-top');
  const chart = document.getElementById('history-chart-section');
  const table = document.getElementById('history-table-container');
  const empty = document.getElementById('history-empty');
  if (!trades.length) {
    if (stats) stats.innerHTML = '';
    if (chart) chart.style.display = 'none';
    if (table) table.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';
  if (chart) chart.style.display = 'flex';
  const chronological = [...trades].reverse();
  if (stats) stats.innerHTML = renderStatsCards(computeStats(chronological));
  drawPerformanceChart(document.getElementById('history-performance-canvas'), buildEquityCurve(chronological, wallet.initialBalance), wallet.initialBalance);
  if (table) table.innerHTML = renderTradesTable(filterTrades(trades, state.historyFilter));
}

function bindHistoryEvents() {
  document.querySelectorAll('.history-filter-btn').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.history-filter-btn').forEach(item => item.classList.remove('active'));
    button.classList.add('active');
    state.historyFilter = button.dataset.filter;
    renderHistory();
  }));

  document.getElementById('btn-export-csv')?.addEventListener('click', () => {
    const trades = getTrades();
    if (!trades.length) return showToast('Nenhum trade para exportar', 'info');
    downloadCSV(tradesToCSV(trades), `polymarket-trades-${new Date().toISOString().split('T')[0]}.csv`);
    showToast(`CSV exportado com ${trades.length} trades`, 'success');
  });
}

function renderBotPanel() {
  const config = getBotConfig();
  const values = {
    'bot-strategy': config.strategy,
    'bot-por-trade': config.porTrade,
    'bot-max-positions': config.maxOpenPositions,
    'bot-min-price': Math.round(config.minPriceToBuy * 100),
    'bot-max-price': Math.round(config.maxPriceToBuy * 100),
    'bot-profit-target': config.profitTarget,
    'bot-stop-loss': config.stopLoss,
    'bot-interval': Math.round(config.intervalMs / 1000),
    'bot-max-daily-loss': config.maxDailyLossPct,
    'bot-max-market-exposure': config.maxMarketExposurePct,
    'bot-max-position': config.maxPositionPct,
    'bot-cooldown-loss': config.cooldownAfterLossMin,
  };
  for (const [id, value] of Object.entries(values)) {
    const element = document.getElementById(id);
    if (element) element.value = value;
  }
  updateBotStatusUI();
  renderBotStats();
}

function updateBotStatusUI() {
  const running = botIsRunning();
  document.getElementById('bot-status-indicator')?.classList.toggle('running', running);
  const dot = document.getElementById('bot-status-dot');
  const text = document.getElementById('bot-status-text');
  const toggle = document.getElementById('btn-bot-toggle');
  const tick = document.getElementById('bot-tick-count');
  if (dot) dot.textContent = running ? '🟢' : '⚫';
  if (text) text.textContent = running ? 'Rodando...' : 'Desligado';
  if (toggle) {
    toggle.textContent = running ? '⏹ Parar Bot' : '▶ Ligar Bot';
    toggle.classList.toggle('running', running);
  }
  if (tick) tick.textContent = getTickCount();
}

function renderBotStats() {
  const stats = getBotStats();
  const risk = getBotRiskState(state.markets, getBotConfig());
  const container = document.getElementById('bot-stats-top');
  if (!container) return;
  const riskLabel = risk.dailyLossBreached ? 'BLOQUEADO' : risk.inCooldown ? 'COOLDOWN' : 'NORMAL';
  const riskClass = risk.dailyLossBreached || risk.inCooldown ? 'pnl-negative' : 'pnl-positive';
  const cooldown = risk.inCooldown ? `${Math.ceil(risk.cooldownRemainingMs / 60_000)} min` : '—';
  container.innerHTML = `
    <div class="stat-card"><span class="stat-label">Ações do Bot</span><span class="stat-value">${stats.totalActions}</span></div>
    <div class="stat-card"><span class="stat-label">Compras / Vendas</span><span class="stat-value">${stats.totalBuys} / ${stats.totalSells}</span></div>
    <div class="stat-card"><span class="stat-label">P&L Realizado Hoje</span><span class="stat-value ${risk.dailyRealizedPnl < 0 ? 'pnl-negative' : risk.dailyRealizedPnl > 0 ? 'pnl-positive' : ''}">${formatUSD(risk.dailyRealizedPnl)}</span></div>
    <div class="stat-card"><span class="stat-label">Limite Diário</span><span class="stat-value">-${formatUSD(risk.dailyLossLimit)}</span></div>
    <div class="stat-card"><span class="stat-label">Cooldown</span><span class="stat-value">${cooldown}</span></div>
    <div class="stat-card risk-card"><span class="stat-label">Risco</span><span class="stat-value ${riskClass}">${riskLabel}</span></div>`;
}

function renderBotLog() {
  const log = getBotLog(100);
  const container = document.getElementById('bot-log-container');
  const empty = document.getElementById('bot-log-empty');
  if (!container) return;
  if (!log.length) {
    container.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';
  container.innerHTML = log.map(entry => {
    const date = new Date(entry.timestamp);
    const time = date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const isBuy = entry.action === 'buy';
    const isRisk = entry.action === 'risk-stop';
    const label = isRisk ? 'Risco' : isBuy ? 'Compra' : 'Venda';
    const cssClass = isRisk ? 'risk' : isBuy ? 'buy' : 'sell';
    const market = String(entry.market || entry.marketQuestion || '—');
    const shortMarket = market.length > 50 ? market.slice(0, 50) + '…' : market;
    const metric = entry.shares != null ? `${entry.shares} shares @ ${formatPrice(entry.price)} → ${formatUSD(entry.shares * entry.price)}` : '';
    const pnl = Number.isFinite(Number(entry.pnl)) ? ` · P&L ${formatUSD(Number(entry.pnl))}` : '';
    return `<div class="bot-log-entry"><span class="bot-log-time">${escapeHtml(time)}</span><span class="bot-log-badge ${cssClass}">${label}</span><div class="bot-log-detail"><div class="bot-log-market">${escapeHtml(shortMarket)}</div><div class="bot-log-metric">${escapeHtml(entry.reason || '')}${metric ? ' — ' + escapeHtml(metric) : ''}${escapeHtml(pnl)}</div></div></div>`;
  }).join('');
}

function readBotConfigFromForm() {
  const read = (id, fallback) => Number(document.getElementById(id)?.value) || fallback;
  let minPrice = Math.max(0.01, Math.min(0.99, read('bot-min-price', 5) / 100));
  let maxPrice = Math.max(0.01, Math.min(1, read('bot-max-price', 75) / 100));
  if (minPrice > maxPrice) [minPrice, maxPrice] = [maxPrice, minPrice];
  return {
    strategy: document.getElementById('bot-strategy')?.value || 'momentum',
    porTrade: Math.max(1, Math.min(50, read('bot-por-trade', 5))),
    maxOpenPositions: Math.round(Math.max(1, Math.min(50, read('bot-max-positions', 10)))),
    minPriceToBuy: minPrice,
    maxPriceToBuy: maxPrice,
    profitTarget: Math.max(1, Math.min(200, read('bot-profit-target', 20))),
    stopLoss: Math.max(1, Math.min(100, read('bot-stop-loss', 25))),
    intervalMs: Math.max(10_000, Math.min(3_600_000, read('bot-interval', 60) * 1000)),
    maxDailyLossPct: Math.max(0.5, Math.min(50, read('bot-max-daily-loss', 5))),
    maxMarketExposurePct: Math.max(1, Math.min(100, read('bot-max-market-exposure', 15))),
    maxPositionPct: Math.max(1, Math.min(100, read('bot-max-position', 10))),
    cooldownAfterLossMin: Math.max(0, Math.min(1440, read('bot-cooldown-loss', 10))),
  };
}

function botCallbacks() {
  return {
    onTick: () => {
      updateBotStatusUI();
      renderHeader();
      renderBotStats();
      if (state.activeTab === 'portfolio') renderPortfolio();
      if (state.activeTab === 'bot') renderBotLog();
    },
    onAction: actions => {
      renderHeader();
      renderBotStats();
      if (state.activeTab === 'bot') renderBotLog();
      if (state.activeTab === 'portfolio') renderPortfolio();
      if (state.activeTab === 'history') renderHistory();
      if (state.activeTab === 'markets') renderMarketsPricesOnly();
      showToast(`🤖 Bot: ${actions.map(action => action.reason || action.action).join(', ')}`, 'success');
    },
  };
}

function bindBotEvents() {
  document.getElementById('btn-bot-toggle')?.addEventListener('click', () => {
    if (botIsRunning()) {
      botStop();
      showToast('Bot desligado', 'info');
    } else {
      saveBotConfig({ ...getBotConfig(), ...readBotConfigFromForm() });
      botStart(() => state.markets, botCallbacks());
      showToast('Bot ligado em modo de simulação.', 'success');
    }
    updateBotStatusUI();
    renderBotStats();
  });

  document.getElementById('btn-bot-emergency')?.addEventListener('click', () => {
    botEmergencyStop('Parada de emergência acionada pela interface');
    updateBotStatusUI();
    renderBotStats();
    renderBotLog();
    showToast('Auto-Trader interrompido por parada de emergência.', 'error');
  });

  document.getElementById('btn-bot-save-config')?.addEventListener('click', () => {
    const current = getBotConfig();
    saveBotConfig({ ...current, ...readBotConfigFromForm(), enabled: current.enabled });
    if (botIsRunning()) {
      botStop();
      botStart(() => state.markets, botCallbacks());
    }
    renderBotStats();
    showToast('Configurações e limites de risco salvos.', 'success');
  });

  document.getElementById('btn-bot-reset-config')?.addEventListener('click', () => {
    if (botIsRunning()) botStop();
    resetBotConfig();
    resetTickCount();
    renderBotPanel();
    showToast('Configuração restaurada para defaults.', 'info');
  });

  document.getElementById('btn-bot-clear-log')?.addEventListener('click', () => {
    clearBotLog();
    renderBotLog();
    renderBotStats();
    showToast('Log do bot limpo.', 'info');
  });
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderSkeletons(count = 4) {
  return Array.from({ length: count }, () => `
    <div class="skeleton-card"><div class="skeleton-line long"></div><div class="skeleton-line short"></div><div class="skeleton-outcomes"><div class="skeleton-btn"></div><div class="skeleton-btn"></div></div><div class="skeleton-line medium"></div></div>`).join('');
}

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.style.display = 'block';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => {
    toast.classList.add('toast-leaving');
    setTimeout(() => {
      toast.style.display = 'none';
      toast.classList.remove('toast-leaving');
    }, 300);
  }, 3000);
}

function bindKeyboardShortcuts() {
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      for (const id of ['modal-reset', 'modal-buy', 'modal-sell']) {
        const modal = document.getElementById(id);
        if (modal?.style.display !== 'flex') continue;
        if (id === 'modal-buy') closeBuyModal();
        else if (id === 'modal-sell') closeSellModal();
        else modal.style.display = 'none';
        break;
      }
    }
    if (event.key === 'Enter' && state.buyContext && document.activeElement?.id === 'buy-shares-input') {
      event.preventDefault();
      if (!document.getElementById('buy-confirm').disabled) confirmBuy();
    }
    if (event.key === 'Enter' && state.sellContext && document.activeElement?.id === 'sell-shares-input') {
      event.preventDefault();
      if (!document.getElementById('sell-confirm').disabled) confirmSell();
    }
  });
}

init();
