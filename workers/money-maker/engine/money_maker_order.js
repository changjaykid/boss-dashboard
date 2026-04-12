#!/usr/bin/env node
/**
 * 虛擬貨幣賺錢機 — 下單 & 帳戶查詢工具
 */

const { MAX } = require('max-exchange-api-node');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'crypto_config.json'), 'utf8'));
const client = new MAX({
  accessKey: CONFIG.api.access_key,
  secretKey: CONFIG.api.secret_key
});

const LOG_FILE = path.join(DATA_DIR, 'money_maker_order_log.json');

const MARKET_CONFIGS = {
  btctwd:  { minAmount: 0.0001, decimals: 8, minTwd: 250 },
  ethtwd:  { minAmount: 0.0037, decimals: 8, minTwd: 250 },
  soltwd:  { minAmount: 0.09,   decimals: 4, minTwd: 250 },
  dogetwd: { minAmount: 80,     decimals: 0, minTwd: 250 },
  xrptwd:  { minAmount: 5.5,    decimals: 2, minTwd: 250 },
  bnbtwd:  { minAmount: 0.012,  decimals: 4, minTwd: 250 },
  linktwd: { minAmount: 0.9,    decimals: 2, minTwd: 250 },
  avaxtwd: { minAmount: 0.88,   decimals: 2, minTwd: 250 },
  arbtwd:  { minAmount: 72,     decimals: 0, minTwd: 250 },
  dottwd:  { minAmount: 5.0,    decimals: 2, minTwd: 250 },
  ltctwd:  { minAmount: 0.15,   decimals: 4, minTwd: 250 },
};

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
  const eth = accounts.find(a => a.currency === 'eth') || { balance: '0', locked: '0' };
  const sol = accounts.find(a => a.currency === 'sol') || { balance: '0', locked: '0' };
  const doge = accounts.find(a => a.currency === 'doge') || { balance: '0', locked: '0' };
  
  const result = {
    twd: { available: parseFloat(twd.balance), locked: parseFloat(twd.locked) },
    btc: { available: parseFloat(btc.balance), locked: parseFloat(btc.locked) },
    eth: { available: parseFloat(eth.balance), locked: parseFloat(eth.locked) },
    sol: { available: parseFloat(sol.balance), locked: parseFloat(sol.locked) },
    doge: { available: parseFloat(doge.balance), locked: parseFloat(doge.locked) }
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function placeLimitOrder(market, side, price, amount) {
  console.log(`📝 下限價單: ${market} ${side} ${amount} @ ${price} TWD`);
  try {
    const order = await client.rest.spotWallet.submitOrder({
      market: market,
      side: side,
      volume: amount.toString(),
      price: price.toString(),
      ord_type: 'limit'
    });
    console.log(`✅ 訂單成功:`, JSON.stringify(order, null, 2));
    appendLog({ action: 'limit_order', market, side, price, amount, orderId: order.id, status: 'success' });
    return order;
  } catch (err) {
    console.error(`❌ 下單失敗:`, err.message || JSON.stringify(err));
    appendLog({ action: 'limit_order', market, side, price, amount, status: 'failed', error: err.message });
    throw err;
  }
}

async function placeMarketBuy(market, totalTwd) {
  console.log(`📝 市價買入: ${market} 花 ${totalTwd} TWD`);
  try {
    const ticker = await client.rest.getTicker({ market: market });
    const askPrice = parseFloat(ticker.sell || ticker.ask);
    if (!askPrice || askPrice <= 0) throw new Error(`無法取得賣價: ${JSON.stringify(ticker)}`);
    
    const safeTotal = totalTwd * 0.995;
    const decimals = MARKET_CONFIGS[market] ? MARKET_CONFIGS[market].decimals : 8;
    const mult = Math.pow(10, decimals);
    const volume = Math.floor((safeTotal / askPrice) * mult) / mult;
    if (volume <= 0) throw new Error(`計算數量為 0, TWD=${totalTwd}, price=${askPrice}`);
    
    console.log(`   當前賣價: ${askPrice} TWD, 預計買入: ${volume}`);
    
    const order = await client.rest.spotWallet.submitOrder({
      market: market,
      side: 'buy',
      volume: volume.toString(),
      ord_type: 'market'
    });
    console.log(`✅ 市價買入成功:`, JSON.stringify(order, null, 2));
    appendLog({ action: 'market_buy', market, totalTwd, volume, askPrice, orderId: order.id, status: 'success' });
    return order;
  } catch (err) {
    console.error(`❌ 市價買入失敗:`, err.message || JSON.stringify(err));
    appendLog({ action: 'market_buy', market, totalTwd, status: 'failed', error: err.message });
    throw err;
  }
}

async function placeMarketSell(market, amount) {
  console.log(`📝 市價賣出: ${market} ${amount}`);
  try {
    const order = await client.rest.spotWallet.submitOrder({
      market: market,
      side: 'sell',
      volume: amount.toString(),
      ord_type: 'market'
    });
    console.log(`✅ 市價賣出成功:`, JSON.stringify(order, null, 2));
    appendLog({ action: 'market_sell', market, amount, orderId: order.id, status: 'success' });
    return order;
  } catch (err) {
    console.error(`❌ 市價賣出失敗:`, err.message || JSON.stringify(err));
    appendLog({ action: 'market_sell', market, amount, status: 'failed', error: err.message });
    throw err;
  }
}

async function cancelOrder(market, orderId) {
  console.log(`🗑️ 取消訂單: ${market} ${orderId}`);
  try {
    const result = await client.rest.cancelOrder({ id: orderId });
    console.log(`✅ 已取消:`, JSON.stringify(result, null, 2));
    appendLog({ action: 'cancel', market, orderId, status: 'success' });
    return result;
  } catch (err) {
    console.error(`❌ 取消失敗:`, err.message || JSON.stringify(err));
    appendLog({ action: 'cancel', market, orderId, status: 'failed', error: err.message });
    throw err;
  }
}

async function getOrders(market) {
  const orders = await client.rest.spotWallet.getOpenOrders({ market: market });
  console.log(`📋 未成交訂單 (${market}) (${orders.length}):`, JSON.stringify(orders, null, 2));
  return orders;
}

async function getTrades(market) {
  const trades = await client.rest.spotWallet.getTrades({ market: market, limit: 20 });
  console.log(`📋 最近成交 (${market}) (${trades.length}):`, JSON.stringify(trades, null, 2));
  return trades;
}

// ========== CLI ==========
const cmdOrMarket = process.argv[2];

(async () => {
  try {
    if (cmdOrMarket === 'balance') {
      await getBalance();
      return;
    }
    
    const market = cmdOrMarket;
    const cmd = process.argv[3];
    const args = process.argv.slice(4);

    if (!market || !cmd) {
      throw new Error('Missing market or cmd');
    }

    switch (cmd) {
      case 'buy': await placeLimitOrder(market, 'buy', parseFloat(args[0]), parseFloat(args[1])); break;
      case 'sell': await placeLimitOrder(market, 'sell', parseFloat(args[0]), parseFloat(args[1])); break;
      case 'buy_market': await placeMarketBuy(market, parseFloat(args[0])); break;
      case 'sell_market': await placeMarketSell(market, parseFloat(args[0])); break;
      case 'cancel': await cancelOrder(market, parseInt(args[0])); break;
      case 'orders': await getOrders(market); break;
      case 'trades': await getTrades(market); break;
      default:
        throw new Error('Unknown command');
    }
  } catch (err) {
    console.log('用法:');
    console.log('  node money_maker_order.js balance');
    console.log('  node money_maker_order.js <market> buy <price> <amount>');
    console.log('  node money_maker_order.js <market> sell <price> <amount>');
    console.log('  node money_maker_order.js <market> buy_market <total_twd>');
    console.log('  node money_maker_order.js <market> sell_market <amount>');
    console.log('  node money_maker_order.js <market> cancel <order_id>');
    console.log('  node money_maker_order.js <market> orders');
    console.log('  node money_maker_order.js <market> trades');
    process.exit(1);
  }
})();
