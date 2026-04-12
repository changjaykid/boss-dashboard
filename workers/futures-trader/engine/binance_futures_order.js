#!/usr/bin/env node
/**
 * Binance USDT-M Futures 下單模組
 * 用法：
 *   node binance_futures_order.js balance
 *   node binance_futures_order.js positions
 *   node binance_futures_order.js leverage <symbol> <leverage>
 *   node binance_futures_order.js margin_type <symbol> <ISOLATED|CROSSED>
 *   node binance_futures_order.js buy <symbol> <quantity>
 *   node binance_futures_order.js sell <symbol> <quantity>
 *   node binance_futures_order.js close <symbol>
 *   node binance_futures_order.js klines <symbol> <interval> [limit]
 *   node binance_futures_order.js price <symbol>
 *   node binance_futures_order.js test
 */

const crypto = require('crypto');
const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, 'binance_futures_config.json');
const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

const BASE_URL = config.baseUrl || 'https://fapi.binance.com';
const API_KEY = config.apiKey;
const SECRET_KEY = config.secretKey;

// ============ HTTP helpers ============

function sign(queryString) {
  return crypto.createHmac('sha256', SECRET_KEY).update(queryString).digest('hex');
}

function request(method, endpoint, params = {}, signed = true) {
  return new Promise((resolve, reject) => {
    let qs = Object.entries(params).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    
    if (signed) {
      if (qs) qs += '&';
      qs += `timestamp=${Date.now()}`;
      qs += `&signature=${sign(qs)}`;
    }

    const url = method === 'GET' && qs ? `${endpoint}?${qs}` : endpoint;
    const urlObj = new URL(url, BASE_URL);

    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'X-MBX-APIKEY': API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.code && parsed.code !== 200) {
            reject(new Error(`Binance API Error ${parsed.code}: ${parsed.msg}`));
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Parse error: ${data}`));
        }
      });
    });

    req.on('error', reject);
    if (method === 'POST' || method === 'PUT' || method === 'DELETE') {
      req.write(qs);
    }
    req.end();
  });
}

// ============ API Functions ============

async function getBalance() {
  const data = await request('GET', '/fapi/v2/balance');
  // Filter to show only non-zero balances
  const nonZero = data.filter(b => parseFloat(b.balance) > 0 || parseFloat(b.crossUnPnl) !== 0);
  return nonZero.length > 0 ? nonZero : [{ asset: 'USDT', balance: '0', availableBalance: '0' }];
}

async function getPositions() {
  const data = await request('GET', '/fapi/v2/positionRisk');
  return data.filter(p => parseFloat(p.positionAmt) !== 0);
}

async function setLeverage(symbol, leverage) {
  return await request('POST', '/fapi/v1/leverage', { symbol, leverage });
}

async function setMarginType(symbol, marginType) {
  try {
    return await request('POST', '/fapi/v1/marginType', { symbol, marginType });
  } catch (e) {
    // -4046 means "No need to change margin type" — not an error
    if (e.message.includes('-4046')) return { msg: 'Already set' };
    throw e;
  }
}

async function placeOrder(symbol, side, quantity, opts = {}) {
  const params = {
    symbol,
    side, // BUY or SELL
    type: opts.type || 'MARKET',
    quantity
  };
  
  if (opts.price) params.price = opts.price;
  if (opts.stopPrice) params.stopPrice = opts.stopPrice;
  if (opts.timeInForce) params.timeInForce = opts.timeInForce;
  if (opts.reduceOnly) params.reduceOnly = 'true';
  if (opts.closePosition) params.closePosition = 'true';
  
  return await request('POST', '/fapi/v1/order', params);
}

async function closePosition(symbol) {
  // Get current position
  const positions = await request('GET', '/fapi/v2/positionRisk', { symbol });
  const pos = positions.find(p => parseFloat(p.positionAmt) !== 0);
  if (!pos) return { msg: 'No open position' };
  
  const amt = parseFloat(pos.positionAmt);
  const side = amt > 0 ? 'SELL' : 'BUY';
  const quantity = Math.abs(amt);
  
  return await placeOrder(symbol, side, quantity, { reduceOnly: true });
}

async function getKlines(symbol, interval, limit = 100) {
  return await request('GET', '/fapi/v1/klines', { symbol, interval, limit }, false);
}

async function getPrice(symbol) {
  return await request('GET', '/fapi/v1/ticker/price', { symbol }, false);
}

async function testConnection() {
  // 1. Test public endpoint
  const price = await getPrice('BTCUSDT');
  console.log(`✅ 公開API正常 — BTC/USDT: $${price.price}`);
  
  // 2. Test authenticated endpoint
  const balance = await getBalance();
  const usdt = balance.find(b => b.asset === 'USDT') || balance[0];
  console.log(`✅ 認證API正常 — USDT餘額: ${usdt.balance} (可用: ${usdt.availableBalance})`);
  
  return { price: price.price, balance: usdt };
}

// ============ CLI ============

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  try {
    switch (cmd) {
      case 'test':
        await testConnection();
        break;
      case 'balance':
        console.log(JSON.stringify(await getBalance(), null, 2));
        break;
      case 'positions':
        console.log(JSON.stringify(await getPositions(), null, 2));
        break;
      case 'leverage':
        console.log(JSON.stringify(await setLeverage(args[1], parseInt(args[2]))));
        break;
      case 'margin_type':
        console.log(JSON.stringify(await setMarginType(args[1], args[2])));
        break;
      case 'buy':
        console.log(JSON.stringify(await placeOrder(args[1], 'BUY', args[2])));
        break;
      case 'sell':
        console.log(JSON.stringify(await placeOrder(args[1], 'SELL', args[2])));
        break;
      case 'close':
        console.log(JSON.stringify(await closePosition(args[1])));
        break;
      case 'klines':
        console.log(JSON.stringify(await getKlines(args[1], args[2], args[3] || 100)));
        break;
      case 'price':
        console.log(JSON.stringify(await getPrice(args[1] || 'BTCUSDT')));
        break;
      default:
        console.log('Commands: test | balance | positions | leverage | margin_type | buy | sell | close | klines | price');
    }
  } catch (e) {
    console.error(`❌ ${e.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  getBalance, getPositions, setLeverage, setMarginType,
  placeOrder, closePosition, getKlines, getPrice, request,
  sign, API_KEY, SECRET_KEY, BASE_URL
};
