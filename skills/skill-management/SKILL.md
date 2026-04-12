---
name: skill-management
description: "Manage, monitor, and optimize all installed OpenClaw skills. Tracks skill status, cron health, usage, and provides optimization suggestions. Use when: (1) boss asks about installed skills or their status, (2) updating the boss dashboard skills section (🛠️ 技能專案), (3) diagnosing cron errors or skill issues, (4) reviewing which skills are active/idle, (5) suggesting new skills or improvements, (6) periodic skill health check during heartbeat."
---

## 👤 負責人員

| 項目 | 內容 |
|------|------|
| **身份** | 系統管理員 |
| **負責項目** | 所有 Skill 與 Cron 健康監控、優化 |
| **日常任務** | 每日 06:00 檢查所有 cron 執行紀錄 → 掃描 dashboard 更新時間 → 診斷異常 → 修復 → 建議優化 |
| **更新時間** | 每日 06:00 健檢 |
| **主控板更新內容** | 各 Skill 狀態、Cron 成功率、異常紀錄、優化建議、更新時間戳 |
| **驗收標準** | 系統 99% 正常運行率，異常 1 小時內修復 |
| **目標** | 確保所有系統 24/7 穩定運作，持續降低 token 消耗 |

---

# Skill Management System — 技能專案

## Overview

管理、監控、優化所有已安裝的 skill。讓老闆在主控版一目了然所有技能的狀態、健康度、使用情況。

## Skill Categories

### 🔧 我們自己寫的 Skill（客製化）

| Skill | 對應項目 | 能做什麼 | Cron |
|-------|---------|---------|------|
| forex-auto-trading | 🤖 外匯自動交易 | 24/5 自動分析市場、15 策略模組化下單、P/L 追蹤、自動復盤優化、主控版完整報告 | */10 weekdays |
| crypto-auto-trading | 🤖 虛擬貨幣自動交易 | 24/7 自動分析幣市、15 策略模組化、BTC 關聯性保護、移動止盈、自動復盤、主控版報告 | */2 全天 |
| forex-news | 💱 外匯保證金 | 每 12H 蒐集 5 則外匯重大新聞（XAUUSD/EUR/GBP/JPY/US30/SPX/NAS100）、X/Reddit AI 交易討論、總結優化建議，全中文 | 08:00/20:00 |
| crypto-news | 🪙 虛擬貨幣 | 每 12H 蒐集 5 則幣圈重大新聞（BTC/ETH/山寨幣）、X/Reddit AI 交易討論、總結優化建議，全中文 | 08:00/20:00 |
| social-posting | 🌐 社群專案 | 每日 2 篇 Threads 草稿、12 主題輪替、品質 checklist、老闆審核後自動發文（Threads API）、主控版管理 | 11:00/18:00 |
| stock-analysis | 📈 股票專案 | 盤前整理（美股隔夜+台股預判+10 檔精選）、AI 概念股/高股息/ETF 推薦、盤中監控、收盤復盤、推薦績效追蹤 | 08:00 daily |
| skill-management | 🛠️ 技能專案 | 監控所有 skill 和 cron 健康度、每日搜尋好用新 skill 推薦安裝、追蹤使用狀況、優化建議 | heartbeat |

### 📦 安裝的第三方 Skill

**交易/分析工具**
| Skill | 能做什麼 |
|-------|---------|
| stock-market-pro | Yahoo Finance 股票分析：報價、基本面、技術指標圖表（RSI/MACD/BB/VWAP）、ASCII 趨勢圖 |

**網頁/自動化工具**
| Skill | 能做什麼 |
|-------|---------|
| agent-browser | 控制無頭瀏覽器：開網頁、點擊、打字、截圖，可以自動操作網站 |
| desktop-control | 控制桌面：滑鼠、鍵盤、螢幕截圖，自動化桌面操作 |
| auto-workflow | 把重複任務變成自動化工作流 |
| automation-workflows | 設計跨工具自動化流程（Zapier/Make/n8n 風格） |

**內容/創作工具**
| Skill | 能做什麼 |
|-------|---------|
| nano-banana-pro | AI 圖片生成（Gemini 3 Pro），支援文生圖、圖生圖、1K/2K/4K |
| remotion-video-toolkit | 程式化製作影片（React + Remotion），適合數據驅動影片 |
| copywriting | 寫銷售文案：標題、CTA、產品描述、廣告文案、email，套用 AIDA/PAS/FAB 公式 |
| sag | ElevenLabs 語音合成，把文字變成語音 |
| summarize | 摘要工具：網頁、PDF、圖片、音檔、YouTube 影片都能摘要 |

**Google / 通訊工具**
| Skill | 能做什麼 |
|-------|---------|
| gog | Google Workspace 操作：Gmail 收發信、Calendar 排程、Drive 檔案、Sheets、Docs、Contacts |

