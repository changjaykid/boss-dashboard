# Risk Management Rules

## Position Sizing

### Testing Phase (Current)
- Use **minimum position size** for all trades
- Goal: gather data, not maximize profit
- GOLD: 0.01 lots, Forex: 0.1 lots, Indices: 0.1 lots

### Live Phase (Future)
- Risk per trade: **1-2% of account balance**
- Position size = (Account × Risk%) / (SL distance in points × point value)
- Never risk more than 2% on a single trade
- Total open risk: max 5% of account

## Stop Loss Rules

- **Primary method**: ATR × 1.2 (tight, current setting)
- **Minimum SL**: Never less than spread × 3
- **Maximum SL**: Never more than 2% of account balance
- SL must be set **before** entry (broker-side SL via Capital.com API)
- **Never move SL against your position** (wider)
- Moving SL to breakeven after 1:1 R is recommended

## Take Profit Rules

- **Minimum risk-reward**: 1.5:1 (current setting, enforce always)
- **Target risk-reward**: 2:1 or better
- Methods:
  1. Fixed R:R (e.g., TP = SL × 2)
  2. Next S/R level
  3. Fibonacci extension (1.618)
  4. Measured move from chart pattern
- **Profitable trades can ride**: Don't rush to close winners. Use trailing stop.

## Trailing Stop

- After 1:1 R reached → move SL to breakeven
- After 2:1 R reached → trail by ATR × 1
- For trend-following: trail by EMA 21 on 1H chart
- Never trail too tight in volatile markets

## Position Limits

- Max **1 position per instrument**
- Max **4 positions total** (testing phase)
- Max **3 positions in same direction** (correlation risk)
- US30, US500, US100 are correlated → treat as one group, max 2 total

## Daily Drawdown

- **Max daily drawdown: 3% of initial balance**
- If hit → stop all new trades for the rest of the day
- Reset at UTC 00:00

## Consecutive Loss Rules

- **3 consecutive losses** → reduce position size to half for next 3 trades
- **5 consecutive losses** → pause trading for 2 hours, then re-evaluate
- **7 consecutive losses** → stop trading for the day, full strategy review

## Time-Based Rules

- **No new positions in dead zones** (UTC 22:00-00:00)
- **No new positions 30 min before/after major news**
- **Max hold time**: 8H for losing positions, unlimited for winners
- **Friday rule**: No new positions after UTC 19:00 (close before weekend)

## Mode Switch: Simulation → Live

When switching to live trading:
1. Change API endpoint to live
2. Reduce max positions to 2
3. Reduce max daily drawdown to 2%
4. Set consecutive loss pause to 3 (not 5)
5. Start with minimum position sizes for first 2 weeks
6. Gradually increase only if positive expectancy confirmed

## Emergency Rules

- **API connection failure**: Do nothing (existing broker-side SL/TP protect)
- **Abnormal spread** (> 3× normal): Skip trade
- **Account drawdown > 10%**: Full stop, manual review required
- **Single trade loss > 3%**: Investigate immediately, likely a sizing error
