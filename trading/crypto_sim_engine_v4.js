#!/usr/bin/env node
// 虛擬貨幣模擬交易引擎 v4 — 策略模組化、完整 Dashboard、BTC 關聯性
// v3→v4 核心改動：
// 1. 15 個獨立策略函數（趨勢5 + 均值回歸5 + 突破5），STRATEGY_ENABLED 開關
// 2. BTC 關聯性規則：山寨幣做多前先檢查 BTC 方向
// 3. 連虧暫停 TESTING_PHASE 控制（測試階段不暫停）
// 4. Dashboard JSON 完整輸出（帳戶總覽、策略績效排名、風控、警報、復盤）
// 5. state version: 4，繼承 v3 資金

const { MAX } = require('max-exchange-api-node');
const https = require('https');
const fs = require('fs');
const path = require('path');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'crypto_config.json'), 'utf8'));
const { rest } = new MAX({
  accessKey: CONFIG.api.access_key,
  secretKey: CONFIG.api.secret_key
});

const STATE_FILE = path.join(__dirname, 'crypto_sim_state.json');
const LOG_FILE = path.join(__dirname, 'crypto_sim_log.json');
const DASHBOARD_FILE = path.join(__dirname, '..', 'boss-dashboard', 'crypto-trading-data.json');
const REVIEW_FILE = path.join(__dirname, 'crypto_review.json');
const OPENAI_CONFIG_FILE = path.join(__dirname, 'openai_config.json');
const REGISTRY_FILE = path.join(__dirname, 'crypto_strategy_registry.json');
const VOLUME_PATTERNS_FILE = path.join(__dirname, 'volume_patterns.json');

// ========== TESTING PHASE ==========
const TESTING_PHASE = true; // true = 不暫停、不停止、不減倉

// ========== 策略 Registry 整合 ==========
// 從 registry 載入策略狀態，只啟用 TESTING / ACTIVE / PROMOTED
function loadStrategyRegistry() {
  try {
    if (fs.existsSync(REGISTRY_FILE)) {
      return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('⚠️ Registry 載入失敗，使用預設:', e.message);
  }
  return null;
}

function getStrategyEnabled(registry) {
  const enabled = {};
  const allStrategies = [
    'trend_ema_cross', 'trend_mtf_alignment', 'trend_momentum_chase',
    'trend_elliott_wave3', 'trend_flag_breakout',
    'reversion_sr', 'reversion_rsi_divergence', 'reversion_bollinger',
    'reversion_pin_bar', 'reversion_liquidation_bounce',
    'breakout_pattern', 'breakout_bollinger_squeeze', 'breakout_range',
    'breakout_outside_bar', 'breakout_news_driven',
  ];

  if (!registry) {
    for (const s of allStrategies) enabled[s] = true;
    return enabled;
  }

  const activeStates = ['TESTING', 'ACTIVE', 'PROMOTED'];
  for (const s of allStrategies) {
    const reg = registry.strategies[s];
    enabled[s] = reg ? activeStates.includes(reg.state) : true;
  }
  return enabled;
}

// 載入交易量模式
function loadVolumePatterns() {
  try {
    if (fs.existsSync(VOLUME_PATTERNS_FILE)) {
      return JSON.parse(fs.readFileSync(VOLUME_PATTERNS_FILE, 'utf8'));
    }
  } catch (e) {}
  return null;
}

// 根據策略狀態調整倉位大小
function getStrategyRiskMultiplier(registry, strategyName) {
  if (!registry || !registry.strategies[strategyName]) return 1.0;
  const state = registry.strategies[strategyName].state;
  if (state === 'PROMOTED') return 1.2;
  if (state === 'TESTING') return 0.7;
  return 1.0;
}

// 交易量時段信心調整
function getVolumeConfidenceAdjust(volumePatterns) {
  if (!volumePatterns) return 0;
  const currentHour = new Date().getHours();
  const highHours = volumePatterns.globalHighVolumeHours || [];
  const lowHours = volumePatterns.globalLowVolumeHours || [];
  if (highHours.includes(currentHour)) return 0.05;
  if (lowHours.includes(currentHour)) return -0.05;
  return 0;
}

// 檢查量價背離警告
function checkVolumeDivergenceWarning(volumePatterns, market) {
  if (!volumePatterns || !volumePatterns.divergences) return null;
  const now = Date.now();
  const recentDivergences = volumePatterns.divergences.filter(d => {
    return d.market === market && (now - new Date(d.time).getTime()) < 3600000;
  });
  return recentDivergences.length > 0 ? recentDivergences[recentDivergences.length - 1] : null;
}

// 驗證策略名稱是否在 registry 中
function validateStrategyName(registry, name) {
  if (!registry) return name;
  return registry.strategies[name] ? name : name;
}

const _registry = loadStrategyRegistry();
const _volumePatterns = loadVolumePatterns();
const STRATEGY_ENABLED = getStrategyEnabled(_registry);

// ========== v4 交易參數 ==========
const PARAMS = {
  initialCapital: 30000,
  maxConcurrentPositions: 5,
  maxTotalExposurePct: 80,
  stopLossATR: 1.2,
  takeProfitATR: 2.5,
  stopLossMaxPct: 1.5,
  stopLossMinPct: 0.3,
  trailingActivatePct: 0.5,
  trailingLockBreakevenPct: 0.5,
  trailingStopPct: 0.35,
  trailingWiden1Pct: 1.0,
  trailingWiden2Pct: 2.0,
  minConfidencePrimary: 0.30,
  minConfidenceSecondary: 0.35,
  highConfidence: 0.70,
  minRiskRewardRatio: 2.0,
  timeExitHours: 4,
  timeExitMinPnlPct: 0.15,
  cooldownMinutes: 5,
  maxConsecutiveLosses: 5,
  pauseHours: 1,
  baseRiskPct: 1.5,
  highConfRiskPct: 2.5,
  compounding: true,
  reviewEveryNTrades: 5,
  allowSameMarketPositions: false,
  startTime: '2026-03-29T22:20:00+08:00',
  endTime: '2099-12-31T23:59:59+08:00',
  watchlist: ['btctwd', 'ethtwd', 'btcusdt', 'ethusdt'],
  primary: ['btctwd', 'ethtwd', 'btcusdt', 'ethusdt'],
  secondary: [],
  altcoins: [], // 山寨幣已移除，專注 BTC/ETH
  btcPair: 'btctwd', // 用於 BTC 關聯性檢查
  btcDropThreshold: 2, // BTC 1H 跌幅 > 2% 不做多山寨幣
};

// ========== STATE ==========
function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s.version === 4) return s;
  }
  // v4 初始化 — 繼承 v3 資金
  let startCapital = PARAMS.initialCapital;
  if (fs.existsSync(STATE_FILE)) {
    try {
      const old = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (old.capital) startCapital = old.capital;
    } catch (e) {}
  }

  const initial = {
    version: 4,
    capital: startCapital,
    available: startCapital,
    positions: [],
    closedTrades: [],
    totalTrades: 0,
    wins: 0,
    losses: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    peakCapital: startCapital,
    maxDrawdown: 0,
    consecutiveLosses: 0,
    maxConsecutiveLosses: 0,
    maxConsecutiveWins: 0,
    currentConsecutiveWins: 0,
    maxSingleWin: 0,
    maxSingleLoss: 0,
    lastLossTime: null,
    pausedUntil: null,
    strategyStats: {},
    dailyStats: {},
    lastRun: null,
    v4StartCapital: startCapital,
    v4StartTime: new Date().toISOString()
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(initial, null, 2));
  return initial;
}

