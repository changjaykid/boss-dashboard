#!/usr/bin/env node
// 虛擬貨幣策略回測器 — 獨立運行，不依賴引擎 state
// 用法：
//   node crypto_backtester.js --strategy trend_ema_cross --market btcusdt --period 30
//   node crypto_backtester.js --all --market btcusdt --period 30
//   node crypto_backtester.js --all --period 30  (所有 registry 策略 x 所有 watchlist 市場)

const { MAX } = require('max-exchange-api-node');
const fs = require('fs');
const path = require('path');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'crypto_config.json'), 'utf8'));
const { rest } = new MAX({
  accessKey: CONFIG.api.access_key,
  secretKey: CONFIG.api.secret_key
});

const REGISTRY_FILE = path.join(__dirname, 'crypto_strategy_registry.json');
const RESULTS_FILE = path.join(__dirname, 'backtest_results.json');

const WATCHLIST = ['btctwd', 'ethtwd', 'btcusdt', 'ethusdt', 'soltwd', 'dogetwd'];

// ========== PARSE ARGS ==========
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}
const hasFlag = (name) => args.includes(`--${name}`);

const targetStrategy = getArg('strategy');
const targetMarket = getArg('market');
const periodDays = parseInt(getArg('period') || '30');
const runAll = hasFlag('all');

if (!targetStrategy && !runAll) {
  console.log('用法: node crypto_backtester.js --strategy <name> --market <market> --period <days>');
  console.log('      node crypto_backtester.js --all --period <days>');
  process.exit(1);
}

// ========== TECHNICAL INDICATORS (複製自引擎核心) ==========
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  if (losses === 0) return 100;
  if (gains === 0) return 0;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

function calcEMA(data, period) {
  if (data.length === 0) return 0;
  const k = 2 / (period + 1);
  let ema = data[0];
  for (let i = 1; i < data.length; i++) ema = data[i] * k + ema * (1 - k);
  return ema;
}

function calcSMA(data, period) {
  if (data.length < period) return data.reduce((a, b) => a + b, 0) / data.length;
  const slice = data.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function calcBollinger(closes, period = 20) {
  if (closes.length < period) return { upper: 0, middle: 0, lower: 0, width: 0, pctB: 0.5 };
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  const upper = mean + 2 * std;
  const lower = mean - 2 * std;
  const current = closes[closes.length - 1];
  const pctB = std > 0 ? (current - lower) / (upper - lower) : 0.5;
  return { upper, middle: mean, lower, width: std > 0 ? (4 * std) / mean * 100 : 0, pctB };
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) return { macd: 0, signal: 0, histogram: 0 };
  const macdLine = [];
  for (let i = slow - 1; i < closes.length; i++) {
    const slice = closes.slice(0, i + 1);
    const emaFast = calcEMA(slice, fast);
    const emaSlow = calcEMA(slice, slow);
    macdLine.push(emaFast - emaSlow);
  }
  const signalLine = calcEMA(macdLine, signal);
  const macd = macdLine[macdLine.length - 1];
  return { macd, signal: signalLine, histogram: macd - signalLine };
}

function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const tr = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - candles[i - 1].close),
      Math.abs(candles[i].low - candles[i - 1].close)
    );
    sum += tr;
  }
  return sum / period;
}

function calcVWAP(candles) {
  let cumPV = 0, cumV = 0;
  for (const c of candles) {
    const typical = (c.high + c.low + c.close) / 3;
    cumPV += typical * c.volume;
    cumV += c.volume;
  }
  return cumV > 0 ? cumPV / cumV : 0;
}

function determineTrend(closes) {
  if (closes.length < 50) return 'unknown';
  const ema20 = calcEMA(closes, 20);
  const ema50 = calcEMA(closes, 50);
  const current = closes[closes.length - 1];
  if (current > ema20 && ema20 > ema50) return 'strong_up';
  if (current > ema20 || current > ema50) return 'up';
  if (current < ema20 && ema20 < ema50) return 'strong_down';
  if (current < ema20 || current < ema50) return 'down';
  return 'sideways';
}

