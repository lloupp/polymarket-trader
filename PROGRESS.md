# Polymarket Trader — Plano de Desenvolvimento Incremental

## Skill de referência: `polymarket-trader-builder`
TODAS as fases devem seguir a skill `polymarket-trader-builder` (carregada no cron).

## Status: Fase 5 concluída — próxima é Fase 6 (Histórico e Performance)

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

### Fase 6 — Histórico e Performance [PENDENTE]
- Log de trades com filtros e exportação CSV
- Gráfico de linha (Canvas): performance ao longo do tempo
- Estatísticas: win rate, melhor/pior trade, ticket médio
- Commit: `feat: histórico e performance`

### Fase 7 — Polimento [PENDENTE]
- Toast, animações, responsividade mobile
- Confirmação ao resetar carteira
- Validação completa
- Commit: `feat: polimento`

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
