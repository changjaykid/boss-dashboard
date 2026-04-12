# Workers Protocol — 員工自治架構

## 每個員工資料夾結構

```
workers/{worker-name}/
├── engine/           # 執行引擎（腳本、程式）
├── data/             # 運行資料（state, logs, trade records）
├── dashboard.json    # 主控版輸出（統一格式，員工自己更新）
├── memory.md         # 員工記憶（上次做了什麼、重要事件）
├── lessons.md        # 學到的教訓（策略調整、錯誤修正）
├── alerts/           # 收到的警報（來自其他員工）
│   └── *.json
└── outbox/           # 要發給其他員工的警報
    └── *.json
```

## dashboard.json 統一格式

```json
{
  "worker": "forex-trader",
  "updatedAt": "2026-04-06T20:00:00+08:00",
  "status": "RUNNING | STANDBY | ERROR | PAUSED",
  "health": "OK | WARN | ERROR",
  "lastError": null,
  "lastRun": "2026-04-06T20:00:00+08:00",
  "nextRun": "2026-04-06T20:10:00+08:00",
  "summary": "一句話摘要，給老闆看的",
  "data": {}
}
```

## 員工 cron 標準流程

```
1. 讀取 memory.md + lessons.md（知道上次做了什麼）
2. 讀取 alerts/ 資料夾（看其他員工有沒有傳話）
3. 執行核心任務
4. 更新 dashboard.json
5. 更新 memory.md（記錄這次做了什麼）
6. 如果有重要發現 → 寫入 outbox/（給其他員工）
7. 如果失敗 → 自動重試 1 次 → 仍失敗 → dashboard.json status=ERROR
```

## 員工間傳話機制

```
發送方：寫入自己的 outbox/{target}-{timestamp}.json
管家（heartbeat）：定期掃所有 outbox/ → 分發到對應 alerts/
接收方：下次 cron 讀取 alerts/ → 處理 → 刪除
```

alert 格式：
```json
{
  "from": "forex-news",
  "to": "forex-trader",
  "type": "MARKET_EVENT",
  "urgency": "high | medium | low",
  "timestamp": "2026-04-06T20:00:00+08:00",
  "payload": {
    "event": "Fed rate decision hawkish",
    "impact": "bearish_gold",
    "suggestion": "考慮減少 XAUUSD 多單"
  }
}
```

## 自愈規則

- 單次失敗：自動重試 1 次
- 連續 3 次失敗：status=ERROR，等管家介入
- 交易類錯誤：立即停機，不重試（真金白銀）
- 非交易類錯誤（新聞抓取、社群同步）：可重試

## 記憶規則

### memory.md
- 記錄最近 3 次執行的關鍵動作和結果
- 超過 3 次的舊紀錄移到 data/history/
- 格式自由，但要簡潔

### lessons.md
- 長期教訓，不輕易刪除
- 每次策略調整的原因和結果
- 員工自己寫，管家審核
