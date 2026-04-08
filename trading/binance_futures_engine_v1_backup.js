#!/usr/bin/env node
/**
 * Binance USDT-M Futures 核心決策引擎
 * 每 3 分鐘由 cron 執行
 * 
 * 資金：466 USDT（背水一戰）
 * 槓桿：動態 3x-10x（根據信號強度和市場狀態自動調整）
 * 標的：BTCUSDT
 * 目標：24小時利潤最大化，嚴格風控保護本金
 *
 * 進階特性：
 * - 動態槓桿：盤整低槓桿，強信號高槓桿
 * - 滾動複利：連勝時逐步加大倉位
 * - 動量識別：分析近50根K線動量規律
 * - 時段感知：亞洲/歐洲/美洲盤波動特性
 */

const fs = require('fs');
const path = require('path');
const { getFullAnalysis, getFundingRate } = require('./binance_futures_fetch');

// ============ Config ============

const TRADING_DIR = __dirname;
const STATE_FILE = path.join(TRADING_DIR, 'binance_futures_state.json');
const LOG_FILE = path.join(TRADING_DIR, 'binance_futures_log.json');
const CRON_LOG = path.join(TRADING_DIR, 'binance_futures_cron.log');
const DASHBOARD_FILE = path.join(TRADING_DIR, '..', 'boss-dashboard', 'crypto-futures-data.json');
const CONFIG_FILE = path.join(TRADING_DIR, 'binance_futures_config.json');

const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

const SYMBOL = 'BTCUSDT';
const BASE_LEVERAGE = 5;
const MAX_LEVERAGE = 10;
const MIN_LEVERAGE = 3;
const MARGIN_TYPE = 'ISOLATED';
const INITIAL_CAPITAL = 466;

// Risk parameters
const MAX_LOSS_PER_TRADE_PCT = 0.02;    // 2% per trade
const DAILY_LOSS_LIMIT_PCT = 0.05;       // 5% daily loss cap
const DAILY_LOSS_LIMIT = INITIAL_CAPITAL * DAILY_LOSS_LIMIT_PCT;
const CONSECUTIVE_LOSS_PAUSE = 3;
const PAUSE_DURATION_MS = 60 * 60 * 1000; // 1 hour
const MIN_RR_RATIO = 1.5;                // Minimum risk:reward ratio
const MAX_POSITION_PCT = 0.35;           // Max 35% of balance per position
const DATA_FRESHNESS_MS = 5 * 60 * 1000; // 5 min max staleness

// Rolling compound: consecutive wins boost
const COMPOUND_WIN_BOOST = 0.05;  // +5% position size per consecutive win
const MAX_COMPOUND_BOOST = 0.20;  // Cap at +20%

// Session volatility windows (UTC hours)
const SESSIONS = {
  ASIA_PEAK:    { start: 1, end: 4 },    // 09:00-12:00 台灣
  EUROPE_OPEN:  { start: 7, end: 10 },   // 15:00-18:00 台灣  
  US_OPEN:      { start: 13, end: 16 },  // 21:00-00:00 台灣
  DEAD_ZONE:    { start: 20, end: 0 },   // 04:00-08:00 台灣（流動性最低）
};

// ============ State Management ============

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      // Validate critical fields
      if (!state.dailyStats) state.dailyStats = freshDailyStats();
      if (!state.position) state.position = null;
      if (!state.trailingStop) state.trailingStop = null;
      if (!state.strategyWeights) state.strategyWeights = defaultWeights();
      return state;
    }
  } catch (e) {
    log(`⚠️ State load error: ${e.message}`);
  }
  return defaultState();
}

function defaultWeights() {
  return {
    BREAKOUT: 1.0,
    TREND_FOLLOW: 1.0,
    REVERSAL: 0.8,
    MOMENTUM: 1.0,
    FUNDING_ARB: 0.7,
    NEWS_EVENT: 0.5
  };
}

function freshDailyStats() {
  return {
    date: new Date().toISOString().slice(0, 10),
    trades: 0, wins: 0, losses: 0,
    pnl: 0, bestTrade: 0, worstTrade: 0,
    consecutiveLosses: 0, consecutiveWins: 0, pauseUntil: null
  };
}

