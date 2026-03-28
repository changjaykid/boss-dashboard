#!/usr/bin/env node
// 虛擬貨幣模擬交易引擎 v2 — 48小時利潤最大化
// 核心改進：
// 1. 多時間框架確認（日線趨勢 + 4H 結構 + 1H/15M 進場）
// 2. 趨勢跟隨為主（順勢才做，不逆勢）
// 3. 嚴格進場條件（最低信心門檻 0.55）
// 4. 動態倉位管理（凱利公式啟發）
// 5. 更積極的止盈策略（利潤最大化）

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

// ========== 交易參數 ==========
const PARAMS = {
  initialCapital: 30000,
  maxConcurrentPositions: 8,     // 大量持倉，瘋狂試錯
  maxTotalExposurePct: 90,       // 模擬交易盡量打滿
  stopLossPct: 0.6,              // 緊止損，錯就快跑
  takeProfitPct: 0.8,            // 低止盈，頻繁獲利了結
  trailingStopPct: 0.4,          // 緊追蹤
  trailingActivatePct: 0.5,      // 很早啟動
  minConfidence: 0.50,           // 基本門檻
  highConfidence: 0.65,          // 高信心
  cooldownMinutes: 2,            // 幾乎不冷卻（模擬不怕）
  maxConsecutiveLosses: 8,       // 模擬容忍高連虧
  pauseHours: 0.25,              // 暫停15分鐘就好
  scalingIn: true,
  compounding: true,
  // 瘋狂試錯模式
  aggressiveMode: true,
  timeExitHours: 2,              // 2小時沒動靜就換下一筆
  reviewEveryNTrades: 5,         // 每5筆復盤
  // 多策略實驗：同一幣種允許不同方向的持倉（對沖實驗）
  allowSameMarketPositions: true,
  // 策略標籤（用來追蹤哪種策略最賺）
  strategyTags: ['trend_follow', 'mean_revert', 'breakout', 'scalp'],
  // 持續運行模式（不再限制48小時）
  startTime: '2026-03-28T15:44:00+08:00',
  endTime: '2099-12-31T23:59:59+08:00',
  // 老闆指示：BTC/TWD + ETH/TWD 為主力，其他挑2個有機會的
  watchlist: ['btctwd', 'ethtwd', 'soltwd', 'dogetwd'],
  primary: ['btctwd', 'ethtwd'],  // 主力：優先、門檻低、倉位大
  secondary: ['soltwd', 'dogetwd']  // 輔助：要好機會才做
};

// ========== STATE ==========
function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (s.version === 2) return s;
  }
  const initial = {
    version: 2,
    capital: PARAMS.initialCapital,
    available: PARAMS.initialCapital,
    positions: [],
    closedTrades: [],
    totalTrades: 0,
    wins: 0,
    losses: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    peakCapital: PARAMS.initialCapital,
    maxDrawdown: 0,
    consecutiveLosses: 0,
    lastLossTime: null,
    pausedUntil: null,
    strategyStats: {},
    dailyStats: {},
    lastRun: null
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

// ========== TECHNICAL ANALYSIS ==========
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
  // Calculate full MACD line
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
  // Simplified VWAP from available candles
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
  const pRange = p.high - p.low;
  const pIsBullish = p.close > p.open;

  // Hammer / Inverted Hammer（需在下跌趨勢中才有意義，但先標記）
  if (lowerWick > body * 2.5 && upperWick < body * 0.3) {
    patterns.push({ name: 'hammer', direction: 'BUY', weight: 1.2 });
  }
  if (upperWick > body * 2.5 && lowerWick < body * 0.3) {
    patterns.push({ name: 'shooting_star', direction: 'SELL', weight: 1.2 });
  }

  // Engulfing
  if (!pIsBullish && isBullish && c.close > p.open && c.open < p.close && body > pBody * 1.3) {
    patterns.push({ name: 'bullish_engulfing', direction: 'BUY', weight: 1.5 });
  }
  if (pIsBullish && !isBullish && c.close < p.open && c.open > p.close && body > pBody * 1.3) {
    patterns.push({ name: 'bearish_engulfing', direction: 'SELL', weight: 1.5 });
  }

  // Morning/Evening Star（三根K線）
  const ppBody = Math.abs(pp.close - pp.open);
  const ppIsBullish = pp.close > pp.open;
  if (!ppIsBullish && pBody < ppBody * 0.3 && isBullish && body > ppBody * 0.5) {
    patterns.push({ name: 'morning_star', direction: 'BUY', weight: 1.8 });
  }
  if (ppIsBullish && pBody < ppBody * 0.3 && !isBullish && body > ppBody * 0.5) {
    patterns.push({ name: 'evening_star', direction: 'SELL', weight: 1.8 });
  }

  // Strong momentum candle（大陽/大陰線）
  if (body > range * 0.7 && range > 0) {
    if (isBullish) patterns.push({ name: 'strong_bull', direction: 'BUY', weight: 0.8 });
    else patterns.push({ name: 'strong_bear', direction: 'SELL', weight: 0.8 });
  }

  return patterns;
}

