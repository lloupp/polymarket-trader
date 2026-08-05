# Polymarket Trader — Plano de Desenvolvimento Incremental

## Skill de referência: `polymarket-trader-builder`
TODAS as fases devem seguir a skill `polymarket-trader-builder` (carregada no cron).

## Status: Fase 2 concluída — próxima é Fase 3 (API e Mercados)

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

### Fase 3 — API e Mercados [PENDENTE]
- Implementar js/api.js: buscar mercados do Polymarket (Gamma API)
- Fallback: sample-markets.json offline
- Renderizar lista com busca e filtro por categoria
- Auto-refresh de preços
- Commit: `feat: API e mercados`

### Fase 4 — Carteira e Comprar/Vender [PENDENTE]
- Implementar js/wallet.js: init, getBalance, buy, sell, reset
- Modal de compra: outcome, quantidade, preview do custo
- Modal de venda: posição, quantidade, preview do retorno
- Validação: saldo suficiente, shares suficientes
- Persistência localStorage
- Commit: `feat: carteira e comprar/vender`

### Fase 5 — Portfolio e P&L [PENDENTE]
- Posições abertas com P&L em tempo real
- Cálculo: preço médio, custo, valor atual, P&L, P&L %
- Dashboard: saldo, P&L total, alocação
- Gráfico de pizza (Canvas): alocação da carteira
- Commit: `feat: portfolio e P&L`

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
