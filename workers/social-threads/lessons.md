# social-threads 教訓紀錄

## 架構（v3，2026-04-07 重整）

**唯一狀態來源：dashboard.json**
- drafts[] — 草稿（pending / approved / rejected / failed）
- published[] — 已發文（含 thread_id, published_at）
- 不存在 drafts/ 資料夾、published/ 資料夾、published_ids.json
- boss-dashboard/social-data.json 是 dashboard.json 的複製品，由 publisher.js 自動同步

## 2026-04-07 重複發文事件（嚴重）

**問題**：同一篇貼文被發了兩次，老闆自己刪的。

**根因**：狀態散在 4 個地方（draft 檔、dashboard.json、published_ids.json、social-data.json），改一個忘改另一個。

**修復**：
1. 砍掉所有多餘狀態，只留 dashboard.json
2. publisher.js v3 重寫，只讀寫 dashboard.json
3. publisher.js 發文前用 Threads API 查重（前 80 字比對最近 10 篇）
4. cron prompt 全部改成讀寫 dashboard.json

**規則**：
1. 所有發文必須走 publisher.js
2. 做完任何操作立刻驗證結果
3. 寧可漏發也不要重複發
