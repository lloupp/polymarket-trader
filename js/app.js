// app.js — Lógica principal do Polymarket Trader
// Fase 3: integração com Gamma API, refresh automático de preços,
//          indicador de fonte/ última atualização, botão de refresh manual.

import { formatUSD, formatPercent, formatPrice } from './utils.js';
import { fetchMarkets, refreshPrices, clearCache } from './api.js';
import { init as initWallet, getBalance, getWallet, buy as walletBuy, sell as walletSell, reset as walletReset, getPositions, getPosition, getTrades } from './wallet.js';
import { computePortfolioSummary, getAllocationData, drawAllocationPie, renderAllocationLegend, renderPositionCards } from './portfolio.js';
import { filterTrades, computeStats, buildEquityCurve, drawPerformanceChart, renderStatsCards, renderTradesTable, tradesToCSV, downloadCSV } from './trades.js';
import { getConfig as getBotConfig, saveConfig as saveBotConfig, updateConfig as updateBotConfig, resetConfig as resetBotConfig, getLog as getBotLog, clearLog as clearBotLog, getBotStats, tick as botTick, start as botStart, stop as botStop, isRunning as botIsRunning, resetTickCount, getTickCount } from './bot.js';

// ===== Configuração =====
const AUTO_REFRESH_MS = 60_000;  // auto-refresh a cada 60s enquanto a aba está aberta

// ===== Estado global da app =====
const state = {
  markets: [],           // lista de mercados carregados (schema do app)
  filteredMarkets: [],  // mercados após busca/filtro
  activeTab: 'markets',
  searchQuery: '',
  categoryFilter: '',
  dataSource: 'sample', // 'api' | 'sample' | 'cache-stale'
  lastUpdate: null,     // Date do último refresh bem-sucedido
  autoRefreshHandle: null,  // setInterval id
  // Contexto de modal de compra/venda
  buyContext: null,     // { marketId, marketQuestion, outcome, price }
  sellContext: null,    // { marketId, marketQuestion, outcome, price, avgPrice, shares }
  // Filtro de histórico (Fase 6)
  historyFilter: 'all',  // 'all' | 'buy' | 'sell'
};

// ===== Init =====
async function init() {
  console.log('Polymarket Trader — inicializando...');
  initWallet();  // wallet.js: cria pm_wallet se não existir
  bindEvents();
  bindTradeModals();
  bindHistoryEvents();  // Fase 6: filtros + CSV
  bindKeyboardShortcuts();  // Fase 7: ESC fecha modais, Enter confirma
  bindBotEvents();  // Fase 9: controles do Auto-Trader
  await loadMarkets();
  renderHeader();
  renderMarkets();
  renderBotPanel();  // Fase 9: inicializa painel do bot com config salva
  startAutoRefresh();
}

// ===== Auto-refresh =====
function startAutoRefresh() {
  stopAutoRefresh();
  state.autoRefreshHandle = setInterval(async () => {
    // Só atualiza se a aba "Mercados" estiver visível (economiza requests)
    if (state.activeTab !== 'markets') return;
    if (document.hidden) return;
    console.log('app.js: auto-refresh tick');
    await updatePrices();
  }, AUTO_REFRESH_MS);
}

function stopAutoRefresh() {
  if (state.autoRefreshHandle) {
    clearInterval(state.autoRefreshHandle);
    state.autoRefreshHandle = null;
  }
}

// ===== Atualizar apenas preços (sem recarregar toda a lista) =====
async function updatePrices() {
  const updated = await refreshPrices();
  if (updated) {
    state.lastUpdate = new Date();
    state.dataSource = 'api';
    updateRefreshIndicator();
    renderMarketsPricesOnly();  // atualiza só os preços nos cards
    showToast('Preços atualizados', 'success');
  } else {
    updateRefreshIndicator(true);
  }
}

// ===== Carteira (estado gerido por wallet.js) =====
// initWallet(), getBalance(), getPositions(), etc. são importados de wallet.js.

