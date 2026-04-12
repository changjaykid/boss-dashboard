---
name: social-posting
description: "Threads social media content creation and publishing system for @freeeadman. Handles draft generation, quality checking, topic rotation, automated publishing via Threads API, and dashboard updates. Use when: (1) running scheduled content cron (11:00/18:00), (2) boss asks to create or publish social content, (3) boss reviews/approves/rejects a draft, (4) updating the boss dashboard community section (🌐 社群專案), (5) any task involving Threads content for @freeeadman. NOT for IG content (use 社群專案IG skill instead)."
---

## 👤 負責人員

| 項目 | 內容 |
|------|------|
| **身份** | 社群經理 |
| **負責項目** | Threads @freeeadman 內容經營 |
| **日常任務** | 11:00/18:00 產草稿 → 送審老闆 → 審核通過後用 publisher.js 發佈 → 追蹤互動 |
| **更新時間** | 每日 11:00（早場草稿）、18:00（晚場草稿） |
| **主控板更新內容** | 草稿狀態、已發佈篇數、最新貼文、互動數據、更新時間戳 |
| **驗收標準** | 每日 1-2 篇高品質貼文，零重複發文，草稿準時產出 |
| **目標** | 穩定輸出好內容，幫老闆建立 @freeeadman 專業形象與影響力 |

---

# Social Posting System — Threads @freeeadman

## Overview

每天 2 篇 Threads 發文，展示行銷專業實力，吸引品牌主、廠商、創業者主動合作。

**定位**：不是情感雞湯、不是個人成長語錄。是讓人覺得「這個人懂，我想找他聊聊」。

## Architecture

```
workers/social-threads/
├── data/config.json         # Threads API credentials
├── engine/publisher.js      # Auto-publish approved drafts via Threads API
└── dashboard.json           # Single Source of Truth (drafts + published)

boss-dashboard/
└── social-data.json         # Synced copy for dashboard display
```

**Cron**: 
- `social-morning` — 11:00 Asia/Taipei（產第一篇草稿）
- `social-evening` — 18:00 Asia/Taipei（產第二篇草稿）
- 用 OpenAI gpt-4o-mini 產草稿

## Complete Workflow

### 1. 產草稿（11:00 / 18:00 cron 觸發）

a. **選主題**：
   - 查 social-data.json 的 published 歷史
   - 避免跟最近 3 篇用同一個 pillar
   - 從 12 個 pillar 中選一個最久沒用的
   → See `references/content-pillars.md`

b. **寫內容**（更豐富扎實版）：
   - 遵守品牌口吻和寫作規則
   → See `references/brand-voice.md`
   - 遵守平台規則
   → See `references/platform-rules.md`
   - **內容結構**：觀點 + 真實案例/數據佐證 + 有力結尾
   - **不要只有觀點**，要有支撐（案例、數字、經驗）
   - **配圖**：每篇產一張配圖，用 image_generate 生成
     - 風格：專業、乾淨、適合行銷主題的視覺圖（數據圖表風、概念圖、金句卡）
     - 尺寸：1080x1080
     - 生成後上傳到公開可訪問的 URL（用 Google Drive 公開連結或 imgur）
     - 草稿 JSON 加 `image_url` 欄位

c. **品質檢查（發布前 checklist）**：
   - [ ] 沒有「——」符號
   - [ ] 沒有提到具體年份（用「最近」「這陣子」代替）
   - [ ] 沒有 AI 味（「首先」「其次」「總結來說」「值得注意的是」）
   - [ ] 沒有文青腔過頭
   - [ ] 沒有雞湯語錄
   - [ ] 沒有 hashtag（Threads 不放）
   - [ ] 口吻像真人說話
   - [ ] 有觀點、有態度、有實戰感
   - [ ] 目標受眾看了會覺得有價值
   - [ ] 長度適合手機滑閱讀（不要太長也不要太短）

d. **放入待審核**：
   - 將草稿寫入 `workers/social-threads/dashboard.json` 的 `drafts` 陣列，status 必須設為 `pending`（**絕對不可以設 approved**，只有老闆能核准）
   - 同步更新主控版 (使用 `sync_dashboards.sh`)
   - LINE 通知老闆：「第 N 篇草稿已備，請審核」

### 2. 老闆審核

**老闆通過**：
- 將 `dashboard.json` 裡的 draft status 改為 `approved`
- 呼叫 `node engine/publisher.js` 自動發文

**老闆退回**：
- 記錄退回原因（如果有說）
- 重寫一篇新的替換
- 重新寫入 `dashboard.json` 待審核

### 3. 自動發文（publisher.js）

publisher.js 流程：
1. 讀取 `dashboard.json`，找 status = `approved`
2. 呼叫 Threads API 發佈（graph.threads.net）
3. 成功後：
   - draft status → `published`
   - 從 drafts 陣列移除
   - 加入 published 陣列（最新的在最上面）
4. **更新 boss-dashboard**：
   - 自動呼叫 `sync_dashboards.sh` 進行同步
5. git push 主控版

### 4. Dashboard 更新規則

**待審核草稿區**：
- 顯示所有 status = `pending` 的草稿
- 老闆可以在這裡審核

**最近已發佈區**：
- **最新的在最上面**
- 顯示最近 20 篇
- 每篇顯示：主題類型、內容預覽、發佈時間、Threads 連結

**發文成功後**：草稿從「待審核」消失，出現在「最近已發佈」的最上面

## Topic Rotation Logic

```
1. 讀取 published 歷史最近 6 篇的 pillar
2. 從 12 個 pillar 中排除最近 3 篇用過的
3. 從剩餘 pillar 中，選「最久沒出現」的
4. 如果全部都在最近 3 篇內（不太可能），就選最久沒用的那個
5. 同一天兩篇必須不同 pillar
```

## Self-Optimization

- **追蹤主題分佈**：確保 12 個 pillar 均勻輪替
- **記錄退回原因**：老闆每次退回的理由都記在 memory/，下次避免
- **品質趨勢**：追蹤老闆直接通過 vs 退回的比例，越來越少退回 = 風格越來越準
- **寫作規則更新**：老闆任何對文案風格的調整，立即更新 brand-voice.md 和 MEMORY.md

## Threads API

- Endpoint: `graph.threads.net`
- Auth: access_token（short-lived，需定期更新）
- Flow: Create container → Wait 3s → Publish
- Config: `workers/social-threads/data/config.json`
- Publisher: `workers/social-threads/engine/publisher.js`

## Key Rules

1. **每篇都要老闆審核**，不可自行發布
2. **Threads 不放 hashtag**
3. **禁止「——」符號**
4. **不提年份**，用「最近」「這陣子」
5. **已發佈排序：最新在最上面**
6. **發文後從待審核移到已發佈**
7. **同一天兩篇不同主題**
8. **這個 skill 只管 Threads**，IG 歸社群專案IG
