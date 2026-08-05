// app.js — Lógica principal do Polymarket Trader
// Fase 2: Layout, Dashboard, Tabs, Cards de Mercado, Header com saldo/P&L

import { formatUSD, formatPercent, saveToStorage, loadFromStorage } from './utils.js';

// ===== Estado global da app =====
const state = {
  markets: [],           // lista de mercados carregados
  filteredMarkets: [],  // mercados após busca/filtro
  activeTab: 'markets',
  searchQuery: '',
  categoryFilter: '',
};

// ===== Init =====
async function init() {
  console.log('Polymarket Trader — inicializando...');
  initWalletState();
  bindEvents();
  await loadMarkets();
  renderHeader();
  renderMarkets();
}

// ===== Carteira (estado mínimo para Fase 2) =====
function initWalletState() {
  const wallet = loadFromStorage('wallet', null);
  if (!wallet) {
    const initial = { balance: 1000, initialBalance: 1000, positions: [], trades: [] };
    saveToStorage('wallet', initial);
  }
}

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
      const initial = { balance: 1000, initialBalance: 1000, positions: [], trades: [] };
      saveToStorage('wallet', initial);
      document.getElementById('modal-reset').style.display = 'none';
      renderHeader();
      renderMarkets();
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
}

// ===== Tabs =====
function switchTab(tabName) {
  state.activeTab = tabName;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === `tab-${tabName}`));
}

// ===== Carregar mercados (Fase 2: sample local; Fase 3 trocará por API) =====
async function loadMarkets() {
  const loading = document.getElementById('markets-loading');
  try {
    if (loading) loading.style.display = 'block';
    // Fase 2: usa sample-markets.json (fallback offline)
    // Fase 3 substituirá por fetch à Gamma API
    const resp = await fetch('data/sample-markets.json');
    if (!resp.ok) throw new Error('Erro ao carregar mercados');
    state.markets = await resp.json();
    state.filteredMarkets = [...state.markets];
  } catch (err) {
    console.error('Erro ao carregar mercados:', err);
    state.markets = [];
    state.filteredMarkets = [];
    showToast('Erro ao carregar mercados. Verifique a conexão.', 'error');
  } finally {
    if (loading) loading.style.display = 'none';
  }
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
  const wallet = loadFromStorage('wallet', { balance: 1000, initialBalance: 1000, positions: [], trades: [] });
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

  // Bind outcome buttons (placeholder — Fase 4 fará a compra real)
  list.querySelectorAll('.outcome-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      const marketId = btn.dataset.marketId;
      const outcome = btn.dataset.outcome;
      // Fase 2: apenas feedback visual. Fase 4 implementará o modal de compra.
      showToast(`Compra de "${outcome}" — disponível na Fase 4`, 'info');
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

// ===== Helpers =====
function formatPrice(price) {
  if (price === undefined || price === null) return '—';
  return (price * 100).toFixed(1) + '¢';
}

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
