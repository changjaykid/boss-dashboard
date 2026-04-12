---
name: stock-analysis
description: "Taiwan stock market (TWSE) analysis system. Covers pre-market briefing, intraday monitoring, post-market review, stock picks, and sector analysis. Use when: (1) running stock-daily cron (08:00), (2) boss asks about Taiwan stocks or market conditions, (3) updating the boss dashboard stocks section (📈 股票專案), (4) analyzing individual stocks, (5) recommending stocks (AI concept, high dividend, ETF, under NT$50). NOT for forex or crypto (those have separate skills)."
---

## 👤 負責人員

| 項目 | 內容 |
|------|------|
| **身份** | 股票分析師 |
| **負責項目** | 台股大盤分析、個股推薦、盤後復盤 |
| **日常任務** | 盤前蒐集消息分析大盤走勢 → 推薦 2-3 檔個股 → 盤後檢視漲跌復盤 |
| **更新時間** | 每日 08:00（盤前）、14:30（盤後），週一到五 |
| **主控板更新內容** | 大盤分析摘要、推薦個股清單、盤後漲跌復盤、更新時間戳 |
| **驗收標準** | 週命中 ≥1 檔漲 3%+，推薦勝率 ≥ 50%，報告準時不遲到 |
| **目標** | 提供可操作的選股建議，幫老闆掌握台股機會 |

---

# Stock Analysis System — 台股專案

## Overview

台股盤前整理、盤中監控、收盤復盤的完整分析系統。每日提供精選 16 檔個股觀察清單 + AI 概念股 / 高股息 / ETF 各 8 檔獨立推薦，幫老闆掌握市場、發現機會。

**老闆有在操作台股**，未來可能串自動交易。

## 🚨 紅線規則（最高優先）

> **絕對禁止模型自行編造任何數字、價格、漲跌幅、成交量。**
> 所有數字資料必須來自腳本（Yahoo Finance）或 web 搜尋的真實來源。
> 如果腳本抓取失敗，該欄位標示 `"N/A"`，不可猜測。

## ⚠️ 寫入規則（最高優先）

> **必須用 `write` 工具整個覆寫 stock-data.json，絕對禁止用 `edit` 做局部替換！**
> edit 工具在大 JSON 上容易 oldText 對不準導致 Edit failed。
> 這條規則不可違反，不可嘗試用 edit，不可「先試 edit 失敗再改 write」。

## 欄位分類

| 類型 | 欄位 | 來源 |
|------|------|------|
| 🔒 腳本產生（不可編） | price, close, change, changePct, volume, 油價, ADR, 美股指數, pe, pb, dividendYield, lastDividendPerShare, exDividendDate | `scripts/update_stock_prices.py` |
| 🔒 搜尋取得（不可編） | 三大法人買賣超數字, 融資融券數字, 券資比, ETF成份股, ETF折溢價, 除息日行事曆 | web_search 鉅亨網/TWSE/Goodinfo |
| ✏️ 模型分析（可以寫） | reason, buyReason, technical, analysis, keyEvents, outlook, sectorStrength status, target, stopLoss, category, peExplain, pbExplain, marginExplain, premiumExplain, foreignConsecutiveDays | 模型根據真實數據分析 |

## Scripts

| 腳本 | 功能 | 執行方式 |
|------|------|---------|
| `scripts/update_stock_prices.py` | 從 Yahoo Finance 抓取所有股票/指數/油價/本益比/殖利率真實數據 | `python3 scripts/update_stock_prices.py` |
| `scripts/track_recommendations.py` | 推薦覆盤追蹤：記錄快照、追蹤達標/停損、計算準確率 | `python3 scripts/track_recommendations.py` |
| `scripts/track_recommendations.py --snapshot` | 記錄今日推薦快照（盤前跑一次） | 盤前整理完成後執行 |

