#!/bin/bash
# 廣告業務自動搜尋腳本
# 每6小時執行一次，搜尋 Facebook / Threads 上的潛在客戶

WORKSPACE="/Users/kid/.openclaw/workspace"
DATA_FILE="$WORKSPACE/boss-dashboard/ad-business-data.json"
LOG_FILE="$WORKSPACE/trading/ad_business_cron.log"
TIMESTAMP=$(date '+%Y/%m/%d %H:%M')

echo "[$TIMESTAMP] 開始搜尋潛在客戶..." >> "$LOG_FILE"

# 用 node 執行搜尋和更新
node "$WORKSPACE/trading/ad_business_updater.js" >> "$LOG_FILE" 2>&1

# 推送到 GitHub
cd "$WORKSPACE/boss-dashboard"
git add ad-business-data.json
git commit -m "auto: 廣告業務名單更新 $TIMESTAMP" 2>/dev/null
git push origin main 2>/dev/null

echo "[$TIMESTAMP] 搜尋完成" >> "$LOG_FILE"