function defaultState() {
  return {
    status: 'RUNNING',
    position: null,
    trailingStop: null,
    dailyStats: freshDailyStats(),
    totalStats: {
      trades: 0, wins: 0, losses: 0,
      pnl: 0, winRate: 0, avgRR: 0,
      maxDrawdown: 0, peakBalance: INITIAL_CAPITAL
    },
    strategyWeights: defaultWeights(),
    lastAnalysis: null,
    lastTradeTime: null,
    tradeHistory: [],
    startTime: new Date().toISOString(),
    initialCapital: INITIAL_CAPITAL
  };
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function loadLog() {
  try {
    if (fs.existsSync(LOG_FILE)) return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  } catch {}
  return [];
}

function saveLog(entries) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(entries, null, 2));
}

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}\n`;
  fs.appendFileSync(CRON_LOG, line);
}

// ============ Binance API Helpers ============

const crypto = require('crypto');
const https = require('https');

function sign(qs) {
  return crypto.createHmac('sha256', config.secretKey).update(qs).digest('hex');
}

function apiRequest(method, endpoint, params = {}, signed = true) {
  return new Promise((resolve, reject) => {
    let qs = Object.entries(params).map(([k,v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    if (signed) {
      if (qs) qs += '&';
      qs += `timestamp=${Date.now()}`;
      qs += `&signature=${sign(qs)}`;
    }
    const url = method === 'GET' && qs ? `${endpoint}?${qs}` : endpoint;
    const urlObj = new URL(url, config.baseUrl);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method,
      headers: { 'X-MBX-APIKEY': config.apiKey, 'Content-Type': 'application/x-www-form-urlencoded' }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.code && parsed.code < 0) reject(new Error(`API ${parsed.code}: ${parsed.msg}`));
          else resolve(parsed);
        } catch { reject(new Error(`Parse: ${data.slice(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    if (method !== 'GET') req.write(qs);
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

async function getPositions() {
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
    liquidationPrice: parseFloat(pos.liquidationPrice),
    marginType: pos.marginType
  };
}

async function setupLeverageAndMargin() {
  try { await apiRequest('POST', '/fapi/v1/leverage', { symbol: SYMBOL, leverage: LEVERAGE }); } catch {}
  try { await apiRequest('POST', '/fapi/v1/marginType', { symbol: SYMBOL, marginType: MARGIN_TYPE }); } catch {}
}

async function openPosition(side, quantity, stopLossPrice) {
  // Market order to open
  const order = await apiRequest('POST', '/fapi/v1/order', {
    symbol: SYMBOL,
    side: side === 'LONG' ? 'BUY' : 'SELL',
    type: 'MARKET',
    quantity: quantity.toString()
  });

  // Set stop loss
  if (stopLossPrice) {
    const slSide = side === 'LONG' ? 'SELL' : 'BUY';
    try {
      await apiRequest('POST', '/fapi/v1/order', {
        symbol: SYMBOL,
        side: slSide,
        type: 'STOP_MARKET',
        stopPrice: stopLossPrice.toFixed(1),
        closePosition: 'true',
        workingType: 'MARK_PRICE'
      });
    } catch (e) {
      log(`⚠️ Stop loss order failed: ${e.message}`);
    }
  }

  return order;
}

async function closePosition() {
  const pos = await getPositions();
  if (!pos) return null;
  const side = pos.side === 'LONG' ? 'SELL' : 'BUY';
  
  // Cancel all open orders first (stop loss etc)
  try {
    await apiRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol: SYMBOL });
  } catch {}
  
  return await apiRequest('POST', '/fapi/v1/order', {
    symbol: SYMBOL,
    side,
    type: 'MARKET',
    quantity: pos.size.toString(),
    reduceOnly: 'true'
  });
}

async function updateStopLoss(newStopPrice) {
  // Cancel existing SL
  try {
    await apiRequest('DELETE', '/fapi/v1/allOpenOrders', { symbol: SYMBOL });
  } catch {}
  
  const pos = await getPositions();
  if (!pos) return;
  
  const slSide = pos.side === 'LONG' ? 'SELL' : 'BUY';
  await apiRequest('POST', '/fapi/v1/order', {
    symbol: SYMBOL,
    side: slSide,
    type: 'STOP_MARKET',
    stopPrice: newStopPrice.toFixed(1),
    closePosition: 'true',
    workingType: 'MARK_PRICE'
  });
}

// ============ Dynamic Leverage ============

function calculateDynamicLeverage(confidence, marketState, signals) {
  let leverage = BASE_LEVERAGE;
  
  // High confidence + trending = boost leverage
  if (confidence >= 5) leverage = 8;
  else if (confidence >= 4) leverage = 7;
  else if (confidence >= 3) leverage = 5;
  else leverage = MIN_LEVERAGE;
  
  // Market state adjustments
  if (marketState === 'CONSOLIDATING' || marketState === 'RANGING') {
    leverage = Math.max(MIN_LEVERAGE, leverage - 1); // Lower in choppy markets
  }
  if (marketState === 'HIGH_VOLATILITY') {
    leverage = Math.max(MIN_LEVERAGE, leverage - 2); // Much lower in high vol
  }
  if (marketState === 'TRENDING_UP' || marketState === 'TRENDING_DOWN') {
    leverage = Math.min(MAX_LEVERAGE, leverage + 1); // Boost in clear trends
  }
  
  // Session adjustment
  const hourUTC = new Date().getUTCHours();
  if (isInSession(hourUTC, SESSIONS.DEAD_ZONE)) {
    leverage = MIN_LEVERAGE; // Minimum during dead zone (插針風險高)
  }
  if (isInSession(hourUTC, SESSIONS.EUROPE_OPEN) || isInSession(hourUTC, SESSIONS.US_OPEN)) {
    leverage = Math.min(MAX_LEVERAGE, leverage + 1); // Boost during active sessions
  }
  
  return Math.min(MAX_LEVERAGE, Math.max(MIN_LEVERAGE, leverage));
}

function isInSession(hourUTC, session) {
  if (session.start < session.end) {
    return hourUTC >= session.start && hourUTC < session.end;
  }
  // Wrap around midnight
  return hourUTC >= session.start || hourUTC < session.end;
}

function getCurrentSession() {
  const hourUTC = new Date().getUTCHours();
  if (isInSession(hourUTC, SESSIONS.ASIA_PEAK)) return 'ASIA_PEAK';
  if (isInSession(hourUTC, SESSIONS.EUROPE_OPEN)) return 'EUROPE_OPEN';
  if (isInSession(hourUTC, SESSIONS.US_OPEN)) return 'US_OPEN';
  if (isInSession(hourUTC, SESSIONS.DEAD_ZONE)) return 'DEAD_ZONE';
  return 'TRANSITION';
}

// ============ Momentum Pattern Analysis ============