// Volume analysis
function volumeAnalysis(candles, period = 20) {
  if (candles.length < period + 1) return { ratio: 1, trend: 'flat' };
  const vols = candles.slice(-(period + 1), -1).map(c => c.volume);
  const avgVol = vols.reduce((a, b) => a + b, 0) / vols.length;
  const currentVol = candles[candles.length - 1].volume;
  const ratio = avgVol > 0 ? currentVol / avgVol : 1;
  
  // Volume trend
  const recentAvg = vols.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const olderAvg = vols.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
  const trend = recentAvg > olderAvg * 1.3 ? 'increasing' : recentAvg < olderAvg * 0.7 ? 'decreasing' : 'flat';
  
  return { ratio, trend };
}

// ========== MULTI-TIMEFRAME ANALYSIS ==========
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

function fullAnalysis(candles_daily, candles_4h, candles_1h, candles_15m) {
  if (!candles_1h.length || !candles_15m.length) return null;
  
  const closes_daily = candles_daily.map(c => c.close);
  const closes_4h = candles_4h.map(c => c.close);
  const closes_1h = candles_1h.map(c => c.close);
  const closes_15m = candles_15m.map(c => c.close);
  const currentPrice = closes_15m[closes_15m.length - 1];

  // 1. Daily trend（大方向）
  const dailyTrend = closes_daily.length >= 20 ? determineTrend(closes_daily) : 'unknown';
  
  // 2. 4H structure
  const trend4h = closes_4h.length >= 20 ? determineTrend(closes_4h) : 'unknown';
  
  // 3. 1H indicators
  const rsi_1h = calcRSI(closes_1h);
  const macd_1h = calcMACD(closes_1h);
  const bb_1h = calcBollinger(closes_1h);
  const atr_1h = calcATR(candles_1h);
  
  // 4. 15M entry signals
  const rsi_15m = calcRSI(closes_15m);
  const ema8 = calcEMA(closes_15m, 8);
  const ema21 = calcEMA(closes_15m, 21);
  const ema50 = closes_15m.length >= 50 ? calcEMA(closes_15m, 50) : ema21;
  const macd_15m = calcMACD(closes_15m);
  const bb_15m = calcBollinger(closes_15m);
  const patterns = detectCandlePatterns(candles_15m);
  const vol = volumeAnalysis(candles_15m);
  const vwap = calcVWAP(candles_15m.slice(-20));

  // ========== SCORING (多策略實驗) ==========
  let buyScore = 0, sellScore = 0;
  const signals = [];
  const details = {};
  
  // 標記策略類型（用來追蹤哪種最賺）
  let strategyType = 'trend_follow'; // default

  // --- TREND ALIGNMENT (最重要，佔40%權重) ---
  const trendBullish = ['strong_up', 'up'].includes(dailyTrend) || ['strong_up', 'up'].includes(trend4h);
  const trendBearish = ['strong_down', 'down'].includes(dailyTrend) || ['strong_down', 'down'].includes(trend4h);
  
  if (dailyTrend === 'strong_up') { buyScore += 2.5; signals.push('日線強勢多頭'); }
  else if (dailyTrend === 'up') { buyScore += 1.5; signals.push('日線偏多'); }
  else if (dailyTrend === 'strong_down') { sellScore += 2.5; signals.push('日線強勢空頭'); }
  else if (dailyTrend === 'down') { sellScore += 1.5; signals.push('日線偏空'); }

  if (trend4h === 'strong_up') { buyScore += 2; signals.push('4H多頭'); }
  else if (trend4h === 'up') { buyScore += 1; }
  else if (trend4h === 'strong_down') { sellScore += 2; signals.push('4H空頭'); }
  else if (trend4h === 'down') { sellScore += 1; }

  // --- RSI (超買/超賣反轉 + 背離) ---
  // 在趨勢中：超賣是買入機會（回調），超買可能續漲
  if (rsi_15m < 25) {
    if (trendBullish) { buyScore += 2; signals.push(`RSI超賣回調買入(${rsi_15m.toFixed(0)})`); }
    else { buyScore += 1; signals.push(`RSI超賣(${rsi_15m.toFixed(0)})`); }
  } else if (rsi_15m < 35 && trendBullish) {
    buyScore += 1; signals.push(`RSI低位+多頭趨勢(${rsi_15m.toFixed(0)})`);
  }
  
  if (rsi_15m > 75) {
    if (trendBearish) { sellScore += 2; signals.push(`RSI超買+空頭(${rsi_15m.toFixed(0)})`); }
    else { sellScore += 0.5; } // 多頭趨勢中超買不一定要賣
  } else if (rsi_15m > 65 && trendBearish) {
    sellScore += 1; signals.push(`RSI高位+空頭趨勢(${rsi_15m.toFixed(0)})`);
  }

  // 1H RSI confirmation
  if (rsi_1h < 35 && rsi_15m < 40) { buyScore += 1; signals.push('雙RSI共振低位'); }
  if (rsi_1h > 65 && rsi_15m > 60) { sellScore += 1; signals.push('雙RSI共振高位'); }

  // --- EMA CROSS ---
  const emaSpreadPct = Math.abs(ema8 - ema21) / currentPrice * 100;
  if (ema8 > ema21 && ema21 > ema50) { buyScore += 1.5; signals.push('EMA多頭排列'); }
  else if (ema8 > ema21) { buyScore += 0.8; signals.push('EMA8>21'); }
  
  if (ema8 < ema21 && ema21 < ema50) { sellScore += 1.5; signals.push('EMA空頭排列'); }
  else if (ema8 < ema21) { sellScore += 0.8; signals.push('EMA8<21'); }

  // --- MACD ---
  if (macd_15m.histogram > 0 && macd_1h.histogram > 0) { buyScore += 1; signals.push('MACD雙正'); }
  if (macd_15m.histogram < 0 && macd_1h.histogram < 0) { sellScore += 1; signals.push('MACD雙負'); }
  // MACD 翻轉（動量轉換）
  if (macd_15m.histogram > 0 && macd_15m.macd > macd_15m.signal) { buyScore += 0.5; }
  if (macd_15m.histogram < 0 && macd_15m.macd < macd_15m.signal) { sellScore += 0.5; }

  // --- BOLLINGER BANDS ---
  if (bb_15m.pctB < 0.05) { buyScore += 1.2; signals.push('觸布林下軌'); }
  if (bb_15m.pctB > 0.95) { sellScore += 1.2; signals.push('觸布林上軌'); }
  if (bb_15m.width < 1.5) { signals.push('布林極度擠壓(突破在即)'); }

  // --- VWAP ---
  if (currentPrice > vwap && trendBullish) { buyScore += 0.5; signals.push('價>VWAP'); }
  if (currentPrice < vwap && trendBearish) { sellScore += 0.5; signals.push('價<VWAP'); }

  // --- VOLUME CONFIRMATION ---
  if (vol.ratio > 1.5) {
    // 放量確認
    const dominant = buyScore > sellScore ? 'buy' : 'sell';
    if (dominant === 'buy') buyScore += 0.8;
    else sellScore += 0.8;
    signals.push(`放量(${vol.ratio.toFixed(1)}x)`);
  }

  // --- CANDLE PATTERNS ---
  for (const p of patterns) {
    if (p.direction === 'BUY' && (trendBullish || dailyTrend === 'sideways')) {
      buyScore += p.weight;
      signals.push(p.name);
    }
    if (p.direction === 'SELL' && (trendBearish || dailyTrend === 'sideways')) {
      sellScore += p.weight;
      signals.push(p.name);
    }
  }

  // ========== STRATEGY TYPE CLASSIFICATION ==========
  // 根據信號組合自動分類策略類型
  const hasRsiExtreme = rsi_15m < 25 || rsi_15m > 75;
  const hasBBExtreme = bb_15m.pctB < 0.05 || bb_15m.pctB > 0.95;
  const hasPatternSignal = patterns.length > 0;
  const hasMomentum = Math.abs(macd_15m.histogram) > 0 && vol.ratio > 1.3;
  
  if (hasRsiExtreme && hasBBExtreme) {
    strategyType = 'mean_revert';  // 均值回歸：超買/超賣 + 布林極端
  } else if (bb_15m.width < 1.5 && hasMomentum) {
    strategyType = 'breakout';     // 突破：布林擠壓 + 放量
  } else if (emaSpreadPct < 0.1 && vol.ratio < 0.8) {
    strategyType = 'scalp';        // 刮頭皮：盤整低波動
  } else {
    strategyType = 'trend_follow'; // 趨勢跟隨：默認
  }

  // ========== FINAL DECISION ==========
  const totalWeight = 12;
  const direction = buyScore > sellScore ? 'BUY' : 'SELL';
  const rawConfidence = Math.max(buyScore, sellScore) / totalWeight;
  
  let confidence = rawConfidence;
  
  // 模擬實驗模式：逆勢懲罰降低（允許嘗試逆勢單來收集數據）
  if (direction === 'BUY' && trendBearish) confidence *= 0.65;  // 原0.5
  if (direction === 'SELL' && trendBullish) confidence *= 0.65;
  // 順勢加分
  if (direction === 'BUY' && trendBullish) confidence *= 1.15;
  if (direction === 'SELL' && trendBearish) confidence *= 1.15;
  
  confidence = Math.min(confidence, 0.95);

  details.dailyTrend = dailyTrend;
  details.trend4h = trend4h;
  details.rsi_1h = rsi_1h;
  details.rsi_15m = rsi_15m;
  details.ema8 = ema8;
  details.ema21 = ema21;
  details.macd_15m = macd_15m;
  details.bb_15m = bb_15m;
  details.atr_1h = atr_1h;
  details.volRatio = vol.ratio;
  details.vwap = vwap;

  return {
    direction,
    confidence: Math.round(confidence * 100) / 100,
    buyScore: Math.round(buyScore * 100) / 100,
    sellScore: Math.round(sellScore * 100) / 100,
    signals,
    strategyType,
    currentPrice,
    atr: atr_1h,
    details
  };
}

