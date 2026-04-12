#!/usr/bin/env node
/**
 * 動態換幣掃描器
 * 每 6 小時掃描 MAX 所有 TWD 交易對
 * 找出成交量和波動率最高的幣種
 * 更新 engine 的 ALL_MARKETS 設定
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'active_markets.json');

// 固定幣種（不換）
const FIXED_MARKETS = ['btctwd', 'ethtwd'];
// 候選幣種池（流動性足夠的）
const CANDIDATES = ['soltwd', 'dogetwd', 'xrptwd', 'bnbtwd', 'linktwd', 'avaxtwd', 'arbtwd', 'dottwd', 'ltctwd'];
// 動態位置數
const DYNAMIC_SLOTS = 2;

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log(`[${new Date().toISOString()}] 🔍 掃描 TWD 市場動能...`);
  
  const scores = [];
  
  for (const market of CANDIDATES) {
    try {
      // 取得 ticker
      const ticker = await fetchJSON(`https://max-api.maicoin.com/api/v3/ticker?market=${market}`);
      
      const last = parseFloat(ticker.last || 0);
      const vol = parseFloat(ticker.vol || 0);
      const high = parseFloat(ticker.high || 0);
      const low = parseFloat(ticker.low || 0);
      const open = parseFloat(ticker.open || last);
      
      if (last <= 0 || vol <= 0) continue;
      
      const turnover = last * vol;           // TWD 成交額
      const volatility = high > 0 && low > 0 ? (high - low) / low * 100 : 0;  // 日波動率 %
      const change = open > 0 ? (last - open) / open * 100 : 0;  // 日漲跌幅
      
      // 動能分數 = 成交額權重 40% + 波動率權重 40% + 絕對漲跌幅 20%
      const score = (turnover / 1000000) * 0.4 + volatility * 0.4 + Math.abs(change) * 0.2;
      
      scores.push({
        market,
        last,
        turnover,
        volatility: volatility.toFixed(2),
        change: change.toFixed(2),
        score: score.toFixed(2)
      });
      
    } catch(e) {
      console.error(`  ⚠️ ${market}: ${e.message}`);
    }
  }
  
  // 排序取前 N
  scores.sort((a, b) => parseFloat(b.score) - parseFloat(a.score));
  
  const dynamicPicks = scores.slice(0, DYNAMIC_SLOTS).map(s => s.market);
  const allMarkets = [...FIXED_MARKETS, ...dynamicPicks];
  
  console.log('\n📊 候選幣種動能排名:');
  scores.forEach((s, i) => {
    const picked = dynamicPicks.includes(s.market) ? '✅' : '  ';
    console.log(`  ${picked} ${i+1}. ${s.market}: score=${s.score} | turnover=NT$${(s.turnover/1000000).toFixed(1)}M | vol=${s.volatility}% | chg=${s.change}%`);
  });
  
  console.log(`\n🎯 本輪幣種: ${allMarkets.join(', ')}`);
  
  // 保存結果
  const config = {
    lastScan: new Date().toISOString(),
    fixedMarkets: FIXED_MARKETS,
    dynamicMarkets: dynamicPicks,
    allMarkets,
    scores: scores.slice(0, 5),
    nextScan: new Date(Date.now() + 6 * 3600 * 1000).toISOString()
  };
  
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log(`✅ 已更新 ${CONFIG_FILE}`);
}

main().catch(e => {
  console.error('掃描失敗:', e.message);
  process.exit(1);
});
