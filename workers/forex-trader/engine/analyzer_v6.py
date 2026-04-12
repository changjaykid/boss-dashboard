#!/usr/bin/env python3
"""
Multi-Instrument Auto Trading Analyzer v6
- Modular strategy engine (12 independent strategies)
- P/L recovery for broker-closed trades via transactions API
- Enhanced dashboard JSON with full statistics
- Strict risk management with consecutive loss controls
- Correlated instrument limits
"""

import json, sys, argparse, requests, os, math
from datetime import datetime, timezone, timedelta

def parse_args():
    p = argparse.ArgumentParser()
    p.add_argument('--positions', required=True)
    p.add_argument('--account', required=True)
    p.add_argument('--market-data', required=True)
    p.add_argument('--state', required=True)
    p.add_argument('--trade-log', required=True)
    p.add_argument('--api-url', required=True)
    p.add_argument('--cst', required=True)
    p.add_argument('--xsec', required=True)
    return p.parse_args()

# ========== INSTRUMENTS ==========
INSTRUMENTS = {
    "GOLD":        {"name": "XAUUSD",   "type": "黃金",  "min_size": 0.01, "max_size": 0.1},
    "EURUSDM2026": {"name": "EUR/USD",  "type": "外匯",  "min_size": 0.1,  "max_size": 1.0},
    "GBPUSD":      {"name": "GBP/USD",  "type": "外匯",  "min_size": 0.1,  "max_size": 1.0},
    "USDJPYM2026": {"name": "USD/JPY",  "type": "外匯",  "min_size": 0.1,  "max_size": 1.0},
    "US30":        {"name": "US30",     "type": "指數",  "min_size": 0.1,  "max_size": 1.0},
    "US500":       {"name": "S&P 500",  "type": "指數",  "min_size": 0.1,  "max_size": 1.0},
    "US100":       {"name": "NAS100",   "type": "指數",  "min_size": 0.1,  "max_size": 1.0},
}

BANNED_INSTRUMENTS = set()

# Correlated groups for position limits
CORRELATED_GROUPS = {
    "US_INDICES": ["US30", "US500", "US100"],
}

# ========== SESSION AWARENESS ==========
ACTIVE_SESSIONS = {
    "GOLD":        [(0, 24)],
    "EURUSDM2026": [(7, 21)],
    "GBPUSD":      [(7, 21)],
    "USDJPYM2026": [(0, 9), (13, 21)],
    "US30":        [(13, 21)],
    "US500":       [(13, 21)],
    "US100":       [(13, 21)],
}

def is_active_session(epic):
    now_utc = datetime.now(timezone.utc).hour
    sessions = ACTIVE_SESSIONS.get(epic, [(0, 24)])
    for start, end in sessions:
        if start <= now_utc < end:
            return True
    return False

# ========== ENABLED STRATEGIES ==========
# Toggle individual strategies on/off
STRATEGY_ENABLED = {
    # === 賺錢策略（保留 + 優化）===
    "breakout_range": True,           # +$55, 30% WR, RR 5.06 — 最佳策略
    "reversion_bollinger": True,      # +$4.21, 100% WR — 小樣本但正期望值
    "trend_ema_cross": True,          # 基礎趨勢跟蹤，保留觀察
    "trend_elliott_wave3": True,      # 波浪理論，保留觀察
    "trend_flag_breakout": True,      # 旗形突破，保留觀察

    # === 虧損策略（停用）===
    "trend_mtf_alignment": False,     # -$103, 12.8% WR — 最大虧損來源
    "reversion_pin_bar": False,       # -$84, 0% WR — 14連敗，完全無效
    "breakout_pattern": False,        # -$57, 16% WR — 虧損嚴重
    "breakout_outside_bar": False,    # -$52, 0% WR — 10連敗
    "breakout_bollinger_squeeze": False, # -$22, 11% WR — 虧損
    "reversion_rsi_divergence": False,   # -$2.2, 0% WR — 無效
    "reversion_sr": True,            # 支撐壓力，保留觀察

    # === 新增策略（2026-04-07）===
    "asian_range_breakout": True,     # 亞洲區間突破（黃金專用）
    "session_momentum": True,         # 時段動量
    "multi_indicator_consensus": True, # 多指標共識
    "atr_breakout": True,
    "strategy_us30_pullback": True,            # ATR 突破
}

# ========== BASE INDICATORS ==========

def get_closes(candles):
    return [(c['closePrice']['bid'] + c['closePrice']['ask']) / 2 for c in candles]

def get_ohlc(candle):
    o = (candle['openPrice']['bid'] + candle['openPrice']['ask']) / 2
    h = (candle['highPrice']['bid'] + candle['highPrice']['ask']) / 2
    l = (candle['lowPrice']['bid'] + candle['lowPrice']['ask']) / 2
    c = (candle['closePrice']['bid'] + candle['closePrice']['ask']) / 2
    return o, h, l, c

def calc_ema(closes, period):
    if len(closes) < period:
        return sum(closes) / len(closes) if closes else 0
    multiplier = 2 / (period + 1)
    ema = sum(closes[:period]) / period
    for price in closes[period:]:
        ema = (price - ema) * multiplier + ema
    return ema

def calc_sma(closes, period):
    if len(closes) < period:
        return sum(closes) / len(closes) if closes else 0
    return sum(closes[-period:]) / period

def calc_rsi(closes, period=14):
    if len(closes) < period + 1:
        return 50
    gains, losses = [], []
    for i in range(1, len(closes)):
        diff = closes[i] - closes[i - 1]
        gains.append(max(diff, 0))
        losses.append(max(-diff, 0))
    ag = sum(gains[-period:]) / period
    al = sum(losses[-period:]) / period
    if al == 0:
        return 100
    return 100 - (100 / (1 + (ag / al)))

def calc_atr(candles, period=14):
    trs = []
    for i in range(1, len(candles)):
        h = (candles[i]['highPrice']['bid'] + candles[i]['highPrice']['ask']) / 2
        l = (candles[i]['lowPrice']['bid'] + candles[i]['lowPrice']['ask']) / 2
        pc = (candles[i - 1]['closePrice']['bid'] + candles[i - 1]['closePrice']['ask']) / 2
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    if not trs:
        return 0
    return sum(trs[-period:]) / min(period, len(trs))

def calc_macd(closes, fast=12, slow=26, signal=9):
    if len(closes) < slow:
        return 0, 0, 0
    ef = calc_ema(closes, fast)
    es = calc_ema(closes, slow)
    ml = ef - es
    mvs = []
    for i in range(signal):
        idx = len(closes) - signal + i
        if idx >= 0:
            mvs.append(calc_ema(closes[:idx + 1], fast) - calc_ema(closes[:idx + 1], slow))
    sl = sum(mvs) / len(mvs) if mvs else ml
    return ml, sl, ml - sl

def calc_bollinger(closes, period=20, std_mult=2):
    if len(closes) < period:
        return closes[-1] if closes else 0, 0, 0
    r = closes[-period:]
    sma = sum(r) / period
    v = sum((x - sma) ** 2 for x in r) / period
    std = v ** 0.5
    return sma, sma + std_mult * std, sma - std_mult * std

def calc_bollinger_width(closes, period=20, std_mult=2):
    mid, up, low = calc_bollinger(closes, period, std_mult)
    if mid == 0:
        return 0
    return (up - low) / mid

def find_peaks_troughs(closes, window=2):
    peaks, troughs = [], []
    for i in range(window, len(closes) - window):
        is_peak = all(closes[i] > closes[i - j] and closes[i] > closes[i + j] for j in range(1, window + 1))
        is_trough = all(closes[i] < closes[i - j] and closes[i] < closes[i + j] for j in range(1, window + 1))
        if is_peak:
            peaks.append((i, closes[i]))
        if is_trough:
            troughs.append((i, closes[i]))
    return peaks, troughs

def find_support_resistance(closes, candles, lookback=50):
    """Find nearest support and resistance levels."""
    if len(closes) < lookback:
        return None, None
    highs = [(candles[i]['highPrice']['bid'] + candles[i]['highPrice']['ask']) / 2 for i in range(-lookback, 0)]
    lows = [(candles[i]['lowPrice']['bid'] + candles[i]['lowPrice']['ask']) / 2 for i in range(-lookback, 0)]
    curr = closes[-1]
    resistance = min((h for h in highs if h > curr), default=None)
    support = max((l for l in lows if l < curr), default=None)
    return support, resistance

