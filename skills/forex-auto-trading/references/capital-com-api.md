# Capital.com API Reference

## Endpoints

- **Live**: `https://api-capital.backend-capital.com`
- **Demo**: `https://demo-api-capital.backend-capital.com`

## Authentication

```
POST /api/v1/session
Headers: X-CAP-API-KEY, Content-Type: application/json
Body: {"identifier": "<email>", "password": "<password>"}
Response headers: CST, X-SECURITY-TOKEN (use for all subsequent requests)
```

Session expires after inactivity. Re-login if 401.

## Key Endpoints

### Account
- `GET /api/v1/accounts` → balance, available, deposit, profitLoss

### Positions
- `GET /api/v1/positions` → all open positions
- `POST /api/v1/positions` → open position
  ```json
  {"epic": "GOLD", "direction": "BUY", "size": 0.01,
   "guaranteedStop": false, "stopDistance": 50, "profitDistance": 100}
  ```
- `PUT /api/v1/positions/{dealId}` → update SL/TP
  ```json
  {"guaranteedStop": false, "stopLevel": 3000, "profitLevel": 3100}
  ```
- `DELETE /api/v1/positions/{dealId}` → close position

### Market Data
- `GET /api/v1/markets/{epic}` → current price, status, instrument info
- `GET /api/v1/prices/{epic}?resolution=MINUTE_15&max=200` → historical candles
  - Resolutions: MINUTE, MINUTE_5, MINUTE_15, MINUTE_30, HOUR, HOUR_4, DAY, WEEK
  - Max 1000 candles per request
  - Candle format: `{snapshotTime, openPrice: {bid, ask}, closePrice: {bid, ask}, highPrice: {bid, ask}, lowPrice: {bid, ask}}`

### History (for P/L recovery)
- `GET /api/v1/history/activity?from=<ISO>&to=<ISO>` → trading activity
- `GET /api/v1/history/transactions?from=<ISO>&to=<ISO>&type=TRADE` → realized P/L
  - Each transaction has: `profitAndLoss` field with actual money amount
  - Use this to recover P/L for CLOSED_BY_BROKER trades

### Watchlists
- `GET /api/v1/watchlists` → user watchlists

## P/L Recovery Flow (SL/TP_BY_BROKER)

When a position is detected as closed by broker:
1. Get the trade's `instrument` and approximate `close_time`
2. Query `/api/v1/history/transactions?from={open_time}&to={close_time+1h}&type=TRADE`
3. Match by instrument and direction
4. Extract `profitAndLoss` value
5. Update trade_log entry: set `pnl`, update `outcome` to WIN/LOSS based on P/L sign

## Error Handling

- **401**: Session expired → re-login
- **403**: API key invalid or IP blocked
- **429**: Rate limit → wait and retry (max ~10 req/sec)
- **500**: Server error → retry after 5s
- Connection timeout: Skip cycle, existing SL/TP protect positions

## Rate Limits

- ~10 requests per second for REST API
- Batch market data requests where possible
- Cache candle data between runs if < 10 min old