function analyzeMomentumPatterns(candles) {
  if (!candles || candles.length < 20) return { pattern: 'INSUFFICIENT_DATA', score: 0 };
  
  const recent = candles.slice(-50);
  const closes = recent.map(c => c.close);
  const volumes = recent.map(c => c.volume);
  
  // 1. Price momentum over different windows
  const mom5 = (closes[closes.length-1] - closes[closes.length-6]) / closes[closes.length-6] * 100;
  const mom10 = (closes[closes.length-1] - closes[closes.length-11]) / closes[closes.length-11] * 100;
  const mom20 = closes.length >= 21 ? (closes[closes.length-1] - closes[closes.length-21]) / closes[closes.length-21] * 100 : 0;
  
  // 2. Acceleration (momentum of momentum)
  const prevMom5 = (closes[closes.length-2] - closes[closes.length-7]) / closes[closes.length-7] * 100;
  const acceleration = mom5 - prevMom5;
  
  // 3. Volume-price divergence
  const priceUp = closes[closes.length-1] > closes[closes.length-6];
  const avgVolRecent = volumes.slice(-5).reduce((a,b)=>a+b,0) / 5;
  const avgVolPrev = volumes.slice(-10,-5).reduce((a,b)=>a+b,0) / 5;
  const volumeIncreasing = avgVolRecent > avgVolPrev * 1.2;
  const volumeDecreasing = avgVolRecent < avgVolPrev * 0.8;
  
  // 4. Identify consecutive candle patterns
  let consecutiveUp = 0, consecutiveDown = 0;
  for (let i = closes.length - 1; i >= Math.max(0, closes.length - 10); i--) {
    if (i > 0 && closes[i] > closes[i-1]) {
      if (consecutiveDown > 0) break;
      consecutiveUp++;
    } else if (i > 0 && closes[i] < closes[i-1]) {
      if (consecutiveUp > 0) break;
      consecutiveDown++;
    } else break;
  }
  
  let score = 0;
  let direction = 'neutral';
  const signals = [];
  
  // Strong upward momentum
  if (mom5 > 0.3 && mom10 > 0.5 && acceleration > 0) {
    score += 2;
    direction = 'bullish';
    signals.push('STRONG_UP_MOMENTUM');
  }
  // Strong downward momentum
  if (mom5 < -0.3 && mom10 < -0.5 && acceleration < 0) {
    score += 2;
    direction = 'bearish';
    signals.push('STRONG_DOWN_MOMENTUM');
  }
  // Volume confirms direction
  if (volumeIncreasing && ((direction === 'bullish' && priceUp) || (direction === 'bearish' && !priceUp))) {
    score += 1;
    signals.push('VOLUME_CONFIRMS');
  }
  // Volume divergence (warning)
  if (volumeDecreasing && ((priceUp && direction === 'bullish') || (!priceUp && direction === 'bearish'))) {
    score -= 1;
    signals.push('VOLUME_DIVERGENCE_WARN');
  }
  // Consecutive candles
  if (consecutiveUp >= 4) { score += 1; signals.push(`${consecutiveUp}_CONSEC_UP`); direction = direction || 'bullish'; }
  if (consecutiveDown >= 4) { score += 1; signals.push(`${consecutiveDown}_CONSEC_DOWN`); direction = direction || 'bearish'; }
  // Exhaustion signal
  if (consecutiveUp >= 6) { score -= 1; signals.push('POSSIBLE_EXHAUSTION_UP'); }
  if (consecutiveDown >= 6) { score -= 1; signals.push('POSSIBLE_EXHAUSTION_DOWN'); }
  
  return {
    pattern: direction,
    score: Math.abs(score),
    direction,
    mom5: parseFloat(mom5.toFixed(3)),
    mom10: parseFloat(mom10.toFixed(3)),
    mom20: parseFloat(mom20.toFixed(3)),
    acceleration: parseFloat(acceleration.toFixed(3)),
    consecutiveUp,
    consecutiveDown,
    volumeTrend: volumeIncreasing ? 'increasing' : volumeDecreasing ? 'decreasing' : 'stable',
    signals
  };
}

// ============ Signal Detection ============

