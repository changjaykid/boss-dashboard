# Backtest Framework

## Purpose
Validate strategy performance on historical data before deploying live. Every strategy must pass backtesting before being used in auto-trading.

## Process

### 1. Data Collection
- Pull historical candle data from Capital.com API:
  - `GET /api/v1/prices/{epic}?resolution={res}&max={count}`
  - Resolutions: MINUTE_5, MINUTE_15, HOUR, HOUR_4
  - Max 1000 candles per request
- Store locally as JSON for reuse
- Minimum: 500 candles on primary timeframe (15M = ~5 trading days)

### 2. Strategy Simulation
For each candle in historical data:
1. Calculate all indicators (RSI, MACD, Bollinger, ATR, EMA)
2. Detect patterns (candlestick, chart patterns)
3. Apply strategy entry conditions
4. If signal triggered → simulate entry with SL/TP
5. Walk forward through subsequent candles:
   - Did SL get hit? → Record LOSS with P/L
   - Did TP get hit? → Record WIN with P/L
   - Did timeout trigger? → Record with actual P/L
6. Move to next signal

### 3. Metrics to Calculate

**Basic**:
- Total trades
- Win rate (%)
- Total P/L
- Average win / Average loss
- Risk-reward ratio (avg win ÷ avg loss)

**Advanced**:
- Profit factor (gross profit ÷ gross loss) — must be > 1.0
- Max drawdown (largest peak-to-trough decline)
- Max consecutive wins / losses
- Sharpe ratio (if enough data)
- Win rate by instrument
- Win rate by session (Asian/European/American)
- Win rate by day of week

### 4. Pass/Fail Criteria

A strategy **passes** backtest if:
- Profit factor > 1.2
- Risk-reward ratio > 1.3:1
- Win rate > 35% (for trend-following) or > 55% (for mean-reversion)
- Max drawdown < 10% of simulated capital
- At least 30 trades in sample

A strategy **fails** and should be disabled or modified if:
- Profit factor < 1.0 (losing money)
- Win rate < 25% after 20+ trades
- Max drawdown > 15%
- More than 7 consecutive losses

### 5. Optimization

After initial backtest:
1. Identify weakest parameters (e.g., RSI threshold, ATR multiplier)
2. Test parameter variations:
   - RSI entry: test 25/30/35
   - ATR SL multiplier: test 1.0/1.2/1.5
   - Minimum confidence: test 0.55/0.60/0.65/0.70
3. Pick best combination based on risk-adjusted return (not just highest P/L)
4. **Avoid overfitting**: If optimization only works on specific date range, it's overfitted
5. Validate on out-of-sample data (different date range)

### 6. Reporting

Backtest results should be stored in `trading/backtest_results/` with format:
```json
{
  "strategy": "EMA_CROSS_TREND",
  "instrument": "GOLD",
  "period": "2026-03-01 to 2026-03-30",
  "timeframe": "15M",
  "totalTrades": 45,
  "wins": 22,
  "losses": 23,
  "winRate": "48.9%",
  "totalPnl": 125.50,
  "avgWin": 15.20,
  "avgLoss": -8.30,
  "riskReward": 1.83,
  "profitFactor": 1.42,
  "maxDrawdown": -45.00,
  "maxConsecutiveLosses": 4,
  "parameters": {
    "ema_fast": 9,
    "ema_slow": 21,
    "rsi_threshold": 50,
    "atr_sl_mult": 1.2,
    "min_confidence": 0.60
  },
  "verdict": "PASS",
  "notes": "Strong during London session, weak during Asian. Consider session filter."
}
```

### 7. Continuous Improvement Cycle

```
Deploy strategy → Collect live/sim results → Compare vs backtest
→ If performance degrades → Re-backtest with recent data
→ Adjust parameters or disable
→ Test new strategy ideas → Backtest → Deploy if passes
```

This cycle runs continuously. Every strategy in production should be re-validated monthly.