# ========== MARKET REGIME ==========

def classify_market_regime(closes_4h, closes_1h, candles_1h):
    if len(closes_1h) < 50:
        return "RANGING"
    ema9 = calc_ema(closes_1h, 9)
    ema21 = calc_ema(closes_1h, 21)
    ema50 = calc_ema(closes_1h, 50)
    bw = calc_bollinger_width(closes_1h, 20, 2)
    atr_now = calc_atr(candles_1h)
    atr_old = calc_atr(candles_1h[:-14]) if len(candles_1h) > 28 else atr_now
    atr_ratio = atr_now / atr_old if atr_old > 0 else 1.0

    if atr_ratio > 2.0:
        return "VOLATILE"
    if bw < 0.005 and atr_ratio > 1.5:
        return "BREAKOUT"
    if ema9 > ema21 > ema50:
        return "TRENDING_UP"
    elif ema9 < ema21 < ema50:
        return "TRENDING_DOWN"
    return "RANGING"


# ========== 12 MODULAR STRATEGIES ==========
# Each returns: (direction, confidence, strategy_name, sl_distance, tp_distance)
# direction: "BUY" | "SELL" | "NONE"
# confidence: 0.0 - 1.0
# If no signal, return ("NONE", 0, name, 0, 0)

def strategy_trend_ema_cross(candles_1h, closes_1h, atr):
    """EMA 9/21 crossover with EMA50 filter."""
    if not STRATEGY_ENABLED.get("trend_ema_cross") or len(closes_1h) < 50:
        return ("NONE", 0, "trend_ema_cross", 0, 0)
    ema9 = calc_ema(closes_1h, 9)
    ema21 = calc_ema(closes_1h, 21)
    ema50 = calc_ema(closes_1h, 50)
    ema9_prev = calc_ema(closes_1h[:-1], 9)
    ema21_prev = calc_ema(closes_1h[:-1], 21)

    sl = atr * 1.2
    tp = atr * 2.5

    # Bullish cross
    if ema9_prev <= ema21_prev and ema9 > ema21 and closes_1h[-1] > ema50:
        return ("BUY", 0.70, "trend_ema_cross", sl, tp)
    # Bearish cross
    if ema9_prev >= ema21_prev and ema9 < ema21 and closes_1h[-1] < ema50:
        return ("SELL", 0.70, "trend_ema_cross", sl, tp)
    return ("NONE", 0, "trend_ema_cross", 0, 0)


def strategy_trend_mtf_alignment(candles_4h, candles_1h, candles_15m, closes_4h, closes_1h, closes_15m, atr):
    """Multi-timeframe alignment: 4H/1H/15M EMAs must agree."""
    if not STRATEGY_ENABLED.get("trend_mtf_alignment"):
        return ("NONE", 0, "trend_mtf_alignment", 0, 0)
    if len(closes_4h) < 20 or len(closes_1h) < 20 or len(closes_15m) < 20:
        return ("NONE", 0, "trend_mtf_alignment", 0, 0)

    ema4h = calc_ema(closes_4h, 20)
    ema1h = calc_ema(closes_1h, 20)
    ema15m = calc_ema(closes_15m, 20)

    sl = atr * 1.2
    tp = atr * 3.0

    if closes_4h[-1] > ema4h and closes_1h[-1] > ema1h and closes_15m[-1] > ema15m:
        return ("BUY", 0.75, "trend_mtf_alignment", sl, tp)
    if closes_4h[-1] < ema4h and closes_1h[-1] < ema1h and closes_15m[-1] < ema15m:
        return ("SELL", 0.75, "trend_mtf_alignment", sl, tp)
    return ("NONE", 0, "trend_mtf_alignment", 0, 0)


def strategy_trend_elliott_wave3(candles_15m, closes_15m, atr):
    """Simplified Elliott Wave 3 detection using Fibonacci."""
    if not STRATEGY_ENABLED.get("trend_elliott_wave3") or len(closes_15m) < 50:
        return ("NONE", 0, "trend_elliott_wave3", 0, 0)

    highs = [(c['highPrice']['bid'] + c['highPrice']['ask']) / 2 for c in candles_15m[-50:]]
    lows = [(c['lowPrice']['bid'] + c['lowPrice']['ask']) / 2 for c in candles_15m[-50:]]
    max_h = max(highs)
    min_l = min(lows)
    diff = max_h - min_l
    if diff == 0:
        return ("NONE", 0, "trend_elliott_wave3", 0, 0)

    curr = closes_15m[-1]
    fib_382 = max_h - diff * 0.382
    fib_618 = max_h - diff * 0.618

    sl = atr * 1.5
    tp = atr * 3.0

    # Near 38.2% retracement in uptrend (potential wave 3 start)
    if curr > max_h - diff * 0.2 and closes_15m[-1] > closes_15m[-3]:
        return ("BUY", 0.65, "trend_elliott_wave3", sl, tp)
    if curr < min_l + diff * 0.2 and closes_15m[-1] < closes_15m[-3]:
        return ("SELL", 0.65, "trend_elliott_wave3", sl, tp)
    return ("NONE", 0, "trend_elliott_wave3", 0, 0)


def strategy_trend_flag_breakout(candles_15m, closes_15m, atr):
    """Flag/pennant breakout after strong move."""
    if not STRATEGY_ENABLED.get("trend_flag_breakout") or len(closes_15m) < 30:
        return ("NONE", 0, "trend_flag_breakout", 0, 0)

    # Detect strong move (pole) in last 10-20 bars
    pole_start = closes_15m[-20]
    pole_end = closes_15m[-10]
    pole_move = pole_end - pole_start
    pole_pct = abs(pole_move) / pole_start if pole_start else 0

    if pole_pct < 0.005:  # Need at least 0.5% move for a flag pole
        return ("NONE", 0, "trend_flag_breakout", 0, 0)

    # Flag: last 10 bars should be consolidating (range < 40% of pole)
    flag_high = max(closes_15m[-10:])
    flag_low = min(closes_15m[-10:])
    flag_range = flag_high - flag_low

    if flag_range > abs(pole_move) * 0.4:
        return ("NONE", 0, "trend_flag_breakout", 0, 0)

    sl = atr * 1.2
    tp = abs(pole_move) * 0.8  # Target = ~80% of pole

    # Breakout direction follows pole
    if pole_move > 0 and closes_15m[-1] > flag_high:
        return ("BUY", 0.72, "trend_flag_breakout", sl, tp)
    if pole_move < 0 and closes_15m[-1] < flag_low:
        return ("SELL", 0.72, "trend_flag_breakout", sl, tp)
    return ("NONE", 0, "trend_flag_breakout", 0, 0)


def strategy_reversion_sr(candles_15m, closes_15m, atr):
    """Support/resistance bounce."""
    if not STRATEGY_ENABLED.get("reversion_sr") or len(closes_15m) < 50:
        return ("NONE", 0, "reversion_sr", 0, 0)

    support, resistance = find_support_resistance(closes_15m, candles_15m)
    curr = closes_15m[-1]
    prev = closes_15m[-2]

    sl = atr * 1.2
    tp = atr * 2.0

    if support and abs(curr - support) / support < 0.002 and curr > prev:
        return ("BUY", 0.68, "reversion_sr", sl, tp)
    if resistance and abs(curr - resistance) / resistance < 0.002 and curr < prev:
        return ("SELL", 0.68, "reversion_sr", sl, tp)
    return ("NONE", 0, "reversion_sr", 0, 0)


def strategy_reversion_rsi_divergence(candles_15m, closes_15m, atr):
    """RSI divergence: price makes new low but RSI doesn't (or vice versa)."""
    if not STRATEGY_ENABLED.get("reversion_rsi_divergence") or len(closes_15m) < 30:
        return ("NONE", 0, "reversion_rsi_divergence", 0, 0)

    rsi_now = calc_rsi(closes_15m)
    rsi_prev = calc_rsi(closes_15m[:-5])

    sl = atr * 1.2
    tp = atr * 2.0

    # Bullish divergence: price lower low, RSI higher low
    if closes_15m[-1] < min(closes_15m[-10:-5]) and rsi_now > rsi_prev and rsi_now < 40:
        return ("BUY", 0.70, "reversion_rsi_divergence", sl, tp)
    # Bearish divergence: price higher high, RSI lower high
    if closes_15m[-1] > max(closes_15m[-10:-5]) and rsi_now < rsi_prev and rsi_now > 60:
        return ("SELL", 0.70, "reversion_rsi_divergence", sl, tp)
    return ("NONE", 0, "reversion_rsi_divergence", 0, 0)