// ========== OPENAI 輔助分析 ==========
const OPENAI_CONFIG_FILE = path.join(__dirname, 'openai_config.json');

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
            const content = j.choices?.[0]?.message?.content || '';
            resolve(content);
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

async function openAIAnalysis(market, analysis) {
  if (!analysis || !fs.existsSync(OPENAI_CONFIG_FILE)) return analysis;
  
  try {
    const prompt = `分析 ${market.toUpperCase()} 交易信號：
方向: ${analysis.direction} | 信心: ${(analysis.confidence * 100).toFixed(0)}%
日線趨勢: ${analysis.details.dailyTrend} | 4H趨勢: ${analysis.details.trend4h}
RSI 15m: ${analysis.details.rsi_15m?.toFixed(1)} | RSI 1h: ${analysis.details.rsi_1h?.toFixed(1)}
信號: ${analysis.signals.join(', ')}
策略: ${analysis.strategyType}

請評估這個交易信號的品質，回覆JSON：
{"adjust": 數字(-0.15到+0.15的信心調整), "note": "一句話理由", "risk": "low/medium/high"}`;

    const raw = await askOpenAI(prompt);
    const jsonMatch = raw.match(/\{[^}]+\}/);
    if (jsonMatch) {
      const ai = JSON.parse(jsonMatch[0]);
      const adjust = Math.max(-0.15, Math.min(0.15, parseFloat(ai.adjust) || 0));
      analysis.confidence = Math.max(0, Math.min(0.95, analysis.confidence + adjust));
      analysis.aiNote = ai.note || '';
      analysis.aiRisk = ai.risk || 'medium';
      analysis.signals.push(`AI:${ai.note?.substring(0, 20) || 'reviewed'}`);
    }
  } catch (e) {
    // AI 分析失敗不影響主流程
  }
  return analysis;
}