function detectSignals(analysis) {
  const { timeframes, funding, marketState, price } = analysis;
  const tf15 = timeframes['15m'];
  const tf1h = timeframes['1h'];
  const tf4h = timeframes['4h'];
  
  const signals = {
    buySignals: [],
    sellSignals: [],
    buyScore: 0,
    sellScore: 0,
    strategies: {}
  };

  // === 4H Trend Direction (gate) ===
  let trend4h = 'neutral';
  if (tf4h.ema8 && tf4h.ema21) {
    if (tf4h.ema8 > tf4h.ema21) trend4h = 'bullish';
    else if (tf4h.ema8 < tf4h.ema21) trend4h = 'bearish';
  }

  // === Strategy 1: BREAKOUT ===
  if (tf15.bb) {
    const bbWidth = tf15.bb.width;
    if (bbWidth < 2 && price > tf15.bb.upper) {
      signals.buySignals.push('BB_BREAKOUT_UP');
      signals.buyScore += 2;
      signals.strategies.BREAKOUT = { direction: 'LONG', confidence: 2 };
    }
    if (bbWidth < 2 && price < tf15.bb.lower) {
      signals.sellSignals.push('BB_BREAKOUT_DOWN');
      signals.sellScore += 2;
      signals.strategies.BREAKOUT = { direction: 'SHORT', confidence: 2 };
    }
    // Volume confirmation for breakout
    if (tf15.volume && tf15.volume.ratio > 1.5) {
      if (signals.strategies.BREAKOUT) {
        signals.strategies.BREAKOUT.confidence += 1;
        if (signals.strategies.BREAKOUT.direction === 'LONG') signals.buyScore += 1;
        else signals.sellScore += 1;
      }
    }
  }

  // === Strategy 2: TREND_FOLLOW ===
  if (tf1h.ema8 && tf1h.ema21 && tf15.rsi !== null) {
    // Bullish trend: EMA8 > EMA21 on 1H, RSI pullback to 40-60 on 15m
    if (tf1h.ema8 > tf1h.ema21 && tf15.rsi >= 40 && tf15.rsi <= 60) {
      // Price near EMA21 on 15m (pullback)
      if (tf15.ema21 && Math.abs(price - tf15.ema21) / tf15.ema21 < 0.003) {
        signals.buySignals.push('TREND_PULLBACK_LONG');
        signals.buyScore += 2;
        signals.strategies.TREND_FOLLOW = { direction: 'LONG', confidence: 2 };
      }
    }
    // Bearish trend
    if (tf1h.ema8 < tf1h.ema21 && tf15.rsi >= 40 && tf15.rsi <= 60) {
      if (tf15.ema21 && Math.abs(price - tf15.ema21) / tf15.ema21 < 0.003) {
        signals.sellSignals.push('TREND_PULLBACK_SHORT');
        signals.sellScore += 2;
        signals.strategies.TREND_FOLLOW = { direction: 'SHORT', confidence: 2 };
      }
    }
  }

  // === Strategy 3: REVERSAL ===
  if (tf1h.rsi !== null) {
    if (tf1h.rsi < 25) {
      signals.buySignals.push('RSI_EXTREME_LOW');
      signals.buyScore += 2;
      signals.strategies.REVERSAL = { direction: 'LONG', confidence: 2 };
    }
    if (tf1h.rsi > 75) {
      signals.sellSignals.push('RSI_EXTREME_HIGH');
      signals.sellScore += 2;
      signals.strategies.REVERSAL = { direction: 'SHORT', confidence: 2 };
    }
  }
  // Pin bar / engulfing detection on 15m
  if (tf15.candles && tf15.candles.length >= 2) {
    const last = tf15.candles[tf15.candles.length - 1];
    const prev = tf15.candles[tf15.candles.length - 2];
    const bodyLast = Math.abs(last.close - last.open);
    const rangeLast = last.high - last.low;
    
    // Bullish pin bar (long lower wick)
    if (rangeLast > 0 && (Math.min(last.open, last.close) - last.low) / rangeLast > 0.65 && bodyLast / rangeLast < 0.25) {
      signals.buySignals.push('BULLISH_PIN_BAR');
      signals.buyScore += 1;
      if (signals.strategies.REVERSAL && signals.strategies.REVERSAL.direction === 'LONG') {
        signals.strategies.REVERSAL.confidence += 1;
      }
    }
    // Bearish pin bar (long upper wick)
    if (rangeLast > 0 && (last.high - Math.max(last.open, last.close)) / rangeLast > 0.65 && bodyLast / rangeLast < 0.25) {
      signals.sellSignals.push('BEARISH_PIN_BAR');
      signals.sellScore += 1;
      if (signals.strategies.REVERSAL && signals.strategies.REVERSAL.direction === 'SHORT') {
        signals.strategies.REVERSAL.confidence += 1;
      }
    }
    // Bullish engulfing
    if (prev.close < prev.open && last.close > last.open && last.close > prev.open && last.open < prev.close) {
      signals.buySignals.push('BULLISH_ENGULFING');
      signals.buyScore += 1.5;
    }
    // Bearish engulfing
    if (prev.close > prev.open && last.close < last.open && last.close < prev.open && last.open > prev.close) {
      signals.sellSignals.push('BEARISH_ENGULFING');
      signals.sellScore += 1.5;
    }
  }

  // === Strategy 4: MOMENTUM ===
  if (analysis.raw15m && analysis.raw15m.length >= 3) {
    const recent = analysis.raw15m.slice(-3);
    const momentum = (recent[2].close - recent[0].open) / recent[0].open * 100;
    if (Math.abs(momentum) > 0.5) {
      if (momentum > 0) {
        signals.buySignals.push(`MOMENTUM_UP_${momentum.toFixed(2)}%`);
        signals.buyScore += 1.5;
        signals.strategies.MOMENTUM = { direction: 'LONG', confidence: 1.5, momentum };
      } else {
        signals.sellSignals.push(`MOMENTUM_DOWN_${momentum.toFixed(2)}%`);
        signals.sellScore += 1.5;
        signals.strategies.MOMENTUM = { direction: 'SHORT', confidence: 1.5, momentum };
      }
      // MACD confirmation
      if (tf15.macd) {
        if (momentum > 0 && tf15.macd.histogram > 0 && tf15.macd.histogram > tf15.macd.prevHistogram) {
          signals.buyScore += 0.5;
          signals.buySignals.push('MACD_CONFIRM_UP');
        }
        if (momentum < 0 && tf15.macd.histogram < 0 && tf15.macd.histogram < tf15.macd.prevHistogram) {
          signals.sellScore += 0.5;
          signals.sellSignals.push('MACD_CONFIRM_DOWN');
        }
      }
    }
  }

  // === Strategy 5: FUNDING_ARB ===
  if (funding) {
    const rate = funding.nextFundingRate;
    if (rate > 0.0005) { // > 0.05%
      signals.sellSignals.push(`HIGH_FUNDING_${(rate*100).toFixed(3)}%`);
      signals.sellScore += 1;
      signals.strategies.FUNDING_ARB = { direction: 'SHORT', confidence: 1, rate };
    }
    if (rate < -0.0005) {
      signals.buySignals.push(`NEG_FUNDING_${(rate*100).toFixed(3)}%`);
      signals.buyScore += 1;
      signals.strategies.FUNDING_ARB = { direction: 'LONG', confidence: 1, rate };
    }
  }

  // === EMA alignment bonus ===
  if (tf15.ema8 && tf15.ema21 && tf15.ema55) {
    if (tf15.ema8 > tf15.ema21 && tf15.ema21 > tf15.ema55) {
      signals.buySignals.push('EMA_BULL_ALIGN');
      signals.buyScore += 1;
    }
    if (tf15.ema8 < tf15.ema21 && tf15.ema21 < tf15.ema55) {
      signals.sellSignals.push('EMA_BEAR_ALIGN');
      signals.sellScore += 1;
    }
  }

  // === MACD crossover ===
  if (tf15.macd) {
    if (tf15.macd.histogram > 0 && tf15.macd.prevHistogram <= 0) {
      signals.buySignals.push('MACD_BULL_CROSS');
      signals.buyScore += 1;
    }
    if (tf15.macd.histogram < 0 && tf15.macd.prevHistogram >= 0) {
      signals.sellSignals.push('MACD_BEAR_CROSS');
      signals.sellScore += 1;
    }
  }

  // === 4H trend gate: penalize counter-trend ===
  if (trend4h === 'bullish') {
    signals.sellScore *= 0.5; // Halve short signals against 4H uptrend
  } else if (trend4h === 'bearish') {
    signals.buyScore *= 0.5; // Halve long signals against 4H downtrend
  }

  // Apply strategy weights
  const state = loadState();
  for (const [strat, info] of Object.entries(signals.strategies)) {
    const weight = state.strategyWeights[strat] || 1.0;
    if (info.direction === 'LONG') signals.buyScore *= (1 + (weight - 1) * 0.5);
    if (info.direction === 'SHORT') signals.sellScore *= (1 + (weight - 1) * 0.5);
  }

  // === Momentum Pattern Analysis (50-bar) ===
  const momentumAnalysis = analyzeMomentumPatterns(analysis.raw15m);
  if (momentumAnalysis.score >= 2) {
    if (momentumAnalysis.direction === 'bullish') {
      signals.buySignals.push(...momentumAnalysis.signals);
      signals.buyScore += momentumAnalysis.score;
    } else if (momentumAnalysis.direction === 'bearish') {
      signals.sellSignals.push(...momentumAnalysis.signals);
      signals.sellScore += momentumAnalysis.score;
    }
  }

  // === Session awareness ===
  const session = getCurrentSession();
  if (session === 'DEAD_ZONE') {
    // Reduce all scores during dead zone (high 插針 risk)
    signals.buyScore *= 0.6;
    signals.sellScore *= 0.6;
    signals.buySignals.push('DEAD_ZONE_PENALTY');
    signals.sellSignals.push('DEAD_ZONE_PENALTY');
  }
  if (session === 'EUROPE_OPEN' || session === 'US_OPEN') {
    // Slight boost during active sessions
    signals.buyScore *= 1.1;
    signals.sellScore *= 1.1;
  }

  signals.trend4h = trend4h;
  signals.marketState = marketState;
  signals.session = session;
  signals.momentum = momentumAnalysis;
  return signals;
}

