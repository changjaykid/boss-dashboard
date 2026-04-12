#!/bin/bash
# Multi-Instrument Auto Trader v3 - Capital.com
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"

API_URL="https://api-capital.backend-capital.com"
API_KEY="XIiPKqsC9qYZ3rM2"
EMAIL="jaykidforextrading@gmail.com"
PASS="@Jaykid03120312"
TRADE_LOG="/Users/kid/.openclaw/workspace/trading/trade_log.json"
STATE_FILE="/Users/kid/.openclaw/workspace/trading/state.json"
DASHBOARD_DIR="/Users/kid/.openclaw/workspace/boss-dashboard"

if [ ! -f "$STATE_FILE" ]; then
  echo '{"consecutive_losses":0,"last_trade_time":"","total_trades":0,"wins":0,"losses":0,"total_pnl":0}' > "$STATE_FILE"
fi

# Login
RESPONSE=$(curl -s -D /tmp/cap_auto_headers.txt -X POST "$API_URL/api/v1/session" \
  -H "Content-Type: application/json" \
  -H "X-CAP-API-KEY: $API_KEY" \
  -d "{\"identifier\":\"$EMAIL\",\"password\":\"$PASS\"}" 2>/dev/null)

CST=$(grep -i "^cst:" /tmp/cap_auto_headers.txt | tr -d '\r' | awk '{print $2}')
XSEC=$(grep -i "^x-security-token:" /tmp/cap_auto_headers.txt | tr -d '\r' | awk '{print $2}')

if [ -z "$CST" ]; then
  echo "LOGIN_FAILED" 
  exit 1
fi

# Get positions & account
POSITIONS=$(curl -s "$API_URL/api/v1/positions" -H "X-SECURITY-TOKEN: $XSEC" -H "CST: $CST" 2>/dev/null)
ACCOUNT=$(curl -s "$API_URL/api/v1/accounts" -H "X-SECURITY-TOKEN: $XSEC" -H "CST: $CST" 2>/dev/null)

# Fetch data for each instrument
INSTRUMENTS="GOLD EURUSDM2026 GBPUSD USDJPYM2026 US30 US500 US100"

python3 << PYEOF > /tmp/market_data.json 2>/dev/null
import json, requests

api_url = "$API_URL"
cst = "$CST"
xsec = "$XSEC"
instruments = "$INSTRUMENTS".split()
market_data = {}
h = {"X-SECURITY-TOKEN": xsec, "CST": cst}

for epic in instruments:
    try:
        mkt = requests.get(f"{api_url}/api/v1/markets/{epic}", headers=h, timeout=10).json()
        snap = mkt.get("snapshot", {})
        bid = snap.get("bid", 0)
        ask = snap.get("offer", 0)
        if not bid:
            continue
        c4h = requests.get(f"{api_url}/api/v1/prices/{epic}?resolution=HOUR_4&max=30", headers=h, timeout=10).json()
        c1h = requests.get(f"{api_url}/api/v1/prices/{epic}?resolution=HOUR&max=30", headers=h, timeout=10).json()
        c15m = requests.get(f"{api_url}/api/v1/prices/{epic}?resolution=MINUTE_15&max=30", headers=h, timeout=10).json()
        c5m = requests.get(f"{api_url}/api/v1/prices/{epic}?resolution=MINUTE_5&max=30", headers=h, timeout=10).json()
        market_data[epic] = {"status": "TRADEABLE", "bid": bid, "ask": ask, "candles_4h": c4h, "candles_1h": c1h, "candles_15m": c15m, "candles_5m": c5m}
    except:
        pass

print(json.dumps(market_data))
PYEOF

# Run analyzer
python3 /Users/kid/.openclaw/workspace/trading/analyzer_v6.py \
  --positions "$POSITIONS" \
  --account "$ACCOUNT" \
  --market-data "$(cat /tmp/market_data.json)" \
  --state "$STATE_FILE" \
  --trade-log "$TRADE_LOG" \
  --api-url "$API_URL" \
  --cst "$CST" \
  --xsec "$XSEC"

# Push to GitHub
if [ -f "$DASHBOARD_DIR/trading-data.json" ]; then
  cd "$DASHBOARD_DIR"
  git add trading-data.json 2>/dev/null
  git diff --cached --quiet || git commit -m "auto: update $(date '+%Y-%m-%d %H:%M')" 2>/dev/null && git push origin main 2>/dev/null
fi
