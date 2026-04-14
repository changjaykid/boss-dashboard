# MEMORY.md - 管家的長期記憶

## 老闆偏好 & 禁令
- 聰明、可靠、直接、有效率。不囉嗦。
- **絕對禁止**：思考過程、除錯紀錄、處理過程、英文內部片段。只給結論和結果。
- **LINE 回覆絕對不超過 200 字**。這是死規則。簡短、直接、不囉嗦。
- **LINE 429 根因（已確認）**：回覆超過 5000 字元會被分段，多段 = 多次 API call = 觸發 LINE rate limit = 429。
- **解決方法**：每次回覆控制在 200 字以內，絕對不分段。複雜內容先做完再給結論。
- **禁止**：在 LINE 回覆中貼代碼、表格、長列表、長分析過程。只給結果。
- 已關掉非必要 cron 的 LINE 通知。
- 只有 social-morning / social-evening 保留 LINE 通知（通知老闆審核草稿）。
- 老闆審核後才能發社群文，不可自行發布。

## 模型規則
- **🚨 絕對禁止使用 claude-opus。Token 太貴，老闆明確禁止。**
- **主 session 現在用 anthropic/claude-sonnet-4-6**（2026-04-15 因 gpt-5.4 rate-limit 爆掉改的）
- **所有 cron 員工也改為 claude-sonnet-4-6**（binance-futures、money-maker、forex-auto-trader、social、nightly-report、backup、forex-weekend-study）
- agents.defaults.model.primary = anthropic/claude-sonnet-4-6
- gpt-5.4 額度爆掉過（2026-04-14 晚）— 未來考慮切回但需確認額度
- **血的教訓（2026-04-14）**：gpt-5.4 + gemini 額度全掉 → 主 session 無法回應長達 10+ 小時。改用 claude-sonnet 作為主力避免單點失敗。
- **血的教訓（2026-04-15）**：sync-max-balance cron 刪除。daily-backup 改 3 天一次。

## 回報規則
- 固定回報：11:00 / 18:00 社群草稿、22:00 每日總回報
- 開平倉不即時回報，22:00 統一復盤
- 異常/需老闆決定才即時通知
- 主控版有進展就自動更新

## 自動交易系統
- **外匯 (Capital.com)**：$500 實戰，v4 策略，保留 5 個正期望值策略
- **合約 (Binance)**：每日 10 筆額度，多幣種（BTC+ETH+動態 2 幣），每 10 分鐘 cron
- **賺錢機 (MAX)**：BTC/ETH/任意兩個動能高的幣種 TWD，每幣 2,500 TWD，每 3 分鐘 cron，目標帳戶本金最大化
- **核心原則**：保護本金第一，利潤最大化第二。賺的抱住、虧的快砍、風報比 > 勝率
- Capital.com epic：GOLD、EURUSDM2026、GBPUSD、USDJPYM2026、US30、US500、US100

## MAX API
- snake_case 參數（ord_type）、市價買要 volume（BTC 數量）
- 最小交易：0.0001 BTC、賣出最低 250 TWD

## Binance API（2026-04-07 教訓）
- STOP_MARKET/TAKE_PROFIT_MARKET 已遷移到 /fapi/v1/algoOrder
- 必要參數：algoType='CONDITIONAL', triggerPrice（取代 stopPrice）

## Threads 發文
- 500 字元限制，長文用 reply_to_id 拆到留言區
- 真人口吻、禁用「——」、不放 hashtag、3-5 emoji
- publisher.js 支援 image_url
- **publisher.js 有 API 級重複檢查**：發文前比對最近 10 篇，前 80 字重複就擋

## ⛔ 血的教訓（反覆犯錯記錄）

### 重複發文問題（2026-04-07，老闆多次發怒）
- **根因**：狀態散在 4 個地方（draft檔、dashboard.json、published_ids.json、social-data.json），改一個忘改另一個，導致 cron/手動重複發文
- **已加防護**：publisher.js 發文前用 Threads API 查重，不再依賴本地狀態
- **教訓**：
  1. **做完任何操作，立刻用 API 驗證結果**，不要假設成功
  2. **不要手動繞過 publisher.js 發文**，所有發文必須走同一條路徑
  3. **修完 bug 要測試**，不是改完就算
  4. 老闆說做什麼就要真的執行，不能 session 斷了就丟掉

### 狀態不同步通病
- 同一筆資料不要存超過 2 個地方
- 如果必須多份，寫入時必須原子性全部更新
- heartbeat 要主動掃描狀態一致性

## 工作原則 (2026-04-12 更新)
- **追根因不修表面、一次修到底、數據必須腳本抓取不可編造**
- **嚴禁依賴緩存數據回報資產，每次涉及金額必須調用 API 實時抓取**
- **積極交易定義**：合約槓桿 20x，單筆權重 50%，掃描頻率 10min/次。
- **老闆最恨的事情**：交代事情要說兩次、回報數字與實況不符、避重就輕。
- **改進方向**：主動發現異常（如持倉滯後）並在老闆發問前修正，不准等老闆來抓包。
- **做完就驗證，不要假設成功**

## 已暫停項目（skill 保留不刪）
- 虛擬貨幣模擬交易、廣告業務掃描、IG、台股、外匯新聞、幣圈新聞

## 員工架構（workers/）
- 8 個獨立員工，各有 engine/data/dashboard.json/memory.md/lessons.md
- **每個員工的 dashboard.json 是唯一狀態來源（真實檔案，不是 symlink）**
- **boss-dashboard/ 裡的 JSON 是複製品，由 sync_dashboards.sh 單向同步**
- **禁止 symlink、禁止多份狀態、禁止引擎直接寫 boss-dashboard/**
- workers/sync_dashboards.sh — 員工 → boss-dashboard 單向同步
- workers/dispatch_alerts.sh — 分發 alert
- 2026-04-07 已拔掉所有 symlink，全部改成真實檔案

## 主控版
- Repo: changjaykid/boss-dashboard, GitHub Pages
- 密碼: 8888, push to main

## 系統操作教訓 (2026-04-11)
- **回覆 Discord 時絕對不可使用 `sessions_yield`**。這會導致訊息留在後台而不會推送到使用者的聊天室。一般對話必須直接以常規回覆（`<final>`）進行。

## 關於社群發文的教訓
- 老闆審核社群貼文，是在聊天室直接下指令（如「發佈」、「通過」），主控板上並沒有審核按鈕，未來回報時不可再說「去主控板點擊核准」。
- 2026-04-12 教訓：社群系統升級至 workers 後，SKILL.md 未同步更新，導致發文時找錯目錄。已刪除舊 social/ 目錄並更新 SKILL.md。後續重構必須確保手冊同步更新。