// ============ Position Sizing ============

function calculatePositionSize(balance, price, atr, confidence, leverage, state) {
  // Confidence-based sizing
  let pct;
  if (confidence >= 5) pct = MAX_POSITION_PCT;  // 35%
  else if (confidence >= 4) pct = 0.30;          // 30%
  else if (confidence >= 3) pct = 0.20;          // 20%
  else if (confidence >= 2) pct = 0.12;          // 12%
  else return 0; // Not enough confidence

  // Rolling compound: boost after consecutive wins
  const consecutiveWins = state.dailyStats ? countConsecutiveWins(state) : 0;
  if (consecutiveWins > 0) {
    const boost = Math.min(MAX_COMPOUND_BOOST, consecutiveWins * COMPOUND_WIN_BOOST);
    pct = Math.min(MAX_POSITION_PCT + MAX_COMPOUND_BOOST, pct + boost);
    log(`📈 Rolling compound: +${(boost*100).toFixed(0)}% size boost (${consecutiveWins} consecutive wins)`);
  }

  const effectiveLeverage = leverage || BASE_LEVERAGE;
  const margin = balance * pct;
  const notionalValue = margin * effectiveLeverage;
  let quantity = notionalValue / price;
  
  // Round to 3 decimal places (Binance BTC minimum)
  quantity = Math.floor(quantity * 1000) / 1000;
  
  // Ensure minimum order size (0.001 BTC for BTCUSDT)
  if (quantity < 0.001) return 0;
  
  // Verify max loss per trade (based on actual balance, not leveraged)
  const stopDistance = atr * 1.5; // Typical stop distance
  const maxLoss = quantity * stopDistance;
  const maxAllowed = balance * MAX_LOSS_PER_TRADE_PCT;
  
  if (maxLoss > maxAllowed) {
    quantity = Math.floor((maxAllowed / stopDistance) * 1000) / 1000;
  }
  
  return quantity;
}

function countConsecutiveWins(state) {
  const history = state.tradeHistory || [];
  let count = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].pnl > 0) count++;
    else break;
  }
  return count;
}

// ============ Trailing Stop Management ============

