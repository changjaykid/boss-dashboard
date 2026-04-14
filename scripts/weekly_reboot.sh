#!/bin/bash
# 每週自動重開機腳本
# 建議排在週日凌晨 4:00（交易最冷清的時段）
# 用法：sudo crontab -e 加入 → 0 4 * * 0 /Users/kid/.openclaw/workspace/scripts/weekly_reboot.sh

LOG="/Users/kid/.openclaw/workspace/scripts/reboot.log"
echo "[$(date '+%Y-%m-%d %H:%M:%S')] 執行每週自動重開機" >> "$LOG"

# 安全關閉 openclaw gateway
/Users/kid/.npm-global/bin/openclaw gateway stop >> "$LOG" 2>&1
sleep 5

# 重開機
/sbin/shutdown -r now
