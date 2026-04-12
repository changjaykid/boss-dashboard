---
name: forex-auto-trading
description: "Fully automated forex & index CFD trading system on Capital.com. Covers market analysis (candlestick patterns, chart patterns, indicators, Elliott Wave, Dow Theory, volume-price analysis), multi-timeframe decision making, strategy selection, order execution, position management, P/L tracking (including SL/TP broker-closed trades), backtesting, self-optimization, and dashboard reporting. Use when: (1) running scheduled auto-trading cron, (2) analyzing forex/index markets, (3) backtesting or optimizing trading strategies, (4) reviewing trade performance, (5) updating the boss dashboard trading section, (6) any task involving Capital.com trading. Instruments: XAUUSD, EUR/USD, GBP/USD, USD/JPY, US30, S&P500, NAS100."
---

## 👤 負責人員

| 項目 | 內容 |
|------|------|
| **身份** | 外匯交易員 |
| **負責項目** | Capital.com 外匯 & 指數 CFD 自動交易（$500 實戰） |
| **日常任務** | 交易時段每 15 分鐘分析市場 → 篩選信號 → 開單 → 管理持倉(SL/TP) → 每日 22:00 復盤 |
| **更新時間** | 交易時段每 15 分鐘，每日 22:00 復盤 |
| **主控板更新內容** | 持倉狀態、今日/累計損益、策略勝率、交易紀錄、更新時間戳 |
| **驗收標準** | 月報酬正成長，勝率 > 40%，風報比 > 2:1，單筆虧損 ≤ 帳戶 2% |
| **目標** | 穩定獲利，嚴守風控，讓老闆的錢越來越多 |

---

# Forex Auto Trading System

## Overview

24/5 automated trading on Capital.com (CFD). Currently in **simulation testing phase** — goal is to find profitable strategies through mass testing, backtesting, and optimization before going live.

**Core philosophy**: 保護本金第一，利潤最大化第二。賺的抱住，虧的快砍。重點是最終有沒有賺，不是勝率。

## Architecture

```
trading/
├── auto_trader.sh          # Entry point (cron every 10min, Mon-Fri)
├── analyzer_v5.py          # Core engine (analysis → signals → orders → dashboard)
├── config.json             # API credentials & settings
├── state.json              # Runtime state (balance, consecutive losses, etc.)
├── trade_log.json          # All trade records
├── dashboard_data.json     # Dashboard output
├── last_report.json        # Latest analysis report
├── strategy_registry.json  # Dynamic strategy registry (auto-maintained)
├── strategy_lab/           # Strategy research & backtest workspace
│   ├── hypotheses.json     # New strategy ideas to test
│   ├── backtest_results/   # Per-strategy backtest data
│   └── graduated.json      # Strategies promoted to live testing
└── cron.log                # Execution log
```

**Cron schedule**: `*/10 * * * 1-5` (every 10 minutes, weekdays only)

## Workflow (每次 cron 執行)

### 1. Login & Data Fetch
- Login Capital.com API → get CST + X-SECURITY-TOKEN
- Fetch: positions, account balance, market data (4H/1H/15M/5M candles for each instrument)

### 2. Market Analysis (per instrument)
For each of 7 instruments, if in active trading session:

a. **Calculate indicators** → RSI, MACD, Bollinger, ATR, EMA (9/21/50), KD, OBV, VWAP, etc.
b. **Price action** → Candlestick patterns (pin bar, engulfing, morning/evening star, etc.)
c. **Chart patterns** → Double top/bottom, H&S, triangles, flags, wedges
d. **Elliott Wave** → Wave position + Fibonacci levels
e. **Market regime** → TRENDING_UP / TRENDING_DOWN / RANGING / BREAKOUT / VOLATILE
f. **Multi-timeframe alignment** → 4H/1H/15M must agree on direction

→ See `references/knowledge-base.md` for full technical analysis knowledge.

### 3. Dynamic Strategy Selection

⚠️ **策略不是固定清單，是動態進化系統。**

策略從 `strategy_registry.json` 動態載入，不寫死在程式碼裡。

→ See **Strategy Evolution System** section below for full details.

### 4. Signal Generation & Confidence Scoring
- Combine all analysis into directional signal (BUY/SELL/NONE)
- Calculate confidence score (0.0–1.0) based on: MTF alignment, price action, pattern, RSI, MACD, ATR ratio, Elliott
- **Minimum confidence to enter: 0.60**

### 5. Risk Management (pre-trade)
Before placing any order:
- Check daily drawdown limit (3% of initial balance → stop trading)
- Check max positions per instrument (1)
- Check active trading session for instrument
- Set SL = ATR × 1.2 (tight)
- Set TP to enforce minimum 1.5:1 risk-reward ratio
- Position size = minimum (testing phase)

