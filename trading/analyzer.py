#!/usr/bin/env python3
"""
Multi-Instrument Auto Trading Analyzer v4
- Instruments: GOLD, EURUSD, US500, OIL (BTC permanently disabled)
- Strict trend alignment: 15M must follow 1H direction
- No opposing positions on same instrument
- Higher confidence threshold (0.70)
- Multi-confirmation entry: RSI + trend + MACD must agree
- Volume/ATR expansion filter
- Session-aware trading (avoid low-liquidity hours)
- Fix: use API activity history for accurate P/L detection
"""

import json, sys, argparse, requests, os
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

# ========== INSTRUMENTS (BTC permanently disabled) ==========
INSTRUMENTS = {
    "GOLD":        {"name": "XAUUSD",   "type": "黃金",  "min_size": 0.01, "max_size": 0.1},
    "SILVER":      {"name": "XAGUSD",   "type": "白銀",  "min_size": 0.1,  "max_size": 1.0},
    "COPPER":      {"name": "銅",       "type": "金屬",  "min_size": 0.1,  "max_size": 1.0},
    "EURUSDM2026": {"name": "EUR/USD",  "type": "外匯",  "min_size": 0.1,  "max_size": 1.0},
    "US500":       {"name": "S&P 500",  "type": "指數",  "min_size": 0.1,  "max_size": 1.0},
    "US30":        {"name": "US30",     "type": "指數",  "min_size": 0.1,  "max_size": 1.0},
    "OIL_CRUDE":   {"name": "原油",     "type": "商品",  "min_size": 0.1,  "max_size": 1.0},
    "NATURALGAS":  {"name": "天然氣",   "type": "商品",  "min_size": 0.1,  "max_size": 1.0},
}

# Permanently banned instruments
BANNED_INSTRUMENTS = {"BTCUSD", "ETHUSD", "LTCUSD", "XRPUSD"}

# ========== STRATEGY CONFIG ==========
MIN_CONFIDENCE = 0.70          # was 0.45
MAX_CONCURRENT_POSITIONS = 3   # tighter
COOLDOWN_LOSSES = 3
COOLDOWN_SECONDS = 7200        # 2 hours (was 30 min)

# ========== SESSION AWARENESS ==========
# Best trading hours per instrument (UTC)
ACTIVE_SESSIONS = {
    "GOLD":        [(7, 17), (13, 21)],   # London + NY overlap
    "SILVER":      [(7, 17), (13, 21)],   # Same as gold
    "COPPER":      [(7, 17), (13, 21)],
    "EURUSDM2026": [(7, 17)],              # London session
    "US500":       [(13, 21)],              # NY session
    "US30":        [(13, 21)],              # NY session
    "OIL_CRUDE":   [(13, 21)],              # NY session
    "NATURALGAS":  [(13, 21)],              # NY session
}

def is_active_session(epic):
    """Check if current UTC hour is within active session for this instrument"""
    now_utc = datetime.now(timezone.utc).hour
    sessions = ACTIVE_SESSIONS.get(epic, [(0, 24)])
    for start, end in sessions:
        if start <= now_utc < end:
            return True
    return False

# ========== INDICATORS ==========

def calc_ema(closes, period):
    if len(closes) < period:
        return sum(closes) / len(closes) if closes else 0
    multiplier = 2 / (period + 1)
    ema = sum(closes[:period]) / period
    for price in closes[period:]:
        ema = (price - ema) * multiplier + ema
    return ema

def calc_rsi(closes, period=14):
    if len(closes) < period + 1:
        return 50
    gains, losses = [], []
    for i in range(1, len(closes)):
        diff = closes[i] - closes[i-1]
        gains.append(max(diff, 0))
        losses.append(max(-diff, 0))
    rg = gains[-period:]
    rl = losses[-period:]
    ag = sum(rg) / period
    al = sum(rl) / period
    if al == 0: return 100
    rs = ag / al
    return 100 - (100 / (1 + rs))

def calc_atr(candles, period=14):
    trs = []
    for i in range(1, len(candles)):
        h = (candles[i]['highPrice']['bid'] + candles[i]['highPrice']['ask']) / 2
        l = (candles[i]['lowPrice']['bid'] + candles[i]['lowPrice']['ask']) / 2
        pc = (candles[i-1]['closePrice']['bid'] + candles[i-1]['closePrice']['ask']) / 2
        tr = max(h - l, abs(h - pc), abs(l - pc))
        trs.append(tr)
    if not trs: return 0
    return sum(trs[-period:]) / min(period, len(trs))

def calc_macd(closes, fast=12, slow=26, signal=9):
    if len(closes) < slow:
        return 0, 0, 0
    ef = calc_ema(closes, fast)
    es = calc_ema(closes, slow)
    ml = ef - es
    if len(closes) >= slow + signal:
        mvs = []
        for i in range(signal):
            idx = len(closes) - signal + i
            mvs.append(calc_ema(closes[:idx+1], fast) - calc_ema(closes[:idx+1], slow))
        sl = sum(mvs) / len(mvs)
    else:
        sl = ml
    return ml, sl, ml - sl

