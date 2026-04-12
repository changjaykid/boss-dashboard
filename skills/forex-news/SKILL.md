---
name: forex-news
description: "Forex & index market news intelligence system. Collects, translates, and analyzes major news for XAUUSD, EUR/USD, GBP/USD, USD/JPY, US30, SPX500, NAS100. Also monitors X/Reddit discussions on AI auto-trading and forex trading bots. Use when: (1) running scheduled news update cron (08:00/20:00), (2) boss asks about forex market news, (3) updating the boss dashboard forex news section (💱 外匯保證金), (4) analyzing how news impacts our forex auto-trading system."
---

## 👤 負責人員

| 項目 | 內容 |
|------|------|
| **身份** | 外匯新聞記者 |
| **負責項目** | 外匯市場重大新聞蒐集、翻譯、影響分析 |
| **日常任務** | 蒐集 XAUUSD/EUR/GBP/JPY/US指數重大新聞 → 翻譯整理 → 分析對持倉影響 |
| **更新時間** | 每日 08:00 / 20:00（⏸️ 目前已暫停） |
| **主控板更新內容** | 新聞摘要、市場情緒、對交易策略的影響判斷、更新時間戳 |
| **驗收標準** | 重大新聞 30 分鐘內更新，每則附影響評估（利多/利空/中性） |
| **目標** | 提供外匯交易員可直接參考的即時情報 |

---

# Forex News Intelligence

## Overview

24 小時國內外外匯/指數市場重大新聞蒐集、翻譯、解析系統。每 12 小時更新一次，提供老闆完整的市場資訊 + AI 自動交易社群動態 + 對我們系統的優化建議。

## Schedule

- **08:00 (Asia/Taipei)**: 早盤更新（涵蓋美盤收盤 + 亞洲開盤動態）
- **20:00 (Asia/Taipei)**: 晚盤更新（涵蓋歐洲盤 + 美盤開盤動態）
- Cron: `0 8,20 * * *`

## Output

寫入 `boss-dashboard/forex-news.json`，主控版 💱 外匯保證金區塊讀取顯示。

---

## 🚨 紅線規則

> **絕對禁止模型自行編造任何匯率、價格、指數數字。**
>
> 所有價格、匯率、漲跌幅數字必須來自腳本 (`update_forex_prices.py`) 或可驗證的 API。
> 模型只負責新聞蒐集、翻譯、分析、社群整理。如果腳本執行失敗，價格欄位保留 `N/A`，不可用猜測值填入。

### 欄位分類

| 標記 | 類型 | 欄位 | 規則 |
|------|------|------|------|
| 🔒 | 腳本產生（不可編） | `prices.*`（所有價格、匯率、漲跌幅、漲跌數字） | 只能由 `update_forex_prices.py` 寫入 |
| ✏️ | 模型產生（可以寫） | `news[]`、`socialDiscussions[]`、`conclusion` | 用 web_search + web_fetch 蒐集，模型分析撰寫 |
| ✏️ | 模型產生（可以寫） | `lastUpdate`、`updateCycle` | 模型更新時間戳 |

---

## Workflow

### ⚡ Step 0：執行價格抓取腳本（必要前置步驟）

**每次更新前必須先執行此步驟，不可跳過。**

```bash
python3 skills/forex-news/scripts/update_forex_prices.py
```

腳本會：
1. 從 Yahoo Finance 抓取 9 個商品的即時/收盤價
2. 讀取現有 `boss-dashboard/forex-news.json`
3. 只更新 `prices` 區塊，不動新聞/討論/總結
4. 寫回 JSON

確認輸出中所有商品都顯示 ✅。如有 ❌，記錄失敗商品但繼續後續步驟。

**監控的商品（9 個）**：
- XAUUSD（黃金）、EUR/USD、GBP/USD、USD/JPY
- US30（道瓊）、SPX500（標普）、NAS100（那斯達克100期）
- DXY（美元指數）、US10Y（美國10年期殖利率）

### Step 1：蒐集重大新聞（5 則）

**來源**（依優先順序搜尋）：
- 財經新聞網站：Reuters, Bloomberg, CNBC, FXStreet, DailyFX, Investing.com
- 國內：鉅亨網, MoneyDJ, 經濟日報
- 央行官網：Fed, ECB, BOE, BOJ

**搜尋關鍵字**：
- `XAUUSD gold price` / `黃金價格`
- `EUR/USD euro dollar` / `歐元美元`
- `GBP/USD pound` / `英鎊`
- `USD/JPY yen` / `日圓`
- `US30 Dow Jones` / `道瓊`
- `S&P 500 SPX` / `標普500`
- `Nasdaq 100 NAS100` / `那斯達克`
- `Federal Reserve interest rate` / `聯準會利率`
- `CPI inflation` / `通膨`
- `NFP jobs` / `非農就業`