def strategy_reversion_bollinger(candles_15m, closes_15m, atr):
    """Bollinger band mean reversion."""
    if not STRATEGY_ENABLED.get("reversion_bollinger") or len(closes_15m) < 20:
        return ("NONE", 0, "reversion_bollinger", 0, 0)

    mid, upper, lower = calc_bollinger(closes_15m, 20, 2)
    curr = closes_15m[-1]
    prev = closes_15m[-2]
    rsi = calc_rsi(closes_15m)

    sl = atr * 1.2
    tp = abs(curr - mid) * 0.8  # Target mid-band
    if tp < atr:
        tp = atr * 1.5

    # Touch lower band + RSI oversold + reversal candle
    if curr <= lower and rsi < 35 and curr > prev:
        return ("BUY", 0.68, "reversion_bollinger", sl, tp)
    # Touch upper band + RSI overbought + reversal candle
    if curr >= upper and rsi > 65 and curr < prev:
        return ("SELL", 0.68, "reversion_bollinger", sl, tp)
    return ("NONE", 0, "reversion_bollinger", 0, 0)


def strategy_reversion_pin_bar(candles_15m, closes_15m, atr):
    """Pin bar reversal pattern."""
    if not STRATEGY_ENABLED.get("reversion_pin_bar") or len(candles_15m) < 3:
        return ("NONE", 0, "reversion_pin_bar", 0, 0)

    o, h, l, c = get_ohlc(candles_15m[-1])
    body = abs(c - o)
    rng = h - l
    if rng == 0:
        return ("NONE", 0, "reversion_pin_bar", 0, 0)

    sl = atr * 1.2
    tp = atr * 2.0

    # Bullish pin bar: small body, long lower shadow
    if body < rng * 0.3 and (min(o, c) - l) > rng * 0.6:
        return ("BUY", 0.72, "reversion_pin_bar", sl, tp)
    # Bearish pin bar: small body, long upper shadow
    if body < rng * 0.3 and (h - max(o, c)) > rng * 0.6:
        return ("SELL", 0.72, "reversion_pin_bar", sl, tp)
    return ("NONE", 0, "reversion_pin_bar", 0, 0)


def strategy_breakout_pattern(candles_15m, closes_15m, atr):
    """Double top/bottom breakout."""
    if not STRATEGY_ENABLED.get("breakout_pattern") or len(closes_15m) < 30:
        return ("NONE", 0, "breakout_pattern", 0, 0)

    peaks, troughs = find_peaks_troughs(closes_15m[-30:])

    sl = atr * 1.5
    tp = atr * 3.0

    if len(troughs) >= 2 and len(peaks) >= 1:
        t1, t2 = troughs[-2][1], troughs[-1][1]
        if abs(t1 - t2) / t1 < 0.003:
            neckline = peaks[-1][1]
            if closes_15m[-1] > neckline:
                tp = neckline - t1
                return ("BUY", 0.75, "breakout_pattern", sl, tp)

    if len(peaks) >= 2 and len(troughs) >= 1:
        p1, p2 = peaks[-2][1], peaks[-1][1]
        if abs(p1 - p2) / p1 < 0.003:
            neckline = troughs[-1][1]
            if closes_15m[-1] < neckline:
                tp = p1 - neckline
                return ("SELL", 0.75, "breakout_pattern", sl, tp)

    return ("NONE", 0, "breakout_pattern", 0, 0)


def strategy_breakout_bollinger_squeeze(candles_15m, closes_15m, atr):
    """Bollinger squeeze breakout (low volatility → expansion)."""
    if not STRATEGY_ENABLED.get("breakout_bollinger_squeeze") or len(closes_15m) < 30:
        return ("NONE", 0, "breakout_bollinger_squeeze", 0, 0)

    bw_now = calc_bollinger_width(closes_15m, 20, 2)
    bw_prev = calc_bollinger_width(closes_15m[:-5], 20, 2)
    mid, upper, lower = calc_bollinger(closes_15m, 20, 2)

    sl = atr * 1.5
    tp = atr * 3.0

    # Squeeze: bandwidth was low, now expanding
    if bw_prev < 0.01 and bw_now > bw_prev * 1.3:
        if closes_15m[-1] > upper:
            return ("BUY", 0.70, "breakout_bollinger_squeeze", sl, tp)
        if closes_15m[-1] < lower:
            return ("SELL", 0.70, "breakout_bollinger_squeeze", sl, tp)
    return ("NONE", 0, "breakout_bollinger_squeeze", 0, 0)


def strategy_breakout_range(candles_15m, closes_15m, atr):
    """Range breakout: break above/below recent consolidation range."""
    if not STRATEGY_ENABLED.get("breakout_range") or len(closes_15m) < 30:
        return ("NONE", 0, "breakout_range", 0, 0)

    range_high = max(closes_15m[-20:-1])
    range_low = min(closes_15m[-20:-1])
    range_size = range_high - range_low
    curr = closes_15m[-1]

    sl = atr * 1.2
    tp = range_size  # Measured move

    if tp < atr * 1.5:
        tp = atr * 2.0

    if curr > range_high and range_size / range_high < 0.02:  # Was actually ranging
        return ("BUY", 0.68, "breakout_range", sl, tp)
    if curr < range_low and range_size / range_high < 0.02:
        return ("SELL", 0.68, "breakout_range", sl, tp)
    return ("NONE", 0, "breakout_range", 0, 0)


def strategy_breakout_outside_bar(candles_15m, closes_15m, atr):
    """Outside bar breakout."""
    if not STRATEGY_ENABLED.get("breakout_outside_bar") or len(candles_15m) < 3:
        return ("NONE", 0, "breakout_outside_bar", 0, 0)

    o1, h1, l1, c1 = get_ohlc(candles_15m[-1])
    o2, h2, l2, c2 = get_ohlc(candles_15m[-2])

    sl = atr * 1.2
    tp = atr * 2.0

    if h1 > h2 and l1 < l2:
        if c1 > o1:
            return ("BUY", 0.65, "breakout_outside_bar", sl, tp)
        else:
            return ("SELL", 0.65, "breakout_outside_bar", sl, tp)
    return ("NONE", 0, "breakout_outside_bar", 0, 0)


# ========== NEW STRATEGIES (2026-04-07) ==========

def strategy_asian_range_breakout(candles_15m, closes_15m, atr, epic=""):
    """Asian session range breakout — best for GOLD."""
    if not STRATEGY_ENABLED.get("asian_range_breakout") or len(candles_15m) < 60:
        return ("NONE", 0, "asian_range_breakout", 0, 0)
    
    now_utc = datetime.now(timezone.utc).hour
    # Only trigger during London/NY session (7-16 UTC)
    if now_utc < 7 or now_utc > 16:
        return ("NONE", 0, "asian_range_breakout", 0, 0)
    
    # Find Asian session candles (UTC 0-7) from today's 15m data
    asian_highs, asian_lows = [], []
    for c in candles_15m:
        ts = c.get("snapshotTimeUTC") or c.get("snapshotTime", "")
        try:
            h = int(ts[11:13]) if len(ts) > 13 else -1
        except:
            continue
        if 0 <= h < 7:
            _, ch, cl, _ = get_ohlc(c)
            asian_highs.append(ch)
            asian_lows.append(cl)
    
    if len(asian_highs) < 8:  # Need at least 2h of data
        return ("NONE", 0, "asian_range_breakout", 0, 0)
    
    a_high = max(asian_highs)
    a_low = min(asian_lows)
    a_range = a_high - a_low
    
    # Minimum range filter (avoid too narrow)
    if a_range < atr * 0.5:
        return ("NONE", 0, "asian_range_breakout", 0, 0)
    
    current_price = closes_15m[-1]
    sl = atr * 1.2
    tp = a_range * 1.5  # Target = 1.5x Asian range
    
    if current_price > a_high:
        return ("BUY", 0.72, "asian_range_breakout", sl, max(tp, sl * 2))
    elif current_price < a_low:
        return ("SELL", 0.72, "asian_range_breakout", sl, max(tp, sl * 2))
    
    return ("NONE", 0, "asian_range_breakout", 0, 0)