// ===== Eventos =====
function bindEvents() {
  // Tabs
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Busca
  const searchInput = document.getElementById('market-search');
  if (searchInput) {
    searchInput.addEventListener('input', e => {
      state.searchQuery = e.target.value.toLowerCase();
      renderMarkets();
    });
  }

  // Filtro de categoria
  const filterSelect = document.getElementById('market-filter');
  if (filterSelect) {
    filterSelect.addEventListener('change', e => {
      state.categoryFilter = e.target.value;
      renderMarkets();
    });
  }

  // Botão de refresh manual de preços
  const btnRefresh = document.getElementById('btn-refresh-prices');
  if (btnRefresh) {
    btnRefresh.addEventListener('click', async () => {
      btnRefresh.disabled = true;
      btnRefresh.textContent = '⟳ Atualizando...';
      await updatePrices();
      btnRefresh.disabled = false;
      btnRefresh.textContent = '⟳ Atualizar preços';
    });
  }

  // Botão Reset
  const btnReset = document.getElementById('btn-reset');
  if (btnReset) {
    btnReset.addEventListener('click', () => {
      document.getElementById('modal-reset').style.display = 'flex';
    });
  }

  // Modal reset — cancelar
  const resetCancel = document.getElementById('reset-cancel');
  if (resetCancel) {
    resetCancel.addEventListener('click', () => {
      document.getElementById('modal-reset').style.display = 'none';
    });
  }

  // Modal reset — confirmar
  const resetConfirm = document.getElementById('reset-confirm');
  if (resetConfirm) {
    resetConfirm.addEventListener('click', () => {
      if (botIsRunning()) botStop();  // Fase 9: para o bot antes de resetar
      walletReset();
      clearCache();  // força re-fetch da API na próxima renderização
      document.getElementById('modal-reset').style.display = 'none';
      renderHeader();
      renderPortfolio();
      renderHistory();  // Fase 6: atualiza histórico após reset
      clearBotLog();  // Fase 9: limpa log do bot
      if (state.activeTab === 'bot') { renderBotPanel(); renderBotLog(); }
      loadMarkets().then(() => renderMarkets());  // recarrega mercados
      showToast('Carteira reiniciada! Saldo: $1,000.00', 'info');
    });
  }

  // Click fora do modal fecha
  const modal = document.getElementById('modal-reset');
  if (modal) {
    modal.addEventListener('click', e => {
      if (e.target === modal) modal.style.display = 'none';
    });
  }

  // Click fora dos modais de trade fecha
  const modalBuy = document.getElementById('modal-buy');
  if (modalBuy) {
    modalBuy.addEventListener('click', e => {
      if (e.target === modalBuy) closeBuyModal();
    });
  }
  const modalSell = document.getElementById('modal-sell');
  if (modalSell) {
    modalSell.addEventListener('click', e => {
      if (e.target === modalSell) closeSellModal();
    });
  }
}