function manageTrailingStop(state, currentPrice) {
  if (!state.position || !state.trailingStop) return state;
  
  const pos = state.position;
  const ts = state.trailingStop;
  const entryPrice = pos.entryPrice;
  
  let pnlPct;
  if (pos.side === 'LONG') {
    pnlPct = ((currentPrice - entryPrice) / entryPrice) * 100;
  } else {
    pnlPct = ((entryPrice - currentPrice) / entryPrice) * 100;
  }

  // Trailing stop ladder
  let newStopLevel = ts.currentStop;
  
  if (pnlPct >= 3.0) {
    // Lock 50% of profits
    const lockPct = pnlPct * 0.5;
    if (pos.side === 'LONG') newStopLevel = entryPrice * (1 + lockPct / 100);
    else newStopLevel = entryPrice * (1 - lockPct / 100);
  } else if (pnlPct >= 2.0) {
    if (pos.side === 'LONG') newStopLevel = entryPrice * 1.015;
    else newStopLevel = entryPrice * 0.985;
  } else if (pnlPct >= 1.5) {
    if (pos.side === 'LONG') newStopLevel = entryPrice * 1.01;
    else newStopLevel = entryPrice * 0.99;
  } else if (pnlPct >= 1.0) {
    if (pos.side === 'LONG') newStopLevel = entryPrice * 1.006;
    else newStopLevel = entryPrice * 0.994;
  } else if (pnlPct >= 0.6) {
    if (pos.side === 'LONG') newStopLevel = entryPrice * 1.003;
    else newStopLevel = entryPrice * 0.997;
  } else if (pnlPct >= 0.3) {
    // Move to breakeven
    newStopLevel = entryPrice;
  }
  
  // Only tighten, never loosen
  if (pos.side === 'LONG' && newStopLevel > ts.currentStop) {
    ts.currentStop = newStopLevel;
    ts.lastUpdate = new Date().toISOString();
    ts.pnlPctAtUpdate = pnlPct;
    return { ...state, trailingStop: ts, needStopUpdate: true };
  }
  if (pos.side === 'SHORT' && newStopLevel < ts.currentStop) {
    ts.currentStop = newStopLevel;
    ts.lastUpdate = new Date().toISOString();
    ts.pnlPctAtUpdate = pnlPct;
    return { ...state, trailingStop: ts, needStopUpdate: true };
  }
  
  return state;
}

// ============ Dashboard Update ============

function updateDashboard(state, balance, livePosition, signals) {
  const now = new Date();
  const tzOffset = 8 * 60 * 60 * 1000;
  const localTime = new Date(now.getTime() + tzOffset).toISOString().replace('T', ' ').slice(0, 16);
  
  const ds = state.dailyStats;
  const ts = state.totalStats;
  
  const dashboard = {
    lastUpdate: localTime,
    status: state.status,
    mode: '背水一戰模式',
    exchange: 'Binance Futures',
    account: {
      initialCapital: INITIAL_CAPITAL,
      balance: balance ? balance.total : INITIAL_CAPITAL,
      available: balance ? balance.available : INITIAL_CAPITAL,
      unrealizedPnl: livePosition ? livePosition.unrealizedPnl : 0,
      netEquity: balance ? (balance.total + (livePosition ? livePosition.unrealizedPnl : 0)) : INITIAL_CAPITAL,
      todayPnl: ds.pnl,
      totalPnl: ts.pnl,
      leverage: livePosition ? livePosition.leverage : BASE_LEVERAGE,
      marginType: MARGIN_TYPE,
      totalTrades: ts.trades,
      winRate: ts.trades > 0 ? ((ts.wins / ts.trades) * 100).toFixed(1) + '%' : '--',
      wins: ts.wins,
      losses: ts.losses,
      maxDrawdown: ts.maxDrawdown
    },
    position: livePosition ? {
      symbol: SYMBOL,
      side: livePosition.side,
      size: livePosition.size,
      entryPrice: livePosition.entryPrice,
      markPrice: livePosition.markPrice,
      pnl: livePosition.unrealizedPnl,
      leverage: livePosition.leverage,
      liquidationPrice: livePosition.liquidationPrice,
      trailingStop: state.trailingStop ? state.trailingStop.currentStop : null
    } : null,
    todayStats: {
      trades: ds.trades,
      wins: ds.wins,
      losses: ds.losses,
      pnl: ds.pnl,
      bestTrade: ds.bestTrade,
      worstTrade: ds.worstTrade,
      consecutiveLosses: ds.consecutiveLosses
    },
    totalStats: ts,
    signals: signals ? {
      marketState: signals.marketState || 'N/A',
      trend4h: signals.trend4h || 'N/A',
      buyScore: signals.buyScore ? signals.buyScore.toFixed(1) : '0',
      sellScore: signals.sellScore ? signals.sellScore.toFixed(1) : '0',
      session: signals.session || getCurrentSession(),
      momentum: signals.momentum ? {
        direction: signals.momentum.direction,
        score: signals.momentum.score,
        mom5: signals.momentum.mom5,
        acceleration: signals.momentum.acceleration
      } : null,
      activeSignals: [...(signals.buySignals || []), ...(signals.sellSignals || [])].slice(0, 8)
    } : null,
    strategyWeights: state.strategyWeights,
    recentTrades: (state.tradeHistory || []).slice(-10).reverse(),
    riskStatus: {
      dailyLossUsed: `$${Math.abs(ds.pnl < 0 ? ds.pnl : 0).toFixed(2)} / $${DAILY_LOSS_LIMIT.toFixed(2)}`,
      consecutiveLosses: `${ds.consecutiveLosses} / ${CONSECUTIVE_LOSS_PAUSE}`,
      paused: ds.pauseUntil ? new Date(ds.pauseUntil) > new Date() : false
    },
    alerts: []
  };

  // Add alerts
  if (ds.pnl < -DAILY_LOSS_LIMIT * 0.7) dashboard.alerts.push('⚠️ 接近日虧上限');
  if (ds.consecutiveLosses >= 2) dashboard.alerts.push(`⚠️ 已連虧 ${ds.consecutiveLosses} 筆`);
  if (livePosition && Math.abs(livePosition.unrealizedPnl) > INITIAL_CAPITAL * 0.03) {
    dashboard.alerts.push(`📊 持倉 P/L ${livePosition.unrealizedPnl > 0 ? '+' : ''}$${livePosition.unrealizedPnl.toFixed(2)}`);
  }

  try {
    fs.writeFileSync(DASHBOARD_FILE, JSON.stringify(dashboard, null, 2));
  } catch (e) {
    log(`⚠️ Dashboard write error: ${e.message}`);
  }
}

// ============ Main Decision Engine ============

