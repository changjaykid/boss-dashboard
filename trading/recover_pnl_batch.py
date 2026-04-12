#!/usr/bin/env python3
"""
Batch P/L recovery v4.
1. Fetch all 'Trade closed' transactions from Capital.com
2. Match known-good trades (already have P/L) first to consume transactions
3. Match remaining transactions to zero-pnl trades
4. Fallback: SL estimation
"""
import json
import sys
import os
import requests
from datetime import datetime, timedelta, timezone

API_URL = "https://api-capital.backend-capital.com"
API_KEY = "XIiPKqsC9qYZ3rM2"
EMAIL = "jaykidforextrading@gmail.com"
PASS = "@Jaykid03120312"

EPIC_TO_TX_NAME = {
    'GOLD': 'GOLD', 'US30': 'US30', 'US500': 'US500', 'US100': 'US100',
    'EURUSDM2026': 'EURUSD', 'GBPUSD': 'GBPUSD', 'USDJPYM2026': 'USDJPY',
}

def authenticate():
    resp = requests.post(f"{API_URL}/api/v1/session", json={
        "identifier": EMAIL, "password": PASS, "encryptedPassword": False
    }, headers={"X-CAP-API-KEY": API_KEY, "Content-Type": "application/json"}, timeout=15)
    if resp.status_code != 200:
        print(f"Auth failed: {resp.status_code}")
        sys.exit(1)
    return resp.headers.get('CST',''), resp.headers.get('X-SECURITY-TOKEN','')

def fetch_close_transactions(cst, xsec):
    h = {"X-SECURITY-TOKEN": xsec, "CST": cst, "Content-Type": "application/json"}
    all_closes = []
    start = datetime(2026, 3, 26, tzinfo=timezone.utc)
    end = datetime.now(timezone.utc)
    current = start
    while current < end:
        chunk_end = min(current + timedelta(days=5), end)
        url = f"{API_URL}/api/v1/history/transactions?from={current.strftime('%Y-%m-%dT%H:%M:%S')}&to={chunk_end.strftime('%Y-%m-%dT%H:%M:%S')}&maxSpanSeconds=604800"
        r = requests.get(url, headers=h, timeout=30)
        if r.status_code == 200:
            txs = r.json().get('transactions', [])
            closes = [tx for tx in txs if tx.get('note') == 'Trade closed']
            all_closes.extend(closes)
            print(f"  {current.date()} → {chunk_end.date()}: {len(closes)} closes")
        current = chunk_end
    return all_closes

def parse_time(ts):
    if not ts: return None
    try:
        dt = datetime.fromisoformat(ts.replace('Z', '+00:00'))
        if dt.tzinfo is None: dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except: return None

def match_trade_to_tx(trade, txs, used, time_field='close_time', max_delta=timedelta(minutes=30)):
    """Find best matching transaction by instrument + time proximity."""
    instrument = trade.get('instrument', '')
    trade_time = parse_time(trade.get(time_field, ''))
    if not trade_time or not instrument:
        return None, None
    
    tx_name = EPIC_TO_TX_NAME.get(instrument, instrument)
    best_idx = None
    best_diff = timedelta(hours=999)
    
    for i, tx in enumerate(txs):
        if i in used: continue
        if tx.get('instrumentName','') != tx_name: continue
        tx_time = parse_time(tx.get('dateUtc',''))
        if not tx_time: continue
        diff = abs(tx_time - trade_time)
        if diff < best_diff and diff < max_delta:
            best_diff = diff
            best_idx = i
    
    if best_idx is not None:
        return best_idx, float(txs[best_idx].get('size', '0'))
    return None, None

def estimate_from_sl(t):
    sl = t.get('sl_distance') or t.get('stop_distance', 0)
    size = t.get('size', 0)
    instrument = t.get('instrument', '')
    if not sl or not size: return None
    if instrument == 'GOLD': return -abs(sl) * size * 100
    elif instrument in ('US30','US500','US100'): return -abs(sl) * size
    elif instrument in ('EURUSDM2026','GBPUSD','USDJPYM2026'): return -abs(sl) * size * 10
    return -abs(sl) * size