// ===== Tabs =====
function switchTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll('.tab').forEach(t => {
    const isActive = t.dataset.tab === tabName;
    t.classList.toggle('active', isActive);
    t.setAttribute('aria-selected', isActive ? 'true' : 'false');
  });
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tabName}`));
  // Renderiza a tab se necessário
  if (tabName === 'portfolio') renderPortfolio();
  if (tabName === 'history') renderHistory();
  if (tabName === 'bot') { renderBotPanel(); renderBotLog(); }
}

// ===== Carregar mercados (Fase 3: Gamma API com fallback) =====
async function loadMarkets() {
  const loading = document.getElementById('markets-loading');
  const list = document.getElementById('markets-list');
  try {
    if (loading) {
      loading.style.display = 'grid';
      loading.innerHTML = renderSkeletons(6);
    }
    if (list) list.style.display = 'none';  // esconde a lista durante loading
    const markets = await fetchMarkets({ limit: 50 });
    state.markets = markets;
    state.filteredMarkets = [...state.markets];
    state.lastUpdate = new Date();

    // Determina a fonte dos dados para o indicador
    // (api.js loga quando usa cache stale ou sample)
    if (markets.length > 0) {
      // se os IDs baterem com sample-markets.json, é fallback local
      try {
        const sampleRes = await fetch('data/sample-markets.json');
        if (sampleRes.ok) {
          const sample = await sampleRes.json();
          const sampleIds = new Set(sample.map(m => String(m.id)));
          const firstId = String(markets[0]?.id);
          state.dataSource = sampleIds.has(firstId) ? 'sample' : 'api';
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
    if (list) list.style.display = 'grid';  // restaura visibilidade da lista
  }
}

// ===== Atualizar o indicador de fonte/última atualização =====
function updateRefreshIndicator(error = false) {
  const indicator = document.getElementById('refresh-indicator');
  if (!indicator) return;

  const time = state.lastUpdate
    ? state.lastUpdate.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';

  const sourceLabel = {
    'api': '🟢 Gamma API',
    'sample': '🟡 Dados de exemplo',
    'cache-stale': '🟠 Cache (offline)'
  }[state.dataSource] || '—';

  if (error) {
    indicator.innerHTML = '<span class="ri-error">🔴 Falha ao atualizar</span>';
  } else {
    indicator.innerHTML = `<span class="ri-source">${sourceLabel}</span> <span class="ri-time">atualizado às ${time}</span>`;
  }
}

// ===== Atualizar SÓ os preços nos cards existentes (sem re-render) =====
function renderMarketsPricesOnly() {
  // Atualiza cada card de mercado com os novos preços via data-market-id
  const list = document.getElementById('markets-list');
  if (!list || state.markets.length === 0) return;

  const marketMap = new Map(state.markets.map(m => [String(m.id), m]));
  list.querySelectorAll('.market-card').forEach(card => {
    const id = card.dataset.marketId;
    const m = marketMap.get(id);
    if (!m) return;
    const yesOutcome = m.outcomes.find(o => o.name === 'Yes') || m.outcomes[0];
    const noOutcome = m.outcomes.find(o => o.name === 'No') || m.outcomes[1];

    const yesPrice = card.querySelector('.outcome-btn.yes .outcome-price');
    const noPrice = card.querySelector('.outcome-btn.no .outcome-price');
    if (yesPrice) yesPrice.textContent = formatPrice(yesOutcome?.price);
    if (noPrice) noPrice.textContent = formatPrice(noOutcome?.price);

    // Atualiza meta com volume/liquidez
    const meta = card.querySelector('.market-meta');
    if (meta) {
      const volumeStr = m.volume >= 1_000_000
        ? '$' + (m.volume / 1_000_000).toFixed(2) + 'M'
        : m.volume >= 1_000
          ? '$' + (m.volume / 1_000).toFixed(1) + 'K'
          : '$' + (m.volume || 0).toFixed(2);
      meta.innerHTML = `<span>Vol: ${volumeStr}</span><span>Liq: $${(m.liquidity || 0).toFixed(0)}</span>`;
    }
  });
  renderHeader();  // atualiza P&L se houver posições (Fase 5)
  // Se a aba Portfolio estiver ativa, atualiza os preços lá também
  if (state.activeTab === 'portfolio') renderPortfolio();
}

// ===== Filtrar mercados =====
function filterMarkets() {
  state.filteredMarkets = state.markets.filter(m => {
    const matchSearch = !state.searchQuery || m.question.toLowerCase().includes(state.searchQuery);
    const matchCategory = !state.categoryFilter || m.category === state.categoryFilter;
    return matchSearch && matchCategory;
  });
}

// ===== Renderizar header (saldo e P&L) =====
function renderHeader() {
  const wallet = getWallet();
  const balanceEl = document.getElementById('header-balance');
  const pnlEl = document.getElementById('header-pnl');
  const pnlBox = document.getElementById('header-pnl-box');

  if (balanceEl) balanceEl.textContent = formatUSD(wallet.balance);

  const pnl = wallet.balance - wallet.initialBalance;
  const pnlPercent = wallet.initialBalance > 0 ? (pnl / wallet.initialBalance) * 100 : 0;

  if (pnlEl) {
    pnlEl.textContent = `${formatUSD(pnl)} (${formatPercent(pnlPercent)})`;
    pnlEl.classList.remove('positive', 'negative');
    if (pnl > 0) pnlEl.classList.add('positive');
    else if (pnl < 0) pnlEl.classList.add('negative');
  }
}

// ===== Renderizar lista de mercados =====
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

  list.innerHTML = state.filteredMarkets.map(m => renderMarketCard(m)).join('');

  // Bind outcome buttons — abre modal de compra (Fase 4)
  list.querySelectorAll('.outcome-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const marketId = btn.dataset.marketId;
      const outcome = btn.dataset.outcome;
      openBuyModal(marketId, outcome);
    });
  });
}

// ===== Renderizar um card de mercado =====
function renderMarketCard(m) {
  const yesOutcome = m.outcomes.find(o => o.name === 'Yes') || m.outcomes[0];
  const noOutcome = m.outcomes.find(o => o.name === 'No') || m.outcomes[1];

  const volumeStr = m.volume >= 1_000_000
    ? '$' + (m.volume / 1_000_000).toFixed(2) + 'M'
    : m.volume >= 1_000
      ? '$' + (m.volume / 1_000).toFixed(1) + 'K'
      : '$' + (m.volume || 0).toFixed(2);

  return `
    <div class="market-card" data-market-id="${m.id}">
      <div class="market-card-top">
        <p class="market-question">${escapeHtml(m.question)}</p>
        <span class="market-category">${escapeHtml(m.category || 'general')}</span>
      </div>
      <div class="market-outcomes">
        <button class="outcome-btn yes" data-market-id="${m.id}" data-outcome="Yes">
          <span class="outcome-name">Yes</span>
          <span class="outcome-price">${formatPrice(yesOutcome?.price)}</span>
        </button>
        <button class="outcome-btn no" data-market-id="${m.id}" data-outcome="No">
          <span class="outcome-name">No</span>
          <span class="outcome-price">${formatPrice(noOutcome?.price)}</span>
        </button>
      </div>
      <div class="market-meta">
        <span>Vol: ${volumeStr}</span>
        <span>Liq: $${(m.liquidity || 0).toFixed(0)}</span>
      </div>
    </div>
  `;
}

// ===== Modal de Compra (Fase 4) =====

/**
 * Abre o modal de compra para um mercado + outcome.
 * Busca o preço atual do mercado em state.markets e popula o modal.
 */
function openBuyModal(marketId, outcome) {
  const market = state.markets.find(m => String(m.id) === String(marketId));
  if (!market) {
    showToast('Mercado não encontrado', 'error');
    return;
  }
  const outcomeObj = market.outcomes.find(o => o.name === outcome) || market.outcomes[0];
  if (!outcomeObj) {
    showToast('Outcome não disponível', 'error');
    return;
  }

  state.buyContext = {
    marketId: String(marketId),
    marketQuestion: market.question,
    outcome: outcomeObj.name,
    price: outcomeObj.price
  };

  // Popula o modal
  document.getElementById('buy-market-question').textContent = market.question;
  const outcomeDisplay = document.getElementById('buy-outcome-display');
  outcomeDisplay.textContent = outcomeObj.name;
  outcomeDisplay.classList.remove('yes', 'no');
  outcomeDisplay.classList.add(outcomeObj.name === 'Yes' ? 'yes' : 'no');

  document.getElementById('buy-price-display').textContent = formatPrice(outcomeObj.price);

  // Reset shares para 10
  const sharesInput = document.getElementById('buy-shares-input');
  sharesInput.value = 10;

  // Se já tem posição, mostra tag
  const existingPos = getPosition(marketId, outcomeObj.name);
  const tagEl = document.getElementById('buy-position-tag');
  if (existingPos) {
    tagEl.style.display = 'inline-block';
    tagEl.textContent = `Você já tem ${existingPos.shares} shares a ${formatPrice(existingPos.avgPrice)}`;
  } else {
    tagEl.style.display = 'none';
  }

  updateBuyPreview();

  // Mostra o modal
  document.getElementById('modal-buy').style.display = 'flex';

  // Fase 7: autofocus no input de quantidade
  setTimeout(() => {
    const inp = document.getElementById('buy-shares-input');
    if (inp) inp.focus();
    inp?.select();
  }, 50);
}

/**
 * Atualiza o preview de custo e saldo no modal de compra.
 */
function updateBuyPreview() {
  if (!state.buyContext) return;
  const sharesRaw = document.getElementById('buy-shares-input').value;
  const shares = Math.max(0, Math.floor(parseInt(sharesRaw) || 0));
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
    warningEl.textContent = totalCost > balance
      ? `Saldo insuficiente. Você precisa de ${formatUSD(totalCost)}, mas tem ${formatUSD(balance)}.`
      : 'Quantidade deve ser maior que zero.';
    confirmBtn.disabled = true;
  } else {
    warningEl.style.display = 'none';
    confirmBtn.disabled = false;
  }
}

/**
 * Fecha o modal de compra.
 */
function closeBuyModal() {
  document.getElementById('modal-buy').style.display = 'none';
  state.buyContext = null;
}

/**
 * Confirma a compra — chama walletBuy, atualiza UI.
 */
function confirmBuy() {
  if (!state.buyContext) return;
  const sharesRaw = document.getElementById('buy-shares-input').value;
  const shares = Math.max(0, Math.floor(parseInt(sharesRaw) || 0));
  if (shares <= 0) { showToast('Quantidade inválida', 'error'); return; }
  const ctx = state.buyContext;

  const result = walletBuy({
    marketId: ctx.marketId,
    marketQuestion: ctx.marketQuestion,
    outcome: ctx.outcome,
    shares: shares,
    price: ctx.price
  });

  if (result.success) {
    showToast(result.message, 'success');
    closeBuyModal();
    renderHeader();
    renderPortfolio();
    if (state.activeTab === 'history') renderHistory();  // Fase 6: atualiza histórico
  } else {
    showToast(result.message, 'error');
    // Mostra warning no modal
    const warningEl = document.getElementById('buy-warning');
    warningEl.style.display = 'block';
    warningEl.textContent = result.message;
  }
}

// ===== Modal de Venda (Fase 4) =====

/**
 * Abre o modal de venda para uma posição existente.
 * Busca o preço atual do mercado em state.markets.
 */
function openSellModal(marketId, outcome) {
  const position = getPosition(marketId, outcome);
  if (!position) {
    showToast('Posição não encontrada', 'error');
    return;
  }

  // Busca preço atual
  const market = state.markets.find(m => String(m.id) === String(marketId));
  let currentPrice = 0;
  if (market) {
    const outcomeObj = market.outcomes.find(o => o.name === outcome);
    if (outcomeObj) currentPrice = outcomeObj.price;
  }

  state.sellContext = {
    marketId: String(marketId),
    marketQuestion: position.marketQuestion,
    outcome: outcome,
    price: currentPrice,
    avgPrice: position.avgPrice,
    shares: position.shares
  };

  // Popula o modal
  document.getElementById('sell-market-question').textContent = position.marketQuestion;
  document.getElementById('sell-position-tag').textContent =
    `${position.shares} shares — posicão aberta`;

  const outcomeDisplay = document.getElementById('sell-outcome-display');
  outcomeDisplay.textContent = outcome;
  outcomeDisplay.classList.remove('yes', 'no');
  outcomeDisplay.classList.add(outcome === 'Yes' ? 'yes' : 'no');

  document.getElementById('sell-price-display').textContent = formatPrice(currentPrice);
  document.getElementById('sell-avg-price').textContent = formatPrice(position.avgPrice);

  // Reset shares para o total da posição
  const sharesInput = document.getElementById('sell-shares-input');
  sharesInput.value = position.shares;
  sharesInput.max = position.shares;

  updateSellPreview();

  document.getElementById('modal-sell').style.display = 'flex';

  // Fase 7: autofocus no input de quantidade
  setTimeout(() => {
    const inp = document.getElementById('sell-shares-input');
    if (inp) inp.focus();
    inp?.select();
  }, 50);
}

/**
 * Atualiza o preview de retorno e P&L no modal de venda.
 */
function updateSellPreview() {
  if (!state.sellContext) return;
  const sharesRaw = document.getElementById('sell-shares-input').value;
  const shares = Math.max(0, Math.floor(parseInt(sharesRaw) || 0));
  const totalReturn = shares * state.sellContext.price;
  const pnl = (state.sellContext.price - state.sellContext.avgPrice) * shares;
  const pnlPercent = state.sellContext.avgPrice > 0
    ? ((state.sellContext.price - state.sellContext.avgPrice) / state.sellContext.avgPrice) * 100
    : 0;

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
    warningEl.textContent = shares <= 0
      ? 'Quantidade deve ser maior que zero.'
      : `Você só tem ${state.sellContext.shares} shares dessa posição.`;
    confirmBtn.disabled = true;
  } else {
    warningEl.style.display = 'none';
    confirmBtn.disabled = false;
  }
}

/**
 * Fecha o modal de venda.
 */
function closeSellModal() {
  document.getElementById('modal-sell').style.display = 'none';
  state.sellContext = null;
}

/**
 * Confirma a venda — chama walletSell, atualiza UI.
 */
function confirmSell() {
  if (!state.sellContext) return;
  const sharesRaw = document.getElementById('sell-shares-input').value;
  const shares = Math.max(0, Math.floor(parseInt(sharesRaw) || 0));
  if (shares <= 0) { showToast('Quantidade inválida', 'error'); return; }
  const ctx = state.sellContext;

  const result = walletSell({
    marketId: ctx.marketId,
    outcome: ctx.outcome,
    shares: shares,
    price: ctx.price
  });

  if (result.success) {
    showToast(result.message, 'success');
    closeSellModal();
    renderHeader();
    renderPortfolio();
    if (state.activeTab === 'history') renderHistory();  // Fase 6: atualiza histórico
  } else {
    showToast(result.message, 'error');
    const warningEl = document.getElementById('sell-warning');
    warningEl.style.display = 'block';
    warningEl.textContent = result.message;
  }
}

// ===== Binders dos modais de trade =====
function bindTradeModals() {
  // Modal de compra
  document.getElementById('buy-cancel')?.addEventListener('click', closeBuyModal);
  document.getElementById('buy-confirm')?.addEventListener('click', confirmBuy);
  document.getElementById('buy-shares-input')?.addEventListener('input', updateBuyPreview);

  // Modal de venda
  document.getElementById('sell-cancel')?.addEventListener('click', closeSellModal);
  document.getElementById('sell-confirm')?.addEventListener('click', confirmSell);
  document.getElementById('sell-shares-input')?.addEventListener('input', updateSellPreview);
}

// ===== Portfolio (Fase 5 — P&L completo, gráfico de pizza, alocação) =====
function renderPortfolio() {
  const positions = getPositions();
  const list = document.getElementById('positions-list');
  const emptyMsg = document.getElementById('portfolio-empty');
  const chartSection = document.getElementById('port-chart-section');
  if (!list) return;

  // Calcula métricas agregadas via portfolio.js
  const summary = computePortfolioSummary(state.markets);

  // Stat cards
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

  // Estado vazio
  if (positions.length === 0) {
    list.innerHTML = '';
    if (emptyMsg) emptyMsg.style.display = 'block';
    if (chartSection) chartSection.style.display = 'none';
    return;
  }
  if (emptyMsg) emptyMsg.style.display = 'none';
  if (chartSection) chartSection.style.display = 'flex';

  // Renderiza as position cards via portfolio.js
  list.innerHTML = renderPositionCards(state.markets);
  // Bind sell buttons nas position cards
  list.querySelectorAll('.position-sell-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      openSellModal(btn.dataset.marketId, btn.dataset.outcome);
    });
  });

  // Gráfico de pizza: alocação da carteira
  const allocData = getAllocationData(state.markets);
  const canvas = document.getElementById('port-allocation-canvas');
  const legend = document.getElementById('port-allocation-legend');
  drawAllocationPie(canvas, allocData, summary.currentValue);
  renderAllocationLegend(legend, allocData);
}

// ===== Histórico (Fase 6 — completo: filtros, tabela, stats, gráfico, CSV) =====
function renderHistory() {
  const trades = getTrades();  // mais recente primeiro (do wallet.js)
  const wallet = getWallet();
  const statsTop = document.getElementById('history-stats-top');
  const chartSection = document.getElementById('history-chart-section');
  const tableContainer = document.getElementById('history-table-container');
  const emptyMsg = document.getElementById('history-empty');

  // Estado vazio: nenhum trade
  if (trades.length === 0) {
    if (statsTop) statsTop.innerHTML = '';
    if (chartSection) chartSection.style.display = 'none';
    if (tableContainer) tableContainer.innerHTML = '';
    if (emptyMsg) emptyMsg.style.display = 'block';
    return;
  }
  if (emptyMsg) emptyMsg.style.display = 'none';
  if (chartSection) chartSection.style.display = 'flex';

  // 1. Estatísticas (processa todos os trades, não os filtrados)
  //    getTrades() retorna inverso (mais recente primeiro); inverter para cronológico
  const chronoTrades = [...trades].reverse();
  const stats = computeStats(chronoTrades);
  if (statsTop) {
    statsTop.innerHTML = renderStatsCards(stats);
  }

  // 2. Gráfico de performance (linha de equity) sobre todos os trades
  const curve = buildEquityCurve(chronoTrades, wallet.initialBalance);
  const canvas = document.getElementById('history-performance-canvas');
  drawPerformanceChart(canvas, curve, wallet.initialBalance);

  // 3. Tabela de trades com filtro aplicado
  //    getTrades() já está em ordem "mais recente primeiro"
  const filtered = filterTrades(trades, state.historyFilter);
  if (tableContainer) {
    tableContainer.innerHTML = renderTradesTable(filtered);
  }
}

// ===== Bindings do histórico (Fase 6) =====
function bindHistoryEvents() {
  // Filtros de histórico
  document.querySelectorAll('.history-filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.history-filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.historyFilter = btn.dataset.filter;
      renderHistory();
    });
  });

  // Botão de exportar CSV
  const btnCSV = document.getElementById('btn-export-csv');
  if (btnCSV) {
    btnCSV.addEventListener('click', () => {
      const trades = getTrades();
      if (trades.length === 0) {
        showToast('Nenhum trade para exportar', 'info');
        return;
      }
      const csv = tradesToCSV(trades);
      const dateStr = new Date().toISOString().split('T')[0];
      downloadCSV(csv, `polymarket-trades-${dateStr}.csv`);
      showToast('CSV exportado com ' + trades.length + ' trades', 'success');
    });
  }
}

// ===== Helpers =====
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== Fase 7: Skeleton loader =====
function renderSkeletons(count = 4) {
  let html = '';
  for (let i = 0; i < count; i++) {
    html += `
      <div class="skeleton-card">
        <div class="skeleton-line long"></div>
        <div class="skeleton-line short"></div>
        <div class="skeleton-outcomes">
          <div class="skeleton-btn"></div>
          <div class="skeleton-btn"></div>
        </div>
        <div class="skeleton-line medium"></div>
      </div>
    `;
  }
  return html;
}

// ===== Fase 7: Toast com auto-dismiss animado =====
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.style.display = 'block';
  clearTimeout(toast._timer);
  // Auto-dismiss com fade-out
  toast._timer = setTimeout(() => {
    toast.classList.add('toast-leaving');
    setTimeout(() => { toast.style.display = 'none'; toast.classList.remove('toast-leaving'); }, 300);
  }, 3000);
}

// ===== Fase 7: Keyboard shortcuts =====
function bindKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    // ESC fecha qualquer modal aberto
    if (e.key === 'Escape') {
      const modals = ['modal-reset', 'modal-buy', 'modal-sell'];
      for (const id of modals) {
        const modal = document.getElementById(id);
        if (modal && modal.style.display === 'flex') {
          if (id === 'modal-buy') closeBuyModal();
          else if (id === 'modal-sell') closeSellModal();
          else modal.style.display = 'none';
          break;
        }
      }
    }
    // Enter confirma no modal de compra (se o input de quantidade estiver focado)
    if (e.key === 'Enter' && state.buyContext) {
      const activeEl = document.activeElement;
      if (activeEl && activeEl.id === 'buy-shares-input') {
        e.preventDefault();
        if (!document.getElementById('buy-confirm').disabled) confirmBuy();
      }
    }
    // Enter confirma no modal de venda
    if (e.key === 'Enter' && state.sellContext) {
      const activeEl = document.activeElement;
      if (activeEl && activeEl.id === 'sell-shares-input') {
        e.preventDefault();
        if (!document.getElementById('sell-confirm').disabled) confirmSell();
      }
    }
  });
}

// ===== Fase 9: Auto-Trader — Renderização e Events =====

/**
 * Preenche o formulário do painel do bot com a config salva.
 * Atualiza o indicador de status (ligado/desligado) e o tick count.
 */
function renderBotPanel() {
  const config = getBotConfig();

  // Preenche os campos
  const strategy = document.getElementById('bot-strategy');
  if (strategy) strategy.value = config.strategy;

  const porTrade = document.getElementById('bot-por-trade');
  if (porTrade) porTrade.value = config.porTrade;

  const maxPos = document.getElementById('bot-max-positions');
  if (maxPos) maxPos.value = config.maxOpenPositions;

  const minPrice = document.getElementById('bot-min-price');
  if (minPrice) minPrice.value = Math.round(config.minPriceToBuy * 100);

  const maxPrice = document.getElementById('bot-max-price');
  if (maxPrice) maxPrice.value = Math.round(config.maxPriceToBuy * 100);

  const profitTarget = document.getElementById('bot-profit-target');
  if (profitTarget) profitTarget.value = config.profitTarget;

  const stopLoss = document.getElementById('bot-stop-loss');
  if (stopLoss) stopLoss.value = config.stopLoss;

  const interval = document.getElementById('bot-interval');
  if (interval) interval.value = Math.round(config.intervalMs / 1000);

  // Atualiza status
  updateBotStatusUI();
  renderBotStats();
}

/**
 * Atualiza a UI do indicador de status do bot (ligado/desligado + tick count).
 */
function updateBotStatusUI() {
  const running = botIsRunning();
  const indicator = document.getElementById('bot-status-indicator');
  const dot = document.getElementById('bot-status-dot');
  const text = document.getElementById('bot-status-text');
  const toggleBtn = document.getElementById('btn-bot-toggle');
  const tickEl = document.getElementById('bot-tick-count');

  if (indicator) indicator.classList.toggle('running', running);
  if (dot) dot.textContent = running ? '🟢' : '⚫';
  if (text) text.textContent = running ? 'Rodando...' : 'Desligado';

  if (toggleBtn) {
    if (running) {
      toggleBtn.textContent = '⏹ Parar Bot';
      toggleBtn.classList.add('running');
    } else {
      toggleBtn.textContent = '▶ Ligar Bot';
      toggleBtn.classList.remove('running');
    }
  }

  if (tickEl) tickEl.textContent = getTickCount();
}

/**
 * Renderiza as estatísticas do bot (total de ações, compras, vendas, última ação).
 */
function renderBotStats() {
  const stats = getBotStats();
  const container = document.getElementById('bot-stats-top');
  if (!container) return;

  if (stats.totalActions === 0) {
    container.innerHTML = '';
    return;
  }

  const lastActionTime = stats.lastAction
    ? new Date(stats.lastAction.timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })
    : '—';

  container.innerHTML = `
    <div class="stat-card">
      <span class="stat-label">Total de Ações</span>
      <span class="stat-value">${stats.totalActions}</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">Compras</span>
      <span class="stat-value pnl-positive">${stats.totalBuys}</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">Vendas</span>
      <span class="stat-value pnl-negative">${stats.totalSells}</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">Última Ação</span>
      <span class="stat-value" style="font-size:0.9rem;">${lastActionTime}</span>
    </div>
  `;
}

/**
 * Renderiza o log de ações do bot.
 */
function renderBotLog() {
  const log = getBotLog(100);
  const container = document.getElementById('bot-log-container');
  const emptyMsg = document.getElementById('bot-log-empty');
  if (!container) return;

  if (log.length === 0) {
    container.innerHTML = '';
    if (emptyMsg) emptyMsg.style.display = 'block';
    return;
  }
  if (emptyMsg) emptyMsg.style.display = 'none';

  container.innerHTML = log.map(entry => {
    const dt = new Date(entry.timestamp);
    const timeStr = dt.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
      + ' ' + dt.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    const actionLabel = entry.action === 'buy' ? 'Compra' : 'Venda';
    const actionClass = entry.action === 'buy' ? 'buy' : 'sell';
    const market = entry.market || entry.marketQuestion || '—';
    const truncMarket = market.length > 50 ? market.substring(0, 50) + '…' : market;
    const metricText = entry.shares != null
      ? `${entry.shares} shares @ ${formatPrice(entry.price)} → ${formatUSD(entry.shares * entry.price)}`
      : '';

    return `
      <div class="bot-log-entry">
        <span class="bot-log-time">${timeStr}</span>
        <span class="bot-log-badge ${actionClass}">${actionLabel}</span>
        <div class="bot-log-detail">
          <div class="bot-log-market">${escapeHtml(truncMarket)}</div>
          ${metricText ? `<div class="bot-log-metric">${escapeHtml(entry.reason || '')} — ${metricText}</div>` : `<div class="bot-log-metric">${escapeHtml(entry.reason || '')}</div>`}
        </div>
      </div>
    `;
  }).join('');
}

/**
 * Lê os valores dos inputs do formulário e monta um objeto config.
 * Converte preço de centavos (UI) para decimal 0-1 (interno).
 * @returns {Object} — config capturada do formulário
 */
function readBotConfigFromForm() {
  const porTrade = parseInt(document.getElementById('bot-por-trade')?.value) || 5;
  const maxPos = parseInt(document.getElementById('bot-max-positions')?.value) || 10;
  const minPriceCents = parseInt(document.getElementById('bot-min-price')?.value) || 5;
  const maxPriceCents = parseInt(document.getElementById('bot-max-price')?.value) || 75;
  const profitTarget = parseInt(document.getElementById('bot-profit-target')?.value) || 20;
  const stopLoss = parseInt(document.getElementById('bot-stop-loss')?.value) || 25;
  const intervalSec = parseInt(document.getElementById('bot-interval')?.value) || 60;
  const strategy = document.getElementById('bot-strategy')?.value || 'momentum';

  return {
    strategy,
    porTrade: Math.max(1, Math.min(50, porTrade)),
    maxOpenPositions: Math.max(1, Math.min(50, maxPos)),
    minPriceToBuy: Math.max(0.01, minPriceCents / 100),
    maxPriceToBuy: Math.min(1.0, maxPriceCents / 100),
    profitTarget: Math.max(1, profitTarget),
    stopLoss: Math.max(1, stopLoss),
    intervalMs: Math.max(10000, intervalSec * 1000),
  };
}

// ===== Bindings do Auto-Trader (Fase 9) =====
function bindBotEvents() {
  // Ligar/Desligar bot
  const toggleBtn = document.getElementById('btn-bot-toggle');
  if (toggleBtn) {
    toggleBtn.addEventListener('click', () => {
      if (botIsRunning()) {
        botStop();
        showToast('Bot desligado', 'info');
      } else {
        // Pega config atual do formulário para garantir valores sincronizados
        const formConfig = readBotConfigFromForm();
        const currentConfig = getBotConfig();
        const mergedConfig = { ...currentConfig, ...formConfig };
        saveBotConfig(mergedConfig);

        // Inicia bot passando função que retorna state.markets
        botStart(() => state.markets, {
          onTick: () => {
            updateBotStatusUI();
            // Atualiza header/portfolio se estiverem na tela
            renderHeader();
            if (state.activeTab === 'portfolio') renderPortfolio();
            if (state.activeTab === 'bot') renderBotLog();
            renderBotStats();
          },
          onAction: (actions) => {
            // Quando o bot executa uma ação, atualiza a UI
            renderHeader();
            if (state.activeTab === 'bot') {
              renderBotLog();
              renderBotStats();
            }
            if (state.activeTab === 'portfolio') renderPortfolio();
            if (state.activeTab === 'history') renderHistory();
            if (state.activeTab === 'markets') renderMarketsPricesOnly();
            // Toast com resumo
            const summaries = actions.map(a => a.reason || a.action);
            showToast(`🤖 Bot: ${summaries.join(', ')}`, 'success');
          },
        });
        showToast('Bot ligado! negociando automaticamente.', 'success');
      }
      updateBotStatusUI();
    });
  }

  // Salvar config
  const saveBtn = document.getElementById('btn-bot-save-config');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => {
      const formConfig = readBotConfigFromForm();
      const currentConfig = getBotConfig();
      const enabled = currentConfig.enabled;
      const mergedConfig = { ...currentConfig, ...formConfig, enabled };
      saveBotConfig(mergedConfig);
      showToast('Config do bot salva!', 'success');

      // Se o bot está rodando, reinicia com a nova config
      if (botIsRunning()) {
        botStop();
        botStart(() => state.markets, {
          onTick: () => {
            updateBotStatusUI();
            renderHeader();
            if (state.activeTab === 'portfolio') renderPortfolio();
            if (state.activeTab === 'bot') renderBotLog();
            renderBotStats();
          },
          onAction: (actions) => {
            renderHeader();
            if (state.activeTab === 'bot') { renderBotLog(); renderBotStats(); }
            if (state.activeTab === 'portfolio') renderPortfolio();
            if (state.activeTab === 'history') renderHistory();
            if (state.activeTab === 'markets') renderMarketsPricesOnly();
            showToast(`🤖 Bot: ${actions.map(a => a.reason || a.action).join(', ')}`, 'success');
          },
        });
      }
    });
  }

  // Restaurar defaults
  const resetConfigBtn = document.getElementById('btn-bot-reset-config');
  if (resetConfigBtn) {
    resetConfigBtn.addEventListener('click', () => {
      const wasRunning = botIsRunning();
      if (wasRunning) botStop();
      resetBotConfig();
      resetTickCount();
      renderBotPanel();
      showToast('Config restaurada para defaults', 'info');
    });
  }

  // Limpar log
  const clearLogBtn = document.getElementById('btn-bot-clear-log');
  if (clearLogBtn) {
    clearLogBtn.addEventListener('click', () => {
      clearBotLog();
      renderBotLog();
      renderBotStats();
      showToast('Log do bot limpo', 'info');
    });
  }
}

// ===== Start =====
init();
