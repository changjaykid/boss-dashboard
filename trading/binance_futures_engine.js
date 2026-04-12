#!/usr/bin/env node
/**
 * Binance USDT-M Futures 核心決策引擎 v3
 * 
 * 重構原則：
 * 1. 只留 2 個策略：TREND_FOLLOW + MOMENTUM
 * 2. 信號強度評分 ≥ 70 才進場（「不做」的能力）
 * 3. 風報比 ≥ 2.0（不夠肥不做）
 * 4. 每天最多 3 筆
 * 5. 時段聚焦：亞洲盤 + 美洲盤開盤
 * 6. 盤整不開新倉
 * 7. 小帳戶優化：止損收窄、盡量掛 limit
 * 
 * 資金：$464 USDT | 槓桿：5x 固定 | 標的：BTCUSDT
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

// ============ Config ============

const TRADING_DIR = __dirname;
const STATE_FILE = path.join(TRADING_DIR, 'binance_futures_state.json');
const LOG_FILE = path.join(TRADING_DIR, 'binance_futures_log.json');
const CRON_LOG = path.join(TRADING_DIR, 'binance_futures_cron.log');
const DASHBOARD_FILE = path.join(TRADING_DIR, '..', 'boss-dashboard', 'crypto-futures-data.json');
const CONFIG_FILE = path.join(TRADING_DIR, 'binance_futures_config.json');

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

const SYMBOL = 'BTCUSDT';
const LEVERAGE = 5;                           // 回到 5x，先保本再放大利潤
const MARGIN_TYPE = 'ISOLATED';
const INITIAL_CAPITAL = 464;

// === 風控鐵律 ===
const MAX_LOSS_PER_TRADE_PCT = 0.02;     // 單筆最大虧損 2%
const DAILY_LOSS_LIMIT_PCT = 0.05;        // 日虧上限 5%
const DAILY_LOSS_LIMIT = INITIAL_CAPITAL * DAILY_LOSS_LIMIT_PCT;
const MAX_DAILY_TRADES = 3;               // 每天最多 3 筆
const CONSECUTIVE_LOSS_PAUSE = 3;         // 連虧 3 筆暫停 1 小時
const PAUSE_DURATION_MS = 60 * 60 * 1000;
const SL_ATR_MULT = 1.2;                      // 抓高低點，但停損不能太寬
const SIGNAL_THRESHOLD = 45;                 // 進場更嚴格，避免亂追
const MAX_POSITION_PCT = 0.12;               // 小帳戶降倉位，先求穩
const COOLDOWN_MS = 30 * 60 * 1000;          // v3.1: 平倉後冷卻 30 分鐘
const REVERSAL_RSI_LONG = 38;
const REVERSAL_RSI_SHORT = 62;

// === 時段定義 (UTC) ===
const ACTIVE_SESSIONS = [
  { name: 'ASIA_PEAK', start: 1, end: 4 },    // 09:00-12:00 台灣
  { name: 'US_OPEN', start: 13, end: 17 },     // 21:00-01:00 台灣
];
const DEAD_ZONE = { start: 19, end: 23 };       // 03:00-07:00 台灣

// ============ Logging ============

function log(msg) {
  const ts = new Date().toISOString();
  fs.appendFileSync(CRON_LOG, `[${ts}] ${msg}\n`);
}

// ============ API ============

function sign(qs) {
  return crypto.createHmac('sha256', config.secretKey).update(qs).digest('hex');
}

function apiRequest(method, endpoint, params = {}, signed = true) {
  return new Promise((resolve, reject) => {
    let qs = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    if (signed) {
      if (qs) qs += '&';
      qs += `timestamp=${Date.now()}`;
      qs += `&signature=${sign(qs)}`;
    }
    const url = (method === 'GET' || method === 'DELETE') && qs ? `${endpoint}?${qs}` : endpoint;
    const urlObj = new URL(url, config.baseUrl || 'https://fapi.binance.com');
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: {
        'X-MBX-APIKEY': config.apiKey,
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.code && parsed.code < 0) reject(new Error(`API ${parsed.code}: ${parsed.msg}`));
          else resolve(parsed);
        } catch {
          reject(new Error(`API response parse error (status ${res.statusCode}): ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    if (method !== 'GET' && method !== 'DELETE') req.write(qs);
    req.end();
  });
}

async function getBalance() {
  const data = await apiRequest('GET', '/fapi/v2/balance');
  const usdt = data.find(b => b.asset === 'USDT');
  return usdt ? {
    total: parseFloat(usdt.balance),
    available: parseFloat(usdt.availableBalance),
    unrealizedPnl: parseFloat(usdt.crossUnPnl)
  } : { total: 0, available: 0, unrealizedPnl: 0 };
}

async function getLivePosition() {
  const data = await apiRequest('GET', '/fapi/v2/positionRisk', { symbol: SYMBOL });
  const pos = data.find(p => parseFloat(p.positionAmt) !== 0);
  if (!pos) return null;
  return {
    side: parseFloat(pos.positionAmt) > 0 ? 'LONG' : 'SHORT',
    size: Math.abs(parseFloat(pos.positionAmt)),
    entryPrice: parseFloat(pos.entryPrice),
    markPrice: parseFloat(pos.markPrice),
    unrealizedPnl: parseFloat(pos.unRealizedProfit),
    leverage: parseInt(pos.leverage),
    liquidationPrice: parseFloat(pos.liquidationPrice)
  };
}

async function openPosition(side, quantity, stopLossPrice) {
  // Market order
  const order = await apiRequest('POST', '/fapi/v1/order', {
    symbol: SYMBOL,
    side: side === 'LONG' ? 'BUY' : 'SELL',
    type: 'MARKET',
    quantity: quantity.toString()
  });

  // Set stop loss
  if (stopLossPrice) {
    try {
      await apiRequest('POST', '/fapi/v1/order', {
        symbol: SYMBOL,
        side: side === 'LONG' ? 'SELL' : 'BUY',
        type: 'STOP_MARKET',
        stopPrice: stopLossPrice.toFixed(1),
        closePosition: 'true',
        workingType: 'MARK_PRICE'
      });
    } catch (e) {
      log(`⚠️ SL order failed: ${e.message}`);
    }
  }
  return order;
}

async function closePosition() {
  const pos = await getLivePosition();
  if (!pos) return null;
  // Cancel open orders first
  try { await apiRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol: SYMBOL }); } catch (e) { log(`⚠️ Cancel orders: ${e.message}`); }
  await new Promise(r => setTimeout(r, 500));
  const closeSide = pos.side === 'LONG' ? 'SELL' : 'BUY';
  // Try reduceOnly first
  try {
    return await apiRequest('POST', '/fapi/v1/order', {
      symbol: SYMBOL, side: closeSide, type: 'MARKET',
      quantity: pos.size.toString(), reduceOnly: 'true'
    });
  } catch (e1) {
    log(`⚠️ reduceOnly close failed: ${e1.message}, trying closePosition param`);
    // Fallback: use closePosition=true (no quantity needed)
    return await apiRequest('POST', '/fapi/v1/order', {
      symbol: SYMBOL, side: closeSide, type: 'MARKET',
      closePosition: 'true'
    });
  }
}

async function updateStopLoss(newPrice) {
  try { await apiRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol: SYMBOL }); } catch {}
  const pos = await getLivePosition();
  if (!pos) return;
  await apiRequest('POST', '/fapi/v1/order', {
    symbol: SYMBOL,
    side: pos.side === 'LONG' ? 'SELL' : 'BUY',
    type: 'STOP_MARKET',
    stopPrice: newPrice.toFixed(1),
    closePosition: 'true',
    workingType: 'MARK_PRICE'
  });
}

// ============ Market Data ============

async function getKlines(symbol, interval, limit = 100) {
  const raw = await apiRequest('GET', '/fapi/v1/klines', { symbol, interval, limit }, false);
  return raw.map(k => ({
    openTime: k[0], open: parseFloat(k[1]), high: parseFloat(k[2]),
    low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5])
  }));
}

async function getFundingRate() {
  const premium = await apiRequest('GET', '/fapi/v1/premiumIndex', { symbol: SYMBOL }, false);
  return {
    rate: parseFloat(premium.lastFundingRate),
    markPrice: parseFloat(premium.markPrice),
    nextTime: premium.nextFundingTime
  };
}

// ============ Indicators ============

function ema(data, period) {
  const k = 2 / (period + 1);
  let e = data[0];
  const r = [e];
  for (let i = 1; i < data.length; i++) { e = data[i] * k + e * (1 - k); r.push(e); }
  return r;
}

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) avgGain += d; else avgLoss -= d;
  }
  avgGain /= period; avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function macd(closes, fast = 12, slow = 26, sig = 9) {
  if (closes.length < slow + sig) return null;
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = ef.map((v, i) => v - es[i]);
  const sl = ema(line.slice(slow - 1), sig);
  const hist = line[line.length - 1] - sl[sl.length - 1];
  const prevHist = line[line.length - 2] - sl[sl.length - 2];
  return { histogram: hist, prevHistogram: prevHist, line: line[line.length - 1], signal: sl[sl.length - 1] };
}

function bb(closes, period = 20, dev = 2) {
  if (closes.length < period) return null;
  const s = closes.slice(-period);
  const avg = s.reduce((a, b) => a + b) / period;
  const std = Math.sqrt(s.reduce((a, b) => a + (b - avg) ** 2, 0) / period);
  return { upper: avg + dev * std, middle: avg, lower: avg - dev * std, width: ((2 * dev * std) / avg) * 100 };
}

function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let a = trs.slice(0, period).reduce((s, v) => s + v) / period;
  for (let i = period; i < trs.length; i++) a = (a * (period - 1) + trs[i]) / period;
  return a;
}

function adx(candles, period = 14) {
  if (candles.length < period * 2 + 1) return null;
  const pdm = [], mdm = [], trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], p = candles[i - 1];
    const up = c.high - p.high, dn = p.low - c.low;
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const sa = ema(trs, period), sp = ema(pdm, period), sm = ema(mdm, period);
  const dx = sp.map((v, i) => {
    const dp = sa[i] > 0 ? v / sa[i] * 100 : 0;
    const dm = sa[i] > 0 ? sm[i] / sa[i] * 100 : 0;
    return dp + dm > 0 ? Math.abs(dp - dm) / (dp + dm) * 100 : 0;
  });
  const a = ema(dx.slice(period), period);
  return a[a.length - 1];
}

// ============ State ============

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {}
  return defaultState();
}

function defaultState() {
  return {
    status: 'RUNNING',
    position: null,
    trailingStop: null,
    dailyStats: { date: today(), trades: 0, wins: 0, losses: 0, pnl: 0, bestTrade: 0, worstTrade: 0, consecutiveLosses: 0, pauseUntil: null },
    totalStats: { trades: 0, wins: 0, losses: 0, pnl: 0, winRate: 0, maxDrawdown: 0, peakBalance: INITIAL_CAPITAL },
    tradeHistory: [],
    lastAnalysis: null,
    lastTradeTime: null,
    startTime: new Date().toISOString(),
    initialCapital: INITIAL_CAPITAL
  };
}

function saveState(s) { fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); }
function today() { return new Date().toISOString().slice(0, 10); }

// ============ Session Check ============

function isActiveSession() {
  const h = new Date().getUTCHours();
  for (const s of ACTIVE_SESSIONS) {
    if (s.start < s.end) { if (h >= s.start && h < s.end) return s.name; }
    else { if (h >= s.start || h < s.end) return s.name; }
  }
  return null;
}

function isDeadZone() {
  const h = new Date().getUTCHours();
  if (DEAD_ZONE.start < DEAD_ZONE.end) return h >= DEAD_ZONE.start && h < DEAD_ZONE.end;
  return h >= DEAD_ZONE.start || h < DEAD_ZONE.end;
}

// ============ Market State ============

function detectMarketState(candles1h, closes1h) {
  const adxVal = adx(candles1h);
  const bbVal = bb(closes1h);
  const ema8 = ema(closes1h, 8);
  const ema21 = ema(closes1h, 21);
  const e8 = ema8[ema8.length - 1];
  const e21 = ema21[ema21.length - 1];

  if (bbVal && bbVal.width < 1.5) return 'SQUEEZE';       // BB 極窄 → 即將突破
  if (bbVal && bbVal.width < 2.5 && (!adxVal || adxVal < 20)) return 'CONSOLIDATING';
  if (adxVal && adxVal > 25) return e8 > e21 ? 'TRENDING_UP' : 'TRENDING_DOWN';
  if (bbVal && bbVal.width > 4) return 'HIGH_VOLATILITY';
  return 'RANGING';
}

// ============ Signal Scoring (0-100) ============

function scoreSignals(klines15m, klines1h, klines4h, fundingData, price) {
  const c15 = klines15m.map(k => k.close);
  const c1h = klines1h.map(k => k.close);
  const c4h = klines4h.map(k => k.close);

  const marketState = detectMarketState(klines1h, c1h);

  // 太窄盤整/擠壓先不做
  if (marketState === 'CONSOLIDATING' || marketState === 'SQUEEZE') {
    return { score: 0, direction: null, strategy: null, marketState, reason: '盤整中，不開新倉' };
  }

  let buyScore = 0, sellScore = 0;
  const buyReasons = [], sellReasons = [];

  // === 4H 大趨勢 (必要條件) ===
  const ema8_4h = ema(c4h, 8), ema21_4h = ema(c4h, 21);
  const trend4h = ema8_4h[ema8_4h.length - 1] > ema21_4h[ema21_4h.length - 1] ? 'UP' : 'DOWN';

  // === 1H EMA 排列 ===
  const ema8_1h = ema(c1h, 8), ema21_1h = ema(c1h, 21), ema55_1h = ema(c1h, 55);
  const e8 = ema8_1h[ema8_1h.length - 1], e21 = ema21_1h[ema21_1h.length - 1], e55 = ema55_1h[ema55_1h.length - 1];
  const last1hClose = c1h[c1h.length - 1];
  const bb1h = bb(c1h);
  
  if (e8 > e21 && e21 > e55) { buyScore += 20; buyReasons.push('1H EMA 多排'); }
  if (e8 < e21 && e21 < e55) { sellScore += 20; sellReasons.push('1H EMA 空排'); }

  if (bb1h) {
    const bbPos1h = (last1hClose - bb1h.lower) / (bb1h.upper - bb1h.lower);
    if (bbPos1h <= 0.18) { buyScore += 18; buyReasons.push('1H靠近下緣'); }
    if (bbPos1h >= 0.82) { sellScore += 18; sellReasons.push('1H靠近上緣'); }
  }

  // === 15m RSI ===
  const rsi15 = rsi(c15);
  if (rsi15 !== null) {
    // TREND_FOLLOW: RSI 回踩 40-55 (多) 或 45-60 (空)
    if (rsi15 >= 40 && rsi15 <= 55) { buyScore += 8; buyReasons.push(`RSI回踩${rsi15.toFixed(0)}`); }
    if (rsi15 >= 45 && rsi15 <= 60) { sellScore += 8; sellReasons.push(`RSI回彈${rsi15.toFixed(0)}`); }
    // 超賣/超買 bonus
    if (rsi15 <= REVERSAL_RSI_LONG) { buyScore += 20; buyReasons.push(`低位RSI${rsi15.toFixed(0)}`); }
    if (rsi15 >= REVERSAL_RSI_SHORT) { sellScore += 20; sellReasons.push(`高位RSI${rsi15.toFixed(0)}`); }
  }

  // === 15m MACD ===
  const macd15 = macd(c15);
  if (macd15) {
    if (macd15.histogram > 0 && macd15.prevHistogram <= 0) { buyScore += 15; buyReasons.push('MACD金叉'); }
    if (macd15.histogram < 0 && macd15.prevHistogram >= 0) { sellScore += 15; sellReasons.push('MACD死叉'); }
    if (macd15.histogram > 0 && macd15.histogram > macd15.prevHistogram) { buyScore += 5; buyReasons.push('MACD柱增'); }
    if (macd15.histogram < 0 && macd15.histogram < macd15.prevHistogram) { sellScore += 5; sellReasons.push('MACD柱增'); }
  }

  // === 15m 相對位置，強化低多高空 ===
  const bb15 = bb(c15);
  if (bb15) {
    const bbPos15 = (price - bb15.lower) / (bb15.upper - bb15.lower);
    if (bbPos15 <= 0.12) { buyScore += 18; buyReasons.push('15m近下軌'); }
    else if (bbPos15 <= 0.25) { buyScore += 10; buyReasons.push('15m偏低'); }
    if (bbPos15 >= 0.88) { sellScore += 18; sellReasons.push('15m近上軌'); }
    else if (bbPos15 >= 0.75) { sellScore += 10; sellReasons.push('15m偏高'); }
  }

  // === 15m K 線型態 ===
  if (klines15m.length >= 3) {
    const last = klines15m[klines15m.length - 1];
    const prev = klines15m[klines15m.length - 2];
    const body = Math.abs(last.close - last.open);
    const range = last.high - last.low;
    
    // Pin bar
    if (range > 0) {
      const lowerWick = (Math.min(last.open, last.close) - last.low) / range;
      const upperWick = (last.high - Math.max(last.open, last.close)) / range;
      if (lowerWick > 0.6 && body / range < 0.25) { buyScore += 10; buyReasons.push('看多Pin Bar'); }
      if (upperWick > 0.6 && body / range < 0.25) { sellScore += 10; sellReasons.push('看空Pin Bar'); }
    }

    // Engulfing
    if (prev.close < prev.open && last.close > last.open && last.close > prev.open && last.open < prev.close) {
      buyScore += 12; buyReasons.push('多頭吞噬');
    }
    if (prev.close > prev.open && last.close < last.open && last.close < prev.open && last.open > prev.close) {
      sellScore += 12; sellReasons.push('空頭吞噬');
    }
  }

  // === 量能確認 ===
  if (klines15m.length >= 20) {
    const recentVol = klines15m.slice(-5).reduce((s, k) => s + k.volume, 0) / 5;
    const avgVol = klines15m.slice(-20, -5).reduce((s, k) => s + k.volume, 0) / 15;
    if (recentVol > avgVol * 1.5) {
      buyScore += 8; sellScore += 8;
      buyReasons.push('量能放大'); sellReasons.push('量能放大');
    }
    if (recentVol < avgVol * 0.3) {
      buyScore -= 3; sellScore -= 3;  // v4: 只有極度量縮才扣分，且降低懲罰
    }
  }

  // === 動量（3 根 15m 累積漲跌 > 0.5%）===
  if (klines15m.length >= 3) {
    const last3 = klines15m.slice(-3);
    const mom = (last3[2].close - last3[0].open) / last3[0].open * 100;
    if (mom > 0.5) { buyScore += 10; buyReasons.push(`動量+${mom.toFixed(2)}%`); }
    if (mom < -0.5) { sellScore += 10; sellReasons.push(`動量${mom.toFixed(2)}%`); }
  }

  // === 4H Gate: 反趨勢信號砍半 ===
  if (trend4h === 'UP') {
    buyScore += 6;
    sellScore *= 0.55;
  }
  if (trend4h === 'DOWN') {
    sellScore += 6;
    buyScore *= 0.55;
  }

  // 資金費率做輕量過濾
  if (fundingData?.rate > 0.0008) {
    sellScore += 5;
    sellReasons.push('資金費率偏熱');
  }
  if (fundingData?.rate < -0.0008) {
    buyScore += 5;
    buyReasons.push('資金費率偏冷');
  }

  // === Active session boost ===
  const session = isActiveSession();
  if (session) { buyScore *= 1.15; sellScore *= 1.15; }
  if (isDeadZone()) { buyScore *= 0.5; sellScore *= 0.5; }

  // Determine direction
  const maxScore = Math.max(buyScore, sellScore);
  const direction = buyScore > sellScore ? 'LONG' : 'SHORT';
  const reasons = direction === 'LONG' ? buyReasons : sellReasons;
  
  // Must have clear directional edge (>30% stronger)
  const minScore = Math.min(buyScore, sellScore);
  const edge = maxScore > 0 ? (maxScore - minScore) / maxScore : 0;
  if (edge < 0.25) {
    return { score: Math.round(maxScore * 0.5), direction: null, strategy: null, marketState, reason: `方向不明確 (edge=${(edge*100).toFixed(0)}%)`, buyScore, sellScore, trend4h };
  }

  // Determine strategy
  let strategy = 'TREND_FOLLOW';
  if (klines15m.length >= 3) {
    const mom = Math.abs((klines15m[klines15m.length - 1].close - klines15m[klines15m.length - 3].open) / klines15m[klines15m.length - 3].open * 100);
    if (mom > 0.5) strategy = 'MOMENTUM';
  }

  return {
    score: Math.round(maxScore),
    direction,
    strategy,
    marketState,
    trend4h,
    reasons,
    buyScore: Math.round(buyScore),
    sellScore: Math.round(sellScore),
    rsi15: rsi15 ? Math.round(rsi15) : null,
    session: session || (isDeadZone() ? 'DEAD_ZONE' : 'TRANSITION')
  };
}

// ============ Position Sizing ============

function calcPositionSize(balance, price, atrVal) {
  const margin = balance * MAX_POSITION_PCT;
  const notional = margin * LEVERAGE;
  let qty = notional / price;
  
  // v3.1: 止損距離 = 1.5 ATR
  const slDist = atrVal * SL_ATR_MULT;
  const maxLoss = balance * MAX_LOSS_PER_TRADE_PCT;
  const maxQty = maxLoss / slDist;
  
  qty = Math.min(qty, maxQty);
  qty = Math.floor(qty * 1000) / 1000;
  
  return qty >= 0.001 ? qty : 0;
}

// ============ Trailing Stop ============

function checkTrailingStop(state, markPrice) {
  if (!state.position || !state.trailingStop) return { shouldUpdate: false };
  
  const entry = state.position.entryPrice;
  const isLong = state.position.side === 'LONG';
  const pnlPct = isLong
    ? (markPrice - entry) / entry * 100
    : (entry - markPrice) / entry * 100;
  
  let newStop = state.trailingStop.currentStop;
  
  // v3.1: 漸進式追蹤，不設天花板，讓利潤跑
  // 階段 1: +0.3% → 保本
  if (pnlPct >= 0.3) {
    newStop = entry;
  }
  // 階段 2: +0.8% → 追蹤 0.5%（寬鬆跟隨）
  if (pnlPct >= 0.8) {
    const trail = isLong ? markPrice * 0.995 : markPrice * 1.005;
    const betterThanBreakeven = isLong ? trail > entry : trail < entry;
    if (betterThanBreakeven) newStop = trail;
  }
  // 階段 3: +1.5% → 追蹤 0.35%
  if (pnlPct >= 1.5) {
    const trail = isLong ? markPrice * 0.9965 : markPrice * 1.0035;
    if (isLong ? trail > newStop : trail < newStop) newStop = trail;
  }
  // 階段 4: +2.5% → 追蹤 0.25%（大賺時鎖利）
  if (pnlPct >= 2.5) {
    const trail = isLong ? markPrice * 0.9975 : markPrice * 1.0025;
    if (isLong ? trail > newStop : trail < newStop) newStop = trail;
  }
  // 階段 5: +4.0% → 追蹤 0.2%（超大波段更緊）
  if (pnlPct >= 4.0) {
    const trail = isLong ? markPrice * 0.998 : markPrice * 1.002;
    if (isLong ? trail > newStop : trail < newStop) newStop = trail;
  }
  
  const improved = isLong ? newStop > state.trailingStop.currentStop : newStop < state.trailingStop.currentStop;
  return { shouldUpdate: improved, newStop, pnlPct };
}

// ============ Position Management ============

function shouldClosePosition(state, livePos, signal) {
  if (!livePos || !state.position) return { close: false };
  
  const entry = state.position.entryPrice;
  const isLong = livePos.side === 'LONG';
  const pnlPct = isLong
    ? (livePos.markPrice - entry) / entry * 100
    : (entry - livePos.markPrice) / entry * 100;
  const holdMs = Date.now() - new Date(state.position.openTime).getTime();
  const holdHours = holdMs / 3600000;

  // 1. 強反轉信號
  const oppositeScore = isLong ? signal.sellScore : signal.buyScore;
  const sameScore = isLong ? signal.buyScore : signal.sellScore;
  if (oppositeScore >= 55 && oppositeScore > sameScore * 1.8) {
    return { close: true, reason: `強反轉信號(${oppositeScore})` };
  }

  // 2. v3.1: 持倉 > 6h + 浮虧 + 盤整 → 出場（虧損的不要耗著）
  if (holdHours > 6 && pnlPct < -0.3 && (signal.marketState === 'CONSOLIDATING' || signal.marketState === 'RANGING')) {
    return { close: true, reason: `盤整中浮虧${pnlPct.toFixed(2)}%` };
  }

  // 3. 持倉 > 3h + 無方向 → 釋放資金
  if (holdHours > 2.5 && pnlPct > -0.15 && pnlPct < 0.15) {
    return { close: true, reason: `持倉${holdHours.toFixed(0)}h無方向` };
  }

  // 4. v3.1: 有利潤的不限時間，讓追蹤停損自己處理出場
  //    不再因為「趨勢減弱」主動平倉 — 趨勢減弱會反映在價格回落觸發追蹤停損

  return { close: false, pnlPct, holdHours };
}

// ============ Dashboard ============

function updateDashboard(state, balance, pos, signal) {
  const now = new Date();
  const local = new Date(now.getTime() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 16);
  const ds = state.dailyStats;
  const ts = state.totalStats;

  const dashboard = {
    lastUpdate: local,
    status: state.status,
    mode: 'v3 精簡雙策略',
    exchange: 'Binance Futures',
    account: {
      initialCapital: INITIAL_CAPITAL, balance: balance?.total || 0,
      available: balance?.available || 0, unrealizedPnl: pos?.unrealizedPnl || 0,
      netEquity: (balance?.total || 0) + (pos?.unrealizedPnl || 0),
      todayPnl: ds.pnl, totalPnl: ts.pnl, leverage: LEVERAGE,
      totalTrades: ts.trades, winRate: ts.trades > 0 ? ((ts.wins / ts.trades) * 100).toFixed(1) + '%' : '--',
      wins: ts.wins, losses: ts.losses, maxDrawdown: ts.maxDrawdown
    },
    position: pos ? {
      symbol: SYMBOL, side: pos.side, size: pos.size,
      entryPrice: pos.entryPrice, markPrice: pos.markPrice,
      pnl: pos.unrealizedPnl, leverage: pos.leverage,
      trailingStop: state.trailingStop?.currentStop || null
    } : null,
    todayStats: { trades: ds.trades, wins: ds.wins, losses: ds.losses, pnl: ds.pnl, remaining: MAX_DAILY_TRADES - ds.trades },
    totalStats: ts,
    signals: signal ? {
      score: signal.score, direction: signal.direction, strategy: signal.strategy,
      marketState: signal.marketState, trend4h: signal.trend4h,
      session: signal.session, reasons: signal.reasons || [],
      buyScore: signal.buyScore, sellScore: signal.sellScore
    } : null,
    recentTrades: (state.tradeHistory || []).slice(-10).reverse(),
    riskStatus: {
      dailyLossUsed: `$${Math.abs(Math.min(ds.pnl, 0)).toFixed(2)} / $${DAILY_LOSS_LIMIT.toFixed(2)}`,
      dailyTradesUsed: `${ds.trades} / ${MAX_DAILY_TRADES}`,
      consecutiveLosses: `${ds.consecutiveLosses} / ${CONSECUTIVE_LOSS_PAUSE}`,
      paused: ds.pauseUntil ? new Date(ds.pauseUntil) > now : false
    }
  };

  try { fs.writeFileSync(DASHBOARD_FILE, JSON.stringify(dashboard, null, 2)); } catch (e) { log(`⚠️ Dashboard: ${e.message}`); }
}

// ============ Trade Recording ============

function recordTrade(state, pnl, strategy) {
  const ds = state.dailyStats;
  ds.trades++;
  ds.pnl += pnl;
  if (pnl > 0) {
    ds.wins++; ds.consecutiveLosses = 0;
    if (pnl > ds.bestTrade) ds.bestTrade = pnl;
  } else {
    ds.losses++; ds.consecutiveLosses++;
    if (pnl < ds.worstTrade) ds.worstTrade = pnl;
    if (ds.consecutiveLosses >= CONSECUTIVE_LOSS_PAUSE) {
      ds.pauseUntil = new Date(Date.now() + PAUSE_DURATION_MS).toISOString();
      log(`⏸️ 連虧${ds.consecutiveLosses}筆，暫停1小時`);
    }
  }

  const ts = state.totalStats;
  ts.trades++; if (pnl > 0) ts.wins++; else ts.losses++;
  ts.pnl += pnl;
  ts.winRate = ts.trades > 0 ? ts.wins / ts.trades : 0;
  const bal = INITIAL_CAPITAL + ts.pnl;
  if (bal > ts.peakBalance) ts.peakBalance = bal;
  const dd = ((ts.peakBalance - bal) / ts.peakBalance) * 100;
  if (dd > ts.maxDrawdown) ts.maxDrawdown = dd;

  state.tradeHistory = state.tradeHistory || [];
  state.tradeHistory.push({
    time: new Date().toISOString(), symbol: SYMBOL,
    side: state.position?.side || 'UNKNOWN',
    entryPrice: state.position?.entryPrice || 0,
    pnl: parseFloat(pnl.toFixed(2)), strategy,
    reasons: state.position?.reasons || []
  });
  if (state.tradeHistory.length > 100) state.tradeHistory = state.tradeHistory.slice(-100);

  // Save to log file
  try {
    const logEntries = fs.existsSync(LOG_FILE) ? JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')) : [];
    logEntries.push(state.tradeHistory[state.tradeHistory.length - 1]);
    fs.writeFileSync(LOG_FILE, JSON.stringify(logEntries, null, 2));
  } catch {}
}

// ============ Main Engine ============

async function run() {
  const startTime = Date.now();
  let state = loadState();

  // Reset daily stats if new day
  if (state.dailyStats.date !== today()) {
    log(`📅 新的一天: ${today()}`);
    state.dailyStats = { date: today(), trades: 0, wins: 0, losses: 0, pnl: 0, bestTrade: 0, worstTrade: 0, consecutiveLosses: 0, pauseUntil: null };
  }

  // Check pause
  if (state.dailyStats.pauseUntil && new Date(state.dailyStats.pauseUntil) > new Date()) {
    log(`⏸️ 暫停中至 ${state.dailyStats.pauseUntil}`);
    saveState(state);
    return;
  }

  // Check daily loss limit
  if (state.dailyStats.pnl <= -DAILY_LOSS_LIMIT) {
    log(`🛑 日虧上限 $${DAILY_LOSS_LIMIT.toFixed(0)} 已達，今日停機`);
    state.status = 'DAILY_LIMIT';
    saveState(state);
    return;
  }

  try {
    // Set leverage & margin type
    try { await apiRequest('POST', '/fapi/v1/leverage', { symbol: SYMBOL, leverage: LEVERAGE }); } catch {}
    try { await apiRequest('POST', '/fapi/v1/marginType', { symbol: SYMBOL, marginType: MARGIN_TYPE }); } catch {}

    // Fetch data
    const [klines15m, klines1h, klines4h, funding, balance, livePos] = await Promise.all([
      getKlines(SYMBOL, '15m', 100),
      getKlines(SYMBOL, '1h', 100),
      getKlines(SYMBOL, '4h', 50),
      getFundingRate(),
      getBalance(),
      getLivePosition()
    ]);

    const price = klines15m[klines15m.length - 1].close;
    const atrVal = atr(klines15m) || price * 0.005;
    const signal = scoreSignals(klines15m, klines1h, klines4h, funding, price);

    state.lastAnalysis = { time: new Date().toISOString(), price, marketState: signal.marketState, score: signal.score, direction: signal.direction };

    // ====== HAS POSITION ======
    if (livePos) {
      if (!state.position) {
        state.position = { side: livePos.side, entryPrice: livePos.entryPrice, size: livePos.size, openTime: new Date().toISOString(), strategy: 'UNKNOWN', reasons: [] };
      }

      const pnlPct = livePos.side === 'LONG'
        ? (livePos.markPrice - livePos.entryPrice) / livePos.entryPrice * 100
        : (livePos.entryPrice - livePos.markPrice) / livePos.entryPrice * 100;
      
      log(`📊 ${livePos.side} ${livePos.size} @ ${livePos.entryPrice} | PnL: $${livePos.unrealizedPnl.toFixed(2)} (${pnlPct.toFixed(2)}%) | Market: ${signal.marketState} | Score: ${signal.score}`);

      // Trailing stop
      const ts = checkTrailingStop(state, livePos.markPrice);
      if (ts.shouldUpdate) {
        try {
          await updateStopLoss(ts.newStop);
          state.trailingStop.currentStop = ts.newStop;
          log(`🔄 Trailing stop → ${ts.newStop.toFixed(1)} (PnL ${ts.pnlPct.toFixed(2)}%)`);
        } catch (e) { log(`⚠️ SL update failed: ${e.message}`); }
      }

      // Check close conditions
      const closeCheck = shouldClosePosition(state, livePos, signal);
      if (closeCheck.close) {
        log(`🔄 平倉: ${closeCheck.reason}`);
        try {
          await closePosition();
          recordTrade(state, livePos.unrealizedPnl, state.position.strategy);
          log(`✅ 平倉完成 PnL: $${livePos.unrealizedPnl.toFixed(2)}`);
          state.position = null;
          state.trailingStop = null;
        } catch (e) { log(`❌ 平倉失敗: ${e.message}`); }
      }
    }
    // ====== NO POSITION — LOOK FOR ENTRY ======
    else {
      state.position = null;
      state.trailingStop = null;

      // Check daily trade limit
      if (state.dailyStats.trades >= MAX_DAILY_TRADES) {
        log(`⏭️ 今日已達 ${MAX_DAILY_TRADES} 筆上限`);
      }
      // Signal threshold check
      else if (signal.score < SIGNAL_THRESHOLD) {
        log(`⏭️ 信號不足 ${signal.score}/${SIGNAL_THRESHOLD} | Market: ${signal.marketState} | ${signal.reason || ''}`);
      }
      // No direction
      else if (!signal.direction) {
        log(`⏭️ 無明確方向 | Buy: ${signal.buyScore} | Sell: ${signal.sellScore}`);
      }
      // Cooldown check
      else if (state.lastTradeTime && (Date.now() - new Date(state.lastTradeTime).getTime()) < COOLDOWN_MS) {
        const coolLeft = Math.round((COOLDOWN_MS - (Date.now() - new Date(state.lastTradeTime).getTime())) / 60000);
        log(`🧊 冷卻中，${coolLeft}分鐘後可進場`);
      }
      // GO!
      else {
        const qty = calcPositionSize(balance.available, price, atrVal);
        if (qty <= 0) {
          log(`⏭️ 倉位太小或餘額不足`);
        } else {
          // v3.1: 停損 = 1.5 ATR
          const slDist = atrVal * SL_ATR_MULT;
          const sl = signal.direction === 'LONG' ? price - slDist : price + slDist;
          
          // v3.1: 不設固定停利，用追蹤停損讓利潤跑
          log(`🎯 進場! ${signal.direction} ${qty} BTC @ ~${price.toFixed(0)} | SL: ${sl.toFixed(0)} (-${(slDist/price*100).toFixed(2)}%) | TP: 追蹤(不設上限) | Score: ${signal.score} | ${signal.strategy} | ${(signal.reasons || []).join(', ')}`);

          try {
            const order = await openPosition(signal.direction, qty, sl);
            state.position = {
              side: signal.direction, entryPrice: price, size: qty,
              openTime: new Date().toISOString(), strategy: signal.strategy,
              stopLoss: sl, takeProfit: null, reasons: signal.reasons || []
            };
            state.trailingStop = { initialStop: sl, currentStop: sl, lastUpdate: new Date().toISOString() };
            state.lastTradeTime = new Date().toISOString();
            log(`✅ 下單成功 orderId: ${order.orderId}`);
          } catch (e) {
            log(`❌ 下單失敗: ${e.message}`);
          }
        }
      }
    }

    // Check if position was closed externally (by SL)
    if (state.position && !livePos) {
      try {
        const trades = await apiRequest('GET', '/fapi/v1/userTrades', { symbol: SYMBOL, limit: 5 });
        const recentPnl = trades
          .filter(t => new Date(t.time) > new Date(state.position.openTime))
          .reduce((s, t) => s + parseFloat(t.realizedPnl), 0);
        if (recentPnl !== 0) {
          recordTrade(state, recentPnl, state.position.strategy);
          log(`📊 SL/TP 觸發 PnL: $${recentPnl.toFixed(2)}`);
        }
      } catch {}
      state.position = null;
      state.trailingStop = null;
    }

    state.status = 'RUNNING';
    saveState(state);
    updateDashboard(state, balance, livePos, signal);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`✅ Cycle ${elapsed}s | $${balance.total.toFixed(2)} | BTC $${price.toFixed(0)} | Score: ${signal.score} ${signal.direction || '-'}`);

  } catch (e) {
    log(`❌ Engine error: ${e.message}`);
    state.status = 'ERROR';
    saveState(state);
    updateDashboard(state, null, null, null);
  }
}

run().catch(e => { log(`💥 Fatal: ${e.message}`); process.exit(1); });
