# Platform Rules

## Threads

- **不放 hashtag**（絕對不放）
- 內容簡潔有力，適合手機滑閱讀
- 段落之間用空行分隔，方便閱讀
- 一篇 300-600 字為佳（太短沒內容，太長沒人看完）
- 不要用 markdown 格式（Threads 不支援）
- 可以用換行和空行做排版
- emoji 少用，用了也要自然，不要每段都放
- API 發文：graph.threads.net，TEXT 類型

### Threads 發文 API 流程
1. `POST /v1.0/{userId}/threads?media_type=TEXT&text={content}&access_token={token}`
2. 等待 3 秒
3. `POST /v1.0/{userId}/threads_publish?creation_id={containerId}&access_token={token}`
4. 回傳 thread_id → 組成 thread_url

### Token 注意事項
- 目前是 short-lived token，需定期更新
- 如果發文失敗回 401/403，通知老闆 token 過期需更新
- Config: `social/config.json`

## IG（暫停中，歸社群專案IG skill）

此 skill 不處理 IG 內容。
