#!/usr/bin/env node
/**
 * 虛擬貨幣賺錢機 — 下單 & 帳戶查詢工具
 * 
 * 用法：
 *   node money_maker_order.js balance          # 查餘額
 *   node money_maker_order.js buy <price> <amount>   # 限價買（Maker）
 *   node money_maker_order.js sell <price> <amount>  # 限價賣（Maker）
 *   node money_maker_order.js buy_market <total_twd>  # 市價買（指定台幣金額）
 *   node money_maker_order.js sell_market <amount>    # 市價賣（指定BTC數量）
 *   node money_maker_order.js cancel <order_id>       # 取消訂單
 *   node money_maker_order.js orders                  # 查詢未成交訂單
 *   node money_maker_order.js trades                  # 查詢最近成交
 */

const { MAX } = require('max-exchange-api-node');
const fs = require('fs');
const path = require('path');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'crypto_config.json'), 'utf8'));
const client = new MAX({
  accessKey: CONFIG.api.access_key,
  secretKey: CONFIG.api.secret_key
});

const MARKET = 'btctwd';
const LOG_FILE = path.join(__dirname, 'money_maker_order_log.json');

function appendLog(entry) {
  let log = [];
  try { log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch (e) {}
  log.push({ ...entry, timestamp: new Date().toISOString() });
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

async function getBalance() {
  const accounts = await client.rest.spotWallet.getAccounts({});
  const twd = accounts.find(a => a.currency === 'twd') || { balance: '0', locked: '0' };
  const btc = accounts.find(a => a.currency === 'btc') || { balance: '0', locked: '0' };
  const result = {
    twd: { available: parseFloat(twd.balance), locked: parseFloat(twd.locked) },
    btc: { available: parseFloat(btc.balance), locked: parseFloat(btc.locked) }
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function placeLimitOrder(side, price, amount) {
  console.log(`📝 下限價單: ${side} ${amount} BTC @ ${price} TWD`);
  try {
    const order = await client.rest.spotWallet.submitOrder({
      market: MARKET,
      side: side,
      volume: amount.toString(),
      price: price.toString(),
      ord_type: 'limit'
    });
    console.log(`✅ 訂單成功:`, JSON.stringify(order, null, 2));
    appendLog({ action: 'limit_order', side, price, amount, orderId: order.id, status: 'success' });
    return order;
  } catch (err) {
    console.error(`❌ 下單失敗:`, err.message || JSON.stringify(err));
    appendLog({ action: 'limit_order', side, price, amount, status: 'failed', error: err.message });
    throw err;
  }
}

async function placeMarketBuy(totalTwd) {
  console.log(`📝 市價買入: 花 ${totalTwd} TWD 買 BTC`);
  try {
    // 先取得當前最佳賣價，計算要買多少 BTC
    const ticker = await client.rest.getTicker({ market: MARKET });
    const askPrice = parseFloat(ticker.sell || ticker.ask);
    if (!askPrice || askPrice <= 0) throw new Error(`無法取得賣價: ${JSON.stringify(ticker)}`);
    
    // 算 BTC 數量，MAX BTC 最小單位 8 位小數，預留 0.5% 滑價空間
    const safeTotal = totalTwd * 0.995;
    const volume = Math.floor((safeTotal / askPrice) * 1e8) / 1e8;
    if (volume <= 0) throw new Error(`計算數量為 0, TWD=${totalTwd}, price=${askPrice}`);
    
    console.log(`   當前賣價: ${askPrice} TWD, 預計買入: ${volume} BTC`);
    
    const order = await client.rest.spotWallet.submitOrder({
      market: MARKET,
      side: 'buy',
      volume: volume.toString(),
      ord_type: 'market'
    });
    console.log(`✅ 市價買入成功:`, JSON.stringify(order, null, 2));
    appendLog({ action: 'market_buy', totalTwd, volume, askPrice, orderId: order.id, status: 'success' });
    return order;
  } catch (err) {
    console.error(`❌ 市價買入失敗:`, err.message || JSON.stringify(err));
    appendLog({ action: 'market_buy', totalTwd, status: 'failed', error: err.message });
    throw err;
  }
}

async function placeMarketSell(amount) {
  console.log(`📝 市價賣出: ${amount} BTC`);
  try {
    const order = await client.rest.spotWallet.submitOrder({
      market: MARKET,
      side: 'sell',
      volume: amount.toString(),
      ord_type: 'market'
    });
    console.log(`✅ 市價賣出成功:`, JSON.stringify(order, null, 2));
    appendLog({ action: 'market_sell', amount, orderId: order.id, status: 'success' });
    return order;
  } catch (err) {
    console.error(`❌ 市價賣出失敗:`, err.message || JSON.stringify(err));
    appendLog({ action: 'market_sell', amount, status: 'failed', error: err.message });
    throw err;
  }
}

async function cancelOrder(orderId) {
  console.log(`🗑️ 取消訂單: ${orderId}`);
  try {
    const result = await client.rest.cancelOrder({ id: orderId });
    console.log(`✅ 已取消:`, JSON.stringify(result, null, 2));
    appendLog({ action: 'cancel', orderId, status: 'success' });
    return result;
  } catch (err) {
    console.error(`❌ 取消失敗:`, err.message || JSON.stringify(err));
    appendLog({ action: 'cancel', orderId, status: 'failed', error: err.message });
    throw err;
  }
}

async function getOrders() {
  const orders = await client.rest.spotWallet.getOpenOrders({ market: MARKET });
  console.log(`📋 未成交訂單 (${orders.length}):`, JSON.stringify(orders, null, 2));
  return orders;
}

async function getTrades() {
  const trades = await client.rest.spotWallet.getTrades({ market: MARKET, limit: 20 });
  console.log(`📋 最近成交 (${trades.length}):`, JSON.stringify(trades, null, 2));
  return trades;
}

// ========== CLI ==========
const [,, cmd, ...args] = process.argv;

(async () => {
  try {
    switch (cmd) {
      case 'balance': await getBalance(); break;
      case 'buy': await placeLimitOrder('buy', parseFloat(args[0]), parseFloat(args[1])); break;
      case 'sell': await placeLimitOrder('sell', parseFloat(args[0]), parseFloat(args[1])); break;
      case 'buy_market': await placeMarketBuy(parseFloat(args[0])); break;
      case 'sell_market': await placeMarketSell(parseFloat(args[0])); break;
      case 'cancel': await cancelOrder(parseInt(args[0])); break;
      case 'orders': await getOrders(); break;
      case 'trades': await getTrades(); break;
      default:
        console.log('用法:');
        console.log('  node money_maker_order.js balance');
        console.log('  node money_maker_order.js buy <price> <amount>');
        console.log('  node money_maker_order.js sell <price> <amount>');
        console.log('  node money_maker_order.js buy_market <total_twd>');
        console.log('  node money_maker_order.js sell_market <amount>');
        console.log('  node money_maker_order.js cancel <order_id>');
        console.log('  node money_maker_order.js orders');
        console.log('  node money_maker_order.js trades');
    }
  } catch (err) {
    process.exit(1);
  }
})();