// ========== FETCH K-LINES ==========
async function getCandles(market, period, limit = 100) {
  try {
    const candles = await rest.getKLine({ market, period, limit });
    return candles.map(c => ({
      time: c[0],
      open: parseFloat(c[1]),
      high: parseFloat(c[2]),
      low: parseFloat(c[3]),
      close: parseFloat(c[4]),
      volume: parseFloat(c[5])
    }));
  } catch (e) {
    console.error(`K-line error ${market}/${period}:`, e.message);
    return [];
  }
}

// ========== POSITION SIZING ==========
function calcPositionSize(state, confidence, atr, currentPrice) {
  const rm = PARAMS;
  const capital = state.capital;
  
  // ATR-based stop loss distance
  const atrStopPct = atr / currentPrice * 100 * 1.5; // 1.5x ATR
  const effectiveStopPct = Math.max(rm.stopLossPct, Math.min(atrStopPct, 3.0));
  
  // Base risk: 2% of capital
  let riskPct = 2;
  
  // Scale by confidence
  if (confidence >= rm.highConfidence) riskPct = 3;
  else if (confidence >= 0.60) riskPct = 2.5;
  
  // Reduce if losing streak
  if (state.consecutiveLosses >= 2) riskPct *= 0.7;
  if (state.consecutiveLosses >= 3) riskPct *= 0.5;
  
  // Increase if winning streak
  if (state.wins > state.losses && state.totalTrades > 3) riskPct *= 1.2;
  
  const riskAmount = capital * (riskPct / 100);
  let sizeTWD = riskAmount / (effectiveStopPct / 100);
  
  // Cap at max exposure
  const currentExposure = state.positions.reduce((sum, p) => sum + p.sizeTWD, 0);
  const maxExposure = capital * (rm.maxTotalExposurePct / 100);
  sizeTWD = Math.min(sizeTWD, maxExposure - currentExposure, state.available);
  
  return { sizeTWD: Math.round(sizeTWD), stopPct: effectiveStopPct };
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

    // Update peak PnL
    if (!pos.peakPnl || pnlPct > pos.peakPnl) pos.peakPnl = pnlPct;

    // --- STOP LOSS ---
    const stopPct = pos.stopPct || PARAMS.stopLossPct;
    if (pnlPct <= -stopPct) {
      toClose.push({ pos, reason: 'STOP_LOSS', pnlPct, pnlTWD });
      continue;
    }

    // --- TRAILING STOP (啟動後) ---
    if (pnlPct >= PARAMS.trailingActivatePct) {
      const drawdown = pos.peakPnl - pnlPct;
      if (drawdown >= PARAMS.trailingStopPct) {
        toClose.push({ pos, reason: 'TRAILING_STOP', pnlPct, pnlTWD });
        continue;
      }
    }

    // --- TIME-BASED EXIT ---
    // 快進快出：持倉超過4小時且利潤 < 0.3%，釋放資金找更好機會
    const holdHours = (Date.now() - new Date(pos.openTime).getTime()) / 3600000;
    if (holdHours > (PARAMS.timeExitHours || 4) && pnlPct < 0.3 && pnlPct > -0.5) {
      toClose.push({ pos, reason: 'TIME_EXIT', pnlPct, pnlTWD });
      continue;
    }

    // --- TAKE PROFIT at high levels ---
    if (pnlPct >= PARAMS.takeProfitPct * 2) {
      toClose.push({ pos, reason: 'TAKE_PROFIT_STRONG', pnlPct, pnlTWD });
      continue;
    }
  }

  state.unrealizedPnl = Math.round(totalUnrealized * 100) / 100;
  return toClose;
}