def strategy_session_momentum(candles_15m, closes_15m, atr):
    """Session open momentum — trade the first 30min direction."""
    if not STRATEGY_ENABLED.get("session_momentum") or len(closes_15m) < 10:
        return ("NONE", 0, "session_momentum", 0, 0)
    
    now_utc = datetime.now(timezone.utc).hour
    # Only at session opens: London (7-8 UTC) or NY (13-14 UTC)
    if now_utc not in [7, 8, 13, 14]:
        return ("NONE", 0, "session_momentum", 0, 0)
    
    # Look at last 2 candles (30min) momentum
    if len(closes_15m) < 3:
        return ("NONE", 0, "session_momentum", 0, 0)
    
    mom = (closes_15m[-1] - closes_15m[-3]) / closes_15m[-3] * 100
    rsi_val = calc_rsi(closes_15m)
    
    sl = atr * 1.0
    tp = atr * 2.5
    
    # Strong momentum + RSI confirmation
    if mom > 0.15 and rsi_val and rsi_val > 55:
        return ("BUY", 0.68, "session_momentum", sl, tp)
    elif mom < -0.15 and rsi_val and rsi_val < 45:
        return ("SELL", 0.68, "session_momentum", sl, tp)
    
    return ("NONE", 0, "session_momentum", 0, 0)


def strategy_multi_indicator_consensus(candles_15m, closes_15m, candles_1h, closes_1h, atr):
    """Multi-indicator consensus — at least 4/6 indicators agree."""
    if not STRATEGY_ENABLED.get("multi_indicator_consensus") or len(closes_15m) < 30:
        return ("NONE", 0, "multi_indicator_consensus", 0, 0)
    
    buy_votes, sell_votes = 0, 0
    
    # 1. RSI
    rsi_val = calc_rsi(closes_15m)
    if rsi_val:
        if rsi_val > 55: buy_votes += 1
        elif rsi_val < 45: sell_votes += 1
    
    # 2. EMA cross (9 vs 21)
    ema9 = calc_ema(closes_15m, 9)
    ema21 = calc_ema(closes_15m, 21)
    if ema9 and ema21:
        if ema9 > ema21: buy_votes += 1
        else: sell_votes += 1
    
    # 3. MACD
    macd_val = calc_macd(closes_15m)
    if macd_val:
        if macd_val[2] > 0: buy_votes += 1  # histogram > 0
        else: sell_votes += 1
    
    # 4. Bollinger position
    bb_val = calc_bollinger(closes_15m)
    if bb_val:
        price = closes_15m[-1]
        mid = bb_val[1]
        if price > mid: buy_votes += 1
        else: sell_votes += 1
    
    # 5. 1H trend
    if len(closes_1h) >= 21:
        ema8_1h = calc_ema(closes_1h, 8)
        ema21_1h = calc_ema(closes_1h, 21)
        if ema8_1h and ema21_1h:
            if ema8_1h > ema21_1h: buy_votes += 1
            else: sell_votes += 1
    
    # 6. Volume (recent vs average)
    if len(candles_15m) >= 20:
        recent_vol = sum(float(c.get("lastTradedVolume", 0)) for c in candles_15m[-3:]) / 3
        avg_vol = sum(float(c.get("lastTradedVolume", 0)) for c in candles_15m[-20:-3]) / 17
        if recent_vol > avg_vol * 1.3: 
            buy_votes += (1 if buy_votes > sell_votes else 0)
            sell_votes += (1 if sell_votes > buy_votes else 0)
    
    sl = atr * 1.2
    tp = atr * 2.5
    
    # Need 4+ votes in same direction
    if buy_votes >= 4:
        conf = 0.65 + (buy_votes - 4) * 0.05
        return ("BUY", min(conf, 0.85), "multi_indicator_consensus", sl, tp)
    elif sell_votes >= 4:
        conf = 0.65 + (sell_votes - 4) * 0.05
        return ("SELL", min(conf, 0.85), "multi_indicator_consensus", sl, tp)
    
    return ("NONE", 0, "multi_indicator_consensus", 0, 0)


def strategy_atr_breakout(candles_15m, closes_15m, atr):
    """ATR breakout — price breaks previous candle high/low by 1.5x ATR."""
    if not STRATEGY_ENABLED.get("atr_breakout") or len(candles_15m) < 5 or not atr:
        return ("NONE", 0, "atr_breakout", 0, 0)
    
    prev = candles_15m[-2]
    curr = candles_15m[-1]
    _, ph, pl, _ = get_ohlc(prev)
    _, _, _, cc = get_ohlc(curr)
    
    breakout_dist = atr * 1.5
    sl = atr * 1.0
    tp = atr * 3.0
    
    # Upward breakout
    if cc > ph + breakout_dist:
        # Confirm with RSI not overbought
        rsi_val = calc_rsi(closes_15m)
        if rsi_val and rsi_val < 75:
            return ("BUY", 0.70, "atr_breakout", sl, tp)
    
    # Downward breakout
    if cc < pl - breakout_dist:
        rsi_val = calc_rsi(closes_15m)
        if rsi_val and rsi_val > 25:
            return ("SELL", 0.70, "atr_breakout", sl, tp)
    
    return ("NONE", 0, "atr_breakout", 0, 0)


# ========== STRATEGY RUNNER ==========


def strategy_us30_pullback(candles_15m, closes_1h, closes_15m, atr):
    if not STRATEGY_ENABLED.get("strategy_us30_pullback") or len(closes_1h) < 50 or len(closes_15m) < 15:
        return ("NONE", 0, "strategy_us30_pullback", 0, 0)
    
    ema9_1h = calc_ema(closes_1h, 9)
    ema21_1h = calc_ema(closes_1h, 21)
    ema50_1h = calc_ema(closes_1h, 50)
    
    trend = "NONE"
    if ema9_1h > ema21_1h > ema50_1h and closes_1h[-1] > ema50_1h:
        trend = "UP"
    elif ema9_1h < ema21_1h < ema50_1h and closes_1h[-1] < ema50_1h:
        trend = "DOWN"
        
    if trend == "NONE":
        return ("NONE", 0, "strategy_us30_pullback", 0, 0)
        
    ema21_15m = calc_ema(closes_15m, 21)
    curr_c = closes_15m[-1]
    
    if trend == "UP":
        if min(closes_15m[-5:]) < ema21_15m + atr*0.5 and curr_c > ema21_15m:
            local_low = min([ (c['lowPrice']['bid'] + c['lowPrice']['ask'])/2 for c in candles_15m[-10:] ])
            sl_dist = curr_c - local_low + 10
            if sl_dist < atr * 0.5: sl_dist = atr * 0.5
            tp_dist = sl_dist * 2.0
            if curr_c > closes_15m[-2]:
                return ("BUY", 0.85, "strategy_us30_pullback", sl_dist, tp_dist)
                
    if trend == "DOWN":
        if max(closes_15m[-5:]) > ema21_15m - atr*0.5 and curr_c < ema21_15m:
            local_high = max([ (c['highPrice']['bid'] + c['highPrice']['ask'])/2 for c in candles_15m[-10:] ])
            sl_dist = local_high - curr_c + 10
            if sl_dist < atr * 0.5: sl_dist = atr * 0.5
            tp_dist = sl_dist * 2.0
            if curr_c < closes_15m[-2]:
                return ("SELL", 0.85, "strategy_us30_pullback", sl_dist, tp_dist)
                
    return ("NONE", 0, "strategy_us30_pullback", 0, 0)


