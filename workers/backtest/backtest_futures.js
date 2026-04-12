#!/usr/bin/env node
/**
 * BTC/USDT Futures Backtest Framework
 * Fetches historical klines from Binance, runs strategies, reports results.
 * 
 * Usage: node backtest_futures.js [--days 30] [--strategy VWAP_BOUNCE]
 */

const https = require('https');
const fs = require('fs');
const path = require('path');

const RESULTS_DIR = path.join(__dirname, 'results');

// === Fetch Binance klines ===
function fetchKlines(symbol, interval, limit = 500) {
  return new Promise((resolve, reject) => {
    const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const raw = JSON.parse(data);
          resolve(raw.map(k => ({
            openTime: k[0], open: +k[1], high: +k[2], low: +k[3], close: +k[4],
            volume: +k[5], closeTime: k[6]
          })));
        } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// === Indicators ===
function ema(data, period) {
  const k = 2 / (period + 1); const r = [data[0]];
  for (let i = 1; i < data.length; i++) r.push(data[i] * k + r[i-1] * (1-k));
  return r;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i-1]; d > 0 ? g += d : l -= d; }
  let ag = g/period, al = l/period;
  const arr = [];
  for (let i = period; i < closes.length; i++) {
    if (i > period) { const d = closes[i]-closes[i-1]; ag = (ag*(period-1)+(d>0?d:0))/period; al = (al*(period-1)+(d<0?-d:0))/period; }
    arr.push(al === 0 ? 100 : 100-100/(1+ag/al));
  }
  return arr;
}

function macd(closes, fast=12, slow=26, sig=9) {
  if (closes.length < slow+sig) return [];
  const ef = ema(closes, fast), es = ema(closes, slow);
  const ml = ef.map((v,i) => v - es[i]);
  const sl2 = ema(ml.slice(slow-1), sig);
  const hist = [];
  for (let i = 0; i < sl2.length; i++) hist.push({ macd: ml[slow-1+i], signal: sl2[i], histogram: ml[slow-1+i]-sl2[i] });
  return hist;
}

function bb(closes, period=20, dev=2) {
  if (closes.length < period) return null;
  const s = closes.slice(-period);
  const m = s.reduce((a,b)=>a+b,0)/period;
  const std = Math.sqrt(s.reduce((a,b)=>a+(b-m)**2,0)/period);
  return { upper: m+dev*std, middle: m, lower: m-dev*std, width: (dev*std*2)/m*100 };
}

function atr(candles, period=14) {
  if (candles.length < period+1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    trs.push(Math.max(candles[i].high-candles[i].low, Math.abs(candles[i].high-candles[i-1].close), Math.abs(candles[i].low-candles[i-1].close)));
  }
  let a = trs.slice(0,period).reduce((s,v)=>s+v,0)/period;
  for (let i = period; i < trs.length; i++) a = (a*(period-1)+trs[i])/period;
  return a;
}

function vwap(candles) {
  let tpv = 0, tv = 0;
  for (const c of candles) { const tp = (c.high+c.low+c.close)/3; tpv += tp*c.volume; tv += c.volume; }
  return tv > 0 ? tpv/tv : null;
}