// ========== MAIN ENGINE ==========
async function run() {
  const state = loadState();
  const now = new Date();

  // Check time window
  const startTime = new Date(PARAMS.startTime);
  const endTime = new Date(PARAMS.endTime);
  
  if (now < startTime) {
    console.log('⏳ 尚未開始');
    return;
  }
  
  if (now > endTime) {
    // 到期：平掉所有倉位
    console.log('⏰ 48小時到期！平倉所有持倉...');
    // Force close all remaining
    const tickers = await fetchAllTickers();
    for (const pos of [...state.positions]) {
      const ticker = tickers.find(t => t.market === pos.market);
      if (!ticker) continue;
      const currentPrice = parseFloat(ticker.last);
      const pnlPct = pos.direction === 'BUY'
        ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
        : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
      const pnlTWD = pos.sizeTWD * (pnlPct / 100);
      closeTrade(state, pos, 'TIME_EXPIRED', pnlPct, pnlTWD, now);
    }
    saveState(state);
    await updateDashboard(state);
    appendLog({ event: 'SIM_ENDED', capital: state.capital, pnl: state.realizedPnl });
    console.log(`🏁 最終結果：本金 NT$${state.capital.toFixed(2)} | 已實現損益 NT$${state.realizedPnl.toFixed(2)} | 報酬率 ${((state.capital - PARAMS.initialCapital) / PARAMS.initialCapital * 100).toFixed(2)}%`);
    return;
  }

  // Check pause
  if (state.pausedUntil && now < new Date(state.pausedUntil)) {
    console.log(`⏸️ 暫停中，到 ${state.pausedUntil}`);
    await updateDashboard(state);
    return;
  }
  
  // Cooldown
  if (state.lastLossTime) {
    const cooldownEnd = new Date(new Date(state.lastLossTime).getTime() + PARAMS.cooldownMinutes * 60000);
    if (now < cooldownEnd) {
      console.log(`❄️ 冷卻中，到 ${cooldownEnd.toISOString()}`);
      await updateDashboard(state);
      return;
    }
  }

  // Fetch tickers
  const tickers = await fetchAllTickers();
  if (tickers.length === 0) {
    console.log('⚠️ 無法取得行情');
    return;
  }

  // 1. Manage existing positions
  const toClose = managePositions(state, tickers);
  for (const { pos, reason, pnlPct, pnlTWD } of toClose) {
    closeTrade(state, pos, reason, pnlPct, pnlTWD, now);
  }

  // 2. Look for new opportunities
  if (state.positions.length < PARAMS.maxConcurrentPositions) {
    const currentExposure = state.positions.reduce((sum, p) => sum + p.sizeTWD, 0);
    const maxExposure = state.capital * (PARAMS.maxTotalExposurePct / 100);
    const heldMarkets = state.positions.map(p => p.market);

    // Analyze all markets and rank by confidence
    // Primary pairs (BTC/ETH) get priority + larger position sizing
    const opportunities = [];
    
    for (const m of PARAMS.watchlist) {
      // 允許同市場不同方向持倉（實驗模式），但同方向不重複
      const existingPos = state.positions.filter(p => p.market === m);
      if (!PARAMS.allowSameMarketPositions && existingPos.length > 0) continue;
      if (existingPos.length >= 2) continue; // 同幣最多2筆
      
      const [candles_daily, candles_4h, candles_1h, candles_15m] = await Promise.all([
        getCandles(m, 1440, 60),
        getCandles(m, 240, 60),
        getCandles(m, 60, 100),
        getCandles(m, 15, 100)
      ]);
      
      let analysis = fullAnalysis(candles_daily, candles_4h, candles_1h, candles_15m);
      if (!analysis) continue;
      
      // OpenAI 輔助分析（用 gpt-4o-mini，省錢）
      analysis = await openAIAnalysis(m, analysis);
      
      const isPrimary = PARAMS.primary.includes(m);
      // Primary pairs (BTC/ETH): 門檻很低，瘋狂試
      // Secondary: 稍高，但也積極
      const threshold = isPrimary ? 0.32 : 0.48;
      if (analysis.confidence >= threshold) {
        opportunities.push({ market: m, analysis, isPrimary });
      }
    }

    // Sort: primary first, then by confidence
    opportunities.sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1;
      return b.analysis.confidence - a.analysis.confidence;
    });

    for (const opp of opportunities) {
      if (state.positions.length >= PARAMS.maxConcurrentPositions) break;
      if (currentExposure >= maxExposure) break;
      if (state.available < 500) break;

      const { market, analysis, isPrimary } = opp;
      const { sizeTWD: rawSize, stopPct } = calcPositionSize(state, analysis.confidence, analysis.atr, analysis.currentPrice);
      // Primary pairs get up to 1.3x position, secondary capped at 0.7x
      const sizeTWD = Math.round(isPrimary ? rawSize * 1.3 : rawSize * 0.7);
      if (sizeTWD < 500) continue;

      const newPos = {
        market,
        direction: analysis.direction,
        entryPrice: analysis.currentPrice,
        sizeTWD,
        stopPct,
        strategy: analysis.signals.slice(0, 4).join('+'),
        strategyType: analysis.strategyType,
        signals: analysis.signals,
        confidence: analysis.confidence,
        dailyTrend: analysis.details.dailyTrend,
        rsi_15m: Math.round(analysis.details.rsi_15m * 10) / 10,
        rsi_1h: Math.round(analysis.details.rsi_1h * 10) / 10,
        openTime: now.toISOString(),
        peakPnl: 0
      };

      state.positions.push(newPos);
      state.available -= sizeTWD;

      appendLog({ event: 'OPEN', ...newPos });
      console.log(`🚀 開倉 ${analysis.direction} ${market} @ ${analysis.currentPrice} | 信心: ${(analysis.confidence * 100).toFixed(0)}% | 倉位: NT$${sizeTWD} | 止損: ${stopPct.toFixed(1)}% | ${analysis.signals.slice(0, 3).join(', ')}`);
    }
  }

  saveState(state);
  await updateDashboard(state);
  
  const elapsedH = ((now - startTime) / 3600000).toFixed(1);
  const remainH = ((endTime - now) / 3600000).toFixed(1);
  const returnPct = ((state.capital - PARAMS.initialCapital) / PARAMS.initialCapital * 100).toFixed(2);
  console.log(`💰 資本: NT$${state.capital.toFixed(2)} | 未實現: NT$${state.unrealizedPnl.toFixed(2)} | 持倉: ${state.positions.length} | 勝率: ${state.totalTrades > 0 ? ((state.wins / state.totalTrades) * 100).toFixed(1) : '--'}% | 報酬: ${returnPct}% | 剩餘: ${remainH}h`);
}

