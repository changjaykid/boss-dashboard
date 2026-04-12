#!/usr/bin/env node
/**
 * Binance Futures 市場資料抓取模組
 * 抓取 K 線、指標計算、資金費率、深度
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

function httpGet(endpoint, params = {}, signed = false) {
  return new Promise((resolve, reject) => {
    let qs = Object.entries(params).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    if (signed) {
      if (qs) qs += '&';
      qs += `timestamp=${Date.now()}`;
      const sig = crypto.createHmac('sha256', SECRET_KEY).update(qs).digest('hex');
      qs += `&signature=${sig}`;
    }
    const urlObj = new URL(`${endpoint}${qs ? '?' + qs : ''}`, BASE_URL);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: { 'X-MBX-APIKEY': API_KEY }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { reject(new Error(`Parse error: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ============ K 線 ============

async function getKlines(symbol, interval, limit = 100) {
  const raw = await httpGet('/fapi/v1/klines', { symbol, interval, limit });
  return raw.map(k => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6],
    quoteVolume: parseFloat(k[7]),
    trades: k[8]
  }));
}

// ============ 技術指標計算 ============

function calcEMA(data, period) {
  const k = 2 / (period + 1);
  let ema = data[0];
  const result = [ema];
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function calcRSI(closes, period = 14) {
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  if (gains.length < period) return null;
  
  let avgGain = gains.slice(0, period).reduce((a, b) => a + b) / period;
  let avgLoss = losses.slice(0, period).reduce((a, b) => a + b) / period;
  const rsiArr = [];
  
  for (let i = period; i < gains.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i]) / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiArr.push(100 - (100 / (1 + rs)));
  }
  return rsiArr.length > 0 ? rsiArr[rsiArr.length - 1] : null;
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = calcEMA(macdLine.slice(slow - 1), signal);
  const macd = macdLine[macdLine.length - 1];
  const sig = signalLine[signalLine.length - 1];
  const hist = macd - sig;
  const prevHist = macdLine[macdLine.length - 2] - signalLine[signalLine.length - 2];
  return { macd, signal: sig, histogram: hist, prevHistogram: prevHist };
}

function calcBollingerBands(closes, period = 20, stdDev = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b) / period;
  const variance = slice.reduce((a, b) => a + Math.pow(b - sma, 2), 0) / period;
  const std = Math.sqrt(variance);
  const upper = sma + stdDev * std;
  const lower = sma - stdDev * std;
  const width = ((upper - lower) / sma) * 100;
  return { upper, middle: sma, lower, width, std };
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    trs.push(tr);
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

function calcADX(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;
  const plusDM = [], minusDM = [], trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const upMove = c.high - p.high;
    const downMove = p.low - c.low;
    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  
  // Smooth with EMA
  const smoothATR = calcEMA(trs, period);
  const smoothPlusDM = calcEMA(plusDM, period);
  const smoothMinusDM = calcEMA(minusDM, period);
  
  const diPlus = smoothPlusDM.map((v, i) => smoothATR[i] > 0 ? (v / smoothATR[i]) * 100 : 0);
  const diMinus = smoothMinusDM.map((v, i) => smoothATR[i] > 0 ? (v / smoothATR[i]) * 100 : 0);
  const dx = diPlus.map((v, i) => {
    const sum = v + diMinus[i];
    return sum > 0 ? (Math.abs(v - diMinus[i]) / sum) * 100 : 0;
  });
  
  const adx = calcEMA(dx.slice(period), period);
  return {
    adx: adx[adx.length - 1],
    diPlus: diPlus[diPlus.length - 1],
    diMinus: diMinus[diMinus.length - 1]
  };
}

function calcVolumeProfile(candles) {
  if (candles.length < 5) return { avgVolume: 0, currentRatio: 0, trend: 'unknown' };
  const recent = candles.slice(-5);
  const older = candles.slice(-20, -5);
  const avgRecent = recent.reduce((a, c) => a + c.volume, 0) / recent.length;
  const avgOlder = older.length > 0 ? older.reduce((a, c) => a + c.volume, 0) / older.length : avgRecent;
  return {
    avgVolume: avgOlder,
    currentVolume: avgRecent,
    ratio: avgOlder > 0 ? avgRecent / avgOlder : 1,
    trend: avgRecent > avgOlder * 1.3 ? 'increasing' : avgRecent < avgOlder * 0.7 ? 'decreasing' : 'stable'
  };
}

// ============ 資金費率 ============

async function getFundingRate(symbol = 'BTCUSDT') {
  const data = await httpGet('/fapi/v1/fundingRate', { symbol, limit: 1 });
  const premium = await httpGet('/fapi/v1/premiumIndex', { symbol });
  return {
    lastFundingRate: data[0] ? parseFloat(data[0].fundingRate) : 0,
    lastFundingTime: data[0] ? data[0].fundingTime : null,
    nextFundingRate: premium.lastFundingRate ? parseFloat(premium.lastFundingRate) : 0,
    nextFundingTime: premium.nextFundingTime || null,
    markPrice: parseFloat(premium.markPrice),
    indexPrice: parseFloat(premium.indexPrice)
  };
}

// ============ 綜合分析 ============

async function getFullAnalysis(symbol = 'BTCUSDT') {
  // Fetch multiple timeframes
  const [klines15m, klines1h, klines4h, funding] = await Promise.all([
    getKlines(symbol, '15m', 100),
    getKlines(symbol, '1h', 100),
    getKlines(symbol, '4h', 50),
    getFundingRate(symbol)
  ]);

  function analyzeTimeframe(candles, label) {
    const closes = candles.map(c => c.close);
    const current = closes[closes.length - 1];
    
    const ema8 = calcEMA(closes, 8);
    const ema21 = calcEMA(closes, 21);
    const ema55 = calcEMA(closes, 55);
    
    return {
      label,
      current,
      candles: candles.slice(-5), // Last 5 candles for pattern detection
      ema8: ema8[ema8.length - 1],
      ema21: ema21[ema21.length - 1],
      ema55: ema55.length > 0 ? ema55[ema55.length - 1] : null,
      rsi: calcRSI(closes, 14),
      macd: calcMACD(closes),
      bb: calcBollingerBands(closes),
      atr: calcATR(candles),
      adx: calcADX(candles),
      volume: calcVolumeProfile(candles)
    };
  }

  const tf15m = analyzeTimeframe(klines15m, '15m');
  const tf1h = analyzeTimeframe(klines1h, '1h');
  const tf4h = analyzeTimeframe(klines4h, '4h');

  // Detect market state from 1h
  let marketState = 'RANGING';
  if (tf1h.adx && tf1h.adx.adx > 25) {
    marketState = tf1h.ema8 > tf1h.ema21 ? 'TRENDING_UP' : 'TRENDING_DOWN';
  }
  if (tf1h.bb && tf1h.bb.width < 2) marketState = 'CONSOLIDATING';
  if (tf1h.atr && tf1h.bb) {
    const avgATR = tf1h.atr;
    // High volatility check
    if (tf1h.bb.width > 4) marketState = 'HIGH_VOLATILITY';
  }
  // Extreme sentiment via RSI
  if (tf1h.rsi && (tf1h.rsi < 25 || tf1h.rsi > 75)) {
    marketState = 'EXTREME';
  }

  return {
    symbol,
    timestamp: new Date().toISOString(),
    price: tf15m.current,
    marketState,
    timeframes: { '15m': tf15m, '1h': tf1h, '4h': tf4h },
    funding,
    raw15m: klines15m // For momentum detection
  };
}

// ============ CLI ============

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'full';
  const symbol = args[1] || 'BTCUSDT';

  try {
    switch (cmd) {
      case 'full':
        const analysis = await getFullAnalysis(symbol);
        console.log(JSON.stringify(analysis, null, 2));
        break;
      case 'funding':
        console.log(JSON.stringify(await getFundingRate(symbol), null, 2));
        break;
      case 'klines':
        console.log(JSON.stringify(await getKlines(symbol, args[2] || '15m', args[3] || 50), null, 2));
        break;
      default:
        console.log('Commands: full [symbol] | funding [symbol] | klines [symbol] [interval] [limit]');
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
  getKlines, getFullAnalysis, getFundingRate,
  calcEMA, calcRSI, calcMACD, calcBollingerBands, calcATR, calcADX, calcVolumeProfile
};
