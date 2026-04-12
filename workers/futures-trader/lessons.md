# 合約員工教訓

## 核心教訓
- 門檻 70 分時最高只到 29 分 = 完全空轉，降到 30 分後才正常
- 方向明確度 30% 太嚴，20% 比較合理
- 量縮懲罰不能太重，只有極度量縮才扣分
- 追蹤停損 5 階段：+0.3%保本 → +0.5%追蹤0.4% → +1%追蹤0.3% → +2%追蹤0.25% → +4%追蹤0.2%
- 有利潤的單子不限持倉時間
- 連續 2-3 天沒進場就要降低門檻
- 測試 API 時要小心，不要不小心平倉（4/5 失誤虧 $1.27）

## API 注意事項
- **2025-12 起 Binance 將 STOP_MARKET 遷移到 `/fapi/v1/algoOrder`**，舊 `/fapi/v1/order` 會回 -4120
- 下 SL 必要參數：`algoType: 'CONDITIONAL'`, `type: 'STOP_MARKET'`, `triggerPrice`（不是 `stopPrice`）
- 取消 SL 用 `DELETE /fapi/v1/algoOpenOrders`（不是 `/fapi/v1/allOpenOrders`）
- 引擎偵測到持倉但沒有 trailingStop 時要自動補上（外部開倉或重啟後）
- MARKET 下單仍用舊 `/fapi/v1/order`，只有條件單要用 algo endpoint

## 程式碼 Bug 教訓
- **外部平倉偵測**：偵測 SL/TP 觸發時必須在 `state.position` 被清除之前做，否則永遠偵測不到。(2026-04-07 修復)
- **today() 時區**：`today()` 要用 UTC+8 而非 UTC，否則 06:00 台灣時間執行時仍是 UTC 昨日，不會重置每日統計。(2026-04-07 修復)
- **追蹤止損平倉可能不記錄**：如果 Binance algo order 觸發平倉，引擎下一次 cycle 需要正確偵測並記錄到 tradeHistory
- **state.position 與交易所不同步**：手動修改 state 檔或 race condition 可能導致 state.position=null 但交易所仍有倉位。反過來，交易所平倉了但 state.position 仍在，若有其他進程清掉了 state.position，外部平倉偵測就不會觸發。(2026-04-07 發現：Trailing SL 在 $69570.5 觸發，盈利 ~$2.55，但引擎未記錄。已加強偵測 log 和 fallback openTime。) 
- **關鍵改進**：外部平倉偵測現在增加「🔍 偵測到持倉消失」前置 log，並用 fallback openTime（lastTradeTime 或 24h 前），避免 openTime 為 undefined 時查不到交易。

## 風控
- 單筆最大虧損 ≤ 保證金 2%
- 日虧上限 ≤ 保證金 5%
- 連虧 3 筆暫停 1 小時