// ========== HELPERS ==========
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

function closeTrade(state, pos, reason, pnlPct, pnlTWD, now) {
  state.available += pos.sizeTWD + pnlTWD;
  state.capital += pnlTWD;
  state.realizedPnl += pnlTWD;
  state.totalTrades++;

  if (pnlTWD >= 0) {
    state.wins++;
    state.consecutiveLosses = 0;
  } else {
    state.losses++;
    state.consecutiveLosses++;
    state.lastLossTime = now.toISOString();
    if (state.consecutiveLosses >= PARAMS.maxConsecutiveLosses) {
      state.pausedUntil = new Date(now.getTime() + PARAMS.pauseHours * 3600000).toISOString();
      appendLog({ event: 'PAUSED', reason: `${state.consecutiveLosses} consecutive losses`, until: state.pausedUntil });
    }
  }

  if (state.capital > state.peakCapital) state.peakCapital = state.capital;
  const dd = ((state.peakCapital - state.capital) / state.peakCapital) * 100;
  if (dd > state.maxDrawdown) state.maxDrawdown = dd;

  // Strategy stats
  const strat = pos.strategy || 'unknown';
  if (!state.strategyStats[strat]) state.strategyStats[strat] = { wins: 0, losses: 0, pnl: 0 };
  state.strategyStats[strat].pnl += pnlTWD;
  if (pnlTWD >= 0) state.strategyStats[strat].wins++;
  else state.strategyStats[strat].losses++;

  const closedTrade = {
    market: pos.market,
    direction: pos.direction,
    entryPrice: pos.entryPrice,
    exitPrice: pos.currentPrice,
    sizeTWD: pos.sizeTWD,
    pnlTWD: Math.round(pnlTWD * 100) / 100,
    pnlPct: Math.round(pnlPct * 100) / 100,
    reason,
    strategy: pos.strategy,
    signals: pos.signals,
    confidence: pos.confidence,
    openTime: pos.openTime,
    closeTime: now.toISOString(),
    outcome: pnlTWD >= 0 ? 'WIN' : 'LOSS'
  };
  state.closedTrades.push(closedTrade);
  if (state.closedTrades.length > 100) state.closedTrades = state.closedTrades.slice(-100);

  appendLog({ event: 'CLOSE', ...closedTrade });
  state.positions = state.positions.filter(p => p !== pos);
  console.log(`📍 平倉 ${pos.direction} ${pos.market} | ${reason} | PnL: NT$${pnlTWD.toFixed(2)} (${pnlPct.toFixed(2)}%)`);
}