- `update_stock_prices.py`：更新 `boss-dashboard/stock-data.json` 中所有 🔒 欄位（價格 + 基本面數據），不動分析內容
- `track_recommendations.py`：追蹤歷史推薦績效，結果寫回 `selfReview` 欄位 + 存入 `track_history.json`
- 上櫃股（如 6547 高端疫苗、3529 力旺）自動使用 `.TWO` 後綴

## Schedule

| 時間 | 任務 | 說明 |
|------|------|------|
| 08:00 | 盤前整理 | cron: stock-daily |
| 09:00-13:30 | 盤中監控 | heartbeat 觸發 |
| 14:00 | 收盤復盤 | heartbeat 或 cron |

台股交易時間：週一到週五 09:00-13:30（Asia/Taipei）

## Output

寫入 `boss-dashboard/stock-data.json`（如不存在則建立），主控版 📈 股票專案區塊讀取。

## Workflow

### Step 0. 必要前置（不可跳過）

**每次更新 stock-data.json 前，必須先執行：**

```bash
python3 /Users/kid/.openclaw/workspace/skills/stock-analysis/scripts/update_stock_prices.py
```

這會從 Yahoo Finance 抓取所有股票、指數、油價、本益比、殖利率的真實數據並寫入 JSON。

**執行完畢後才可以進行後續分析步驟。**

### 1. 盤前整理（08:00 cron）

**推薦覆盤（每日必做）**：
```bash
python3 /Users/kid/.openclaw/workspace/skills/stock-analysis/scripts/track_recommendations.py
```
- 自動抓取昨日推薦股的最新價格
- 判斷是否達標或停損
- 更新 selfReview 準確率
- 如果準確率持續低於 50%，必須在 analysis 中反省選股邏輯並調整策略

**然後記錄今日新推薦快照**：
```bash
python3 /Users/kid/.openclaw/workspace/skills/stock-analysis/scripts/track_recommendations.py --snapshot
```

**美股隔夜表現**（數字已由 Step 0 腳本填入，只需寫分析）：
- 道瓊（DJIA）、S&P 500、Nasdaq 收盤漲跌 — 看 JSON 中已有的數字
- 影響台股的美股重點事件 — web_search 搜尋

**台股預判**：
- 台指期夜盤收盤（預判開盤方向）— web_search 搜尋
- ADR（台積電 ADR）— 已由腳本填入
- 亞洲鄰近市場（日經、韓國）— web_search 搜尋

**今日重要事件**：
- 財報公布、除權息日、法說會
- 國內外經濟數據（GDP、CPI、PMI、央行會議）
- 搜尋鉅亨網、MoneyDJ 當日重要事件 — web_search + web_fetch

**大盤技術面**（分析文字，非數字）：
- 加權指數支撐壓力位
- 均線位置（5MA/10MA/20MA/60MA）
- RSI、MACD 方向
- 量能趨勢

**精選個股觀察清單（16 檔）**：
- **總共 16 檔**，包含至少 3-4 檔 50 元以下的標的
- `price`, `pe`, `pb`, `dividendYield` 等欄位已由腳本填好
- 每檔必須寫 reason + buyReason（白話解釋為什麼值得買）+ technical + target + stopLoss + category
- 選股邏輯：技術面突破/轉強 + 基本面題材 + 法人動態

**獨立推薦區（每類 8 檔）**：
- **AI 概念股推薦**（8 檔）
- **高股息推薦**（8 檔）：殖利率 > 5%、穩定配息
- **ETF 推薦**（8 檔）：市值型、高息型、產業型
- 同上，`price` + `pe` + `pb` + `dividendYield` 已由腳本填好
- ETF 每檔需附：前五大成份股（topHoldings）、最近配息日+金額、折溢價
- 每檔加 buyReason 欄位（白話解釋為什麼推薦）

