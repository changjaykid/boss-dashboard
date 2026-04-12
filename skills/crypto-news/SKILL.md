---
name: crypto-news
description: "Cryptocurrency market news intelligence system. Collects, translates, and analyzes major news for BTC, ETH, and important altcoins. Also monitors X/Reddit discussions on AI crypto trading and trading bots. Use when: (1) running scheduled news update cron (08:00/20:00), (2) boss asks about crypto market news, (3) updating the boss dashboard crypto news section (🪙 虛擬貨幣), (4) analyzing how news impacts our crypto auto-trading system."
---

## 👤 負責人員

| 項目 | 內容 |
|------|------|
| **身份** | 幣圈新聞記者 |
| **負責項目** | BTC/ETH/主流幣新聞 + X/Reddit 社群情緒監控 |
| **日常任務** | 蒐集幣圈重大新聞 → 翻譯 → 分析價格影響 → 監控社群情緒 |
| **更新時間** | 每日 08:00 / 20:00（⏸️ 目前已暫停） |
| **主控板更新內容** | 新聞摘要、情緒指標、對交易系統的建議、更新時間戳 |
| **驗收標準** | 重大事件即時更新，情緒分析方向正確率 ≥ 60% |
| **目標** | 提供交易引擎可參考的情報，幫老闆掌握幣圈動態 |

---

# Crypto News Intelligence

## Overview

24 小時國內外虛擬貨幣市場重大新聞蒐集、翻譯、解析系統。每 12 小時更新一次，提供老闆完整的幣圈資訊 + AI 自動交易社群動態 + 對我們系統的優化建議。

## Schedule

- **08:00 (Asia/Taipei)**: 早盤更新
- **20:00 (Asia/Taipei)**: 晚盤更新
- Cron: `0 8,20 * * *`

## Output

寫入 `boss-dashboard/crypto-news.json`，主控版 🪙 虛擬貨幣區塊讀取顯示。

---

## 🚨 紅線規則

> **絕對禁止模型自行編造任何幣價、漲跌幅數字。**
> 所有價格、漲跌幅、恐懼貪婪指數必須且只能來自腳本 `update_crypto_prices.py` 的輸出。
> 如果腳本抓不到，該欄位標 `"N/A"`，不可用「大約」「估計」「目前約」等方式自行填寫。

## 欄位分類

| 類型 | 欄位 | 來源 |
|------|------|------|
| 🔒 腳本產生（不可編） | `prices.*`：所有幣價、漲跌幅、USD/TWD 匯率、恐懼貪婪指數 | `update_crypto_prices.py` |
| ✏️ 模型產生（可以寫） | `news`：新聞標題、摘要、分析 | web_search + web_fetch |
| ✏️ 模型產生（可以寫） | `socialDiscussions`：社群討論整理 | web_search + web_fetch |
| ✏️ 模型產生（可以寫） | `conclusion`：市場展望、交易建議、系統優化 | 模型分析 |
| ✏️ 模型產生（可以寫） | `lastUpdate`、`updateCycle` | 模型填入當前時間 |

---

## Workflow

### Step 0（必要前置）：執行價格抓取腳本

**每次更新前，必須先跑此腳本，不可跳過。**

```bash
python3 skills/crypto-news/scripts/update_crypto_prices.py --json-path boss-dashboard/crypto-news.json
```

腳本會：
- 從 Yahoo Finance 抓取 BTC、ETH、SOL、DOGE 的 USD 價格 + USD/TWD 匯率
- 換算 BTC/TWD、ETH/TWD
- 從 alternative.me 抓取恐懼貪婪指數
- **只更新 `prices` 欄位**，不動新聞等其他內容
- 抓不到的標 `"N/A"`

確認腳本輸出 `✅ 完成！` 後再進行下一步。如果腳本報錯，先排除問題再繼續。

### Step 1：蒐集重大新聞（5 則）

**來源**（依優先順序搜尋）：
- 幣圈媒體：CoinDesk, CoinTelegraph, The Block, Decrypt, CryptoSlate
- 國內：動區 BlockTempo, 鏈新聞 ABMedia, 桑幣筆記
- 交易所公告：Binance, MAX, Coinbase
- 鏈上數據：Glassnode, CryptoQuant（如有重大指標變化）

