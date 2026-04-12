#!/bin/bash
# backup-to-gdrive.sh - 備份 boss-dashboard 資料到 Google Drive
# 目標資料夾 ID: 1sGIdASzk2-zWl749QU7E8ScECr2N6zK3
# 
# 使用前請先設定 gog auth：
#   gog auth credentials /path/to/client_secret.json
#   gog auth add your@gmail.com --services drive
#   export GOG_ACCOUNT=your@gmail.com
#
# 用法: ./backup-to-gdrive.sh [--account your@gmail.com]

set -euo pipefail

FOLDER_ID="1sGIdASzk2-zWl749QU7E8ScECr2N6zK3"
DASHBOARD_DIR="/Users/kid/.openclaw/workspace/boss-dashboard"
ACCOUNT_FLAG=""

if [ "${1:-}" = "--account" ] && [ -n "${2:-}" ]; then
  ACCOUNT_FLAG="--account $2"
fi

FILES=(
  "trading-data.json"
  "crypto-trading-data.json"
  "forex-news.json"
  "crypto-news.json"
  "social-data.json"
  "index.html"
)

echo "🔄 開始備份 boss-dashboard 到 Google Drive..."
echo "📁 目標資料夾: $FOLDER_ID"
echo ""

SUCCESS=0
FAIL=0

for file in "${FILES[@]}"; do
  filepath="$DASHBOARD_DIR/$file"
  if [ -f "$filepath" ]; then
    echo -n "  📤 上傳 $file ... "
    if gog drive upload "$filepath" --parent "$FOLDER_ID" $ACCOUNT_FLAG --json 2>/dev/null; then
      echo "✅"
      ((SUCCESS++))
    else
      echo "❌"
      ((FAIL++))
    fi
  else
    echo "  ⚠️ 跳過 $file（檔案不存在）"
  fi
done

echo ""
echo "📊 備份結果: ${SUCCESS} 成功, ${FAIL} 失敗"
echo "⏰ 完成時間: $(date '+%Y-%m-%d %H:%M:%S')"