**新增欄位白話解釋規則**：
- `pe`（本益比）：模型必須附 `peExplain`（白話解釋，例如「本益比15倍代表用現在價格買，大約15年可以賺回來，跟同業比算便宜」）
- `pb`（本淨比）：模型必須附 `pbExplain`（白話解釋，例如「本淨比0.9代表股價比公司帳面資產還便宜，有折價保護」）
- `marginBalance`（融資融券）：模型必須附 `marginExplain`（白話解釋，例如「融資餘額連降3天代表散戶在賣，籌碼沉澱中」）
- ETF `premiumDiscount`（折溢價）：模型必須附 `premiumExplain`（白話解釋，例如「溢價0.5%很正常，超過2%就別追」）

**三大法人連續買賣超天數**：
- web_search 搜尋各檔的法人連續買賣超天數
- 填入 `foreignConsecutiveDays` 欄位（正數=連買，負數=連賣）
- 例如：+5 代表外資連買5天，-3 代表外資連賣3天

**除息日行事曆**：
- web_search 搜尋近期即將除息的觀察清單股票
- 填入 `upcomingExDividend` 欄位（格式："2026-04-15 配息1.5元"）
- 方便老闆提前佈局填息行情

**三大法人（web_search 抓取）**：
- 搜尋「三大法人買賣超 今日」from 鉅亨網、經濟日報
- 填入 institutional 欄位的 buy/sell/net 數字
- 搜不到就標 0 + note 說明

**融資融券（web_search 抓取）**：
- 搜尋「融資融券餘額 今日」from 鉅亨網/TWSE
- 填入 margin 欄位：marginBalance（融資餘額億元）、shortBalance（融券餘額張）、marginRatio（券資比%）
- 模型附 `marginExplain`（白話解釋目前融資融券狀況的意義）

### 2. 盤中監控（09:00-13:30）

heartbeat 觸發時，如果是台股交易時間，先跑 Step 0 更新價格，再：

- 大盤即時狀態（漲跌、成交量、漲跌家數比）
- 觀察清單 16 檔的即時表現
- 類股輪動
- **異常提醒**（觸發時 LINE 通知老闆）：
  - 觀察清單個股漲停/跌停
  - 異常爆量
  - 突破關鍵價位
  - 大盤急跌 > 200 點

### 3. 收盤復盤（14:00）

先跑 Step 0 更新收盤價，再：

**大盤總結**：
- 加權指數收盤、漲跌點數、成交量
- 三大法人買賣超 — web_search
- 融資融券變化 — web_search

**觀察清單回顧**：
- 16 檔今日表現
- 哪幾檔判斷正確、哪幾檔判斷錯誤

**明日展望** + **自我優化**

### 4. 寫入 JSON

⚠️ **必須用 `write` 工具整個覆寫 stock-data.json，絕對禁止用 `edit` 做局部替換！**

**步驟**：
1. 用 `read` 讀取現有 `boss-dashboard/stock-data.json` 取得完整 JSON
2. 在記憶中合併：保留 🔒 欄位（price, close, change, pe, pb 等，由 Step 0 腳本寫入），更新 ✏️ 欄位（analysis, reason, buyReason, peExplain 等）
3. 用 `write` 工具一次性覆寫整個 `boss-dashboard/stock-data.json`
4. 寫入後 `cd boss-dashboard && git pull --rebase && git add stock-data.json && git commit -m 'stock: update' && git push origin main`

## Dashboard JSON Structure

