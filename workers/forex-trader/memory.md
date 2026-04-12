# 外匯員工記憶

## 最近狀態
- 系統：Capital.com 自動交易
- 商品：US100 (主力), GOLD, US500 (次要) — ⚠️ US30 已黑名單（三週）
- 實戰資金：$500 USD (帳戶餘額 ~$31,023)
- 運行模式：每 10 分鐘 cron（週一至週五）
- 累計損益：-$385.23 (204筆, 19.6% WR)

## W16 週末復盤重點 (2026-04-12)

### 本週成績
- P/L: -$44.14 (與W15完全相同)
- 27 trades, 11.8% WR, RR=1.47
- 最大單筆虧損: -$10.03 (US30 multi_indicator_consensus)
- 最大單筆贏利: +$5.94 (US100 breakout_range)
- 13連敗紀錄（虧$40.55）

### 🚨🚨🚨 系統性執行失敗 — 三週連續
**W15 提出的 8 項改進，0 項完全執行：**
1. ❌ US30 未封鎖 → 7筆虧$40.44（佔91%）
2. ❌ Retired策略未封鎖 → 5筆虧$12.36（第三週重複）
3. ❌ Circuit breaker 未實裝 → 13連敗
4. ❌ 13:00-13:30 UTC 未封鎖 → 5筆虧$16.54
5. ❌ session_momentum 未暫停 → 5筆虧$15.41
6. ❌ 時間止損未實裝 → 6筆持有>120min
7. △ PnL回查部分修復
8. ❌ TP/SL仍為1.47（目標3.0）

**如果全部落實 → 回測顯示從虧$44.14變成賺$9.09**

### 🚨 週一開盤前必須完成（程式碼層面）
1. **analyzer 引擎加入 INSTRUMENT_BLACKLIST = ['US30']**
2. **analyzer 引擎加入 strategy status check** — 只有 ACTIVE/TESTING 可交易
3. **analyzer 引擎加入 circuit breaker** — 3連敗暫停30分鐘
4. **analyzer 引擎加入 time block** — 13:00-13:30 UTC 不開倉
5. **週一第一次cron立即關閉 US30 和 session_momentum 持倉**

### 策略狀態 (W16 更新)
- ✅ ACTIVE: breakout_range (累計+$64.86), multi_indicator_consensus (累計-$22.08), V5_TRENDING_DOWN (+$20.19 但dormant)
- 🧪 TESTING: reversion_bollinger (+$4.21, 1筆), reversion_rsi_divergence (-$2.01, 3筆)
- 🪦 RETIRED (8個): session_momentum, breakout_pattern, breakout_bollinger_squeeze, reversion_pin_bar, trend_mtf_alignment, breakout_outside_bar, V5_RANGING, V5_TRENDING_UP

### 關鍵發現（三週數據驗證）
1. **US30 是毒瘤** — 三週虧$217+, 0% WR。每筆平均虧$5.29。
2. **13:00 UTC 是虧損黑洞** — 三週虧$458+。美股開盤波動。
3. **高信心(≥0.75)三週全敗** — confidence scoring 有系統性bug。
4. **US100 SELL 是唯一有邊際的方向** — 三週40%WR，兩筆最大贏單都來自US100 SELL。
5. **14:00-18:00 UTC是最佳時段** — 三週驗證。
6. **虧損交易持有太久** — 平均776min vs 贏單37min。需要120min強制平倉。
7. **交易量不重要，品質才重要** — 減少到12筆+正確篩選 = 賺$9.09。

### 下週優先級
1. 🔴 落實引擎四項硬性規則（不能再拖）
2. 🔴 關閉US30和session_momentum持倉
3. 🟡 RETIRE session_momentum, breakout_pattern, breakout_bollinger_squeeze
4. 🟡 開發H11_US100_SELL_SPECIALIST
5. 🟡 實裝120min時間止損
6. 🟢 測試H12反向信心模型
7. 🟢 提高TP/SL至2.5+

### 升級警告
如果 W17 仍然虧損且改進措施仍未落實：
→ 暫停全系統1週
→ 手動審查並重寫 analyzer 引擎的訊號過濾邏輯
→ 不再信任cron自動修復，改為人工介入

## 歷史教訓（持續累積）
- 門檻太高 = 系統癱瘓，防虧防到不做等於白費
- 下單要謹慎、賺的抱住、虧的快砍
- 重點是最終有沒有賺，不是勝率
- 獲利的單子可以繼續抱，不急著平
- 追蹤停損比固定停利好
- Capital.com API 的 epic 代碼要用對（GOLD, EURUSDM2026 等）
- SL/TP 被 broker 觸發時，要主動回查持倉狀態更新 P/L
- 不要在 BB 擠壓時開倉
- **US30 不要碰** — 三週虧$217+, 0% WR，spread高波動大，已列入永久黑名單
- **13:00 UTC 是虧損黑洞** — 美股開盤前波動，三週虧$458+，必須硬性封鎖
- **高信心 ≠ 高勝率** — 三週75+%信心全敗，confidence scoring 系統性失準，考慮反向使用
- **策略退休決定要確實執行** — 連續三週決定但未封鎖，純JSON修改無效，必須改程式碼
- **交易量不是越多越好** — 精選12筆可賺$9，盲目27筆虧$44
- **US100 SELL 有邊際** — 三週驗證，唯一穩定有贏單的方向+商品組合
- **虧損單不要死扛** — 120分鐘未盈利就該砍，等越久虧越多
- **改善建議不落實等於白費** — 三週重複同樣的建議，虧損完全相同。問題不在分析而在執行。

## 6筆OPEN持倉 (進入2026-04-12週末)
| 商品 | 策略 | 方向 | 入場價 | SL Risk | 處置 |
|------|------|------|--------|---------|------|
| US100 | breakout_range | SELL | 24904.0 | $6.34 | 保留 |
| GOLD | multi_indicator_consensus | SELL | 4764.7 | $0.20 | 保留 |
| GOLD | breakout_range | SELL | 4764.34 | $0.20 | 保留 |
| GOLD | session_momentum | SELL | 4764.72 | $0.17 | ⚠️ 週一關閉(retired) |
| US30 | multi_indicator_consensus | SELL | 47670.3 | $12.59 | ⚠️ 週一關閉(blacklisted) |
| US500 | multi_indicator_consensus | SELL | 6758.9 | $1.56 | 保留 |