def run_all_strategies(candles_4h, candles_1h, candles_15m, closes_4h, closes_1h, closes_15m, atr_15m, regime):
    """Run all enabled strategies, return list of signals."""
    signals = []

    # Map regime to preferred strategy categories
    regime_pref = {
        "TRENDING_UP": ["trend_", "breakout_"],
        "TRENDING_DOWN": ["trend_", "breakout_"],
        "RANGING": ["reversion_"],
        "BREAKOUT": ["breakout_"],
        "VOLATILE": [],  # Only very high confidence
    }

    # US30 特規處理
    global current_epic
    if current_epic == 'US30':
        all_results = [ strategy_us30_pullback(candles_15m, closes_1h, closes_15m, atr_15m) ]
    else:
        all_results = [
            strategy_trend_ema_cross(candles_1h, closes_1h, atr_15m),
            strategy_trend_mtf_alignment(candles_4h, candles_1h, candles_15m, closes_4h, closes_1h, closes_15m, atr_15m),
            strategy_trend_elliott_wave3(candles_15m, closes_15m, atr_15m),
            strategy_trend_flag_breakout(candles_15m, closes_15m, atr_15m),
            strategy_reversion_sr(candles_15m, closes_15m, atr_15m),
            strategy_reversion_rsi_divergence(candles_15m, closes_15m, atr_15m),
            strategy_reversion_bollinger(candles_15m, closes_15m, atr_15m),
            strategy_breakout_range(candles_15m, closes_15m, atr_15m),
            strategy_breakout_pattern(candles_15m, closes_15m, atr_15m),
            strategy_breakout_outside_bar(candles_15m, closes_15m, atr_15m),
            strategy_breakout_bollinger_squeeze(candles_15m, closes_15m, atr_15m),
            strategy_reversion_pin_bar(candles_15m, closes_15m, atr_15m),
            strategy_asian_range_breakout(candles_15m, closes_15m, atr_15m),
            strategy_session_momentum(candles_1h, candles_15m, closes_15m, atr_15m),
            strategy_multi_indicator_consensus(candles_1h, candles_15m, closes_15m, closes_1h, atr_15m),
            strategy_atr_breakout(candles_15m, closes_15m, atr_15m)
        ]

    preferred = regime_pref.get(regime, [])

    for direction, confidence, name, sl, tp in all_results:
        if direction == "NONE" or confidence < 0.60:
            continue

        # Boost confidence for regime-appropriate strategies
        is_preferred = any(name.startswith(p) for p in preferred)
        if is_preferred:
            confidence = min(1.0, confidence + 0.05)
        elif regime == "VOLATILE" and confidence < 0.80:
            continue  # Skip low-confidence in volatile markets

        # Enforce minimum 1.5:1 risk-reward
        if tp < sl * 1.5:
            tp = sl * 2.0

        signals.append((direction, confidence, name, sl, tp))

    return signals


# ========== RISK MANAGEMENT ==========

def check_risk_controls(state, trade_log, epic, direction, open_positions):
    """
    Returns (allowed: bool, reason: str, size_multiplier: float)
    """
    now_utc = datetime.now(timezone.utc)

    # 1. UTC 22:00-00:00 no new trades
    if now_utc.hour >= 22:
        return False, "UTC 22:00-00:00 禁止開新倉", 1.0

    # 2. Friday UTC 19:00+ no new trades
    if now_utc.weekday() == 4 and now_utc.hour >= 19:
        return False, "週五 UTC 19:00 後不開新倉", 1.0

    # 3. Hard block banned instruments
    if epic in BANNED_INSTRUMENTS:
        return False, f"{epic} 已列入黑名單", 1.0

    # 4. Block worst loss window around US open
    if now_utc.hour == 13 and now_utc.minute < 30:
        return False, "UTC 13:00-13:30 禁止開新倉", 1.0

    # 5. Consecutive loss controls
    consec_losses = state.get('consecutive_losses', 0)
    size_mult = 1.0
    last_loss_at = state.get('last_loss_time', '')
    if consec_losses >= 3:
        if last_loss_at:
            try:
                last_dt = datetime.fromisoformat(last_loss_at.replace('Z', '+00:00'))
                if now_utc - last_dt < timedelta(minutes=30):
                    return False, "3連敗後冷卻30分鐘", 1.0
            except:
                return False, "3連敗後冷卻30分鐘", 1.0
        else:
            return False, "3連敗後冷卻30分鐘", 1.0
    elif consec_losses >= 2:
        size_mult = 0.5

    # 6. Correlated instrument limit (US indices same direction max 2)
    for group_name, group_epics in CORRELATED_GROUPS.items():
        if epic in group_epics:
            same_dir_count = 0
            for p in open_positions:
                pos_epic = p['position'].get('epic', p['market'].get('epic', ''))
                pos_dir = p['position']['direction']
                if pos_epic in group_epics and pos_dir == direction:
                    same_dir_count += 1
            if same_dir_count >= 2:
                return False, f"相關商品 {group_name} 同方向已達 2 個", size_mult

    # 7. Max 1 position per instrument
    for p in open_positions:
        pos_epic = p['position'].get('epic', p['market'].get('epic', ''))
        if pos_epic == epic:
            return False, f"已持有 {epic}", size_mult

    return True, "OK", size_mult


# ========== P/L RECOVERY ==========