```json
{
  "lastUpdate": "2026-04-01 08:00:00",
  "dataSource": "Yahoo Finance (yfinance)",
  "market": {
    "taiex": { "close": 33173, "change": 1450, "changePct": 4.57, "volume": 6466 },
    "futures": { "close": 32031, "change": -449, "note": "web_search" },
    "usMarket": {
      "djia": { "close": 46341, "change": 1125, "changePct": 2.49 },
      "sp500": { "close": 6528, "change": 184, "changePct": 2.91 },
      "nasdaq": { "close": 21590, "change": 795, "changePct": 3.83 }
    },
    "tsmc_adr": { "close": 337.95, "change": 21.45 },
    "oil": { "wti": 102.89, "brent": 105.2 }
  },
  "watchlist": [
    {
      "code": "2330", "name": "台積電",
      "price": 1845,
      "pe": 25.3, "peExplain": "✏️ 白話解釋本益比",
      "pb": 6.8, "pbExplain": "✏️ 白話解釋本淨比",
      "dividendYield": 1.5,
      "lastDividendPerShare": 4.0, "exDividendDate": "2026-03-15",
      "foreignConsecutiveDays": 5,
      "upcomingExDividend": "",
      "reason": "✏️ 模型寫",
      "buyReason": "✏️ 白話解釋為什麼值得買",
      "technical": "✏️ 模型寫",
      "target": "✏️", "stopLoss": "✏️",
      "category": "AI概念"
    }
  ],
  "recommendations": {
    "ai": [{ "code": "2330", "name": "台積電", "price": 1845, "pe": 25.3, "reason": "✏️", "buyReason": "✏️" }],
    "dividend": [{ "code": "2882", "name": "國泰金", "price": 71.8, "pe": 12.1, "pb": 1.1, "dividendYield": 5.8, "lastDividendPerShare": 3.5, "exDividendDate": "2026-07-15", "reason": "✏️", "buyReason": "✏️" }],
    "etf": [{
      "code": "0050", "name": "元大台灣50", "price": 75.45,
      "dividendYield": 3.2, "lastDividendPerShare": 1.8, "exDividendDate": "2026-01-20",
      "topHoldings": "台積電(47%) 鴻海(5%) 聯發科(4%) 台達電(3%) 中華電(2%)",
      "premiumDiscount": 0.3, "premiumExplain": "✏️ 白話解釋折溢價",
      "reason": "✏️", "buyReason": "✏️"
    }]
  },
  "institutional": {
    "foreign": { "buy": 0, "sell": 0, "net": 0, "note": "web_search 取得" },
    "investment_trust": { "buy": 0, "sell": 0, "net": 0 },
    "dealer": { "buy": 0, "sell": 0, "net": 0 }
  },
  "margin": {
    "marginBalance": 0,
    "shortBalance": 0,
    "marginRatio": 0,
    "marginExplain": "✏️ 白話解釋融資融券狀況"
  },
  "analysis": { "preMarket": "✏️", "keyEvents": "✏️", "outlook": "✏️" },
  "sectorStrength": [{ "sector": "半導體", "change": 0, "status": "✏️" }],
  "selfReview": { "totalPicks": 0, "correctRate": "N/A" }
}
```

## Data Sources

- **Yahoo Finance (yfinance)**：個股報價、指數、油價、ADR、本益比、本淨比、殖利率 → 由 `scripts/update_stock_prices.py` 自動抓取
- **Web Search**：三大法人買賣超、融資融券、券資比、ETF成份股/折溢價、除息日、新聞、事件 → 用 web_search + web_fetch
- **財經新聞**：鉅亨網、MoneyDJ、經濟日報
- **Goodinfo**：個股基本面、殖利率、本益比、ETF 成份股

## Key Rules

1. **Step 0 不可跳過** — 每次都先跑腳本更新價格+基本面
2. **數字只能來自腳本或搜尋** — 不可自行編造
3. **精選 16 檔觀察清單**，含至少 3-4 檔 50 元以下
4. **AI 概念股 / 高股息 / ETF 各 8 檔獨立推薦區**
5. **每檔推薦要有 reason + buyReason（白話解釋）**
6. **本益比/本淨比/融資融券/ETF折溢價 必須附白話解釋**
7. **追蹤推薦績效**，持續自我優化
8. **盤中有異常要 LINE 通知老闆**
9. **收盤要復盤**，誠實面對判斷對錯
10. **只 git add stock-data.json**，不用 git add -A
11. **git push 前先 git pull --rebase**
12. **寫入 JSON 只能用 write，絕對禁止用 edit**
