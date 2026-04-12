---
name: crypto-auto-trading
description: "Fully automated cryptocurrency trading system on MAX Exchange (MaiCoin). Covers market analysis (candlestick patterns, chart patterns, indicators, Elliott Wave, Dow Theory, volume-price, crypto-specific sentiment), multi-timeframe decision making, strategy selection, order execution, position management, backtesting, self-optimization, and dashboard reporting. 24/7 operation. Use when: (1) running scheduled crypto auto-trading cron, (2) analyzing cryptocurrency markets, (3) backtesting or optimizing crypto trading strategies, (4) reviewing crypto trade performance, (5) updating the boss dashboard crypto trading section, (6) any task involving MAX Exchange trading. Pairs: BTC/TWD, ETH/TWD, BTC/USDT, ETH/USDT, SOL/TWD, DOGE/TWD."
---

# Crypto Auto Trading System

## Overview

24/7 automated cryptocurrency trading on MAX Exchange (MaiCoin). Currently in **simulation testing phase** — goal is to find profitable strategies through mass testing, backtesting, and optimization before going live with NT$15,000.

**Core philosophy**: 保護本金第一，利潤最大化第二。賺的抱住，虧的快砍。重點是風報比，不是勝率。

## Architecture

```
trading/
├── crypto_sim_engine_v3.js     # Core engine (Node.js)
├── crypto_config.json          # MAX API credentials
├── crypto_sim_config.json      # Strategy & risk parameters
├── crypto_sim_state.json       # Runtime state
├── crypto_sim_log.json         # All trade records
├── crypto_dashboard_data.json  # Dashboard output (local)
├── crypto_review.json          # Review/optimization data
├── crypto_updater.js           # News/data updater
├── crypto_strategy_registry.json  # Dynamic strategy registry (auto-maintained)
├── crypto_strategy_lab/        # Strategy research & backtest workspace
│   ├── hypotheses.json         # New strategy ideas to test
│   ├── backtest_results/       # Per-strategy backtest data
│   └── graduated.json          # Strategies promoted to live testing
├── crypto_sim_cron.log         # Engine execution log
└── crypto_cron.log             # Updater execution log
```

**Cron schedule**:
- Engine: `*/2 * * * *` (every 2 minutes, 24/7)
- Updater: `*/15 * * * *` (every 15 minutes)

## Workflow (每次 cron 執行)

### 1. Data Fetch
- Login MAX API with access_key + secret_key
- Fetch: ticker prices, order books, recent trades, K-line data (5M/15M/1H/4H)
- For each pair in watchlist

### 2. Market Analysis (per pair)
For each of 6 trading pairs:

a. **Calculate indicators** → RSI, MACD, Bollinger, ATR, EMA (8/21/50), KD, OBV, VWAP, etc.
b. **Price action** → Candlestick patterns (pin bar, engulfing, morning/evening star, etc.)
c. **Chart patterns** → Double top/bottom, triangles, flags, wedges
d. **Elliott Wave** → Wave position + Fibonacci levels
e. **Market regime** → TRENDING_UP / TRENDING_DOWN / RANGING / BREAKOUT / VOLATILE
f. **Multi-timeframe alignment** → 4H/1H/15M/5M must agree on direction
g. **Crypto-specific sentiment** → Fear & Greed Index, social momentum, volume anomalies, on-chain data

→ See `references/knowledge-base.md` for full technical analysis knowledge.

### 3. Dynamic Strategy Selection

⚠️ **策略不是固定清單，是動態進化系統。**

策略從 `crypto_strategy_registry.json` 動態載入，不寫死在程式碼裡。

→ See **Strategy Evolution System** section below for full details.

### 4. Signal Generation & Confidence Scoring
- Combine all analysis into directional signal (BUY/SELL/NONE)
- Calculate confidence score (0.0–1.0)
- **Minimum confidence**: 0.55 (primary pairs) / 0.60 (secondary pairs)
- **Minimum risk-reward ratio**: 2.0:1