def recover_broker_closed_pnl(api_url, cst, xsec, trade_entry):
    """
    Query Capital.com transactions API to get actual P/L for broker-closed trades.
    Uses multiple matching strategies: dealId, epic, instrumentName, direction + time.
    """
    try:
        close_time_str = trade_entry.get('close_time', '')
        open_time_str = trade_entry.get('time', '')
        
        if not close_time_str and not open_time_str:
            return 0

        # Determine search window (wider: 2 hours each side)
        try:
            ct = datetime.fromisoformat((close_time_str or open_time_str).replace('Z', '+00:00'))
            from_time = (ct - timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%S')
            to_time = (ct + timedelta(hours=2)).strftime('%Y-%m-%dT%H:%M:%S')
        except:
            return 0

        headers = {"X-SECURITY-TOKEN": xsec, "CST": cst, "Content-Type": "application/json"}

        # Fetch transactions in window
        tx_url = f"{api_url}/api/v1/history/transactions?from={from_time}&to={to_time}&type=TRADE"
        resp = requests.get(tx_url, headers=headers, timeout=15)

        if resp.status_code != 200:
            return 0

        transactions = resp.json().get('transactions', [])
        closes = [tx for tx in transactions if tx.get('note') == 'Trade closed']
        
        epic = trade_entry.get('instrument', '')       # e.g. GOLD, US30
        inst_name = trade_entry.get('instrumentName', '')  # e.g. XAUUSD, S&P 500
        trade_deal_id = trade_entry.get('dealId', '')
        direction = trade_entry.get('direction', '')
        
        # Epic → possible API instrumentName mappings
        EPIC_TO_NAMES = {
            'GOLD': ['Gold', 'GOLD', 'XAUUSD', 'gold'],
            'US30': ['Wall Street', 'US Wall Street 30', 'US30', 'Dow Jones'],
            'US500': ['US 500', 'US500', 'S&P 500', 'SPX500'],
            'US100': ['US Tech 100', 'US100', 'NAS100', 'Nasdaq'],
            'EURUSDM2026': ['EUR/USD', 'EURUSD'],
            'GBPUSD': ['GBP/USD', 'GBPUSD'],
            'USDJPYM2026': ['USD/JPY', 'USDJPY'],
        }
        
        possible_names = EPIC_TO_NAMES.get(epic, [epic, inst_name])
        if inst_name and inst_name not in possible_names:
            possible_names.append(inst_name)
        
        close_time = None
        if close_time_str:
            try:
                close_time = datetime.fromisoformat(close_time_str.replace('Z', '+00:00'))
            except:
                pass
        
        # Strategy 1: Match by dealId (check reference field)
        if trade_deal_id:
            for tx in closes:
                ref = tx.get('reference', '')
                if trade_deal_id in ref or ref in trade_deal_id:
                    pnl = float(tx.get('cashTransaction', tx.get('size', '0')))
                    if pnl != 0:
                        return pnl
        
        # Strategy 2: Match by instrument name (flexible) + direction + time proximity
        best_pnl = None
        best_diff = timedelta(hours=999)
        
        for tx in closes:
            tx_inst = tx.get('instrumentName', '')
            # Check if this transaction matches our instrument
            match = any(name.lower() in tx_inst.lower() or tx_inst.lower() in name.lower() 
                       for name in possible_names if name)
            if not match:
                continue
            
            try:
                tx_time = datetime.fromisoformat(tx.get('dateUtc', '').replace('Z', '+00:00'))
            except:
                continue
            
            if close_time:
                diff = abs(tx_time - close_time)
                if diff < best_diff and diff < timedelta(minutes=60):
                    best_diff = diff
                    # Capital.com: P/L can be in 'cashTransaction' or computed from 'size'
                    pnl = float(tx.get('cashTransaction', tx.get('size', '0')))
                    if pnl != 0:
                        best_pnl = pnl
        
        if best_pnl is not None:
            return best_pnl

    except Exception as e:
        print(f"P/L recovery error: {e}", file=sys.stderr)

    return 0  # Default to 0 rather than None - NEVER leave as null


# ========== ORDER EXECUTION ==========

def place_order(api_url, cst, xsec, epic, direction, size, stop_dist, profit_dist):
    headers = {"X-SECURITY-TOKEN": xsec, "CST": cst, "Content-Type": "application/json"}
    stop_dist = max(1, min(500, round(stop_dist, 1)))
    profit_dist = max(2, min(1000, round(profit_dist, 1)))
    payload = {
        "epic": epic, "direction": direction, "size": size,
        "guaranteedStop": False, "stopDistance": stop_dist, "profitDistance": profit_dist
    }
    try:
        resp = requests.post(f"{api_url}/api/v1/positions", headers=headers, json=payload, timeout=10)
        return resp.json(), stop_dist, profit_dist
    except Exception as e:
        return {"error": str(e)}, stop_dist, profit_dist


def close_position(api_url, cst, xsec, deal_id):
    headers = {"X-SECURITY-TOKEN": xsec, "CST": cst, "Content-Type": "application/json"}
    try:
        resp = requests.delete(f"{api_url}/api/v1/positions/{deal_id}", headers=headers)
        return resp.status_code, resp.text
    except:
        return 500, "error"


# ========== STATISTICS ==========

def compute_statistics(trade_log, balance, account_data):
    """Compute all enhanced statistics for dashboard."""
    closed = [t for t in trade_log if t.get('outcome') in ('WIN', 'LOSS')]
    wins = [t for t in closed if t['outcome'] == 'WIN']
    losses_list = [t for t in closed if t['outcome'] == 'LOSS']
    open_trades = [t for t in trade_log if t.get('outcome') == 'OPEN']

    n_wins = len(wins)
    n_losses = len(losses_list)
    total_closed = n_wins + n_losses

    # Basic
    win_rate = f"{n_wins / total_closed * 100:.1f}%" if total_closed > 0 else "--"
    total_pnl = sum(t.get('pnl', 0) or 0 for t in closed)

    # avgWin / avgLoss
    win_pnls = [t.get('pnl', 0) or 0 for t in wins]
    loss_pnls = [t.get('pnl', 0) or 0 for t in losses_list]
    avg_win = sum(win_pnls) / len(win_pnls) if win_pnls else 0
    avg_loss = sum(loss_pnls) / len(loss_pnls) if loss_pnls else 0
    risk_reward = round(abs(avg_win / avg_loss), 2) if avg_loss != 0 else 0

    # maxSingleWin / maxSingleLoss
    max_single_win = max(win_pnls) if win_pnls else 0
    max_single_loss = min(loss_pnls) if loss_pnls else 0

    # maxConsecutiveWins / maxConsecutiveLosses
    max_consec_wins = 0
    max_consec_losses = 0
    curr_wins = 0
    curr_losses = 0
    for t in closed:
        if t['outcome'] == 'WIN':
            curr_wins += 1
            curr_losses = 0
            max_consec_wins = max(max_consec_wins, curr_wins)
        else:
            curr_losses += 1
            curr_wins = 0
            max_consec_losses = max(max_consec_losses, curr_losses)

    # todayPnl / weekPnl
    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    week_start = today_start - timedelta(days=today_start.weekday())

    today_pnl = 0
    week_pnl = 0
    for t in closed:
        try:
            tt = datetime.fromisoformat(t.get('close_time', t.get('time', '')).replace('Z', '+00:00'))
            pnl = t.get('pnl', 0) or 0
            if tt >= today_start:
                today_pnl += pnl
            if tt >= week_start:
                week_pnl += pnl
        except:
            pass

    # Unrealized PnL (will be computed from open positions later)
    unrealized = 0

    # Net equity
    net_equity = balance + unrealized

    # Margin usage (from account data)
    margin_pct = "0%"
    for acc in account_data.get('accounts', []):
        if acc.get('preferred'):
            deposit = acc.get('balance', {}).get('deposit', 0)
            equity_val = acc.get('balance', {}).get('balance', balance)
            if equity_val > 0 and deposit > 0:
                margin_pct = f"{deposit / equity_val * 100:.1f}%"
            break

    return {
        "balance": balance,
        "realizedPnl": round(total_pnl, 2),
        "unrealizedPnl": 0,  # Updated later with actual positions
        "netEquity": round(net_equity, 2),
        "todayPnl": round(today_pnl, 2),
        "weekPnl": round(week_pnl, 2),
        "totalTrades": len(trade_log),
        "closedTrades": total_closed,
        "openCount": len(open_trades),
        "wins": n_wins,
        "losses": n_losses,
        "winRate": win_rate,
        "avgWin": round(avg_win, 2),
        "avgLoss": round(avg_loss, 2),
        "riskRewardRatio": risk_reward,
        "maxConsecutiveWins": max_consec_wins,
        "maxConsecutiveLosses": max_consec_losses,
        "maxSingleWin": round(max_single_win, 2),
        "maxSingleLoss": round(max_single_loss, 2),
        "marginUsagePercent": margin_pct,
    }


def compute_strategy_stats(trade_log):
    """Compute per-strategy statistics with ranking."""
    closed = [t for t in trade_log if t.get('outcome') in ('WIN', 'LOSS')]
    stats = {}
    for t in closed:
        s = t.get('strategy', '?')
        if s not in stats:
            stats[s] = {"wins": 0, "losses": 0, "pnl": 0, "win_pnls": [], "loss_pnls": []}
        pnl = t.get('pnl', 0) or 0
        if t['outcome'] == 'WIN':
            stats[s]['wins'] += 1
            stats[s]['win_pnls'].append(pnl)
        else:
            stats[s]['losses'] += 1
            stats[s]['loss_pnls'].append(pnl)
        stats[s]['pnl'] += pnl

    # Compute derived fields and rank
    result = {}
    for name, s in stats.items():
        total = s['wins'] + s['losses']
        win_rate = f"{s['wins'] / total * 100:.1f}%" if total > 0 else "--"
        avg_w = sum(s['win_pnls']) / len(s['win_pnls']) if s['win_pnls'] else 0
        avg_l = sum(s['loss_pnls']) / len(s['loss_pnls']) if s['loss_pnls'] else 0
        rr = round(abs(avg_w / avg_l), 2) if avg_l != 0 else 0
        result[name] = {
            "wins": s['wins'],
            "losses": s['losses'],
            "pnl": round(s['pnl'], 2),
            "winRate": win_rate,
            "riskReward": rr,
            "rank": 0,  # Will be set after sorting
        }

    # Rank by PnL
    sorted_names = sorted(result.keys(), key=lambda k: result[k]['pnl'], reverse=True)
    for i, name in enumerate(sorted_names):
        result[name]['rank'] = i + 1

    return result


# ========== DASHBOARD & REVIEW ==========

def generate_dashboard(report, trade_log, state, positions, all_indicators, account_data):
    # Open positions
    open_pos = []
    for p in positions.get('positions', []):
        pos = p['position']
        mkt = p['market']
        entry = pos['level']
        direction = pos['direction']
        if direction == 'BUY':
            pnl = (mkt['bid'] - entry) * pos['size'] * 100
        else:
            pnl = (entry - mkt['offer']) * pos['size'] * 100
        open_pos.append({
            "dealId": pos['dealId'], "direction": direction,
            "size": pos['size'], "entryPrice": entry,
            "stopLevel": pos.get('stopLevel'), "profitLevel": pos.get('profitLevel'),
            "currentBid": mkt['bid'], "currentAsk": mkt['offer'],
            "pnl": round(pnl, 2), "instrument": mkt.get('instrumentName', 'Unknown'),
            "epic": mkt.get('epic', pos.get('epic', '')),
            "createdDate": pos.get('createdDate', ''),
        })

    # Statistics
    balance = report.get('balance', state.get('last_balance', 31000))
    acct_stats = compute_statistics(trade_log, balance, account_data)

    # Update unrealized from actual positions
    total_unrealized = round(sum(p['pnl'] for p in open_pos), 2)
    acct_stats['unrealizedPnl'] = total_unrealized
    acct_stats['netEquity'] = round(balance + total_unrealized, 2)
    acct_stats['openCount'] = len(open_pos)

    # Strategy stats
    strategy_stats = compute_strategy_stats(trade_log)

    # Closed trades (last 20)
    closed = [t for t in trade_log if t.get('outcome') in ('WIN', 'LOSS')]
    closed_recent = closed[-20:] if len(closed) > 20 else closed

    # Review / Self-optimization
    review = build_review(trade_log, strategy_stats, acct_stats)

    # Risk params
    risk_params = {
        "maxSingleLoss": "2% of balance",
        "maxPositions": 4,
        "consecutiveLossPause": 5,
        "slMethod": "ATR x 1.2",
        "minRiskReward": "1.5:1",
        "sessionRestrictions": "No trades UTC 22-00",
        "mode": state.get('mode', 'simulation'),
        "consecutiveLosses": state.get('consecutive_losses', 0),
        "sizeReduction": "50% after 3 consecutive losses",
    }

    # Alerts
    alerts = report.get('alerts', [])
    # Testing phase: consecutive loss alerts disabled (no pause, no size reduction)
    # TODO: Re-enable when switching to live trading

    return {
        "lastUpdate": datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S"),
        "account": acct_stats,
        "instruments": list(INSTRUMENTS.keys()),
        "openPositions": open_pos,
        "closedTrades": closed_recent,
        "strategyStats": strategy_stats,
        "review": review,
        "riskParams": risk_params,
        "alerts": alerts,
        "currentPrice": report.get('prices', {}),
        "indicators": all_indicators,
        "actions": report.get('actions', []),
    }


def build_review(trade_log, strategy_stats, acct_stats):
    """Build review section for dashboard."""
    closed = [t for t in trade_log if t.get('outcome') in ('WIN', 'LOSS')]
    wins = acct_stats['wins']
    losses = acct_stats['losses']
    total_pnl = acct_stats['realizedPnl']
    win_rate = acct_stats['winRate']

    review = {
        "summary": "",
        "bestStrategy": None,
        "worstStrategy": None,
        "lessons": [],
        "optimization": [],
        "strategiesUnderTest": list(STRATEGY_ENABLED.keys()),
        "recentChanges": [
            "v6: 12 modular strategies",
            "v6: P/L recovery for broker-closed trades",
            "v6: Enhanced risk controls (consecutive loss pause)",
            "v6: Correlated instrument limits",
        ],
        "nextSteps": [
            "累積 20+ 筆交易數據後進行回測",
            "根據策略排名停用低效策略",
            "調整 ATR 倍數與 RR 門檻",
        ],
    }

    if closed:
        review["summary"] = f"{wins}勝/{losses}敗，勝率 {win_rate}，累計盈虧 ${round(total_pnl, 2)}"

        # Best/worst strategy
        if strategy_stats:
            sorted_strats = sorted(strategy_stats.items(), key=lambda x: x[1]['pnl'], reverse=True)
            if sorted_strats:
                best_name, best = sorted_strats[0]
                review["bestStrategy"] = {"name": best_name, **best}
            if len(sorted_strats) > 1:
                worst_name, worst = sorted_strats[-1]
                review["worstStrategy"] = {"name": worst_name, **worst}

        # Time-based lessons
        hour_pnl = {}
        for t in closed:
            try:
                h = datetime.fromisoformat(t.get('close_time', t.get('time', '')).replace('Z', '+00:00')).hour
                hour_pnl.setdefault(h, 0)
                hour_pnl[h] += t.get('pnl', 0) or 0
            except:
                pass
        if hour_pnl:
            best_h = max(hour_pnl, key=hour_pnl.get)
            worst_h = min(hour_pnl, key=hour_pnl.get)
            review["lessons"].append(f"最佳交易時段 UTC {best_h}:00（PnL ${round(hour_pnl[best_h], 2)}）")
            review["lessons"].append(f"最差交易時段 UTC {worst_h}:00（PnL ${round(hour_pnl[worst_h], 2)}）")

        # Optimization suggestions
        for s, st in strategy_stats.items():
            total = st['wins'] + st['losses']
            if total >= 5:
                wr_num = st['wins'] / total if total > 0 else 0
                if wr_num < 0.25:
                    review["optimization"].append(
                        f"考慮停用 {s}（勝率 {wr_num * 100:.0f}%，PnL ${st['pnl']}）"
                    )

    return review


def _save(report, trade_log, state, positions, args, all_indicators, account_data):
    with open(args.state, 'w') as f:
        json.dump(state, f, indent=2)
    with open(args.trade_log, 'w') as f:
        json.dump(trade_log, f, indent=2)

    rp = os.path.dirname(args.state) + '/last_report.json'
    with open(rp, 'w') as f:
        json.dump(report, f, indent=2)

    dashboard = generate_dashboard(report, trade_log, state, positions, all_indicators, account_data)
    dp = os.path.dirname(args.state) + '/dashboard_data.json'
    with open(dp, 'w') as f:
        json.dump(dashboard, f, indent=2)

    # 寫到員工自己的 dashboard.json（由 sync_dashboards.sh 同步到 boss-dashboard）
    worker_dash = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'dashboard.json')
    try:
        with open(worker_dash, 'w') as f:
            json.dump(dashboard, f, indent=2)
    except Exception as e:
        print(f'⚠️ dashboard.json 寫入失敗: {e}')

    print(json.dumps(report, indent=2))