// === Strategy Signals ===
function getSignal(strategy, candles15m, candles1h, i) {
  // i = current bar index in candles15m (use data up to i, not beyond)
  const c15 = candles15m.slice(Math.max(0, i-100), i+1);
  const closes15 = c15.map(c => c.close);
  if (closes15.length < 30) return null;
  
  const price = closes15[closes15.length - 1];
  const rsiArr = rsi(closes15);
  const rsiVal = rsiArr ? rsiArr[rsiArr.length - 1] : null;
  const ema8 = ema(closes15, 8);
  const ema21 = ema(closes15, 21);
  const e8 = ema8[ema8.length-1], e21 = ema21[ema21.length-1];
  const macdArr = macd(closes15);
  const macdLast = macdArr.length ? macdArr[macdArr.length-1] : null;
  const bbVal = bb(closes15);
  const atrVal = atr(c15);
  
  switch(strategy) {
    case 'TREND_FOLLOW': {
      if (e8 > e21 && rsiVal && rsiVal >= 40 && rsiVal <= 60 && macdLast && macdLast.histogram > 0)
        return { dir: 'LONG', sl: atrVal * 1.5, tp: atrVal * 3 };
      if (e8 < e21 && rsiVal && rsiVal >= 40 && rsiVal <= 60 && macdLast && macdLast.histogram < 0)
        return { dir: 'SHORT', sl: atrVal * 1.5, tp: atrVal * 3 };
      return null;
    }
    case 'MOMENTUM': {
      if (closes15.length < 5) return null;
      const mom = (closes15[closes15.length-1] - closes15[closes15.length-4]) / closes15[closes15.length-4] * 100;
      if (mom > 0.5 && rsiVal && rsiVal > 55) return { dir: 'LONG', sl: atrVal*1.5, tp: atrVal*3 };
      if (mom < -0.5 && rsiVal && rsiVal < 45) return { dir: 'SHORT', sl: atrVal*1.5, tp: atrVal*3 };
      return null;
    }
    case 'RSI_BB_ADAPTIVE': {
      // RSI breaks BB applied to RSI
      if (!rsiArr || rsiArr.length < 22) return null;
      const rsiSlice = rsiArr.slice(-20);
      const mean = rsiSlice.reduce((a,b)=>a+b,0)/20;
      const std = Math.sqrt(rsiSlice.reduce((a,b)=>a+(b-mean)**2,0)/20);
      const upper = mean+2*std, lower = mean-2*std;
      const currR = rsiArr[rsiArr.length-1], prevR = rsiArr[rsiArr.length-2];
      if (prevR <= upper && currR > upper && e8 > e21) return { dir: 'LONG', sl: atrVal*1.5, tp: atrVal*3 };
      if (prevR >= lower && currR < lower && e8 < e21) return { dir: 'SHORT', sl: atrVal*1.5, tp: atrVal*3 };
      return null;
    }
    case 'VWAP_BOUNCE': {
      const vwapVal = vwap(c15.slice(-96));
      if (!vwapVal || !rsiVal || !atrVal) return null;
      const dist = (price - vwapVal) / vwapVal * 100;
      if (dist < -0.3 && dist > -1.0 && rsiVal < 40 && e8 > e21) return { dir: 'LONG', sl: atrVal*1.2, tp: atrVal*2.5 };
      if (dist > 0.3 && dist < 1.0 && rsiVal > 60 && e8 < e21) return { dir: 'SHORT', sl: atrVal*1.2, tp: atrVal*2.5 };
      return null;
    }
    case 'SESSION_BREAKOUT': {
      const h = new Date(c15[c15.length-1].openTime).getUTCHours();
      if (h < 7 || h > 16) return null;
      const asianCandles = c15.filter(c => { const ch = new Date(c.openTime).getUTCHours(); return ch >= 0 && ch < 7; });
      if (asianCandles.length < 8) return null;
      const aHigh = Math.max(...asianCandles.map(c=>c.high));
      const aLow = Math.min(...asianCandles.map(c=>c.low));
      const aRange = aHigh - aLow;
      if (aRange < price * 0.002) return null;
      if (price > aHigh) return { dir: 'LONG', sl: atrVal*1.2, tp: aRange*1.5 };
      if (price < aLow) return { dir: 'SHORT', sl: atrVal*1.2, tp: aRange*1.5 };
      return null;
    }
    case 'STOCH_RSI_CROSS': {
      if (!rsiArr || rsiArr.length < 20) return null;
      // Simple stochastic on RSI
      const stochP = 14;
      if (rsiArr.length < stochP + 3) return null;
      const rSlice = rsiArr.slice(-(stochP+1));
      const hi1 = Math.max(...rSlice.slice(0,-1)), lo1 = Math.min(...rSlice.slice(0,-1));
      const k1 = hi1===lo1 ? 50 : (rSlice[rSlice.length-1]-lo1)/(hi1-lo1)*100;
      const hi2 = Math.max(...rSlice.slice(0,-2).concat(rSlice.slice(-2,-1))), lo2 = Math.min(...rSlice.slice(0,-2));
      const k2 = hi2===lo2 ? 50 : (rSlice[rSlice.length-2]-lo2)/(hi2-lo2)*100;
      if (k2 < 20 && k1 > 20 && e8 > e21) return { dir: 'LONG', sl: atrVal*1.5, tp: atrVal*3 };
      if (k2 > 80 && k1 < 80 && e8 < e21) return { dir: 'SHORT', sl: atrVal*1.5, tp: atrVal*3 };
      return null;
    }
    case 'MACD_DIVERGENCE': {
      if (!macdArr.length || closes15.length < 30) return null;
      const recent = closes15.slice(-15), older = closes15.slice(-30,-15);
      const recentLow = Math.min(...recent), olderLow = Math.min(...older);
      const recentHigh = Math.max(...recent), olderHigh = Math.max(...older);
      const hist = macdLast.histogram;
      if (recentLow < olderLow && hist > -0.5) return { dir: 'LONG', sl: atrVal*1.5, tp: atrVal*3 };
      if (recentHigh > olderHigh && hist < 0.5) return { dir: 'SHORT', sl: atrVal*1.5, tp: atrVal*3 };
      return null;
    }
    case 'COMPOUND_MOMENTUM': {
      // 4+ indicators agree
      let buy = 0, sell = 0;
      if (rsiVal > 55) buy++; else if (rsiVal < 45) sell++;
      if (e8 > e21) buy++; else sell++;
      if (macdLast && macdLast.histogram > 0) buy++; else if (macdLast) sell++;
      if (bbVal && price > bbVal.middle) buy++; else if (bbVal) sell++;
      // Volume surge
      if (c15.length >= 20) {
        const rv = c15.slice(-3).reduce((s,c)=>s+c.volume,0)/3;
        const av = c15.slice(-20,-3).reduce((s,c)=>s+c.volume,0)/17;
        if (rv > av*1.3) { if (buy > sell) buy++; else sell++; }
      }
      if (buy >= 4) return { dir: 'LONG', sl: atrVal*1.2, tp: atrVal*2.5 };
      if (sell >= 4) return { dir: 'SHORT', sl: atrVal*1.2, tp: atrVal*2.5 };
      return null;
    }
  }
  return null;
}

