#!/usr/bin/env node
/**
 * 從 Binance API 拉真實成交紀錄，回補 state 和 dashboard
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const TRADING_DIR = __dirname;
const STATE_FILE = path.join(TRADING_DIR, 'binance_futures_state.json');
const LOG_FILE = path.join(TRADING_DIR, 'binance_futures_log.json');
const DASHBOARD_FILE = path.join(TRADING_DIR, '..', 'boss-dashboard', 'crypto-futures-data.json');
const CONFIG_FILE = path.join(TRADING_DIR, 'binance_futures_config.json');

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const SYMBOL = 'BTCUSDT';
const INITIAL_CAPITAL = 464;

function apiRequest(method, endpoint, params = {}) {
  return new Promise((resolve, reject) => {
    params.timestamp = Date.now();
    params.recvWindow = 5000;
    const qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    const signature = crypto.createHmac('sha256', config.secretKey).update(qs).digest('hex');
    const fullQs = `${qs}&signature=${signature}`;
    const url = `${endpoint}?${fullQs}`;
    
    const options = {
      hostname: 'fapi.binance.com',
      path: url,
      method,
      headers: { 'X-MBX-APIKEY': config.apiKey }
    };
    
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.code && parsed.code !== 200) reject(new Error(`API: ${parsed.msg}`));
          else resolve(parsed);
        } catch { reject(new Error(data)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  console.log('📊 拉取 Binance 歷史成交...');
  
  // 拉最近 500 筆成交
  const trades = await apiRequest('GET', '/fapi/v1/userTrades', { symbol: SYMBOL, limit: 500 });
  console.log(`找到 ${trades.length} 筆成交`);
  
  if (trades.length === 0) {
    console.log('沒有成交紀錄');
    return;
  }
  
  // 按時間排序
  trades.sort((a, b) => a.time - b.time);
  
  // 分組：把成交組合成「交易」（開倉→平倉）
  const roundTrips = [];
  let currentPos = null;
  
  for (const t of trades) {
    const side = t.side; // BUY or SELL
    const qty = parseFloat(t.qty);
    const price = parseFloat(t.price);
    const pnl = parseFloat(t.realizedPnl);
    const commission = parseFloat(t.commission);
    const time = new Date(t.time).toISOString();
    
    if (pnl !== 0) {
      // This trade has realized PnL → it's a closing trade
      roundTrips.push({
        time,
        side: side === 'SELL' ? 'LONG' : 'SHORT', // if selling to close = was LONG
        size: qty,
        entryPrice: currentPos?.entryPrice || price,
        exitPrice: price,
        pnl: pnl - commission,
        rawPnl: pnl,
        commission,
        strategy: 'RECOVERED'
      });
      currentPos = null;
    } else {
      // Opening trade
      currentPos = { side: side === 'BUY' ? 'LONG' : 'SHORT', entryPrice: price, size: qty, time };
    }
  }
  
  console.log(`\n組合出 ${roundTrips.length} 筆完整交易：`);
  
  let totalPnl = 0;
  let wins = 0;
  let losses = 0;
  const tradeHistory = [];
  
  for (const rt of roundTrips) {
    const netPnl = rt.rawPnl;
    totalPnl += netPnl;
    if (netPnl > 0) wins++;
    else losses++;
    
    console.log(`  ${rt.time} | ${rt.side} ${rt.size} | 入 ${rt.entryPrice} → 出 ${rt.exitPrice} | PnL: $${netPnl.toFixed(4)}`);
    
    tradeHistory.push({
      time: rt.time,
      strategy: rt.strategy,
      pnl: netPnl,
      side: rt.side,
      entry: rt.entryPrice,
      exit: rt.exitPrice,
      size: rt.size
    });
  }
  
  console.log(`\n📊 統計：${roundTrips.length} 筆 | 贏 ${wins} | 虧 ${losses} | 總PnL: $${totalPnl.toFixed(4)}`);
  console.log(`勝率: ${roundTrips.length > 0 ? ((wins/roundTrips.length)*100).toFixed(1) : 0}%`);
  
  // 更新 state
  const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  state.tradeHistory = tradeHistory;
  state.totalStats.trades = roundTrips.length;
  state.totalStats.wins = wins;
  state.totalStats.losses = losses;
  state.totalStats.pnl = parseFloat(totalPnl.toFixed(4));
  state.totalStats.winRate = roundTrips.length > 0 ? parseFloat(((wins/roundTrips.length)*100).toFixed(1)) : 0;
  
  // 更新 maxDrawdown
  let peak = INITIAL_CAPITAL;
  let maxDD = 0;
  let running = INITIAL_CAPITAL;
  for (const t of tradeHistory) {
    running += t.pnl;
    if (running > peak) peak = running;
    const dd = (peak - running) / peak;
    if (dd > maxDD) maxDD = dd;
  }
  state.totalStats.maxDrawdown = parseFloat((maxDD * 100).toFixed(2));
  state.totalStats.peakBalance = parseFloat(peak.toFixed(2));
  
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  console.log('\n✅ State 已更新');
  
  // 更新 log file
  fs.writeFileSync(LOG_FILE, JSON.stringify(tradeHistory, null, 2));
  console.log('✅ Log 已更新');
  
  // 觸發 dashboard 更新（讀 state 重新生成）
  const dashboard = JSON.parse(fs.readFileSync(DASHBOARD_FILE, 'utf8'));
  dashboard.recentTrades = tradeHistory.slice(-10).reverse();
  dashboard.account.totalTrades = roundTrips.length;
  dashboard.account.wins = wins;
  dashboard.account.losses = losses;
  dashboard.account.totalPnl = parseFloat(totalPnl.toFixed(4));
  dashboard.account.winRate = roundTrips.length > 0 ? ((wins/roundTrips.length)*100).toFixed(1) + '%' : '--';
  dashboard.account.maxDrawdown = state.totalStats.maxDrawdown;
  dashboard.totalStats = state.totalStats;
  
  fs.writeFileSync(DASHBOARD_FILE, JSON.stringify(dashboard, null, 2));
  console.log('✅ Dashboard 已更新');
}

main().catch(e => { console.error('❌', e.message); process.exit(1); });
