#!/usr/bin/env node
/**
 * 虛擬貨幣賺錢機 — 資料抓取 & 技術指標計算
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

const ALL_MARKETS = ['btctwd', 'ethtwd', 'soltwd', 'dogetwd'];

// ========== 技術指標計算 ==========

function calcEMA(data, period) {
  const k = 2 / (period + 1);
  const ema = [data[0]];
  for (let i = 1; i < data.length; i++) {
    ema.push(data[i] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  const rsiArr = [];
  for (let i = period; i < closes.length; i++) {
    if (i > period) {
      const diff = closes[i] - closes[i - 1];
      avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
      avgLoss = (avgLoss * (period - 1) + (diff < 0 ? -diff : 0)) / period;
    }
    const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
    rsiArr.push(100 - 100 / (1 + rs));
  }
  return rsiArr;
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return null;
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macdLine = emaFast.map((v, i) => v - emaSlow[i]);
  const signalLine = calcEMA(macdLine.slice(slow - 1), signal);
  const offset = slow - 1;
  const histogram = [];
  for (let i = 0; i < signalLine.length; i++) {
    histogram.push(macdLine[offset + i] - signalLine[i]);
  }
  return {
    macd: macdLine[macdLine.length - 1],
    signal: signalLine[signalLine.length - 1],
    histogram: histogram[histogram.length - 1],
    prevHistogram: histogram.length > 1 ? histogram[histogram.length - 2] : 0
  };
}

function calcBollinger(closes, period = 20, mult = 2) {
  if (closes.length < period) return null;
  const slice = closes.slice(-period);
  const sma = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - sma) ** 2, 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: sma + mult * std,
    middle: sma,
    lower: sma - mult * std,
    width: (mult * std * 2) / sma * 100, // 寬度百分比
    squeeze: std / sma < 0.01 // 擠壓
  };
}

function calcATR(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  return atr;
}

function calcVWAP(highs, lows, closes, volumes) {
  let cumTPV = 0, cumVol = 0;
  for (let i = 0; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    cumTPV += tp * volumes[i];
    cumVol += volumes[i];
  }
  return cumVol > 0 ? cumTPV / cumVol : closes[closes.length - 1];
}

function calcVolumeMA(volumes, period = 20) {
  if (volumes.length < period) return null;
  return volumes.slice(-period).reduce((a, b) => a + b, 0) / period;
}

// ========== K 線型態辨識 ==========

function detectCandlePatterns(candles) {
  if (candles.length < 3) return [];
  const patterns = [];
  const c = candles;
  const last = c.length - 1;
  const prev = last - 1;
  
  const body = i => Math.abs(c[i].close - c[i].open);
  const range = i => c[i].high - c[i].low;
  const isBullish = i => c[i].close > c[i].open;
  const isBearish = i => c[i].close < c[i].open;
  const upperShadow = i => c[i].high - Math.max(c[i].open, c[i].close);
  const lowerShadow = i => Math.min(c[i].open, c[i].close) - c[i].low;
  
  // 看多吞噬
  if (isBearish(prev) && isBullish(last) && 
      c[last].close > c[prev].open && c[last].open < c[prev].close &&
      body(last) > body(prev)) {
    patterns.push('bullish_engulfing');
  }
  
  // 看空吞噬
  if (isBullish(prev) && isBearish(last) &&
      c[last].close < c[prev].open && c[last].open > c[prev].close &&
      body(last) > body(prev)) {
    patterns.push('bearish_engulfing');
  }
  
  // 錘子線（下影線長、上影線短、實體在上方）
  if (lowerShadow(last) > body(last) * 2 && upperShadow(last) < body(last) * 0.3 && range(last) > 0) {
    patterns.push('hammer');
  }
  
  // 射擊之星（上影線長、下影線短、實體在下方）
  if (upperShadow(last) > body(last) * 2 && lowerShadow(last) < body(last) * 0.3 && range(last) > 0) {
    patterns.push('shooting_star');
  }
  
  // Pin Bar（單邊影線超長）
  if (range(last) > 0) {
    if (lowerShadow(last) > range(last) * 0.6) patterns.push('pin_bar_bullish');
    if (upperShadow(last) > range(last) * 0.6) patterns.push('pin_bar_bearish');
  }
  
  // 十字星
  if (body(last) < range(last) * 0.1 && range(last) > 0) {
    patterns.push('doji');
  }
  
  // 連續同向 K 線
  let bullCount = 0, bearCount = 0;
  for (let i = last; i >= Math.max(0, last - 4); i--) {
    if (isBullish(i)) bullCount++; else break;
  }
  for (let i = last; i >= Math.max(0, last - 4); i--) {
    if (isBearish(i)) bearCount++; else break;
  }
  if (bullCount >= 3) patterns.push(`consecutive_bull_${bullCount}`);
  if (bearCount >= 3) patterns.push(`consecutive_bear_${bearCount}`);
  
  return patterns;
}

// ========== 趨勢判斷 ==========

function judgeTrend(ema8, ema21, rsi, macd) {
  let score = 0;
  if (ema8 > ema21) score += 2; else score -= 2;
  if (rsi > 55) score += 1; else if (rsi < 45) score -= 1;
  if (macd && macd.histogram > 0) score += 1; else if (macd && macd.histogram < 0) score -= 1;
  
  if (score >= 3) return 'strong_up';
  if (score >= 1) return 'up';
  if (score <= -3) return 'strong_down';
  if (score <= -1) return 'down';
  return 'neutral';
}

// ========== 支撐壓力位 ==========

function findSupportResistance(candles, count = 3) {
  const highs = candles.map(c => c.high).sort((a, b) => b - a);
  const lows = candles.map(c => c.low).sort((a, b) => a - b);
  
  return {
    resistance: [...new Set(highs.slice(0, count))],
    support: [...new Set(lows.slice(0, count))]
  };
}

// ========== 主函數 ==========

async function fetchMarket(market) {
  const OUTPUT_FILE = path.join(DATA_DIR, `money_maker_market_${market}.json`);
  try {
    console.log(`[${new Date().toISOString()}] 賺錢機資料抓取開始... 幣種: ${market}`);
    
    // 抓 ticker
    const tickers = await client.rest.getTickers({ markets: [market] });
    const ticker = tickers[0];
    if (!ticker) throw new Error(`找不到 ${market} ticker`);
    
    // 抓 K 線
    const [k15m, k1h, k4h] = await Promise.all([
      client.rest.getKLine({ market: market, period: 15, limit: 100 }),
      client.rest.getKLine({ market: market, period: 60, limit: 50 }),
      client.rest.getKLine({ market: market, period: 240, limit: 30 }),
    ]);
    
    const parseKlines = (raw) => raw.map(k => ({
      time: new Date(k[0]).getTime(),
      open: parseFloat(k[1]),
      high: parseFloat(k[2]),
      low: parseFloat(k[3]),
      close: parseFloat(k[4]),
      volume: parseFloat(k[5])
    }));
    
    const candles15m = parseKlines(k15m);
    const candles1h = parseKlines(k1h);
    const candles4h = parseKlines(k4h);
    
    const extract = (candles) => ({
      closes: candles.map(c => c.close),
      highs: candles.map(c => c.high),
      lows: candles.map(c => c.low),
      volumes: candles.map(c => c.volume)
    });
    
    const d15 = extract(candles15m);
    const d1h = extract(candles1h);
    const d4h = extract(candles4h);
    
    // 15M 指標
    const ema8_15m = calcEMA(d15.closes, 8);
    const ema21_15m = calcEMA(d15.closes, 21);
    const rsi_15m = calcRSI(d15.closes, 14);
    const macd_15m = calcMACD(d15.closes);
    const bb_15m = calcBollinger(d15.closes);
    const atr_15m = calcATR(d15.highs, d15.lows, d15.closes);
    const vwap_15m = calcVWAP(d15.highs, d15.lows, d15.closes, d15.volumes);
    const volMA_15m = calcVolumeMA(d15.volumes);
    const patterns_15m = detectCandlePatterns(candles15m);
    const sr_15m = findSupportResistance(candles15m.slice(-30));
    
    // 1H 指標
    const ema8_1h = calcEMA(d1h.closes, 8);
    const ema21_1h = calcEMA(d1h.closes, 21);
    const rsi_1h = calcRSI(d1h.closes, 14);
    const macd_1h = calcMACD(d1h.closes);
    
    // 4H 指標
    const ema8_4h = calcEMA(d4h.closes, 8);
    const ema21_4h = calcEMA(d4h.closes, 21);
    const rsi_4h = calcRSI(d4h.closes, 14);
    
    const trend15m = judgeTrend(ema8_15m[ema8_15m.length - 1], ema21_15m[ema21_15m.length - 1], rsi_15m ? rsi_15m[rsi_15m.length - 1] : 50, macd_15m);
    const trend1h = judgeTrend(ema8_1h[ema8_1h.length - 1], ema21_1h[ema21_1h.length - 1], rsi_1h ? rsi_1h[rsi_1h.length - 1] : 50, macd_1h);
    const trend4h = judgeTrend(ema8_4h[ema8_4h.length - 1], ema21_4h[ema21_4h.length - 1], rsi_4h ? rsi_4h[rsi_4h.length - 1] : 50, null);
    
    const emaCross15m = (() => {
      const len = ema8_15m.length;
      if (len < 2) return 'none';
      const curr = ema8_15m[len - 1] - ema21_15m[len - 1];
      const prev = ema8_15m[len - 2] - ema21_15m[len - 2];
      if (prev <= 0 && curr > 0) return 'golden_cross';
      if (prev >= 0 && curr < 0) return 'death_cross';
      return 'none';
    })();
    
    const lastVol = d15.volumes[d15.volumes.length - 1];
    const volRatio = volMA_15m ? lastVol / volMA_15m : 1;
    
    const output = {
      timestamp: new Date().toISOString(),
      market: market,
      
      ticker: {
        last: parseFloat(ticker.last),
        buy: parseFloat(ticker.buy),
        buyVol: parseFloat(ticker.buyVol || 0),
        sell: parseFloat(ticker.sell),
        sellVol: parseFloat(ticker.sellVol || 0),
        high: parseFloat(ticker.high),
        low: parseFloat(ticker.low),
        open: parseFloat(ticker.open || 0),
        vol: parseFloat(ticker.vol),
        change24h: ticker.open ? ((parseFloat(ticker.last) - parseFloat(ticker.open)) / parseFloat(ticker.open) * 100) : null
      },
      
      indicators: {
        '15m': {
          ema8: ema8_15m[ema8_15m.length - 1],
          ema21: ema21_15m[ema21_15m.length - 1],
          emaRelation: ema8_15m[ema8_15m.length - 1] > ema21_15m[ema21_15m.length - 1] ? 'bullish' : 'bearish',
          emaCross: emaCross15m,
          rsi: rsi_15m ? rsi_15m[rsi_15m.length - 1] : null,
          macd: macd_15m,
          bollinger: bb_15m,
          atr: atr_15m,
          vwap: vwap_15m,
          priceVsVwap: d15.closes[d15.closes.length - 1] > vwap_15m ? 'above' : 'below',
          volume: lastVol,
          volumeMA20: volMA_15m,
          volumeRatio: volRatio,
          volumeConfirm: volRatio > 1.2,
          trend: trend15m,
          candlePatterns: patterns_15m,
          supportResistance: sr_15m,
          lastCandle: candles15m[candles15m.length - 1],
          prevCandle: candles15m[candles15m.length - 2]
        },
        '1h': {
          ema8: ema8_1h[ema8_1h.length - 1],
          ema21: ema21_1h[ema21_1h.length - 1],
          emaRelation: ema8_1h[ema8_1h.length - 1] > ema21_1h[ema21_1h.length - 1] ? 'bullish' : 'bearish',
          rsi: rsi_1h ? rsi_1h[rsi_1h.length - 1] : null,
          macd: macd_1h,
          trend: trend1h
        },
        '4h': {
          ema8: ema8_4h[ema8_4h.length - 1],
          ema21: ema21_4h[ema21_4h.length - 1],
          emaRelation: ema8_4h[ema8_4h.length - 1] > ema21_4h[ema21_4h.length - 1] ? 'bullish' : 'bearish',
          rsi: rsi_4h ? rsi_4h[rsi_4h.length - 1] : null,
          trend: trend4h
        }
      },
      
      multiTimeframe: {
        trend15m,
        trend1h,
        trend4h,
        aligned: trend15m === trend1h && (trend1h === trend4h || trend4h === 'neutral'),
        direction: trend15m.includes('up') && trend1h.includes('up') ? 'BUY' :
                   trend15m.includes('down') && trend1h.includes('down') ? 'SELL' : 'NONE'
      }
    };
    
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(output, null, 2));
    console.log(`[${new Date().toISOString()}] ✅ 市場資料已更新 → ${OUTPUT_FILE}`);
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ 抓取失敗 (${market}):`, err.message);
  }
}

const inputMarket = process.argv[2];

(async () => {
  if (inputMarket) {
    await fetchMarket(inputMarket);
  } else {
    for (const m of ALL_MARKETS) {
      await fetchMarket(m);
      await new Promise(r => setTimeout(r, 1000)); // sleep 1s between markets
    }
  }
})();