### 5. Risk Management (pre-trade)
Before placing any order:
- Check max concurrent positions (5)
- Check total exposure limit (80% of capital)
- Check no duplicate position on same pair
- Set SL = ATR × 1.2 (tight, max 1.5%)
- Set TP = ATR × 2.5 (minimum 2:1 R:R)
- Position size based on risk: 1.5% base, 2.5% high confidence

→ See `references/risk-management.md` for full risk rules.

### 6. Order Execution (Simulation)
- Calculate simulated entry at current market price
- Log to crypto_sim_log.json with: time, pair, strategy, direction, confidence, size, entry price, SL, TP
- Deduct from simulated capital

### 7. Position Management
For existing positions:
- **Trailing stop activation**: After +0.5% profit, lock breakeven
- **Trailing widening**: +1% → 0.5% trail, +2% → 0.8% trail (let winners ride)
- **Time exit**: 4H with no movement AND < 0.15% profit → close
- **SL/TP hit**: Record actual P/L, update state
- **Cooldown**: 5 minutes after a loss before next entry

### 8. Dashboard Update
Generate dashboard JSON with ALL sections:

**帳戶總覽**
- capital (simulated balance), realizedPnl, unrealizedPnl, netEquity
- todayPnl, weekPnl

**交易統計**
- totalTrades, closedTrades, openCount
- wins, losses, winRate
- avgWin, avgLoss, riskRewardRatio
- maxConsecutiveWins, maxConsecutiveLosses
- maxSingleWin, maxSingleLoss

**監控幣種** (6 pairs)
- Current price, trend direction, has position or not

**目前持倉**
- Per position: pair, direction, entry, current price, unrealized P/L, hold time, strategy, trailing status

**已完成交易**
- Per trade: pair, direction, entry, exit, P/L amount, strategy, hold time, close reason

**策略績效排行榜**
- Per strategy: winRate, tradeCount, totalPnl, riskRewardRatio, status (active/testing/paused/retired), rank
- Sorted by totalPnl descending
- Shows ALL strategies (not just top N)

**復盤與自我優化**
- Latest review summary
- Strategies under test
- Recent optimization changes
- New strategy hypotheses being researched
- Strategies recently promoted / demoted / retired
- Next steps

**風控參數**
- Current settings (SL/TP method, max positions, risk per trade, etc.)

**異常警報**
- API errors, abnormal losses, risk triggers

**策略研究室**
- Strategies in backtest pipeline
- Backtest results summary
- New hypotheses queued

### 9. Strategy Evolution Cycle (periodic)
→ See **Strategy Evolution System** below. This runs as part of self-optimization.

---

## Strategy Evolution System

### Core Principle
**策略是活的，不是死的。** 沒有固定數量上限。系統持續研究、生成、測試、篩選、進化策略。

### Strategy Lifecycle

Every strategy goes through these stages:

```
HYPOTHESIS → BACKTEST → TESTING → ACTIVE → (REVIEW) → PROMOTED / DEMOTED / RETIRED
     ↑                                                          |
     └──────────── feedback loop (learn from results) ──────────┘
```

**Stage definitions:**
| Stage | Description |
|-------|-------------|
| `HYPOTHESIS` | 新策略想法，尚未回測。來源：新理論學習、策略組合、參數變體、市場觀察 |
| `BACKTEST` | 正在用歷史數據回測驗證 |
| `TESTING` | 回測通過，在模擬盤上實測 |
| `ACTIVE` | 實測表現良好，正式啟用 |
| `PROMOTED` | 高績效策略，優先分配資源 |
| `DEMOTED` | 績效下滑，降低權重，觀察中 |
| `RETIRED` | 確認無效或過時，停用但保留記錄供學習 |

### Strategy Registry (`crypto_strategy_registry.json`)

