# 合約員工記憶

## 最近狀態
- 系統：Binance USDT-M 永續合約，v3 多幣種
- 標的：BTCUSDT, ETHUSDT, AVAXUSDT, DOTUSDT
- 槓桿：10x 逐倉
- 錢包餘額：$460.73 USDT（初始 $464）
- 未實現損益：約 -$1.0（三倉合計）
- 淨值：$459.73
- 總已結損益：-$3.27（15 筆完結）
- 運行模式：每 3 分鐘 cron，24/7

## 2026-04-07 23:41 狀態

### 今日（4/7）交易統計（各幣種合計）
- BTCUSDT：4 筆（2勝2敗）累計 PnL -$2.53
- ETHUSDT：1 筆（0勝1敗）累計 PnL -$1.29
- AVAXUSDT：4 筆（2勝2敗）累計 PnL -$2.54
- DOTUSDT：2 筆（2勝0敗）累計 PnL +$1.06
- 合計完結：11 筆今日，日損益約 -$5.30

### 當前持倉（3 倉位）
1. **ETHUSDT LONG** 0.098 @ $2,079.35 | 未實現 PnL: ~-$0.28 (-0.14%)
   - 策略：RSI_BB_ADAPTIVE | 市場：TRENDING_DOWN
   - 止損：$2,063.10 | Score: 46
   - 理由：RSI回踩45, RSI突破BB上軌, MACD看多背離
   - 開倉時間：15:30 UTC（23:30 台灣）
   - ⚠️ 注意：在 TRENDING_DOWN 逆勢做多，需密切監控

2. **AVAXUSDT SHORT** 25 @ $8.578 | 未實現 PnL: ~-$0.17 (-0.08%)
   - 策略：TREND_FOLLOW | 市場：TRENDING_DOWN
   - 止損：$8.648（追蹤中）| Score: 35
   - 理由：1H EMA 空排, 看空Pin Bar
   - 持倉時間：~9 小時（從 14:40 UTC）
   - 當前價格：~$8.584

3. **DOTUSDT SHORT** 186.1 @ $1.218 | 未實現 PnL: ~-$0.47 (-0.21%)
   - 策略：SESSION_BREAKOUT | 市場：TRENDING_DOWN
   - 止損：$1.228（追蹤中）| Score: 39
   - 理由：1H EMA 空排, 量能放大, 亞盤突破↓
   - 持倉時間：~9.2 小時（從 14:30 UTC）
   - 當前價格：~$1.220

4. **BTCUSDT** — 無持倉（信號不足 12/30，TRENDING_DOWN）

### 市場狀態（23:41 台灣）
- BTC：$68,125 | TRENDING_DOWN | Score 12 | 偏多但信號弱
- ETH：$2,077 | TRENDING_DOWN | Score 46 | 持倉做多中
- AVAX：$8.584 | TRENDING_DOWN | Score 35 | 偏空（持倉順勢）
- DOT：$1.220 | TRENDING_DOWN | Score 39 | 偏空（持倉順勢）
- 當前時段：美洲盤（台灣 23:41）

### 今日重要交易回顧
- AVAX 最大虧損單：MACD_DIVERGENCE SHORT -$5.76（SL 被觸發後重新進場成功）
- AVAX 最大盈利單：TREND_FOLLOW SHORT +$1.94（追蹤止損生效）
- DOT 兩筆全勝：+$0.17, +$0.89
- BTC/ETH 亞盤突破策略同時觸發同時止損（高相關性）
- ETH 新倉 LONG @ 15:30 UTC（RSI_BB_ADAPTIVE，在 TRENDING_DOWN 市場逆勢做多）

### ⚠️ API 警告
- 多次出現 API -4067: Position side cannot be changed if there exists open orders
- API -4046: No need to change margin type（無害，正常）

### 累計績效（15 筆完結 + 3 持倉中）
- 完結勝率：53.3%（8勝7敗）
- 完結損益：-$3.27
- 未實現損益：約 -$0.92
- 錢包餘額：$460.73（初始 $464，跌 0.70%）
- 淨值：~$459.81

### 觀察
- 四幣種全面 TRENDING_DOWN，BTC 信號太弱不開倉是正確的
- AVAX 和 DOT 空單順勢持有中，但從盈利轉為小幅浮虧
- ETH 新開多單逆趨勢，風險較高，止損設在 $2,063
- AVAX 今天有一筆大虧 -$5.76 拖累整體表現
- 引擎下午到晚間大部分時間信號不足，保持觀望（正確行為）
- 日交易次數 11 已超過限制 10，後續需注意控制