function detectCandlePatterns(candles) {
  if (candles.length < 3) return [];
  const patterns = [];
  const c = candles[candles.length - 1];
  const p = candles[candles.length - 2];
  const pp = candles[candles.length - 3];
  const body = Math.abs(c.close - c.open);
  const range = c.high - c.low;
  if (range === 0) return patterns;
  const upperWick = c.high - Math.max(c.open, c.close);
  const lowerWick = Math.min(c.open, c.close) - c.low;
  const isBullish = c.close > c.open;
  const pBody = Math.abs(p.close - p.open);
  const pIsBullish = p.close > p.open;

  if (lowerWick > body * 2.5 && upperWick < body * 0.3) patterns.push({ name: 'hammer', direction: 'BUY', weight: 1.2 });
  if (upperWick > body * 2.5 && lowerWick < body * 0.3) patterns.push({ name: 'shooting_star', direction: 'SELL', weight: 1.2 });
  if (!pIsBullish && isBullish && c.close > p.open && c.open < p.close && body > pBody * 1.3) patterns.push({ name: 'bullish_engulfing', direction: 'BUY', weight: 1.5 });
  if (pIsBullish && !isBullish && c.close < p.open && c.open > p.close && body > pBody * 1.3) patterns.push({ name: 'bearish_engulfing', direction: 'SELL', weight: 1.5 });

  const ppBody = Math.abs(pp.close - pp.open);
  const ppIsBullish = pp.close > pp.open;
  if (!ppIsBullish && pBody < ppBody * 0.3 && isBullish && body > ppBody * 0.5) patterns.push({ name: 'morning_star', direction: 'BUY', weight: 1.8 });
  if (ppIsBullish && pBody < ppBody * 0.3 && !isBullish && body > ppBody * 0.5) patterns.push({ name: 'evening_star', direction: 'SELL', weight: 1.8 });
  if (body > range * 0.7 && range > 0) {
    if (isBullish) patterns.push({ name: 'strong_bull', direction: 'BUY', weight: 0.8 });
    else patterns.push({ name: 'strong_bear', direction: 'SELL', weight: 0.8 });
  }
  const pinThreshold = range * 0.6;
  if (lowerWick > pinThreshold && body < range * 0.25) patterns.push({ name: 'bullish_pin_bar', direction: 'BUY', weight: 1.3 });
  if (upperWick > pinThreshold && body < range * 0.25) patterns.push({ name: 'bearish_pin_bar', direction: 'SELL', weight: 1.3 });
  if (c.high > p.high && c.low < p.low) patterns.push({ name: 'outside_bar', direction: isBullish ? 'BUY' : 'SELL', weight: 1.4 });

  return patterns;
}

function volumeAnalysis(candles, period = 20) {
  if (candles.length < period + 1) return { ratio: 1, trend: 'flat' };
  const vols = candles.slice(-(period + 1), -1).map(c => c.volume);
  const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length;
  const currentVol = candles[candles.length - 1].volume;
  const ratio = avgVol > 0 ? currentVol / avgVol : 1;
  const recentAvg = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const olderAvg = vols.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
  const trend = recentAvg > olderAvg * 1.3 ? 'increasing' : recentAvg < olderAvg * 0.7 ? 'decreasing' : 'flat';
  return { ratio, trend };
}

function findSupportResistance(candles, lookback = 50) {
  if (candles.length < lookback) return { supports: [], resistances: [] };
  const recent = candles.slice(-lookback);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);
  const levels = [];
  for (let i = 2; i < recent.length - 2; i++) {
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2])
      levels.push({ price: highs[i], type: 'resistance' });
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2])
      levels.push({ price: lows[i], type: 'support' });
  }
  const currentPrice = recent[recent.length - 1].close;
  const supports = levels.filter(l => l.type === 'support' && l.price < currentPrice).map(l => l.price).sort((a, b) => b - a);
  const resistances = levels.filter(l => l.type === 'resistance' && l.price > currentPrice).map(l => l.price).sort((a, b) => a - b);
  return { supports: supports.slice(0, 3), resistances: resistances.slice(0, 3) };
}

// ========== STRATEGY FUNCTIONS (複製自引擎) ==========
function computeIndicatorsFromCandles(candles_1h, candles_15m) {
  // 回測用簡化版：從 1h 和 15m K 線計算指標
  const closes_1h = candles_1h.map(c => c.close);
  const closes_15m = candles_15m.map(c => c.close);
  const currentPrice = closes_15m.length > 0 ? closes_15m[closes_15m.length - 1] : 0;

  const trend1h = closes_1h.length >= 50 ? determineTrend(closes_1h) : 'unknown';
  const trend15m = closes_15m.length >= 50 ? determineTrend(closes_15m) : 'unknown';
  // For backtest, use 1h trends as proxies for daily/4h
  const dailyTrend = trend1h;
  const trend4h = trend1h;
  const trend5m = trend15m;

  const rsi_1h = calcRSI(closes_1h);
  const rsi_15m = calcRSI(closes_15m);
  const rsi_5m = rsi_15m; // proxy

  const macd_1h = calcMACD(closes_1h);
  const macd_15m = calcMACD(closes_15m);
  const bb_1h = calcBollinger(closes_1h);
  const bb_15m = calcBollinger(closes_15m);
  const atr_1h = calcATR(candles_1h);
  const atr_15m = calcATR(candles_15m);

  const ema8 = calcEMA(closes_15m, 8);
  const ema21 = calcEMA(closes_15m, 21);
  const ema50 = closes_15m.length >= 50 ? calcEMA(closes_15m, 50) : ema21;

  const patterns = detectCandlePatterns(candles_15m);
  const vol = volumeAnalysis(candles_15m);
  const vwap = calcVWAP(candles_15m.slice(-20));
  const sr_1h = findSupportResistance(candles_1h);
  const sr_15m = findSupportResistance(candles_15m);

  const atrPct = currentPrice > 0 ? atr_1h / currentPrice * 100 : 1;
  const stopPct = Math.max(0.3, Math.min(atrPct * 1.2, 1.5));
  const tpPct = atrPct * 2.5;

  return {
    currentPrice,
    closes_daily: closes_1h, closes_4h: closes_1h, closes_1h, closes_15m, closes_5m: closes_15m,
    dailyTrend, trend4h, trend1h, trend15m, trend5m,
    rsi_1h, rsi_15m, rsi_5m,
    macd_1h, macd_15m,
    bb_1h, bb_15m,
    atr_1h, atr_15m, atrPct,
    ema8, ema21, ema50,
    patterns, vol, vwap,
    sr_1h, sr_15m,
    stopPct: Math.round(stopPct * 1000) / 1000,
    tpPct: Math.round(tpPct * 1000) / 1000,
    riskRewardRatio: stopPct > 0 ? Math.round((tpPct / stopPct) * 100) / 100 : 0,
    candles_1h, candles_15m,
  };
}