```json
{
  "strategies": [
    {
      "id": "CRYPTO_MOMENTUM_BTC_15M",
      "name": "BTC 動能突破 (15M)",
      "version": 2,
      "status": "ACTIVE",
      "created": "2026-03-28",
      "lastUpdated": "2026-03-31",
      "regime": ["TRENDING_UP", "BREAKOUT"],
      "pairs": ["btctwd", "btcusdt"],
      "timeframe": "15M",
      "entryRules": { ... },
      "exitRules": { ... },
      "riskParams": { "slMultiplier": 1.2, "minRR": 2.0 },
      "performance": {
        "totalTrades": 18,
        "winRate": 0.39,
        "totalPnl": 850,
        "avgRR": 2.4,
        "sharpe": 0.9,
        "maxDrawdown": -2.1
      },
      "parentStrategy": null,
      "mutations": ["Added volume spike filter", "Tightened SL from 1.5x to 1.2x ATR"],
      "tags": ["momentum", "breakout", "btc"]
    }
  ],
  "metadata": {
    "totalStrategies": 52,
    "active": 10,
    "testing": 12,
    "backtest": 18,
    "hypothesis": 8,
    "retired": 4,
    "lastEvolutionCycle": "2026-03-31T14:30:00Z"
  }
}
```

### Strategy Sources (where new strategies come from)

**1. Knowledge-Driven (學習新理論)**
- Study new methods: Wyckoff, ICT, SMC, Order Flow, Market Profile, on-chain analysis
- Crypto-specific: Whale tracking, exchange inflow/outflow, funding rates, liquidation maps
- Each new method → generate multiple strategy hypotheses

**2. Combination-Driven (排列組合)**
- Take elements from existing strategies and combine them
- Example: EMA crossover (entry) + RSI divergence (filter) + Volume spike (confirmation) + Fear&Greed (sentiment) = new composite strategy
- Systematically explore: entry signals × filters × exit rules × timeframes × sentiment layers

**3. Parameter Variants (參數變體)**
- Same logic, different parameters
- RSI periods: 10, 14, 21 × overbought: 65, 70, 75
- ATR multiplier: 1.0, 1.2, 1.5, 2.0
- EMA combos: 5/13, 8/21, 9/50, 13/34

**4. Timeframe Variants (時間框架變體)**
- Same strategy on: 5M, 15M, 1H, 4H
- Each is separate with independent performance tracking

**5. Market Regime Adaptation (市場狀態適應)**
- Trending strategy fails in ranging → create regime-filtered variant
- Analyze WHEN strategies fail → build regime-specific gates

**6. Performance Feedback (績效回饋)**
- Analyze losing trades → find common patterns → hypothesize fix → create variant
- Analyze winning streaks → identify what works → amplify
- Cross-strategy learning: best exit from A + best entry from B = Strategy C

**7. Crypto-Specific Sources (加密貨幣特有)**
- Fear & Greed Index extremes → contrarian strategies
- Whale wallet movements → follow-the-money strategies
- Exchange funding rate → sentiment-based mean reversion
- Liquidation cascade patterns → volatility capture strategies
- Halving cycle / macro cycle → long-term positioning

**8. External Research (外部研究)**
- From crypto news and discussions (via crypto-news skill)
- X/Reddit AI trading bot discussions
- Academic papers, trading communities
- Translate ideas into testable hypotheses

### Strategy Evaluation Criteria

Priority order:

1. **Total P/L** — 最終有沒有賺才是重點
2. **Risk-Reward Ratio** — 賺的時候賺多少 vs 虧的時候虧多少
3. **Sharpe Ratio** — 風險調整後報酬
4. **Max Drawdown** — 最大回撤（保護本金）
5. **Win Rate** — 勝率（參考用，不是最重要）
6. **Trade Count** — 樣本數夠不夠（<10 筆不做結論）
7. **Consistency** — 表現穩不穩定

### Automatic Promotion / Demotion Rules

**Promote to ACTIVE** (from TESTING):
- ≥ 10 trades in testing
- Total P/L > 0
- Risk-reward ≥ 2.0
- Max drawdown < 3% of test capital

**Promote to PROMOTED** (from ACTIVE):
- ≥ 25 trades
- Top 20% by total P/L
- Consistent positive P/L over last 3 evaluation periods

**Demote** (ACTIVE → DEMOTED):
- P/L turns negative over last 15 trades
- Risk-reward drops below 1.0
- Max drawdown exceeds 5%

**Retire** (DEMOTED → RETIRED):
- Stays demoted for 3 evaluation cycles with no improvement
- Or: confirmed structural reason why it no longer works

**Never permanently delete** — retired strategies are kept for learning.

### Evolution Cycle (runs every 2 hours or on-demand)