// ========== DASHBOARD ==========
async function updateDashboard(state) {
  try {
    let dashData = {};
    if (fs.existsSync(DASHBOARD_FILE)) {
      dashData = JSON.parse(fs.readFileSync(DASHBOARD_FILE, 'utf8'));
    }

    const now = new Date();
    const startTime = new Date(PARAMS.startTime);
    const endTime = new Date(PARAMS.endTime);
    const elapsed = ((now - startTime) / 3600000).toFixed(1);
    const remaining = Math.max(0, (endTime - now) / 3600000).toFixed(1);

    dashData.simulation = {
      enabled: true,
      version: 2,
      status: now > endTime ? 'ENDED' : (state.pausedUntil && now < new Date(state.pausedUntil)) ? 'PAUSED' : 'RUNNING',
      initialCapital: PARAMS.initialCapital,
      currentCapital: Math.round(state.capital * 100) / 100,
      available: Math.round(state.available * 100) / 100,
      realizedPnl: Math.round(state.realizedPnl * 100) / 100,
      unrealizedPnl: state.unrealizedPnl || 0,
      returnPct: Math.round(((state.capital - PARAMS.initialCapital) / PARAMS.initialCapital) * 10000) / 100,
      totalTrades: state.totalTrades,
      wins: state.wins,
      losses: state.losses,
      winRate: state.totalTrades > 0 ? ((state.wins / state.totalTrades) * 100).toFixed(1) + '%' : '--',
      maxDrawdown: Math.round(state.maxDrawdown * 100) / 100,
      positions: state.positions.map(p => ({
        market: p.market,
        direction: p.direction,
        entryPrice: p.entryPrice,
        currentPrice: p.currentPrice || p.entryPrice,
        sizeTWD: p.sizeTWD,
        pnlPct: Math.round((p.pnlPct || 0) * 100) / 100,
        pnlTWD: Math.round((p.pnlTWD || 0) * 100) / 100,
        strategy: p.strategy,
        confidence: p.confidence,
        dailyTrend: p.dailyTrend,
        openTime: p.openTime
      })),
      closedTrades: state.closedTrades.slice(-20),
      strategyStats: state.strategyStats,
      consecutiveLosses: state.consecutiveLosses,
      pausedUntil: state.pausedUntil,
      hoursElapsed: elapsed,
      hoursRemaining: remaining,
      startTime: PARAMS.startTime,
      endTime: PARAMS.endTime,
      lastUpdate: now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
    };

    fs.writeFileSync(DASHBOARD_FILE, JSON.stringify(dashData, null, 2));
  } catch (e) {
    console.error('Dashboard error:', e.message);
  }
}

