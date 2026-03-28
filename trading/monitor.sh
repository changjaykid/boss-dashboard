#!/bin/bash
# XAUUSD Trading Monitor Script
# Refreshes session and checks for trading signals

API_URL="https://api-capital.backend-capital.com"
API_KEY="XIiPKqsC9qYZ3rM2"
EMAIL="jaykidforextrading@gmail.com"
PASS="@Jaykid03120312"

# Login and get tokens
login() {
  RESPONSE=$(curl -s -D /tmp/cap_monitor_headers.txt -X POST "$API_URL/api/v1/session" \
    -H "Content-Type: application/json" \
    -H "X-CAP-API-KEY: $API_KEY" \
    -d "{\"identifier\":\"$EMAIL\",\"password\":\"$PASS\"}")
  
  CST=$(grep -i "^cst:" /tmp/cap_monitor_headers.txt | tr -d '\r' | awk '{print $2}')
  XSEC=$(grep -i "^x-security-token:" /tmp/cap_monitor_headers.txt | tr -d '\r' | awk '{print $2}')
  
  if [ -z "$CST" ]; then
    echo "LOGIN FAILED"
    exit 1
  fi
  echo "CST=$CST"
  echo "XSEC=$XSEC"
}

# Get candles
get_candles() {
  local resolution=$1
  local max=$2
  curl -s "$API_URL/api/v1/prices/GOLD?resolution=$resolution&max=$max" \
    -H "X-SECURITY-TOKEN: $XSEC" \
    -H "CST: $CST"
}

# Get current price
get_price() {
  curl -s "$API_URL/api/v1/markets?searchTerm=XAUUSD" \
    -H "X-SECURITY-TOKEN: $XSEC" \
    -H "CST: $CST" | python3 -c "
import json,sys
d=json.load(sys.stdin)
m=d['markets'][0]
print(f'{m[\"bid\"]}|{m[\"offer\"]}')
"
}

login
echo "=== Monitor Started ==="
echo "Time: $(date)"
PRICE=$(get_price)
echo "Current XAUUSD: $PRICE"
