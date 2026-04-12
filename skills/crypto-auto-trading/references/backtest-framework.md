# Crypto Backtest Framework

## Process

Same structure as forex backtest framework (`skills/forex-auto-trading/references/backtest-framework.md`). Key differences below.

### Data Collection
- MAX API: `GET /api/v2/k?market={pair}&period={min}&limit={count}`
- Periods: 1 (1min), 5, 15, 30, 60, 120, 240, 360, 720, 1440 (1day)
- Max 1000 candles per request
- Minimum: 500 candles on primary timeframe
- **Crypto advantage**: 24/7 data, no gaps, more data points per day than forex

### Metrics (same as forex, plus)
- Win rate by pair (btctwd may behave differently from dogetwd)
- Win rate by BTC direction (were we trading with or against BTC?)
- Avg hold time for winners vs losers
- Trailing stop effectiveness (how much extra profit did trailing capture?)

### Pass/Fail Criteria
Same as forex:
- Profit factor > 1.2
- Risk-reward ratio > 1.5:1
- Win rate > 30% (trend) or > 50% (reversion)
- Max drawdown < 10%
- At least 30 trades in sample

### Crypto-Specific Validation
- **Test across market conditions**: Bull run, bear market, and sideways
- **Test with and without BTC correlation filter**: Does filtering improve results?
- **Test different ATR periods**: Crypto volatility shifts faster, shorter ATR may be better
- **Watch for exchange-specific artifacts**: MAX liquidity can cause slippage on paper but not in backtest

### Reporting
Store in `trading/backtest_results/crypto/` with same JSON format as forex, plus:
```json
{
  "btcCorrelationFilter": true,
  "avgHoldTimeWinners": "45min",
  "avgHoldTimeLosers": "12min",
  "trailingStopBenefit": "+15% extra profit captured"
}
```

### Continuous Improvement
Same cycle: Deploy → Collect → Compare vs backtest → Adjust → Re-validate monthly.