async function run() {
  const startTime = Date.now();
  let state = loadState();
  
  // Daily stats reset
  const today = new Date().toISOString().slice(0, 10);
  if (state.dailyStats.date !== today) {
    log(`📅 New day: ${today} — resetting daily stats`);
    state.dailyStats = freshDailyStats();
  }

  // Check pause
  if (state.dailyStats.pauseUntil && new Date(state.dailyStats.pauseUntil) > new Date()) {
    log(`⏸️ Paused until ${state.dailyStats.pauseUntil}`);
    saveState(state);
    return;
  }

  // Check daily loss limit
  if (state.dailyStats.pnl <= -DAILY_LOSS_LIMIT) {
    log(`🛑 Daily loss limit reached: $${state.dailyStats.pnl.toFixed(2)} — stopping for today`);
    state.status = 'DAILY_LIMIT';
    saveState(state);
    updateDashboard(state, null, null, null);
    return;
  }

  try {
    // Setup margin type (leverage set dynamically per trade)
    try { await apiRequest('POST', '/fapi/v1/marginType', { symbol: SYMBOL, marginType: MARGIN_TYPE }); } catch {}

    // Fetch data
    const [analysis, balance, livePosition] = await Promise.all([
      getFullAnalysis(SYMBOL),
      getBalance(),
      getPositions()
    ]);

    if (!analysis || !analysis.price) {
      log('❌ Failed to get market data');
      return;
    }

    state.lastAnalysis = {
      time: analysis.timestamp,
      price: analysis.price,
      marketState: analysis.marketState
    };

    const signals = detectSignals(analysis);
    const atr15 = analysis.timeframes['15m'].atr;

    // ====== POSITION MANAGEMENT ======
    if (livePosition) {
      log(`📊 Position: ${livePosition.side} ${livePosition.size} @ ${livePosition.entryPrice} | P/L: $${livePosition.unrealizedPnl.toFixed(2)} | Mark: ${livePosition.markPrice}`);
      
      // Sync state with live position
      if (!state.position) {
        state.position = {
          side: livePosition.side,
          entryPrice: livePosition.entryPrice,
          size: livePosition.size,
          openTime: new Date().toISOString(),
          strategy: 'UNKNOWN'
        };
      }

      // Manage trailing stop
      state = manageTrailingStop(state, livePosition.markPrice);
      
      if (state.needStopUpdate && state.trailingStop) {
        try {
          await updateStopLoss(state.trailingStop.currentStop);
          log(`🔄 Trailing stop updated to ${state.trailingStop.currentStop.toFixed(1)}`);
        } catch (e) {
          log(`⚠️ Failed to update trailing stop: ${e.message}`);
        }
        delete state.needStopUpdate;
      }

      // Check for reversal signals (close if strong opposite signal)
      const isLong = livePosition.side === 'LONG';
      const oppositeScore = isLong ? signals.sellScore : signals.buyScore;
      const sameScore = isLong ? signals.buyScore : signals.sellScore;
      
      if (oppositeScore >= 4 && oppositeScore > sameScore * 2) {
        log(`🔄 Strong reversal signal detected (score: ${oppositeScore}), closing position`);
        try {
          const closeResult = await closePosition();
          if (closeResult) {
            const pnl = livePosition.unrealizedPnl;
            recordTrade(state, pnl, state.position.strategy);
            state.position = null;
            state.trailingStop = null;
            log(`✅ Position closed for reversal, P/L: $${pnl.toFixed(2)}`);
          }
        } catch (e) {
          log(`❌ Close position failed: ${e.message}`);
        }
      }
    }
    // ====== NO POSITION — LOOK FOR ENTRY ======
    else {
      state.position = null;
      state.trailingStop = null;

      const maxScore = Math.max(signals.buyScore, signals.sellScore);
      const direction = signals.buyScore > signals.sellScore ? 'LONG' : 'SHORT';
      const confidence = maxScore;
      
      const session = getCurrentSession();
      log(`📈 Signals — Buy: ${signals.buyScore.toFixed(1)} | Sell: ${signals.sellScore.toFixed(1)} | Market: ${signals.marketState} | 4H: ${signals.trend4h} | Session: ${session}`);
      if (signals.momentum && signals.momentum.score > 0) {
        log(`📊 Momentum — ${signals.momentum.direction} | Score: ${signals.momentum.score} | 5m: ${signals.momentum.mom5}% | Accel: ${signals.momentum.acceleration} | Vol: ${signals.momentum.volumeTrend}`);
      }
      
      // Need minimum score of 3 to enter
      if (maxScore >= 3 && maxScore > Math.min(signals.buyScore, signals.sellScore) * 1.3) {
        // Dynamic leverage
        const dynamicLev = calculateDynamicLeverage(confidence, signals.marketState, signals);
        try { await apiRequest('POST', '/fapi/v1/leverage', { symbol: SYMBOL, leverage: dynamicLev }); } catch {}
        
        // Calculate position size with rolling compound
        const quantity = calculatePositionSize(balance.available, analysis.price, atr15 || analysis.price * 0.005, confidence, dynamicLev, state);
        
        if (quantity > 0) {
          // Calculate stop loss
          const slDistance = atr15 ? atr15 * 1.5 : analysis.price * 0.008;
          const stopLoss = direction === 'LONG' 
            ? analysis.price - slDistance 
            : analysis.price + slDistance;
          
          // Verify RR ratio
          const tpDistance = slDistance * MIN_RR_RATIO;
          const potentialProfit = quantity * tpDistance;
          const potentialLoss = quantity * slDistance;
          const rr = potentialProfit / potentialLoss;
          
          if (rr >= MIN_RR_RATIO) {
            // Determine primary strategy
            let primaryStrategy = 'MIXED';
            let maxConf = 0;
            for (const [strat, info] of Object.entries(signals.strategies)) {
              if (info.direction === direction && info.confidence > maxConf) {
                maxConf = info.confidence;
                primaryStrategy = strat;
              }
            }

            log(`🎯 ENTRY: ${direction} ${quantity} BTC @ ~${analysis.price} | SL: ${stopLoss.toFixed(1)} | Lev: ${dynamicLev}x | Strategy: ${primaryStrategy} | Confidence: ${confidence.toFixed(1)}`);
            
            try {
              const order = await openPosition(direction, quantity, stopLoss);
              
              state.position = {
                side: direction,
                entryPrice: analysis.price,
                size: quantity,
                openTime: new Date().toISOString(),
                strategy: primaryStrategy,
                stopLoss,
                signals: direction === 'LONG' ? signals.buySignals : signals.sellSignals
              };
              
              state.trailingStop = {
                initialStop: stopLoss,
                currentStop: stopLoss,
                lastUpdate: new Date().toISOString(),
                pnlPctAtUpdate: 0
              };

              state.lastTradeTime = new Date().toISOString();
              log(`✅ Order filled: ${JSON.stringify({ orderId: order.orderId, avgPrice: order.avgPrice, status: order.status })}`);
            } catch (e) {
              log(`❌ Order failed: ${e.message}`);
            }
          } else {
            log(`⏭️ RR ratio too low: ${rr.toFixed(2)} < ${MIN_RR_RATIO}`);
          }
        } else {
          log(`⏭️ Position size too small or balance insufficient`);
        }
      } else {
        log(`⏭️ No strong signal (max score: ${maxScore.toFixed(1)})`);
      }
    }

    // Check if position was closed by SL (compare state vs live)
    if (state.position && !livePosition) {
      // Position was closed (probably by stop loss)
      log(`📉 Position appears closed by SL/TP`);
      // We need to check recent trades to get actual PnL
      try {
        const recentTrades = await apiRequest('GET', '/fapi/v1/userTrades', { 
          symbol: SYMBOL, limit: 5 
        });
        if (recentTrades.length > 0) {
          // Sum recent trade PnL
          const totalPnl = recentTrades
            .filter(t => new Date(t.time) > new Date(state.position.openTime))
            .reduce((sum, t) => sum + parseFloat(t.realizedPnl), 0);
          
          if (totalPnl !== 0) {
            recordTrade(state, totalPnl, state.position.strategy);
            log(`📊 SL/TP closed — P/L: $${totalPnl.toFixed(2)}`);
          }
        }
      } catch (e) {
        log(`⚠️ Could not fetch trade history: ${e.message}`);
      }
      state.position = null;
      state.trailingStop = null;
    }

    // Save & update
    state.status = 'RUNNING';
    saveState(state);
    updateDashboard(state, balance, livePosition, signals);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    log(`✅ Cycle complete in ${elapsed}s | Balance: $${balance.total.toFixed(2)} | Price: $${analysis.price}`);

  } catch (e) {
    log(`❌ Engine error: ${e.message}\n${e.stack}`);
    state.status = 'ERROR';
    saveState(state);
    updateDashboard(state, null, null, null);
  }
}