**每則新聞格式**：
```json
{
  "title": "聯準會暗示六月可能降息，美元指數跳水",
  "source": "Reuters",
  "time": "2026-03-31 15:00 UTC",
  "summary": "重點大意（2-3句）",
  "analysis": "我的解析：對哪些商品有什麼影響，交易上該注意什麼",
  "impact": {
    "instruments": ["GOLD", "EURUSDM2026", "USDJPYM2026"],
    "direction": "美元走弱 → 金價利多、EUR/USD 利多、USD/JPY 利空",
    "severity": "high"
  }
}
```

**篩選標準**：
- 優先選擇對我們監控的 7 個商品有直接影響的新聞
- 英文來源全部翻譯成中文
- severity 分三級：high（會造成大波動）、medium（有影響但有限）、low（背景資訊）

### Step 2：X / Reddit 熱門討論

**搜尋關鍵字**：
- X: `forex trading bot`, `forex algorithm`, `AI forex trading`, `automated forex`, `gold trading bot`, `forex EA`
- Reddit: r/algotrading, r/Forex, r/Trading → 搜 `bot`, `algorithm`, `automated`, `AI trading`

**每則討論格式**：
```json
{
  "platform": "X" | "Reddit",
  "title": "討論標題或推文摘要",
  "author": "@username 或 u/username",
  "summary": "內容大意",
  "whatTheyDid": "他做了什麼（用了什麼策略/工具/方法）",
  "whatWeCanLearn": "我們可以參考什麼（具體可執行的建議）",
  "url": "原文連結"
}
```

**數量**：每次更新至少 3-5 則有價值的討論

### Step 3：總結 — 我們可以怎麼優化

根據本次蒐集的新聞和討論，提出具體的優化建議：

```json
{
  "marketOutlook": "目前市場狀態和未來 12-24 小時展望",
  "tradingImplications": [
    "根據新聞，GOLD 可能繼續上漲，建議多頭策略加權",
    "Fed 講話前後波動大，建議 UTC 18:00-20:00 減少開倉"
  ],
  "systemOptimization": [
    "Reddit 上有人分享用 mean reversion + volume filter 在 GOLD 上勝率 65%，可以參考加入回測",
    "建議加入 news sentiment scoring，重大利空自動暫停做多"
  ]
}
```

### Step 4：寫入 JSON

讀取 `boss-dashboard/forex-news.json`（此時已包含 Step 0 寫入的 prices），更新以下 ✏️ 欄位：
- `news[]` — Step 1 的新聞
- `socialDiscussions[]` — Step 2 的討論
- `conclusion` — Step 3 的總結
- `lastUpdate` — 當前時間
- `updateCycle` — "08:00/20:00"

**⚠️ 不可覆蓋 `prices` 區塊！** 用 read → merge → write 方式更新。

---

## Complete JSON Output Structure

```json
{
  "lastUpdate": "2026-03-31 20:00:00",
  "updateCycle": "08:00/20:00",
  "prices": {
    "fetchedAt": "2026-03-31 19:58:00",
    "source": "Yahoo Finance (yfinance)",
    "instruments": {
      "XAUUSD": { "key": "XAUUSD", "label": "黃金 XAUUSD", "unit": "USD/oz", "price": 3085.20, "change": 12.50, "changePercent": "+0.41%", "symbol": "GC=F", "fetchedAt": "..." },
      "EURUSD": { "...": "..." },
      "GBPUSD": { "...": "..." },
      "USDJPY": { "...": "..." },
      "US30":   { "...": "..." },
      "SPX500": { "...": "..." },
      "NAS100": { "...": "..." },
      "DXY":    { "...": "..." },
      "US10Y":  { "...": "..." }
    }
  },
  "news": [
    { "title": "...", "source": "...", "time": "...", "summary": "...", "analysis": "...", "impact": {"instruments": [], "direction": "", "severity": ""} }
  ],
  "socialDiscussions": [
    { "platform": "...", "title": "...", "author": "...", "summary": "...", "whatTheyDid": "...", "whatWeCanLearn": "...", "url": "..." }
  ],
  "conclusion": {
    "marketOutlook": "...",
    "tradingImplications": ["..."],
    "systemOptimization": ["..."]
  }
}
```

## Key Rules

1. **🔒 價格數字只能來自腳本**，絕對禁止模型編造
2. **全部中文**，英文來源翻譯
3. **每 12 小時 5 則新聞** + 3-5 則社群討論 + 1 份總結
4. **聚焦 9 個商品**：XAUUSD, EUR/USD, GBP/USD, USD/JPY, US30, SPX500, NAS100, DXY, US10Y
5. **解析要有觀點**，不是只翻譯，要說對交易有什麼影響
6. **總結要可執行**，不是空話，要能直接拿來優化系統
7. **寫入 forex-news.json**，不動其他 JSON 檔案
8. 使用 web_search + web_fetch 工具蒐集新聞資訊
9. **Step 0 不可跳過** — 每次更新必須先跑價格腳本
