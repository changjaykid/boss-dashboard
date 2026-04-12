# Crypto Risk Management Rules

## Position Sizing

### Testing Phase (Current)
- Base risk per trade: **1.5% of capital**
- High confidence (> 0.70): **2.5% of capital**
- Position size = (Capital × Risk%) / SL distance
- Compounding enabled (use current capital, not initial)

### Live Phase (NT$15,000)
- Base risk: **1% of capital**
- High confidence: **2% of capital**
- First 2 weeks: minimum sizes only

## Stop Loss Rules

- **Primary method**: ATR × 1.2 (tight — cut losers fast)
- **Maximum SL**: 1.5% of entry price
- **Minimum SL**: 0.3% of entry price (avoid being stopped by noise)
- SL is engine-side (simulated), not exchange-side
- **Never move SL wider**

## Take Profit & Trailing

- **Minimum risk-reward**: 2.0:1 (hard rule — skip trade if R:R below this)
- **TP method**: ATR × 2.5 or next S/R level

### Trailing Stop System (key to letting winners ride)
| Profit level | Action |
|-------------|--------|
| +0.5% | Lock breakeven (SL moves to entry) |
| +1.0% | Trail distance widens to 0.5% |
| +2.0% | Trail distance widens to 0.8% |
| +3.0%+ | Trail by ATR × 1.0 (dynamic) |

This is the core mechanic for "賺的抱住" — small moves lock breakeven, big moves get room to breathe.

## Position Limits

- Max **5 concurrent positions**
- Max **80% total exposure** (keep 20% cash buffer)
- **No duplicate**: one position per pair max
- BTC TWD + BTC USDT = correlated → treat as same asset, max 1 total
- Same for ETH TWD + ETH USDT

## Time-Based Rules

- **Time exit**: 4 hours with no movement AND < 0.15% profit → close
- **Cooldown**: 5 minutes after a loss before next entry
- **No time-of-day restrictions** (crypto is 24/7)
- **Weekend**: Normal trading (crypto doesn't close)

## Consecutive Loss Rules

### Testing Phase (CURRENT — ALL DISABLED)
- No pause, no stop, no size reduction
- Keep trading to gather data
- TODO: Re-enable when switching to live

### Live Phase (Future)
- 3 consecutive losses → half position size
- 5 consecutive losses → pause 1 hour
- 7 consecutive losses → pause 4 hours, full strategy review

## BTC Correlation Rule

- Before opening any altcoin position, check BTC direction
- If BTC is dumping (> 2% drop in 1H): do NOT open new altcoin longs
- If BTC is pumping: altcoin longs are safer
- This is the single most important crypto-specific risk rule

## Mode Switch: Simulation → Live

When switching:
1. Fund MAX account with NT$15,000
2. Replace simulation logic with real API order execution
3. Reduce max positions to 3
4. Reduce base risk to 1%
5. Enable consecutive loss controls
6. Start with BTC/ETH TWD pairs only (most liquid on MAX)
7. Add altcoins after 1 week of profitable BTC/ETH trading

## Emergency Rules

- **API failure**: Skip cycle, existing positions managed by trailing logic next cycle
- **Exchange maintenance**: Detected by API error → skip, log alert
- **Flash crash** (> 10% drop in 1H): Close all positions, pause 2H
- **Single trade loss > 3%**: Investigate — likely a gap through SL