// === Backtest Runner ===
async function backtest(strategy, days = 30) {
  console.log(`\n📊 Backtesting ${strategy} on BTCUSDT (${days} days)...`);
  
  const limit = Math.min(1500, days * 96); // 15m candles
  const candles15m = await fetchKlines('BTCUSDT', '15m', limit);
  const candles1h = await fetchKlines('BTCUSDT', '1h', Math.min(500, days * 24));
  
  const FEE = 0.0004; // 0.04% taker
  const SLIPPAGE = 0.0002; // 0.02%
  const INITIAL = 10000;
  let balance = INITIAL;
  let trades = [];
  let lastTradeBar = -10;
  
  for (let i = 50; i < candles15m.length - 1; i++) {
    if (i - lastTradeBar < 4) continue; // Cooldown: 1 hour
    
    const signal = getSignal(strategy, candles15m, candles1h, i);
    if (!signal || !signal.sl || signal.sl <= 0) continue;
    
    const entry = candles15m[i].close * (1 + SLIPPAGE * (signal.dir === 'LONG' ? 1 : -1));
    const sl = signal.sl;
    const tp = signal.tp || sl * 2;
    
    // Simulate forward
    let pnl = null;
    let exitPrice = null;
    let exitReason = '';
    
    for (let j = i + 1; j < Math.min(i + 48, candles15m.length); j++) { // Max 12h hold
      const c = candles15m[j];
      if (signal.dir === 'LONG') {
        if (c.low <= entry - sl) { exitPrice = entry - sl; exitReason = 'SL'; pnl = -sl; break; }
        if (c.high >= entry + tp) { exitPrice = entry + tp; exitReason = 'TP'; pnl = tp; break; }
      } else {
        if (c.high >= entry + sl) { exitPrice = entry + sl; exitReason = 'SL'; pnl = -sl; break; }
        if (c.low <= entry - tp) { exitPrice = entry - tp; exitReason = 'TP'; pnl = tp; break; }
      }
    }
    
    if (pnl === null) continue; // Didn't hit SL/TP
    
    // Apply fee
    const feeCost = entry * FEE * 2; // entry + exit
    const netPnl = pnl - feeCost;
    const pctPnl = (netPnl / entry) * 100;
    
    balance += netPnl * 10; // Simulated 10x leverage on $1000 position
    
    trades.push({
      bar: i, entry: entry.toFixed(1), dir: signal.dir, pnl: netPnl.toFixed(2),
      pctPnl: pctPnl.toFixed(3), reason: exitReason,
      time: new Date(candles15m[i].openTime).toISOString()
    });
    
    lastTradeBar = i;
  }
  
  // Calculate stats
  const wins = trades.filter(t => +t.pnl > 0);
  const losses = trades.filter(t => +t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + (+t.pnl), 0);
  const avgWin = wins.length ? wins.reduce((s,t) => s + (+t.pnl), 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((s,t) => s + (+t.pnl), 0) / losses.length) : 0;
  const rr = avgLoss > 0 ? avgWin / avgLoss : 0;
  
  // Max drawdown
  let peak = INITIAL, maxDD = 0, equity = INITIAL;
  for (const t of trades) {
    equity += (+t.pnl) * 10;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak * 100;
    if (dd > maxDD) maxDD = dd;
  }
  
  const result = {
    strategy,
    days,
    totalTrades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: trades.length ? (wins.length / trades.length * 100).toFixed(1) + '%' : '0%',
    totalPnl: totalPnl.toFixed(2),
    avgWin: avgWin.toFixed(2),
    avgLoss: avgLoss.toFixed(2),
    riskReward: rr.toFixed(2),
    maxDrawdown: maxDD.toFixed(2) + '%',
    finalBalance: balance.toFixed(2),
    returnPct: ((balance - INITIAL) / INITIAL * 100).toFixed(2) + '%'
  };
  
  console.log(`\n=== ${strategy} Results ===`);
  console.log(`Trades: ${result.totalTrades} | Win: ${result.wins} | Loss: ${result.losses} | WR: ${result.winRate}`);
  console.log(`Total PnL: $${result.totalPnl} | Avg Win: $${result.avgWin} | Avg Loss: $${result.avgLoss}`);
  console.log(`Risk/Reward: ${result.riskReward} | Max DD: ${result.maxDrawdown}`);
  console.log(`Final Balance: $${result.finalBalance} (${result.returnPct})`);
  
  return result;
}

