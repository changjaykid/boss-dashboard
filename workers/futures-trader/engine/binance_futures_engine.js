#!/usr/bin/env node
/**
 * Binance USDT-M Futures 核心決策引擎 v8 「賺大虧小」
 * 
 * 核心哲學：
 * 1. 用 1H/4H K 線做決策，抓 1-3% 波段，不做毛利
 * 2. 每天最多 3 筆，只在最確定的信號出手
 * 3. 集中火力：單筆倉位 40% margin，讓每筆賺的夠多
 * 4. 手續費佔比 < 15%，每筆淨賺 $5+
 * 5. 停損約 $3-5，風報比 1:2.5+
 * 6. 目標：本金最大化
 * 
 * 資金：~$437 USDT | 槓桿：5x 固定 | 標的：BTC
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

// ============ Config ============

const WORKER_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(WORKER_DIR, 'data');
// Per-symbol file paths (set dynamically)
let STATE_FILE = path.join(DATA_DIR, 'binance_futures_state.json');
let LOG_FILE = path.join(DATA_DIR, 'binance_futures_log.json');
let CRON_LOG = path.join(DATA_DIR, 'binance_futures_cron.log');
const DASHBOARD_FILE = path.join(WORKER_DIR, 'dashboard.json');

function setSymbolPaths(sym) {
  SYMBOL = sym;
  STATE_FILE = path.join(DATA_DIR, `binance_futures_state_${sym}.json`);
  LOG_FILE = path.join(DATA_DIR, `binance_futures_log_${sym}.json`);
  CRON_LOG = path.join(DATA_DIR, `binance_futures_cron_${sym}.log`);
  // Migrate: if old single-symbol state exists and sym is BTCUSDT, use it
  if (sym === 'BTCUSDT') {
    const oldState = path.join(DATA_DIR, 'binance_futures_state.json');
    if (fs.existsSync(oldState) && !fs.existsSync(STATE_FILE)) {
      try { fs.copyFileSync(oldState, STATE_FILE); } catch(_) { log(`⚠️ ${_.message}`); }
    }
  }
}
const CONFIG_FILE = path.join(DATA_DIR, 'binance_futures_config.json');

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

// === 多幣種支援 ===
// Updated 2026-04-07 from Binance /fapi/v1/exchangeInfo
const MARKET_PARAMS = {
  BTCUSDT:  { minQty: 0.001, stepSize: 0.001, pricePrecision: 2 },
  ETHUSDT:  { minQty: 0.001, stepSize: 0.001, pricePrecision: 2 },
  SOLUSDT:  { minQty: 0.01,  stepSize: 0.01,  pricePrecision: 4 },
  DOGEUSDT: { minQty: 1,     stepSize: 1,     pricePrecision: 6 },
  XRPUSDT:  { minQty: 0.1,   stepSize: 0.1,   pricePrecision: 4 },
  BNBUSDT:  { minQty: 0.01,  stepSize: 0.01,  pricePrecision: 3 },
  LINKUSDT: { minQty: 0.01,  stepSize: 0.01,  pricePrecision: 3 },
  AVAXUSDT: { minQty: 1,     stepSize: 1,     pricePrecision: 4 },
  ARBUSDT:  { minQty: 0.1,   stepSize: 0.1,   pricePrecision: 6 },
  DOTUSDT:  { minQty: 0.1,   stepSize: 0.1,   pricePrecision: 3 },
};
const DEFAULT_MARKETS = ['BTCUSDT'];  // v8: 主做 BTC，停用 ETH
const ACTIVE_MARKETS_FILE = path.join(DATA_DIR, 'active_futures_markets.json');
let ALL_MARKETS = DEFAULT_MARKETS;
try {
  const am = JSON.parse(fs.readFileSync(ACTIVE_MARKETS_FILE, 'utf8'));
  // v6: 停用動態換幣，只做 BTC + ETH
  // if (am.allMarkets && am.allMarkets.length >= 2) ALL_MARKETS = am.allMarkets;
} catch(_) { log(`⚠️ ${_.message}`); }
const inputSymbol = process.argv[2];
const SYMBOLS_TO_RUN = inputSymbol ? [inputSymbol] : ALL_MARKETS;

let SYMBOL = SYMBOLS_TO_RUN[0]; // Will be set per-iteration
const LEVERAGE = 5;              // v8: 5x（降槓桿 = 降爆倉風險，拉高容錯空間）
const MARGIN_TYPE = 'ISOLATED';
const INITIAL_CAPITAL = 464;

// === 風控鐵律 v8 ===
const MAX_LOSS_PER_TRADE_PCT = 0.015;     // v8: 單筆最大虧損 1.5%（~$6.5）
const DAILY_LOSS_LIMIT_PCT = 0.04;        // v8: 日虧上限 4%（~$17）
const DAILY_LOSS_LIMIT = INITIAL_CAPITAL * DAILY_LOSS_LIMIT_PCT;
const MAX_DAILY_TRADES = 10;              // v8: 每天最多 10 筆，做完復盤自己調整
const CONSECUTIVE_LOSS_PAUSE = 2;         // v8: 連虧 2 筆就停，今天不做了
const PAUSE_DURATION_MS = 4 * 60 * 60 * 1000;  // v8: 暫停 4 小時
const SL_ATR_MULT = 1.5;                     // v8: 停損 1.5x 1H ATR（用 1H 不是 15m）
const MIN_RR_RATIO = 2.5;                    // v8: 風報比 1:2.5，賺大虧小的核心
const MIN_PROFIT_USD = 5.0;                  // v8: 每筆至少賺 $5（手續費 ~$0.87，佔 17%）
const SIGNAL_THRESHOLD = 40;              // v8: 門檻拉高，只做最確定的
const MAX_POSITION_PCT = 0.40;            // v8: 單筆 40% margin 集中火力（5x * 40% = 2x 曝險）
const COOLDOWN_MS = 60 * 60 * 1000;          // v8: 平倉後冷卻 1 小時（反正一天只做 3 筆）

// === 時段定義 (UTC) ===
const ACTIVE_SESSIONS = [
  { name: 'ASIA_PEAK', start: 1, end: 4 },    // 09:00-12:00 台灣
  { name: 'US_OPEN', start: 13, end: 17 },     // 21:00-01:00 台灣
];
const DEAD_ZONE = { start: 19, end: 23 };       // 03:00-07:00 台灣

// ============ Logging ============

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  fs.appendFileSync(CRON_LOG, line + '\n');
  console.log(line);  // v6.1: 同時輸出到 stdout，讓 cron agent 看得到
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

// Helper: get quantity decimal precision from stepSize
function qtyPrecision(sym) {
  const mp = MARKET_PARAMS[sym || SYMBOL] || { stepSize: 0.001 };
  const s = mp.stepSize.toString();
  const dot = s.indexOf('.');
  return dot === -1 ? 0 : s.length - dot - 1;
}

// Helper: format price to pricePrecision
function fmtPrice(price, sym) {
  const mp = MARKET_PARAMS[sym || SYMBOL] || { pricePrecision: 1 };
  return price.toFixed(mp.pricePrecision);
}

async function openPosition(side, quantity, stopLossPrice) {
  const mp = MARKET_PARAMS[SYMBOL] || { stepSize: 0.001, pricePrecision: 1 };
  const prec = qtyPrecision();
  const qtyStr = (Math.floor(quantity / mp.stepSize) * mp.stepSize).toFixed(prec);
  // Market order
  const order = await apiRequest('POST', '/fapi/v1/order', {
    symbol: SYMBOL,
    side: side === 'LONG' ? 'BUY' : 'SELL',
    type: 'MARKET',
    quantity: qtyStr
  });

  // Set stop loss via Algo Order API (Binance migrated STOP_MARKET to algoOrder)
  if (stopLossPrice) {
    try {
      await apiRequest('POST', '/fapi/v1/algoOrder', {
        symbol: SYMBOL,
        side: side === 'LONG' ? 'SELL' : 'BUY',
        algoType: 'CONDITIONAL',
        type: 'STOP_MARKET',
        triggerPrice: fmtPrice(stopLossPrice),
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
  // Cancel open regular orders first
  try { await apiRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol: SYMBOL }); } catch (e) { log(`⚠️ Cancel regular orders: ${e.message}`); }
  // Cancel open algo orders (SL/TP) too
  try { await apiRequest('DELETE', '/fapi/v1/algoOpenOrders', { symbol: SYMBOL }); } catch (e) { log(`⚠️ Cancel algo orders: ${e.message}`); }
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
  // Cancel existing regular orders
  try { await apiRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol: SYMBOL }); } catch(e) { log(`⚠️ ${e.message}`); }
  // Cancel existing algo orders (SL/TP)
  try { await apiRequest('DELETE', '/fapi/v1/algoOpenOrders', { symbol: SYMBOL }); } catch(e) { log(`⚠️ ${e.message}`); }
  await new Promise(r => setTimeout(r, 300));
  const pos = await getLivePosition();
  if (!pos) return;
  // Place new SL via Algo Order API
  await apiRequest('POST', '/fapi/v1/algoOrder', {
    symbol: SYMBOL,
    side: pos.side === 'LONG' ? 'SELL' : 'BUY',
    algoType: 'CONDITIONAL',
    type: 'STOP_MARKET',
    triggerPrice: fmtPrice(newPrice),
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

// ============ Additional Indicators ============

function stochRsi(closes, rsiPeriod = 14, stochPeriod = 14, kSmooth = 3, dSmooth = 3) {
  const rsiArr = [];
  if (closes.length < rsiPeriod + stochPeriod + kSmooth) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= rsiPeriod; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / rsiPeriod, al = losses / rsiPeriod;
  for (let i = rsiPeriod; i < closes.length; i++) {
    if (i > rsiPeriod) {
      const d = closes[i] - closes[i - 1];
      ag = (ag * (rsiPeriod - 1) + (d > 0 ? d : 0)) / rsiPeriod;
      al = (al * (rsiPeriod - 1) + (d < 0 ? -d : 0)) / rsiPeriod;
    }
    rsiArr.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  if (rsiArr.length < stochPeriod) return null;
  const rawK = [];
  for (let i = stochPeriod - 1; i < rsiArr.length; i++) {
    const slice = rsiArr.slice(i - stochPeriod + 1, i + 1);
    const hi = Math.max(...slice), lo = Math.min(...slice);
    rawK.push(hi === lo ? 50 : (rsiArr[i] - lo) / (hi - lo) * 100);
  }
  const kLine = sma(rawK, kSmooth);
  const dLine = sma(kLine, dSmooth);
  if (!kLine.length || !dLine.length) return null;
  return { k: kLine[kLine.length - 1], d: dLine[dLine.length - 1], prevK: kLine.length > 1 ? kLine[kLine.length - 2] : null, prevD: dLine.length > 1 ? dLine[dLine.length - 2] : null };
}

function sma(data, period) {
  if (data.length < period) return [];
  const result = [];
  for (let i = period - 1; i < data.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += data[i - j];
    result.push(sum / period);
  }
  return result;
}

function vwap(candles) {
  if (!candles.length) return null;
  let cumTPV = 0, cumVol = 0;
  for (const c of candles) {
    const tp = (c.high + c.low + c.close) / 3;
    cumTPV += tp * c.volume;
    cumVol += c.volume;
  }
  return cumVol > 0 ? cumTPV / cumVol : null;
}

function bbOnRsi(closes, rsiPeriod = 14, bbPeriod = 20, bbDev = 2) {
  // Bollinger Bands applied to RSI values
  const rsiArr = [];
  if (closes.length < rsiPeriod + bbPeriod) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= rsiPeriod; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses -= d;
  }
  let ag = gains / rsiPeriod, al = losses / rsiPeriod;
  for (let i = rsiPeriod; i < closes.length; i++) {
    if (i > rsiPeriod) {
      const d = closes[i] - closes[i - 1];
      ag = (ag * (rsiPeriod - 1) + (d > 0 ? d : 0)) / rsiPeriod;
      al = (al * (rsiPeriod - 1) + (d < 0 ? -d : 0)) / rsiPeriod;
    }
    rsiArr.push(al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  }
  if (rsiArr.length < bbPeriod) return null;
  const slice = rsiArr.slice(-bbPeriod);
  const mean = slice.reduce((a, b) => a + b, 0) / bbPeriod;
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / bbPeriod);
  const currentRsi = rsiArr[rsiArr.length - 1];
  const prevRsi = rsiArr[rsiArr.length - 2];
  return { rsi: currentRsi, prevRsi, upper: mean + bbDev * std, lower: mean - bbDev * std, middle: mean };
}

function getSessionRange(candles15m) {
  // Get Asian session range (UTC 0-7) from 15m candles
  const asianCandles = candles15m.filter(c => {
    const h = new Date(c.openTime || c.time).getUTCHours();
    return h >= 0 && h < 7;
  });
  if (asianCandles.length < 4) return null;
  const high = Math.max(...asianCandles.map(c => c.high));
  const low = Math.min(...asianCandles.map(c => c.low));
  return { high, low, range: high - low, midpoint: (high + low) / 2 };
}

// ============ State ============

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch(e) { log(`⚠️ ${e.message}`); }
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
function today() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10); }

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

// ============ Support / Resistance Detection ============

function findSupportResistance(klines1h, klines15m, price) {
  // 用 1H K 線找近期高低點作為支撐壓力
  const highs = klines1h.slice(-48).map(k => k.high);  // 48H
  const lows = klines1h.slice(-48).map(k => k.low);
  
  // 找 pivot highs (局部最高點) 和 pivot lows (局部最低點)
  const resistances = [], supports = [];
  for (let i = 2; i < highs.length - 2; i++) {
    if (highs[i] > highs[i-1] && highs[i] > highs[i-2] && highs[i] > highs[i+1] && highs[i] > highs[i+2]) {
      resistances.push(highs[i]);
    }
  }
  for (let i = 2; i < lows.length - 2; i++) {
    if (lows[i] < lows[i-1] && lows[i] < lows[i-2] && lows[i] < lows[i+1] && lows[i] < lows[i+2]) {
      supports.push(lows[i]);
    }
  }
  
  // BB 中軌作為動態支撐/壓力
  const c1h = klines1h.map(k => k.close);
  const bbVal = bb(c1h);
  
  // 近期最高/最低（作為突破基準）
  const recentHigh = Math.max(...klines1h.slice(-24).map(k => k.high));
  const recentLow = Math.min(...klines1h.slice(-24).map(k => k.low));
  
  return { supports, resistances, bb: bbVal, recentHigh, recentLow };
}

function priceNearLevel(price, level, tolerancePct) {
  return Math.abs(price - level) / price * 100 <= tolerancePct;
}

function isNearSupport(price, sr) {
  for (const s of sr.supports) {
    if (priceNearLevel(price, s, 0.3) && price >= s * 0.997) return true;
  }
  if (sr.bb && priceNearLevel(price, sr.bb.lower, 0.3)) return true;
  return false;
}

function isNearResistance(price, sr) {
  for (const r of sr.resistances) {
    if (priceNearLevel(price, r, 0.3) && price <= r * 1.003) return true;
  }
  if (sr.bb && priceNearLevel(price, sr.bb.upper, 0.3)) return true;
  return false;
}

function isBreakoutUp(price, sr, klines15m) {
  // 突破近24H最高 + 最近3根K線收盤都在高點之上 = 真突破
  if (price <= sr.recentHigh) return false;
  const last3 = klines15m.slice(-3);
  return last3.every(k => k.close > sr.recentHigh);
}

function isBreakoutDown(price, sr, klines15m) {
  if (price >= sr.recentLow) return false;
  const last3 = klines15m.slice(-3);
  return last3.every(k => k.close < sr.recentLow);
}

// ============ Signal Scoring (0-100) ============

function scoreSignals(klines15m, klines1h, klines4h, fundingData, price, oiChange, atrVal) {
  const c15 = klines15m.map(k => k.close);
  const c1h = klines1h.map(k => k.close);
  const c4h = klines4h.map(k => k.close);

  const marketState = detectMarketState(klines1h, c1h);

  // v8: 支撐壓力偵測
  const sr = findSupportResistance(klines1h, klines15m, price);
  const nearSupport = isNearSupport(price, sr);
  const nearResistance = isNearResistance(price, sr);
  const breakoutUp = isBreakoutUp(price, sr, klines15m);
  const breakoutDown = isBreakoutDown(price, sr, klines15m);

  let buyScore = 0, sellScore = 0;
  const buyReasons = [], sellReasons = [];

  // ========== 策略核心：用大時間維度做決策 ==========

  // === 4H 大趨勢（重要性最高）===
  const ema8_4h = ema(c4h, 8), ema21_4h = ema(c4h, 21);
  const e8_4h = ema8_4h[ema8_4h.length - 1], e21_4h = ema21_4h[ema21_4h.length - 1];
  const trend4h = e8_4h > e21_4h ? 'UP' : 'DOWN';
  const trend4hStrength = Math.abs(e8_4h - e21_4h) / e21_4h * 100;
  // 4H 趨勢明確才給大分
  if (trend4hStrength > 0.3) {
    if (trend4h === 'UP') { buyScore += 25; buyReasons.push(`4H多頭(${trend4hStrength.toFixed(2)}%)`); }
    if (trend4h === 'DOWN') { sellScore += 25; sellReasons.push(`4H空頭(${trend4hStrength.toFixed(2)}%)`); }
  }

  // === 4H MACD 確認趨勢動能 ===
  const macd4h = macd(c4h);
  if (macd4h) {
    if (macd4h.histogram > 0 && macd4h.histogram > macd4h.prevHistogram) { buyScore += 15; buyReasons.push('4H MACD加速↑'); }
    if (macd4h.histogram < 0 && macd4h.histogram < macd4h.prevHistogram) { sellScore += 15; sellReasons.push('4H MACD加速↓'); }
    // 4H MACD 金叉/死叉 = 強信號
    if (macd4h.histogram > 0 && macd4h.prevHistogram <= 0) { buyScore += 20; buyReasons.push('4H MACD金叉'); }
    if (macd4h.histogram < 0 && macd4h.prevHistogram >= 0) { sellScore += 20; sellReasons.push('4H MACD死叉'); }
  }

  // === 1H EMA 排列（確認中期方向）===
  const ema8_1h = ema(c1h, 8), ema21_1h = ema(c1h, 21), ema55_1h = ema(c1h, 55);
  const e8 = ema8_1h[ema8_1h.length - 1], e21 = ema21_1h[ema21_1h.length - 1], e55 = ema55_1h[ema55_1h.length - 1];
  if (e8 > e21 && e21 > e55) { buyScore += 15; buyReasons.push('1H EMA多排'); }
  if (e8 < e21 && e21 < e55) { sellScore += 15; sellReasons.push('1H EMA空排'); }

  // === 1H RSI（用 1H 不用 15m，避免噪音）===
  const rsi1h = rsi(c1h);
  if (rsi1h !== null) {
    // 趨勢回踩進場
    if (rsi1h >= 40 && rsi1h <= 55 && trend4h === 'UP') { buyScore += 12; buyReasons.push(`1H RSI回踩${rsi1h.toFixed(0)}`); }
    if (rsi1h >= 45 && rsi1h <= 60 && trend4h === 'DOWN') { sellScore += 12; sellReasons.push(`1H RSI回彈${rsi1h.toFixed(0)}`); }
    // 極端超賣超買
    if (rsi1h < 30) { buyScore += 18; buyReasons.push(`1H RSI超賣${rsi1h.toFixed(0)}`); }
    if (rsi1h > 70) { sellScore += 18; sellReasons.push(`1H RSI超買${rsi1h.toFixed(0)}`); }
  }

  // === 1H MACD 確認 ===
  const macd1h = macd(c1h);
  if (macd1h) {
    if (macd1h.histogram > 0 && macd1h.prevHistogram <= 0) { buyScore += 12; buyReasons.push('1H MACD金叉'); }
    if (macd1h.histogram < 0 && macd1h.prevHistogram >= 0) { sellScore += 12; sellReasons.push('1H MACD死叉'); }
  }

  // === 1H K線型態（用 1H 不用 15m）===
  if (klines1h.length >= 3) {
    const last = klines1h[klines1h.length - 1];
    const prev = klines1h[klines1h.length - 2];
    const body = Math.abs(last.close - last.open);
    const range = last.high - last.low;
    if (range > 0) {
      const lowerWick = (Math.min(last.open, last.close) - last.low) / range;
      const upperWick = (last.high - Math.max(last.open, last.close)) / range;
      if (lowerWick > 0.6 && body / range < 0.25) { buyScore += 10; buyReasons.push('1H看多Pin Bar'); }
      if (upperWick > 0.6 && body / range < 0.25) { sellScore += 10; sellReasons.push('1H看空Pin Bar'); }
    }
    // 吞噬
    if (prev.close < prev.open && last.close > last.open && last.close > prev.open && last.open < prev.close) {
      buyScore += 12; buyReasons.push('1H多頭吞噬');
    }
    if (prev.close > prev.open && last.close < last.open && last.close < prev.open && last.open > prev.close) {
      sellScore += 12; sellReasons.push('1H空頭吞噬');
    }
  }

  // === 1H 量能確認 ===
  if (klines1h.length >= 20) {
    const recentVol = klines1h.slice(-3).reduce((s, k) => s + k.volume, 0) / 3;
    const avgVol = klines1h.slice(-20, -3).reduce((s, k) => s + k.volume, 0) / 17;
    if (recentVol > avgVol * 1.8) {
      buyScore += 10; sellScore += 10;
      buyReasons.push('1H量能爆發'); sellReasons.push('1H量能爆發');
    }
  }

  // === 突破信號（最肥的行情）===
  if (breakoutUp) { buyScore += 20; buyReasons.push(`突破${sr.recentHigh.toFixed(1)}`); }
  if (breakoutDown) { sellScore += 20; sellReasons.push(`跌破${sr.recentLow.toFixed(1)}`); }
  // 支撐壓力回踩
  if (nearSupport && !breakoutDown && trend4h === 'UP') { buyScore += 15; buyReasons.push('支撐區回踩做多'); }
  if (nearResistance && !breakoutUp && trend4h === 'DOWN') { sellScore += 15; sellReasons.push('壓力區回踩做空'); }
  // SQUEEZE 突破 bonus
  if (marketState === 'SQUEEZE' && (breakoutUp || breakoutDown)) {
    buyScore *= 1.4; sellScore *= 1.4;
    if (breakoutUp) buyReasons.push('SQUEEZE突破↑');
    if (breakoutDown) sellReasons.push('SQUEEZE突破↓');
  }

  // === 防追價：反方向位置扣分 ===
  if (nearResistance && !breakoutUp) { buyScore *= 0.3; buyReasons.push('⚠️壓力區不追多'); }
  if (nearSupport && !breakoutDown) { sellScore *= 0.3; sellReasons.push('⚠️支撐區不追空'); }

  // === 4H 門筛：逆趨勢打 3 折 ===
  if (trend4h === 'UP') sellScore *= 0.3;
  if (trend4h === 'DOWN') buyScore *= 0.3;

  // === 資金費率 ===
  if (fundingData) {
    let fRate = null;
    if (typeof fundingData === 'number') fRate = fundingData;
    else if (typeof fundingData === 'object' && !Array.isArray(fundingData) && typeof fundingData.rate === 'number') fRate = fundingData.rate;
    else if (Array.isArray(fundingData) && fundingData.length > 0) {
      const last = fundingData[fundingData.length - 1];
      fRate = typeof last === 'number' ? last : (typeof last.rate === 'number' ? last.rate : parseFloat(last.lastFundingRate || last.fundingRate || 0));
    }
    if (fRate !== null && !isNaN(fRate)) {
      if (fRate > 0.0005) { sellScore += 10; sellReasons.push('費率極高做空'); }
      if (fRate < -0.0003) { buyScore += 10; buyReasons.push('負費率做多'); }
    }
  }

  // === OI（持倉量）變化 ===
  if (typeof oiChange === 'number' && !isNaN(oiChange)) {
    if (oiChange > 5 && trend4h === 'UP') { buyScore += 8; buyReasons.push('OI增+多頭'); }
    if (oiChange > 5 && trend4h === 'DOWN') { sellScore += 8; sellReasons.push('OI增+空頭'); }
  }

  // === 盤整懲罰（沒突破的盤整打折，但不歸零）===
  const isConsolidating = (marketState === 'CONSOLIDATING' || marketState === 'RANGING');
  if (isConsolidating && !breakoutUp && !breakoutDown) {
    buyScore *= 0.5; sellScore *= 0.5;
  }

  // === 活躍時段 boost ===
  const session = isActiveSession();
  if (session) { buyScore *= 1.2; sellScore *= 1.2; }
  if (isDeadZone()) { buyScore *= 0.4; sellScore *= 0.4; }

  // Determine direction
  const maxScore = Math.max(buyScore, sellScore);
  const direction = buyScore > sellScore ? 'LONG' : 'SHORT';
  const reasons = direction === 'LONG' ? buyReasons : sellReasons;
  
  // v8: 方向必須有 40% 以上優勢才做
  const minScore = Math.min(buyScore, sellScore);
  const edge = maxScore > 0 ? (maxScore - minScore) / maxScore : 0;
  const rsi15 = rsi(c15); // 保留 15m RSI 做參考
  if (edge < 0.40) {
    return { score: Math.round(maxScore * 0.5), direction: null, strategy: null, marketState, reason: `方向不明確(edge=${(edge*100).toFixed(0)}%)`, buyScore: Math.round(buyScore), sellScore: Math.round(sellScore), trend4h, reasons: [...buyReasons.map(r => `🟢${r}`), ...sellReasons.map(r => `🔴${r}`)], rsi15: rsi15 ? Math.round(rsi15) : null };
  }

  // Determine strategy
  let strategy = 'TREND_FOLLOW';
  const allReasons = reasons.join(',');
  if (allReasons.includes('SQUEEZE突破')) strategy = 'SQUEEZE_BREAKOUT';
  else if (allReasons.includes('突破') || allReasons.includes('跌破')) strategy = 'BREAKOUT';
  else if (allReasons.includes('回踩') || allReasons.includes('回彈')) strategy = 'PULLBACK';
  else if (allReasons.includes('超賣') || allReasons.includes('超買')) strategy = 'EXTREME_RSI';
  else strategy = 'TREND_FOLLOW';

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

// ============ 第二套策略：動量突破（Momentum Breakout）============
// 跟 v8 Pullback 互補：v8 等回踩，這套追突破
// 只在 v8 主信號不觸發時才檢查

function scoreMomentumBreakout(klines15m, klines1h, klines4h, price) {
  const c1h = klines1h.map(k => k.close);
  const c4h = klines4h.map(k => k.close);
  
  const ema8_4h = ema(c4h, 8), ema21_4h = ema(c4h, 21);
  const trend4h = ema8_4h[ema8_4h.length - 1] > ema21_4h[ema21_4h.length - 1] ? 'UP' : 'DOWN';
  
  let score = 0;
  let direction = null;
  const reasons = [];
  
  // 條件 1：1H 大量突破（量是平均 2 倍以上）
  if (klines1h.length < 25) return null;
  const lastCandle = klines1h[klines1h.length - 1];
  const avgVol = klines1h.slice(-25, -1).reduce((s, k) => s + k.volume, 0) / 24;
  const volRatio = lastCandle.volume / avgVol;
  if (volRatio < 1.8) return null; // 量不夠大，不是突破
  
  // 條件 2：1H 實體大 K 線（body > 70% of range）
  const body = Math.abs(lastCandle.close - lastCandle.open);
  const range = lastCandle.high - lastCandle.low;
  if (range === 0 || body / range < 0.6) return null;
  
  // 條件 3：方向要跟 4H 趨勢一致
  const isBullish = lastCandle.close > lastCandle.open;
  if (isBullish && trend4h !== 'UP') return null;
  if (!isBullish && trend4h !== 'DOWN') return null;
  
  // 條件 4：突破近期高/低
  const recent24h = klines1h.slice(-25, -1);
  const recentHigh = Math.max(...recent24h.map(k => k.high));
  const recentLow = Math.min(...recent24h.map(k => k.low));
  
  if (isBullish && lastCandle.close > recentHigh) {
    direction = 'LONG';
    score = 50;
    reasons.push(`1H爆量突破↑(vol=${volRatio.toFixed(1)}x)`);
    reasons.push(`突破24H高${recentHigh.toFixed(1)}`);
  } else if (!isBullish && lastCandle.close < recentLow) {
    direction = 'SHORT';
    score = 50;
    reasons.push(`1H爆量突破↓(vol=${volRatio.toFixed(1)}x)`);
    reasons.push(`跌破24H低${recentLow.toFixed(1)}`);
  } else {
    return null; // 有量但沒突破
  }
  
  // 加分：MACD 確認
  const macd1h = macd(c1h);
  if (macd1h) {
    if (direction === 'LONG' && macd1h.histogram > 0) { score += 10; reasons.push('MACD多確認'); }
    if (direction === 'SHORT' && macd1h.histogram < 0) { score += 10; reasons.push('MACD空確認'); }
  }
  
  // 加分：ADX > 25（趨勢有力）
  const adxVal = adx(klines1h);
  if (adxVal && adxVal > 25) { score += 10; reasons.push(`ADX=${adxVal.toFixed(0)}`); }
  
  return { score, direction, strategy: 'MOMENTUM_BREAKOUT', reasons, trend4h,
    marketState: 'BREAKOUT', buyScore: direction === 'LONG' ? score : 0,
    sellScore: direction === 'SHORT' ? score : 0 };
}

// ============ Position Sizing ============

function calcPositionSize(balance, price, atrVal1h) {
  const mp = MARKET_PARAMS[SYMBOL] || { minQty: 0.001, stepSize: 0.001 };
  // v8: 集中火力，不分幣種平分（同時只會有 1 個持倉）
  const margin = balance * MAX_POSITION_PCT;
  const notional = margin * LEVERAGE;
  let qty = notional / price;
  
  // v8: 用 1H ATR 算停損
  const slDist = atrVal1h * SL_ATR_MULT;
  const maxLoss = balance * MAX_LOSS_PER_TRADE_PCT;
  const maxQty = maxLoss / slDist;
  
  qty = Math.min(qty, maxQty);
  qty = Math.floor(qty / mp.stepSize) * mp.stepSize;
  
  return qty >= mp.minQty ? qty : 0;
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
  
  // v6.2: 放寬追蹤止損，給利潤充足空間（之前太緊一直被掃）
  // v8: 「賺大虧小」追蹤止損
  // 原則：先保本，再鎖利，最後讓利潤跑
  // 階段 1: +0.8% → 保本（確保不讓賺的單變虧）
  if (pnlPct >= 0.8) {
    newStop = entry;
  }
  // 階段 2: +1.5% → 鎖住 +0.5%（小賺入袋）
  if (pnlPct >= 1.5) {
    const lockPrice = isLong ? entry * 1.005 : entry * 0.995;
    if (isLong ? lockPrice > newStop : lockPrice < newStop) newStop = lockPrice;
  }
  // 階段 3: +2.5% → 追蹤 1.0%（給空間跑，抓大波段）
  if (pnlPct >= 2.5) {
    const trail = isLong ? markPrice * 0.990 : markPrice * 1.010;
    if (isLong ? trail > newStop : trail < newStop) newStop = trail;
  }
  // 階段 4: +4.0% → 追蹤 0.6%（收緊保護）
  if (pnlPct >= 4.0) {
    const trail = isLong ? markPrice * 0.994 : markPrice * 1.006;
    if (isLong ? trail > newStop : trail < newStop) newStop = trail;
  }
  // 階段 5: +6.0% → 追蹤 0.4%（大波段收緊）
  if (pnlPct >= 6.0) {
    const trail = isLong ? markPrice * 0.996 : markPrice * 1.004;
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
  if (oppositeScore >= 60 && oppositeScore > sameScore * 2) {
    return { close: true, reason: `強反轉信號(${oppositeScore})` };
  }

  // 2. v8: 浮虧超過 4h 就砍（賺大虧小 = 虧的快砂）
  if (holdHours > 4 && pnlPct < -0.3) {
    return { close: true, reason: `虧損${pnlPct.toFixed(2)}%持${holdHours.toFixed(0)}h快砂` };
  }

  // 3. v8: 持倉 > 8h + 完全無動 → 釋放資金（但不要太早砍正在跑的單）
  if (holdHours > 8 && Math.abs(pnlPct) < 0.3) {
    return { close: true, reason: `持倉${holdHours.toFixed(0)}h無動釋放資金` };
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
    mode: 'v8 賺大虧小',
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
  } catch(e) { log(`⚠️ ${e.message}`); }
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
    try { await apiRequest('POST', '/fapi/v1/leverage', { symbol: SYMBOL, leverage: LEVERAGE }); } catch(e) { log(`⚠️ ${e.message}`); }
    try { await apiRequest('POST', '/fapi/v1/marginType', { symbol: SYMBOL, marginType: MARGIN_TYPE }); } catch(e) { log(`⚠️ ${e.message}`); }

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
    // v8: 用 1H ATR 做停損和倉位計算（不是 15m）
    const atrVal = atr(klines1h) || price * 0.01;
    // === OI 變化計算 ===
    let oiChange = null;
    try {
      const oiData = await apiRequest('GET', '/fapi/v1/openInterest', { symbol: SYMBOL }, false);
      const currentOI = parseFloat(oiData.openInterest);
      if (currentOI > 0) {
        const oiKey = `lastOI_${SYMBOL}`;
        const prevOI = state[oiKey] || 0;
        if (prevOI > 0) {
          oiChange = ((currentOI - prevOI) / prevOI) * 100;
        }
        state[oiKey] = currentOI;
      }
    } catch (e) { log(`⚠️ OI fetch: ${e.message}`); }

    const signal = scoreSignals(klines15m, klines1h, klines4h, funding, price, oiChange, atrVal);

    state.lastAnalysis = {
      time: new Date().toISOString(), price,
      marketState: signal.marketState, score: signal.score, direction: signal.direction,
      trend4h: signal.trend4h, buyScore: signal.buyScore || 0, sellScore: signal.sellScore || 0,
      reasons: signal.reasons || [], strategy: signal.strategy, rsi15: signal.rsi15,
      session: signal.session
    };

    // ====== HAS POSITION ======
    if (livePos) {
      if (!state.position) {
        state.position = { side: livePos.side, entryPrice: livePos.entryPrice, size: livePos.size, openTime: new Date().toISOString(), strategy: 'UNKNOWN', reasons: [] };
      }
      // Auto-initialize trailing stop if missing
      if (!state.trailingStop && state.position) {
        const slDist = atrVal * SL_ATR_MULT;
        const initSL = state.position.side === 'LONG'
          ? state.position.entryPrice - slDist
          : state.position.entryPrice + slDist;
        state.trailingStop = { initialStop: initSL, currentStop: initSL, lastUpdate: new Date().toISOString() };
        log(`🔧 Auto-init trailing stop @ ${initSL.toFixed(1)} for existing position`);
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
    // ====== NO POSITION ======
    else {
      // Detect externally closed position (by SL/TP on exchange)
      if (state.position) {
        log(`🔍 偵測到持倉消失，查詢平倉紀錄...`);
        try {
          const trades = await apiRequest('GET', '/fapi/v1/userTrades', { symbol: SYMBOL, limit: 10 });
          const openTime = state.position.openTime || state.lastTradeTime || new Date(Date.now() - 24*60*60*1000).toISOString();
          const recentTrades = trades.filter(t => new Date(t.time) > new Date(openTime) && parseFloat(t.realizedPnl) !== 0);
          const recentPnl = recentTrades.reduce((s, t) => s + parseFloat(t.realizedPnl), 0);
          if (recentPnl !== 0) {
            recordTrade(state, recentPnl, state.position.strategy);
            log(`📊 SL/TP 觸發 PnL: $${recentPnl.toFixed(2)} (${recentTrades.length} trades since ${openTime})`);
          } else {
            log(`📊 持倉已消失，無已實現損益 (checked ${trades.length} trades, openTime: ${openTime})`);
          }
        } catch (e) { log(`⚠️ 查詢平倉紀錄失敗: ${e.message}`); }
        state.position = null;
        state.trailingStop = null;
      }

      // v8: 先檢查主信號，不夠就嘗試動量突破
      if ((signal.score < SIGNAL_THRESHOLD || !signal.direction) && state.dailyStats.trades < MAX_DAILY_TRADES) {
        const mbSignal = scoreMomentumBreakout(klines15m, klines1h, klines4h, price);
        if (mbSignal && mbSignal.score >= 50 && mbSignal.direction) {
          log(`🔥 動量突破信號! ${mbSignal.direction} | Score: ${mbSignal.score} | ${mbSignal.reasons.join(', ')}`);
          signal.score = mbSignal.score;
          signal.direction = mbSignal.direction;
          signal.strategy = mbSignal.strategy;
          signal.reasons = mbSignal.reasons;
          signal.buyScore = mbSignal.buyScore;
          signal.sellScore = mbSignal.sellScore;
          signal.trend4h = mbSignal.trend4h;
          signal.marketState = mbSignal.marketState;
        }
      }

      // 決策樹
      if (state.dailyStats.trades >= MAX_DAILY_TRADES) {
        log(`⏭️ 今日已達 ${MAX_DAILY_TRADES} 筆上限`);
      }
      else if (signal.score < SIGNAL_THRESHOLD || !signal.direction) {
        if (!signal.direction) {
          log(`⏭️ 無明確方向 | Buy: ${signal.buyScore} | Sell: ${signal.sellScore}`);
        } else {
          log(`⏭️ 信號不足 ${signal.score}/${SIGNAL_THRESHOLD} | Market: ${signal.marketState} | ${signal.reason || ''}`);
        }
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
          // v8: 停損 = 1.5x 1H ATR，最少 0.5%、最多 1.5%
          const minSlDist = price * 0.005; // 最少 0.5%
          const maxSlDist = price * 0.015; // 最多 1.5%（控制每筆虧損）
          const slDist = Math.min(Math.max(atrVal * SL_ATR_MULT, minSlDist), maxSlDist);
          const sl = signal.direction === 'LONG' ? price - slDist : price + slDist;
          
          // v5: 風報比檢查 — 預期利潤必須 >= 2倍風險，且 >= $1.5
          const riskPerUnit = slDist;
          const expectedReward = riskPerUnit * MIN_RR_RATIO;
          const expectedProfitUsd = expectedReward * qty;
          const riskUsd = riskPerUnit * qty;
          
          if (expectedProfitUsd < MIN_PROFIT_USD) {
            log(`⏭️ 預期利潤 $${expectedProfitUsd.toFixed(2)} < $${MIN_PROFIT_USD}，不值得做（風險 $${riskUsd.toFixed(2)}）`);
          } else {
          
          log(`🎯 進場! ${signal.direction} ${qty} ${SYMBOL} @ ~${price.toFixed(1)} | SL: ${fmtPrice(sl)} (-$${riskUsd.toFixed(2)}) | 最低目標: +$${expectedProfitUsd.toFixed(2)} (RR 1:${MIN_RR_RATIO}) | Score: ${signal.score} | ${signal.strategy} | ${(signal.reasons || []).join(', ')}`);

          try {
            const order = await openPosition(signal.direction, qty, sl);
            state.position = {
              symbol: SYMBOL, side: signal.direction, entryPrice: price, size: qty,
              openTime: new Date().toISOString(), strategy: signal.strategy,
              stopLoss: sl, takeProfit: null, reasons: signal.reasons || []
            };
            state.trailingStop = { initialStop: sl, currentStop: sl, lastUpdate: new Date().toISOString() };
            state.lastTradeTime = new Date().toISOString();
            log(`✅ 下單成功 orderId: ${order.orderId}`);
          } catch (e) {
            log(`❌ 下單失敗: ${e.message}`);
          }
          } // end RR check
        }
      }
    }

    // (External closure detection moved to no-position branch above)

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

// === Multi-symbol runner ===
async function runAll() {
  // v6.1: 檢查是否有不在主列表但仍有持倉的幣種（避免持倉被遺棄）
  const symbolsToRun = [...SYMBOLS_TO_RUN];
  try {
    const accData = await apiRequest('GET', '/fapi/v2/account');
    const livePositions = (accData.positions || []).filter(p => parseFloat(p.positionAmt) !== 0);
    for (const p of livePositions) {
      if (!symbolsToRun.includes(p.symbol)) {
        symbolsToRun.push(p.symbol);
        console.log(`⚠️ ${p.symbol} 不在主列表但有持倉 ${p.positionAmt}，納入管理`);
      }
    }
  } catch(e) { /* fallback to configured list */ }

  for (const sym of symbolsToRun) {
    setSymbolPaths(sym);
    try {
      await run();
    } catch(e) {
      log(`💥 ${sym} Fatal: ${e.message}`);
    }
    if (symbolsToRun.length > 1) await new Promise(r => setTimeout(r, 1000)); // Rate limit between symbols
  }
  
  // Merge dashboard from all symbols — keep frontend-compatible format
  if (SYMBOLS_TO_RUN.length > 1) {
    try {
      const now = new Date();
      const local = new Date(now.getTime() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 16);
      const allTrades = [];
      let totalPnl = 0, totalTodayPnl = 0, totalTrades = 0, totalWins = 0, totalLosses = 0;
      let totalBalance = 0, totalUnrealized = 0, maxDD = 0;
      let activePosition = null;
      let activeSignal = null;
      let activeState = null;
      const stratWeights = {};
      const dailyTradesUsed = { trades: 0, limit: MAX_DAILY_TRADES };
      const perSymbolSignals = {};  // v6.1: 所有幣種信號

      for (const sym of SYMBOLS_TO_RUN) {
        const sf = path.join(DATA_DIR, `binance_futures_state_${sym}.json`);
        if (!fs.existsSync(sf)) continue;
        const st = JSON.parse(fs.readFileSync(sf, 'utf8'));
        const ts = st.totalStats || {};
        const ds = st.dailyStats || {};

        totalPnl += ts.pnl || 0;
        totalTodayPnl += ds.pnl || 0;
        totalTrades += ts.trades || 0;
        totalWins += ts.wins || 0;
        totalLosses += ts.losses || 0;
        if ((ts.maxDrawdown || 0) > maxDD) maxDD = ts.maxDrawdown;
        dailyTradesUsed.trades += ds.trades || 0;

        // Collect trades
        if (st.tradeHistory) allTrades.push(...st.tradeHistory);

        // Use the first active position found
        if (!activePosition && st.position) {
          activePosition = st.position;
          activeState = st;
        }
        // v6.1: 儲存每個幣種的信號
        if (!activeState && st.lastAnalysis) activeState = st;
        if (st.lastAnalysis) {
          perSymbolSignals[sym] = {
            score: st.lastAnalysis.score || 0,
            direction: st.lastAnalysis.direction,
            marketState: st.lastAnalysis.marketState,
            trend4h: st.lastAnalysis.trend4h,
            buyScore: st.lastAnalysis.buyScore || 0,
            sellScore: st.lastAnalysis.sellScore || 0,
            reasons: st.lastAnalysis.reasons || [],
            price: st.lastAnalysis.price,
            rsi15: st.lastAnalysis.rsi15,
            time: st.lastAnalysis.time
          };
        }

        // Merge strategy weights
        if (st.strategyWeights) {
          for (const [k, v] of Object.entries(st.strategyWeights)) {
            if (!stratWeights[k]) stratWeights[k] = v;
          }
        }
      }

      // Sort trades by time, take last 10
      allTrades.sort((a, b) => new Date(a.time) - new Date(b.time));
      const recentTrades = allTrades.slice(-10).reverse();

      // Try to read last balance from Binance (from any per-symbol state)
      for (const sym of SYMBOLS_TO_RUN) {
        const sf = path.join(DATA_DIR, `binance_futures_state_${sym}.json`);
        try {
          const st = JSON.parse(fs.readFileSync(sf, 'utf8'));
          if (st.lastBalance && st.lastBalance > totalBalance) totalBalance = st.lastBalance;
        } catch(_) { log(`⚠️ ${_.message}`); }
      }
      if (totalBalance === 0) totalBalance = INITIAL_CAPITAL + totalPnl;

      const merged = {
        lastUpdate: local,
        status: 'RUNNING',
        mode: 'v8 賺大虧小',
        exchange: 'Binance Futures',
        account: {
          initialCapital: INITIAL_CAPITAL,
          balance: parseFloat(totalBalance.toFixed(2)),
          available: parseFloat(totalBalance.toFixed(2)),
          unrealizedPnl: totalUnrealized,
          netEquity: parseFloat((totalBalance + totalUnrealized).toFixed(2)),
          todayPnl: parseFloat(totalTodayPnl.toFixed(2)),
          totalPnl: parseFloat(totalPnl.toFixed(2)),
          leverage: LEVERAGE,
          marginType: MARGIN_TYPE,
          totalTrades,
          winRate: totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) + '%' : '--',
          wins: totalWins,
          losses: totalLosses,
          maxDrawdown: parseFloat(maxDD.toFixed(1))
        },
        position: activePosition ? {
          symbol: activePosition.symbol || SYMBOLS_TO_RUN[0],
          side: activePosition.side,
          size: activePosition.size,
          entryPrice: activePosition.entryPrice,
          markPrice: activePosition.markPrice || activePosition.entryPrice,
          pnl: activePosition.unrealizedPnl || 0,
          leverage: activePosition.leverage || LEVERAGE,
          trailingStop: activeState?.trailingStop?.currentStop || null
        } : null,
        signals: activeState?.lastAnalysis ? {
          score: activeState.lastAnalysis.score,
          direction: activeState.lastAnalysis.direction,
          marketState: activeState.lastAnalysis.marketState,
          trend4h: activeState.lastAnalysis.trend4h,
          buyScore: activeState.lastAnalysis.buyScore || 0,
          sellScore: activeState.lastAnalysis.sellScore || 0,
          reasons: activeState.lastAnalysis.reasons || [],
          rsi15: activeState.lastAnalysis.rsi15,
          strategy: activeState.lastAnalysis.strategy
        } : {},
        perSymbolSignals,  // v6.1: 每個幣種的即時信號詳情
        recentTrades,
        strategyWeights: Object.keys(stratWeights).length ? stratWeights : undefined,
        riskStatus: {
          dailyLossUsed: `$${Math.abs(Math.min(totalTodayPnl, 0)).toFixed(2)} / $${DAILY_LOSS_LIMIT.toFixed(2)}`,
          dailyTradesUsed: `${dailyTradesUsed.trades} / ${MAX_DAILY_TRADES}`,
          consecutiveLosses: '0',
          paused: false
        }
      };

      // v6: 用 API 即時數據覆蓋 balance / position / recentTrades
      try {
        const bal = await getBalance();
        merged.account.balance = parseFloat(bal.total.toFixed(2));
        merged.account.available = parseFloat(bal.available.toFixed(2));
        merged.account.unrealizedPnl = parseFloat(bal.unrealizedPnl.toFixed(2));
        merged.account.netEquity = parseFloat((bal.total + bal.unrealizedPnl).toFixed(2));
        merged.account.totalPnl = parseFloat((bal.total - INITIAL_CAPITAL).toFixed(2));

        // Live positions
        const accData = await apiRequest('GET', '/fapi/v2/account');
        const livePos = (accData.positions || []).filter(p => parseFloat(p.positionAmt) !== 0);
        if (livePos.length > 0) {
          const p = livePos[0];
          const amt = parseFloat(p.positionAmt);
          const pnl = parseFloat(p.unrealizedProfit);
          merged.position = {
            symbol: p.symbol,
            side: amt > 0 ? 'LONG' : 'SHORT',
            size: Math.abs(amt),
            entryPrice: parseFloat(p.entryPrice),
            markPrice: parseFloat((parseFloat(p.entryPrice) + pnl / Math.abs(amt)).toFixed(2)),
            pnl: parseFloat(pnl.toFixed(2)),
            leverage: parseInt(p.leverage),
            trailingStop: activeState?.trailingStop?.currentStop || null
          };
        } else {
          merged.position = null;
        }

        // Recent realized PnL from API
        const income = await apiRequest('GET', '/fapi/v1/income', { incomeType: 'REALIZED_PNL', limit: 20 });
        if (Array.isArray(income)) {
          const apiTrades = income.filter(i => parseFloat(i.income) !== 0).reverse().map(i => ({
            time: new Date(i.time).toISOString(),
            symbol: i.symbol,
            side: parseFloat(i.income) >= 0 ? 'LONG' : 'SHORT',
            pnl: parseFloat(parseFloat(i.income).toFixed(2)),
            strategy: '',
          }));
          if (apiTrades.length > 0) merged.recentTrades = apiTrades;
        }
      } catch(e2) { console.error(`⚠️ API overlay: ${e2.message}`); }

      fs.writeFileSync(DASHBOARD_FILE, JSON.stringify(merged, null, 2));
    } catch(e) { console.error(`⚠️ Merge dashboard error: ${e.message}`); }
  }
}

runAll().catch(e => { console.error(`💥 Fatal: ${e.message}`); process.exit(1); });
