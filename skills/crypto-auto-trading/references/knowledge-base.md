# Crypto Trading Knowledge Base

Inherits all technical analysis from forex skill (`skills/forex-auto-trading/references/knowledge-base.md`):
- Candlestick patterns, chart patterns, technical indicators, volume-price analysis
- Elliott Wave, Dow Theory, support/resistance, multi-timeframe, Fibonacci

**Read the forex knowledge-base for those topics.** This file covers **crypto-specific** additions only.

---

## Table of Contents
1. [Crypto Market Structure](#crypto-market-structure)
2. [Fear & Greed Index](#fear-greed-index)
3. [On-Chain Analysis](#on-chain-analysis)
4. [Exchange Flow](#exchange-flow)
5. [Funding Rate](#funding-rate)
6. [Social Sentiment](#social-sentiment)
7. [Crypto-Specific Patterns](#crypto-specific-patterns)
8. [Market Cycles](#market-cycles)
9. [Crypto Session Characteristics](#crypto-session-characteristics)

---

## 1. Crypto Market Structure

### vs Forex
- **24/7 trading** — no market close, gaps rare (only on exchange maintenance)
- **Higher volatility** — BTC daily range 2-5% is normal (forex majors ~0.5-1%)
- **Thinner liquidity** — especially altcoins, spread can widen suddenly
- **Retail-dominated** — more emotional, more herd behavior, more manipulation
- **News-driven** — single tweet or regulation news can move market 10%+
- **Correlation** — altcoins mostly follow BTC. When BTC dumps, everything dumps

### Practical implications
- Wider stops needed (ATR-based, not fixed %)
- Faster reaction needed (2-min cron is appropriate)
- BTC direction is the master signal — don't long altcoins when BTC is dumping
- Weekend volatility can be higher (less institutional dampening)

---

## 2. Fear & Greed Index

Source: alternative.me/crypto/fear-and-greed-index/

| Range | Sentiment | Trading implication |
|-------|-----------|-------------------|
| 0-25 | Extreme Fear | Contrarian BUY signal (market oversold) |
| 25-45 | Fear | Cautious, look for reversal signs |
| 45-55 | Neutral | No directional bias from sentiment |
| 55-75 | Greed | Trend may continue, but watch for exhaustion |
| 75-100 | Extreme Greed | Contrarian SELL signal (market euphoric) |

### Usage
- **Don't trade against extreme readings** — Extreme Fear + bullish candle at support = strong BUY
- **Extreme Greed + bearish divergence** = strong SELL signal
- Works best as confirmation, not primary signal
- Updated daily, check once per session

---

## 3. On-Chain Analysis

### Key Metrics
- **Active addresses**: Rising = growing adoption, bullish
- **Hash rate**: Rising = miners confident, bullish for BTC
- **NVT Ratio** (Network Value to Transactions): High = overvalued, Low = undervalued
- **MVRV Ratio** (Market Value to Realized Value): > 3.5 = market top zone, < 1 = market bottom zone
- **SOPR** (Spent Output Profit Ratio): > 1 = holders selling at profit, < 1 = selling at loss (capitulation)

### Whale tracking
- Wallets holding 1000+ BTC movements
- Large transfers to exchanges = potential sell pressure
- Large transfers from exchanges to cold wallets = accumulation (bullish)

### Practical for our system
- On-chain data is slow-moving (daily), use as background bias, not for 2-min decisions
- Whale alerts can be real-time — integrate if API available

---

## 4. Exchange Flow

- **Exchange inflow spike** → coins moving to exchange to sell → bearish
- **Exchange outflow spike** → coins moving to cold storage → bullish (accumulation)
- **Stablecoin inflow to exchange** → dry powder ready to buy → bullish
- **BTC exchange reserve declining** → less sell pressure → bullish

### MAX Exchange specific
- MAX is smaller exchange, less whale activity
- Look at global exchange flow (Binance, Coinbase) for macro signal
- MAX TWD pairs can have premium/discount vs global price — arbitrage opportunity

---

## 5. Funding Rate

Applies to perpetual futures (not directly on MAX spot, but affects spot price):
- **Positive funding rate** → longs paying shorts → market is leveraged long → potential squeeze down
- **Negative funding rate** → shorts paying longs → market is leveraged short → potential squeeze up
- **Extreme positive** (> 0.1%) → very bullish sentiment, but correction risk high
- **Extreme negative** (< -0.05%) → very bearish sentiment, but bounce likely

### Usage
- Extreme funding rate = contrarian signal
- Check on Binance/Bybit for reference, even though we trade spot on MAX

---

## 6. Social Sentiment

### Sources
- **X (Twitter)**: Real-time crypto sentiment, influencer calls
- **Reddit** (r/cryptocurrency, r/bitcoin): Community sentiment, narrative shifts
- **Telegram/Discord**: Alpha groups, early signals (harder to parse)

### Signals
- **Sudden spike in mentions** of specific coin → something happening, investigate
- **Uniform bullish sentiment everywhere** → contrarian warning (too crowded)
- **FUD spreading** + price holding support → strong hands accumulating
- **Celebrity/influencer pump** → usually dump follows, avoid or short after spike

### Practical
- Use web search during analysis to check recent crypto news
- X sentiment for BTC/ETH directional bias
- Don't trade altcoins purely on social hype without technical confirmation

---

## 7. Crypto-Specific Patterns

### Bitcoin Dominance (BTC.D)
- BTC.D rising → money flowing from alts to BTC (risk-off within crypto)
- BTC.D falling → alt season starting (risk-on, alts outperform)
- **For our system**: When BTC.D rising, focus on BTC pairs. When falling, SOL/DOGE may have better moves.

### Liquidation Cascades
- Large leveraged positions get liquidated → waterfall effect
- After a cascade, price often reverses sharply (all weak hands washed out)
- Look for long wicks after cascade = buying opportunity

### Exchange Premium/Discount
- MAX TWD price vs global USD price (converted)
- Premium → local buyers aggressive (bullish local sentiment)
- Discount → local sellers aggressive (bearish local sentiment)
- Can be used as additional confirmation

### Halving Cycle
- BTC halving every ~4 years reduces new supply
- Historically: 12-18 months after halving = bull market peak
- Current cycle awareness matters for long-term bias

---

## 8. Market Cycles

### Crypto Bull/Bear Phases
1. **Accumulation**: Low volume, flat price, smart money buying quietly
2. **Markup**: Price starts trending up, volume increases, FOMO begins
3. **Distribution**: High volume at tops, divergences appear, smart money selling
4. **Markdown**: Price drops, volume on down moves, capitulation at bottom

### Phase Detection
- Accumulation → Bollinger squeeze + low RSI + flat EMA → prepare for breakout
- Markup → EMA aligned up + volume increasing → trend follow
- Distribution → RSI divergence + high volume at resistance → reduce/short
- Markdown → EMA aligned down + fear index high → wait or short

---

## 9. Crypto Session Characteristics

Unlike forex, crypto trades 24/7 but still has patterns:

| Session | UTC | 特徵 |
|---------|-----|------|
| Asia (incl. Taiwan) | 00:00-08:00 | TWD pairs most active, MAX liquidity highest |
| Europe | 08:00-16:00 | Volume picks up, BTC/ETH more volatile |
| US | 14:00-22:00 | Highest volume period, most institutional activity |
| US/Asia overlap | 22:00-02:00 | Can be volatile or dead, depends on news |
| Weekend | All day | Lower volume but can have sudden moves (less dampening) |

### For MAX Exchange (Taiwan-based)
- Best liquidity for TWD pairs: Taiwan business hours (01:00-09:00 UTC / 9AM-5PM Taipei)
- USDT pairs follow global patterns more closely
- Late night Taiwan time = US session = higher BTC volatility
