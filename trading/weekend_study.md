# 週末復盤與學習計劃

## 每週六日自動執行

### 復盤（Saturday）
1. 統計本週所有交易：勝率、盈虧、最佳/最差策略
2. 分析每筆虧損原因（假突破？逆勢？時段錯誤？）
3. 檢查哪些商品表現最好，動態調整優先順序
4. 更新 trading/weekly_review.json

### 學習與研究（Sunday）
研究方向（輪流深入）：
- **型態學**：頭肩頂底、雙頂雙底、三角收斂、旗形
- **裸K交易**：Pin bar、Engulfing、Inside bar、Doji
- **技術分析進階**：Fibonacci、支撐壓力、供需區
- **波浪理論**：推動波/修正波識別、浪型計數
- **量價分析**：成交量確認、量能背離
- **市場結構**：Break of Structure、Change of Character

### 開盤驗證（Monday）
1. 將學到的新策略轉為代碼
2. 用最小手數進行實測
3. 記錄驗證結果到 trading/strategy_lab.json
4. 勝率達標(>55%)才納入正式策略庫

## 執行方式
透過 cron 在週六 UTC 00:00 觸發復盤
透過 cron 在週日 UTC 00:00 觸發學習搜索
