# Polymarket Trader — Plano de Desenvolvimento Incremental

## Skill de referência: `polymarket-trader-builder`
TODAS as fases devem seguir a skill `polymarket-trader-builder` (carregada no cron).

## Status: Fase 7 concluída — próxima é Fase 8 (Deploy GitHub Pages)

## Fases

### Fase 1 — Pesquisa [CONCLUÍDO — 2026-08-05]
- ✅ Pesquisar: API pública do Polymarket (Gamma API, CLOB API)
- ✅ Identificar endpoints: `/markets`, `/events`, `/tags`, `/markets/{id}`, `/events/{id}`
- ✅ Estudar como shares funcionam (preço 0-$1, payout $1 se acertar)
- ✅ Estudar UX de plataformas de trading simulado
- ✅ Documentação completa em `docs/api-research.md`
- ✅ Sample markets reais da API em `data/sample-markets.json` (10 mercados, 4 categorias)
- ✅ Skill atualizada com endpoints e detalhes da API
- Commit: `docs: Fase 1 — pesquisa + skill`

### Fase 2 — Layout e Dashboard [CONCLUÍDO — 2026-08-05]
- ✅ Header com saldo, P&L total, botão reset
- ✅ Tabs: Mercados | Portfolio | Histórico
- ✅ Card de mercado: pergunta, preços Yes/No, volume, liquidez, categoria
- ✅ CSS: tema escuro, cards, cores verde/vermelho
- ✅ Busca de mercados + filtro por categoria
- ✅ Modal de confirmação ao resetar carteira
- ✅ Toast notifications
- ✅ Responsividade mobile
- ✅ Carteira init em localStorage (pm_wallet, $1,000 default)
- ✅ Commit: `feat: layout e dashboard`

### Fase 3 — API e Mercados [CONCLUÍDO — 2026-08-05]
- ✅ Implementar js/api.js: buscar mercados do Polymarket (Gamma API `/events`)
- ✅ Endpoint primário: `GET /events?limit=50&active=true&closed=false&order=volume&ascending=false`
- ✅ Tratamento de `outcomes`/`outcomePrices` como JSON strings (pegadinha crítica)
- ✅ Categorização client-side por tags dentro do evento (api mapeia ~120 slugs → 8 categorias)
- ✅ Fallback: sample-markets.json offline quando API falha
- ✅ Cache em memória de 60s (não localStorage — economia de quota)
- ✅ `refreshPrices()` atualiza só preços sem re-renderizar cards (preserva DOM/bindings)
- ✅ `clearCache()` para forçar re-fetch no reset da carteira
- ✅ Auto-refresh a cada 60s via setInterval (só roda se aba Mercados visível e !document.hidden)
- ✅ Indicador de fonte: 🟢 Gamma API / 🟡 Dados de exemplo / 🟠 Cache / 🔴 Falha
- ✅ Botão "⟳ Atualizar preços" manual na toolbar de mercados
- ✅ Testes completos: 1462/1462 mercados reais mapeados sem nulls
- ✅ Testes de fallback, cache em memória, clearCache, categorização, JSON strings
- ✅ Commit: `feat: API e mercados`

### Fase 4 — Carteira e Comprar/Vender [CONCLUÍDO — 2026-08-05]
- ✅ Implementar js/wallet.js: init, getBalance, buy, sell, reset
- ✅ Modal de compra: outcome, quantidade, preview do custo
- ✅ Modal de venda: posição, quantidade, preview do retorno
- ✅ Validação: saldo suficiente, shares suficientes
- ✅ Persistência localStorage
- ✅ Commit: `feat: carteira e comprar/vender`

### Fase 5 — Portfolio e P&L [CONCLUÍDO — 2026-08-05]
- ✅ Criado js/portfolio.js: funções reutilizáveis (computePositionMetrics, computePortfolioSummary, getAllocationData, drawAllocationPie, renderAllocationLegend, renderPositionCards)
- ✅ Posições abertas com P&L em tempo real (preço médio, custo, valor atual, P&L, P&L %)
- ✅ Dashboard: saldo, P&L total, valor investido, valor atual, patrimônio total
- ✅ Gráfico de pizza (donut Canvas): alocação da carteira por mercado
- ✅ Legenda do gráfico com cores, valores e percentuais
- ✅ Barra de alocação por posição (% do portfólio em cada card)
- ✅ Agrupamento de posições por marketId (Yes/No do mesmo mercado juntos no gráfico)
- ✅ Top 10 fatias + "Outros" quando > 11 mercados
- ✅ DPI-aware canvas rendering (telas HiDPI)
- ✅ app.js refatorado para delegar cálculos de portfolio a portfolio.js
- ✅ Testes lógicos: P&L individual, agregado, multi-posição, alocação multi-mercado
- ✅ Commit: `feat: portfolio e P&L` (hash `a537b52`)