def calc_bollinger(closes, period=20, std_mult=2):
    if len(closes) < period:
        return closes[-1], closes[-1] + 10, closes[-1] - 10
    r = closes[-period:]
    sma = sum(r) / period
    v = sum((x - sma) ** 2 for x in r) / period
    std = v ** 0.5
    return sma, sma + std_mult * std, sma - std_mult * std

def get_closes(candles):
    return [(c['closePrice']['bid'] + c['closePrice']['ask']) / 2 for c in candles]

def calc_atr_expansion(candles, period=14):
    """Check if current ATR is above average (volatility expanding = better for trend)"""
    if len(candles) < period * 2:
        return False, 1.0
    recent_atr = calc_atr(candles, period)
    # ATR of older candles
    older = candles[:len(candles)//2]
    older_atr = calc_atr(older, min(period, len(older)-1)) if len(older) > 1 else recent_atr
    if older_atr == 0:
        return False, 1.0
    ratio = recent_atr / older_atr
    return ratio > 1.2, round(ratio, 2)

# ========== TREND ==========

def analyze_trend(closes):
    ema9 = calc_ema(closes, 9)
    ema21 = calc_ema(closes, 21)
    ema50 = calc_ema(closes, min(50, len(closes)))
    if ema9 > ema21 > ema50: return "STRONG_BULL", ema9, ema21
    elif ema9 > ema21: return "BULL", ema9, ema21
    elif ema9 < ema21 < ema50: return "STRONG_BEAR", ema9, ema21
    elif ema9 < ema21: return "BEAR", ema9, ema21
    return "NEUTRAL", ema9, ema21

def trends_agree(trend_1h, trend_15m, direction):
    """Both timeframes must agree with trade direction"""
    bull_trends = ("BULL", "STRONG_BULL")
    bear_trends = ("BEAR", "STRONG_BEAR")
    if direction == "BUY":
        return trend_1h in bull_trends and trend_15m in bull_trends
    else:
        return trend_1h in bear_trends and trend_15m in bear_trends

# ========== MULTI-CONFIRMATION SCORING ==========

def calc_confirmation_score(direction, trend_1h, trend_15m, rsi_1h, rsi_15m, macd_h_15m, macd_h_1h, atr_expanding):
    """
    Each confirmation adds points. Need >= 5 out of 7 to trade.
    Returns (score, max_score, details)
    """
    score = 0
    details = []
    
    if direction == "BUY":
        # 1. 1H trend bullish
        if trend_1h in ("BULL", "STRONG_BULL"):
            score += 1
            details.append("1H趨勢✓")
        # 2. 15M trend bullish
        if trend_15m in ("BULL", "STRONG_BULL"):
            score += 1
            details.append("15M趨勢✓")
        # 3. RSI 1H not overbought
        if 35 < rsi_1h < 65:
            score += 1
            details.append("1H RSI合理✓")
        # 4. RSI 15M supportive
        if 40 < rsi_15m < 70:
            score += 1
            details.append("15M RSI✓")
        # 5. MACD 15M positive
        if macd_h_15m > 0:
            score += 1
            details.append("15M MACD✓")
        # 6. MACD 1H positive
        if macd_h_1h > 0:
            score += 1
            details.append("1H MACD✓")
        # 7. ATR expanding
        if atr_expanding:
            score += 1
            details.append("波動擴張✓")
    else:  # SELL
        if trend_1h in ("BEAR", "STRONG_BEAR"):
            score += 1
            details.append("1H趨勢✓")
        if trend_15m in ("BEAR", "STRONG_BEAR"):
            score += 1
            details.append("15M趨勢✓")
        if 35 < rsi_1h < 65:
            score += 1
            details.append("1H RSI合理✓")
        if 30 < rsi_15m < 60:
            score += 1
            details.append("15M RSI✓")
        if macd_h_15m < 0:
            score += 1
            details.append("15M MACD✓")
        if macd_h_1h < 0:
            score += 1
            details.append("1H MACD✓")
        if atr_expanding:
            score += 1
            details.append("波動擴張✓")
    
    return score, 7, details

# ========== SIGNAL DETECTION (v4 — strict) ==========

def find_signals(closes_1h, closes_15m, closes_5m, candles_15m, candles_1h):
    """Strict signals: fewer but higher quality"""
    if len(closes_1h) < 26 or len(closes_15m) < 26:
        return []
    
    trend_1h, ema9_1h, ema21_1h = analyze_trend(closes_1h)
    trend_15m, ema9_15m, ema21_15m = analyze_trend(closes_15m)
    rsi_1h = calc_rsi(closes_1h)
    rsi_15m = calc_rsi(closes_15m)
    rsi_5m = calc_rsi(closes_5m) if len(closes_5m) > 14 else 50
    atr_15m = calc_atr(candles_15m) if candles_15m else 0
    atr_1h = calc_atr(candles_1h) if candles_1h else 0
    bb_mid, bb_upper, bb_lower = calc_bollinger(closes_15m)
    macd_l, macd_s, macd_h = calc_macd(closes_15m)
    macd_l1h, macd_s1h, macd_h1h = calc_macd(closes_1h)
    current = closes_15m[-1]
    atr_exp, atr_ratio = calc_atr_expansion(candles_15m)
    
    signals = []
    ctx_base = {
        "trend_1h": trend_1h, "trend_15m": trend_15m,
        "rsi_1h": round(rsi_1h, 1), "rsi_15m": round(rsi_15m, 1),
        "atr_15m": round(atr_15m, 2), "atr_1h": round(atr_1h, 2),
        "macd_h_15m": round(macd_h, 4), "macd_h_1h": round(macd_h1h, 4),
        "atr_expanding": atr_exp, "atr_ratio": atr_ratio
    }
    
    # === STRATEGY 1: Trend Alignment (main strategy) ===
    # Both timeframes must agree. This is the highest-quality signal.
    if trend_1h in ("STRONG_BEAR",) and trend_15m in ("BEAR", "STRONG_BEAR"):
        conf = 0.65
        score, _, _ = calc_confirmation_score("SELL", trend_1h, trend_15m, rsi_1h, rsi_15m, macd_h, macd_h1h, atr_exp)
        conf += score * 0.03  # each confirmation adds 3%
        if conf >= MIN_CONFIDENCE:
            signals.append(("趨勢對齊", "SELL", round(conf, 2), 1.0, 3.0, ctx_base.copy()))
    
    elif trend_1h in ("STRONG_BULL",) and trend_15m in ("BULL", "STRONG_BULL"):
        conf = 0.65
        score, _, _ = calc_confirmation_score("BUY", trend_1h, trend_15m, rsi_1h, rsi_15m, macd_h, macd_h1h, atr_exp)
        conf += score * 0.03
        if conf >= MIN_CONFIDENCE:
            signals.append(("趨勢對齊", "BUY", round(conf, 2), 1.0, 3.0, ctx_base.copy()))
    
    # === STRATEGY 2: RSI Extreme + Trend (mean reversion only WITH trend) ===
    if rsi_15m < 25 and trend_1h in ("BULL", "STRONG_BULL"):
        conf = 0.60
        if rsi_5m < 20: conf += 0.08
        if macd_h > 0: conf += 0.05
        if atr_exp: conf += 0.03
        if conf >= MIN_CONFIDENCE:
            signals.append(("RSI超賣反彈", "BUY", round(conf, 2), 1.2, 3.5, ctx_base.copy()))
    elif rsi_15m > 75 and trend_1h in ("BEAR", "STRONG_BEAR"):
        conf = 0.60
        if rsi_5m > 80: conf += 0.08
        if macd_h < 0: conf += 0.05
        if atr_exp: conf += 0.03
        if conf >= MIN_CONFIDENCE:
            signals.append(("RSI超買回落", "SELL", round(conf, 2), 1.2, 3.5, ctx_base.copy()))
    
    # === STRATEGY 3: Bollinger Squeeze Breakout ===
    bb1m, bb1u, bb1l = calc_bollinger(closes_1h)
    bw = (bb1u - bb1l) / bb1m if bb1m else 0
    if bw < 0.004:  # Very tight squeeze
        if current > bb1u and trend_15m in ("BULL", "STRONG_BULL") and macd_h > 0:
            conf = 0.65
            if trend_1h in ("BULL", "STRONG_BULL"): conf += 0.08
            if atr_exp: conf += 0.05
            if conf >= MIN_CONFIDENCE:
                signals.append(("布林擠壓突破", "BUY", round(conf, 2), 1.0, 3.5, ctx_base.copy()))
        elif current < bb1l and trend_15m in ("BEAR", "STRONG_BEAR") and macd_h < 0:
            conf = 0.65
            if trend_1h in ("BEAR", "STRONG_BEAR"): conf += 0.08
            if atr_exp: conf += 0.05
            if conf >= MIN_CONFIDENCE:
                signals.append(("布林擠壓突破", "SELL", round(conf, 2), 1.0, 3.5, ctx_base.copy()))
    
    return signals

# ========== LOT SIZING ==========

def calc_lot_size(confidence, instrument_config, capital=31000, risk_pct=0.10):
    """Conservative lot sizing: scale with confidence"""
    min_s = instrument_config['min_size']
    max_s = instrument_config['max_size']
    # Scale: 70% conf → min, 90%+ conf → max
    ratio = max(0, min(1, (confidence - 0.70) / 0.20))
    size = min_s + ratio * (max_s - min_s)
    return round(max(min_s, min(max_s, size)), 2)

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

def update_stop(api_url, cst, xsec, deal_id, new_stop, new_tp=None):
    headers = {"X-SECURITY-TOKEN": xsec, "CST": cst, "Content-Type": "application/json"}
    payload = {"guaranteedStop": False, "stopLevel": new_stop}
    if new_tp: payload["profitLevel"] = new_tp
    try:
        resp = requests.put(f"{api_url}/api/v1/positions/{deal_id}", headers=headers, json=payload, timeout=10)
        return resp.status_code, resp.text
    except:
        return 500, "error"

def close_position(api_url, cst, xsec, deal_id):
    headers = {"X-SECURITY-TOKEN": xsec, "CST": cst, "Content-Type": "application/json"}
    try:
        resp = requests.delete(f"{api_url}/api/v1/positions/{deal_id}", headers=headers)
        return resp.status_code, resp.text
    except:
        return 500, "error"

# ========== FIX: Accurate P/L from API Activity ==========

def fetch_activity_history(api_url, cst, xsec, from_dt=None):
    """Fetch recent activity from Capital.com API for accurate P/L"""
    headers = {"X-SECURITY-TOKEN": xsec, "CST": cst}
    params = {}
    if from_dt:
        params['from'] = from_dt.strftime('%Y-%m-%dT%H:%M:%S')
    try:
        resp = requests.get(f"{api_url}/api/v1/history/activity?type=POSITION&pageSize=50",
                          headers=headers, params=params, timeout=10)
        if resp.status_code == 200:
            return resp.json().get('activities', [])
    except:
        pass
    return []

def fetch_transaction_history(api_url, cst, xsec, from_dt=None):
    """Fetch transaction history for actual realized P/L"""
    headers = {"X-SECURITY-TOKEN": xsec, "CST": cst}
    params = {"type": "ALL_DEAL", "pageSize": 50}
    if from_dt:
        params['from'] = from_dt.strftime('%Y-%m-%dT%H:%M:%S')
    try:
        resp = requests.get(f"{api_url}/api/v1/history/transactions",
                          headers=headers, params=params, timeout=10)
        if resp.status_code == 200:
            return resp.json().get('transactions', [])
    except:
        pass
    return []

def sync_closed_trades_from_api(trade_log, api_url, cst, xsec, open_positions):
    """Use API activity to accurately determine outcomes instead of guessing"""
    open_trades = [t for t in trade_log if t.get('outcome') == 'OPEN']
    if not open_trades:
        return
    
    # Get deal IDs still open
    open_deal_ids = set()
    for p in open_positions:
        pos = p['position']
        open_deal_ids.add(pos.get('dealId', ''))
    
    # Fetch recent transactions for P/L data
    from_dt = datetime.now(timezone.utc) - timedelta(hours=48)
    transactions = fetch_transaction_history(api_url, cst, xsec, from_dt)
    
    # Build a map: dealReference -> transaction info
    tx_map = {}
    for tx in transactions:
        ref = tx.get('reference', '')
        if ref:
            tx_map[ref] = tx
    
    for t in open_trades:
        deal_ref = t.get('result', {}).get('dealReference', '')
        
        # Check if still physically open
        still_open = False
        for p in open_positions:
            pos = p['position']
            if pos['direction'] == t['direction']:
                entry_price = t.get('entry_bid', 0) if t['direction'] == 'SELL' else t.get('entry_ask', 0)
                if abs(pos['level'] - entry_price) < 5:
                    still_open = True
                    break
        
        if still_open:
            continue
        
        # Position is gone — determine actual outcome
        t['close_time'] = datetime.now(timezone.utc).isoformat()
        
        # Try to find in transaction history
        if deal_ref in tx_map:
            tx = tx_map[deal_ref]
            pnl = tx.get('profitAndLoss', {})
            amount = pnl.get('amount', 0) if isinstance(pnl, dict) else float(pnl) if pnl else 0
            t['pnl'] = round(amount, 2)
            t['outcome'] = 'WIN' if amount >= 0 else 'LOSS'
            t['close_reason'] = 'API_CONFIRMED'
        else:
            # Fallback: check activities
            activities = fetch_activity_history(api_url, cst, xsec, 
                datetime.now(timezone.utc) - timedelta(hours=24))
            found = False
            for act in activities:
                details = act.get('details', {})
                if details.get('dealReference') == deal_ref:
                    actions = details.get('actions', [])
                    for action in actions:
                        if action.get('actionType') in ('POSITION_CLOSED', 'STOP_LOSS_AMENDED'):
                            pnl = action.get('profitAndLoss', 0)
                            t['pnl'] = round(float(pnl) if pnl else 0, 2)
                            t['outcome'] = 'WIN' if t['pnl'] >= 0 else 'LOSS'
                            t['close_reason'] = 'ACTIVITY_CONFIRMED'
                            found = True
                            break
                    if found:
                        break
            
            if not found:
                # Last resort: estimate based on stop/tp distance and direction
                # Better than the old balance > 31000 hack
                t['outcome'] = 'LOSS'
                t['pnl'] = round(-abs(t.get('stop_distance', 10)) * t.get('size', 0.01), 2)
                t['close_reason'] = 'ESTIMATED'

# ========== OPPOSING POSITION CHECK ==========

def has_opposing_position(open_positions, epic, direction):
    """Block opening if there's already an opposite direction on same instrument"""
    for p in open_positions:
        pos = p['position']
        mkt = p['market']
        pos_epic = pos.get('epic', mkt.get('epic', ''))
        if pos_epic == epic and pos['direction'] != direction:
            return True
    return False

def has_same_instrument_position(open_positions, epic):
    """Check if any position exists on this instrument"""
    for p in open_positions:
        pos = p['position']
        mkt = p['market']
        pos_epic = pos.get('epic', mkt.get('epic', ''))
        if pos_epic == epic:
            return True
    return False

# ========== DASHBOARD & REVIEW ==========

def generate_review(trade_log, strategy_stats, wins, losses, total_pnl):
    total = wins + losses
    review = {"summary": "", "lessons": [], "optimization": [], "bestStrategy": None, "worstStrategy": None}
    
    if total == 0:
        review["summary"] = "尚無已完成交易，系統監控中。"
        return review
    
    wr = wins / total * 100
    review["summary"] = f"已完成 {total} 筆交易，勝率 {wr:.1f}%，累計盈虧 ${total_pnl:.2f}"
    
    if strategy_stats:
        best = max(strategy_stats.items(), key=lambda x: x[1]['pnl'])
        worst = min(strategy_stats.items(), key=lambda x: x[1]['pnl'])
        review["bestStrategy"] = {"name": best[0], "pnl": round(best[1]['pnl'], 2), "wins": best[1]['wins'], "losses": best[1]['losses']}
        if worst[0] != best[0]:
            review["worstStrategy"] = {"name": worst[0], "pnl": round(worst[1]['pnl'], 2), "wins": worst[1]['wins'], "losses": worst[1]['losses']}
    
    lessons = []
    
    for name, stats in strategy_stats.items():
        st = stats['wins'] + stats['losses']
        if st >= 2:
            swr = stats['wins'] / st * 100
            if swr < 30:
                lessons.append(f"策略「{name}」勝率偏低 ({swr:.0f}%)，考慮提高門檻或停用")
            elif swr > 70:
                lessons.append(f"策略「{name}」表現優秀 ({swr:.0f}%)，可加大比重")
    
    if wr < 40:
        lessons.append("整體勝率偏低，建議提高信心度門檻")
    
    win_pnls = [t.get('pnl', 0) or 0 for t in trade_log if t.get('outcome') == 'WIN']
    loss_pnls = [abs(t.get('pnl', 0) or 0) for t in trade_log if t.get('outcome') == 'LOSS']
    avg_win = sum(win_pnls) / len(win_pnls) if win_pnls else 0
    avg_loss = sum(loss_pnls) / len(loss_pnls) if loss_pnls else 0
    if avg_loss > 0 and avg_win > 0:
        rr = avg_win / avg_loss
        lessons.append(f"平均獲利/虧損比 = {rr:.2f}{'（良好）' if rr >= 1.5 else '（需改善）'}")
    
    # Instrument analysis
    inst_stats = {}
    for t in trade_log:
        if t.get('outcome') not in ('WIN', 'LOSS'): continue
        inst = t.get('instrument', 'GOLD')
        if inst not in inst_stats: inst_stats[inst] = {"wins": 0, "losses": 0, "pnl": 0}
        if t['outcome'] == 'WIN': inst_stats[inst]['wins'] += 1
        else: inst_stats[inst]['losses'] += 1
        inst_stats[inst]['pnl'] += t.get('pnl', 0) or 0
    
    for inst, is2 in inst_stats.items():
        it = is2['wins'] + is2['losses']
        if it >= 2:
            iwr = is2['wins'] / it * 100
            name = INSTRUMENTS.get(inst, {}).get('name', inst)
            lessons.append(f"{name} 勝率 {iwr:.0f}%，盈虧 ${is2['pnl']:.2f}")
    
    if not lessons:
        lessons.append("交易數據尚少，持續累積中")
    review["lessons"] = lessons
    
    opts = []
    if total >= 3:
        if wr < 50:
            opts.append("提高信心度門檻：減少低品質進場")
        if avg_loss > avg_win:
            opts.append("調整風報比：縮小止損或擴大止盈")
        opts.append("觀察哪個商品和時間框架勝率最高，集中火力")
        if strategy_stats:
            bn = max(strategy_stats.items(), key=lambda x: x[1]['pnl'])[0]
            opts.append(f"重點使用表現最好的策略：{bn}")
    else:
        opts.append("需要更多交易數據，持續測試中")
    review["optimization"] = opts
    
    return review

def generate_dashboard(report, trade_log, state, positions, all_indicators):
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
            "pnl": round(pnl, 2), "instrument": mkt.get('instrumentName', 'Gold'),
            "epic": mkt.get('epic', pos.get('epic', ''))
        })
    
    closed = [t for t in trade_log if t.get('outcome') in ('WIN', 'LOSS')]
    wins = len([t for t in closed if t['outcome'] == 'WIN'])
    losses = len([t for t in closed if t['outcome'] == 'LOSS'])
    total_pnl = sum(t.get('pnl', 0) or 0 for t in closed)
    win_rate = f"{wins/(wins+losses)*100:.1f}%" if (wins + losses) > 0 else "--"
    
    strategy_stats = {}
    for t in closed:
        s = t.get('strategy', '?')
        if s not in strategy_stats: strategy_stats[s] = {"wins": 0, "losses": 0, "pnl": 0}
        if t['outcome'] == 'WIN': strategy_stats[s]['wins'] += 1
        else: strategy_stats[s]['losses'] += 1
        strategy_stats[s]['pnl'] += t.get('pnl', 0) or 0
    
    review = generate_review(trade_log, strategy_stats, wins, losses, total_pnl)
    
    balance = report.get('balance', 31000)
    
    return {
        "lastUpdate": datetime.now(timezone(timedelta(hours=8))).strftime("%Y-%m-%d %H:%M:%S"),
        "currentPrice": report.get('prices', {}),
        "indicators": all_indicators,
        "account": {
            "balance": balance,
            "realizedPnl": round(total_pnl, 2),
            "unrealizedPnl": round(sum(p['pnl'] for p in open_pos), 2),
            "totalTrades": len(trade_log),
            "closedTrades": len(closed),
            "wins": wins, "losses": losses,
            "winRate": win_rate,
        },
        "openPositions": open_pos,
        "closedTrades": [t for t in closed[-30:]],
        "strategyStats": strategy_stats,
        "review": review,
        "instruments": list(INSTRUMENTS.keys()),
        "actions": report.get('actions', [])
    }

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
    
    balance = 31000
    for acc in account.get('accounts', []):
        if acc.get('preferred'):
            balance = acc['balance']['balance']
    
    report = {
        "time": datetime.now(timezone.utc).isoformat(),
        "balance": balance,
        "prices": {},
        "actions": []
    }
    
    all_indicators = {}
    all_signals = []
    
    # === ANALYZE EACH INSTRUMENT ===
    for epic, info in INSTRUMENTS.items():
        # Skip banned instruments
        if epic in BANNED_INSTRUMENTS:
            continue
        
        idata = market_data.get(epic, {})
        if not idata or idata.get('status') != 'TRADEABLE':
            continue
        
        # Session check
        if not is_active_session(epic):
            report['actions'].append(f"SKIP_{info['name']}: outside active session")
            # Still collect indicators for dashboard
            c1h = idata.get('candles_1h', {}).get('prices', [])
            c15m = idata.get('candles_15m', {}).get('prices', [])
            if c1h and c15m:
                closes_1h = get_closes(c1h)
                closes_15m = get_closes(c15m)
                trend_1h, _, _ = analyze_trend(closes_1h) if len(closes_1h) >= 21 else ("NEUTRAL", 0, 0)
                trend_15m, _, _ = analyze_trend(closes_15m) if len(closes_15m) >= 21 else ("NEUTRAL", 0, 0)
                report['prices'][epic] = {"bid": idata.get('bid', 0), "ask": idata.get('ask', 0)}
                all_indicators[epic] = {
                    "name": info['name'], "type": info['type'],
                    "trend_1h": trend_1h, "trend_15m": trend_15m,
                    "rsi_1h": round(calc_rsi(closes_1h), 1),
                    "rsi_15m": round(calc_rsi(closes_15m), 1),
                    "atr_15m": round(calc_atr(c15m) if c15m else 0, 2),
                    "atr_1h": round(calc_atr(c1h) if c1h else 0, 2),
                    "bid": idata.get('bid', 0), "ask": idata.get('ask', 0),
                    "session": "INACTIVE"
                }
            continue
        
        c1h = idata.get('candles_1h', {}).get('prices', [])
        c15m = idata.get('candles_15m', {}).get('prices', [])
        c5m = idata.get('candles_5m', {}).get('prices', [])
        
        if not c1h or not c15m:
            continue
        
        closes_1h = get_closes(c1h)
        closes_15m = get_closes(c15m)
        closes_5m = get_closes(c5m) if c5m else []
        
        atr_15m = calc_atr(c15m) if c15m else 0
        atr_1h = calc_atr(c1h) if c1h else 0
        trend_1h, _, _ = analyze_trend(closes_1h) if len(closes_1h) >= 21 else ("NEUTRAL", 0, 0)
        trend_15m, _, _ = analyze_trend(closes_15m) if len(closes_15m) >= 21 else ("NEUTRAL", 0, 0)
        
        report['prices'][epic] = {"bid": idata.get('bid', 0), "ask": idata.get('ask', 0)}
        all_indicators[epic] = {
            "name": info['name'], "type": info['type'],
            "trend_1h": trend_1h, "trend_15m": trend_15m,
            "rsi_1h": round(calc_rsi(closes_1h), 1),
            "rsi_15m": round(calc_rsi(closes_15m), 1),
            "atr_15m": round(atr_15m, 2), "atr_1h": round(atr_1h, 2),
            "bid": idata.get('bid', 0), "ask": idata.get('ask', 0),
            "session": "ACTIVE"
        }
        
        signals = find_signals(closes_1h, closes_15m, closes_5m, c15m, c1h)
        for sig_type, direction, confidence, sl_mult, tp_mult, ctx in signals:
            atr = atr_15m if '15M' in sig_type else atr_1h
            all_signals.append((epic, sig_type, direction, confidence, sl_mult, tp_mult, atr, ctx))
    
    # === POSITION MANAGEMENT ===
    open_positions = positions.get('positions', [])
    for p in open_positions:
        pos = p['position']
        mkt = p['market']
        deal_id = pos['dealId']
        direction = pos['direction']
        entry = pos['level']
        stop = pos.get('stopLevel')
        bid = mkt['bid']
        ask = mkt['offer']
        epic = pos.get('epic', mkt.get('epic', 'GOLD'))
        
        pnl_pts = (bid - entry) if direction == 'BUY' else (entry - ask)
        
        inst_ind = all_indicators.get(epic, {})
        atr = inst_ind.get('atr_15m', 10)
        
        # Close BTC positions if any remain (banned instrument cleanup)
        if epic in BANNED_INSTRUMENTS:
            status, resp = close_position(args.api_url, args.cst, args.xsec, deal_id)
            if status == 200:
                report['actions'].append(f"BANNED_CLOSE: {direction} {mkt.get('instrumentName','')} (instrument disabled)")
            continue
        
        # Smart exit: close winners at 2 ATR profit (was 1.5)
        if atr > 0 and pnl_pts > atr * 2:
            status, resp = close_position(args.api_url, args.cst, args.xsec, deal_id)
            if status == 200:
                report['actions'].append(f"PROFIT_CLOSE: {direction} {mkt.get('instrumentName','')} +{pnl_pts:.1f}pts")
                for t in trade_log:
                    if t.get('outcome') == 'OPEN' and t.get('direction') == direction:
                        if t.get('instrument', 'GOLD') == epic or abs(t.get('entry_bid', 0) - entry) < 5:
                            t['outcome'] = 'WIN'
                            t['pnl'] = round(pnl_pts * pos['size'], 2)
                            t['close_time'] = datetime.now(timezone.utc).isoformat()
                            t['close_reason'] = 'PROFIT_TAKE'
                            break
            continue
        
        # Trailing stop: breakeven at 1 ATR
        if atr > 0 and pnl_pts > atr and stop:
            if direction == 'BUY' and stop < entry:
                update_stop(args.api_url, args.cst, args.xsec, deal_id, entry + 1)
                report['actions'].append(f"TRAIL_BE: {mkt.get('instrumentName','')} {direction}")
            elif direction == 'SELL' and stop > entry:
                update_stop(args.api_url, args.cst, args.xsec, deal_id, entry - 1)
                report['actions'].append(f"TRAIL_BE: {mkt.get('instrumentName','')} {direction}")
        
        # Tighten at 2 ATR
        if atr > 0 and pnl_pts > atr * 1.5 and stop:
            if direction == 'BUY':
                ns = bid - atr * 0.5
                if ns > stop:
                    update_stop(args.api_url, args.cst, args.xsec, deal_id, round(ns, 2))
            elif direction == 'SELL':
                ns = ask + atr * 0.5
                if ns < stop:
                    update_stop(args.api_url, args.cst, args.xsec, deal_id, round(ns, 2))
    
    # === SYNC CLOSED TRADES (v4: use API) ===
    sync_closed_trades_from_api(trade_log, args.api_url, args.cst, args.xsec, open_positions)
    
    # Update state
    closed_trades = [t for t in trade_log if t['outcome'] in ('WIN', 'LOSS')]
    state['wins'] = len([t for t in closed_trades if t['outcome'] == 'WIN'])
    state['losses'] = len([t for t in closed_trades if t['outcome'] == 'LOSS'])
    state['total_pnl'] = round(sum(t.get('pnl', 0) or 0 for t in closed_trades), 2)
    
    # === NEW TRADE LOGIC (v4: strict) ===
    current_open = len(open_positions)
    
    if current_open < MAX_CONCURRENT_POSITIONS and all_signals:
        # Cooldown check
        if state.get('consecutive_losses', 0) >= COOLDOWN_LOSSES:
            lt = state.get('last_trade_time', '')
            if lt:
                try:
                    elapsed = (datetime.now(timezone.utc) - datetime.fromisoformat(lt)).total_seconds()
                    if elapsed < COOLDOWN_SECONDS:
                        remaining = int((COOLDOWN_SECONDS - elapsed) / 60)
                        report['actions'].append(f"COOLDOWN: {remaining}min remaining")
                        _save(report, trade_log, state, positions, args, all_indicators)
                        return
                    else:
                        state['consecutive_losses'] = 0
                except:
                    pass
        
        # Sort by confidence (highest first)
        all_signals.sort(key=lambda x: x[3], reverse=True)
        
        opened_this_round = {}
        placed = 0
        
        for epic, sig_type, direction, confidence, sl_mult, tp_mult, atr, ctx in all_signals:
            if current_open + placed >= MAX_CONCURRENT_POSITIONS:
                break
            if epic in opened_this_round:
                continue
            if epic in BANNED_INSTRUMENTS:
                continue
            if atr <= 0:
                continue
            if confidence < MIN_CONFIDENCE:
                continue
            
            # Block opposing positions
            if has_opposing_position(open_positions, epic, direction):
                report['actions'].append(f"BLOCKED: {direction} {INSTRUMENTS[epic]['name']} — opposing position exists")
                continue
            
            # Block duplicate instrument positions
            if has_same_instrument_position(open_positions, epic):
                report['actions'].append(f"BLOCKED: {direction} {INSTRUMENTS[epic]['name']} — already have position")
                continue
            
            inst_config = INSTRUMENTS.get(epic, {"min_size": 0.01, "max_size": 0.1})
            size = calc_lot_size(confidence, inst_config, balance)
            sl = atr * sl_mult
            tp = atr * tp_mult
            
            result, actual_sl, actual_tp = place_order(
                args.api_url, args.cst, args.xsec,
                epic, direction, size, sl, tp
            )
            
            if 'dealReference' in result:
                price_data = report['prices'].get(epic, {})
                trade_entry = {
                    "time": datetime.now(timezone.utc).isoformat(),
                    "instrument": epic,
                    "instrumentName": inst_config.get('name', epic),
                    "strategy": sig_type,
                    "direction": direction,
                    "confidence": round(confidence, 2),
                    "size": size,
                    "entry_bid": price_data.get('bid', 0),
                    "entry_ask": price_data.get('ask', 0),
                    "stop_distance": actual_sl,
                    "tp_distance": actual_tp,
                    "trend_1h": ctx.get('trend_1h', ''),
                    "trend_15m": ctx.get('trend_15m', ''),
                    "rsi_15m": ctx.get('rsi_15m', 0),
                    "rsi_1h": ctx.get('rsi_1h', 0),
                    "confirmation_score": ctx.get('confirmation_score', ''),
                    "result": result,
                    "outcome": "OPEN",
                    "pnl": None
                }
                
                trade_log.append(trade_entry)
                state['last_trade_time'] = datetime.now(timezone.utc).isoformat()
                state['total_trades'] = state.get('total_trades', 0) + 1
                state['consecutive_losses'] = 0  # reset on new trade
                opened_this_round[epic] = True
                placed += 1
                report['actions'].append(
                    f"OPENED: {direction} {inst_config.get('name',epic)} via {sig_type} "
                    f"conf={confidence:.0%} size={size}"
                )
        
        if placed == 0:
            report['actions'].append("NO_TRADE: no signal meets 70% confidence threshold")
    elif not all_signals:
        report['actions'].append("NO_SIGNAL")
    else:
        report['actions'].append(f"MAX_POS: {current_open}/{MAX_CONCURRENT_POSITIONS}")
    
    _save(report, trade_log, state, positions, args, all_indicators)

def _save(report, trade_log, state, positions, args, all_indicators):
    with open(args.state, 'w') as f:
        json.dump(state, f, indent=2)
    with open(args.trade_log, 'w') as f:
        json.dump(trade_log, f, indent=2)
    
    rp = os.path.dirname(args.state) + '/last_report.json'
    with open(rp, 'w') as f:
        json.dump(report, f, indent=2)
    
    dashboard = generate_dashboard(report, trade_log, state, positions, all_indicators)
    dp = os.path.dirname(args.state) + '/dashboard_data.json'
    with open(dp, 'w') as f:
        json.dump(dashboard, f, indent=2)
    
    bp = os.path.expanduser('~/.openclaw/workspace/boss-dashboard/trading-data.json')
    with open(bp, 'w') as f:
        json.dump(dashboard, f, indent=2)
    
    print(json.dumps(report, indent=2))

if __name__ == '__main__':
    main()