# ========== MAIN ==========

def main():
    args = parse_args()

    positions = json.loads(args.positions)
    account = json.loads(args.account)
    market_data = json.loads(args.market_data)

    with open(args.state) as f:
        state = json.load(f)

    if os.path.exists(args.trade_log):
        with open(args.trade_log) as f:
            trade_log = json.load(f)
    else:
        trade_log = []

    # Real balance via API
    balance = state.get('last_balance', 31000)
    for acc in account.get('accounts', []):
        if acc.get('preferred'):
            new_balance = acc['balance']['balance']
            if new_balance != balance:
                print(f"帳戶餘額更新: {balance} -> {new_balance}")
            balance = new_balance
    state['last_balance'] = balance

    # Drawdown check
    initial_balance = state.get('initial_balance', 31000)
    if 'initial_balance' not in state:
        state['initial_balance'] = initial_balance

    stop_trading = False
    if (initial_balance - balance) / initial_balance >= 0.03:
        print("警告：虧損回撤超過 3%，今日停止交易")
        stop_trading = True

    report = {
        "time": datetime.now(timezone.utc).isoformat(),
        "balance": balance,
        "prices": {},
        "actions": [],
        "alerts": [],
    }

    all_indicators = {}
    all_signals = []

    # ===== SYNC: Detect broker-closed positions & recover P/L =====
    open_positions_broker = positions.get('positions', [])

    broker_deal_ids = set()
    for p in open_positions_broker:
        broker_deal_ids.add(p['position']['dealId'])

    # Count broker positions per instrument+direction
    broker_counts = {}
    for p in open_positions_broker:
        epic = p['market'].get('epic', p['position'].get('epic', ''))
        d = p['position']['direction']
        key = f"{epic}_{d}"
        broker_counts[key] = broker_counts.get(key, 0) + 1

    # Build broker positions list for entry price matching (by epic+direction+time)
    broker_positions_list = []
    for p in open_positions_broker:
        pos = p['position']
        mkt = p['market']
        broker_positions_list.append({
            'epic': mkt.get('epic', pos.get('epic', '')),
            'direction': pos['direction'],
            'level': pos.get('level'),
            'dealId': pos['dealId'],
            'createdDate': pos.get('createdDate', ''),
            'matched': False,
        })

    # Count log open per instrument+direction
    log_open_counts = {}
    log_open_trades = []
    for t in trade_log:
        if t.get('outcome') == 'OPEN':
            # Backfill entry price from broker by matching epic+direction
            if not t.get('entryPrice'):
                epic = t.get('instrument', '')
                direction = t.get('direction', '')
                for bp in broker_positions_list:
                    if not bp['matched'] and bp['epic'] == epic and bp['direction'] == direction and bp['level']:
                        t['entryPrice'] = bp['level']
                        t['brokerDealId'] = bp['dealId']
                        bp['matched'] = True
                        break
            key = f"{t.get('instrument', '?')}_{t.get('direction', '?')}"
            log_open_counts[key] = log_open_counts.get(key, 0) + 1
            log_open_trades.append((key, t))

    # Find trades closed by broker
    close_needed = {}
    for key, count in log_open_counts.items():
        broker_n = broker_counts.get(key, 0)
        if count > broker_n:
            close_needed[key] = count - broker_n

    # Build current market prices from broker data for pnl calculation
    market_prices = {}
    for p in open_positions_broker:
        mkt = p['market']
        epic = mkt.get('epic', p['position'].get('epic', ''))
        if epic:
            market_prices[epic] = {'bid': mkt.get('bid', 0), 'offer': mkt.get('offer', 0)}
    # Also add from report prices
    for epic, prices in report.get('prices', {}).items():
        if epic not in market_prices and prices.get('bid'):
            market_prices[epic] = {'bid': prices['bid'], 'offer': prices.get('ask', prices['bid'])}

    for key, t in log_open_trades:
        if close_needed.get(key, 0) > 0:
            epic = t.get('instrument', '')
            direction = t.get('direction', '')
            size = t.get('size', 0) or 0
            entry = t.get('entryPrice')
            mkt = market_prices.get(epic, {})

            # Calculate pnl from entry price and current market price
            pnl = None
            if entry and mkt and size:
                if direction == 'BUY':
                    exit_price = mkt.get('bid', 0)
                    pnl = round((exit_price - entry) * size, 2)
                elif direction == 'SELL':
                    exit_price = mkt.get('offer', 0)
                    pnl = round((entry - exit_price) * size, 2)

            # Fallback: sl_distance × size (if no entry price recorded)
            if pnl is None:
                sl = t.get('sl_distance', 0) or 0
                if sl > 0 and size > 0:
                    pnl = round(-sl * size, 2)  # Assume SL hit (most common broker close)

            t['outcome'] = 'WIN' if (pnl and pnl > 0) else 'LOSS'
            t['pnl'] = pnl if pnl is not None else 0
            t['pnl_source'] = 'calculated_from_market' if entry else 'estimated_SL'
            t['close_time'] = datetime.now(timezone.utc).isoformat()
            t['close_reason'] = 'SL/TP_BY_BROKER'
            close_needed[key] -= 1
            report['actions'].append(f"SYNC_CLOSE: {epic} {direction} PnL=${t['pnl']} ({t['pnl_source']})")

    # Also fix any historical null pnl entries
    for t in trade_log:
        if t.get('pnl') is None and t.get('outcome') in ('WIN', 'LOSS'):
            t['pnl'] = 0  # Absolute fallback - NEVER leave as null

    # Update consecutive loss tracking
    recent_outcomes = [t['outcome'] for t in trade_log if t.get('outcome') in ('WIN', 'LOSS')]
    consec_losses = 0
    for outcome in reversed(recent_outcomes):
        if outcome == 'LOSS':
            consec_losses += 1
        else:
            break
    state['consecutive_losses'] = consec_losses
    if consec_losses > 0 and recent_outcomes and recent_outcomes[-1] == 'LOSS':
        state['last_loss_time'] = datetime.now(timezone.utc).isoformat()

    # ===== MARKET ANALYSIS =====
    for epic, info in INSTRUMENTS.items():
        if epic in BANNED_INSTRUMENTS:
            continue

        idata = market_data.get(epic, {})
        if not idata or idata.get('status') != 'TRADEABLE':
            continue
        if not is_active_session(epic):
            continue

        c4h = idata.get('candles_4h', {}).get('prices', [])
        c1h = idata.get('candles_1h', {}).get('prices', [])
        c15m = idata.get('candles_15m', {}).get('prices', [])
        c5m = idata.get('candles_5m', {}).get('prices', [])

        if not c1h or not c15m or not c4h:
            continue

        closes_4h = get_closes(c4h)
        closes_1h = get_closes(c1h)
        closes_15m = get_closes(c15m)

        atr_15m = calc_atr(c15m)
        atr_1h = calc_atr(c1h)
        rsi_15m = calc_rsi(closes_15m)
        macd_l, macd_s, macd_h = calc_macd(closes_15m)
        bb_mid, bb_up, bb_low = calc_bollinger(closes_15m)

        # Market regime
        regime = classify_market_regime(closes_4h, closes_1h, c1h)

        # Run all strategies
        signals = run_all_strategies(c4h, c1h, c15m, closes_4h, closes_1h, closes_15m, atr_15m, regime)

        for direction, confidence, strategy_name, sl, tp in signals:
            all_signals.append((epic, strategy_name, direction, confidence, sl, tp))

        # Compute trend for 1H and 15M for dashboard display
        def _trend_label(closes):
            if len(closes) < 50:
                return "RANGING"
            e9 = calc_ema(closes, 9)
            e21 = calc_ema(closes, 21)
            e50 = calc_ema(closes, 50)
            if e9 > e21 > e50:
                return "BULL"
            elif e9 < e21 < e50:
                return "BEAR"
            elif e9 > e21:
                return "WEAK_BULL"
            elif e9 < e21:
                return "WEAK_BEAR"
            return "RANGING"

        all_indicators[epic] = {
            "name": info['name'],
            "regime": regime,
            "trend_1h": _trend_label(closes_1h),
            "trend_15m": _trend_label(closes_15m),
            "bid": idata.get('bid', 0),
            "rsi": round(rsi_15m, 1),
            "macd_hist": round(macd_h, 4),
            "atr": round(atr_15m, 4),
            "bb_width": round(calc_bollinger_width(closes_15m), 4),
            "ema9": round(calc_ema(closes_15m, 9), 4),
            "ema21": round(calc_ema(closes_15m, 21), 4),
        }
        report['prices'][epic] = {"bid": idata.get('bid', 0), "ask": idata.get('ask', 0)}

    # ===== POSITION MANAGEMENT =====
    for p in open_positions_broker:
        pos = p['position']
        mkt = p['market']
        deal_id = pos['dealId']
        epic = pos.get('epic', mkt.get('epic', 'GOLD'))

        create_time = pos.get('createdDate')
        if create_time:
            try:
                ct = datetime.fromisoformat(create_time.replace('Z', '+00:00'))
                hold_hours = (datetime.now(timezone.utc) - ct).total_seconds() / 3600
                entry = pos['level']
                direction = pos['direction']
                is_profit = (mkt['bid'] > entry) if direction == 'BUY' else (entry > mkt['offer'])

                if hold_hours > 8 and not is_profit:
                    status, _ = close_position(args.api_url, args.cst, args.xsec, deal_id)
                    if status == 200:
                        report['actions'].append(f"TIMEOUT_CLOSE: {epic} (held {hold_hours:.1f}h, losing)")
            except:
                pass

    # ===== ORDER EXECUTION =====
    if not stop_trading:
        for epic, strategy_name, direction, confidence, sl, tp in sorted(all_signals, key=lambda x: x[3], reverse=True):
            # Risk check
            allowed, reason, size_mult = check_risk_controls(
                state, trade_log, epic, direction, open_positions_broker
            )
            if not allowed:
                report['actions'].append(f"BLOCKED: {epic} {direction} — {reason}")
                continue

            inst_config = INSTRUMENTS.get(epic, {"min_size": 0.01, "max_size": 0.1})
            size = inst_config['min_size']

            # Apply size reduction for consecutive losses
            if size_mult < 1.0:
                size = max(inst_config['min_size'], round(size * size_mult, 2))

            # Ensure minimum 1.5:1 R:R
            if tp < sl * 1.5:
                tp = sl * 2.0

            res, actual_sl, actual_tp = place_order(args.api_url, args.cst, args.xsec, epic, direction, size, sl, tp)
            if 'dealReference' in res:
                # Get dealId AND entry price from confirms endpoint
                deal_id = None
                entry_price = None
                try:
                    h = {"X-SECURITY-TOKEN": args.xsec, "CST": args.cst}
                    cr = requests.get(f"{args.api_url}/api/v1/confirms/{res['dealReference']}", headers=h, timeout=10)
                    if cr.status_code == 200:
                        confirm_data = cr.json()
                        deal_id = confirm_data.get('dealId')
                        entry_price = confirm_data.get('level')
                except:
                    pass
                trade_log.append({
                    "time": datetime.now(timezone.utc).isoformat(),
                    "instrument": epic,
                    "instrumentName": INSTRUMENTS[epic]['name'],
                    "strategy": strategy_name,
                    "direction": direction,
                    "confidence": round(confidence, 2),
                    "size": size,
                    "entryPrice": entry_price,
                    "sl_distance": actual_sl,
                    "tp_distance": actual_tp,
                    "outcome": "OPEN",
                    "pnl": None,
                    "result": {"dealReference": res['dealReference']},
                    "dealId": deal_id,
                })
                report['actions'].append(f"OPENED {direction} {epic} [{strategy_name}] Conf:{confidence:.2f} SL:{actual_sl} TP:{actual_tp}")

    _save(report, trade_log, state, positions, args, all_indicators, account)


if __name__ == '__main__':
    main()
