#!/bin/bash
# OpenClaw Workspace Backup to Google Drive
# Backs up all critical data to ensure recovery on new machine
#
# Usage: ./backup_to_drive.sh [drive_folder_id] [account]

set -euo pipefail

DRIVE_FOLDER_ID="${1:-1sGIdASzk2-zWl749QU7E8ScECr2N6zK3}"
ACCOUNT="${2:-socialobservertw@gmail.com}"
WORKSPACE="/Users/kid/.openclaw/workspace"
OPENCLAW_DIR="/Users/kid/.openclaw"
DATE=$(date +%Y%m%d)
BACKUP_DIR="/tmp/openclaw-backup-${DATE}"
BACKUP_FILE="/tmp/openclaw-backup-${DATE}.zip"

echo "🔄 OpenClaw Backup — ${DATE}"
echo "================================"

# Clean previous
rm -rf "$BACKUP_DIR" "$BACKUP_FILE"
mkdir -p "$BACKUP_DIR"

# --- 1. Core identity & memory files ---
echo "📝 Backing up core files..."
mkdir -p "$BACKUP_DIR/workspace"
for f in AGENTS.md SOUL.md IDENTITY.md USER.md MEMORY.md HEARTBEAT.md TOOLS.md social-posting-rules.md; do
  [ -f "$WORKSPACE/$f" ] && cp "$WORKSPACE/$f" "$BACKUP_DIR/workspace/"
done

# --- 2. Memory (daily logs) ---
echo "🧠 Backing up memory..."
if [ -d "$WORKSPACE/memory" ]; then
  cp -r "$WORKSPACE/memory" "$BACKUP_DIR/workspace/memory"
fi

# --- 3. Skills (all custom skills) ---
echo "🛠️ Backing up skills..."
if [ -d "$WORKSPACE/skills" ]; then
  cp -r "$WORKSPACE/skills" "$BACKUP_DIR/workspace/skills"
fi

# --- 4. Trading configs & strategies ---
echo "📈 Backing up trading..."
mkdir -p "$BACKUP_DIR/workspace/trading"
for f in config.json crypto_config.json crypto_sim_config.json openai_config.json strategy_registry.json crypto_strategy_registry.json analyzer_v6.py auto_trader.sh; do
  [ -f "$WORKSPACE/trading/$f" ] && cp "$WORKSPACE/trading/$f" "$BACKUP_DIR/workspace/trading/"
done
# Trade logs (important for learning)
for f in trade_log.json crypto_sim_log.json crypto_sim_state.json last_report.json; do
  [ -f "$WORKSPACE/trading/$f" ] && cp "$WORKSPACE/trading/$f" "$BACKUP_DIR/workspace/trading/"
done

# --- 5. Social configs ---
echo "📱 Backing up social..."
mkdir -p "$BACKUP_DIR/workspace/social"
for f in config.json publisher.js content_engine.py; do
  [ -f "$WORKSPACE/social/$f" ] && cp "$WORKSPACE/social/$f" "$BACKUP_DIR/workspace/social/"
done
[ -d "$WORKSPACE/social/published" ] && cp -r "$WORKSPACE/social/published" "$BACKUP_DIR/workspace/social/published"

# --- 6. Dashboard ---
echo "📊 Backing up dashboard..."
mkdir -p "$BACKUP_DIR/workspace/boss-dashboard"
for f in index.html social-data.json trading-data.json crypto-trading-data.json forex-news.json crypto-news.json ad-business-data.json; do
  [ -f "$WORKSPACE/boss-dashboard/$f" ] && cp "$WORKSPACE/boss-dashboard/$f" "$BACKUP_DIR/workspace/boss-dashboard/"
done

# --- 7. OpenClaw config ---
echo "⚙️ Backing up openclaw config..."
mkdir -p "$BACKUP_DIR/openclaw-config"
[ -f "$OPENCLAW_DIR/openclaw.json" ] && cp "$OPENCLAW_DIR/openclaw.json" "$BACKUP_DIR/openclaw-config/"

# --- 8. Scripts ---
echo "📜 Backing up scripts..."
[ -d "$WORKSPACE/scripts" ] && cp -r "$WORKSPACE/scripts" "$BACKUP_DIR/workspace/scripts"

# --- 9. IG carousel data ---
# echo "🎨 Backing up ig-carousel..."
# [ -d "$WORKSPACE/ig-carousel" ] && cp -r "$WORKSPACE/ig-carousel" "$BACKUP_DIR/workspace/ig-carousel"
# [ -d "$WORKSPACE/workers/ig-carousel" ] && cp -r "$WORKSPACE/workers/ig-carousel" "$BACKUP_DIR/workspace/workers/ig-carousel"

# --- Package ---
echo ""
echo "📦 Packaging..."
cd /tmp
zip -r -q "$BACKUP_FILE" "openclaw-backup-${DATE}/"
SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "   Size: $SIZE"

# --- Upload ---
echo ""
echo "☁️ Uploading to Google Drive..."
gog drive upload "$BACKUP_FILE" --parent "$DRIVE_FOLDER_ID" --account "$ACCOUNT" 2>&1

# --- Cleanup old backups on Drive (keep last 7) ---
echo ""
echo "🧹 Cleaning up old backups (keep last 7)..."
# 使用 Python 處理 JSON 並列出需要刪除的 ID
OLD_BACKUPS=$(gog drive ls --parent "$DRIVE_FOLDER_ID" --account "$ACCOUNT" --json 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    # 支援 files 鍵名或直接是陣列
    files_list = data.get('files', data) if isinstance(data, dict) else data
    
    # 過濾出備份檔案
    backups = [f for f in files_list if f.get('name', '').startswith('openclaw-backup-')]
    
    # 按名稱降序排列（最新的在前）
    backups.sort(key=lambda x: x.get('name', ''), reverse=True)
    
    # 找出重複日期的檔案（保留最新的一個）
    seen_dates = set()
    to_delete = []
    to_keep = []
    
    for f in backups:
        name = f.get('name', '')
        # 提取日期部分 openclaw-backup-YYYYMMDD.zip
        date_part = name.split('-')[-1].split('.')[0] if '-' in name else name
        
        if date_part in seen_dates:
            to_delete.append(f['id'])
        else:
            seen_dates.add(date_part)
            to_keep.append(f)
            
    # 在不重複日期的檔案中，保留最新的 7 個，其餘刪除
    if len(to_keep) > 7:
        for f in to_keep[7:]:
            to_delete.append(f['id'])
            
    for fid in to_delete:
        print(fid)
except Exception as e:
    pass
" 2>/dev/null || true)

for fid in $OLD_BACKUPS; do
  echo "  Deleting old backup: $fid"
  gog drive rm "$fid" --account "$ACCOUNT" --force 2>/dev/null || true
done

# --- Cleanup local temp ---
rm -rf "$BACKUP_DIR" "$BACKUP_FILE"

echo ""
echo "✅ Backup complete — ${DATE}"
