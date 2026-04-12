import re

with open('/Users/kid/.openclaw/workspace/workers/forex-trader/engine/analyzer_v6.py', 'r') as f:
    text = f.read()

if '"strategy_us30_pullback": True,' not in text:
    text = text.replace('"atr_breakout": True,', '"atr_breakout": True,\n    "strategy_us30_pullback": True,')

strat_code = """
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
"""

if 'def strategy_us30_pullback' not in text:
    text = text.replace('def run_all_strategies', strat_code + '\n\ndef run_all_strategies')

pattern = r"all_results = \[\s*strategy_trend_ema_cross.*?\n\s*\]"
new_run_all = """# US30 特規處理
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
        ]"""

if '# US30 特規處理' not in text:
    text = re.sub(pattern, new_run_all, text, flags=re.DOTALL)
    
if 'global current_epic' not in text and 'def analyze_instrument' in text:
    text = text.replace('def analyze_instrument(epic, data, trade_log, open_positions, account_balance, state):', 
                        'def analyze_instrument(epic, data, trade_log, open_positions, account_balance, state):\n    global current_epic\n    current_epic = epic')

text = text.replace('BANNED_INSTRUMENTS = {"US30"}', 'BANNED_INSTRUMENTS = set()')

with open('/Users/kid/.openclaw/workspace/workers/forex-trader/engine/analyzer_v6.py', 'w') as f:
    f.write(text)
print("PATCH APPLIED")