**自我優化**
| Skill | 能做什麼 |
|-------|---------|
| self-improving | 從錯誤中學習，記錄教訓避免重複犯錯 |
| self-evolving-skill | 根據使用情況自動進化 skill 內容 |
| proactive-agent | 主動預測需求、不等指令就先做事 |
| cron-mastery | 排程管理專家，正確設定 cron 和 heartbeat |

**Skill 管理**
| Skill | 能做什麼 |
|-------|---------|
| skill-builder | 建立高品質新 skill |
| skill-vetter | 安裝前安全審查 skill，檢查有沒有惡意行為 |
| find-skills | 搜尋 ClawHub 上的新 skill |
| freeride | 管理免費 AI 模型（OpenRouter），省錢 |

## Monitoring

### Cron Health Check

掃描所有 cron job 狀態：

```bash
openclaw cron list
```

檢查項目：
- status = ok → 正常
- status = error → 需要修復，查 log 找原因
- 長時間沒跑 → 可能被 disable 或有問題

### Skill Health Indicators

| 狀態 | 定義 | 顏色 |
|------|------|------|
| 🟢 運行中 | 有 cron 且正常執行 | green |
| 🔵 待命 | 沒有 cron，按需使用，正常 | blue |
| 🟡 注意 | cron 最近有 error，但還在跑 | yellow |
| 🔴 異常 | cron 連續 error 或完全停止 | red |
| ⚪ 閒置 | 超過 7 天沒使用 | gray |

### Log Files to Monitor

| Skill | Log |
|-------|-----|
| forex-auto-trading | trading/cron.log |
| crypto-auto-trading | trading/crypto_sim_cron.log |
| forex-news + crypto-news | trading/news_cron.log |
| social-posting | cron runs (openclaw cron runs) |
| stock-analysis | cron runs (openclaw cron runs) |
| ad-business | trading/ad_business_cron.log |

## Dashboard JSON Structure

寫入 `boss-dashboard/skills-data.json`

```json
{
  "lastUpdate": "2026-03-31 22:00:00",
  "summary": {
    "totalSkills": 28,
    "categories": {
      "trading": 3,
      "news": 3,
      "social": 1,
      "tools": 8,
      "selfOptimization": 6,
      "search": 4,
      "other": 3
    },
    "cronJobs": {
      "total": 8,
      "healthy": 6,
      "error": 1,
      "disabled": 1
    }
  },
  "skills": [
    {
      "name": "forex-auto-trading",
      "category": "trading",
      "status": "running",
      "cron": "*/10 * * * 1-5",
      "lastRun": "2026-03-31 21:50:00",
      "health": "green",
      "notes": "v6 引擎，15策略模組化"
    }
  ],
  "cronHealth": [
    {
      "name": "forex-auto-trader",
      "schedule": "*/10 weekdays",
      "status": "ok",
      "lastRun": "...",
      "lastError": null
    }
  ],
  "recentChanges": [
    "2026-03-31: 建立 forex-auto-trading, crypto-auto-trading, forex-news, crypto-news, social-posting, stock-analysis skill"
  ],
  "suggestions": [
    "ad-business-scanner 品質需優化：目前抓到的 leads 多為新聞而非真人發案",
    "建議為社群專案IG建立獨立 skill（目前 IG 暫停中）"
  ]
}
```

## Periodic Tasks

### 每日新 Skill 搜尋
1. 用 `openclaw skills search` 搜尋以下關鍵字：
   - `image`、`video`、`design`（做圖做影片）
   - `forex`、`trading`、`crypto`（交易相關）
   - `money`、`revenue`、`profit`（賺錢相關）
   - `automation`、`workflow`（自動化）
   - `social`、`marketing`、`seo`（社群行銷）
2. 過濾出有價值的新 skill
3. 每則推薦包含：名稱、能做什麼、對我們有什麼用、要不要裝
4. 放進 skills-data.json 的 `recommendations` 欄位
5. 有特別好的才 LINE 通知老闆

### Heartbeat 檢查（每日 1-2 次）
1. `openclaw cron list` 檢查所有 cron 狀態
2. 有 error 的記錄到 alerts
3. 更新 skills-data.json
4. 有嚴重問題才通知老闆

### 每週回顧
1. 哪些 skill 這週用了、哪些沒用
2. cron 成功率統計
3. 新增/移除/更新的 skill
4. 優化建議

## Key Rules

1. **自動掃描 cron 狀態**，不等老闆問才查
2. **cron error 要主動修復**，能修的直接修，不能修的通知老闆
3. **skills-data.json 定期更新**，保持主控版資訊新鮮
4. **新安裝 skill 後立即更新主控版**
5. **功能重疊的 skill 要標記**，建議合併
6. **閒置超過 7 天的 skill 要提醒**，可能過時需清理
