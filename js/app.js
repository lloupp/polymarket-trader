// app.js — Lógica principal do Polymarket Trader
// Fase 3: integração com Gamma API, refresh automático de preços,
//          indicador de fonte/ última atualização, botão de refresh manual.

import { formatUSD, formatPercent, formatPrice } from './utils.js';
import { fetchMarkets, refreshPrices, clearCache } from './api.js';
import { init as initWallet, getBalance, getWallet, buy as walletBuy, sell as walletSell, reset as walletReset, getPositions, getPosition, getTrades } from './wallet.js';

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
};

// ===== Init =====
async function init() {
  console.log('Polymarket Trader — inicializando...');
  initWallet();  // wallet.js: cria pm_wallet se não existir
  bindEvents();
  bindTradeModals();
  await loadMarkets();
  renderHeader();
  renderMarkets();
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
      walletReset();
      clearCache();  // força re-fetch da API na próxima renderização
      document.getElementById('modal-reset').style.display = 'none';
      renderHeader();
      renderPortfolio();
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
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tabName}`));
  // Renderiza a tab se necessário
  if (tabName === 'portfolio') renderPortfolio();
  if (tabName === 'history') renderHistory();
}

// ===== Carregar mercados (Fase 3: Gamma API com fallback) =====
async function loadMarkets() {
  const loading = document.getElementById('markets-loading');
  try {
    if (loading) loading.style.display = 'block';
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
}

/**
 * Atualiza o preview de custo e saldo no modal de compra.
 */
function updateBuyPreview() {
  if (!state.buyContext) return;
  const shares = parseInt(document.getElementById('buy-shares-input').value) || 0;
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
  const shares = parseInt(document.getElementById('buy-shares-input').value) || 0;
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
}

/**
 * Atualiza o preview de retorno e P&L no modal de venda.
 */
function updateSellPreview() {
  if (!state.sellContext) return;
  const shares = parseInt(document.getElementById('sell-shares-input').value) || 0;
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
  const shares = parseInt(document.getElementById('sell-shares-input').value) || 0;
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

// ===== Portfolio (Fase 4 — básico; P&L completo na Fase 5) =====
function renderPortfolio() {
  const positions = getPositions();
  const list = document.getElementById('positions-list');
  const emptyMsg = document.getElementById('portfolio-empty');
  if (!list) return;

  // Stat cards
  const openCount = positions.length;
  const invested = positions.reduce((sum, p) => sum + p.costBasis, 0);

  // Valor atual = shares * preço atual (do mercado em state.markets)
  let currentValue = 0;
  for (const p of positions) {
    const market = state.markets.find(m => String(m.id) === String(p.marketId));
    const outcomeObj = market?.outcomes.find(o => o.name === p.outcome);
    const price = outcomeObj?.price ?? p.avgPrice;  // fallback: preço médio
    currentValue += p.shares * price;
  }
  const unrealizedPnl = currentValue - invested;

  document.getElementById('port-open-positions').textContent = openCount;
  document.getElementById('port-invested').textContent = formatUSD(invested);
  document.getElementById('port-current-value').textContent = formatUSD(currentValue);

  const pnlEl = document.getElementById('port-unrealized-pnl');
  pnlEl.textContent = formatUSD(unrealizedPnl);
  pnlEl.classList.remove('pnl-positive', 'pnl-negative');
  if (unrealizedPnl > 0) pnlEl.classList.add('pnl-positive');
  else if (unrealizedPnl < 0) pnlEl.classList.add('pnl-negative');

  if (positions.length === 0) {
    list.innerHTML = '';
    if (emptyMsg) emptyMsg.style.display = 'block';
    return;
  }
  if (emptyMsg) emptyMsg.style.display = 'none';

  list.innerHTML = positions.map(p => {
    const market = state.markets.find(m => String(m.id) === String(p.marketId));
    const outcomeObj = market?.outcomes.find(o => o.name === p.outcome);
    const currentPrice = outcomeObj?.price ?? p.avgPrice;
    const marketValue = p.shares * currentPrice;
    const pnl = (currentPrice - p.avgPrice) * p.shares;
    const pnlPercent = p.avgPrice > 0 ? ((currentPrice - p.avgPrice) / p.avgPrice) * 100 : 0;

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
            <span class="position-stat-value">${formatPrice(currentPrice)}</span>
          </div>
          <div class="position-stat">
            <span class="position-stat-label">Valor Atual</span>
            <span class="position-stat-value">${formatUSD(marketValue)}</span>
          </div>
          <div class="position-stat">
            <span class="position-stat-label">P&L</span>
            <span class="position-stat-value ${pnl > 0 ? 'pnl-positive' : pnl < 0 ? 'pnl-negative' : ''}">
              ${formatUSD(pnl)} (${formatPercent(pnlPercent)})
            </span>
          </div>
        </div>
        <div class="position-card-actions">
          <button class="position-sell-btn" data-market-id="${p.marketId}" data-outcome="${p.outcome}">
            Vender
          </button>
        </div>
      </div>
    `;
  }).join('');

  // Bind sell buttons nas position cards
  list.querySelectorAll('.position-sell-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      openSellModal(btn.dataset.marketId, btn.dataset.outcome);
    });
  });
}

// ===== Histórico (Fase 4 — básico; completo na Fase 6) =====
function renderHistory() {
  // Fase 4: placeholder básico — detalhes completos na Fase 6
  const trades = getTrades();
  // Atualiza os stat cards do placeholder
  const historyStats = document.querySelector('#tab-history .history-stats');
  if (historyStats) {
    const totalTrades = trades.length;
    const volume = trades.reduce((sum, t) => sum + t.totalCost, 0);
    const statCards = historyStats.querySelectorAll('.stat-value');
    if (statCards[0]) statCards[0].textContent = totalTrades;
    if (statCards[1]) statCards[1].textContent = formatUSD(volume);
  }

  // Atualiza o texto do placeholder
  const placeholder = document.querySelector('#tab-history .text-secondary');
  if (placeholder) {
    placeholder.textContent = trades.length > 0
      ? `Você já fez ${trades.length} operações. Histórico completo na Fase 6.`
      : 'O histórico de operações aparecerá aqui após a Fase 6.';
  }
}

// ===== Helpers =====
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.style.display = 'block';
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.style.display = 'none'; }, 3000);
}

// ===== Start =====
init();
