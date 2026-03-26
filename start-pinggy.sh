#!/bin/bash
cd /Users/kid/.openclaw/workspace/boss-dashboard
# 1. 確保本地伺服器運行
pkill -f http-server
nohup npx serve -p 8080 > serve.log 2>&1 &

# 2. 等待 serve 啟動
sleep 2

# 3. 使用 SSH 建立 Pinggy 隧道 (更穩定的免費內網穿透)
ssh -p 443 -R0:localhost:8080 a.pinggy.io > pinggy.log 2>&1 &
