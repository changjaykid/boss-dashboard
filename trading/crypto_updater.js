#!/usr/bin/env node
// MAX Exchange 虛擬貨幣自動交易 - 數據更新器
// 用途：抓取帳戶餘額、幣價、掛單等資訊，輸出到主控板用的 JSON

const { MAX } = require('max-exchange-api-node');
const fs = require('fs');
const path = require('path');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'crypto_config.json'), 'utf8'));

const { rest } = new MAX({
  accessKey: CONFIG.api.access_key,
  secretKey: CONFIG.api.secret_key
});

// 監控幣對（TWD 和 USDT 計價）
const WATCH_MARKETS = [
  'btctwd', 'ethtwd', 'soltwd', 'dogetwd', 'xrptwd',
  'btcusdt', 'ethusdt', 'solusdt'
];

async function fetchAll() {
  const result = {
    lastUpdate: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
    exchange: 'MAX (MaiCoin)',
    status: 'connected',
    account: {},
    tickers: [],
    openOrders: [],
    recentTrades: [],
    marketSentiment: {}
  };

  // 1. 帳戶餘額
  try {
    const accounts = await rest.spotWallet.getAccounts({ market: 'usdt' });
    const balances = accounts
      .filter(a => parseFloat(a.balance) > 0 || parseFloat(a.locked) > 0)
      .map(a => ({
        currency: a.currency.toUpperCase(),
        available: a.balance,
        locked: a.locked,
        staked: a.staked || '0'
      }));
    
    // 計算總資產（TWD 計價）
    let totalTWD = 0;
    for (const b of balances) {
      if (b.currency === 'TWD') {
        totalTWD += parseFloat(b.available) + parseFloat(b.locked);
      } else {
        // 嘗試用 TWD 計價
        try {
          const ticker = await rest.getTicker({ market: b.currency.toLowerCase() + 'twd' });
          if (ticker && ticker.last) {
            totalTWD += (parseFloat(b.available) + parseFloat(b.locked)) * parseFloat(ticker.last);
          }
        } catch (e) { /* 沒有 TWD 交易對就跳過 */ }
      }
    }

    result.account = {
      balances,
      totalValueTWD: totalTWD.toFixed(2),
      totalBalances: balances.length
    };
  } catch (e) {
    result.account = { error: e.message };
  }

  // 2. 幣價行情（逐一查詢避免 SDK 問題）
  try {
    const tickers = [];
    for (const m of WATCH_MARKETS) {
      try {
        const t = await rest.getTicker({ market: m });
        if (t && t.last) {
          tickers.push({
            market: m,
            name: m.replace('twd', '/TWD').replace('usdt', '/USDT').toUpperCase(),
            last: t.last,
            open: t.open,
            high: t.high,
            low: t.low,
            vol: t.vol,
            change: t.open && parseFloat(t.open) > 0
              ? (((parseFloat(t.last) - parseFloat(t.open)) / parseFloat(t.open)) * 100).toFixed(2)
              : '0'
          });
        }
      } catch (e) { /* 該幣對不存在 */ }
    }
    result.tickers = tickers;
  } catch (e) {
    result.tickers = [];
  }

  // 3. 掛單（所有監控幣對）
  try {
    let allOrders = [];
    for (const m of WATCH_MARKETS) {
      try {
        const orders = await rest.spotWallet.getOpenOrders({ market: m });
        if (orders && orders.length) {
          allOrders = allOrders.concat(orders.map(o => ({
            ...o,
            market: m
          })));
        }
      } catch (e) { /* 跳過 */ }
    }
    result.openOrders = allOrders;
  } catch (e) {
    result.openOrders = [];
  }

  // 4. 最近成交（只顯示 2026/3/27 以後、最多 15 筆）
  const CUTOFF = new Date('2026-03-27T00:00:00+08:00').getTime();
  try {
    let allTrades = [];
    for (const m of WATCH_MARKETS) {
      try {
        const trades = await rest.spotWallet.getTrades({ market: m, limit: 20 });
        if (trades && trades.length) {
          allTrades = allTrades.concat(trades.map(t => ({ ...t, market: m })));
        }
      } catch (e) { /* 跳過 */ }
    }
    result.recentTrades = allTrades
      .filter(t => new Date(t.createdAt).getTime() >= CUTOFF)
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .slice(0, 15);
  } catch (e) {
    result.recentTrades = [];
  }

  // 5. 恐懼貪婪指數（從公開 API）
  try {
    const https = require('https');
    const fgData = await new Promise((resolve, reject) => {
      https.get('https://api.alternative.me/fng/?limit=1', res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
      }).on('error', reject);
    });
    if (fgData && fgData.data && fgData.data[0]) {
      result.marketSentiment.fearGreed = {
        value: fgData.data[0].value,
        label: fgData.data[0].value_classification
      };
    }
  } catch (e) { /* 跳過 */ }

  return result;
}

async function main() {
  console.log('正在抓取 MAX 交易所數據...');
  const data = await fetchAll();
  
  // 寫到主控板目錄
  const dashboardPath = path.join(__dirname, '..', 'boss-dashboard', 'crypto-trading-data.json');
  fs.writeFileSync(dashboardPath, JSON.stringify(data, null, 2));
  console.log('✅ 數據已更新:', dashboardPath);
  
  // 也存一份在 trading 目錄
  const localPath = path.join(__dirname, 'crypto_dashboard_data.json');
  fs.writeFileSync(localPath, JSON.stringify(data, null, 2));
  
  console.log('帳戶餘額:', JSON.stringify(data.account.balances || [], null, 2));
  console.log('監控幣對:', data.tickers.length, '個');
  console.log('掛單:', data.openOrders.length, '筆');
}

main().catch(e => {
  console.error('❌ 錯誤:', e.message);
  process.exit(1);
});
