#!/usr/bin/env bash
# sync_dashboards.sh — 員工 dashboard.json → boss-dashboard/ 單向同步
# 員工是來源，boss-dashboard 是複製品。

WORKSPACE="$HOME/.openclaw/workspace"
BOSS="$WORKSPACE/boss-dashboard"

# Use standard bash array/loop instead of zsh associative arrays
# Format: "worker_dir:target_file"
MAPPINGS=(
  "crypto-news:crypto-news.json"
  "forex-news:forex-news.json"
  "forex-trader:trading-data.json"
  "futures-trader:crypto-futures-data.json"
  "ig-carousel:ig-data.json"
  "money-maker:money-maker-data.json"
  "social-threads:social-data.json"
  "stock-analyst:stock-data.json"
)

cd "$BOSS" && git pull --rebase 2>/dev/null

CHANGED=0
for item in "${MAPPINGS[@]}"; do
  worker="${item%%:*}"
  target="${item##*:}"
  
  src="$WORKSPACE/workers/${worker}/dashboard.json"
  dst="$BOSS/${target}"
  if [ -f "$src" ]; then
    if ! diff -q "$src" "$dst" >/dev/null 2>&1; then
      cp "$src" "$dst"
      CHANGED=$((CHANGED + 1))
    fi
  fi
done

if [ $CHANGED -gt 0 ]; then
  cd "$BOSS" && git add -A && git commit -m "sync: ${CHANGED} worker dashboards $(date '+%H:%M')" && git push origin main 2>/dev/null
  echo "[sync] $CHANGED dashboards updated and pushed"
else
  echo "[sync] no changes"
fi
