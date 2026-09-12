// app.js — Lógica principal do Polymarket Trader
// Fase 3: integração com Gamma API, refresh automático de preços,
//          indicador de fonte/ última atualização, botão de refresh manual.

import { formatUSD, formatPercent, formatPrice } from './utils.js';
import { fetchMarkets, refreshPrices, clearCache } from './api.js';
import { init as initWallet, getBalance, getWallet, buy as walletBuy, sell as walletSell, reset as walletReset, getPositions, getPosition, getTrades } from './wallet.js';
import { computePortfolioSummary, getAllocationData, drawAllocationPie, renderAllocationLegend, renderPositionCards } from './portfolio.js';
import { filterTrades, computeStats, buildEquityCurve, drawPerformanceChart, renderStatsCards, renderTradesTable, tradesToCSV, downloadCSV } from './trades.js';
import { getConfig as getBotConfig, saveConfig as saveBotConfig, resetConfig as resetBotConfig, getLog as getBotLog, clearLog as clearBotLog, getBotStats, start as botStart, stop as botStop, isRunning as botIsRunning, resetTickCount, getTickCount } from './bot.js';

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
  console.log('Polymarket Trader — inicializando...');
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
  if (state.autoRefreshHandle) {
    clearInterval(state.autoRefreshHandle);
    state.autoRefreshHandle = null;
  }
}

async function updatePrices() {
  const updated = await refreshPrices();
  if (updated) {
    state.lastUpdate = new Date();
    state.dataSource = 'api';
    updateRefreshIndicator();
    renderMarketsPricesOnly();
    showToast('Preços atualizados', 'success');
  } else {
    updateRefreshIndicator(true);
  }
}

function bindEvents() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  const searchInput = document.getElementById('market-search');
  searchInput?.addEventListener('input', e => {
    state.searchQuery = e.target.value.toLowerCase();
    renderMarkets();
  });

  const filterSelect = document.getElementById('market-filter');
  filterSelect?.addEventListener('change', e => {
    state.categoryFilter = e.target.value;
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
    document.getElementById('modal-reset').style.display = 'none';
    renderHeader();
    renderPortfolio();
    renderHistory();
    clearBotLog();
    if (state.activeTab === 'bot') { renderBotPanel(); renderBotLog(); }
    loadMarkets().then(() => { renderMarkets(); renderHeader(); });
    showToast('Carteira reiniciada! Saldo: $1,000.00', 'info');
  });

  const modal = document.getElementById('modal-reset');
  modal?.addEventListener('click', e => {
    if (e.target === modal) modal.style.display = 'none';
  });
  const modalBuy = document.getElementById('modal-buy');
  modalBuy?.addEventListener('click', e => {
    if (e.target === modalBuy) closeBuyModal();
  });
  const modalSell = document.getElementById('modal-sell');
  modalSell?.addEventListener('click', e => {
    if (e.target === modalSell) closeSellModal();
  });
}

function switchTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll('.tab').forEach(t => {
    const active = t.dataset.tab === tabName;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', active ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tabName}`));
  if (tabName === 'portfolio') renderPortfolio();
  if (tabName === 'history') renderHistory();
  if (tabName === 'bot') { renderBotPanel(); renderBotLog(); }
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

    if (markets.length > 0) {
      try {
        const sampleRes = await fetch('data/sample-markets.json');
        if (sampleRes.ok) {
          const sample = await sampleRes.json();
          const sampleIds = new Set(sample.map(m => String(m.id)));
          state.dataSource = sampleIds.has(String(markets[0]?.id)) ? 'sample' : 'api';
        } else {
          state.dataSource = 'api';
        }
      } catch {
        state.dataSource = 'api';
      }
    }
    updateRefreshIndicator();
  } catch (err) {
    console.error('Erro ao carregar mercados:', err);
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
  const sourceLabel = {
    api: '🟢 Gamma API',
    sample: '🟡 Dados de exemplo',
    'cache-stale': '🟠 Cache (offline)'
  }[state.dataSource] || '—';
  indicator.innerHTML = error
    ? '<span class="ri-error">🔴 Falha ao atualizar</span>'
    : `<span class="ri-source">${sourceLabel}</span> <span class="ri-time">atualizado às ${time}</span>`;
}

function renderMarketsPricesOnly() {
  const list = document.getElementById('markets-list');
  if (!list || state.markets.length === 0) return;
  const marketMap = new Map(state.markets.map(m => [String(m.id), m]));
  list.querySelectorAll('.market-card').forEach(card => {
    const m = marketMap.get(card.dataset.marketId);
    if (!m) return;
    const yes = m.outcomes.find(o => o.name === 'Yes') || m.outcomes[0];
    const no = m.outcomes.find(o => o.name === 'No') || m.outcomes[1];
    const yesPrice = card.querySelector('.outcome-btn.yes .outcome-price');
    const noPrice = card.querySelector('.outcome-btn.no .outcome-price');
    if (yesPrice) yesPrice.textContent = formatPrice(yes?.price);
    if (noPrice) noPrice.textContent = formatPrice(no?.price);
    const meta = card.querySelector('.market-meta');
    if (meta) {
      const volumeStr = m.volume >= 1_000_000
        ? '$' + (m.volume / 1_000_000).toFixed(2) + 'M'
        : m.volume >= 1_000 ? '$' + (m.volume / 1_000).toFixed(1) + 'K' : '$' + (m.volume || 0).toFixed(2);
      meta.innerHTML = `<span>Vol: ${volumeStr}</span><span>Liq: $${(m.liquidity || 0).toFixed(0)}</span>`;
    }
  });
  renderHeader();
  if (state.activeTab === 'portfolio') renderPortfolio();
}

function filterMarkets() {
  state.filteredMarkets = state.markets.filter(m => {
    const question = String(m.question || '').toLowerCase();
    return (!state.searchQuery || question.includes(state.searchQuery)) &&
      (!state.categoryFilter || m.category === state.categoryFilter);
  });
}

function renderHeader() {
  const wallet = getWallet();
  const summary = computePortfolioSummary(state.markets);
  const balanceEl = document.getElementById('header-balance');
  const pnlEl = document.getElementById('header-pnl');
  if (balanceEl) balanceEl.textContent = formatUSD(wallet.balance);

  // P&L global deve usar patrimônio total marcado a mercado, não apenas o caixa.
  const pnl = summary.totalEquity - wallet.initialBalance;
  const pnlPercent = wallet.initialBalance > 0 ? (pnl / wallet.initialBalance) * 100 : 0;
  if (pnlEl) {
    pnlEl.textContent = `${formatUSD(pnl)} (${formatPercent(pnlPercent)})`;
    pnlEl.classList.remove('positive', 'negative');
    if (pnl > 0) pnlEl.classList.add('positive');
    else if (pnl < 0) pnlEl.classList.add('negative');
  }
}

function renderMarkets() {
  filterMarkets();
  const list = document.getElementById('markets-list');
  const empty = document.getElementById('markets-empty');
  if (!list) return;
  if (state.filteredMarkets.length === 0) {
    list.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';
  list.innerHTML = state.filteredMarkets.map(renderMarketCard).join('');
  list.querySelectorAll('.outcome-btn').forEach(btn => {
    btn.addEventListener('click', () => openBuyModal(btn.dataset.marketId, btn.dataset.outcome));
  });
}

function renderMarketCard(m) {
  const yes = m.outcomes.find(o => o.name === 'Yes') || m.outcomes[0];
  const no = m.outcomes.find(o => o.name === 'No') || m.outcomes[1];
  const volumeStr = m.volume >= 1_000_000
    ? '$' + (m.volume / 1_000_000).toFixed(2) + 'M'
    : m.volume >= 1_000 ? '$' + (m.volume / 1_000).toFixed(1) + 'K' : '$' + (m.volume || 0).toFixed(2);
  return `
    <div class="market-card" data-market-id="${escapeHtml(m.id)}">
      <div class="market-card-top">
        <p class="market-question">${escapeHtml(m.question)}</p>
        <span class="market-category">${escapeHtml(m.category || 'general')}</span>
      </div>
      <div class="market-outcomes">
        <button class="outcome-btn yes" data-market-id="${escapeHtml(m.id)}" data-outcome="Yes"><span class="outcome-name">Yes</span><span class="outcome-price">${formatPrice(yes?.price)}</span></button>
        <button class="outcome-btn no" data-market-id="${escapeHtml(m.id)}" data-outcome="No"><span class="outcome-name">No</span><span class="outcome-price">${formatPrice(no?.price)}</span></button>
      </div>
      <div class="market-meta"><span>Vol: ${volumeStr}</span><span>Liq: $${(m.liquidity || 0).toFixed(0)}</span></div>
    </div>`;
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
  const existingPos = getPosition(marketId, outcomeObj.name);
  const tagEl = document.getElementById('buy-position-tag');
  if (existingPos) {
    tagEl.style.display = 'inline-block';
    tagEl.textContent = `Você já tem ${existingPos.shares} shares a ${formatPrice(existingPos.avgPrice)}`;
  } else tagEl.style.display = 'none';
  updateBuyPreview();
  document.getElementById('modal-buy').style.display = 'flex';
  setTimeout(() => { sharesInput.focus(); sharesInput.select(); }, 50);
}

function updateBuyPreview() {
  if (!state.buyContext) return;
  const shares = Math.max(0, Math.floor(Number(document.getElementById('buy-shares-input').value) || 0));
  const totalCost = shares * state.buyContext.price;
  const balance = getBalance();
  const balanceAfter = balance - totalCost;
  document.getElementById('buy-cost-display').textContent = formatUSD(totalCost);
  const balAfterEl = document.getElementById('buy-balance-after');
  balAfterEl.textContent = formatUSD(balanceAfter);
  balAfterEl.style.color = balanceAfter < 0 ? 'var(--red)' : 'var(--text-primary)';
  const warningEl = document.getElementById('buy-warning');
  const confirmBtn = document.getElementById('buy-confirm');
  if (totalCost > balance || shares <= 0) {
    warningEl.style.display = 'block';
    warningEl.textContent = totalCost > balance ? `Saldo insuficiente. Você precisa de ${formatUSD(totalCost)}, mas tem ${formatUSD(balance)}.` : 'Quantidade deve ser maior que zero.';
    confirmBtn.disabled = true;
  } else {
    warningEl.style.display = 'none';
    confirmBtn.disabled = false;
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
  if (result.success) {
    showToast(result.message, 'success');
    closeBuyModal();
    renderHeader();
    renderPortfolio();
    if (state.activeTab === 'history') renderHistory();
  } else {
    showToast(result.message, 'error');
    const warningEl = document.getElementById('buy-warning');
    warningEl.style.display = 'block';
    warningEl.textContent = result.message;
  }
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
  const pnlPercent = state.sellContext.avgPrice > 0 ? ((state.sellContext.price - state.sellContext.avgPrice) / state.sellContext.avgPrice) * 100 : 0;
  document.getElementById('sell-return-display').textContent = formatUSD(totalReturn);
  const pnlEl = document.getElementById('sell-pnl-display');
  pnlEl.textContent = `${formatUSD(pnl)} (${formatPercent(pnlPercent)})`;
  pnlEl.classList.remove('positive', 'negative');
  if (pnl > 0) pnlEl.classList.add('positive');
  else if (pnl < 0) pnlEl.classList.add('negative');
  const warningEl = document.getElementById('sell-warning');
  const confirmBtn = document.getElementById('sell-confirm');
  if (shares <= 0 || shares > state.sellContext.shares) {
    warningEl.style.display = 'block';
    warningEl.textContent = shares <= 0 ? 'Quantidade deve ser maior que zero.' : `Você só tem ${state.sellContext.shares} shares dessa posição.`;
    confirmBtn.disabled = true;
  } else {
    warningEl.style.display = 'none';
    confirmBtn.disabled = false;
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
  if (result.success) {
    showToast(result.message, 'success');
    closeSellModal();
    renderHeader();
    renderPortfolio();
    if (state.activeTab === 'history') renderHistory();
  } else {
    showToast(result.message, 'error');
    const warningEl = document.getElementById('sell-warning');
    warningEl.style.display = 'block';
    warningEl.textContent = result.message;
  }
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
  const emptyMsg = document.getElementById('portfolio-empty');
  const chartSection = document.getElementById('port-chart-section');
  if (!list) return;
  const summary = computePortfolioSummary(state.markets);
  document.getElementById('port-open-positions').textContent = summary.openCount;
  document.getElementById('port-invested').textContent = formatUSD(summary.invested);
  document.getElementById('port-current-value').textContent = formatUSD(summary.currentValue);
  const pnlEl = document.getElementById('port-unrealized-pnl');
  pnlEl.textContent = `${formatUSD(summary.unrealizedPnl)} (${formatPercent(summary.unrealizedPnlPercent)})`;
  pnlEl.classList.remove('pnl-positive', 'pnl-negative');
  if (summary.unrealizedPnl > 0) pnlEl.classList.add('pnl-positive');
  else if (summary.unrealizedPnl < 0) pnlEl.classList.add('pnl-negative');
  const equityEl = document.getElementById('port-total-equity');
  if (equityEl) equityEl.textContent = formatUSD(summary.totalEquity);

  if (positions.length === 0) {
    list.innerHTML = '';
    if (emptyMsg) emptyMsg.style.display = 'block';
    if (chartSection) chartSection.style.display = 'none';
    return;
  }
  if (emptyMsg) emptyMsg.style.display = 'none';
  if (chartSection) chartSection.style.display = 'flex';
  list.innerHTML = renderPositionCards(state.markets);
  list.querySelectorAll('.position-sell-btn').forEach(btn => btn.addEventListener('click', () => openSellModal(btn.dataset.marketId, btn.dataset.outcome)));
  const allocData = getAllocationData(state.markets);
  drawAllocationPie(document.getElementById('port-allocation-canvas'), allocData, summary.currentValue);
  renderAllocationLegend(document.getElementById('port-allocation-legend'), allocData);
}

function renderHistory() {
  const tradeList = getTrades();
  const wallet = getWallet();
  const statsTop = document.getElementById('history-stats-top');
  const chartSection = document.getElementById('history-chart-section');
  const tableContainer = document.getElementById('history-table-container');
  const emptyMsg = document.getElementById('history-empty');
  if (tradeList.length === 0) {
    if (statsTop) statsTop.innerHTML = '';
    if (chartSection) chartSection.style.display = 'none';
    if (tableContainer) tableContainer.innerHTML = '';
    if (emptyMsg) emptyMsg.style.display = 'block';
    return;
  }
  if (emptyMsg) emptyMsg.style.display = 'none';
  if (chartSection) chartSection.style.display = 'flex';
  const chrono = [...tradeList].reverse();
  if (statsTop) statsTop.innerHTML = renderStatsCards(computeStats(chrono));
  drawPerformanceChart(document.getElementById('history-performance-canvas'), buildEquityCurve(chrono, wallet.initialBalance), wallet.initialBalance);
  if (tableContainer) tableContainer.innerHTML = renderTradesTable(filterTrades(tradeList, state.historyFilter));
}

function bindHistoryEvents() {
  document.querySelectorAll('.history-filter-btn').forEach(btn => btn.addEventListener('click', () => {
    document.querySelectorAll('.history-filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.historyFilter = btn.dataset.filter;
    renderHistory();
  }));
  document.getElementById('btn-export-csv')?.addEventListener('click', () => {
    const tradeList = getTrades();
    if (!tradeList.length) return showToast('Nenhum trade para exportar', 'info');
    downloadCSV(tradesToCSV(tradeList), `polymarket-trades-${new Date().toISOString().split('T')[0]}.csv`);
    showToast(`CSV exportado com ${tradeList.length} trades`, 'success');
  });
}

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
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
    setTimeout(() => { toast.style.display = 'none'; toast.classList.remove('toast-leaving'); }, 300);
  }, 3000);
}

function bindKeyboardShortcuts() {
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      for (const id of ['modal-reset', 'modal-buy', 'modal-sell']) {
        const modal = document.getElementById(id);
        if (modal?.style.display === 'flex') {
          if (id === 'modal-buy') closeBuyModal();
          else if (id === 'modal-sell') closeSellModal();
          else modal.style.display = 'none';
          break;
        }
      }
    }
    if (e.key === 'Enter' && state.buyContext && document.activeElement?.id === 'buy-shares-input') {
      e.preventDefault();
      if (!document.getElementById('buy-confirm').disabled) confirmBuy();
    }
    if (e.key === 'Enter' && state.sellContext && document.activeElement?.id === 'sell-shares-input') {
      e.preventDefault();
      if (!document.getElementById('sell-confirm').disabled) confirmSell();
    }
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
  };
  for (const [id, value] of Object.entries(values)) {
    const el = document.getElementById(id);
    if (el) el.value = value;
  }
  updateBotStatusUI();
  renderBotStats();
}