### Fase 6 — Histórico e Performance [CONCLUÍDO — 2026-08-06]
- ✅ Implementar js/trades.js: módulo completo com filtros, tabela, exportação CSV
- ✅ Gráfico de linha (Canvas): performance da carteira ao longo do tempo (equity curve)
- ✅ Estatísticas: win rate, melhor trade, pior trade, ticket médio, total volume, P&L realizado
- ✅ `computeStats()` calcula P&L por venda (considerando preço médio ponderado via cost basis)
- ✅ `buildEquityCurve()` reconstroi a evolução do patrimônio (saldo + investido)
- ✅ `drawPerformanceChart()` gráfico de linha DPI-aware com grid, labels, linha de referência
- ✅ Tabela de trades com badges de tipo (Compra/Venda) e outcome (Yes/No), datas formatadas
- ✅ Filtros: Todos | Compras | Vendas (botões na toolbar)
- ✅ Exportação CSV via Blob download
- ✅ CSS: tema escuro consistente, tabela scrollável no mobile, gráfico de performance
- ✅ app.js: atualiza histórico após compra/venda/reset se aba histórico ativa
- ✅ Testes lógicos: filtro (5/3/2), stats (winRate 50%, P&L das vendas $5/-$5), equity curve (6 pontos), CSV (5 linhas)
- ✅ Commit: `feat: histórico e performance — Fase 6` (hash `16b40ac`)

### Fase 7 — Polimento [CONCLUÍDO — 2026-08-06]
- ✅ Animações: fade-in + stagger em cards de mercado e posições
- ✅ Skeleton loaders (shimmer) durante carregamento de mercados
- ✅ Toast com fade-out animado ao auto-dismiss (3s + 300ms fade)
- ✅ Modal com scale-in animation + backdrop blur
- ✅ Pulse no P&L header quando muda de valor
- ✅ Tab transition: fade-in ao trocar de aba
- ✅ Empty states bonitos: ícone + título + descrição (Mercados, Portfolio, Histórico)
- ✅ Keyboard shortcuts: ESC fecha modais, Enter confirma compra/venda
- ✅ Autofocus + select no input de quantidade ao abrir modais (compra/venda)
- ✅ aria-labels, role=dialog, aria-modal, aria-selected, role=tablist (accessibility)
- ✅ focus-visible outline em elementos interativos
- ✅ Touch targets 44px mínimo em dispositivos sem hover
- ✅ Validação robusta: Math.max(0, Math.floor(...)) em todos os inputs de quantidade
- ✅ Bug fix: escapeHtmlAttr em trades.js não escapava & e " corretamente
- ✅ Responsividade: portfolio chart em coluna no mobile, scrollbar styled
- ✅ Stat cards com hover effect (border + translateY)
- ✅ Commit: `feat: polimento` (hash `c73ce69`)

### Fase 8 — Deploy GitHub Pages [PENDENTE]
- Configurar Pages, verificar, atualizar README
- Commit: `deploy: GitHub Pages`

### Fase 9 — Motor de Negociação Autônoma (Auto-Trader) [PENDENTE]
- Implementar js/bot.js: ciclo de avaliação via setInterval
- Estratégias: momentum, reversão à média, comprar barato amplo, aleatória
- Gestão de posições: take-profit e stop-loss automáticos
- Painel de controle: ligar/desligar bot, escolher estratégia, ajustar limites (porTrade, maxOpenPositions, profitTarget, stopLoss, intervalMs)
- Log de ações do bot (pm_bot_log) com timestamp
- Histórico de preços por mercado (pm_market_history) para estratégia momentum
- Integração com wallet.js (comprar/vender)
- Testes completos
- Commit: `feat: motor de negociação autônoma`

## Regras do cron
1. Ler PROGRESS.md
2. Implementar fase completa
3. Testar (node -c, HTML, JSON, localStorage)
4. Commit + push
5. Atualizar status
6. Reportar
