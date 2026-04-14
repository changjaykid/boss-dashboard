#!/usr/bin/env node
/**
 * Binance USDT-M Futures 核心決策引擎 v11 「順勢回踩 + 極端轉折」
 * 
 * 核心哲學：
 * 1. 用 1H/4H K 線做決策，抓 1-3% 波段，不做毛利
 * 2. 每天最多 5 筆，積極把握好機會
 * 3. 主策略：順勢回踩（趨勢中等回踩進場，順勢吃波段）
 * 4. 輔策略：極端轉折（只在 RSI 極端超買超賣才做反向）
 * 5. 趨勢過濾鐵律：上升趨勢不做空、下降趨勢不做多（除非極端轉折）
 * 6. 動態槓桿 + 動態風報比
 * 7. 目標：本金最大化
 * 
 * 資金：~$464 USDT | 槓桿：動態 5-20x | 標的：BTC
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

// ============ Config ============

const WORKER_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(WORKER_DIR, 'data');
let STATE_FILE = path.join(DATA_DIR, 'state.json');
let LOG_FILE = path.join(DATA_DIR, 'trade_log.json');
let CRON_LOG = path.join(DATA_DIR, 'cron.log');
const DASHBOARD_FILE = path.join(WORKER_DIR, 'dashboard.json');

function setSymbolPaths(sym) {
  SYMBOL = sym;
  STATE_FILE = path.join(DATA_DIR, 'state.json');
  LOG_FILE = path.join(DATA_DIR, 'trade_log.json');
  CRON_LOG = path.join(DATA_DIR, 'cron.log');
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
const DEFAULT_MARKETS = ['BTCUSDT', 'SOLUSDT'];  // v12: BTC + 動能幣 SOL
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
// v10: 動態槓桿，不再固定
const LEVERAGE_MIN = 8;
const LEVERAGE_MID = 15;
const LEVERAGE_MAX = 25;
const MARGIN_TYPE = 'ISOLATED';
const INITIAL_CAPITAL = 464;

// === 風控鐵律 v10 ===
const MAX_LOSS_PER_TRADE_PCT = 0.012;        // 單筆最大虧損 1.2%（收緊止損）
const DAILY_LOSS_LIMIT_PCT = 0.06;           // 日虧上限 6%（多幣種分散後可略放）
const DAILY_LOSS_LIMIT = INITIAL_CAPITAL * DAILY_LOSS_LIMIT_PCT;
const MAX_DAILY_TRADES = 10;                 // 多幣種每天最多 10 筆
const CONSECUTIVE_LOSS_PAUSE = 3;            // 連虧 3 筆才停機
const PAUSE_DURATION_MS = 2 * 60 * 60 * 1000;  // 暫停縮短到 2 小時（更快恢復）
const SL_ATR_MULT = 1.0;                     // 收緊止損 1.0x 1H ATR
const SIGNAL_THRESHOLD = 52;                 // 保持積極，但不能用雜訊單進場
const MAX_POSITION_PCT_BASE = 0.20;          // 基礎倉位 20%（動態調整）
const COOLDOWN_MS = 30 * 60 * 1000;          // 縮短冷卻到 30 分鐘
const MIN_4H_TREND_STRENGTH = 0.45;          // 趨勢要明確，但不要保守到沒單
const REQUIRE_PULLBACK_CONFIRMATION = true;  // 回踩一定要有確認，不可硬接
const MIN_CHECKLIST_COUNT = 3;               // 至少 3 個有效確認才准出手
const AGGRESSIVE_MOMENTUM_SCORE = 60;        // 強動量突破可積極追擊
const REVERSAL_SCORE_THRESHOLD = 58;         // 合理抄底/摸頂需要更高確認

// === v10: 動態槓桿 & 風報比計算 ===
function calcDynamicLeverage(signalScore, sentimentContrarian, confirmations, isActiveSession, strategy) {
  // v11: 順勢單給高槓桿（勝率高），轉折單保守槓桿（勝率低但 RR 高）
  let lev = LEVERAGE_MID;
  const isTrendStrategy = ['PULLBACK', 'TREND_FOLLOW', 'TREND_PULLBACK'].includes(strategy);
  
  if (isTrendStrategy) {
    // 順勢策略：信號越強槓桿越高
    if (confirmations >= 5 && signalScore >= 70) lev = LEVERAGE_MAX;
    else if (confirmations >= 4 && signalScore >= 60) lev = 17;
    else if (confirmations >= 3) lev = 15;
    else lev = LEVERAGE_MID;
  } else {
    // 轉折策略：保守槓桿（極端反轉風險大）
    if (confirmations >= 5 && sentimentContrarian && signalScore >= 75) lev = 15;
    else if (confirmations >= 4 && signalScore >= 70) lev = LEVERAGE_MID;
    else lev = 8;
  }
  
  if (isActiveSession && lev < LEVERAGE_MAX) lev = Math.min(lev + 2, LEVERAGE_MAX);
  
  return lev;
}

function calcDynamicRR(signalScore, sentimentContrarian, strategy) {
  // v11: 順勢單 RR 適中（高勝率取量），轉折單追高 RR（低勝率取質）
  const isTrendStrategy = ['PULLBACK', 'TREND_FOLLOW', 'TREND_PULLBACK'].includes(strategy);
  let rr = 3.0;
  
  if (isTrendStrategy) {
    // 順勢：RR 2.5-3.5，穩定出場
    if (signalScore >= 70) rr = 3.5;
    else if (signalScore >= 60) rr = 3.0;
    else rr = 2.5;
  } else {
    // 轉折：RR 4.0-6.0，抓大反轉
    if (signalScore >= 80 && sentimentContrarian) rr = 6.0;
    else if (signalScore >= 70 && sentimentContrarian) rr = 5.0;
    else if (signalScore >= 65) rr = 4.5;
    else rr = 4.0;
  }
  
  if (strategy === 'DIVERGENCE_REVERSAL') rr = Math.max(rr, 4.5);
  
  return rr;
}

function calcDynamicMinProfit(leverage, rr) {
  // 高槓桿 + 高 RR → 每筆預期利潤更高
  // 但最低門檻也要合理，不能因為算出太高就不做
  const base = 5.0; // 最低 $5
  return Math.max(base, leverage * 0.4); // 槓桿越高，最低利潤門檻越高
}

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
    if (fs.existsSync(STATE_FILE)) {
      const root = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      const symbolState = root?.symbols?.[SYMBOL];
      if (symbolState && typeof symbolState === 'object') return symbolState;
    }
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
    strategyStats: {},
    strategyWeights: {},
    tradeHistory: [],
    lastAnalysis: null,
    lastTradeTime: null,
    startTime: new Date().toISOString(),
    initialCapital: INITIAL_CAPITAL
  };
}

function getStrategyDefaults() {
  return {
    // v11 主策略：順勢回踩
    PULLBACK: { weight: 1.2, enabled: true },
    TREND_FOLLOW: { weight: 1.1, enabled: true },
    TREND_PULLBACK: { weight: 1.1, enabled: true },
    // v11 輔策略：極端轉折（只在極端情況觸發）
    REVERSAL_CONFIRM: { weight: 0.9, enabled: true },
    DIVERGENCE_REVERSAL: { weight: 1.0, enabled: true },
    BB_EXTREME_REVERSAL: { weight: 0.9, enabled: true },
    // 停用
    MOMENTUM_BREAKOUT: { weight: 0, enabled: false },
    BB_SQUEEZE: { weight: 0, enabled: false },
    EMA_RSI_CROSS: { weight: 0, enabled: false },
    SESSION_BREAKOUT: { weight: 0, enabled: false },
    STOCH_RSI_CROSS: { weight: 0, enabled: false },
    RSI_BB_ADAPTIVE: { weight: 0, enabled: false },
    MOMENTUM: { weight: 0, enabled: false },
    UNKNOWN: { weight: 0.8, enabled: true }
  };
}

function ensureStrategyState(state) {
  state.strategyStats = state.strategyStats || {};
  state.strategyWeights = state.strategyWeights || {};
  const defaults = getStrategyDefaults();
  for (const [name, cfg] of Object.entries(defaults)) {
    if (!state.strategyWeights[name]) state.strategyWeights[name] = { ...cfg };
    else {
      if (typeof state.strategyWeights[name].weight !== 'number') state.strategyWeights[name].weight = cfg.weight;
      if (typeof state.strategyWeights[name].enabled !== 'boolean') state.strategyWeights[name].enabled = cfg.enabled;
    }
    if (!state.strategyStats[name]) {
      state.strategyStats[name] = {
        trades: 0, wins: 0, losses: 0, pnl: 0,
        recentPnls: [], avgPnl: 0, winRate: 0,
        lastTradeAt: null, disabledReason: null
      };
    }
  }
}

function updateStrategyPerformance(state, strategy, pnl) {
  ensureStrategyState(state);
  const key = strategy || 'UNKNOWN';
  if (!state.strategyStats[key]) {
    state.strategyStats[key] = { trades: 0, wins: 0, losses: 0, pnl: 0, recentPnls: [], avgPnl: 0, winRate: 0, lastTradeAt: null, disabledReason: null };
  }
  if (!state.strategyWeights[key]) {
    state.strategyWeights[key] = { weight: 1, enabled: true };
  }

  const st = state.strategyStats[key];
  st.trades += 1;
  st.pnl += pnl;
  if (pnl > 0) st.wins += 1; else st.losses += 1;
  st.winRate = st.trades > 0 ? st.wins / st.trades : 0;
  st.recentPnls.push(parseFloat(pnl.toFixed(2)));
  if (st.recentPnls.length > 10) st.recentPnls = st.recentPnls.slice(-10);
  st.avgPnl = st.recentPnls.length ? st.recentPnls.reduce((a,b) => a + b, 0) / st.recentPnls.length : 0;
  st.lastTradeAt = new Date().toISOString();

  const recentCount = st.recentPnls.length;
  const last3 = st.recentPnls.slice(-3);
  const last3AllLoss = last3.length === 3 && last3.every(v => v < 0);
  const recentSum = st.recentPnls.reduce((a,b) => a + b, 0);

  if (recentCount >= 5 && recentSum < -8) {
    state.strategyWeights[key].weight = 0.35;
    state.strategyWeights[key].enabled = false;
    st.disabledReason = 'recent_5_trades_negative';
  } else if (last3AllLoss) {
    state.strategyWeights[key].weight = 0.55;
    state.strategyWeights[key].enabled = true;
    st.disabledReason = '3_consecutive_losses';
  } else if (recentCount >= 5 && recentSum > 8 && st.winRate >= 0.5) {
    state.strategyWeights[key].weight = 1.25;
    state.strategyWeights[key].enabled = true;
    st.disabledReason = null;
  } else {
    state.strategyWeights[key].weight = Math.max(0.7, Math.min(1.15, 1 + st.avgPnl / 20));
    state.strategyWeights[key].enabled = true;
    st.disabledReason = null;
  }
}

function saveState(s) {
  let root = { version: 9, activeSymbols: [], symbols: {} };
  try {
    if (fs.existsSync(STATE_FILE)) {
      const existing = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (existing && typeof existing === 'object') {
        root = {
          version: existing.version || 9,
          activeSymbols: Array.isArray(existing.activeSymbols) ? existing.activeSymbols : [],
          symbols: existing.symbols && typeof existing.symbols === 'object' ? existing.symbols : {}
        };
      }
    }
  } catch(e) { log(`⚠️ ${e.message}`); }

  root.version = 9;
  root.symbols[SYMBOL] = s;
  root.activeSymbols = Object.keys(root.symbols).filter(sym => root.symbols[sym]);
  fs.writeFileSync(STATE_FILE, JSON.stringify(root, null, 2));
}
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

// ============ Signal Scoring v11 — 順勢回踩 + 極端轉折 ============
// 核心理念：
// 1. 主策略：順著 4H 趨勢方向，等 1H 回踩後進場
// 2. 輔策略：只有 RSI 極端超買超賣才做反向（門檻很高）
// 3. 鐵律：上升趨勢不做空、下降趨勢不做多（除非極端轉折）

function scoreSignals(klines15m, klines1h, klines4h, fundingData, price, oiChange, atrVal) {
  const c15 = klines15m.map(k => k.close);
  const c1h = klines1h.map(k => k.close);
  const c4h = klines4h.map(k => k.close);

  const marketState = detectMarketState(klines1h, c1h);
  const sr = findSupportResistance(klines1h, klines15m, price);
  const nearSupport = isNearSupport(price, sr);
  const nearResistance = isNearResistance(price, sr);

  let buyScore = 0, sellScore = 0;
  const buyReasons = [], sellReasons = [];

  // === 基礎指標計算 ===
  const ema8_4h = ema(c4h, 8), ema21_4h = ema(c4h, 21);
  const e8_4h = ema8_4h[ema8_4h.length - 1], e21_4h = ema21_4h[ema21_4h.length - 1];
  const trend4h = e8_4h > e21_4h ? 'UP' : 'DOWN';
  const trend4hStrength = Math.abs(e8_4h - e21_4h) / e21_4h * 100;

  const macd4h = macd(c4h);
  const macd1h = macd(c1h);
  const rsi1h = rsi(c1h);
  const rsi4h = rsi(c4h);
  const rsi15 = rsi(c15);
  const bbVal = bb(c1h);
  const bb4h = bb(c4h);
  const atrVal1h = atr(klines1h) || price * 0.01;
  const adxVal = adx(klines1h);

  const ema8_1h = ema(c1h, 8), ema21_1h = ema(c1h, 21);
  const e8_1h = ema8_1h[ema8_1h.length - 1], e21_1h = ema21_1h[ema21_1h.length - 1];
  const trend1h = e8_1h > e21_1h ? 'UP' : 'DOWN';

  // 量能
  let volumeSpike = false;
  if (klines1h.length >= 20) {
    const recentVol = klines1h.slice(-3).reduce((s, k) => s + k.volume, 0) / 3;
    const avgVol = klines1h.slice(-20, -3).reduce((s, k) => s + k.volume, 0) / 17;
    volumeSpike = recentVol > avgVol * 1.5;
  }

  // K 線形態
  let pinBarBull = false, pinBarBear = false, engulfBull = false, engulfBear = false;
  if (klines1h.length >= 3) {
    const last = klines1h[klines1h.length - 1];
    const prev = klines1h[klines1h.length - 2];
    const body = Math.abs(last.close - last.open);
    const range = last.high - last.low;
    if (range > 0) {
      const lowerWick = (Math.min(last.open, last.close) - last.low) / range;
      const upperWick = (last.high - Math.max(last.open, last.close)) / range;
      pinBarBull = lowerWick > 0.6 && body / range < 0.25;
      pinBarBear = upperWick > 0.6 && body / range < 0.25;
    }
    engulfBull = prev.close < prev.open && last.close > last.open && last.close > prev.open && last.open < prev.close;
    engulfBear = prev.close > prev.open && last.close < last.open && last.close < prev.open && last.open > prev.close;
  }

  // MACD 動能
  let macd4hBullTurn = false, macd4hBearTurn = false;
  if (macd4h) {
    macd4hBullTurn = (macd4h.histogram > macd4h.prevHistogram && macd4h.prevHistogram < 0);
    macd4hBearTurn = (macd4h.histogram < macd4h.prevHistogram && macd4h.prevHistogram > 0);
  }
  let macd1hBullCross = false, macd1hBearCross = false;
  if (macd1h) {
    macd1hBullCross = macd1h.histogram > 0 && macd1h.prevHistogram <= 0;
    macd1hBearCross = macd1h.histogram < 0 && macd1h.prevHistogram >= 0;
  }

  // ======== 主策略：順勢回踩 ========
  // 4H 多頭趨勢 → 等 1H 回踩到支撐/EMA/BB中軌 → 出現多頭信號進場做多
  // 4H 空頭趨勢 → 等 1H 反彈到壓力/EMA/BB中軌 → 出現空頭信號進場做空
  let trendBuyConfirm = 0, trendSellConfirm = 0;

  if (trend4h === 'UP' && trend4hStrength >= MIN_4H_TREND_STRENGTH) {
    // === 多頭趨勢回踩做多 ===
    buyScore += 15; buyReasons.push(`4H多頭(${trend4hStrength.toFixed(2)}%)`); trendBuyConfirm++;

    // 4H MACD 加速↑ 或金叉
    if (macd4h && macd4h.histogram > macd4h.prevHistogram) { buyScore += 12; buyReasons.push('4H MACD加速↑'); trendBuyConfirm++; }
    if (macd4hBullTurn) { buyScore += 10; buyReasons.push('4H MACD金叉'); trendBuyConfirm++; }

    // 1H EMA 多排（回踩後趨勢繼續）
    if (e8_1h > e21_1h) { buyScore += 10; buyReasons.push('1H EMA多排'); trendBuyConfirm++; }

    // RSI 回踩到 40-55 區間（不是超賣，是正常回踩）
    if (rsi1h !== null && rsi1h >= 38 && rsi1h <= 55) { buyScore += 12; buyReasons.push(`1H RSI回踩${rsi1h.toFixed(0)}`); trendBuyConfirm++; }

    // 回踩到支撐/BB中軌附近
    if (nearSupport) { buyScore += 15; buyReasons.push('支撐區回踩做多'); trendBuyConfirm++; }
    if (bbVal && price <= bbVal.middle * 1.003 && price >= bbVal.lower) { buyScore += 10; buyReasons.push('BB中軌回踩'); trendBuyConfirm++; }

    // K 線形態確認
    if (pinBarBull) { buyScore += 12; buyReasons.push('1H看多Pin Bar'); trendBuyConfirm++; }
    if (engulfBull) { buyScore += 15; buyReasons.push('1H多頭吞噬'); trendBuyConfirm++; }
    if (macd1hBullCross) { buyScore += 10; buyReasons.push('1H MACD金叉'); trendBuyConfirm++; }

    // 放量確認
    if (volumeSpike && (pinBarBull || engulfBull || macd1hBullCross)) {
      buyScore += 10; buyReasons.push('1H量能爆發'); trendBuyConfirm++;
    }
  }

  if (trend4h === 'DOWN' && trend4hStrength >= MIN_4H_TREND_STRENGTH) {
    // === 空頭趨勢反彈做空 ===
    sellScore += 15; sellReasons.push(`4H空頭(${trend4hStrength.toFixed(2)}%)`); trendSellConfirm++;

    if (macd4h && macd4h.histogram < macd4h.prevHistogram) { sellScore += 12; sellReasons.push('4H MACD加速↓'); trendSellConfirm++; }
    if (macd4hBearTurn) { sellScore += 10; sellReasons.push('4H MACD死叉'); trendSellConfirm++; }

    if (e8_1h < e21_1h) { sellScore += 10; sellReasons.push('1H EMA空排'); trendSellConfirm++; }

    if (rsi1h !== null && rsi1h >= 45 && rsi1h <= 62) { sellScore += 12; sellReasons.push(`1H RSI反彈${rsi1h.toFixed(0)}`); trendSellConfirm++; }

    if (nearResistance) { sellScore += 15; sellReasons.push('壓力區反彈做空'); trendSellConfirm++; }
    if (bbVal && price >= bbVal.middle * 0.997 && price <= bbVal.upper) { sellScore += 10; sellReasons.push('BB中軌反彈'); trendSellConfirm++; }

    if (pinBarBear) { sellScore += 12; sellReasons.push('1H看空Pin Bar'); trendSellConfirm++; }
    if (engulfBear) { sellScore += 15; sellReasons.push('1H空頭吞噬'); trendSellConfirm++; }
    if (macd1hBearCross) { sellScore += 10; sellReasons.push('1H MACD死叉'); trendSellConfirm++; }

    if (volumeSpike && (pinBarBear || engulfBear || macd1hBearCross)) {
      sellScore += 10; sellReasons.push('1H量能爆發'); trendSellConfirm++;
    }
  }

  // ======== 輔策略：極端轉折（收緊門檻）========
  // 只有在真正極端時才允許逆勢
  let extremeBuyConfirm = 0, extremeSellConfirm = 0;
  const EXTREME_RSI_LOW = 28;   // v11: 收緊（原 35）
  const EXTREME_RSI_HIGH = 75;  // v11: 收緊（原 65）
  const EXTREME_RSI_4H_LOW = 25;
  const EXTREME_RSI_4H_HIGH = 78;

  // 極端超賣反轉做多（即使 4H 趨勢向下也可以）
  if (rsi1h !== null && rsi1h < EXTREME_RSI_LOW) { buyScore += 25; buyReasons.push(`🚨 1H RSI極端超賣${rsi1h.toFixed(0)}`); extremeBuyConfirm++; }
  if (rsi4h !== null && rsi4h < EXTREME_RSI_4H_LOW) { buyScore += 30; buyReasons.push(`🚨 4H RSI極端超賣${rsi4h.toFixed(0)}`); extremeBuyConfirm++; }
  if (bb4h && price < bb4h.lower) { buyScore += 20; buyReasons.push('🚨 跌破4H BB下軌'); extremeBuyConfirm++; }
  if (pinBarBull && rsi1h !== null && rsi1h < 35) { buyScore += 15; buyReasons.push('超賣區Pin Bar'); extremeBuyConfirm++; }
  if (engulfBull && rsi1h !== null && rsi1h < 35) { buyScore += 18; buyReasons.push('超賣區多頭吞噬'); extremeBuyConfirm++; }
  // RSI 底背離
  if (rsi1h !== null && klines1h.length >= 20) {
    const prices20 = klines1h.slice(-20).map(k => k.low);
    const rsiArr = [];
    const tempCloses = c1h.slice(-20);
    for (let i = 14; i < tempCloses.length; i++) {
      const r = rsi(tempCloses.slice(0, i + 1));
      if (r !== null) rsiArr.push(r);
    }
    if (rsiArr.length >= 5) {
      const priceNewLow = price <= Math.min(...prices20.slice(-10));
      const rsiNotNewLow = rsiArr[rsiArr.length - 1] > Math.min(...rsiArr.slice(-10));
      if (priceNewLow && rsiNotNewLow && rsi1h < 35) { buyScore += 22; buyReasons.push('RSI底背離'); extremeBuyConfirm++; }
    }
  }

  // 極端超買反轉做空
  if (rsi1h !== null && rsi1h > EXTREME_RSI_HIGH) { sellScore += 25; sellReasons.push(`🚨 1H RSI極端超買${rsi1h.toFixed(0)}`); extremeSellConfirm++; }
  if (rsi4h !== null && rsi4h > EXTREME_RSI_4H_HIGH) { sellScore += 30; sellReasons.push(`🚨 4H RSI極端超買${rsi4h.toFixed(0)}`); extremeSellConfirm++; }
  if (bb4h && price > bb4h.upper) { sellScore += 20; sellReasons.push('🚨 突破4H BB上軌'); extremeSellConfirm++; }
  if (pinBarBear && rsi1h !== null && rsi1h > 65) { sellScore += 15; sellReasons.push('超買區Pin Bar'); extremeSellConfirm++; }
  if (engulfBear && rsi1h !== null && rsi1h > 65) { sellScore += 18; sellReasons.push('超買區空頭吞噬'); extremeSellConfirm++; }
  // RSI 頂背離
  if (rsi1h !== null && klines1h.length >= 20) {
    const prices20h = klines1h.slice(-20).map(k => k.high);
    const rsiArr2 = [];
    const tempCloses2 = c1h.slice(-20);
    for (let i = 14; i < tempCloses2.length; i++) {
      const r = rsi(tempCloses2.slice(0, i + 1));
      if (r !== null) rsiArr2.push(r);
    }
    if (rsiArr2.length >= 5) {
      const priceNewHigh = price >= Math.max(...prices20h.slice(-10));
      const rsiNotNewHigh = rsiArr2[rsiArr2.length - 1] < Math.max(...rsiArr2.slice(-10));
      if (priceNewHigh && rsiNotNewHigh && rsi1h > 65) { sellScore += 22; sellReasons.push('RSI頂背離'); extremeSellConfirm++; }
    }
  }

  // ======== 資金費率（共用）========
  if (fundingData) {
    let fRate = null;
    if (typeof fundingData === 'number') fRate = fundingData;
    else if (typeof fundingData === 'object' && !Array.isArray(fundingData) && typeof fundingData.rate === 'number') fRate = fundingData.rate;
    else if (Array.isArray(fundingData) && fundingData.length > 0) {
      const last = fundingData[fundingData.length - 1];
      fRate = typeof last === 'number' ? last : (typeof last.rate === 'number' ? last.rate : parseFloat(last.lastFundingRate || last.fundingRate || 0));
    }
    if (fRate !== null && !isNaN(fRate)) {
      if (fRate > 0.0005) { sellScore += 10; sellReasons.push(`費率過高${(fRate*100).toFixed(3)}%`); }
      if (fRate < -0.0003) { buyScore += 10; buyReasons.push(`負費率${(fRate*100).toFixed(3)}%`); }
    }
  }

  // OI 變化
  if (typeof oiChange === 'number' && !isNaN(oiChange)) {
    if (oiChange > 5 && rsi1h !== null && rsi1h > 60) { sellScore += 8; sellReasons.push('OI增+超買'); }
    if (oiChange > 5 && rsi1h !== null && rsi1h < 40) { buyScore += 8; buyReasons.push('OI增+超賣'); }
  }

  // ======== 🚨 趨勢過濾鐵律（v11 核心）========
  // 上升趨勢不做空（除非極端轉折 >= 3 確認）
  // 下降趨勢不做多（除非極端轉折 >= 3 確認）
  if (trend4h === 'UP' && trend4hStrength >= MIN_4H_TREND_STRENGTH) {
    if (extremeSellConfirm < 3) {
      // 上升趨勢 + 沒有極端超買 → 殺掉做空分數
      sellScore = Math.round(sellScore * 0.15);
      if (sellScore > 0) sellReasons.push('⛔ 上升趨勢禁做空');
    } else {
      sellReasons.push('⚠️ 逆勢做空(極端轉折)');
    }
  }
  if (trend4h === 'DOWN' && trend4hStrength >= MIN_4H_TREND_STRENGTH) {
    if (extremeBuyConfirm < 3) {
      buyScore = Math.round(buyScore * 0.15);
      if (buyScore > 0) buyReasons.push('⛔ 下降趨勢禁做多');
    } else {
      buyReasons.push('⚠️ 逆勢做多(極端轉折)');
    }
  }

  // ======== 確認數門檻 ========
  const totalBuyConfirm = trendBuyConfirm + extremeBuyConfirm;
  const totalSellConfirm = trendSellConfirm + extremeSellConfirm;
  
  // 順勢單至少 3 確認，轉折單至少 3 極端確認
  if (totalBuyConfirm < 3) {
    buyScore = Math.round(buyScore * 0.3);
    if (totalBuyConfirm > 0) buyReasons.push(`⚠️確認不足(${totalBuyConfirm}/3)`);
  }
  if (totalSellConfirm < 3) {
    sellScore = Math.round(sellScore * 0.3);
    if (totalSellConfirm > 0) sellReasons.push(`⚠️確認不足(${totalSellConfirm}/3)`);
  }

  // 活躍時段 boost
  const session = isActiveSession();
  if (session) { buyScore = Math.round(buyScore * 1.12); sellScore = Math.round(sellScore * 1.12); }
  if (isDeadZone()) { buyScore = Math.round(buyScore * 0.4); sellScore = Math.round(sellScore * 0.4); }

  // ======== 決策輸出 ========
  const maxScore = Math.max(buyScore, sellScore);
  const direction = buyScore > sellScore ? 'LONG' : 'SHORT';
  const reasons = direction === 'LONG' ? buyReasons : sellReasons;
  const confirmations = direction === 'LONG' ? totalBuyConfirm : totalSellConfirm;

  const minScore = Math.min(buyScore, sellScore);
  const edge = maxScore > 0 ? (maxScore - minScore) / maxScore : 0;

  if (edge < 0.45 || maxScore < SIGNAL_THRESHOLD || confirmations < 3) {
    const reason = confirmations < 3 ? `確認不足(${confirmations}/3)` : edge < 0.45 ? `方向不明(edge=${(edge*100).toFixed(0)}%)` : `分數不足(${maxScore})`;
    return {
      score: Math.round(maxScore * 0.5), direction: null, strategy: null, marketState, reason,
      buyScore: Math.round(buyScore), sellScore: Math.round(sellScore),
      trend4h, trend4hStrength,
      reasons: [...buyReasons.map(r => `🟢${r}`), ...sellReasons.map(r => `🔴${r}`)],
      rsi15: rsi15 ? Math.round(rsi15) : null,
      bottomConfirmations: totalBuyConfirm, topConfirmations: totalSellConfirm,
      trendBuyConfirm, trendSellConfirm, extremeBuyConfirm, extremeSellConfirm,
      session: session || (isDeadZone() ? 'DEAD_ZONE' : 'TRANSITION')
    };
  }

  // 策略分類：根據哪種確認更多來分類
  let strategy;
  const isTrendDriven = direction === 'LONG' ? trendBuyConfirm >= extremeBuyConfirm : trendSellConfirm >= extremeSellConfirm;
  if (isTrendDriven) {
    // 順勢策略
    const allReasonsStr = reasons.join(',');
    if (allReasonsStr.includes('回踩') || allReasonsStr.includes('支撐') || allReasonsStr.includes('壓力')) strategy = 'PULLBACK';
    else if (allReasonsStr.includes('EMA') || allReasonsStr.includes('MACD加速')) strategy = 'TREND_FOLLOW';
    else strategy = 'TREND_PULLBACK';
  } else {
    // 極端轉折策略
    const allReasonsStr = reasons.join(',');
    if (allReasonsStr.includes('背離')) strategy = 'DIVERGENCE_REVERSAL';
    else if (allReasonsStr.includes('BB')) strategy = 'BB_EXTREME_REVERSAL';
    else strategy = 'REVERSAL_CONFIRM';
  }

  const checklist = reasons.filter(r => !r.startsWith('⚠️') && !r.startsWith('⛔'));

  return {
    score: Math.round(maxScore),
    direction,
    strategy,
    marketState,
    trend4h,
    trend4hStrength,
    reasons,
    buyScore: Math.round(buyScore),
    sellScore: Math.round(sellScore),
    checklist,
    checklistCount: checklist.length,
    bottomConfirmations: totalBuyConfirm,
    topConfirmations: totalSellConfirm,
    trendBuyConfirm, trendSellConfirm,
    extremeBuyConfirm, extremeSellConfirm,
    rsi15: rsi15 ? Math.round(rsi15) : null,
    session: session || (isDeadZone() ? 'DEAD_ZONE' : 'TRANSITION')
  };
}

// ============ 第二套策略：動量突破（Momentum Breakout）============
// 跟 v8 Pullback 互補：v8 等回踩，這套追突破
// 只在 v8 主信號不觸發時才檢查

function scoreMomentumBreakout() {
  return null;
}

// ============ Sentiment Data (Public API, no key needed) ============

function fetchPublicJSON(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    https.get({ hostname: urlObj.hostname, path: urlObj.pathname + urlObj.search, headers: { 'Accept': 'application/json' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });
}

async function fetchSentimentData(symbol = 'BTCUSDT') {
  try {
    const [topPos, topAcc, takerRatio] = await Promise.all([
      fetchPublicJSON(`https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=1h&limit=3`),
      fetchPublicJSON(`https://fapi.binance.com/futures/data/topLongShortAccountRatio?symbol=${symbol}&period=1h&limit=3`),
      fetchPublicJSON(`https://fapi.binance.com/futures/data/takerlongshortRatio?symbol=${symbol}&period=1h&limit=3`)
    ]);

    const posRatio = parseFloat(topPos[topPos.length - 1]?.longShortRatio || 1);
    const accRatio = parseFloat(topAcc[topAcc.length - 1]?.longShortRatio || 1);
    const buySellRatio = parseFloat(takerRatio[takerRatio.length - 1]?.buySellRatio || 1);

    // 大戶持倉偏多 + 主動買盤強 → LONG
    // 大戶持倉偏空 + 主動賣盤強 → SHORT
    let sentimentBias = 'NEUTRAL';
    if (posRatio > 1.05 && buySellRatio > 1.02) sentimentBias = 'LONG';
    else if (posRatio < 0.95 && buySellRatio < 0.98) sentimentBias = 'SHORT';

    // 散戶 vs 大戶分歧（帳戶數偏多但持倉偏空 = 散戶多大戶空）
    const retailVsWhale = accRatio > 1.03 && posRatio < 0.97 ? 'RETAIL_LONG_WHALE_SHORT'
      : accRatio < 0.97 && posRatio > 1.03 ? 'RETAIL_SHORT_WHALE_LONG'
      : 'ALIGNED';

    log(`📊 情緒: 大戶持倉比=${posRatio.toFixed(3)} 帳戶比=${accRatio.toFixed(3)} 買賣比=${buySellRatio.toFixed(3)} → ${sentimentBias} (${retailVsWhale})`);

    return { posRatio, accRatio, buySellRatio, sentimentBias, retailVsWhale };
  } catch (e) {
    log(`⚠️ Sentiment fetch error: ${e.message}`);
    return { posRatio: 1, accRatio: 1, buySellRatio: 1, sentimentBias: 'NEUTRAL', retailVsWhale: 'ALIGNED' };
  }
}

// ============ BB Squeeze Detection ============

function detectBBSqueeze(klines1h) {
  if (klines1h.length < 25) return null;
  const closes = klines1h.map(k => k.close);

  // Calculate BB width for last 25 candles
  const widths = [];
  for (let i = 20; i <= klines1h.length; i++) {
    const slice = closes.slice(i - 20, i);
    const avg = slice.reduce((a, b) => a + b) / 20;
    const std = Math.sqrt(slice.reduce((a, b) => a + (b - avg) ** 2, 0) / 20);
    widths.push((4 * std / avg) * 100); // BB width %
  }

  const currentWidth = widths[widths.length - 1];
  const sortedWidths = [...widths].sort((a, b) => a - b);
  const threshold20pct = sortedWidths[Math.floor(sortedWidths.length * 0.2)];
  const isSqueeze = currentWidth <= threshold20pct;

  if (!isSqueeze) return null;

  // Check breakout direction
  const bbVal = bb(closes);
  if (!bbVal) return null;
  const lastCandle = klines1h[klines1h.length - 1];
  const avgVol = klines1h.slice(-20).reduce((s, k) => s + k.volume, 0) / 20;
  const volConfirm = lastCandle.volume > avgVol * 1.5;

  if (lastCandle.close > bbVal.upper && volConfirm) {
    const atrVal = atr(klines1h) || lastCandle.close * 0.01;
    return { direction: 'LONG', sl: bbVal.middle, tp: lastCandle.close + atrVal * 2, reason: `BB Squeeze突破做多(寬度${currentWidth.toFixed(2)}%<${threshold20pct.toFixed(2)}%)` };
  }
  if (lastCandle.close < bbVal.lower && volConfirm) {
    const atrVal = atr(klines1h) || lastCandle.close * 0.01;
    return { direction: 'SHORT', sl: bbVal.middle, tp: lastCandle.close - atrVal * 2, reason: `BB Squeeze突破做空(寬度${currentWidth.toFixed(2)}%<${threshold20pct.toFixed(2)}%)` };
  }
  return null;
}

// ============ EMA RSI Cross Detection ============

function detectEmaRsiCross(klines1h) {
  if (klines1h.length < 30) return null;
  const closes = klines1h.map(k => k.close);
  const ema9 = ema(closes, 9);
  const ema21arr = ema(closes, 21);
  const rsiVal = rsi(closes);
  if (rsiVal === null) return null;

  const currEma9 = ema9[ema9.length - 1];
  const prevEma9 = ema9[ema9.length - 2];
  const currEma21 = ema21arr[ema21arr.length - 1];
  const prevEma21 = ema21arr[ema21arr.length - 2];

  const atrVal = atr(klines1h) || closes[closes.length - 1] * 0.01;

  // 9EMA 從下穿上 21EMA + RSI > 50
  if (prevEma9 <= prevEma21 && currEma9 > currEma21 && rsiVal > 50) {
    return {
      direction: 'LONG',
      sl: closes[closes.length - 1] - atrVal * 1.5,
      tp: closes[closes.length - 1] + atrVal * 3,
      reason: `EMA金叉(9>${Math.round(currEma9)}>21=${Math.round(currEma21)})+RSI=${Math.round(rsiVal)}`
    };
  }
  // 9EMA 從上穿下 21EMA + RSI < 50
  if (prevEma9 >= prevEma21 && currEma9 < currEma21 && rsiVal < 50) {
    return {
      direction: 'SHORT',
      sl: closes[closes.length - 1] + atrVal * 1.5,
      tp: closes[closes.length - 1] - atrVal * 3,
      reason: `EMA死叉(9=${Math.round(currEma9)}<21=${Math.round(currEma21)})+RSI=${Math.round(rsiVal)}`
    };
  }
  return null;
}

// ============ Position Sizing ============

function calcPositionSize(balance, price, atrVal1h, dynamicLeverage) {
  const mp = MARKET_PARAMS[SYMBOL] || { minQty: 0.001, stepSize: 0.001 };
  const lev = dynamicLeverage || LEVERAGE_MID;
  
  // v10: 動態倉位：高槓桿降低倉位%，低槓桿提高倉位%
  // 確保實際曝險金額不會過大
  const positionPct = lev >= 15 ? 0.18 : lev >= 10 ? 0.22 : 0.28;
  const margin = balance * positionPct;
  const notional = margin * lev;
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
  
  // v12: 止損收緊 + 止盈放大，讓利潤跑得更遠
  // 階段 1: +0.4% → 保本
  if (pnlPct >= 0.4) {
    newStop = entry;
  }
  // 階段 2: +1.0% → 鎖住 +0.3%
  if (pnlPct >= 1.0) {
    const lockPrice = isLong ? entry * 1.003 : entry * 0.997;
    if (isLong ? lockPrice > newStop : lockPrice < newStop) newStop = lockPrice;
  }
  // 階段 3: +2.0% → 追蹤 1.2%（放寬空間讓利潤跑）
  if (pnlPct >= 2.0) {
    const trail = isLong ? markPrice * 0.988 : markPrice * 1.012;
    if (isLong ? trail > newStop : trail < newStop) newStop = trail;
  }
  // 階段 4: +4.0% → 追蹤 0.8%
  if (pnlPct >= 4.0) {
    const trail = isLong ? markPrice * 0.992 : markPrice * 1.008;
    if (isLong ? trail > newStop : trail < newStop) newStop = trail;
  }
  // 階段 5: +7.0% → 追蹤 0.5%（大波段保護）
  if (pnlPct >= 7.0) {
    const trail = isLong ? markPrice * 0.995 : markPrice * 1.005;
    if (isLong ? trail > newStop : trail < newStop) newStop = trail;
  }
  // 階段 6: +12% → 追蹤 0.3%（極大波段收緊）
  if (pnlPct >= 12.0) {
    const trail = isLong ? markPrice * 0.997 : markPrice * 1.003;
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

  // 1. 強反轉信號（對向轉折確認）
  const oppositeConfirm = isLong ? (signal.topConfirmations || 0) : (signal.bottomConfirmations || 0);
  if (oppositeConfirm >= 3) {
    return { close: true, reason: `對向轉折確認(${oppositeConfirm}個信號)` };
  }

  // 2. v10: 浮虧超過 3h 就砍（轉折單應該很快解決）
  if (holdHours > 3 && pnlPct < -0.3) {
    return { close: true, reason: `虧損${pnlPct.toFixed(2)}%持${holdHours.toFixed(0)}h快砍` };
  }

  // 3. 持倉 > 6h + 完全無動 → 釋放資金
  if (holdHours > 6 && Math.abs(pnlPct) < 0.3) {
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
    mode: 'v11 順勢回踩+極端轉折',
    exchange: 'Binance Futures',
    account: {
      initialCapital: INITIAL_CAPITAL, balance: balance?.total || 0,
      available: balance?.available || 0, unrealizedPnl: pos?.unrealizedPnl || 0,
      netEquity: (balance?.total || 0) + (pos?.unrealizedPnl || 0),
      todayPnl: ds.pnl, totalPnl: ts.pnl, leverage: `${LEVERAGE_MIN}-${LEVERAGE_MAX}x(動態)`,
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
    strategyStats: state.strategyStats,
    strategyWeights: state.strategyWeights,
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
  ensureStrategyState(state);
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

  updateStrategyPerformance(state, strategy, pnl);

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
    logEntries.push({ ...state.tradeHistory[state.tradeHistory.length - 1], symbol: SYMBOL });
    fs.writeFileSync(LOG_FILE, JSON.stringify(logEntries, null, 2));
  } catch(e) { log(`⚠️ ${e.message}`); }
}

// ============ Main Engine ============

async function run() {
  const startTime = Date.now();
  let state = loadState();
  ensureStrategyState(state);

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
    // v10: Leverage will be set dynamically before each trade
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

    // === Fetch sentiment data ===
    const sentiment = await fetchSentimentData(SYMBOL);

    let signal = scoreSignals(klines15m, klines1h, klines4h, funding, price, oiChange, atrVal);

    // === v11: 情緒參考（不過濾，不加分，只記錄）===
    if (signal.direction && sentiment.sentimentBias !== 'NEUTRAL') {
      // v11: 情緒純參考，不影響分數（避免過度揨演）
      const sentimentAligned = sentiment.sentimentBias === signal.direction;
      signal.reasons = [...(signal.reasons || []), `📊情緒:${sentiment.sentimentBias}(${sentimentAligned ? '同向' : '逆向'})`];
      log(`📊 情緒參考: 大戶${sentiment.sentimentBias} 我做${signal.direction} (${sentimentAligned ? '同向' : '逆向'})`);
    }

    const stratCfg = state.strategyWeights[signal.strategy || 'UNKNOWN'] || { weight: 1, enabled: true };
    if (!stratCfg.enabled) {
      signal = {
        ...signal,
        direction: null,
        reason: `策略已停用(${signal.strategy})`,
        score: Math.round((signal.score || 0) * 0.2)
      };
    } else if (typeof stratCfg.weight === 'number') {
      signal = {
        ...signal,
        score: Math.round((signal.score || 0) * stratCfg.weight)
      };
    }

    state.lastAnalysis = {
      time: new Date().toISOString(), price,
      marketState: signal.marketState, score: signal.score, direction: signal.direction,
      trend4h: signal.trend4h, trend4hStrength: signal.trend4hStrength || 0,
      buyScore: signal.buyScore || 0, sellScore: signal.sellScore || 0,
      reasons: signal.reasons || [], strategy: signal.strategy, rsi15: signal.rsi15,
      checklist: signal.checklist || [], checklistCount: signal.checklistCount || 0,
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
        // v10: 動態計算槓桿、風報比、最低利潤
        const sentimentContrarian = sentiment.sentimentBias !== 'NEUTRAL' && sentiment.sentimentBias !== signal.direction;
        const confirmations = signal.direction === 'LONG' ? (signal.bottomConfirmations || 0) : (signal.topConfirmations || 0);
        const activeSession = isActiveSession();
        const dynLeverage = calcDynamicLeverage(signal.score, sentimentContrarian, confirmations, !!activeSession, signal.strategy);
        const dynRR = calcDynamicRR(signal.score, sentimentContrarian, signal.strategy);
        const dynMinProfit = calcDynamicMinProfit(dynLeverage, dynRR);
        
        // Set leverage for this trade
        try { await apiRequest('POST', '/fapi/v1/leverage', { symbol: SYMBOL, leverage: dynLeverage }); } catch(e) { log(`⚠️ Leverage set: ${e.message}`); }
        
        const qty = calcPositionSize(balance.available, price, atrVal, dynLeverage);
        if (qty <= 0) {
          log(`⏭️ 倉位太小或餘額不足`);
        } else {
          // v10: 停損 = 1.2x 1H ATR，最少 0.4%、最多 1.5%
          const minSlDist = price * 0.004; // 最少 0.4%
          const maxSlDist = price * 0.015; // 最多 1.5%
          const slDist = Math.min(Math.max(atrVal * SL_ATR_MULT, minSlDist), maxSlDist);
          const sl = signal.direction === 'LONG' ? price - slDist : price + slDist;
          
          // v10: 動態風報比檢查
          const riskPerUnit = slDist;
          const expectedReward = riskPerUnit * dynRR;
          const expectedProfitUsd = expectedReward * qty;
          const riskUsd = riskPerUnit * qty;
          
          if (expectedProfitUsd < dynMinProfit) {
            log(`⏭️ 預期利潤 $${expectedProfitUsd.toFixed(2)} < $${dynMinProfit.toFixed(1)}，不值得做（Lev:${dynLeverage}x RR:1:${dynRR} 風險:$${riskUsd.toFixed(2)}）`);
          } else {
          
          log(`🎯 進場! ${signal.direction} ${qty} ${SYMBOL} @ ~${price.toFixed(1)} | Lev:${dynLeverage}x | SL:${fmtPrice(sl)}(-$${riskUsd.toFixed(2)}) | RR 1:${dynRR} 目標:+$${expectedProfitUsd.toFixed(2)} | Score:${signal.score} | ${signal.strategy} | 確認:${confirmations} 情緒逆向:${sentimentContrarian ? '✅' : '➖'} | ${(signal.reasons || []).join(', ')}`);

          try {
            const order = await openPosition(signal.direction, qty, sl);
            state.position = {
              symbol: SYMBOL, side: signal.direction, entryPrice: price, size: qty,
              openTime: new Date().toISOString(), strategy: signal.strategy,
              stopLoss: sl, takeProfit: null, reasons: signal.reasons || [],
              leverage: dynLeverage, targetRR: dynRR
            };
            state.trailingStop = { initialStop: sl, currentStop: sl, lastUpdate: new Date().toISOString() };
            state.lastTradeTime = new Date().toISOString();
            log(`✅ 下單成功 orderId:${order.orderId} | Lev:${dynLeverage}x | RR:1:${dynRR}`);
          } catch (e) {
            log(`❌ 下單失敗: ${e.message}`);
          }
          } // end RR check
        }
      }
    }

    // (External closure detection moved to no-position branch above)

    state.status = 'RUNNING';
    state.lastBalance = balance.total;
    saveState(state);
    updateDashboard(state, balance, livePos, signal);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`✅ Cycle ${elapsed}s | $${balance.total.toFixed(2)} | BTC $${price.toFixed(0)} | Score: ${signal.score} ${signal.direction || '-'} | 底${signal.bottomConfirmations || 0} 頂${signal.topConfirmations || 0}`);

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

  if (symbolsToRun.length > 1) {
    try {
      const root = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : { symbols: {} };
      const states = Object.entries(root.symbols || {});
      if (states.length === 0) return;

      const now = new Date();
      const local = new Date(now.getTime() + 8 * 3600000).toISOString().replace('T', ' ').slice(0, 16);
      const allTrades = [];
      let totalPnl = 0, totalTodayPnl = 0, totalTrades = 0, totalWins = 0, totalLosses = 0, maxDD = 0;
      let activeState = null;
      let totalBalance = 0;
      const perSymbolSignals = {};

      for (const [sym, st] of states) {
        const ts = st.totalStats || {};
        const ds = st.dailyStats || {};
        totalPnl += ts.pnl || 0;
        totalTodayPnl += ds.pnl || 0;
        totalTrades += ts.trades || 0;
        totalWins += ts.wins || 0;
        totalLosses += ts.losses || 0;
        maxDD = Math.max(maxDD, ts.maxDrawdown || 0);
        totalBalance = Math.max(totalBalance, st.lastBalance || 0);
        if (Array.isArray(st.tradeHistory)) allTrades.push(...st.tradeHistory);
        if (!activeState && (st.position || st.lastAnalysis)) activeState = { symbol: sym, ...st };
        if (st.lastAnalysis) perSymbolSignals[sym] = { ...st.lastAnalysis };
      }

      allTrades.sort((a, b) => new Date(a.time) - new Date(b.time));
      const recentTrades = allTrades.slice(-10).reverse();
      const pos = activeState?.position ? {
        symbol: activeState.symbol,
        side: activeState.position.side,
        size: activeState.position.size,
        entryPrice: activeState.position.entryPrice,
        markPrice: activeState.position.markPrice || activeState.position.entryPrice,
        pnl: activeState.position.unrealizedPnl || 0,
        leverage: activeState.position.leverage || LEVERAGE,
        trailingStop: activeState.trailingStop?.currentStop || null
      } : null;

      const merged = {
        lastUpdate: local,
        status: 'RUNNING',
        mode: 'v11 順勢回踩+極端轉折',
        exchange: 'Binance Futures',
        account: {
          initialCapital: INITIAL_CAPITAL,
          balance: parseFloat((totalBalance || (INITIAL_CAPITAL + totalPnl)).toFixed(2)),
          available: parseFloat((totalBalance || (INITIAL_CAPITAL + totalPnl)).toFixed(2)),
          unrealizedPnl: 0,
          netEquity: parseFloat((totalBalance || (INITIAL_CAPITAL + totalPnl)).toFixed(2)),
          todayPnl: parseFloat(totalTodayPnl.toFixed(2)),
          totalPnl: parseFloat(totalPnl.toFixed(2)),
          leverage: `${LEVERAGE_MIN}-${LEVERAGE_MAX}x(動態)`,
          totalTrades,
          winRate: totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) + '%' : '--',
          wins: totalWins,
          losses: totalLosses,
          maxDrawdown: parseFloat(maxDD.toFixed(1))
        },
        position: pos,
        todayStats: {
          trades: states.reduce((sum, [, st]) => sum + (st.dailyStats?.trades || 0), 0),
          wins: states.reduce((sum, [, st]) => sum + (st.dailyStats?.wins || 0), 0),
          losses: states.reduce((sum, [, st]) => sum + (st.dailyStats?.losses || 0), 0),
          pnl: parseFloat(totalTodayPnl.toFixed(2)),
          remaining: MAX_DAILY_TRADES - states.reduce((sum, [, st]) => sum + (st.dailyStats?.trades || 0), 0)
        },
        totalStats: { trades: totalTrades, wins: totalWins, losses: totalLosses, pnl: parseFloat(totalPnl.toFixed(2)), winRate: totalTrades > 0 ? totalWins / totalTrades : 0, maxDrawdown: maxDD, peakBalance: 0 },
        signals: activeState?.lastAnalysis ? {
          score: activeState.lastAnalysis.score,
          direction: activeState.lastAnalysis.direction,
          strategy: activeState.lastAnalysis.strategy,
          marketState: activeState.lastAnalysis.marketState,
          trend4h: activeState.lastAnalysis.trend4h,
          session: activeState.lastAnalysis.session,
          reasons: activeState.lastAnalysis.reasons || [],
          checklist: activeState.lastAnalysis.checklist || [],
          checklistCount: activeState.lastAnalysis.checklistCount || 0,
          buyScore: activeState.lastAnalysis.buyScore,
          sellScore: activeState.lastAnalysis.sellScore
        } : null,
        perSymbolSignals,
        recentTrades,
        riskStatus: {
          dailyLossUsed: `$${Math.abs(Math.min(totalTodayPnl, 0)).toFixed(2)} / $${DAILY_LOSS_LIMIT.toFixed(2)}`,
          dailyTradesUsed: `${states.reduce((sum, [, st]) => sum + (st.dailyStats?.trades || 0), 0)} / ${MAX_DAILY_TRADES}`,
          consecutiveLosses: `${states.reduce((max, [, st]) => Math.max(max, st.dailyStats?.consecutiveLosses || 0), 0)} / ${CONSECUTIVE_LOSS_PAUSE}`,
          paused: states.some(([, st]) => st.dailyStats?.pauseUntil && new Date(st.dailyStats.pauseUntil) > now)
        }
      };

      fs.writeFileSync(DASHBOARD_FILE, JSON.stringify(merged, null, 2));
    } catch(e) { console.error(`⚠️ Merge dashboard error: ${e.message}`); }
  }
}

runAll().catch(e => { console.error(`💥 Fatal: ${e.message}`); process.exit(1); });