function recordTrade(state, pnl, strategy) {
  const ds = state.dailyStats;
  ds.trades++;
  ds.pnl += pnl;
  
  if (pnl > 0) {
    ds.wins++;
    ds.consecutiveLosses = 0;
    ds.consecutiveWins = (ds.consecutiveWins || 0) + 1;
    if (pnl > ds.bestTrade) ds.bestTrade = pnl;
  } else {
    ds.losses++;
    ds.consecutiveLosses++;
    ds.consecutiveWins = 0;
    if (pnl < ds.worstTrade) ds.worstTrade = pnl;
    
    // Consecutive loss pause
    if (ds.consecutiveLosses >= CONSECUTIVE_LOSS_PAUSE) {
      ds.pauseUntil = new Date(Date.now() + PAUSE_DURATION_MS).toISOString();
      log(`⏸️ ${ds.consecutiveLosses} consecutive losses — pausing for 1 hour`);
    }
  }

  // Total stats
  const ts = state.totalStats;
  ts.trades++;
  if (pnl > 0) ts.wins++;
  else ts.losses++;
  ts.pnl += pnl;
  ts.winRate = ts.trades > 0 ? (ts.wins / ts.trades) : 0;
  
  const currentBalance = INITIAL_CAPITAL + ts.pnl;
  if (currentBalance > ts.peakBalance) ts.peakBalance = currentBalance;
  const drawdown = ((ts.peakBalance - currentBalance) / ts.peakBalance) * 100;
  if (drawdown > ts.maxDrawdown) ts.maxDrawdown = drawdown;

  // Trade history
  state.tradeHistory.push({
    time: new Date().toISOString(),
    symbol: SYMBOL,
    side: state.position ? state.position.side : 'UNKNOWN',
    entryPrice: state.position ? state.position.entryPrice : 0,
    pnl: parseFloat(pnl.toFixed(2)),
    strategy,
    signals: state.position ? state.position.signals : []
  });

  // Keep last 100 trades
  if (state.tradeHistory.length > 100) {
    state.tradeHistory = state.tradeHistory.slice(-100);
  }

  // Update strategy weights
  if (strategy && state.strategyWeights[strategy] !== undefined) {
    if (pnl > 0) {
      state.strategyWeights[strategy] = Math.min(2.0, state.strategyWeights[strategy] + 0.05);
    } else {
      state.strategyWeights[strategy] = Math.max(0.3, state.strategyWeights[strategy] - 0.08);
    }
  }

  // Save log
  const logEntries = loadLog();
  logEntries.push(state.tradeHistory[state.tradeHistory.length - 1]);
  saveLog(logEntries);
}

// ============ Entry ============

run().catch(e => {
  log(`💥 Fatal: ${e.message}\n${e.stack}`);
  process.exit(1);
});
