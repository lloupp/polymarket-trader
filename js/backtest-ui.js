// backtest-ui.js — painel de backtesting histórico rigoroso

import { fetchMarkets } from './api.js';
import { fetchHistoricalDataset } from './backtest-data.js';
import { runBacktest, compareStrategies } from './backtest.js';

const STRATEGY_LABELS = {
  momentum: 'Momentum',
  meanReversion: 'Reversão à Média',
  bargainHunting: 'Comprar Barato',
  valueBetting: 'Value Betting',
  kelly: '½-Kelly',
  random: 'Aleatória',
};

let cachedHistorical = null;

function money(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function pct(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

function num(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function dateTime(timestamp) {
  const d = new Date(Number(timestamp));
  return Number.isFinite(d.getTime()) ? d.toLocaleString('pt-BR') : '—';
}

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readNumber(id, fallback) {
  const value = Number(document.getElementById(id)?.value);
  return Number.isFinite(value) ? value : fallback;
}

function readSettings() {
  return {
    days: readNumber('bt-days', 30),
    fidelityMinutes: readNumber('bt-fidelity', 60),
    maxMarkets: readNumber('bt-markets', 5),
    universeMode: document.getElementById('bt-universe')?.value || 'historical',
    strategy: document.getElementById('bt-strategy')?.value || 'momentum',
    initialBalance: readNumber('bt-capital', 1000),
    feeBps: readNumber('bt-fee', 0),
    slippageBps: readNumber('bt-slippage', 25),
    outOfSamplePct: readNumber('bt-oos', 30),
    warmupBars: readNumber('bt-warmup', 5),
    seed: readNumber('bt-seed', 42),
    porTrade: readNumber('bt-por-trade', 5),
    profitTarget: readNumber('bt-tp', 20),
    stopLoss: readNumber('bt-sl', 25),
    maxDailyLossPct: readNumber('bt-daily-loss', 5),
    maxMarketExposurePct: readNumber('bt-market-exposure', 15),
    maxPositionPct: readNumber('bt-position', 10),
    cooldownAfterLossMin: readNumber('bt-cooldown', 10),
    maxOpenPositions: readNumber('bt-max-positions', 10),
    minPriceToBuy: readNumber('bt-min-price', 5) / 100,
    maxPriceToBuy: readNumber('bt-max-price', 75) / 100,
  };
}

function settingsFingerprint(settings) {
  return JSON.stringify({
    days: settings.days,
    fidelityMinutes: settings.fidelityMinutes,
    maxMarkets: settings.maxMarkets,
    universeMode: settings.universeMode,
    seed: settings.seed,
  });
}

function injectUI() {
  if (document.getElementById('tab-backtest')) return;
  const nav = document.querySelector('.tabs');
  if (!nav) return;
  const tab = document.createElement('button');
  tab.className = 'tab';
  tab.dataset.tab = 'backtest';
  tab.setAttribute('role', 'tab');
  tab.setAttribute('aria-selected', 'false');
  tab.textContent = '🧪 Backtest';
  nav.appendChild(tab);

  const section = document.createElement('section');
  section.id = 'tab-backtest';
  section.className = 'tab-content';
  section.innerHTML = `
    <div class="backtest-content">
      <div class="backtest-hero">
        <div>
          <h2>Backtesting histórico rigoroso</h2>
          <p>Replay temporal sem look-ahead: sinal na barra atual, execução apenas na próxima barra, custos explícitos e validação fora da amostra iniciando sem posições herdadas.</p>
        </div>
        <span class="backtest-badge">PRICE-ONLY · CLOB</span>
      </div>

      <div class="backtest-warning">
        <strong>Limites metodológicos:</strong> a API histórica fornece preços, não profundidade histórica completa do order book. Slippage e taxas são hipóteses configuráveis. O universo histórico é reconstruído do índice Gamma disponível hoje, portanto reduz mas não elimina viés de sobrevivência. Resultados não representam garantia de execução real.
      </div>

      <div class="backtest-config-grid">
        <label>Universo
          <select id="bt-universe">
            <option value="historical" selected>Histórico: mercados sobrepostos à janela (Gamma)</option>
            <option value="current">Mercados carregados hoje</option>
          </select>
        </label>
        <label>Estratégia
          <select id="bt-strategy">
            ${Object.entries(STRATEGY_LABELS).map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}
          </select>
        </label>
        <label>Janela
          <select id="bt-days"><option value="7">7 dias</option><option value="30" selected>30 dias</option><option value="90">90 dias</option><option value="180">180 dias</option><option value="365">365 dias</option></select>
        </label>
        <label>Fidelidade
          <select id="bt-fidelity"><option value="15">15 min</option><option value="60" selected>1 hora</option><option value="360">6 horas</option><option value="1440">1 dia</option></select>
        </label>
        <label>Mercados <input id="bt-markets" type="number" min="1" max="10" value="5"></label>
        <label>Capital inicial ($) <input id="bt-capital" type="number" min="1" value="1000"></label>
        <label>Fee (bps) <input id="bt-fee" type="number" min="0" max="1000" value="0"></label>
        <label>Slippage (bps) <input id="bt-slippage" type="number" min="0" max="5000" value="25"></label>
        <label>Validação OOS (%) <input id="bt-oos" type="number" min="10" max="90" value="30"></label>
        <label>Warmup (barras) <input id="bt-warmup" type="number" min="1" value="5"></label>
        <label>Seed <input id="bt-seed" type="number" min="1" value="42"></label>
        <label>% saldo / trade <input id="bt-por-trade" type="number" min="0.1" max="100" step="0.5" value="5"></label>
        <label>Take-profit (%) <input id="bt-tp" type="number" min="0.1" value="20"></label>
        <label>Stop-loss (%) <input id="bt-sl" type="number" min="0.1" max="100" value="25"></label>
        <label>Perda diária máx. (%) <input id="bt-daily-loss" type="number" min="0.1" max="100" step="0.1" value="5"></label>
        <label>Exposição / mercado (%) <input id="bt-market-exposure" type="number" min="0.1" max="100" value="15"></label>
        <label>Posição máx. (%) <input id="bt-position" type="number" min="0.1" max="100" value="10"></label>
        <label>Cooldown perda (min) <input id="bt-cooldown" type="number" min="0" value="10"></label>
        <label>Máx. posições <input id="bt-max-positions" type="number" min="1" max="100" value="10"></label>
        <label>Preço mín. (¢) <input id="bt-min-price" type="number" min="0.1" max="99.9" step="0.1" value="5"></label>
        <label>Preço máx. (¢) <input id="bt-max-price" type="number" min="0.1" max="100" step="0.1" value="75"></label>
      </div>

      <div class="backtest-actions">
        <button class="btn btn-buy" id="bt-run">▶ Rodar estratégia</button>
        <button class="btn btn-refresh" id="bt-compare">⚖ Comparar todas</button>
        <span id="bt-progress" class="backtest-progress">Pronto.</span>
      </div>

      <div id="bt-results" class="backtest-results" style="display:none;">
        <div id="bt-meta" class="backtest-meta"></div>
        <div id="bt-metrics" class="backtest-metrics"></div>
        <div class="backtest-chart-grid">
          <div class="backtest-chart-card"><h3>Equity — validação OOS</h3><canvas id="bt-equity-chart"></canvas></div>
          <div class="backtest-chart-card"><h3>Drawdown — validação OOS</h3><canvas id="bt-drawdown-chart"></canvas></div>
        </div>
        <div id="bt-confidence" class="backtest-confidence"></div>
        <div id="bt-comparison" class="backtest-comparison"></div>
        <div id="bt-trades" class="backtest-trades"></div>
        <div id="bt-audit" class="backtest-audit"></div>
      </div>
    </div>`;
  document.getElementById('app')?.insertBefore(section, document.getElementById('modal-reset'));

  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(item => {
      const active = item === tab;
      item.classList.toggle('active', active);
      item.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    document.querySelectorAll('.tab-content').forEach(content => content.classList.toggle('active', content === section));
  });

  document.getElementById('bt-run')?.addEventListener('click', () => execute(false));
  document.getElementById('bt-compare')?.addEventListener('click', () => execute(true));
}

function setBusy(busy, message) {
  for (const id of ['bt-run', 'bt-compare']) {
    const button = document.getElementById(id);
    if (button) button.disabled = busy;
  }
  const progress = document.getElementById('bt-progress');
  if (progress && message) progress.textContent = message;
}

async function getHistorical(settings) {
  const fingerprint = settingsFingerprint(settings);
  if (cachedHistorical?.fingerprint === fingerprint) return cachedHistorical.payload;
  const current = await fetchMarkets({ limit: 50 });
  const payload = await fetchHistoricalDataset(current, {
    days: settings.days,
    fidelityMinutes: settings.fidelityMinutes,
    maxMarkets: settings.maxMarkets,
    universeMode: settings.universeMode,
    seed: settings.seed,
    onProgress: progress => setBusy(true, `Baixando histórico ${progress.completed}/${progress.total}…`),
  });
  cachedHistorical = { fingerprint, payload };
  return payload;
}

async function execute(compareAll) {
  const settings = readSettings();
  setBusy(true, 'Selecionando universo histórico…');
  try {
    const historical = await getHistorical(settings);
    setBusy(true, `Executando ${historical.dataset.length} barras…`);
    if (compareAll) {
      const rows = compareStrategies(historical.dataset, settings);
      renderResult(rows[0]?.result || null, historical, rows);
    } else {
      const result = runBacktest(historical.dataset, settings);
      renderResult(result, historical, null);
    }
    setBusy(false, `Concluído: ${historical.dataset.length} barras · ${historical.markets.length} mercados utilizáveis.`);
  } catch (error) {
    console.error('backtest:', error);
    setBusy(false, `Falha: ${error?.message || error}`);
    const results = document.getElementById('bt-results');
    if (results) results.style.display = 'none';
  }
}

function metricCard(label, value, detail = '') {
  return `<div class="bt-metric-card"><span>${esc(label)}</span><strong>${esc(value)}</strong>${detail ? `<small>${esc(detail)}</small>` : ''}</div>`;
}

function renderResult(result, historical, comparison) {
  if (!result) return;
  const results = document.getElementById('bt-results');
  if (results) results.style.display = 'block';
  const m = result.validationMetrics;
  const full = result.fullMetrics;
  const universe = historical.universe || {};
  document.getElementById('bt-meta').innerHTML = `
    <strong>${esc(STRATEGY_LABELS[result.config.strategy] || result.config.strategy)}</strong>
    · ${esc(dateTime(result.startTimestamp))} → ${esc(dateTime(result.endTimestamp))}
    · ${result.bars} barras
    · treino/warmup ${result.trainingBars} / validação ${result.validationBars}
    · universo ${esc(universe.mode || '—')} (${universe.usable ?? historical.markets.length}/${universe.selected ?? historical.markets.length} utilizáveis; ${universe.candidates ?? '—'} candidatos)`;

  document.getElementById('bt-metrics').innerHTML = [
    metricCard('Retorno OOS', pct(m?.returnPct), `Full: ${pct(full?.returnPct)}`),
    metricCard('P&L OOS', money(m?.netProfit), `Equity: ${money(m?.endEquity)}`),
    metricCard('Max drawdown', pct(m?.maxDrawdownPct), `${m?.maxDrawdownDurationBars ?? 0} barras`),
    metricCard('Sharpe', num(m?.sharpe), 'annualizado por intervalo mediano'),
    metricCard('Sortino', num(m?.sortino), 'annualizado por intervalo mediano'),
    metricCard('Profit factor', Number.isFinite(m?.profitFactor) ? num(m.profitFactor) : '∞', `${m?.closedTrades ?? 0} trades fechados`),
    metricCard('Win rate', pct(m?.winRatePct), `Expectância ${money(m?.expectancy)}`),
    metricCard('Exposição média', pct(m?.averageGrossExposurePct), `Turnover ${money(m?.turnover)}`),
    metricCard('Custos estimados', money((m?.totalFees || 0) + (m?.slippageCost || 0)), `fees ${money(m?.totalFees)} · slippage ${money(m?.slippageCost)}`),
    metricCard('Controles de risco', `${m?.riskSkips ?? 0} bloqueios`, `${m?.rejectedOrders ?? 0} ordens rejeitadas`),
  ].join('');

  drawSeries(document.getElementById('bt-equity-chart'), result.validationEquityCurve, point => point.equity, false);
  drawSeries(document.getElementById('bt-drawdown-chart'), m?.drawdownSeries || [], point => point.drawdownPct, true);

  const ci = result.confidence;
  document.getElementById('bt-confidence').innerHTML = ci
    ? `<strong>Incerteza OOS — block bootstrap 95%</strong><span>${pct(ci.low95)} a ${pct(ci.high95)} · mediana ${pct(ci.median)} · ${ci.iterations} reamostragens · bloco ${ci.blockSize}</span>`
    : '<strong>Incerteza OOS</strong><span>Amostra pequena demais para bootstrap por blocos (mínimo de 20 retornos).</span>';

  renderComparison(comparison);
  renderTrades(result.validationTrades || []);
  document.getElementById('bt-audit').innerHTML = `
    <h3>Auditoria metodológica</h3>
    <div class="bt-audit-grid">
      <span>✓ Sinal usa apenas presente/passado</span>
      <span>✓ Execução atrasada em 1 barra</span>
      <span>✓ Sem entrada na última barra executável</span>
      <span>✓ Validação OOS começa flat</span>
      <span>✓ Warmup pré-OOS não altera capital</span>
      <span>✓ Seed reproduzível (${esc(result.config.seed)})</span>
      <span>✓ Forward-fill limitado a ${esc(historical.maxForwardFillBuckets ?? 3)} barras</span>
      <span>✓ Liquidação final explícita</span>
      <span>Fee: ${esc(result.config.feeBps)} bps</span>
      <span>Slippage: ${esc(result.config.slippageBps)} bps</span>
      <span class="bt-limit">⚠ Profundidade histórica do order book não modelada</span>
      <span class="bt-limit">⚠ Custos são hipóteses do usuário, não fee histórico reconstruído</span>
      <span class="bt-limit">⚠ O índice Gamma disponível hoje pode omitir mercados históricos removidos/desindexados</span>
    </div>`;
}

function renderComparison(rows) {
  const container = document.getElementById('bt-comparison');
  if (!container) return;
  if (!rows) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = `
    <h3>Comparação fora da amostra</h3>
    <div class="bt-table-wrap"><table class="bt-table"><thead><tr><th>Estratégia</th><th>Retorno</th><th>Max DD</th><th>Sharpe</th><th>Sortino</th><th>PF</th><th>Trades</th><th>Custos</th></tr></thead><tbody>
    ${rows.map(({ strategy, result }) => {
      const m = result.validationMetrics;
      return `<tr><td>${esc(STRATEGY_LABELS[strategy] || strategy)}</td><td>${esc(pct(m?.returnPct))}</td><td>${esc(pct(m?.maxDrawdownPct))}</td><td>${esc(num(m?.sharpe))}</td><td>${esc(num(m?.sortino))}</td><td>${esc(Number.isFinite(m?.profitFactor) ? num(m.profitFactor) : '∞')}</td><td>${m?.closedTrades ?? 0}</td><td>${esc(money((m?.totalFees || 0) + (m?.slippageCost || 0)))}</td></tr>`;
    }).join('')}
    </tbody></table></div>
    <p class="bt-method-note">Ordenação: retorno OOS. Comparar várias estratégias no mesmo OOS aumenta risco de seleção; trate a vencedora como hipótese para um novo período, não como prova definitiva.</p>`;
}

function renderTrades(trades) {
  const container = document.getElementById('bt-trades');
  if (!container) return;
  const closed = trades.filter(trade => trade.side === 'sell').slice(-25).reverse();
  if (!closed.length) {
    container.innerHTML = '<h3>Trades OOS</h3><p class="bt-method-note">Nenhum trade fechado no período de validação.</p>';
    return;
  }
  container.innerHTML = `
    <h3>Últimos trades OOS</h3>
    <div class="bt-table-wrap"><table class="bt-table"><thead><tr><th>Data</th><th>Mercado</th><th>Outcome</th><th>Shares</th><th>Preço</th><th>P&L líquido</th><th>Saída</th></tr></thead><tbody>
    ${closed.map(trade => `<tr><td>${esc(dateTime(trade.timestamp))}</td><td>${esc(trade.marketQuestion)}</td><td>${esc(trade.outcome)}</td><td>${trade.shares}</td><td>${esc((trade.price * 100).toFixed(1) + '¢')}</td><td>${esc(money(trade.pnl))}</td><td>${esc(trade.reason)}</td></tr>`).join('')}
    </tbody></table></div>`;
}

function drawSeries(canvas, points, getter, zeroLine) {
  if (!canvas?.getContext) return;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(300, canvas.clientWidth || 640);
  const height = Math.max(180, canvas.clientHeight || 240);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const values = (points || []).map(getter).map(Number).filter(Number.isFinite);
  if (values.length < 2) {
    ctx.fillStyle = '#8b919e';
    ctx.font = '13px system-ui';
    ctx.fillText('Dados insuficientes para o gráfico.', 16, 28);
    return;
  }
  let min = Math.min(...values);
  let max = Math.max(...values);
  if (zeroLine) max = Math.max(0, max);
  if (max === min) { max += 1; min -= 1; }
  const pad = 16;
  const x = i => pad + i / (values.length - 1) * (width - pad * 2);
  const y = value => pad + (max - value) / (max - min) * (height - pad * 2);
  ctx.strokeStyle = 'rgba(139,145,158,.18)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const yy = pad + i / 4 * (height - pad * 2);
    ctx.beginPath(); ctx.moveTo(pad, yy); ctx.lineTo(width - pad, yy); ctx.stroke();
  }
  if (zeroLine && min < 0 && max >= 0) {
    ctx.strokeStyle = 'rgba(255,255,255,.3)';
    ctx.beginPath(); ctx.moveTo(pad, y(0)); ctx.lineTo(width - pad, y(0)); ctx.stroke();
  }
  ctx.strokeStyle = zeroLine ? '#ef4444' : '#22c55e';
  ctx.lineWidth = 2;
  ctx.beginPath();
  values.forEach((value, i) => i ? ctx.lineTo(x(i), y(value)) : ctx.moveTo(x(i), y(value)));
  ctx.stroke();
}

injectUI();
