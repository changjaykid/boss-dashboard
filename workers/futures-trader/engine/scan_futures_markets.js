#!/usr/bin/env node
/**
 * Binance Futures 動態換幣掃描器
 * 每 6 小時掃描，選出最有動能的 2 個幣種
 */
const https = require('https');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'active_futures_markets.json');
const FIXED = ['BTCUSDT'];
const CANDIDATES = ['SOLUSDT','DOGEUSDT','XRPUSDT','BNBUSDT','LINKUSDT','AVAXUSDT','ARBUSDT','DOTUSDT'];

function fetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

async function main() {
  console.log(`[${new Date().toISOString()}] 🔍 掃描 Binance Futures 動能...`);
  const tickers = await fetch('https://fapi.binance.com/fapi/v1/ticker/24hr');
  const scores = [];
  for (const sym of CANDIDATES) {
    const t = tickers.find(x => x.symbol === sym);
    if (!t) continue;
    const vol = parseFloat(t.quoteVolume || 0);
    const chg = Math.abs(parseFloat(t.priceChangePercent || 0));
    const high = parseFloat(t.highPrice || 0), low = parseFloat(t.lowPrice || 0);
    const volatility = low > 0 ? (high - low) / low * 100 : 0;
    const score = (vol / 1e9) * 0.4 + volatility * 0.4 + chg * 0.2;
    scores.push({ symbol: sym, vol: (vol/1e9).toFixed(2)+'B', volatility: volatility.toFixed(2), change: chg.toFixed(2), score: score.toFixed(2) });
  }
  scores.sort((a, b) => b.score - a.score);
  const picks = scores.slice(0, 2).map(s => s.symbol);
  const all = [...FIXED, ...picks];
  console.log('\n📊 動能排名:');
  scores.forEach((s, i) => {
    console.log(`  ${picks.includes(s.symbol)?'✅':'  '} ${i+1}. ${s.symbol}: score=${s.score} | vol=${s.vol} | vol%=${s.volatility}% | chg=${s.change}%`);
  });
  console.log(`\n🎯 本輪: ${all.join(', ')}`);
  fs.writeFileSync(CONFIG_FILE, JSON.stringify({ lastScan: new Date().toISOString(), allMarkets: all, scores: scores.slice(0,5) }, null, 2));
}
main().catch(e => { console.error(e.message); process.exit(1); });