function updateBotStatusUI() {
  const running = botIsRunning();
  document.getElementById('bot-status-indicator')?.classList.toggle('running', running);
  const dot = document.getElementById('bot-status-dot');
  const text = document.getElementById('bot-status-text');
  const toggleBtn = document.getElementById('btn-bot-toggle');
  const tickEl = document.getElementById('bot-tick-count');
  if (dot) dot.textContent = running ? '🟢' : '⚫';
  if (text) text.textContent = running ? 'Rodando...' : 'Desligado';
  if (toggleBtn) {
    toggleBtn.textContent = running ? '⏹ Parar Bot' : '▶ Ligar Bot';
    toggleBtn.classList.toggle('running', running);
  }
  if (tickEl) tickEl.textContent = getTickCount();
}

function renderBotStats() {
  const stats = getBotStats();
  const container = document.getElementById('bot-stats-top');
  if (!container) return;
  if (!stats.totalActions) { container.innerHTML = ''; return; }
  const lastActionTime = stats.lastAction ? new Date(stats.lastAction.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : '—';
  container.innerHTML = `
    <div class="stat-card"><span class="stat-label">Total de Ações</span><span class="stat-value">${stats.totalActions}</span></div>
    <div class="stat-card"><span class="stat-label">Compras</span><span class="stat-value pnl-positive">${stats.totalBuys}</span></div>
    <div class="stat-card"><span class="stat-label">Vendas</span><span class="stat-value pnl-negative">${stats.totalSells}</span></div>
    <div class="stat-card"><span class="stat-label">Última Ação</span><span class="stat-value" style="font-size:0.9rem;">${lastActionTime}</span></div>`;
}

function renderBotLog() {
  const log = getBotLog(100);
  const container = document.getElementById('bot-log-container');
  const emptyMsg = document.getElementById('bot-log-empty');
  if (!container) return;
  if (!log.length) {
    container.innerHTML = '';
    if (emptyMsg) emptyMsg.style.display = 'block';
    return;
  }
  if (emptyMsg) emptyMsg.style.display = 'none';
  container.innerHTML = log.map(entry => {
    const dt = new Date(entry.timestamp);
    const timeStr = dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + ' ' + dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const actionLabel = entry.action === 'buy' ? 'Compra' : 'Venda';
    const actionClass = entry.action === 'buy' ? 'buy' : 'sell';
    const market = String(entry.market || entry.marketQuestion || '—');
    const truncMarket = market.length > 50 ? market.substring(0, 50) + '…' : market;
    const metricText = entry.shares != null ? `${entry.shares} shares @ ${formatPrice(entry.price)} → ${formatUSD(entry.shares * entry.price)}` : '';
    return `<div class="bot-log-entry"><span class="bot-log-time">${escapeHtml(timeStr)}</span><span class="bot-log-badge ${actionClass}">${actionLabel}</span><div class="bot-log-detail"><div class="bot-log-market">${escapeHtml(truncMarket)}</div><div class="bot-log-metric">${escapeHtml(entry.reason || '')}${metricText ? ' — ' + escapeHtml(metricText) : ''}</div></div></div>`;
  }).join('');
}

function readBotConfigFromForm() {
  const porTrade = Number(document.getElementById('bot-por-trade')?.value) || 5;
  const maxPos = Number(document.getElementById('bot-max-positions')?.value) || 10;
  let minPrice = Math.max(0.01, Math.min(0.99, (Number(document.getElementById('bot-min-price')?.value) || 5) / 100));
  let maxPrice = Math.max(0.01, Math.min(1, (Number(document.getElementById('bot-max-price')?.value) || 75) / 100));
  if (minPrice > maxPrice) [minPrice, maxPrice] = [maxPrice, minPrice];
  return {
    strategy: document.getElementById('bot-strategy')?.value || 'momentum',
    porTrade: Math.max(1, Math.min(50, porTrade)),
    maxOpenPositions: Math.max(1, Math.min(50, maxPos)),
    minPriceToBuy: minPrice,
    maxPriceToBuy: maxPrice,
    profitTarget: Math.max(1, Number(document.getElementById('bot-profit-target')?.value) || 20),
    stopLoss: Math.max(1, Number(document.getElementById('bot-stop-loss')?.value) || 25),
    intervalMs: Math.max(10_000, (Number(document.getElementById('bot-interval')?.value) || 60) * 1000),
  };
}

function botCallbacks() {
  return {
    onTick: () => {
      updateBotStatusUI();
      renderHeader();
      if (state.activeTab === 'portfolio') renderPortfolio();
      if (state.activeTab === 'bot') renderBotLog();
      renderBotStats();
    },
    onAction: actions => {
      renderHeader();
      if (state.activeTab === 'bot') { renderBotLog(); renderBotStats(); }
      if (state.activeTab === 'portfolio') renderPortfolio();
      if (state.activeTab === 'history') renderHistory();
      if (state.activeTab === 'markets') renderMarketsPricesOnly();
      showToast(`🤖 Bot: ${actions.map(a => a.reason || a.action).join(', ')}`, 'success');
    }
  };
}

function bindBotEvents() {
  document.getElementById('btn-bot-toggle')?.addEventListener('click', () => {
    if (botIsRunning()) {
      botStop();
      showToast('Bot desligado', 'info');
    } else {
      const mergedConfig = { ...getBotConfig(), ...readBotConfigFromForm() };
      saveBotConfig(mergedConfig);
      botStart(() => state.markets, botCallbacks());
      showToast('Bot ligado! negociando automaticamente.', 'success');
    }
    updateBotStatusUI();
  });

  document.getElementById('btn-bot-save-config')?.addEventListener('click', () => {
    const current = getBotConfig();
    saveBotConfig({ ...current, ...readBotConfigFromForm(), enabled: current.enabled });
    showToast('Config do bot salva!', 'success');
    if (botIsRunning()) {
      botStop();
      botStart(() => state.markets, botCallbacks());
    }
  });

  document.getElementById('btn-bot-reset-config')?.addEventListener('click', () => {
    if (botIsRunning()) botStop();
    resetBotConfig();
    resetTickCount();
    renderBotPanel();
    showToast('Config restaurada para defaults', 'info');
  });

  document.getElementById('btn-bot-clear-log')?.addEventListener('click', () => {
    clearBotLog();
    renderBotLog();
    renderBotStats();
    showToast('Log do bot limpo', 'info');
  });
}

init();
