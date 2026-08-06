# 📈 Polymarket Trader — Simulação de Carteira

Trader de simulação do Polymarket: carteira fictícia, compra/venda de shares, P&L em tempo real e portfolio. Treine trading sem arriscar dinheiro real.

🔗 **Demo:** [https://lloupp.github.io/polymarket-trader/](https://lloupp.github.io/polymarket-trader/)

## Recursos

- 💵 **Carteira fictícia** — saldo inicial configurável (default $1,000)
- 🛒 **Compra e venda** — buy/sell shares de Yes ou No com preview em tempo real
- 📊 **P&L em tempo real** — lucro/prejuízo por posição e total (realizado + não realizado)
- 📋 **Portfolio** — posições abertas com preço médio, valor de mercado e gráfico de alocação (donut)
- 📜 **Histórico de trades** — log completo com filtros, estatísticas e gráfico de performance (equity curve)
- 🔍 **Mercados reais** — busca mercados do Polymarket (Gamma API) com auto-refresh de preços
- 📈 **Gráficos Canvas** — alocação da carteira (pizza) e performance ao longo do tempo (linha) com DPI-aware rendering
- 💾 **Offline** — dados salvos no navegador (localStorage, prefixo `pm_`)
- 🌙 **Tema escuro** nativo
- 📱 **Responsivo** — celular, tablet e desktop
- ⌨️ **Keyboard shortcuts** — ESC fecha modais, Enter confirma operações
- ♿ **Accessibility** — ARIA labels, role=dialog, focus-visible, touch targets 44px+

## Tech Stack

- HTML5 + CSS3 + JavaScript vanilla (ES modules, sem frameworks, sem build)
- Polymarket Gamma API (mercados e preços em tempo real)
- Canvas API para gráficos (pizza de alocação + linha de equity curve)
- localStorage (prefixo `pm_` para todas as chaves)
- GitHub Pages para deploy

## Como usar

### Online
Acesse: [https://lloupp.github.io/polymarket-trader/](https://lloupp.github.io/polymarket-trader/)

### Local
Abra `index.html` no navegador. Comece com $1,000 fictícios. Pronto.

## Estrutura do projeto

```
polymarket-trader/
├── index.html              — layout, modais e tabs
├── css/style.css           — tema escuro, responsividade, animações
├── js/
│   ├── app.js              — navegação, renderização, event binding
│   ├── api.js             — Gamma API (fetch, cache, refresh, fallback)
│   ├── wallet.js           — carteira (saldo, buy, sell, reset, posições)
│   ├── portfolio.js        — posições, P&L, gráfico de alocação
│   ├── trades.js           — histórico, estatísticas, equity curve, CSV
│   ├── utils.js            — formatação, storage, helpers
│   └── bot.js             — (placeholder) motor de negociação autônoma
├── data/sample-markets.json — mercados de exemplo (fallback offline)
├── .github/workflows/deploy.yml — GitHub Actions: deploy automático no Pages
├── .gitignore
├── PROGRESS.md             — tracking de fases de desenvolvimento
└── README.md
```

## Mercado de dados

A app usa a [Gamma API do Polymarket](https://gamma-api.polymarket.com) — gratuita, sem auth, com CORS habilitado. Os preços de shares vão de $0 a $1 (simulando probabilidade). O payout é $1 se o outcome estiver correto na resolução do mercado.

Os dados da carteira (saldo, posições, trades) são persistidos em `localStorage` sob as chaves prefixadas com `pm_`:
- `pm_wallet` — saldo, posições e trades
- `pm_watchlist` — mercados favoritos
- `pm_settings` — preferências

## Licença

MIT