// ========== 復盤與學習系統 ==========
function reviewAndLearn(state) {
  const REVIEW_FILE = path.join(__dirname, 'crypto_review.json');
  let review = { lastReviewAt: 0, lessons: [], adjustments: [] };
  if (fs.existsSync(REVIEW_FILE)) review = JSON.parse(fs.readFileSync(REVIEW_FILE, 'utf8'));
  
  // 每 N 筆交易觸發復盤
  if (state.totalTrades <= review.lastReviewAt) return;
  if ((state.totalTrades - review.lastReviewAt) < (PARAMS.reviewEveryNTrades || 5)) return;
  
  const recent = state.closedTrades.slice(-10);
  if (recent.length === 0) return;
  
  // 分析近期表現
  const wins = recent.filter(t => t.outcome === 'WIN');
  const losses = recent.filter(t => t.outcome === 'LOSS');
  const winRate = recent.length > 0 ? (wins.length / recent.length * 100).toFixed(1) : 0;
  const avgWin = wins.length > 0 ? wins.reduce((s,t) => s + t.pnlPct, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s,t) => s + Math.abs(t.pnlPct), 0) / losses.length : 0;
  const profitFactor = avgLoss > 0 ? (avgWin * wins.length) / (avgLoss * losses.length) : 999;
  
  // 策略表現分析（by signal combo）
  const stratPerf = {};
  for (const t of recent) {
    const key = t.strategy || 'unknown';
    if (!stratPerf[key]) stratPerf[key] = { wins: 0, losses: 0, pnl: 0 };
    stratPerf[key].pnl += t.pnlTWD;
    if (t.outcome === 'WIN') stratPerf[key].wins++; else stratPerf[key].losses++;
  }
  
  // 策略類型表現（trend_follow / mean_revert / breakout / scalp）
  const typePerf = {};
  for (const t of recent) {
    const key = t.strategyType || 'unknown';
    if (!typePerf[key]) typePerf[key] = { wins: 0, losses: 0, pnl: 0, avgHold: 0, trades: [] };
    typePerf[key].pnl += t.pnlTWD;
    if (t.outcome === 'WIN') typePerf[key].wins++; else typePerf[key].losses++;
    const holdH = t.openTime && t.closeTime ? ((new Date(t.closeTime) - new Date(t.openTime)) / 3600000) : 0;
    typePerf[key].trades.push(holdH);
  }
  for (const [k, v] of Object.entries(typePerf)) {
    v.avgHold = v.trades.length > 0 ? (v.trades.reduce((a,b)=>a+b,0) / v.trades.length).toFixed(1) + 'h' : '-';
    delete v.trades;
  }
  
  // 按出場原因分析
  const exitReasons = {};
  for (const t of recent) {
    if (!exitReasons[t.reason]) exitReasons[t.reason] = { count: 0, pnl: 0 };
    exitReasons[t.reason].count++;
    exitReasons[t.reason].pnl += t.pnlTWD;
  }
  
  // 按市場分析
  const marketPerf = {};
  for (const t of recent) {
    if (!marketPerf[t.market]) marketPerf[t.market] = { wins: 0, losses: 0, pnl: 0 };
    marketPerf[t.market].pnl += t.pnlTWD;
    if (t.outcome === 'WIN') marketPerf[t.market].wins++; else marketPerf[t.market].losses++;
  }
  
  const lesson = {
    reviewAt: state.totalTrades,
    timestamp: new Date().toISOString(),
    recentTrades: recent.length,
    winRate: parseFloat(winRate),
    avgWinPct: Math.round(avgWin * 100) / 100,
    avgLossPct: Math.round(avgLoss * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    capitalAtReview: state.capital,
    returnPct: Math.round(((state.capital - PARAMS.initialCapital) / PARAMS.initialCapital) * 10000) / 100,
    strategyPerformance: stratPerf,
    strategyTypePerformance: typePerf,
    exitReasons,
    marketPerformance: marketPerf,
    // 自動歸納教訓
    insights: generateInsights(winRate, avgWin, avgLoss, profitFactor, exitReasons, marketPerf, stratPerf)
  };
  
  review.lessons.push(lesson);
  if (review.lessons.length > 20) review.lessons = review.lessons.slice(-20);
  review.lastReviewAt = state.totalTrades;
  
  fs.writeFileSync(REVIEW_FILE, JSON.stringify(review, null, 2));
  console.log(`📊 復盤 #${review.lessons.length} | 近${recent.length}筆勝率: ${winRate}% | 盈虧比: ${profitFactor.toFixed(2)} | 報酬: ${lesson.returnPct}%`);
  
  for (const insight of lesson.insights) {
    console.log(`  💡 ${insight}`);
  }
}

function generateInsights(winRate, avgWin, avgLoss, profitFactor, exitReasons, marketPerf, stratPerf) {
  const insights = [];
  
  if (parseFloat(winRate) < 40) {
    insights.push('勝率偏低(<40%)，考慮提高進場門檻或等更好的信號確認');
  }
  if (parseFloat(winRate) > 65) {
    insights.push('勝率優秀(>65%)，可考慮加大倉位');
  }
  if (profitFactor < 1) {
    insights.push('盈虧比<1，虧損大於獲利，需檢視止損/止盈設定');
  }
  if (profitFactor > 2) {
    insights.push('盈虧比優秀(>2)，策略方向正確');
  }
  if (avgLoss > avgWin * 1.5) {
    insights.push('平均虧損遠大於平均獲利，止損太寬或止盈太早');
  }
  
  // Exit reason analysis
  if (exitReasons['STOP_LOSS'] && exitReasons['STOP_LOSS'].count > 3) {
    insights.push('止損觸發頻繁，可能進場時機不夠精準');
  }
  if (exitReasons['TIME_EXIT'] && exitReasons['TIME_EXIT'].count > 3) {
    insights.push('時間止損頻繁，市場可能處於盤整，降低交易頻率');
  }
  
  // Market analysis
  for (const [market, perf] of Object.entries(marketPerf)) {
    if (perf.pnl < -100) insights.push(`${market}表現差(虧${Math.abs(perf.pnl).toFixed(0)})，暫時減少該市場交易`);
    if (perf.pnl > 100) insights.push(`${market}表現佳(賺${perf.pnl.toFixed(0)})，可加大該市場倉位`);
  }
  
  if (insights.length === 0) insights.push('表現穩定，維持當前策略');
  return insights;
}

run().then(() => {
  // 每次運行後檢查是否需要復盤
  try {
    const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    reviewAndLearn(state);
  } catch(e) {}
}).catch(e => {
  console.error('❌ Engine error:', e.message);
  appendLog({ event: 'ERROR', error: e.message });
});