// === Main ===
async function main() {
  const args = process.argv.slice(2);
  let days = 15; // Default: 15 days (Binance limit ~1500 candles for 15m)
  let strategies = ['TREND_FOLLOW', 'MOMENTUM', 'RSI_BB_ADAPTIVE', 'VWAP_BOUNCE', 'SESSION_BREAKOUT', 'STOCH_RSI_CROSS', 'MACD_DIVERGENCE', 'COMPOUND_MOMENTUM'];
  
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days' && args[i+1]) days = parseInt(args[i+1]);
    if (args[i] === '--strategy' && args[i+1]) strategies = [args[i+1]];
  }
  
  const allResults = [];
  for (const s of strategies) {
    try {
      const r = await backtest(s, days);
      allResults.push(r);
      await new Promise(r => setTimeout(r, 500)); // Rate limit
    } catch(e) {
      console.error(`❌ ${s}: ${e.message}`);
    }
  }
  
  // Sort by total PnL
  allResults.sort((a, b) => parseFloat(b.totalPnl) - parseFloat(a.totalPnl));
  
  console.log('\n\n========== STRATEGY RANKING ==========');
  allResults.forEach((r, i) => {
    console.log(`${i+1}. ${r.strategy.padEnd(22)} PnL: $${r.totalPnl.padStart(8)} | WR: ${r.winRate.padStart(6)} | RR: ${r.riskReward} | Trades: ${r.totalTrades}`);
  });
  
  // Save results
  const outFile = path.join(RESULTS_DIR, `backtest_futures_${new Date().toISOString().slice(0,10)}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ timestamp: new Date().toISOString(), days, results: allResults }, null, 2));
  console.log(`\n💾 Results saved to ${outFile}`);
}

main().catch(e => { console.error(e); process.exit(1); });