→ See `references/risk-management.md` for full risk rules.

### 6. Order Execution
- Place order via Capital.com API with broker-side SL/TP
- Log to trade_log.json with: time, instrument, strategy, direction, confidence, size, outcome=OPEN

### 7. Position Management
For existing positions:
- **Profitable after 8H**: Let it ride (trailing stop)
- **Losing after 8H**: Force close
- **Broker closed (SL/TP hit)**: Sync status → **query API for actual P/L** → update trade_log

⚠️ **SL/TP_BY_BROKER P/L Recovery**:
When broker closes a position, query `/api/v1/history/activity` or `/api/v1/history/transactions` to get actual realized P/L. Never leave pnl as null.

### 8. Dashboard Update
Generate dashboard JSON with ALL of these sections:

**帳戶總覽**
- balance, realizedPnl, unrealizedPnl, netEquity (balance + unrealized)
- todayPnl, weekPnl

**交易統計**
- totalTrades, closedTrades, openCount
- wins, losses, winRate
- avgWin, avgLoss, riskRewardRatio (avgWin ÷ avgLoss)
- maxConsecutiveWins, maxConsecutiveLosses
- maxSingleWin, maxSingleLoss
- marginUsagePercent (used margin ÷ equity)

**監控商品** (7 instruments)
- Current price, trend direction, has position or not

**目前持倉**
- Per position: instrument, direction, entry, current price, unrealized P/L, hold time, strategy

**已完成交易**
- Per trade: instrument, direction, entry, exit, P/L amount, strategy, hold time, close reason (including recovered SL/TP P/L)

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
- Max single loss, max positions, consecutive loss pause rule
- SL method (ATR multiplier), min risk-reward, session restrictions

**異常警報**
- API errors, abnormal losses, risk control triggers

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

### Strategy Registry (`strategy_registry.json`)

```json
{
  "strategies": [
    {
      "id": "TREND_EMA_CROSS_1H",
      "name": "EMA 9/21 交叉趨勢跟隨 (1H)",
      "version": 3,
      "status": "ACTIVE",
      "created": "2026-03-28",
      "lastUpdated": "2026-03-31",
      "regime": ["TRENDING_UP", "TRENDING_DOWN"],
      "instruments": ["GOLD", "EURUSDM2026"],
      "timeframe": "1H",
      "entryRules": { ... },
      "exitRules": { ... },
      "riskParams": { "slMultiplier": 1.2, "minRR": 1.5 },
      "performance": {
        "totalTrades": 24,
        "winRate": 0.42,
        "totalPnl": 12.50,
        "avgRR": 2.1,
        "sharpe": 0.8,
        "maxDrawdown": -3.2
      },
      "parentStrategy": null,
      "mutations": ["Changed EMA from 9/21 to 8/21", "Added volume filter"],
      "tags": ["trend", "ema", "crossover"]
    }
  ],
  "metadata": {
    "totalStrategies": 47,
    "active": 12,
    "testing": 8,
    "backtest": 15,
    "hypothesis": 9,
    "retired": 3,
    "lastEvolutionCycle": "2026-03-31T14:30:00Z"
  }
}
```

### Strategy Sources (where new strategies come from)

**1. Knowledge-Driven (學習新理論)**
- Study new TA methods: Wyckoff, ICT, SMC (Smart Money Concept), Order Flow, Market Profile
- Each new method → generate multiple strategy hypotheses
- Store in `references/knowledge-base.md` as system learns

**2. Combination-Driven (排列組合)**
- Take elements from existing strategies and combine them
- Example: EMA crossover (entry) + RSI divergence (filter) + Volume spike (confirmation) = new composite strategy
- Systematically explore combinations of: entry signals × filters × exit rules × timeframes

**3. Parameter Variants (參數變體)**
- Same strategy logic, different parameters
- Example: RSI(14) overbought at 70 → try RSI(10) at 65, RSI(21) at 75
- ATR multiplier: 1.0, 1.2, 1.5, 2.0
- EMA periods: 5/13, 8/21, 9/50, 13/34

**4. Timeframe Variants (時間框架變體)**
- Same strategy on different timeframes: 5M, 15M, 1H, 4H
- Each timeframe version is a separate strategy with its own performance tracking

**5. Market Regime Adaptation (市場狀態適應)**
- A strategy that works in trending markets → create ranging variant
- Analyze WHEN strategies fail → create regime-specific filters

**6. Performance Feedback (績效回饋)**
- Analyze losing trades → identify common patterns → hypothesize fix → create variant
- Analyze winning streaks → identify what's working → amplify those elements
- Cross-strategy learning: if Strategy A's exit rule works better than Strategy B's, create Strategy C combining best of both