```
1. EVALUATE — Score all active/testing strategies on latest data
2. PROMOTE/DEMOTE — Move strategies between stages based on rules
3. ANALYZE — Find patterns in what's working vs failing
4. HYPOTHESIZE — Generate new strategy ideas from analysis
5. BACKTEST — Run top hypotheses against historical data
6. GRADUATE — Move passing backtests to TESTING stage
7. REPORT — Update dashboard with strategy evolution status
```

### Learning & Knowledge Accumulation

The system maintains a growing knowledge base:

- `references/knowledge-base.md` — TA methods + crypto-specific analysis (continuously expanded)
- `references/strategies/` — Strategy category documentation (grows as new categories emerge)
- `crypto_strategy_lab/hypotheses.json` — Queue of ideas to test
- `crypto_strategy_lab/backtest_results/` — Historical backtest data (never deleted)
- `crypto_strategy_lab/lessons.json` — What worked, what didn't, and why

**Knowledge compounds over time.** Every trade, every backtest, every failure feeds the next generation of strategies.

---

## Trading Pairs

| Pair | Type | Priority | Notes |
|------|------|----------|-------|
| btctwd | BTC/TWD | 主力 | Highest liquidity on MAX |
| ethtwd | ETH/TWD | 主力 | Second most liquid |
| btcusdt | BTC/USDT | 主力 | USDT pair, different dynamics |
| ethusdt | ETH/USDT | 主力 | USDT pair |
| soltwd | SOL/TWD | 輔助 | Higher volatility, needs higher confidence |
| dogetwd | DOGE/TWD | 輔助 | Meme coin, news-driven |

## Key Differences from Forex System

| Aspect | Forex | Crypto |
|--------|-------|--------|
| Market hours | 24/5 | **24/7** |
| Cron frequency | 10 min | **2 min** |
| Volatility | Moderate | **High** |
| Exchange | Capital.com (CFD) | **MAX (spot)** |
| Language | Python | **Node.js** |
| SL/TP execution | Broker-side | **Engine-side (simulated)** |
| Sentiment tools | COT, DXY | **Fear & Greed, on-chain, social** |
| Evolution cycle | Every 4H | **Every 2H** (faster market) |
| Min R:R | 1.5:1 | **2.0:1** (higher volatility needs wider margin) |

## Configuration

- **Mode**: `simulation` | `live` (crypto_sim_config.json)
- **Live capital**: NT$15,000 (planned)
- **Live mode** auto-enforces: smaller positions, tighter stops, lower consecutive loss threshold

## MAX Exchange API Reference

→ See `references/max-api.md` for endpoints, auth, and SDK usage.

## File Outputs

| File | Location | Purpose |
|------|----------|---------|
| crypto-trading-data.json | boss-dashboard/ | Dashboard display |
| crypto_dashboard_data.json | trading/ | Local copy |
| crypto_sim_state.json | trading/ | Runtime state |
| crypto_sim_log.json | trading/ | Trade history |
| crypto_review.json | trading/ | Review data |
| crypto_strategy_registry.json | trading/ | Dynamic strategy registry |

## Key Rules

1. **24/7 operation** — no market close, no weekend pause
2. **Every 2 minutes** — fast enough to catch short-term moves
3. **Minimum 2:1 risk-reward** — don't enter if R:R below this
4. **Let winners ride** — trailing stop widens as profit grows
5. **Cut losers fast** — tight SL (1.2× ATR, max 1.5%)
6. **Testing phase**: no consecutive loss pause, keep trading to gather data
7. **Focus on R:R improvement** — make winners bigger, not more wins
8. **Dashboard must show ALL sections** — boss wants full visibility
9. **策略數量無上限** — 不斷研究、生成、測試、淘汰、進化
10. **策略是動態的** — 從 crypto_strategy_registry.json 載入，不寫死在程式碼
11. **每個策略獨立追蹤績效** — 用數據決定去留，不靠直覺
12. **退役策略保留紀錄** — 失敗也是學習
13. **知識持續累積** — 所有學到的都寫入 knowledge-base
14. **加密貨幣特有分析** — Fear & Greed、on-chain、whale tracking、funding rate 都要用