**搜尋關鍵字**：
- `Bitcoin BTC price` / `比特幣價格`
- `Ethereum ETH` / `以太幣`
- `crypto regulation SEC` / `加密貨幣監管`
- `Bitcoin ETF` / `比特幣 ETF`
- `altcoin rally` / `山寨幣`
- `SOL Solana` / `DOGE Dogecoin`
- `crypto hack exploit` / `交易所駭客`
- `whale transaction` / `巨鯨動態`
- `DeFi TVL` / `DeFi 鎖倉量`

**每則新聞格式**：
```json
{
  "title": "比特幣突破 10 萬美元，機構資金持續流入 ETF",
  "source": "CoinDesk",
  "time": "2026-03-31 14:00 UTC",
  "summary": "重點大意（2-3句）",
  "analysis": "我的解析：對 BTC/ETH/山寨幣的影響，交易上該注意什麼",
  "impact": {
    "coins": ["BTC", "ETH"],
    "direction": "BTC 利多，可能帶動 ETH 和山寨幣跟漲",
    "severity": "high"
  }
}
```

**篩選標準**：
- 優先選擇對 BTC、ETH 有直接影響的新聞
- 重大山寨幣事件也要（SOL 升級、DOGE 名人喊單等）
- 監管新聞必收（SEC、CFTC、EU MiCA、各國政策）
- 英文來源全部翻譯成中文
- severity 分三級：high / medium / low

### Step 2：X / Reddit 熱門討論

**搜尋關鍵字**：
- X: `crypto trading bot`, `Bitcoin algo trading`, `AI crypto trader`, `automated crypto`, `DeFi bot`, `MEV bot`
- Reddit: r/CryptoCurrency, r/algotrading, r/Bitcoin → 搜 `bot`, `algorithm`, `automated`, `AI trading`, `trading strategy`

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

```json
{
  "marketOutlook": "目前幣市狀態和未來 12-24 小時展望",
  "tradingImplications": [
    "BTC 突破關鍵壓力位，建議多頭策略加權",
    "ETH 合併升級倒數，波動可能加大，收緊止損"
  ],
  "systemOptimization": [
    "X 上有人分享用 funding rate + RSI 做反向交易，勝率不錯，可以回測",
    "建議加入恐懼貪婪指數作為整體市場偏多偏空的背景濾鏡"
  ]
}
```

### Step 4：寫入 JSON

讀取 `boss-dashboard/crypto-news.json`（Step 0 已寫入 prices），更新以下欄位：
- `lastUpdate` — 當前時間
- `updateCycle` — `"08:00/20:00"`
- `news` — Step 1 的新聞
- `socialDiscussions` — Step 2 的討論
- `conclusion` — Step 3 的總結
- **不動 `prices` 欄位**（已由腳本寫入）

---

## Complete JSON Output Structure

```json
{
  "lastUpdate": "2026-03-31 20:00:00",
  "updateCycle": "08:00/20:00",
  "prices": {
    "fetchedAt": "2026-03-31 20:00:05",
    "source": "Yahoo Finance + alternative.me",
    "BTC_USD": { "price": 68071.55, "change_pct": -0.2 },
    "ETH_USD": { "price": 2100.95, "change_pct": -0.13 },
    "SOL_USD": { "price": 83.34, "change_pct": 0.29 },
    "DOGE_USD": { "price": 0.0923, "change_pct": 0.13 },
    "BTC_TWD": { "price": 2174478, "change_pct": -0.2 },
    "ETH_TWD": { "price": 67113, "change_pct": -0.13 },
    "USD_TWD": { "price": 31.944, "change_pct": 0.02 },
    "fearGreedIndex": { "value": 25, "classification": "Extreme Fear" }
  },
  "news": [
    { "title": "...", "source": "...", "time": "...", "summary": "...", "analysis": "...", "impact": {"coins": [], "direction": "...", "severity": "..."} }
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

1. **全部中文**，英文來源翻譯
2. **每 12 小時 5 則新聞** + 3-5 則社群討論 + 1 份總結
3. **聚焦 BTC、ETH + 重要山寨幣**
4. **解析要有觀點**，不是只翻譯，要說對交易有什麼影響
5. **總結要可執行**，能直接拿來優化我們的虛擬貨幣自動交易系統
6. **寫入 crypto-news.json**，不動其他 JSON 檔案
7. 使用 web_search + web_fetch 工具蒐集資訊
8. **幣圈特有關注點**：鏈上數據異常、巨鯨動態、交易所資金流、恐懼貪婪指數變化
9. **🔒 所有幣價數字只來自腳本**，模型不可自行編造或估算任何價格
10. **Step 0 不可跳過**，每次更新必須先跑價格腳本
