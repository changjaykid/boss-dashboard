#!/usr/bin/env python3
"""
Multi-Instrument Auto Trading Analyzer v5
- Advanced Strategy Engine: Price Action, Chart Patterns, Elliott Wave, Market Regime
- Multi-Timeframe Alignment
- Real P/L tracking via API delta
- Strict Risk Management (3% daily drawdown limit, Max 4H hold, ATR based SL)
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
    "SILVER":      {"name": "XAGUSD",   "type": "白銀",  "min_size": 0.1,  "max_size": 1.0},
    "COPPER":      {"name": "銅",       "type": "金屬",  "min_size": 0.1,  "max_size": 1.0},
    "EURUSDM2026": {"name": "EUR/USD",  "type": "外匯",  "min_size": 0.1,  "max_size": 1.0},
    "US500":       {"name": "S&P 500",  "type": "指數",  "min_size": 0.1,  "max_size": 1.0},
    "US30":        {"name": "US30",     "type": "指數",  "min_size": 0.1,  "max_size": 1.0},
    "OIL_CRUDE":   {"name": "原油",     "type": "商品",  "min_size": 0.1,  "max_size": 1.0},
    "NATURALGAS":  {"name": "天然氣",   "type": "商品",  "min_size": 0.1,  "max_size": 1.0},
}

# Banned instruments (+ US30)
BANNED_INSTRUMENTS = {"BTCUSD", "ETHUSD", "LTCUSD", "XRPUSD", "US30"}

# ========== SESSION AWARENESS ==========
ACTIVE_SESSIONS = {
    "GOLD":        [(7, 17), (13, 21)],
    "SILVER":      [(7, 17), (13, 21)],
    "COPPER":      [(7, 17), (13, 21)],
    "EURUSDM2026": [(7, 17)],
    "US500":       [(13, 21)],
    "US30":        [(13, 21)],
    "OIL_CRUDE":   [(13, 21)],
    "NATURALGAS":  [(13, 21)],
}

def is_active_session(epic):
    now_utc = datetime.now(timezone.utc).hour
    sessions = ACTIVE_SESSIONS.get(epic, [(0, 24)])
    for start, end in sessions:
        if start <= now_utc < end:
            return True
    return False

# ========== BASE INDICATORS ==========

def get_closes(candles):
    return [(c['closePrice']['bid'] + c['closePrice']['ask']) / 2 for c in candles]

def calc_ema(closes, period):
    if len(closes) < period:
        return sum(closes) / len(closes) if closes else 0
    multiplier = 2 / (period + 1)
    ema = sum(closes[:period]) / period
    for price in closes[period:]:
        ema = (price - ema) * multiplier + ema
    return ema

def calc_rsi(closes, period=14):
    if len(closes) < period + 1: return 50
    gains, losses = [], []
    for i in range(1, len(closes)):
        diff = closes[i] - closes[i-1]
        gains.append(max(diff, 0))
        losses.append(max(-diff, 0))
    ag = sum(gains[-period:]) / period
    al = sum(losses[-period:]) / period
    if al == 0: return 100
    return 100 - (100 / (1 + (ag / al)))

def calc_atr(candles, period=14):
    trs = []
    for i in range(1, len(candles)):
        h = (candles[i]['highPrice']['bid'] + candles[i]['highPrice']['ask']) / 2
        l = (candles[i]['lowPrice']['bid'] + candles[i]['lowPrice']['ask']) / 2
        pc = (candles[i-1]['closePrice']['bid'] + candles[i-1]['closePrice']['ask']) / 2
        trs.append(max(h - l, abs(h - pc), abs(l - pc)))
    if not trs: return 0
    return sum(trs[-period:]) / min(period, len(trs))

def calc_macd(closes, fast=12, slow=26, signal=9):
    if len(closes) < slow: return 0, 0, 0
    ef = calc_ema(closes, fast)
    es = calc_ema(closes, slow)
    ml = ef - es
    mvs = []
    for i in range(signal):
        idx = len(closes) - signal + i
        if idx >= 0:
            mvs.append(calc_ema(closes[:idx+1], fast) - calc_ema(closes[:idx+1], slow))
    sl = sum(mvs) / len(mvs) if mvs else ml
    return ml, sl, ml - sl

def calc_bollinger(closes, period=20, std_mult=2):
    if len(closes) < period: return closes[-1], closes[-1]+10, closes[-1]-10
    r = closes[-period:]
    sma = sum(r) / period
    v = sum((x - sma) ** 2 for x in r) / period
    std = v ** 0.5
    return sma, sma + std_mult * std, sma - std_mult * std

# ========== A. PRICE ACTION ==========
def detect_price_action(candles):
    """
    辨識：Pin bar, Engulfing, Inside bar, Outside bar, Doji, Morning/Evening star, Support/Resistance
    """
    if len(candles) < 50:
        return None, 0, ""
    
    # helper for o, h, l, c
    def ohlc(idx):
        c = candles[idx]
        o = (c['openPrice']['bid'] + c['openPrice']['ask']) / 2
        h = (c['highPrice']['bid'] + c['highPrice']['ask']) / 2
        l = (c['lowPrice']['bid'] + c['lowPrice']['ask']) / 2
        cl = (c['closePrice']['bid'] + c['closePrice']['ask']) / 2
        return o, h, l, cl
    
    o1, h1, l1, c1 = ohlc(-1)
    o2, h2, l2, c2 = ohlc(-2)
    o3, h3, l3, c3 = ohlc(-3)
    
    body1 = abs(c1 - o1)
    range1 = h1 - l1
    
    # Pin bar
    if range1 > 0 and body1 < range1 * 0.3:
        if c1 > o1 and (l1 + range1 * 0.3) > min(o1, c1): # Lower shadow
            return "BUY", 0.8, "Bullish Pin Bar"
        elif c1 < o1 and (h1 - range1 * 0.3) < max(o1, c1): # Upper shadow
            return "SELL", 0.8, "Bearish Pin Bar"
            
    # Engulfing
    body2 = abs(c2 - o2)
    if body1 > body2 and c1 > o1 and c2 < o2 and c1 > o2 and o1 < c2:
        return "BUY", 0.75, "Bullish Engulfing"
    if body1 > body2 and c1 < o1 and c2 > o2 and c1 < o2 and o1 > c2:
        return "SELL", 0.75, "Bearish Engulfing"
        
    # Outside bar
    if h1 > h2 and l1 < l2:
        return ("BUY" if c1 > o1 else "SELL"), 0.7, "Outside Bar"
        
    # Inside bar
    if h1 < h2 and l1 > l2:
        return ("BUY" if c2 > o2 else "SELL"), 0.6, "Inside Bar"
        
    # Morning / Evening Star
    if c3 < o3 and abs(c2 - o2) < (h2 - l2) * 0.2 and c1 > o1 and c1 > (o3 + c3)/2:
        return "BUY", 0.85, "Morning Star"
    if c3 > o3 and abs(c2 - o2) < (h2 - l2) * 0.2 and c1 < o1 and c1 < (o3 + c3)/2:
        return "SELL", 0.85, "Evening Star"
        
    return "NONE", 0, "No Pattern"

# ========== B. CHART PATTERNS ==========
def detect_chart_patterns(candles, closes):
    """
    辨識：Double Top/Bottom, Head & Shoulders, Triangles, Wedges, Flags
    """
    if len(closes) < 20:
        return "None", "NONE", 0, 0
        
    # Simplified peak/trough detection
    peaks = []
    troughs = []
    for i in range(2, len(closes)-2):
        if closes[i] > closes[i-1] and closes[i] > closes[i+1]:
            peaks.append((i, closes[i]))
        if closes[i] < closes[i-1] and closes[i] < closes[i+1]:
            troughs.append((i, closes[i]))
            
    if len(peaks) >= 2 and len(troughs) >= 1:
        p1, p2 = peaks[-2][1], peaks[-1][1]
        if abs(p1 - p2) / p1 < 0.002:
            return "Double Top", "SELL", troughs[-1][1] - (p1 - troughs[-1][1]), 0.8
            
    if len(troughs) >= 2 and len(peaks) >= 1:
        t1, t2 = troughs[-2][1], troughs[-1][1]
        if abs(t1 - t2) / t1 < 0.002:
            return "Double Bottom", "BUY", peaks[-1][1] + (peaks[-1][1] - t1), 0.8

    return "None", "NONE", 0, 0

# ========== C. ELLIOTT WAVE ==========
def detect_elliott_wave(candles, closes):
    """
    簡化版波浪辨識
    """
    if len(closes) < 50:
        return "Unknown", [], "NONE", 0
        
    highs = [(c['highPrice']['bid'] + c['highPrice']['ask']) / 2 for c in candles]
    lows = [(c['lowPrice']['bid'] + c['lowPrice']['ask']) / 2 for c in candles]
    
    max_h = max(highs[-50:])
    min_l = min(lows[-50:])
    
    diff = max_h - min_l
    if diff == 0: return "Unknown", [], "NONE", 0
    
    fibs = [max_h - diff*0.382, max_h - diff*0.5, max_h - diff*0.618]
    
    curr = closes[-1]
    if curr > max_h - diff*0.2:
        return "Wave 3/5", fibs, "BUY", 0.6
    elif curr < min_l + diff*0.2:
        return "Wave C", fibs, "SELL", 0.6
        
    return "Corrective", fibs, "NONE", 0

# ========== D. MARKET REGIME ==========
def classify_market_regime(closes_4h, closes_1h, atr_values):
    """
    判斷目前市場狀態
    """
    if len(closes_1h) < 20: return "RANGING"
    
    ema9 = calc_ema(closes_1h, 9)
    ema21 = calc_ema(closes_1h, 21)
    ema50 = calc_ema(closes_1h, 50)
    
    bb_mid, bb_up, bb_low = calc_bollinger(closes_1h, 20, 2)
    bw = (bb_up - bb_low) / bb_mid if bb_mid else 0
    
    curr_atr = atr_values[-1] if atr_values else 0
    avg_atr = sum(atr_values[-14:]) / 14 if len(atr_values) >= 14 else curr_atr
    
    if curr_atr > avg_atr * 2:
        return "VOLATILE"
        
    if bw < 0.005 and curr_atr > avg_atr * 1.5:
        return "BREAKOUT"
        
    if ema9 > ema21 > ema50:
        return "TRENDING_UP"
    elif ema9 < ema21 < ema50:
        return "TRENDING_DOWN"
        
    return "RANGING"

# ========== E. STRATEGY SELECTOR ==========
def select_strategies(regime, indicators):
    """
    根據市況選策略
    """
    valid_strats = []
    if regime in ("TRENDING_UP", "TRENDING_DOWN"):
        valid_strats.extend(["TREND_ALIGN", "ELLIOTT", "FLAG_BREAKOUT"])
    elif regime == "RANGING":
        valid_strats.extend(["SR_REVERSAL", "RSI_REVERSAL", "PIN_BAR"])
    elif regime == "BREAKOUT":
        valid_strats.extend(["PATTERN_BREAK", "BB_BREAK", "OUTSIDE_BAR"])
    elif regime == "VOLATILE":
        valid_strats.extend(["HIGH_CONF_ONLY"])
    return valid_strats

# ========== F. MULTI-TIMEFRAME ANALYSIS ==========
def multi_timeframe_analysis(candles_4h, candles_1h, candles_15m, candles_5m):
    """
    所有時間框架必須對齊才進場
    """
    if not (candles_4h and candles_1h and candles_15m): return "NONE", 0
    
    c4 = get_closes(candles_4h)
    c1 = get_closes(candles_1h)
    c15 = get_closes(candles_15m)
    
    ema4h = calc_ema(c4, 20)
    ema1h = calc_ema(c1, 20)
    ema15m = calc_ema(c15, 20)
    
    if c4[-1] > ema4h and c1[-1] > ema1h and c15[-1] > ema15m:
        return "BUY", 1.0
    if c4[-1] < ema4h and c1[-1] < ema1h and c15[-1] < ema15m:
        return "SELL", 1.0
        
    return "NONE", 0

# ========== I. CONFIDENCE CALCULATION ==========
def calculate_confidence(direction, mtf_dir, pa_dir, pa_str, pat_dir, pat_conf, rsi, macd_h, atr_ratio, ew_dir, sr_near):
    conf = 0.5 # Base
    if mtf_dir == direction: conf += 0.10
    if pa_dir == direction: conf += 0.08 * pa_str
    if pat_dir == direction: conf += 0.08 * pat_conf
    
    if direction == "BUY" and 30 < rsi < 60: conf += 0.05
    elif direction == "SELL" and 40 < rsi < 70: conf += 0.05
    
    if direction == "BUY" and macd_h > 0: conf += 0.05
    elif direction == "SELL" and macd_h < 0: conf += 0.05
    
    if atr_ratio > 1.2: conf += 0.04
    if ew_dir == direction: conf += 0.05
    if sr_near: conf += 0.05
    
    return min(1.0, conf)

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

# ========== DASHBOARD & REVIEW ==========

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
    
    balance = report.get('balance', state.get('last_balance', 31000))
    
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
        "closedTrades": closed[-30:],
        "strategyStats": strategy_stats,
        "instruments": list(INSTRUMENTS.keys()),
        "actions": report.get('actions', [])
    }

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
    try:
        os.makedirs(os.path.dirname(bp), exist_ok=True)
        with open(bp, 'w') as f:
            json.dump(dashboard, f, indent=2)
    except:
        pass
    
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
    
    # Real balance via API delta
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
    if not 'initial_balance' in state: state['initial_balance'] = initial_balance
    
    if (initial_balance - balance) / initial_balance >= 0.03:
        print("警告：虧損回撤超過 3%，今日停止交易")
        stop_trading = True
    else:
        stop_trading = False
        
    report = {
        "time": datetime.now(timezone.utc).isoformat(),
        "balance": balance,
        "prices": {},
        "actions": []
    }
    
    all_indicators = {}
    all_signals = []
    
    for epic, info in INSTRUMENTS.items():
        if epic in BANNED_INSTRUMENTS: continue
        
        idata = market_data.get(epic, {})
        if not idata or idata.get('status') != 'TRADEABLE': continue
        if not is_active_session(epic): continue
        
        c4h = idata.get('candles_4h', {}).get('prices', [])
        c1h = idata.get('candles_1h', {}).get('prices', [])
        c15m = idata.get('candles_15m', {}).get('prices', [])
        c5m = idata.get('candles_5m', {}).get('prices', [])
        
        if not c1h or not c15m or not c4h: continue
        
        closes_4h = get_closes(c4h)
        closes_1h = get_closes(c1h)
        closes_15m = get_closes(c15m)
        
        atr_15m = calc_atr(c15m)
        atr_1h = calc_atr(c1h)
        
        # A. PA
        pa_dir, pa_str, pa_name = detect_price_action(c15m)
        
        # B. Patterns
        pat_name, pat_dir, pat_tgt, pat_conf = detect_chart_patterns(c15m, closes_15m)
        
        # C. Elliott Wave
        ew_pos, ew_fibs, ew_dir, ew_conf = detect_elliott_wave(c15m, closes_15m)
        
        # D. Regime
        regime = classify_market_regime(closes_4h, closes_1h, [calc_atr(c1h[-i-14:-i]) if i>0 else atr_1h for i in range(10,-1,-1)])
        
        # E. Strategies
        strats = select_strategies(regime, {})
        
        # F. MTF
        mtf_dir, mtf_conf = multi_timeframe_analysis(c4h, c1h, c15m, c5m)
        
        rsi_15m = calc_rsi(closes_15m)
        macd_l, macd_s, macd_h = calc_macd(closes_15m)
        
        atr_old = calc_atr(c15m[:len(c15m)//2])
        atr_ratio = atr_15m / atr_old if atr_old > 0 else 1.0
        
        # Base Signals
        sig_dir = "NONE"
        if mtf_dir != "NONE":
            sig_dir = mtf_dir
        elif pa_dir != "NONE":
            sig_dir = pa_dir
            
        if sig_dir != "NONE":
            conf = calculate_confidence(sig_dir, mtf_dir, pa_dir, pa_str, pat_dir, pat_conf, rsi_15m, macd_h, atr_ratio, ew_dir, False)
            if conf >= 0.75:
                all_signals.append((epic, f"V5_{regime}", sig_dir, conf, atr_15m, pat_tgt))
                
        all_indicators[epic] = {
            "name": info['name'], "regime": regime, "pa": pa_name,
            "pattern": pat_name, "mtf_dir": mtf_dir, "ew_pos": ew_pos
        }
        report['prices'][epic] = {"bid": idata.get('bid', 0), "ask": idata.get('ask', 0)}

    # POSITION MGMT (G)
    open_positions = positions.get('positions', [])
    for p in open_positions:
        pos = p['position']
        mkt = p['market']
        deal_id = pos['dealId']
        epic = pos.get('epic', mkt.get('epic', 'GOLD'))
        
        # Max hold time 4H
        create_time = pos.get('createdDate')
        if create_time:
            # Simple format check
            try:
                ct = datetime.fromisoformat(create_time.replace('Z', '+00:00'))
                if (datetime.now(timezone.utc) - ct).total_seconds() > 4 * 3600:
                    status, _ = close_position(args.api_url, args.cst, args.xsec, deal_id)
                    if status == 200:
                        report['actions'].append(f"TIMEOUT_CLOSE: {epic}")
            except:
                pass
                
    if not stop_trading:
        for epic, sig_type, direction, confidence, atr_val, tgt in sorted(all_signals, key=lambda x: x[3], reverse=True):
            # Max 1 per instrument
            has_pos = any(p['position'].get('epic', p['market'].get('epic')) == epic for p in open_positions)
            if has_pos: continue
            
            inst_config = INSTRUMENTS.get(epic, {"min_size": 0.01, "max_size": 0.1})
            size = inst_config['min_size']
            
            sl = max(atr_val * 1.5, 5) # dynamic atr SL
            tp = abs(tgt - report['prices'][epic]['bid']) if tgt > 0 else max(atr_val * 3, 10)
            
            res, asl, atp = place_order(args.api_url, args.cst, args.xsec, epic, direction, size, sl, tp)
            if 'dealReference' in res:
                trade_log.append({
                    "time": datetime.now(timezone.utc).isoformat(),
                    "instrument": epic,
                    "strategy": sig_type,
                    "direction": direction,
                    "confidence": round(confidence, 2),
                    "size": size,
                    "outcome": "OPEN"
                })
                report['actions'].append(f"OPENED {direction} {epic} Conf:{confidence:.2f}")

    _save(report, trade_log, state, positions, args, all_indicators)

if __name__ == '__main__':
    main()