function saveState(state) {
  state.lastRun = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function appendLog(entry) {
  let log = [];
  if (fs.existsSync(LOG_FILE)) log = JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  log.push({ ...entry, timestamp: new Date().toISOString() });
  if (log.length > 500) log = log.slice(-500);
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

// ========== TECHNICAL INDICATORS ==========
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
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
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

  if (lowerWick > body * 2.5 && upperWick < body * 0.3) {
    patterns.push({ name: 'hammer', direction: 'BUY', weight: 1.2 });
  }
  if (upperWick > body * 2.5 && lowerWick < body * 0.3) {
    patterns.push({ name: 'shooting_star', direction: 'SELL', weight: 1.2 });
  }
  if (!pIsBullish && isBullish && c.close > p.open && c.open < p.close && body > pBody * 1.3) {
    patterns.push({ name: 'bullish_engulfing', direction: 'BUY', weight: 1.5 });
  }
  if (pIsBullish && !isBullish && c.close < p.open && c.open > p.close && body > pBody * 1.3) {
    patterns.push({ name: 'bearish_engulfing', direction: 'SELL', weight: 1.5 });
  }

  const ppBody = Math.abs(pp.close - pp.open);
  const ppIsBullish = pp.close > pp.open;
  if (!ppIsBullish && pBody < ppBody * 0.3 && isBullish && body > ppBody * 0.5) {
    patterns.push({ name: 'morning_star', direction: 'BUY', weight: 1.8 });
  }
  if (ppIsBullish && pBody < ppBody * 0.3 && !isBullish && body > ppBody * 0.5) {
    patterns.push({ name: 'evening_star', direction: 'SELL', weight: 1.8 });
  }
  if (body > range * 0.7 && range > 0) {
    if (isBullish) patterns.push({ name: 'strong_bull', direction: 'BUY', weight: 0.8 });
    else patterns.push({ name: 'strong_bear', direction: 'SELL', weight: 0.8 });
  }

  // Pin bar detection (for reversion_pin_bar strategy)
  const pinThreshold = range * 0.6;
  if (lowerWick > pinThreshold && body < range * 0.25) {
    patterns.push({ name: 'bullish_pin_bar', direction: 'BUY', weight: 1.3 });
  }
  if (upperWick > pinThreshold && body < range * 0.25) {
    patterns.push({ name: 'bearish_pin_bar', direction: 'SELL', weight: 1.3 });
  }

  // Outside bar (for breakout_outside_bar)
  if (c.high > p.high && c.low < p.low) {
    patterns.push({ name: 'outside_bar', direction: isBullish ? 'BUY' : 'SELL', weight: 1.4 });
  }

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

// ========== SUPPORT / RESISTANCE ==========
function findSupportResistance(candles, lookback = 50) {
  if (candles.length < lookback) return { supports: [], resistances: [] };
  const recent = candles.slice(-lookback);
  const highs = recent.map(c => c.high);
  const lows = recent.map(c => c.low);
  const levels = [];

  // Find pivot points
  for (let i = 2; i < recent.length - 2; i++) {
    if (highs[i] > highs[i - 1] && highs[i] > highs[i - 2] && highs[i] > highs[i + 1] && highs[i] > highs[i + 2]) {
      levels.push({ price: highs[i], type: 'resistance' });
    }
    if (lows[i] < lows[i - 1] && lows[i] < lows[i - 2] && lows[i] < lows[i + 1] && lows[i] < lows[i + 2]) {
      levels.push({ price: lows[i], type: 'support' });
    }
  }

  // Cluster nearby levels
  const currentPrice = recent[recent.length - 1].close;
  const supports = levels.filter(l => l.type === 'support' && l.price < currentPrice).map(l => l.price).sort((a, b) => b - a);
  const resistances = levels.filter(l => l.type === 'resistance' && l.price > currentPrice).map(l => l.price).sort((a, b) => a - b);

  return { supports: supports.slice(0, 3), resistances: resistances.slice(0, 3) };
}

// ========== COMPUTE INDICATORS BUNDLE ==========
function computeIndicators(candles_daily, candles_4h, candles_1h, candles_15m, candles_5m) {
  const closes_daily = candles_daily.map(c => c.close);
  const closes_4h = candles_4h.map(c => c.close);
  const closes_1h = candles_1h.map(c => c.close);
  const closes_15m = candles_15m.map(c => c.close);
  const closes_5m = candles_5m ? candles_5m.map(c => c.close) : [];
  const currentPrice = closes_15m.length > 0 ? closes_15m[closes_15m.length - 1] : 0;

  const dailyTrend = closes_daily.length >= 20 ? determineTrend(closes_daily) : 'unknown';
  const trend4h = closes_4h.length >= 20 ? determineTrend(closes_4h) : 'unknown';
  const trend1h = closes_1h.length >= 20 ? determineTrend(closes_1h) : 'unknown';
  const trend15m = closes_15m.length >= 20 ? determineTrend(closes_15m) : 'unknown';
  const trend5m = closes_5m.length >= 20 ? determineTrend(closes_5m) : 'unknown';

  const rsi_1h = calcRSI(closes_1h);
  const rsi_15m = calcRSI(closes_15m);
  const rsi_5m = closes_5m.length > 15 ? calcRSI(closes_5m) : 50;

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

  // ATR-based SL/TP
  const atrPct = currentPrice > 0 ? atr_1h / currentPrice * 100 : 1;
  const stopPct = Math.max(PARAMS.stopLossMinPct, Math.min(atrPct * PARAMS.stopLossATR, PARAMS.stopLossMaxPct));
  const tpPct = atrPct * PARAMS.takeProfitATR;

  return {
    currentPrice,
    closes_daily, closes_4h, closes_1h, closes_15m, closes_5m,
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
    candles_1h, candles_15m, candles_daily, candles_4h,
  };
}

// ========== 15 MODULAR STRATEGIES ==========
// Each returns: { direction: 'BUY'|'SELL'|'NONE', confidence: 0-1, strategy: string, slPct: number, tpPct: number }

const NONE_SIGNAL = (name) => ({ direction: 'NONE', confidence: 0, strategy: name, slPct: 0, tpPct: 0 });

// --- 趨勢類（5）---

function strategy_trend_ema_cross(ind) {
  const name = 'trend_ema_cross';
  if (!STRATEGY_ENABLED[name]) return NONE_SIGNAL(name);
  const { ema8, ema21, ema50, currentPrice, rsi_15m, vol, dailyTrend, trend4h, stopPct, tpPct } = ind;

  // EMA 8/21 交叉 + EMA 50 確認方向 + 回踩 EMA21
  const bullCross = ema8 > ema21 && ema21 > ema50;
  const bearCross = ema8 < ema21 && ema21 < ema50;

  // 回踩 EMA21（價格接近 EMA21 但仍在上方）
  const pullbackBull = bullCross && currentPrice > ema21 && (currentPrice - ema21) / currentPrice < 0.003;
  const pullbackBear = bearCross && currentPrice < ema21 && (ema21 - currentPrice) / currentPrice < 0.003;

  let confidence = 0;
  let direction = 'NONE';

  if (bullCross) {
    direction = 'BUY';
    confidence = 0.4;
    if (pullbackBull) confidence += 0.15;
    if (['strong_up', 'up'].includes(dailyTrend)) confidence += 0.1;
    if (['strong_up', 'up'].includes(trend4h)) confidence += 0.1;
    if (rsi_15m > 40 && rsi_15m < 65) confidence += 0.05; // RSI 健康區間
    if (vol.ratio > 1.2) confidence += 0.05;
  } else if (bearCross) {
    direction = 'SELL';
    confidence = 0.4;
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
  if (!STRATEGY_ENABLED[name]) return NONE_SIGNAL(name);
  const { trend4h, trend1h, trend15m, trend5m, stopPct, tpPct, vol } = ind;

  const bullTrends = ['strong_up', 'up'];
  const bearTrends = ['strong_down', 'down'];

  const bullCount = [trend4h, trend1h, trend15m, trend5m].filter(t => bullTrends.includes(t)).length;
  const bearCount = [trend4h, trend1h, trend15m, trend5m].filter(t => bearTrends.includes(t)).length;

  let direction = 'NONE';
  let confidence = 0;

  if (bullCount >= 3) {
    direction = 'BUY';
    confidence = 0.35 + bullCount * 0.1;
    if (bullCount === 4) confidence += 0.15; // 完美對齊
    if (vol.ratio > 1.3) confidence += 0.05;
  } else if (bearCount >= 3) {
    direction = 'SELL';
    confidence = 0.35 + bearCount * 0.1;
    if (bearCount === 4) confidence += 0.15;
    if (vol.ratio > 1.3) confidence += 0.05;
  }

  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_trend_momentum_chase(ind) {
  const name = 'trend_momentum_chase';
  if (!STRATEGY_ENABLED[name]) return NONE_SIGNAL(name);
  const { vol, macd_15m, macd_1h, rsi_15m, currentPrice, ema8, ema21, stopPct, tpPct, dailyTrend, trend4h } = ind;

  // 幣圈特有：放量突破 + 動量確認
  if (vol.ratio < 1.5) return NONE_SIGNAL(name); // 必須放量

  let direction = 'NONE';
  let confidence = 0;

  const bullMomentum = macd_15m.histogram > 0 && macd_1h.histogram > 0 && rsi_15m > 55 && currentPrice > ema8;
  const bearMomentum = macd_15m.histogram < 0 && macd_1h.histogram < 0 && rsi_15m < 45 && currentPrice < ema8;

  if (bullMomentum) {
    direction = 'BUY';
    confidence = 0.45;
    if (vol.ratio > 2.0) confidence += 0.1;
    if (vol.ratio > 3.0) confidence += 0.1;
    if (['strong_up', 'up'].includes(dailyTrend)) confidence += 0.1;
    if (['strong_up', 'up'].includes(trend4h)) confidence += 0.05;
  } else if (bearMomentum) {
    direction = 'SELL';
    confidence = 0.45;
    if (vol.ratio > 2.0) confidence += 0.1;
    if (vol.ratio > 3.0) confidence += 0.1;
    if (['strong_down', 'down'].includes(dailyTrend)) confidence += 0.1;
    if (['strong_down', 'down'].includes(trend4h)) confidence += 0.05;
  }

  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_trend_elliott_wave3(ind) {
  const name = 'trend_elliott_wave3';
  if (!STRATEGY_ENABLED[name]) return NONE_SIGNAL(name);
  const { closes_1h, currentPrice, dailyTrend, trend4h, rsi_15m, stopPct, tpPct } = ind;

  if (closes_1h.length < 30) return NONE_SIGNAL(name);

  // Simplified Wave 3 detection:
  // Wave 1: initial impulse, Wave 2: correction (38.2-61.8% retrace), Wave 3: strongest
  // Look for: recent swing low → swing high → pullback (38-62%) → new push
  let direction = 'NONE';
  let confidence = 0;

  const recent = closes_1h.slice(-30);
  let swingLow = Math.min(...recent.slice(0, 15));
  let swingHigh = Math.max(...recent.slice(5, 20));
  let retraceLevel = recent.slice(15, 25);
  let retraceLow = retraceLevel.length > 0 ? Math.min(...retraceLevel) : swingLow;

  const wave1Range = swingHigh - swingLow;
  if (wave1Range <= 0) return NONE_SIGNAL(name);

  const retracement = (swingHigh - retraceLow) / wave1Range;
  const isPushingUp = currentPrice > retraceLow && currentPrice > swingHigh * 0.98;

  // Bearish version
  let swingHighB = Math.max(...recent.slice(0, 15));
  let swingLowB = Math.min(...recent.slice(5, 20));
  let retraceLevelB = recent.slice(15, 25);
  let retraceHighB = retraceLevelB.length > 0 ? Math.max(...retraceLevelB) : swingHighB;
  const wave1RangeB = swingHighB - swingLowB;
  const retracementB = wave1RangeB > 0 ? (retraceHighB - swingLowB) / wave1RangeB : 0;
  const isPushingDown = currentPrice < retraceHighB && currentPrice < swingLowB * 1.02;

  if (retracement >= 0.38 && retracement <= 0.62 && isPushingUp) {
    direction = 'BUY';
    confidence = 0.5;
    if (['strong_up', 'up'].includes(dailyTrend)) confidence += 0.1;
    if (['strong_up', 'up'].includes(trend4h)) confidence += 0.05;
    if (rsi_15m > 45 && rsi_15m < 70) confidence += 0.05;
  } else if (retracementB >= 0.38 && retracementB <= 0.62 && isPushingDown) {
    direction = 'SELL';
    confidence = 0.5;
    if (['strong_down', 'down'].includes(dailyTrend)) confidence += 0.1;
    if (['strong_down', 'down'].includes(trend4h)) confidence += 0.05;
    if (rsi_15m < 55 && rsi_15m > 30) confidence += 0.05;
  }

  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_trend_flag_breakout(ind) {
  const name = 'trend_flag_breakout';
  if (!STRATEGY_ENABLED[name]) return NONE_SIGNAL(name);
  const { candles_15m, currentPrice, vol, dailyTrend, trend4h, stopPct, tpPct } = ind;

  if (candles_15m.length < 30) return NONE_SIGNAL(name);

  // Flag = strong move (pole) followed by consolidation (flag) then breakout
  const recent = candles_15m.slice(-30);
  const pole = recent.slice(0, 10);
  const flag = recent.slice(10, 25);
  const now = recent.slice(-5);

  const poleMove = (pole[pole.length - 1].close - pole[0].open) / pole[0].open * 100;
  const flagHigh = Math.max(...flag.map(c => c.high));
  const flagLow = Math.min(...flag.map(c => c.low));
  const flagRange = flagHigh - flagLow;
  const poleRange = Math.abs(pole[pole.length - 1].close - pole[0].open);
  const isConsolidation = poleRange > 0 && flagRange / poleRange < 0.5;

  let direction = 'NONE';
  let confidence = 0;

  if (poleMove > 1.0 && isConsolidation && currentPrice > flagHigh) {
    direction = 'BUY';
    confidence = 0.5;
    if (vol.ratio > 1.3) confidence += 0.1;
    if (['strong_up', 'up'].includes(dailyTrend)) confidence += 0.1;
  } else if (poleMove < -1.0 && isConsolidation && currentPrice < flagLow) {
    direction = 'SELL';
    confidence = 0.5;
    if (vol.ratio > 1.3) confidence += 0.1;
    if (['strong_down', 'down'].includes(dailyTrend)) confidence += 0.1;
  }

  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

// --- 均值回歸類（5）---

function strategy_reversion_sr(ind) {
  const name = 'reversion_sr';
  if (!STRATEGY_ENABLED[name]) return NONE_SIGNAL(name);
  const { currentPrice, sr_1h, rsi_15m, patterns, bb_15m, stopPct, tpPct } = ind;

  let direction = 'NONE';
  let confidence = 0;

  // Near support + oversold signals → BUY
  if (sr_1h.supports.length > 0) {
    const nearestSupport = sr_1h.supports[0];
    const distPct = (currentPrice - nearestSupport) / currentPrice * 100;
    if (distPct >= 0 && distPct < 0.5) {
      direction = 'BUY';
      confidence = 0.45;
      if (rsi_15m < 35) confidence += 0.15;
      if (bb_15m.pctB < 0.1) confidence += 0.1;
      if (patterns.some(p => p.direction === 'BUY')) confidence += 0.1;
    }
  }
  // Near resistance + overbought signals → SELL
  if (direction === 'NONE' && sr_1h.resistances.length > 0) {
    const nearestResistance = sr_1h.resistances[0];
    const distPct = (nearestResistance - currentPrice) / currentPrice * 100;
    if (distPct >= 0 && distPct < 0.5) {
      direction = 'SELL';
      confidence = 0.45;
      if (rsi_15m > 65) confidence += 0.15;
      if (bb_15m.pctB > 0.9) confidence += 0.1;
      if (patterns.some(p => p.direction === 'SELL')) confidence += 0.1;
    }
  }

  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_reversion_rsi_divergence(ind) {
  const name = 'reversion_rsi_divergence';
  if (!STRATEGY_ENABLED[name]) return NONE_SIGNAL(name);
  const { closes_15m, rsi_15m, currentPrice, stopPct, tpPct } = ind;

  if (closes_15m.length < 30) return NONE_SIGNAL(name);

  // Detect bullish divergence: price makes lower low, RSI makes higher low
  // Detect bearish divergence: price makes higher high, RSI makes lower high
  const prices = closes_15m.slice(-20);
  const rsiValues = [];
  for (let i = 14; i <= closes_15m.length; i++) {
    rsiValues.push(calcRSI(closes_15m.slice(0, i)));
  }
  if (rsiValues.length < 10) return NONE_SIGNAL(name);

  const recentRSI = rsiValues.slice(-10);
  const recentPrices = prices.slice(-10);

  let direction = 'NONE';
  let confidence = 0;

  // Bullish divergence
  const priceLow1 = Math.min(...recentPrices.slice(0, 5));
  const priceLow2 = Math.min(...recentPrices.slice(5));
  const rsiLow1 = Math.min(...recentRSI.slice(0, 5));
  const rsiLow2 = Math.min(...recentRSI.slice(5));

  if (priceLow2 < priceLow1 && rsiLow2 > rsiLow1 && rsi_15m < 40) {
    direction = 'BUY';
    confidence = 0.5;
    if (rsi_15m < 30) confidence += 0.1;
  }

  // Bearish divergence
  const priceHigh1 = Math.max(...recentPrices.slice(0, 5));
  const priceHigh2 = Math.max(...recentPrices.slice(5));
  const rsiHigh1 = Math.max(...recentRSI.slice(0, 5));
  const rsiHigh2 = Math.max(...recentRSI.slice(5));

  if (direction === 'NONE' && priceHigh2 > priceHigh1 && rsiHigh2 < rsiHigh1 && rsi_15m > 60) {
    direction = 'SELL';
    confidence = 0.5;
    if (rsi_15m > 70) confidence += 0.1;
  }

  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_reversion_bollinger(ind) {
  const name = 'reversion_bollinger';
  if (!STRATEGY_ENABLED[name]) return NONE_SIGNAL(name);
  const { bb_15m, bb_1h, rsi_15m, currentPrice, stopPct, tpPct, dailyTrend } = ind;

  let direction = 'NONE';
  let confidence = 0;

  // Price below lower band → mean reversion BUY
  if (bb_15m.pctB < 0.05 && bb_15m.width > 2.0) {
    direction = 'BUY';
    confidence = 0.45;
    if (bb_1h.pctB < 0.2) confidence += 0.1;
    if (rsi_15m < 30) confidence += 0.15;
    if (rsi_15m < 25) confidence += 0.05;
    if (!['strong_down'].includes(dailyTrend)) confidence += 0.05;
  }
  // Price above upper band → mean reversion SELL
  else if (bb_15m.pctB > 0.95 && bb_15m.width > 2.0) {
    direction = 'SELL';
    confidence = 0.45;
    if (bb_1h.pctB > 0.8) confidence += 0.1;
    if (rsi_15m > 70) confidence += 0.15;
    if (rsi_15m > 75) confidence += 0.05;
    if (!['strong_up'].includes(dailyTrend)) confidence += 0.05;
  }

  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_reversion_pin_bar(ind) {
  const name = 'reversion_pin_bar';
  if (!STRATEGY_ENABLED[name]) return NONE_SIGNAL(name);
  const { patterns, sr_1h, currentPrice, rsi_15m, stopPct, tpPct } = ind;

  const bullPins = patterns.filter(p => p.name === 'bullish_pin_bar' || p.name === 'hammer');
  const bearPins = patterns.filter(p => p.name === 'bearish_pin_bar' || p.name === 'shooting_star');

  let direction = 'NONE';
  let confidence = 0;

  // Pin bar at key support level
  if (bullPins.length > 0 && sr_1h.supports.length > 0) {
    const nearestSupport = sr_1h.supports[0];
    const distPct = Math.abs(currentPrice - nearestSupport) / currentPrice * 100;
    if (distPct < 1.0) {
      direction = 'BUY';
      confidence = 0.5;
      if (rsi_15m < 35) confidence += 0.1;
      if (distPct < 0.3) confidence += 0.1;
    }
  }
  // Pin bar at key resistance level
  if (direction === 'NONE' && bearPins.length > 0 && sr_1h.resistances.length > 0) {
    const nearestResistance = sr_1h.resistances[0];
    const distPct = Math.abs(nearestResistance - currentPrice) / currentPrice * 100;
    if (distPct < 1.0) {
      direction = 'SELL';
      confidence = 0.5;
      if (rsi_15m > 65) confidence += 0.1;
      if (distPct < 0.3) confidence += 0.1;
    }
  }

  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_reversion_liquidation_bounce(ind) {
  const name = 'reversion_liquidation_bounce';
  if (!STRATEGY_ENABLED[name]) return NONE_SIGNAL(name);
  const { vol, rsi_15m, bb_15m, currentPrice, candles_15m, stopPct, tpPct } = ind;

  // 幣圈特有：清算瀑布反彈
  // 條件：極端放量 + RSI 極端超賣 + 價格劇烈下跌後反彈
  if (candles_15m.length < 5) return NONE_SIGNAL(name);

  const recent5 = candles_15m.slice(-5);
  const maxDrop = Math.min(...recent5.map(c => (c.close - c.open) / c.open * 100));
  const lastCandle = recent5[recent5.length - 1];
  const isRebounding = lastCandle.close > lastCandle.open; // 最新K線收陽

  let direction = 'NONE';
  let confidence = 0;

  // 清算瀑布後反彈做多
  if (vol.ratio > 3.0 && rsi_15m < 20 && maxDrop < -1.5 && isRebounding) {
    direction = 'BUY';
    confidence = 0.55;
    if (vol.ratio > 5.0) confidence += 0.1;
    if (rsi_15m < 15) confidence += 0.1;
    if (bb_15m.pctB < 0.02) confidence += 0.05;
  }
  // 極端上漲瀑布後反轉做空
  const maxPump = Math.max(...recent5.map(c => (c.close - c.open) / c.open * 100));
  const isDropping = lastCandle.close < lastCandle.open;
  if (direction === 'NONE' && vol.ratio > 3.0 && rsi_15m > 80 && maxPump > 1.5 && isDropping) {
    direction = 'SELL';
    confidence = 0.55;
    if (vol.ratio > 5.0) confidence += 0.1;
    if (rsi_15m > 85) confidence += 0.1;
  }

  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

// --- 突破類（5）---

function strategy_breakout_pattern(ind) {
  const name = 'breakout_pattern';
  if (!STRATEGY_ENABLED[name]) return NONE_SIGNAL(name);
  const { patterns, vol, dailyTrend, trend4h, stopPct, tpPct } = ind;

  // Pattern breakout using candle patterns with volume confirmation
  const bullPatterns = patterns.filter(p => p.direction === 'BUY');
  const bearPatterns = patterns.filter(p => p.direction === 'SELL');

  let direction = 'NONE';
  let confidence = 0;

  const bullWeight = bullPatterns.reduce((sum, p) => sum + p.weight, 0);
  const bearWeight = bearPatterns.reduce((sum, p) => sum + p.weight, 0);

  if (bullWeight > 1.5 && vol.ratio > 1.2) {
    direction = 'BUY';
    confidence = 0.4 + Math.min(bullWeight * 0.08, 0.3);
    if (['strong_up', 'up'].includes(dailyTrend)) confidence += 0.1;
    if (['strong_up', 'up'].includes(trend4h)) confidence += 0.05;
  } else if (bearWeight > 1.5 && vol.ratio > 1.2) {
    direction = 'SELL';
    confidence = 0.4 + Math.min(bearWeight * 0.08, 0.3);
    if (['strong_down', 'down'].includes(dailyTrend)) confidence += 0.1;
    if (['strong_down', 'down'].includes(trend4h)) confidence += 0.05;
  }

  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_breakout_bollinger_squeeze(ind) {
  const name = 'breakout_bollinger_squeeze';
  if (!STRATEGY_ENABLED[name]) return NONE_SIGNAL(name);
  const { bb_15m, bb_1h, macd_15m, vol, currentPrice, stopPct, tpPct, dailyTrend } = ind;

  // BB squeeze: width < 1.5 followed by expansion with volume
  if (bb_15m.width > 1.5) return NONE_SIGNAL(name); // 必須先擠壓

  let direction = 'NONE';
  let confidence = 0;

  if (currentPrice > bb_15m.upper && vol.ratio > 1.3 && macd_15m.histogram > 0) {
    direction = 'BUY';
    confidence = 0.5;
    if (bb_1h.width < 2.0) confidence += 0.1; // 多時間框架擠壓
    if (vol.ratio > 2.0) confidence += 0.1;
    if (['strong_up', 'up'].includes(dailyTrend)) confidence += 0.05;
  } else if (currentPrice < bb_15m.lower && vol.ratio > 1.3 && macd_15m.histogram < 0) {
    direction = 'SELL';
    confidence = 0.5;
    if (bb_1h.width < 2.0) confidence += 0.1;
    if (vol.ratio > 2.0) confidence += 0.1;
    if (['strong_down', 'down'].includes(dailyTrend)) confidence += 0.05;
  }

  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_breakout_range(ind) {
  const name = 'breakout_range';
  if (!STRATEGY_ENABLED[name]) return NONE_SIGNAL(name);
  const { candles_1h, currentPrice, vol, stopPct, tpPct } = ind;

  if (candles_1h.length < 24) return NONE_SIGNAL(name);

  // 箱型突破：找過去 24 根 1H K 線的高低點
  const range = candles_1h.slice(-24);
  const rangeHigh = Math.max(...range.map(c => c.high));
  const rangeLow = Math.min(...range.map(c => c.low));
  const rangeWidth = (rangeHigh - rangeLow) / currentPrice * 100;

  // 必須是盤整（width < 3%）
  if (rangeWidth > 3.0 || rangeWidth < 0.5) return NONE_SIGNAL(name);

  let direction = 'NONE';
  let confidence = 0;

  if (currentPrice > rangeHigh && vol.ratio > 1.3) {
    direction = 'BUY';
    confidence = 0.5;
    if (vol.ratio > 2.0) confidence += 0.15;
  } else if (currentPrice < rangeLow && vol.ratio > 1.3) {
    direction = 'SELL';
    confidence = 0.5;
    if (vol.ratio > 2.0) confidence += 0.15;
  }

  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_breakout_outside_bar(ind) {
  const name = 'breakout_outside_bar';
  if (!STRATEGY_ENABLED[name]) return NONE_SIGNAL(name);
  const { patterns, vol, macd_15m, stopPct, tpPct, dailyTrend } = ind;

  const outsideBars = patterns.filter(p => p.name === 'outside_bar');
  if (outsideBars.length === 0) return NONE_SIGNAL(name);

  const ob = outsideBars[0];
  let direction = ob.direction;
  let confidence = 0.45;

  if (vol.ratio > 1.5) confidence += 0.1;
  if (direction === 'BUY' && macd_15m.histogram > 0) confidence += 0.1;
  if (direction === 'SELL' && macd_15m.histogram < 0) confidence += 0.1;
  if (direction === 'BUY' && ['strong_up', 'up'].includes(dailyTrend)) confidence += 0.05;
  if (direction === 'SELL' && ['strong_down', 'down'].includes(dailyTrend)) confidence += 0.05;

  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

function strategy_breakout_news_driven(ind) {
  const name = 'breakout_news_driven';
  if (!STRATEGY_ENABLED[name]) return NONE_SIGNAL(name);
  const { vol, rsi_15m, macd_15m, currentPrice, candles_15m, stopPct, tpPct } = ind;

  // 幣圈特有：突然的大量異動（可能新聞驅動）
  // 條件：極端放量 + 大幅價格變動 + 動量方向一致
  if (candles_15m.length < 3) return NONE_SIGNAL(name);
  if (vol.ratio < 2.5) return NONE_SIGNAL(name); // 至少 2.5 倍平均量

  const lastCandle = candles_15m[candles_15m.length - 1];
  const priceChangePct = (lastCandle.close - lastCandle.open) / lastCandle.open * 100;

  let direction = 'NONE';
  let confidence = 0;

  if (priceChangePct > 0.5 && macd_15m.histogram > 0) {
    direction = 'BUY';
    confidence = 0.45;
    if (vol.ratio > 4.0) confidence += 0.15;
    if (priceChangePct > 1.0) confidence += 0.1;
    if (rsi_15m > 50 && rsi_15m < 80) confidence += 0.05;
  } else if (priceChangePct < -0.5 && macd_15m.histogram < 0) {
    direction = 'SELL';
    confidence = 0.45;
    if (vol.ratio > 4.0) confidence += 0.15;
    if (priceChangePct < -1.0) confidence += 0.1;
    if (rsi_15m < 50 && rsi_15m > 20) confidence += 0.05;
  }

  return { direction, confidence: Math.min(confidence, 0.95), strategy: name, slPct: stopPct, tpPct };
}

// ========== ALL STRATEGIES ==========
const ALL_STRATEGIES = [
  strategy_trend_ema_cross,
  strategy_trend_mtf_alignment,
  strategy_trend_momentum_chase,
  strategy_trend_elliott_wave3,
  strategy_trend_flag_breakout,
  strategy_reversion_sr,
  strategy_reversion_rsi_divergence,
  strategy_reversion_bollinger,
  strategy_reversion_pin_bar,
  strategy_reversion_liquidation_bounce,
  strategy_breakout_pattern,
  strategy_breakout_bollinger_squeeze,
  strategy_breakout_range,
  strategy_breakout_outside_bar,
  strategy_breakout_news_driven,
];

// ========== BTC CORRELATION CHECK ==========
let _btc1hCache = null;

async function checkBTCCorrelation() {
  // Returns the BTC 1H price change percentage
  try {
    if (_btc1hCache) return _btc1hCache;
    const candles = await getCandles(PARAMS.btcPair, 60, 5);
    if (candles.length < 2) return 0;
    const oldPrice = candles[0].open;
    const newPrice = candles[candles.length - 1].close;
    const changePct = (newPrice - oldPrice) / oldPrice * 100;
    _btc1hCache = changePct;
    return changePct;
  } catch (e) {
    return 0;
  }
}

// ========== OPENAI 輔助分析 ==========
async function askOpenAI(prompt) {
  try {
    const cfg = JSON.parse(fs.readFileSync(OPENAI_CONFIG_FILE, 'utf8'));
    const body = JSON.stringify({
      model: 'gpt-4o-mini',
      messages: [{ role: 'system', content: '你是一位專業加密貨幣交易分析師。只回覆JSON格式。' }, { role: 'user', content: prompt }],
      max_tokens: 200,
      temperature: 0.3
    });
    return new Promise((resolve, reject) => {
      const req = https.request({
        hostname: 'api.openai.com',
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${cfg.api_key}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body)
        },
        timeout: 15000
      }, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => {
          try {
            const j = JSON.parse(data);
            resolve(j.choices?.[0]?.message?.content || '');
          } catch (e) { resolve(''); }
        });
      });
      req.on('error', () => resolve(''));
      req.on('timeout', () => { req.destroy(); resolve(''); });
      req.write(body);
      req.end();
    });
  } catch (e) { return ''; }
}

async function openAIConfidenceAdjust(market, bestSignal, ind) {
  if (!bestSignal || bestSignal.direction === 'NONE') return bestSignal;
  if (!fs.existsSync(OPENAI_CONFIG_FILE)) return bestSignal;

  try {
    const prompt = `分析 ${market.toUpperCase()} 交易信號：
方向: ${bestSignal.direction} | 策略: ${bestSignal.strategy} | 信心: ${(bestSignal.confidence * 100).toFixed(0)}%
日線趨勢: ${ind.dailyTrend} | 4H趨勢: ${ind.trend4h} | 1H趨勢: ${ind.trend1h}
RSI 15m: ${ind.rsi_15m?.toFixed(1)} | RSI 1h: ${ind.rsi_1h?.toFixed(1)}
BB%B: ${ind.bb_15m.pctB?.toFixed(2)} | 量比: ${ind.vol.ratio?.toFixed(1)}
風報比: ${bestSignal.tpPct > 0 && bestSignal.slPct > 0 ? (bestSignal.tpPct / bestSignal.slPct).toFixed(1) : '-'}:1

請評估，回覆JSON：{"adjust": -0.15~+0.15, "note": "一句話", "risk": "low/medium/high"}`;

    const raw = await askOpenAI(prompt);
    const jsonMatch = raw.match(/\{[^}]+\}/);
    if (jsonMatch) {
      const ai = JSON.parse(jsonMatch[0]);
      const adjust = Math.max(-0.15, Math.min(0.15, parseFloat(ai.adjust) || 0));
      bestSignal.confidence = Math.max(0, Math.min(0.95, bestSignal.confidence + adjust));
      bestSignal.aiNote = ai.note || '';
      bestSignal.aiRisk = ai.risk || 'medium';
    }
  } catch (e) {}
  return bestSignal;
}

// ========== FETCH K-LINES ==========
async function getCandles(market, period, limit = 100) {
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

async function fetchAllTickers() {
  const tickers = [];
  for (const m of PARAMS.watchlist) {
    try {
      const t = await rest.getTicker({ market: m });
      if (t && t.last) tickers.push({ market: m, last: t.last, open: t.open, high: t.high, low: t.low, vol: t.vol });
    } catch (e) {}
  }
  return tickers;
}

// ========== POSITION SIZING ==========
function calcPositionSize(state, confidence, signal) {
  const capital = state.capital;
  const stopPct = signal.slPct;

  let riskPct = PARAMS.baseRiskPct;
  if (confidence >= PARAMS.highConfidence) riskPct = PARAMS.highConfRiskPct;

  // Registry-based risk multiplier
  if (_registry && signal.strategy) {
    riskPct *= getStrategyRiskMultiplier(_registry, signal.strategy);
  }

  // TESTING_PHASE: 不減倉
  if (!TESTING_PHASE) {
    if (state.consecutiveLosses >= 2) riskPct *= 0.7;
    if (state.consecutiveLosses >= 3) riskPct *= 0.5;
  }

  if (state.totalTrades > 5 && state.wins > state.losses) riskPct *= 1.1;

  const riskAmount = capital * (riskPct / 100);
  let sizeTWD = stopPct > 0 ? riskAmount / (stopPct / 100) : riskAmount * 10;

  const currentExposure = state.positions.reduce((sum, p) => sum + p.sizeTWD, 0);
  const maxExposure = capital * (PARAMS.maxTotalExposurePct / 100);
  sizeTWD = Math.min(sizeTWD, maxExposure - currentExposure, state.available);

  return Math.round(Math.max(0, sizeTWD));
}

// ========== POSITION MANAGEMENT ==========
function managePositions(state, tickers) {
  const toClose = [];
  let totalUnrealized = 0;

  for (const pos of state.positions) {
    const ticker = tickers.find(t => t.market === pos.market);
    if (!ticker) continue;

    const currentPrice = parseFloat(ticker.last);
    const pnlPct = pos.direction === 'BUY'
      ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
    const pnlTWD = pos.sizeTWD * (pnlPct / 100);

    pos.currentPrice = currentPrice;
    pos.pnlPct = pnlPct;
    pos.pnlTWD = pnlTWD;
    totalUnrealized += pnlTWD;

    if (!pos.peakPnl || pnlPct > pos.peakPnl) pos.peakPnl = pnlPct;

    // STOP LOSS
    const stopPct = pos.stopPct || 1.0;
    if (pnlPct <= -stopPct) {
      toClose.push({ pos, reason: 'STOP_LOSS', pnlPct, pnlTWD });
      continue;
    }

    // TRAILING STOP（分級追蹤）
    if (pos.peakPnl >= PARAMS.trailingActivatePct) {
      if (pnlPct < 0) {
        toClose.push({ pos, reason: 'BREAKEVEN_STOP', pnlPct, pnlTWD });
        continue;
      }

      let trailingStop = PARAMS.trailingStopPct;
      if (pos.peakPnl >= PARAMS.trailingWiden2Pct) trailingStop = 0.8;
      else if (pos.peakPnl >= PARAMS.trailingWiden1Pct) trailingStop = 0.5;

      const drawdown = pos.peakPnl - pnlPct;
      if (drawdown >= trailingStop) {
        toClose.push({ pos, reason: 'TRAILING_STOP', pnlPct, pnlTWD });
        continue;
      }
    }

    // TAKE PROFIT（放寬，讓追蹤止盈接手）
    const tpPct = pos.tpPct || 2.0;
    if (pnlPct >= tpPct * 1.5) {
      toClose.push({ pos, reason: 'TAKE_PROFIT_STRONG', pnlPct, pnlTWD });
      continue;
    }

    // TIME EXIT
    const holdHours = (Date.now() - new Date(pos.openTime).getTime()) / 3600000;
    if (holdHours > PARAMS.timeExitHours && pnlPct < PARAMS.timeExitMinPnlPct) {
      toClose.push({ pos, reason: 'TIME_EXIT', pnlPct, pnlTWD });
      continue;
    }
    if (holdHours > 8) {
      toClose.push({ pos, reason: 'MAX_TIME_EXIT', pnlPct, pnlTWD });
      continue;
    }
  }

  state.unrealizedPnl = Math.round(totalUnrealized * 100) / 100;
  return toClose;
}

// ========== CLOSE TRADE ==========
function closeTrade(state, pos, reason, pnlPct, pnlTWD, now) {
  state.available += pos.sizeTWD + pnlTWD;
  state.capital += pnlTWD;
  state.realizedPnl += pnlTWD;
  state.totalTrades++;

  if (pnlTWD >= 0) {
    state.wins++;
    state.consecutiveLosses = 0;
    state.currentConsecutiveWins = (state.currentConsecutiveWins || 0) + 1;
    if (state.currentConsecutiveWins > (state.maxConsecutiveWins || 0)) {
      state.maxConsecutiveWins = state.currentConsecutiveWins;
    }
    if (pnlTWD > (state.maxSingleWin || 0)) state.maxSingleWin = pnlTWD;
  } else {
    state.losses++;
    state.consecutiveLosses++;
    state.currentConsecutiveWins = 0;
    if (state.consecutiveLosses > (state.maxConsecutiveLosses || 0)) {
      state.maxConsecutiveLosses = state.consecutiveLosses;
    }
    if (pnlTWD < (state.maxSingleLoss || 0)) state.maxSingleLoss = pnlTWD;
    state.lastLossTime = now.toISOString();

    // TESTING_PHASE: 不暫停
    if (!TESTING_PHASE && state.consecutiveLosses >= PARAMS.maxConsecutiveLosses) {
      state.pausedUntil = new Date(now.getTime() + PARAMS.pauseHours * 3600000).toISOString();
      appendLog({ event: 'PAUSED', reason: `${state.consecutiveLosses} consecutive losses`, until: state.pausedUntil });
    }
  }

  if (state.capital > state.peakCapital) state.peakCapital = state.capital;
  const dd = ((state.peakCapital - state.capital) / state.peakCapital) * 100;
  if (dd > state.maxDrawdown) state.maxDrawdown = dd;

  // Strategy stats (using v4 strategy name)
  const strat = pos.strategy || 'unknown';
  if (!state.strategyStats[strat]) state.strategyStats[strat] = { wins: 0, losses: 0, pnl: 0, totalPnlTWD: 0 };
  state.strategyStats[strat].pnl += pnlTWD;
  state.strategyStats[strat].totalPnlTWD = (state.strategyStats[strat].totalPnlTWD || 0) + pnlTWD;
  if (pnlTWD >= 0) state.strategyStats[strat].wins++;
  else state.strategyStats[strat].losses++;

  const closedTrade = {
    market: pos.market, direction: pos.direction,
    entryPrice: pos.entryPrice, exitPrice: pos.currentPrice,
    sizeTWD: pos.sizeTWD,
    pnlTWD: Math.round(pnlTWD * 100) / 100,
    pnlPct: Math.round(pnlPct * 100) / 100,
    riskRewardRatio: pos.riskRewardRatio,
    reason, strategy: pos.strategy, signals: pos.signals || [],
    confidence: pos.confidence,
    openTime: pos.openTime, closeTime: now.toISOString(),
    outcome: pnlTWD >= 0 ? 'WIN' : 'LOSS'
  };
  state.closedTrades.push(closedTrade);
  if (state.closedTrades.length > 100) state.closedTrades = state.closedTrades.slice(-100);

  appendLog({ event: 'CLOSE', ...closedTrade });
  state.positions = state.positions.filter(p => p !== pos);
  console.log(`📍 平倉 ${pos.direction} ${pos.market} | ${reason} | PnL NT$${pnlTWD.toFixed(2)} (${pnlPct.toFixed(2)}%) | 策略: ${strat}`);
}

// ========== MAIN ENGINE ==========
async function run() {
  const state = loadState();
  const now = new Date();

  const startTime = new Date(PARAMS.startTime);
  if (now < startTime) { console.log('⏳ v4 尚未開始'); return; }

  // Check pause (TESTING_PHASE = 跳過)
  if (!TESTING_PHASE && state.pausedUntil && now < new Date(state.pausedUntil)) {
    console.log(`⏸️ 暫停中，到 ${state.pausedUntil}`);
    await updateDashboard(state);
    return;
  }

  // Cooldown after loss (TESTING_PHASE = 跳過)
  if (!TESTING_PHASE && state.lastLossTime) {
    const cooldownEnd = new Date(new Date(state.lastLossTime).getTime() + PARAMS.cooldownMinutes * 60000);
    if (now < cooldownEnd) {
      console.log(`❄️ 冷卻中，到 ${cooldownEnd.toISOString()}`);
      await updateDashboard(state);
      return;
    }
  }

  const tickers = await fetchAllTickers();
  if (tickers.length === 0) { console.log('⚠️ 無法取得行情'); return; }

  // Reset BTC cache
  _btc1hCache = null;

  // 1. Manage existing positions
  const toClose = managePositions(state, tickers);
  for (const { pos, reason, pnlPct, pnlTWD } of toClose) {
    closeTrade(state, pos, reason, pnlPct, pnlTWD, now);
  }

  // 2. Find new opportunities
  if (state.positions.length < PARAMS.maxConcurrentPositions) {
    const currentExposure = state.positions.reduce((sum, p) => sum + p.sizeTWD, 0);
    const maxExposure = state.capital * (PARAMS.maxTotalExposurePct / 100);
    const heldMarkets = state.positions.map(p => p.market);

    const opportunities = [];

    for (const m of PARAMS.watchlist) {
      if (heldMarkets.includes(m)) continue;

      // ★ BTC 關聯性規則：山寨幣做多前先檢查 BTC
      const isAltcoin = PARAMS.altcoins.includes(m);
      let btcBlocked = false;
      if (isAltcoin) {
        const btcChange = await checkBTCCorrelation();
        if (btcChange < -PARAMS.btcDropThreshold) {
          btcBlocked = true; // BTC 1H 跌 > 2%，不做多山寨幣
          console.log(`⚠️ ${m} BTC 1H 跌幅 ${btcChange.toFixed(2)}%，不做多山寨幣`);
        }
      }

      const [candles_daily, candles_4h, candles_1h, candles_15m, candles_5m] = await Promise.all([
        getCandles(m, 1440, 60),
        getCandles(m, 240, 60),
        getCandles(m, 60, 100),
        getCandles(m, 15, 100),
        getCandles(m, 5, 60)
      ]);

      if (!candles_1h.length || !candles_15m.length) continue;

      const ind = computeIndicators(candles_daily, candles_4h, candles_1h, candles_15m, candles_5m);
      if (!ind || ind.currentPrice === 0) continue;

      // Run all 15 strategies
      const signals = ALL_STRATEGIES.map(fn => fn(ind)).filter(s => s.direction !== 'NONE');

      if (signals.length === 0) {
        console.log(`⏭️ ${m} 無策略觸發`);
        continue;
      }

      // Pick best signal by confidence
      signals.sort((a, b) => b.confidence - a.confidence);
      let bestSignal = signals[0];

      // 交易量時段信心調整
      const volAdj = getVolumeConfidenceAdjust(_volumePatterns);
      if (volAdj !== 0) {
        bestSignal.confidence = Math.max(0, Math.min(0.95, bestSignal.confidence + volAdj));
        if (volAdj > 0) console.log(`  📈 高量時段 +${(volAdj*100).toFixed(0)}% 信心`);
        else console.log(`  📉 低量時段 ${(volAdj*100).toFixed(0)}% 信心`);
      }

      // 量價背離警告
      const divWarning = checkVolumeDivergenceWarning(_volumePatterns, m);
      if (divWarning) {
        console.log(`  ⚠️ 量價背離: ${divWarning.description}`);
      }

      // ★ BTC blocked: only block BUY for altcoins
      if (btcBlocked && bestSignal.direction === 'BUY') {
        // Try next SELL signal
        const sellSignals = signals.filter(s => s.direction === 'SELL');
        if (sellSignals.length > 0) {
          bestSignal = sellSignals[0];
        } else {
          console.log(`⏭️ ${m} BTC 關聯性阻擋做多，無做空信號`);
          continue;
        }
      }

      // OpenAI adjustment
      bestSignal = await openAIConfidenceAdjust(m, bestSignal, ind);

      // Confidence threshold
      const isPrimary = PARAMS.primary.includes(m);
      const threshold = isPrimary ? PARAMS.minConfidencePrimary : PARAMS.minConfidenceSecondary;
      if (bestSignal.confidence < threshold) {
        console.log(`⏭️ ${m} ${bestSignal.strategy} 信心不足 ${(bestSignal.confidence * 100).toFixed(0)}% < ${(threshold * 100).toFixed(0)}%`);
        continue;
      }

      // Risk-reward check
      const rr = bestSignal.slPct > 0 ? bestSignal.tpPct / bestSignal.slPct : 0;
      if (rr < PARAMS.minRiskRewardRatio) {
        console.log(`⏭️ ${m} ${bestSignal.strategy} 風報比不足 ${rr.toFixed(1)}:1 < ${PARAMS.minRiskRewardRatio}:1`);
        continue;
      }

      opportunities.push({ market: m, signal: bestSignal, ind, isPrimary, allSignals: signals });
    }

    // Sort by confidence × risk-reward
    opportunities.sort((a, b) => {
      const rrA = a.signal.slPct > 0 ? a.signal.tpPct / a.signal.slPct : 0;
      const rrB = b.signal.slPct > 0 ? b.signal.tpPct / b.signal.slPct : 0;
      return (rrB * b.signal.confidence) - (rrA * a.signal.confidence);
    });

    for (const opp of opportunities) {
      if (state.positions.length >= PARAMS.maxConcurrentPositions) break;
      if (currentExposure >= maxExposure) break;
      if (state.available < 500) break;

      const { market, signal, ind } = opp;
      const sizeTWD = calcPositionSize(state, signal.confidence, signal);
      if (sizeTWD < 500) continue;

      const rr = signal.slPct > 0 ? signal.tpPct / signal.slPct : 0;

      // 確保 strategy 名稱使用 registry key，AI 分析放獨立欄位
      const registryKey = validateStrategyName(_registry, signal.strategy);

      const newPos = {
        market,
        direction: signal.direction,
        entryPrice: ind.currentPrice,
        sizeTWD,
        stopPct: signal.slPct,
        tpPct: signal.tpPct,
        riskRewardRatio: Math.round(rr * 100) / 100,
        strategy: registryKey,  // 只用 registry key，不允許 AI 改名
        strategyType: registryKey.split('_')[0], // trend/reversion/breakout
        aiAnalysis: signal.aiNote ? { note: signal.aiNote, risk: signal.aiRisk || 'medium' } : null,
        signals: [registryKey],
        confidence: signal.confidence,
        dailyTrend: ind.dailyTrend,
        rsi_15m: Math.round(ind.rsi_15m * 10) / 10,
        rsi_1h: Math.round(ind.rsi_1h * 10) / 10,
        openTime: now.toISOString(),
        peakPnl: 0,
        registryState: _registry?.strategies[registryKey]?.state || 'ACTIVE'
      };

      state.positions.push(newPos);
      state.available -= sizeTWD;

      appendLog({ event: 'OPEN', ...newPos });
      console.log(`🚀 開倉 ${signal.direction} ${market} @ ${ind.currentPrice} | 策略 ${signal.strategy} | 信心 ${(signal.confidence * 100).toFixed(0)}% | 風報比 ${rr.toFixed(1)}:1 | 倉位 NT$${sizeTWD} | 止損 ${signal.slPct.toFixed(2)}% 止盈 ${signal.tpPct.toFixed(2)}%`);
    }
  }

  saveState(state);
  await updateDashboard(state);

  const returnPct = ((state.capital - (state.v4StartCapital || PARAMS.initialCapital)) / (state.v4StartCapital || PARAMS.initialCapital) * 100).toFixed(2);
  console.log(`💰 v4 | 資本 NT$${state.capital.toFixed(2)} | 未實現 NT$${state.unrealizedPnl.toFixed(2)} | 持倉 ${state.positions.length} | ${state.wins}W/${state.losses}L | 報酬 ${returnPct}%`);
}

// ========== DASHBOARD (v4 完整輸出) ==========
async function updateDashboard(state) {
  try {
    let dashData = {};
    if (fs.existsSync(DASHBOARD_FILE)) {
      dashData = JSON.parse(fs.readFileSync(DASHBOARD_FILE, 'utf8'));
    }
    const now = new Date();
    const lastUpdateStr = now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

    // --- Compute stats ---
    const closedTrades = state.closedTrades || [];
    const wins = closedTrades.filter(t => t.outcome === 'WIN');
    const losses = closedTrades.filter(t => t.outcome === 'LOSS');
    const avgWin = wins.length > 0 ? Math.round(wins.reduce((s, t) => s + t.pnlTWD, 0) / wins.length * 100) / 100 : 0;
    const avgLoss = losses.length > 0 ? Math.round(losses.reduce((s, t) => s + t.pnlTWD, 0) / losses.length * 100) / 100 : 0;
    const riskRewardRatio = avgLoss !== 0 ? Math.round(Math.abs(avgWin / avgLoss) * 100) / 100 : 0;

    // Today PnL
    const todayStr = now.toISOString().slice(0, 10);
    const todayTrades = closedTrades.filter(t => t.closeTime && t.closeTime.startsWith(todayStr));
    const todayPnl = Math.round(todayTrades.reduce((s, t) => s + (t.pnlTWD || 0), 0) * 100) / 100;

    // Week PnL (last 7 days)
    const weekAgo = new Date(now.getTime() - 7 * 86400000);
    const weekTrades = closedTrades.filter(t => t.closeTime && new Date(t.closeTime) >= weekAgo);
    const weekPnl = Math.round(weekTrades.reduce((s, t) => s + (t.pnlTWD || 0), 0) * 100) / 100;

    // Strategy stats with ranking
    const ss = state.strategyStats || {};
    const strategyStats = {};
    const stratEntries = Object.entries(ss).map(([name, st]) => {
      const total = st.wins + st.losses;
      const wr = total > 0 ? ((st.wins / total) * 100).toFixed(1) + '%' : '--';
      const avgW = st.wins > 0 ? (st.pnl > 0 ? st.pnl / st.wins : 0) : 0;
      const avgL = st.losses > 0 ? (st.pnl < 0 ? Math.abs(st.pnl) / st.losses : 0) : 0;
      const rr = avgL > 0 ? Math.round(avgW / avgL * 100) / 100 : (avgW > 0 ? 99 : 0);
      return { name, wins: st.wins, losses: st.losses, pnl: Math.round(st.pnl * 100) / 100, winRate: wr, riskReward: rr };
    });
    stratEntries.sort((a, b) => b.pnl - a.pnl);
    stratEntries.forEach((s, i) => {
      strategyStats[s.name] = { ...s, rank: i + 1 };
      delete strategyStats[s.name].name;
    });

    // Best/worst strategy
    const bestStrat = stratEntries.length > 0 ? stratEntries[0] : null;
    const worstStrat = stratEntries.length > 0 ? stratEntries[stratEntries.length - 1] : null;

    // Review section
    let reviewData = {};
    if (fs.existsSync(REVIEW_FILE)) {
      try { reviewData = JSON.parse(fs.readFileSync(REVIEW_FILE, 'utf8')); } catch (e) {}
    }
    const lessons = [];
    if (state.totalTrades > 0) {
      const winRate = ((state.wins / state.totalTrades) * 100).toFixed(1);
      lessons.push(`累計 ${state.totalTrades} 筆交易，勝率 ${winRate}%`);
      if (riskRewardRatio < 1.5) lessons.push('風報比偏低，需要讓獲利單跑更久');
      if (parseFloat(winRate) < 40) lessons.push('勝率偏低，但只要風報比 > 2.0 就能獲利');
    }

    const optimization = [];
    for (const [name, st] of Object.entries(ss)) {
      const total = st.wins + st.losses;
      if (total >= 5 && st.wins / total < 0.25) {
        optimization.push(`考慮停用 ${name}（勝率 ${((st.wins / total) * 100).toFixed(0)}%，共 ${total} 筆）`);
      }
    }

    const enabledStrategies = Object.entries(STRATEGY_ENABLED).filter(([, v]) => v).map(([k]) => k);
    const strategiesWithData = Object.keys(ss);
    const strategiesUnderTest = enabledStrategies.filter(s => !strategiesWithData.includes(s));

    const review = {
      summary: `v4 引擎 | ${state.wins}勝/${state.losses}敗 | 勝率 ${state.totalTrades > 0 ? ((state.wins / state.totalTrades) * 100).toFixed(1) : 0}% | 報酬 ${((state.capital - (state.v4StartCapital || PARAMS.initialCapital)) / (state.v4StartCapital || PARAMS.initialCapital) * 100).toFixed(2)}% | 15 策略模組化`,
      bestStrategy: bestStrat ? { name: bestStrat.name, pnl: bestStrat.pnl, wins: bestStrat.wins, losses: bestStrat.losses } : null,
      worstStrategy: worstStrat && worstStrat.name !== bestStrat?.name ? { name: worstStrat.name, pnl: worstStrat.pnl, wins: worstStrat.wins, losses: worstStrat.losses } : null,
      lessons,
      optimization,
      strategiesUnderTest: strategiesUnderTest.length > 0 ? strategiesUnderTest : ['所有策略已有數據'],
      recentChanges: [
        'v3→v4: 15 策略模組化',
        'v4: BTC 關聯性規則（山寨幣）',
        'v4: Dashboard 完整輸出',
        'v4: TESTING_PHASE 不暫停不減倉'
      ],
      nextSteps: [
        '累積交易數據，評估各策略表現',
        '停用表現差的策略',
        '根據風報比排名調整策略優先級',
        '目標：找到 3-5 個穩定獲利策略'
      ]
    };

    // Alerts
    const alerts = [];
    if (state.consecutiveLosses >= 3) alerts.push(`⚠️ 連虧 ${state.consecutiveLosses} 筆（TESTING_PHASE 不暫停）`);
    if (state.maxDrawdown > 10) alerts.push(`🔴 最大回撤 ${state.maxDrawdown.toFixed(1)}% 超過 10%`);
    if (state.capital < (state.v4StartCapital || PARAMS.initialCapital) * 0.85) alerts.push('🔴 資金低於初始的 85%');

    // Actions
    const actions = [];
    if (optimization.length > 0) actions.push(...optimization);
    if (state.totalTrades > 0 && riskRewardRatio < 1.5) actions.push('調高止盈倍數或收緊止損');

    // Build v4 dashboard output
    dashData.lastUpdate = lastUpdateStr;
    dashData.simulation = {
      enabled: true,
      version: 4,
      status: 'RUNNING',
      initialCapital: state.v4StartCapital || PARAMS.initialCapital,
      currentCapital: Math.round(state.capital * 100) / 100,
      available: Math.round(state.available * 100) / 100,
      realizedPnl: Math.round(state.realizedPnl * 100) / 100,
      unrealizedPnl: state.unrealizedPnl || 0,
      returnPct: Math.round(((state.capital - (state.v4StartCapital || PARAMS.initialCapital)) / (state.v4StartCapital || PARAMS.initialCapital)) * 10000) / 100,
      totalTrades: state.totalTrades,
      wins: state.wins,
      losses: state.losses,
      winRate: state.totalTrades > 0 ? ((state.wins / state.totalTrades) * 100).toFixed(1) + '%' : '--',
      maxDrawdown: Math.round(state.maxDrawdown * 100) / 100,
      positions: state.positions.map(p => ({
        market: p.market, direction: p.direction,
        entryPrice: p.entryPrice, currentPrice: p.currentPrice || p.entryPrice,
        sizeTWD: p.sizeTWD,
        pnlPct: Math.round((p.pnlPct || 0) * 100) / 100,
        pnlTWD: Math.round((p.pnlTWD || 0) * 100) / 100,
        riskRewardRatio: p.riskRewardRatio,
        strategy: p.strategy, confidence: p.confidence,
        dailyTrend: p.dailyTrend, openTime: p.openTime
      })),
      closedTrades: state.closedTrades.slice(-20),
      strategyStats,
      consecutiveLosses: state.consecutiveLosses,
      pausedUntil: state.pausedUntil,
      v4StartTime: state.v4StartTime,
      lastUpdate: lastUpdateStr
    };

    // v4 完整 account 欄位
    dashData.account = {
      capital: Math.round(state.capital * 100) / 100,
      realizedPnl: Math.round(state.realizedPnl * 100) / 100,
      unrealizedPnl: state.unrealizedPnl || 0,
      netEquity: Math.round((state.capital + (state.unrealizedPnl || 0)) * 100) / 100,
      todayPnl,
      weekPnl,
      totalTrades: state.totalTrades,
      closedTrades: state.totalTrades,
      openCount: state.positions.length,
      wins: state.wins,
      losses: state.losses,
      winRate: state.totalTrades > 0 ? ((state.wins / state.totalTrades) * 100).toFixed(1) + '%' : '--',
      avgWin,
      avgLoss,
      riskRewardRatio,
      maxConsecutiveWins: state.maxConsecutiveWins || 0,
      maxConsecutiveLosses: state.maxConsecutiveLosses || 0,
      maxSingleWin: Math.round((state.maxSingleWin || 0) * 100) / 100,
      maxSingleLoss: Math.round((state.maxSingleLoss || 0) * 100) / 100,
      maxDrawdown: Math.round(state.maxDrawdown * 100) / 100
    };

    dashData.instruments = PARAMS.watchlist;
    dashData.openPositions = dashData.simulation.positions;
    dashData.closedTrades = dashData.simulation.closedTrades;
    dashData.strategyStats = strategyStats;

    dashData.review = review;

    dashData.riskParams = {
      maxPositions: PARAMS.maxConcurrentPositions,
      maxExposure: PARAMS.maxTotalExposurePct + '%',
      baseRisk: PARAMS.baseRiskPct + '%',
      slMethod: `ATR x ${PARAMS.stopLossATR}`,
      minRiskReward: `${PARAMS.minRiskRewardRatio}:1`,
      trailingStop: `${PARAMS.trailingActivatePct}% activate, widen at ${PARAMS.trailingWiden1Pct}%/${PARAMS.trailingWiden2Pct}%`,
      mode: 'simulation',
      testingPhase: TESTING_PHASE
    };

    dashData.alerts = alerts;
    dashData.actions = actions;

    fs.writeFileSync(DASHBOARD_FILE, JSON.stringify(dashData, null, 2));
  } catch (e) {
    console.error('Dashboard error:', e.message);
  }
}

// ========== 復盤系統 ==========
function reviewAndLearn(state) {
  let review = { lastReviewAt: 0, lessons: [], adjustments: [] };
  if (fs.existsSync(REVIEW_FILE)) review = JSON.parse(fs.readFileSync(REVIEW_FILE, 'utf8'));

  if (state.totalTrades <= review.lastReviewAt) return;
  if ((state.totalTrades - review.lastReviewAt) < PARAMS.reviewEveryNTrades) return;

  const recent = state.closedTrades.slice(-10);
  if (recent.length === 0) return;

  const wins = recent.filter(t => t.outcome === 'WIN');
  const losses = recent.filter(t => t.outcome === 'LOSS');
  const winRate = (wins.length / recent.length * 100).toFixed(1);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + Math.abs(t.pnlPct), 0) / losses.length : 0;
  const profitFactor = avgLoss > 0 ? (avgWin * wins.length) / (avgLoss * losses.length) : 999;

  const lesson = {
    reviewAt: state.totalTrades,
    timestamp: new Date().toISOString(),
    recentTrades: recent.length,
    winRate: parseFloat(winRate),
    avgWinPct: Math.round(avgWin * 100) / 100,
    avgLossPct: Math.round(avgLoss * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    capitalAtReview: state.capital,
    returnPct: Math.round(((state.capital - (state.v4StartCapital || PARAMS.initialCapital)) / (state.v4StartCapital || PARAMS.initialCapital)) * 10000) / 100,
    // v4: 策略分佈
    strategyDistribution: recent.reduce((acc, t) => { acc[t.strategy] = (acc[t.strategy] || 0) + 1; return acc; }, {})
  };

  review.lessons.push(lesson);
  if (review.lessons.length > 20) review.lessons = review.lessons.slice(-20);
  review.lastReviewAt = state.totalTrades;
  fs.writeFileSync(REVIEW_FILE, JSON.stringify(review, null, 2));
  console.log(`📊 v4 復盤 | 勝率 ${winRate}% | 平均賺 ${avgWin.toFixed(2)}% 平均虧 ${avgLoss.toFixed(2)}% | 盈虧比 ${profitFactor.toFixed(2)}`);
}

// ========== RUN ==========
run().then(() => {
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    reviewAndLearn(state);
  } catch (e) {}
}).catch(e => {
  console.error('❌ v4 Engine error:', e.message);
  appendLog({ event: 'ERROR', error: e.message });
});
