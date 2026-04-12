# MAX Exchange API Reference

## Base URL
`https://max-api.maicoin.com`

## Authentication
- SDK: `max-exchange-api-node` (Node.js)
- Auth: access_key + secret_key in crypto_config.json
- Signature: HMAC-SHA256

```javascript
const { MAX } = require('max-exchange-api-node');
const { rest } = new MAX({
  accessKey: CONFIG.api.access_key,
  secretKey: CONFIG.api.secret_key
});
```

## Public Endpoints (no auth)

### Tickers
- `GET /api/v2/tickers` → all market tickers
- `GET /api/v2/tickers/{market}` → single ticker
  - Returns: `buy` (best bid), `sell` (best ask), `last`, `vol`, `high`, `low`, `open`

### K-Lines (Candles)
- `GET /api/v2/k?market={pair}&period={min}&limit={count}`
  - market: btctwd, ethtwd, btcusdt, ethusdt, soltwd, dogetwd
  - period: 1, 5, 15, 30, 60, 120, 240, 360, 720, 1440
  - limit: max 1000
  - Returns: `[[timestamp, open, high, low, close, volume], ...]`

### Order Book
- `GET /api/v2/depth?market={pair}&limit={count}`
  - Returns: `{asks: [[price, vol], ...], bids: [[price, vol], ...]}`

### Recent Trades
- `GET /api/v2/trades?market={pair}&limit={count}`

## Private Endpoints (auth required)

### Account
- `GET /api/v2/members/me` → account info, balances
- `GET /api/v2/members/accounts/{currency}` → specific currency balance

### Orders
- `POST /api/v2/orders` → place order
  ```json
  {"market": "btctwd", "side": "buy", "volume": "0.001", "price": "3000000", "ord_type": "limit"}
  ```
  - ord_type: `limit`, `market`, `stop_limit`, `stop_market`
- `GET /api/v2/orders?market={pair}&state=wait` → open orders
- `POST /api/v2/order/delete` → cancel order
  ```json
  {"id": 12345}
  ```

### Trades (execution history)
- `GET /api/v2/trades/my?market={pair}&limit={count}` → my executed trades

## SDK Usage (Node.js)

```javascript
// Get ticker
const ticker = await rest.getTicker('btctwd');

// Get K-lines
const klines = await rest.getKLines('btctwd', { period: 15, limit: 200 });

// Get order book
const depth = await rest.getDepth('btctwd', { limit: 20 });

// Place order (live mode)
const order = await rest.createOrder({
  market: 'btctwd', side: 'buy', volume: '0.001',
  price: '3000000', ord_type: 'limit'
});

// Cancel order
await rest.cancelOrder(orderId);

// Get balances
const accounts = await rest.getAccounts();
```

## Rate Limits
- Public: 600 requests per minute
- Private: 1200 requests per minute
- K-line requests are heavier — cache when possible

## Error Handling
- `2xxx`: Success
- `2001`: Unauthorized (check keys)
- `2004`: Insufficient balance
- `3xxx`: Invalid parameters
- `429`: Rate limit exceeded → backoff 1 second
- Connection timeout: Skip cycle, retry next cron

## Simulation vs Live

### Current (Simulation)
- Fetch real market data (prices, candles, order book)
- Simulate orders in memory (no actual API calls to create orders)
- Track positions, P/L, state in local JSON files

### Future (Live)
- Same data fetching
- Replace simulation logic with actual `rest.createOrder()` / `rest.cancelOrder()`
- Add order status tracking (wait/done/cancel)
- Handle partial fills
