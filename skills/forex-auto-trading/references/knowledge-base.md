# Technical Analysis Knowledge Base

Complete reference for forex & index CFD market analysis.

## Table of Contents
1. [Candlestick Patterns (K棒型態)](#candlestick-patterns)
2. [Chart Patterns (型態學)](#chart-patterns)
3. [Technical Indicators (技術指標)](#technical-indicators)
4. [Volume-Price Analysis (量價分析)](#volume-price-analysis)
5. [Elliott Wave Theory (波浪理論)](#elliott-wave-theory)
6. [Dow Theory (道氏理論)](#dow-theory)
7. [Support & Resistance (支撐壓力)](#support-resistance)
8. [Multi-Timeframe Analysis (多時間框架)](#multi-timeframe-analysis)
9. [Fibonacci (斐波那契)](#fibonacci)
10. [News & Fundamentals (新聞面)](#news-fundamentals)
11. [Session Characteristics (時段特性)](#session-characteristics)
12. [Fund Flow (資金流向)](#fund-flow)

---

## 1. Candlestick Patterns

### Reversal Patterns (反轉型態)

**Bullish (看漲)**
- **Hammer (錘子線)**: 小實體在上方，長下影線 (≥2x實體)。出現在下跌趨勢底部 → 買方開始反攻
- **Bullish Engulfing (看漲吞噬)**: 陽線完全包覆前一根陰線。越大的吞噬越強
- **Morning Star (晨星)**: 陰線 → 小實體(十字) → 陽線。三根組合的底部反轉信號
- **Piercing Line (貫穿線)**: 陽線開盤低於前陰線最低，收盤穿過前陰線中點以上
- **Three White Soldiers (三白兵)**: 連續三根上漲陽線，每根收盤高於前一根。強力多頭信號
- **Bullish Harami (看漲孕線)**: 小陽線被前一根大陰線包含。趨勢可能反轉

**Bearish (看跌)**
- **Shooting Star (射擊之星)**: 小實體在下方，長上影線。出現在上漲趨勢頂部
- **Bearish Engulfing (看跌吞噬)**: 陰線完全包覆前一根陽線
- **Evening Star (暮星)**: 陽線 → 小實體 → 陰線。頂部反轉
- **Dark Cloud Cover (烏雲蓋頂)**: 陰線開盤高於前陽線最高，收盤跌破前陽線中點
- **Three Black Crows (三黑鴉)**: 連續三根下跌陰線。強力空頭信號
- **Bearish Harami (看跌孕線)**: 小陰線被前一根大陽線包含

### Continuation Patterns (持續型態)
- **Doji (十字星)**: 開盤≈收盤，代表猶豫。出現在趨勢中要看前後文
- **Spinning Top (紡錘線)**: 小實體，上下影線差不多長。市場猶豫
- **Inside Bar (內包線)**: 整根K棒在前一根範圍內。蓄勢待發，突破方向跟進
- **Outside Bar (外包線)**: 完全包住前一根。通常收盤方向是信號方向

### 使用原則
- 不要只看單根K棒，要看前後文（趨勢位置、支撐壓力附近）
- K棒在關鍵位置（支撐/壓力/斐波那契回撤）出現更有意義
- 時間框架越大，K棒信號越可靠（4H > 1H > 15M）

---

## 2. Chart Patterns

### Reversal Patterns
- **Head & Shoulders (頭肩頂)**: 左肩-頭-右肩，跌破頸線 → SELL。目標 = 頭到頸線距離
- **Inverse H&S (頭肩底)**: 反過來，突破頸線 → BUY
- **Double Top (雙頂/M頂)**: 兩次觸頂失敗，跌破支撐 → SELL
- **Double Bottom (雙底/W底)**: 兩次觸底反彈，突破壓力 → BUY
- **Triple Top/Bottom**: 三次測試同一水平失敗 → 比雙頂/底更強的信號
- **Rounding Top/Bottom (圓弧頂/底)**: 緩慢的趨勢轉換

### Continuation Patterns
- **Ascending Triangle (上升三角)**: 水平壓力 + 上升支撐線。通常向上突破
- **Descending Triangle (下降三角)**: 水平支撐 + 下降壓力線。通常向下突破
- **Symmetrical Triangle (對稱三角)**: 收斂中，突破方向跟進。越接近頂點突破力道越弱
- **Bull Flag (牛旗)**: 急漲後的小幅回調通道 → 突破上緣繼續漲
- **Bear Flag (熊旗)**: 急跌後的小幅反彈通道 → 跌破下緣繼續跌
- **Wedge (楔形)**:
  - Rising Wedge (上升楔形): 兩條上斜收斂線 → 通常向下突破 (bearish)
  - Falling Wedge (下降楔形): 兩條下斜收斂線 → 通常向上突破 (bullish)
- **Cup & Handle (杯柄)**: U型底 + 小幅回調（柄）→ 突破杯口 → BUY
- **Rectangle (矩形/箱型)**: 水平區間整理 → 突破方向跟進

### 使用原則
- 型態要有足夠的「成熟度」（至少觸及支撐/壓力 2-3 次）
- 突破要有量能確認（成交量放大）
- 假突破很常見 → 等回測確認後再進場更安全
- 目標價 = 型態的高度（measured move）

---

## 3. Technical Indicators

### Trend Indicators (趨勢指標)
- **EMA/SMA (指數/簡單移動平均)**
  - EMA 9/21: 短期趨勢
  - EMA 50: 中期趨勢
  - EMA 200: 長期趨勢（大方向）
  - 金叉 (短期穿越長期向上) → bullish
  - 死叉 (短期穿越長期向下) → bearish
  - 價格在 EMA 之上 = 多頭，之下 = 空頭

- **MACD (12/26/9)**
  - MACD 線 = EMA12 - EMA26
  - Signal 線 = MACD 的 EMA9
  - Histogram = MACD - Signal
  - Histogram 由負轉正 → 多頭動能增強
  - Histogram 由正轉負 → 空頭動能增強
  - 背離（價格新高但 MACD 沒新高）→ 趨勢可能反轉

### Oscillators (震盪指標)
- **RSI (14)**
  - > 70: 超買（可能回調，但強趨勢中可以持續超買）
  - < 30: 超賣（可能反彈）
  - 50 是多空分界
  - RSI 背離比超買超賣更可靠
  
- **Stochastic (KD, 9/3/3)**
  - K 線 > D 線 + 在 20 以下 → 買入信號
  - K 線 < D 線 + 在 80 以上 → 賣出信號

### Volatility Indicators (波動率指標)
- **Bollinger Bands (20, 2)**
  - 中軌 = SMA20, 上軌 = +2σ, 下軌 = -2σ
  - 帶寬收窄 (squeeze) → 大波動即將來臨
  - 價格觸及/突破上軌 → 可能超買或強勢突破
  - 價格觸及/突破下軌 → 可能超賣或強勢下跌
  
- **ATR (14)**
  - 衡量市場波動幅度，不判斷方向
  - 用於設定止損距離：SL = Entry ± (ATR × multiplier)
  - ATR 增加 → 波動加大，放寬止損
  - ATR 減少 → 波動縮小，收緊止損

### Volume Indicators
- **OBV (能量潮)**
  - 價漲 + OBV 漲 = 真突破
  - 價漲 + OBV 跌 = 假突破警告
  
- **VWAP (成交量加權平均價)**
  - 機構常用的日內參考價
  - 價格在 VWAP 上方 → 日內多頭
  - 價格在 VWAP 下方 → 日內空頭

---

## 4. Volume-Price Analysis (量價分析)

### Core Principles
- **量增價漲**: 上漲時成交量放大 → 健康的多頭，趨勢持續
- **量縮價漲**: 上漲時成交量萎縮 → 多頭力竭，可能反轉
- **量增價跌**: 下跌時成交量放大 → 恐慌拋售或強勢下跌
- **量縮價跌**: 下跌時成交量萎縮 → 賣壓減弱，可能反彈
- **放量突破**: 突破支撐/壓力時成交量明顯放大 → 有效突破
- **縮量回踩**: 價格回測突破點時成交量萎縮 → 回測成功，原方向繼續
- **天量天價**: 創新高時出現異常巨量 → 主力出貨信號，小心反轉
- **地量地價**: 極低成交量對應新低 → 賣壓枯竭，可能見底

### CFD 注意事項
Capital.com 的 CFD 成交量不等於實際市場成交量，僅供參考。外匯市場（OTC）本身就沒有集中交易所成交量數據。用 tick volume（報價變動次數）作為替代指標。

---

## 5. Elliott Wave Theory (波浪理論)

### Basic Structure
市場波動遵循 5-3 模式：
- **推動波 (Impulse)**: 5 浪（1-2-3-4-5），與主趨勢同方向
  - Wave 1: 趨勢啟動，通常不明顯
  - Wave 2: 回調（不能跌破 Wave 1 起點），通常回撤 50-61.8%
  - Wave 3: 最強勢的一浪（通常最長），**不能是最短的推動波**
  - Wave 4: 回調（不能跌入 Wave 1 的價格範圍），通常回撤 38.2%
  - Wave 5: 最後一推，動能通常弱於 Wave 3
- **修正波 (Corrective)**: 3 浪（A-B-C），與主趨勢相反
  - Wave A: 第一段修正
  - Wave B: 反彈（常被誤認為趨勢恢復）
  - Wave C: 最後一段修正，通常與 Wave A 等長

### Rules (不可違反)
1. Wave 2 不能回撤超過 Wave 1 的 100%
2. Wave 3 不能是三個推動波（1/3/5）中最短的
3. Wave 4 不能進入 Wave 1 的價格範圍

### Guidelines (常見但非絕對)
- Wave 3 通常是 Wave 1 的 1.618 倍
- Wave 5 通常與 Wave 1 等長
- Wave 2 通常是急速修正（zig-zag）
- Wave 4 通常是橫盤修正（flat/triangle）

### 交替原則
如果 Wave 2 是急速修正（zig-zag），Wave 4 通常是橫盤修正（flat/triangle），反之亦然

### Trading Application
- **Wave 3 做多/做空最安全**: 方向明確、動能最強
- 在 Wave 2 結束（斐波那契 50-61.8% 回撤）時進場做 Wave 3
- 在 Wave 5 結束時注意反轉信號
- **不要逆著 Wave 3 的方向操作**

---

## 6. Dow Theory (道氏理論)

### Six Tenets
1. **市場反映一切**: 所有已知資訊都已反映在價格中
2. **三種趨勢**:
   - 主要趨勢 (Primary): 1年以上的大方向（牛市/熊市）
   - 次級趨勢 (Secondary): 數週到數月的修正（主趨勢的回調）
   - 短期波動 (Minor): 數天的波動（雜訊）
3. **主要趨勢有三個階段**:
   - 牛市: 積累期 → 公眾參與期 → 過度投機期
   - 熊市: 出貨期 → 公眾拋售期 → 絕望期
4. **指數必須互相確認**: 不同市場（如 US30 和 US500）應該同步，若背離則趨勢可能反轉
5. **成交量必須確認趨勢**: 趨勢方向的波動應伴隨更大成交量
6. **趨勢持續直到有明確的反轉信號**

### Trend Identification
- **上升趨勢**: 更高的高點 (Higher Highs) + 更高的低點 (Higher Lows)
- **下降趨勢**: 更低的高點 (Lower Highs) + 更低的低點 (Lower Lows)
- **趨勢反轉確認**: HH/HL 序列被打破（出現 Lower Low）

### Trading Application
- **順勢交易**: 永遠跟著主要趨勢方向操作
- 在次級趨勢的回調結束時進場（順著主要趨勢）
- 用高低點序列判斷趨勢是否還在
- 多個指數/商品背離時要小心

---

## 7. Support & Resistance

### Types
- **Historical S/R**: 前高、前低、多次測試的水平
- **Psychological levels**: 整數關卡（如 GOLD 3000, 3500, 4000, 4500）
- **Dynamic S/R**: 移動平均線（EMA 50, EMA 200）
- **Fibonacci levels**: 38.2%, 50%, 61.8% 回撤/延伸
- **Pivot Points**: 日/週/月樞紐點

### Principles
- 支撐被跌破 → 變壓力（角色互換）
- 壓力被突破 → 變支撐
- 多次測試同一水平，該水平越重要
- 時間框架越大的 S/R 越重要

---

## 8. Multi-Timeframe Analysis

### Framework
1. **4H (大方向)**: 判斷主趨勢方向，找關鍵 S/R
2. **1H (確認)**: 確認中期趨勢，找進場區域
3. **15M (進場)**: 精確進場點，K棒信號
4. **5M (微調)**: 可選，精確止損位置

### Rules
- **所有時間框架必須方向一致才進場**
- 4H 看漲 + 1H 看漲 + 15M 出現買入信號 → 做多
- 任何一個時間框架方向相反 → 不進場
- 高時間框架的 S/R 優先於低時間框架

---

## 9. Fibonacci

### Retracement Levels (回撤)
- **23.6%**: 淺回撤，強趨勢中常見
- **38.2%**: 常見回撤位，健康修正
- **50.0%**: 不是斐波那契數，但心理重要位
- **61.8%**: 黃金比例回撤，最重要的回撤位
- **78.6%**: 深度回撤，接近反轉

### Extension Levels (延伸，算目標價)
- **127.2%**: 第一目標
- **161.8%**: 常用目標（Wave 3 常到這裡）
- **200.0%**: 強趨勢目標
- **261.8%**: 超強趨勢

---

## 10. News & Fundamentals

### High Impact Events (高影響事件)
- **NFP (非農就業)**: 每月第一個週五 → 美元劇烈波動
- **CPI (消費者物價指數)**: 通膨數據 → 影響央行利率預期
- **FOMC (聯準會利率決議)**: 直接影響美元及所有金融市場
- **ECB/BOE/BOJ 利率決議**: 各自貨幣及相關交叉盤
- **GDP**: 經濟成長 → 影響貨幣強弱
- **PMI**: 製造業/服務業採購經理人指數 → 經濟領先指標

### Event Trading Rules
- 重大數據公布前 30 分鐘 → 不開新倉
- 數據公布時波動劇烈 → 等第一波走完再判斷方向
- 如果持倉方向與數據一致 → 可以加碼或讓利潤跑
- 如果持倉方向與數據相反 → 立即止損

### Instrument-specific
- **GOLD**: 避險資產，美元跌→金漲，地緣政治風險→金漲，通膨↑→金漲
- **EUR/USD**: ECB vs Fed 利率差異，歐元區經濟數據
- **GBP/USD**: BOE 政策，英國經濟/脫歐影響
- **USD/JPY**: 避險時日圓升值（USD/JPY 跌），日本央行干預
- **US30/US500/US100**: 企業財報季、Fed 政策、就業/消費數據

---

## 11. Session Characteristics

| Session | UTC | 特徵 |
|---------|-----|------|
| 亞洲 (Tokyo) | 00:00-09:00 | 波動較小，USD/JPY 最活躍，常形成區間 |
| 歐洲 (London) | 07:00-16:00 | 波動最大的開盤，EUR/GBP 最活躍，常有突破 |
| 美洲 (New York) | 13:00-22:00 | US 指數最活躍，與倫敦重疊時段(13-16)波動最大 |
| 倫敦+紐約重疊 | 13:00-16:00 | 全天波動最大的時段，最好的交易機會 |

### Dead Zones (避開)
- UTC 22:00-00:00: 流動性低，spread 大
- 週五 UTC 20:00+: 收盤前波動異常
- 重大假日: 流動性低，價格異常

---

## 12. Fund Flow (資金流向)

### COT Report (交易員持倉報告)
- 每週五發布（反映截至週二的數據）
- 三類交易者: Commercial (避險者)、Large Speculator (基金)、Small Speculator (散戶)
- **Large Speculator 的多空比例變化** 是最有參考價值的
- 當大型投機者的淨多頭創歷史新高 → 可能見頂
- 當大型投機者的淨空頭創歷史新高 → 可能見底

### Dollar Index (DXY)
- 美元強弱的綜合指標
- DXY 上漲 → 通常 EUR/USD, GBP/USD 下跌, USD/JPY 上漲, GOLD 下跌
- DXY 下跌 → 反過來
- 做外匯先看 DXY 方向
