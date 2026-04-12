#!/bin/bash
# 管家 Alert 分發器
# 掃描所有員工 outbox/ → 依據 "to" 欄位分發到目標員工 alerts/
# heartbeat 時執行

WORKSPACE="$HOME/.openclaw/workspace"
WORKERS_DIR="$WORKSPACE/workers"
DISPATCHED=0

for WORKER_DIR in "$WORKERS_DIR"/*/; do
  OUTBOX="$WORKER_DIR/outbox"
  [ -d "$OUTBOX" ] || continue
  
  for ALERT_FILE in "$OUTBOX"/*.json; do
    [ -f "$ALERT_FILE" ] || continue
    
    # 讀取目標員工
    TARGET=$(python3 -c "import json; print(json.load(open('$ALERT_FILE'))['to'])" 2>/dev/null)
    
    if [ -n "$TARGET" ] && [ -d "$WORKERS_DIR/$TARGET" ]; then
      mkdir -p "$WORKERS_DIR/$TARGET/alerts"
      mv "$ALERT_FILE" "$WORKERS_DIR/$TARGET/alerts/"
      DISPATCHED=$((DISPATCHED + 1))
      SENDER=$(basename "$WORKER_DIR")
      echo "[dispatch] $SENDER → $TARGET: $(basename $ALERT_FILE)"
    else
      echo "[dispatch] WARN: unknown target '$TARGET' in $(basename $ALERT_FILE)"
    fi
  done
done

echo "[dispatch] $DISPATCHED alerts delivered"
