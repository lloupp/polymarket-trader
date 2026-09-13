// backtest-advanced-ui.js — UI para walk-forward, benchmark e stress de custos

import { fetchMarkets } from './api.js';
import { fetchHistoricalDataset } from './backtest-data.js';
import { walkForwardValidate, runCostStressMatrix } from './backtest-advanced.js';

const LABELS = {
  momentum: 'Momentum',
  meanReversion: 'Reversão à Média',
  bargainHunting: 'Comprar Barato',
  valueBetting: 'Value Betting',
  kelly: '½-Kelly',
  random: 'Aleatória',
};

let cache = null;

function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function readNumber(id, fallback) {
  const n = Number(document.getElementById(id)?.value);
  return Number.isFinite(n) ? n : fallback;
}

function pct(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
}

function dateShort(timestamp) {
  const d = new Date(Number(timestamp));
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString('pt-BR') : '—';
}

function coreSettings() {
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

function walkSettings() {
  return {
    selectionMode: document.getElementById('bt-wf-selection')?.value || 'fixed',
    trainPct: readNumber('bt-wf-train', 50),
    testPct: readNumber('bt-wf-test', 15),
    innerOosPct: readNumber('bt-wf-inner', 30),
  };
}

function datasetFingerprint(settings) {
  return JSON.stringify({
    days: settings.days,
    fidelityMinutes: settings.fidelityMinutes,
    maxMarkets: settings.maxMarkets,
    universeMode: settings.universeMode,
    seed: settings.seed,
  });
}

async function getDataset(settings) {
  const fingerprint = datasetFingerprint(settings);
  if (cache?.fingerprint === fingerprint) return cache.payload;
  const current = await fetchMarkets({ limit: 50 });
  const payload = await fetchHistoricalDataset(current, {
    days: settings.days,
    fidelityMinutes: settings.fidelityMinutes,
    maxMarkets: settings.maxMarkets,
    universeMode: settings.universeMode,
    seed: settings.seed,
    onProgress: progress => setBusy(true, `Histórico ${progress.completed}/${progress.total}…`),
  });
  cache = { fingerprint, payload };
  return payload;
}

function metric(label, value, detail = '') {
  return `<div class="bt-metric-card"><span>${esc(label)}</span><strong>${esc(value)}</strong>${detail ? `<small>${esc(detail)}</small>` : ''}</div>`;
}

function injectAdvancedPanel() {
  const host = document.querySelector('#tab-backtest .backtest-content');
  if (!host || document.getElementById('bt-advanced-panel')) return Boolean(host);
  const panel = document.createElement('div');
  panel.id = 'bt-advanced-panel';
  panel.className = 'bt-advanced-panel';
  panel.innerHTML = `
    <div class="bt-advanced-header">
      <div><h3>Validação avançada</h3><p>Walk-forward externo não sobreposto, seleção opcional aninhada e stress de custos sobre múltiplas janelas.</p></div>
      <span class="backtest-badge">WALK-FORWARD · STRESS</span>
    </div>
    <div class="bt-advanced-controls">
      <label>Seleção por fold
        <select id="bt-wf-selection"><option value="fixed" selected>Estratégia fixa escolhida acima</option><option value="nestedBest">Nested: melhor estratégia no treino</option></select>
      </label>
      <label>Janela treino (%) <input id="bt-wf-train" type="number" min="20" max="80" value="50"></label>
      <label>Janela teste (%) <input id="bt-wf-test" type="number" min="10" max="35" value="15"></label>
      <label>OOS interno da seleção (%) <input id="bt-wf-inner" type="number" min="15" max="50" value="30"></label>
    </div>
    <div class="backtest-actions">
      <button class="btn btn-buy" id="bt-wf-run">↻ Rodar walk-forward</button>
      <button class="btn btn-refresh" id="bt-stress-run">▦ Stress fees/slippage</button>
      <span id="bt-advanced-progress" class="backtest-progress">Pronto para validação avançada.</span>
    </div>
    <div id="bt-advanced-results" class="bt-advanced-results" style="display:none;">
      <div id="bt-wf-metrics" class="backtest-metrics"></div>
      <div class="backtest-chart-card"><h3>Equity walk-forward vs benchmark passivo</h3><canvas id="bt-wf-chart"></canvas></div>
      <div id="bt-wf-folds" class="backtest-comparison"></div>
      <div id="bt-stress-results" class="backtest-comparison"></div>
      <div id="bt-wf-audit" class="backtest-audit"></div>
    </div>`;
  host.appendChild(panel);
  document.getElementById('bt-wf-run')?.addEventListener('click', runWalkForward);
  document.getElementById('bt-stress-run')?.addEventListener('click', runStress);
  return true;
}

function setBusy(busy, message) {
  for (const id of ['bt-wf-run', 'bt-stress-run']) {
    const button = document.getElementById(id);
    if (button) button.disabled = busy;
  }
  const progress = document.getElementById('bt-advanced-progress');
  if (progress && message) progress.textContent = message;
}

async function runWalkForward() {
  const core = coreSettings();
  const walk = walkSettings();
  setBusy(true, 'Preparando walk-forward…');
  try {
    const historical = await getDataset(core);
    const wf = walkForwardValidate(historical.dataset, core, walk);
    renderWalkForward(wf, historical);
    setBusy(false, `Walk-forward concluído: ${wf.summary.folds} folds externos.`);
  } catch (error) {
    console.error('walk-forward:', error);
    setBusy(false, `Falha: ${error?.message || error}`);
  }
}

async function runStress() {
  const core = coreSettings();
  const walk = walkSettings();
  setBusy(true, 'Preparando stress de custos…');
  try {
    const historical = await getDataset(core);
    const stress = runCostStressMatrix(historical.dataset, core, walk);
    renderStress(stress, core);
    setBusy(false, `Stress concluído: ${stress.summary.scenarios} cenários sobre walk-forward.`);
  } catch (error) {
    console.error('stress:', error);
    setBusy(false, `Falha: ${error?.message || error}`);
  }
}

function renderWalkForward(wf, historical) {
  const results = document.getElementById('bt-advanced-results');
  if (results) results.style.display = 'flex';
  const s = wf.summary;
  const selection = wf.options.selectionMode === 'nestedBest' ? 'seleção aninhada' : `fixa: ${LABELS[wf.config.strategy] || wf.config.strategy}`;
  document.getElementById('bt-wf-metrics').innerHTML = [
    metric('Retorno WF composto', pct(s.compoundedReturnPct), `${s.folds} folds não sobrepostos`),
    metric('Benchmark passivo', pct(s.benchmarkCompoundedReturnPct), 'favorito no início de cada teste'),
    metric('Alpha composto', pct(s.compoundedAlphaPct), `mediana por fold ${pct(s.medianAlphaPct)}`),
    metric('Folds positivos', pct(s.positiveFoldPct), `pior fold ${pct(s.worstFoldReturnPct)}`),
    metric('Bateu benchmark', pct(s.beatBenchmarkPct), `melhor fold ${pct(s.bestFoldReturnPct)}`),
    metric('Max drawdown WF', pct(s.maxStitchedDrawdownPct), `benchmark ${pct(s.benchmarkMaxDrawdownPct)}`),
  ].join('');

  drawDualSeries(document.getElementById('bt-wf-chart'), wf.strategyCurve, wf.benchmarkCurve);
  document.getElementById('bt-wf-folds').innerHTML = `
    <h3>Folds externos</h3>
    <div class="bt-table-wrap"><table class="bt-table"><thead><tr><th>Fold</th><th>Teste</th><th>Estratégia</th><th>Retorno</th><th>Benchmark</th><th>Alpha</th><th>Max DD</th></tr></thead><tbody>
    ${wf.folds.map(fold => `<tr><td>${fold.index}</td><td>${esc(dateShort(fold.testStart))} → ${esc(dateShort(fold.testEnd))}</td><td>${esc(LABELS[fold.selectedStrategy] || fold.selectedStrategy)}</td><td>${esc(pct(fold.returnPct))}</td><td>${esc(pct(fold.benchmarkReturnPct))}</td><td>${esc(pct(fold.alphaPct))}</td><td>${esc(pct(fold.result.validationMetrics?.maxDrawdownPct))}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="bt-method-note">Modo: ${esc(selection)} · treino ${wf.options.trainBars} barras · teste ${wf.options.testBars} barras · passo ${wf.options.stepBars}. Testes externos não se sobrepõem.</p>`;
  document.getElementById('bt-wf-audit').innerHTML = `
    <h3>Auditoria walk-forward</h3><div class="bt-audit-grid">
      <span>✓ Folds externos sem sobreposição</span>
      <span>✓ Cada fold externo começa com capital limpo</span>
      <span>✓ Benchmark decide no início do teste e executa 1 barra depois</span>
      <span>✓ Seleção nested usa somente dados de treino</span>
      <span>✓ Custos e guardrails reaplicados em cada fold</span>
      <span>✓ Universo/dados idênticos entre estratégia e benchmark</span>
      <span>Mercados utilizáveis: ${esc(historical.markets.length)}</span>
      <span class="bt-limit">⚠ Walk-forward mede estabilidade histórica, não elimina regime shift futuro</span>
      <span class="bt-limit">⚠ Selecionar entre várias estratégias ainda exige confirmação em períodos futuros independentes</span>
      <span class="bt-limit">⚠ Benchmark passivo é referência simples, não carteira ótima</span>
    </div>`;
}

function renderStress(stress, core) {
  const results = document.getElementById('bt-advanced-results');
  if (results) results.style.display = 'flex';
  const s = stress.summary;
  const rowsByFee = new Map(stress.feeGrid.map(fee => [fee, stress.rows.filter(row => row.feeBps === fee)]));
  document.getElementById('bt-stress-results').innerHTML = `
    <h3>Stress de custos — retorno walk-forward composto</h3>
    <div class="bt-stress-summary">
      ${metric('Cenários positivos', pct(s.positiveScenarioPct), `${s.scenarios} cenários`)}
      ${metric('Bate benchmark', pct(s.beatBenchmarkScenarioPct), `pior alpha ${pct(s.worstAlphaPct)}`)}
      ${metric('Pior cenário', pct(s.worstReturnPct), `mediana ${pct(s.medianReturnPct)}`)}
      ${metric('Tolerância slippage', s.maxPositiveSlippageAtConfiguredFeeBps == null ? 'nenhuma' : `${s.maxPositiveSlippageAtConfiguredFeeBps} bps`, `fee atual ${core.feeBps} bps`)}
    </div>
    <div class="bt-table-wrap"><table class="bt-table bt-stress-table"><thead><tr><th>Fee \\ Slippage</th>${stress.slippageGrid.map(value => `<th>${value} bps</th>`).join('')}</tr></thead><tbody>
      ${stress.feeGrid.map(fee => `<tr><th>${fee} bps</th>${(rowsByFee.get(fee) || []).map(row => `<td title="Alpha ${esc(pct(row.alphaPct))} · DD ${esc(pct(row.maxDrawdownPct))}">${esc(pct(row.compoundedReturnPct))}</td>`).join('')}</tr>`).join('')}
    </tbody></table></div>
    <p class="bt-method-note">Cada célula reexecuta a estratégia fixa nos mesmos folds externos. A grade inclui os custos configurados pelo usuário além dos cenários padrão.</p>`;
}

function drawDualSeries(canvas, strategyCurve, benchmarkCurve) {
  if (!canvas?.getContext) return;
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(320, canvas.clientWidth || 800);
  const height = Math.max(220, canvas.clientHeight || 280);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const all = [...(strategyCurve || []), ...(benchmarkCurve || [])].map(point => Number(point.equity)).filter(Number.isFinite);
  if (all.length < 2) return;
  let min = Math.min(...all);
  let max = Math.max(...all);
  if (min === max) { min -= 1; max += 1; }
  const pad = 18;
  ctx.strokeStyle = 'rgba(139,145,158,.18)';
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) {
    const y = pad + i / 4 * (height - pad * 2);
    ctx.beginPath(); ctx.moveTo(pad, y); ctx.lineTo(width - pad, y); ctx.stroke();
  }
  const draw = (curve, color) => {
    if (!curve?.length) return;
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.beginPath();
    curve.forEach((point, i) => {
      const x = pad + i / Math.max(1, curve.length - 1) * (width - pad * 2);
      const y = pad + (max - point.equity) / (max - min) * (height - pad * 2);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  };
  draw(strategyCurve, '#22c55e');
  draw(benchmarkCurve, '#60a5fa');
  ctx.font = '12px system-ui';
  ctx.fillStyle = '#22c55e'; ctx.fillText('Estratégia', pad, 14);
  ctx.fillStyle = '#60a5fa'; ctx.fillText('Benchmark', pad + 75, 14);
}

function init(retries = 20) {
  if (injectAdvancedPanel()) return;
  if (retries > 0) setTimeout(() => init(retries - 1), 0);
}

init();