**7. External Research (外部研究)**
- From forex/trading news and discussions (via forex-news skill)
- From academic papers, trading books, community strategies
- Translate interesting ideas into testable strategy hypotheses

### Strategy Evaluation Criteria

A strategy is evaluated on these metrics (in priority order):

1. **Total P/L** — 最終有沒有賺才是重點
2. **Risk-Reward Ratio** — 賺的時候賺多少 vs 虧的時候虧多少
3. **Sharpe Ratio** — 風險調整後報酬
4. **Max Drawdown** — 最大回撤（保護本金）
5. **Win Rate** — 勝率（參考用，不是最重要）
6. **Trade Count** — 樣本數夠不夠（<10 筆不做結論）
7. **Consistency** — 表現穩不穩定（不是偶爾大贏其他全輸）

### Automatic Promotion / Demotion Rules

**Promote to ACTIVE** (from TESTING):
- ≥ 10 trades in testing
- Total P/L > 0
- Risk-reward ≥ 1.5
- Max drawdown < 5% of test capital

**Promote to PROMOTED** (from ACTIVE):
- ≥ 25 trades
- Top 20% by total P/L
- Consistent positive P/L over last 3 evaluation periods

**Demote** (ACTIVE → DEMOTED):
- P/L turns negative over last 15 trades
- Risk-reward drops below 1.0
- Max drawdown exceeds 8%

**Retire** (DEMOTED → RETIRED):
- Stays demoted for 3 evaluation cycles with no improvement
- Or: confirmed structural reason why it no longer works (market regime shift, etc.)

**Never permanently delete** — retired strategies are kept for learning. They might inspire future strategies.

### Evolution Cycle (runs every 4 hours or on-demand)

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

- `references/knowledge-base.md` — Technical analysis methods (continuously expanded)
- `references/strategies/` — Strategy category documentation (grows as new categories emerge)
- `strategy_lab/hypotheses.json` — Queue of ideas to test
- `strategy_lab/backtest_results/` — Historical backtest data (never deleted)
- `strategy_lab/lessons.json` — What worked, what didn't, and why

**Knowledge compounds over time.** Every trade, every backtest, every failure teaches the system something that feeds into the next generation of strategies.

---

## Instruments

| Epic | Name | Type | Active Session (UTC) |
|------|------|------|---------------------|
| GOLD | XAUUSD | 黃金 | 0-24 (nearly 24H) |
| EURUSDM2026 | EUR/USD | 外匯 | 7-21 |
| GBPUSD | GBP/USD | 外匯 | 7-21 |
| USDJPYM2026 | USD/JPY | 外匯 | 0-9, 13-21 |
| US30 | Dow Jones | 指數 | 13-21 |
| US500 | S&P 500 | 指數 | 13-21 |
| US100 | Nasdaq 100 | 指數 | 13-21 |

**禁止**: 不做虛擬貨幣（有獨立系統）

## Configuration

- **Mode**: `simulation` | `live` (config.json)
- **API**: `https://api-capital.backend-capital.com` (live) / `https://demo-api-capital.backend-capital.com` (demo)
- **Live mode** auto-enforces stricter risk: smaller size, tighter SL, lower consecutive loss threshold

## Capital.com API Reference

→ See `references/capital-com-api.md` for endpoints, auth, and error handling.

## File Outputs

| File | Location | Purpose |
|------|----------|---------|
| trading-data.json | boss-dashboard/ | Dashboard display |
| dashboard_data.json | trading/ | Local copy |
| last_report.json | trading/ | Latest analysis |
| trade_log.json | trading/ | Trade history |
| state.json | trading/ | Runtime state |
| strategy_registry.json | trading/ | Dynamic strategy registry |

## Key Rules

1. **Never leave pnl as null** — always recover actual P/L for broker-closed trades
2. **Cron overwrites JSON every 10 min** — to change dashboard data, modify the engine code, not the JSON
3. **All times in UTC** internally, display in Asia/Taipei (UTC+8)
4. **Testing phase**: use minimum position sizes, test aggressively, gather data
5. **Dashboard must show ALL sections** listed above — boss wants full visibility
6. **策略數量無上限** — 不斷研究、生成、測試、淘汰、進化
7. **策略是動態的** — 從 strategy_registry.json 載入，不寫死在程式碼
8. **每個策略獨立追蹤績效** — 用數據決定去留，不靠直覺
9. **退役策略保留紀錄** — 失敗也是學習，未來可能啟發新策略
10. **知識持續累積** — 學到的分析方法、市場觀察、教訓都寫入 knowledge-base