// ===== 15 STRATEGY FUNCTIONS =====
const NONE_SIGNAL = (name) => ({ direction: 'NONE', confidence: 0, strategy: name, slPct: 0, tpPct: 0 });

function strategy_trend_ema_cross(ind) {
  const name = 'trend_ema_cross';
  const { ema8, ema21, ema50, currentPrice, rsi_15m, vol, dailyTrend, trend4h, stopPct, tpPct } = ind;
  const bullCross = ema8 > ema21 && ema21 > ema50;
  const bearCross = ema8 < ema21 && ema21 < ema50;
  const pullbackBull = bullCross && currentPrice > ema21 && (currentPrice - ema21) / currentPrice < 0.003;
  const pullbackBear = bearCross && currentPrice < ema21 && (ema21 - currentPrice) / currentPrice < 0.003;
  let confidence = 0, direction = 'NONE';
  if (bullCross) {
    direction = 'BUY'; confidence = 0.4;
    if (pullbackBull) confidence += 0.15;
    if (['strong_up', 'up'].includes(dailyTrend)) confidence += 0.1;
    if (['strong_up', 'up'].includes(trend4h)) confidence += 0.1;
    if (rsi_15m > 40 && rsi_15m < 65) confidence += 0.05;
    if (vol.ratio > 1.2) confidence += 0.05;
  } else if (bearCross) {
    direction = 'SELL'; confidence = 0.4;
    if (pullbackBear) confidence += 0.15;
    if (['strong_down', 'down'].includes(dailyTrend)) confidence += 0.1;
    if (['strong_down', 'down'].includes(trend4h)) confidence += 0.1;
    if (rsi_15m < 60 && rsi_15m > 35) confidence += 0.05;
    if (vol.ratio > 1.2) confidence += 0.05;
  }
  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_trend_mtf_alignment(ind) {
  const name = 'trend_mtf_alignment';
  const { trend4h, trend1h, trend15m, trend5m, stopPct, tpPct, vol } = ind;
  const bullTrends = ['strong_up', 'up'];
  const bearTrends = ['strong_down', 'down'];
  const bullCount = [trend4h, trend1h, trend15m, trend5m].filter(t => bullTrends.includes(t)).length;
  const bearCount = [trend4h, trend1h, trend15m, trend5m].filter(t => bearTrends.includes(t)).length;
  let direction = 'NONE', confidence = 0;
  if (bullCount >= 3) { direction = 'BUY'; confidence = 0.35 + bullCount * 0.1; if (bullCount === 4) confidence += 0.15; if (vol.ratio > 1.3) confidence += 0.05; }
  else if (bearCount >= 3) { direction = 'SELL'; confidence = 0.35 + bearCount * 0.1; if (bearCount === 4) confidence += 0.15; if (vol.ratio > 1.3) confidence += 0.05; }
  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_trend_momentum_chase(ind) {
  const name = 'trend_momentum_chase';
  const { vol, macd_15m, macd_1h, rsi_15m, currentPrice, ema8, stopPct, tpPct, dailyTrend, trend4h } = ind;
  if (vol.ratio < 1.5) return NONE_SIGNAL(name);
  let direction = 'NONE', confidence = 0;
  if (macd_15m.histogram > 0 && macd_1h.histogram > 0 && rsi_15m > 55 && currentPrice > ema8) {
    direction = 'BUY'; confidence = 0.45;
    if (vol.ratio > 2.0) confidence += 0.1; if (vol.ratio > 3.0) confidence += 0.1;
    if (['strong_up', 'up'].includes(dailyTrend)) confidence += 0.1;
    if (['strong_up', 'up'].includes(trend4h)) confidence += 0.05;
  } else if (macd_15m.histogram < 0 && macd_1h.histogram < 0 && rsi_15m < 45 && currentPrice < ema8) {
    direction = 'SELL'; confidence = 0.45;
    if (vol.ratio > 2.0) confidence += 0.1; if (vol.ratio > 3.0) confidence += 0.1;
    if (['strong_down', 'down'].includes(dailyTrend)) confidence += 0.1;
    if (['strong_down', 'down'].includes(trend4h)) confidence += 0.05;
  }
  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_trend_elliott_wave3(ind) {
  const name = 'trend_elliott_wave3';
  const { closes_1h, currentPrice, dailyTrend, trend4h, rsi_15m, stopPct, tpPct } = ind;
  if (closes_1h.length < 30) return NONE_SIGNAL(name);
  let direction = 'NONE', confidence = 0;
  const recent = closes_1h.slice(-30);
  let swingLow = Math.min(...recent.slice(0, 15));
  let swingHigh = Math.max(...recent.slice(5, 20));
  let retraceLevel = recent.slice(15, 25);
  let retraceLow = retraceLevel.length > 0 ? Math.min(...retraceLevel) : swingLow;
  const wave1Range = swingHigh - swingLow;
  if (wave1Range <= 0) return NONE_SIGNAL(name);
  const retracement = (swingHigh - retraceLow) / wave1Range;
  const isPushingUp = currentPrice > retraceLow && currentPrice > swingHigh * 0.98;
  let swingHighB = Math.max(...recent.slice(0, 15));
  let swingLowB = Math.min(...recent.slice(5, 20));
  let retraceLevelB = recent.slice(15, 25);
  let retraceHighB = retraceLevelB.length > 0 ? Math.max(...retraceLevelB) : swingHighB;
  const wave1RangeB = swingHighB - swingLowB;
  const retracementB = wave1RangeB > 0 ? (retraceHighB - swingLowB) / wave1RangeB : 0;
  const isPushingDown = currentPrice < retraceHighB && currentPrice < swingLowB * 1.02;
  if (retracement >= 0.38 && retracement <= 0.62 && isPushingUp) {
    direction = 'BUY'; confidence = 0.5;
    if (['strong_up', 'up'].includes(dailyTrend)) confidence += 0.1;
    if (['strong_up', 'up'].includes(trend4h)) confidence += 0.05;
    if (rsi_15m > 45 && rsi_15m < 70) confidence += 0.05;
  } else if (retracementB >= 0.38 && retracementB <= 0.62 && isPushingDown) {
    direction = 'SELL'; confidence = 0.5;
    if (['strong_down', 'down'].includes(dailyTrend)) confidence += 0.1;
    if (['strong_down', 'down'].includes(trend4h)) confidence += 0.05;
    if (rsi_15m < 55 && rsi_15m > 30) confidence += 0.05;
  }
  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_trend_flag_breakout(ind) {
  const name = 'trend_flag_breakout';
  const { candles_15m, currentPrice, vol, dailyTrend, stopPct, tpPct } = ind;
  if (candles_15m.length < 30) return NONE_SIGNAL(name);
  const recent = candles_15m.slice(-30);
  const pole = recent.slice(0, 10);
  const flag = recent.slice(10, 25);
  const poleMove = (pole[pole.length - 1].close - pole[0].open) / pole[0].open * 100;
  const flagHigh = Math.max(...flag.map(c => c.high));
  const flagLow = Math.min(...flag.map(c => c.low));
  const flagRange = flagHigh - flagLow;
  const poleRange = Math.abs(pole[pole.length - 1].close - pole[0].open);
  const isConsolidation = poleRange > 0 && flagRange / poleRange < 0.5;
  let direction = 'NONE', confidence = 0;
  if (poleMove > 1.0 && isConsolidation && currentPrice > flagHigh) {
    direction = 'BUY'; confidence = 0.5;
    if (vol.ratio > 1.3) confidence += 0.1; if (['strong_up', 'up'].includes(dailyTrend)) confidence += 0.1;
  } else if (poleMove < -1.0 && isConsolidation && currentPrice < flagLow) {
    direction = 'SELL'; confidence = 0.5;
    if (vol.ratio > 1.3) confidence += 0.1; if (['strong_down', 'down'].includes(dailyTrend)) confidence += 0.1;
  }
  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_reversion_sr(ind) {
  const name = 'reversion_sr';
  const { currentPrice, sr_1h, rsi_15m, patterns, bb_15m, stopPct, tpPct } = ind;
  let direction = 'NONE', confidence = 0;
  if (sr_1h.supports.length > 0) {
    const nearestSupport = sr_1h.supports[0];
    const distPct = (currentPrice - nearestSupport) / currentPrice * 100;
    if (distPct >= 0 && distPct < 0.5) {
      direction = 'BUY'; confidence = 0.45;
      if (rsi_15m < 35) confidence += 0.15; if (bb_15m.pctB < 0.1) confidence += 0.1;
      if (patterns.some(p => p.direction === 'BUY')) confidence += 0.1;
    }
  }
  if (direction === 'NONE' && sr_1h.resistances.length > 0) {
    const nearestResistance = sr_1h.resistances[0];
    const distPct = (nearestResistance - currentPrice) / currentPrice * 100;
    if (distPct >= 0 && distPct < 0.5) {
      direction = 'SELL'; confidence = 0.45;
      if (rsi_15m > 65) confidence += 0.15; if (bb_15m.pctB > 0.9) confidence += 0.1;
      if (patterns.some(p => p.direction === 'SELL')) confidence += 0.1;
    }
  }
  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_reversion_rsi_divergence(ind) {
  const name = 'reversion_rsi_divergence';
  const { closes_15m, rsi_15m, stopPct, tpPct } = ind;
  if (closes_15m.length < 30) return NONE_SIGNAL(name);
  const prices = closes_15m.slice(-20);
  const rsiValues = [];
  for (let i = 14; i <= closes_15m.length; i++) rsiValues.push(calcRSI(closes_15m.slice(0, i)));
  if (rsiValues.length < 10) return NONE_SIGNAL(name);
  const recentRSI = rsiValues.slice(-10);
  const recentPrices = prices.slice(-10);
  let direction = 'NONE', confidence = 0;
  const priceLow1 = Math.min(...recentPrices.slice(0, 5));
  const priceLow2 = Math.min(...recentPrices.slice(5));
  const rsiLow1 = Math.min(...recentRSI.slice(0, 5));
  const rsiLow2 = Math.min(...recentRSI.slice(5));
  if (priceLow2 < priceLow1 && rsiLow2 > rsiLow1 && rsi_15m < 40) {
    direction = 'BUY'; confidence = 0.5; if (rsi_15m < 30) confidence += 0.1;
  }
  const priceHigh1 = Math.max(...recentPrices.slice(0, 5));
  const priceHigh2 = Math.max(...recentPrices.slice(5));
  const rsiHigh1 = Math.max(...recentRSI.slice(0, 5));
  const rsiHigh2 = Math.max(...recentRSI.slice(5));
  if (direction === 'NONE' && priceHigh2 > priceHigh1 && rsiHigh2 < rsiHigh1 && rsi_15m > 60) {
    direction = 'SELL'; confidence = 0.5; if (rsi_15m > 70) confidence += 0.1;
  }
  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_reversion_bollinger(ind) {
  const name = 'reversion_bollinger';
  const { bb_15m, bb_1h, rsi_15m, stopPct, tpPct, dailyTrend } = ind;
  let direction = 'NONE', confidence = 0;
  if (bb_15m.pctB < 0.05 && bb_15m.width > 2.0) {
    direction = 'BUY'; confidence = 0.45;
    if (bb_1h.pctB < 0.2) confidence += 0.1; if (rsi_15m < 30) confidence += 0.15;
    if (rsi_15m < 25) confidence += 0.05; if (!['strong_down'].includes(dailyTrend)) confidence += 0.05;
  } else if (bb_15m.pctB > 0.95 && bb_15m.width > 2.0) {
    direction = 'SELL'; confidence = 0.45;
    if (bb_1h.pctB > 0.8) confidence += 0.1; if (rsi_15m > 70) confidence += 0.15;
    if (rsi_15m > 75) confidence += 0.05; if (!['strong_up'].includes(dailyTrend)) confidence += 0.05;
  }
  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_reversion_pin_bar(ind) {
  const name = 'reversion_pin_bar';
  const { patterns, sr_1h, currentPrice, rsi_15m, stopPct, tpPct } = ind;
  const bullPins = patterns.filter(p => p.name === 'bullish_pin_bar' || p.name === 'hammer');
  const bearPins = patterns.filter(p => p.name === 'bearish_pin_bar' || p.name === 'shooting_star');
  let direction = 'NONE', confidence = 0;
  if (bullPins.length > 0 && sr_1h.supports.length > 0) {
    const dist = Math.abs(currentPrice - sr_1h.supports[0]) / currentPrice * 100;
    if (dist < 1.0) { direction = 'BUY'; confidence = 0.5; if (rsi_15m < 35) confidence += 0.1; if (dist < 0.3) confidence += 0.1; }
  }
  if (direction === 'NONE' && bearPins.length > 0 && sr_1h.resistances.length > 0) {
    const dist = Math.abs(sr_1h.resistances[0] - currentPrice) / currentPrice * 100;
    if (dist < 1.0) { direction = 'SELL'; confidence = 0.5; if (rsi_15m > 65) confidence += 0.1; if (dist < 0.3) confidence += 0.1; }
  }
  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_reversion_liquidation_bounce(ind) {
  const name = 'reversion_liquidation_bounce';
  const { vol, rsi_15m, bb_15m, candles_15m, stopPct, tpPct } = ind;
  if (candles_15m.length < 5) return NONE_SIGNAL(name);
  const recent5 = candles_15m.slice(-5);
  const maxDrop = Math.min(...recent5.map(c => (c.close - c.open) / c.open * 100));
  const lastCandle = recent5[recent5.length - 1];
  const isRebounding = lastCandle.close > lastCandle.open;
  let direction = 'NONE', confidence = 0;
  if (vol.ratio > 3.0 && rsi_15m < 20 && maxDrop < -1.5 && isRebounding) {
    direction = 'BUY'; confidence = 0.55;
    if (vol.ratio > 5.0) confidence += 0.1; if (rsi_15m < 15) confidence += 0.1;
    if (bb_15m.pctB < 0.02) confidence += 0.05;
  }
  const maxPump = Math.max(...recent5.map(c => (c.close - c.open) / c.open * 100));
  const isDropping = lastCandle.close < lastCandle.open;
  if (direction === 'NONE' && vol.ratio > 3.0 && rsi_15m > 80 && maxPump > 1.5 && isDropping) {
    direction = 'SELL'; confidence = 0.55;
    if (vol.ratio > 5.0) confidence += 0.1; if (rsi_15m > 85) confidence += 0.1;
  }
  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_breakout_pattern(ind) {
  const name = 'breakout_pattern';
  const { patterns, vol, dailyTrend, trend4h, stopPct, tpPct } = ind;
  const bullPatterns = patterns.filter(p => p.direction === 'BUY');
  const bearPatterns = patterns.filter(p => p.direction === 'SELL');
  let direction = 'NONE', confidence = 0;
  const bullWeight = bullPatterns.reduce((sum, p) => sum + p.weight, 0);
  const bearWeight = bearPatterns.reduce((sum, p) => sum + p.weight, 0);
  if (bullWeight > 1.5 && vol.ratio > 1.2) {
    direction = 'BUY'; confidence = 0.4 + Math.min(bullWeight * 0.08, 0.3);
    if (['strong_up', 'up'].includes(dailyTrend)) confidence += 0.1;
    if (['strong_up', 'up'].includes(trend4h)) confidence += 0.05;
  } else if (bearWeight > 1.5 && vol.ratio > 1.2) {
    direction = 'SELL'; confidence = 0.4 + Math.min(bearWeight * 0.08, 0.3);
    if (['strong_down', 'down'].includes(dailyTrend)) confidence += 0.1;
    if (['strong_down', 'down'].includes(trend4h)) confidence += 0.05;
  }
  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_breakout_bollinger_squeeze(ind) {
  const name = 'breakout_bollinger_squeeze';
  const { bb_15m, bb_1h, macd_15m, vol, currentPrice, stopPct, tpPct, dailyTrend } = ind;
  if (bb_15m.width > 1.5) return NONE_SIGNAL(name);
  let direction = 'NONE', confidence = 0;
  if (currentPrice > bb_15m.upper && vol.ratio > 1.3 && macd_15m.histogram > 0) {
    direction = 'BUY'; confidence = 0.5;
    if (bb_1h.width < 2.0) confidence += 0.1; if (vol.ratio > 2.0) confidence += 0.1;
    if (['strong_up', 'up'].includes(dailyTrend)) confidence += 0.05;
  } else if (currentPrice < bb_15m.lower && vol.ratio > 1.3 && macd_15m.histogram < 0) {
    direction = 'SELL'; confidence = 0.5;
    if (bb_1h.width < 2.0) confidence += 0.1; if (vol.ratio > 2.0) confidence += 0.1;
    if (['strong_down', 'down'].includes(dailyTrend)) confidence += 0.05;
  }
  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_breakout_range(ind) {
  const name = 'breakout_range';
  const { candles_1h, currentPrice, vol, stopPct, tpPct } = ind;
  if (candles_1h.length < 24) return NONE_SIGNAL(name);
  const range = candles_1h.slice(-24);
  const rangeHigh = Math.max(...range.map(c => c.high));
  const rangeLow = Math.min(...range.map(c => c.low));
  const rangeWidth = (rangeHigh - rangeLow) / currentPrice * 100;
  if (rangeWidth > 3.0 || rangeWidth < 0.5) return NONE_SIGNAL(name);
  let direction = 'NONE', confidence = 0;
  if (currentPrice > rangeHigh && vol.ratio > 1.3) {
    direction = 'BUY'; confidence = 0.5; if (vol.ratio > 2.0) confidence += 0.15;
  } else if (currentPrice < rangeLow && vol.ratio > 1.3) {
    direction = 'SELL'; confidence = 0.5; if (vol.ratio > 2.0) confidence += 0.15;
  }
  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_breakout_outside_bar(ind) {
  const name = 'breakout_outside_bar';
  const { patterns, vol, macd_15m, stopPct, tpPct, dailyTrend } = ind;
  const outsideBars = patterns.filter(p => p.name === 'outside_bar');
  if (outsideBars.length === 0) return NONE_SIGNAL(name);
  const ob = outsideBars[0];
  let direction = ob.direction, confidence = 0.45;
  if (vol.ratio > 1.5) confidence += 0.1;
  if (direction === 'BUY' && macd_15m.histogram > 0) confidence += 0.1;
  if (direction === 'SELL' && macd_15m.histogram < 0) confidence += 0.1;
  if (direction === 'BUY' && ['strong_up', 'up'].includes(dailyTrend)) confidence += 0.05;
  if (direction === 'SELL' && ['strong_down', 'down'].includes(dailyTrend)) confidence += 0.05;
  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_breakout_news_driven(ind) {
  const name = 'breakout_news_driven';
  const { vol, rsi_15m, macd_15m, candles_15m, stopPct, tpPct } = ind;
  if (candles_15m.length < 3 || vol.ratio < 2.5) return NONE_SIGNAL(name);
  const lastCandle = candles_15m[candles_15m.length - 1];
  const priceChangePct = (lastCandle.close - lastCandle.open) / lastCandle.open * 100;
  let direction = 'NONE', confidence = 0;
  if (priceChangePct > 0.5 && macd_15m.histogram > 0) {
    direction = 'BUY'; confidence = 0.45;
    if (vol.ratio > 4.0) confidence += 0.15; if (priceChangePct > 1.0) confidence += 0.1;
    if (rsi_15m > 50 && rsi_15m < 80) confidence += 0.05;
  } else if (priceChangePct < -0.5 && macd_15m.histogram < 0) {
    direction = 'SELL'; confidence = 0.45;
    if (vol.ratio > 4.0) confidence += 0.15; if (priceChangePct < -1.0) confidence += 0.1;
    if (rsi_15m < 50 && rsi_15m > 20) confidence += 0.05;
  }
  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

const STRATEGY_MAP = {
  trend_ema_cross: strategy_trend_ema_cross,
  trend_mtf_alignment: strategy_trend_mtf_alignment,
  trend_momentum_chase: strategy_trend_momentum_chase,
  trend_elliott_wave3: strategy_trend_elliott_wave3,
  trend_flag_breakout: strategy_trend_flag_breakout,
  reversion_sr: strategy_reversion_sr,
  reversion_rsi_divergence: strategy_reversion_rsi_divergence,
  reversion_bollinger: strategy_reversion_bollinger,
  reversion_pin_bar: strategy_reversion_pin_bar,
  reversion_liquidation_bounce: strategy_reversion_liquidation_bounce,
  breakout_pattern: strategy_breakout_pattern,
  breakout_bollinger_squeeze: strategy_breakout_bollinger_squeeze,
  breakout_range: strategy_breakout_range,
  breakout_outside_bar: strategy_breakout_outside_bar,
  breakout_news_driven: strategy_breakout_news_driven,
};

// ========== FETCH HISTORICAL K-LINES ==========
async function getCandles(market, period, limit = 1000) {
  try {
    const candles = await rest.getKLine({ market, period, limit });
    return candles.map(c => ({
      time: c[0], open: parseFloat(c[1]), high: parseFloat(c[2]),
      low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5])
    }));
  } catch (e) {
    console.error(`K-line error ${market}/${period}:`, e.message);
    return [];
  }
}

// ========== BACKTEST ENGINE ==========
async function backtestStrategy(strategyName, market, periodDays) {
  console.log(`\n📊 回測 ${strategyName} @ ${market} (${periodDays} 天)`);

  const strategyFn = STRATEGY_MAP[strategyName];
  if (!strategyFn) {
    console.error(`❌ 未知策略: ${strategyName}`);
    return null;
  }

  // Fetch K-lines: 15m for signals, 1h for higher TF
  // 15m: periodDays * 24 * 4 = candles needed, max ~1000
  const limit15m = Math.min(periodDays * 24 * 4, 1000);
  const limit1h = Math.min(periodDays * 24, 1000);

  const [candles_1h, candles_15m] = await Promise.all([
    getCandles(market, 60, limit1h),
    getCandles(market, 15, limit15m)
  ]);

  if (candles_15m.length < 60 || candles_1h.length < 30) {
    console.log(`⚠️ K 線數據不足 (15m: ${candles_15m.length}, 1h: ${candles_1h.length})`);
    return null;
  }

  // Simulate trades
  const trades = [];
  let position = null;
  const minLookback = 60; // Need at least 60 15m candles for indicators

  for (let i = minLookback; i < candles_15m.length; i++) {
    // Build indicator window
    const window15m = candles_15m.slice(Math.max(0, i - 100), i + 1);

    // Find matching 1h window
    const currentTime = candles_15m[i].time;
    const window1h = candles_1h.filter(c => c.time <= currentTime);
    if (window1h.length < 30) continue;

    const ind = computeIndicatorsFromCandles(window1h.slice(-100), window15m);
    const currentPrice = candles_15m[i].close;

    // If in position, check exit
    if (position) {
      const pnlPct = position.direction === 'BUY'
        ? ((currentPrice - position.entryPrice) / position.entryPrice) * 100
        : ((position.entryPrice - currentPrice) / position.entryPrice) * 100;

      if (pnlPct > position.peakPnl) position.peakPnl = pnlPct;

      // Stop loss
      if (pnlPct <= -position.slPct) {
        trades.push({ ...position, exitPrice: currentPrice, pnlPct, reason: 'STOP_LOSS', exitIdx: i });
        position = null;
        continue;
      }

      // Trailing stop
      if (position.peakPnl >= 0.5 && pnlPct < 0) {
        trades.push({ ...position, exitPrice: currentPrice, pnlPct, reason: 'BREAKEVEN_STOP', exitIdx: i });
        position = null;
        continue;
      }
      if (position.peakPnl >= 0.5) {
        const drawdown = position.peakPnl - pnlPct;
        if (drawdown >= 0.35) {
          trades.push({ ...position, exitPrice: currentPrice, pnlPct, reason: 'TRAILING_STOP', exitIdx: i });
          position = null;
          continue;
        }
      }

      // Take profit
      if (pnlPct >= position.tpPct * 1.5) {
        trades.push({ ...position, exitPrice: currentPrice, pnlPct, reason: 'TAKE_PROFIT', exitIdx: i });
        position = null;
        continue;
      }

      // Time exit (16 candles = 4h)
      if (i - position.entryIdx > 16 && pnlPct < 0.15) {
        trades.push({ ...position, exitPrice: currentPrice, pnlPct, reason: 'TIME_EXIT', exitIdx: i });
        position = null;
        continue;
      }

      continue; // Stay in position
    }

    // No position — check for entry
    const signal = strategyFn(ind);
    if (signal.direction !== 'NONE' && signal.confidence >= 0.55) {
      position = {
        strategy: strategyName,
        direction: signal.direction,
        entryPrice: currentPrice,
        slPct: signal.slPct,
        tpPct: signal.tpPct,
        confidence: signal.confidence,
        entryIdx: i,
        peakPnl: 0
      };
    }
  }

  // Close any remaining position at last price
  if (position) {
    const lastPrice = candles_15m[candles_15m.length - 1].close;
    const pnlPct = position.direction === 'BUY'
      ? ((lastPrice - position.entryPrice) / position.entryPrice) * 100
      : ((position.entryPrice - lastPrice) / position.entryPrice) * 100;
    trades.push({ ...position, exitPrice: lastPrice, pnlPct, reason: 'END_OF_DATA', exitIdx: candles_15m.length - 1 });
  }

  // Calculate metrics
  if (trades.length === 0) {
    console.log(`  ⏭️ 無交易信號`);
    return { strategy: strategyName, market, periodDays, trades: 0, winRate: 0, profitFactor: 0, avgPnl: 0, maxDrawdown: 0, sharpeRatio: 0, expectancy: 0, riskRewardRatio: 0 };
  }

  const wins = trades.filter(t => t.pnlPct > 0);
  const losses = trades.filter(t => t.pnlPct <= 0);
  const winRate = wins.length / trades.length;
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length) : 0;
  const grossProfit = wins.reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnlPct, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);
  const avgPnl = trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length;
  const riskRewardRatio = avgLoss > 0 ? avgWin / avgLoss : (avgWin > 0 ? 999 : 0);
  const expectancy = winRate * avgWin - (1 - winRate) * avgLoss;

  // Max drawdown
  let equity = 0, peak = 0, maxDD = 0;
  for (const t of trades) {
    equity += t.pnlPct;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (dd > maxDD) maxDD = dd;
  }

  // Sharpe ratio (annualized, assuming 15m bars)
  const returns = trades.map(t => t.pnlPct);
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const stdReturn = Math.sqrt(returns.reduce((a, b) => a + (b - meanReturn) ** 2, 0) / returns.length);
  // Annualize: assume ~35000 15m bars/year, but we trade much less frequently
  const tradesPerYear = (trades.length / periodDays) * 365;
  const sharpeRatio = stdReturn > 0 ? (meanReturn * Math.sqrt(tradesPerYear)) / stdReturn : 0;

  const result = {
    strategy: strategyName,
    market,
    periodDays,
    trades: trades.length,
    wins: wins.length,
    losses: losses.length,
    winRate: Math.round(winRate * 10000) / 100,
    avgWinPct: Math.round(avgWin * 100) / 100,
    avgLossPct: Math.round(avgLoss * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    avgPnlPct: Math.round(avgPnl * 100) / 100,
    totalPnlPct: Math.round(trades.reduce((s, t) => s + t.pnlPct, 0) * 100) / 100,
    maxDrawdownPct: Math.round(maxDD * 100) / 100,
    sharpeRatio: Math.round(sharpeRatio * 100) / 100,
    riskRewardRatio: Math.round(riskRewardRatio * 100) / 100,
    expectancy: Math.round(expectancy * 100) / 100,
    backtestTime: new Date().toISOString()
  };

  console.log(`  📈 ${trades.length} 筆交易 | 勝率 ${result.winRate}% | PF ${result.profitFactor} | 夏普 ${result.sharpeRatio} | 最大回撤 ${result.maxDrawdownPct}% | 期望值 ${result.expectancy}%`);
  return result;
}

// ========== MAIN ==========
async function main() {
  console.log('🔬 虛擬貨幣策略回測器 v1.0');
  console.log(`📅 回測期間: ${periodDays} 天\n`);

  let strategies = [];
  if (runAll) {
    if (fs.existsSync(REGISTRY_FILE)) {
      const registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
      strategies = Object.keys(registry.strategies);
    } else {
      strategies = Object.keys(STRATEGY_MAP);
    }
  } else {
    strategies = [targetStrategy];
  }

  let markets = [];
  if (targetMarket) {
    markets = [targetMarket];
  } else {
    markets = WATCHLIST;
  }

  const allResults = [];

  for (const strat of strategies) {
    for (const market of markets) {
      try {
        const result = await backtestStrategy(strat, market, periodDays);
        if (result) allResults.push(result);
        // Rate limit: wait 500ms between API calls
        await new Promise(r => setTimeout(r, 500));
      } catch (e) {
        console.error(`❌ ${strat}@${market} 回測失敗:`, e.message);
      }
    }
  }

  // Save results
  let existing = {};
  if (fs.existsSync(RESULTS_FILE)) {
    try { existing = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8')); } catch (e) {}
  }

  existing.lastRun = new Date().toISOString();
  existing.periodDays = periodDays;
  if (!existing.results) existing.results = {};

  for (const r of allResults) {
    const key = `${r.strategy}__${r.market}`;
    existing.results[key] = r;
  }

  // Summary ranking
  const ranked = allResults
    .filter(r => r.trades >= 3)
    .sort((a, b) => b.expectancy - a.expectancy);

  existing.ranking = ranked.map((r, i) => ({
    rank: i + 1,
    strategy: r.strategy,
    market: r.market,
    trades: r.trades,
    winRate: r.winRate,
    profitFactor: r.profitFactor,
    expectancy: r.expectancy,
    sharpeRatio: r.sharpeRatio
  }));

  fs.writeFileSync(RESULTS_FILE, JSON.stringify(existing, null, 2));

  console.log('\n========== 回測排名 ==========');
  for (const r of existing.ranking.slice(0, 10)) {
    console.log(`#${r.rank} ${r.strategy}@${r.market} | 勝率 ${r.winRate}% | PF ${r.profitFactor} | 期望值 ${r.expectancy}% | 夏普 ${r.sharpeRatio}`);
  }
  console.log(`\n✅ 結果已存到 ${RESULTS_FILE}`);
}

main().catch(e => {
  console.error('❌ Backtester error:', e.message);
  process.exit(1);
});