def main():
    print("=== Batch P/L Recovery v4 ===")
    cst, xsec = authenticate()
    print("Authenticated ✓")
    
    log_path = os.path.join(os.path.dirname(__file__), 'trade_log.json')
    with open(log_path) as f:
        trade_log = json.load(f)
    
    print("\nFetching close transactions...")
    close_txs = fetch_close_transactions(cst, xsec)
    print(f"Total close transactions: {len(close_txs)}")
    
    used_tx = set()
    
    # PHASE 1: Match known-good trades (already have correct P/L) to consume transactions
    # These trades have non-zero P/L from the original auto_trader logging
    known_good = []
    needs_recovery = []
    
    for i, t in enumerate(trade_log):
        if t.get('outcome') == 'OPEN':
            continue
        pnl = t.get('pnl', 0) or 0
        source = t.get('pnl_source', '')
        
        if pnl != 0 and source not in ('api_time_matched', 'estimated_from_sl', 'calculated_from_sl'):
            known_good.append((i, t))
        elif t.get('outcome') in ('WIN', 'LOSS', 'CLOSED_BY_BROKER'):
            needs_recovery.append((i, t))
    
    print(f"\nPhase 1: Matching {len(known_good)} known-good trades to consume transactions...")
    matched_known = 0
    for idx, t in known_good:
        # Try to match by close_time first, then by open time
        tx_idx, _ = match_trade_to_tx(t, close_txs, used_tx, 'close_time')
        if tx_idx is None:
            tx_idx, _ = match_trade_to_tx(t, close_txs, used_tx, 'time')
        if tx_idx is not None:
            used_tx.add(tx_idx)
            matched_known += 1
    print(f"  Consumed {matched_known} transactions for known trades")
    
    # PHASE 2: Match remaining transactions to zero-pnl trades
    remaining_txs = [(i, tx) for i, tx in enumerate(close_txs) if i not in used_tx]
    print(f"\nPhase 2: {len(remaining_txs)} unmatched transactions for {len(needs_recovery)} trades")
    
    api_recovered = 0
    estimated = 0
    no_data = 0
    
    # Sort needs_recovery by close_time for better matching
    needs_recovery.sort(key=lambda x: x[1].get('close_time', '') or x[1].get('time', ''))
    
    for idx, t in needs_recovery:
        instrument = t.get('instrument', '')
        close_time = parse_time(t.get('close_time', ''))
        open_time = parse_time(t.get('time', ''))
        
        # For V5 trades that were all SYNC_CLOSED at same time, 
        # the actual broker close could be anytime between open and sync time
        # So use a wide window
        
        tx_idx = None
        pnl_val = None
        
        if instrument:
            tx_name = EPIC_TO_TX_NAME.get(instrument, instrument)
            
            # Strategy: find any unmatched transaction for same instrument
            # within the trade's lifetime (open_time to close_time + buffer)
            best_idx = None
            best_diff = timedelta(days=999)
            
            for i, tx in enumerate(close_txs):
                if i in used_tx: continue
                if tx.get('instrumentName','') != tx_name: continue
                tx_time = parse_time(tx.get('dateUtc',''))
                if not tx_time: continue
                
                # Check if tx_time falls within trade lifetime
                in_window = False
                if open_time and close_time:
                    # Transaction should be between open and close (with buffer)
                    if (open_time - timedelta(minutes=5)) <= tx_time <= (close_time + timedelta(minutes=5)):
                        in_window = True
                elif close_time:
                    if abs(tx_time - close_time) < timedelta(hours=2):
                        in_window = True
                elif open_time:
                    if tx_time > open_time and (tx_time - open_time) < timedelta(days=5):
                        in_window = True
                
                if in_window:
                    if close_time:
                        diff = abs(tx_time - close_time)
                    else:
                        diff = abs(tx_time - (open_time or datetime.now(timezone.utc)))
                    if diff < best_diff:
                        best_diff = diff
                        best_idx = i
            
            if best_idx is not None:
                used_tx.add(best_idx)
                pnl_val = float(close_txs[best_idx].get('size', '0'))
                trade_log[idx]['pnl'] = round(pnl_val, 2)
                trade_log[idx]['pnl_source'] = 'api_time_matched'
                trade_log[idx]['matched_dealId'] = close_txs[best_idx].get('dealId', '')
                tx_idx = best_idx
                api_recovered += 1
                print(f"  ✓ {instrument} {t.get('direction')} → ${round(pnl_val,2)}")
        
        if tx_idx is None:
            pnl_est = estimate_from_sl(t)
            if pnl_est is not None:
                trade_log[idx]['pnl'] = round(pnl_est, 2)
                trade_log[idx]['pnl_source'] = 'estimated_from_sl'
                estimated += 1
                print(f"  ~ {instrument} {t.get('direction')} → ~${round(pnl_est,2)} (estimated)")
            else:
                no_data += 1
                print(f"  ✗ {instrument or '?'} {t.get('direction','')} → no data")
        
        # Update outcome
        pnl = trade_log[idx].get('pnl', 0) or 0
        if pnl > 0: trade_log[idx]['outcome'] = 'WIN'
        elif pnl < 0: trade_log[idx]['outcome'] = 'LOSS'
    
    # Save
    with open(log_path, 'w') as f:
        json.dump(trade_log, f, indent=2, ensure_ascii=False)
    
    # Summary
    wins = len([t for t in trade_log if t.get('outcome') == 'WIN'])
    losses = len([t for t in trade_log if t.get('outcome') == 'LOSS'])
    total_pnl = sum(t.get('pnl', 0) or 0 for t in trade_log if t.get('outcome') in ('WIN','LOSS'))
    zero_pnl = len([t for t in trade_log if (t.get('pnl',0) or 0) == 0 and t.get('outcome') in ('WIN','LOSS')])
    
    print(f"\n=== Results ===")
    print(f"API matched: {api_recovered}")
    print(f"SL estimated: {estimated}")
    print(f"No data: {no_data}")
    print(f"Still zero P/L: {zero_pnl}")
    print(f"Stats: {wins}W/{losses}L, Total P/L: ${round(total_pnl,2)}")
    print(f"Account balance: $31,026 (started $31,000)")
    print(f"Discrepancy: ${round(31026 - 31000 - total_pnl, 2)}")

if __name__ == '__main__':
    main()
