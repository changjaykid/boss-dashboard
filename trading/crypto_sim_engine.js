#!/usr/bin/env node
// 虛擬貨幣模擬交易引擎
// 背水一戰模式：30000 TWD，48小時利潤最大化，嚴格風控

const { MAX } = require('max-exchange-api-node');
const fs = require('fs');
const path = require('path');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'crypto_config.json'), 'utf8'));
const SIM_CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'crypto_sim_config.json'), 'utf8'));

const { rest } = new MAX({
  accessKey: CONFIG.api.access_key,
  secretKey: CONFIG.api.secret_key
});

const STATE_FILE = path.join(__dirname, 'crypto_sim_state.json');
const LOG_FILE = path.join(__dirname, 'crypto_sim_log.json');
const DASHBOARD_FILE = path.join(__dirname, '..', 'boss-dashboard', 'crypto-trading-data.json');

// ========== STATE MANAGEMENT ==========
function loadState() {
  if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  const initial = {
    capital: SIM_CONFIG.simulation.initial_capital_twd,
    available: SIM_CONFIG.simulation.initial_capital_twd,
    positions: [],
    closedTrades: [],
    totalTrades: 0,
    wins: 0,
    losses: 0,
    realizedPnl: 0,
    peakCapital: SIM_CONFIG.simulation.initial_capital_twd,
    maxDrawdown: 0,
    consecutiveLosses: 0,
    lastLossTime: null,
    pausedUntil: null,
    strategyStats: {},
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
  // 只保留最近 200 筆
  if (log.length > 200) log = log.slice(-200);
  fs.writeFileSync(LOG_FILE, JSON.stringify(log, null, 2));
}

// ========== TECHNICAL ANALYSIS ==========
function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

function calcEMA(data, period) {
  const k = 2 / (period + 1);
  let ema = data[0];
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcBollinger(closes, period = 20) {
  if (closes.length < period) return { upper: 0, middle: 0, lower: 0, width: 0 };
  const slice = closes.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const std = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period);
  return { upper: mean + 2 * std, middle: mean, lower: mean - 2 * std, width: (4 * std) / mean * 100 };
}

function calcMACD(closes) {
  if (closes.length < 26) return { macd: 0, signal: 0, histogram: 0 };
  const ema12 = calcEMA(closes.slice(-26), 12);
  const ema26 = calcEMA(closes.slice(-26), 26);
  const macd = ema12 - ema26;
  // 簡化 signal
  return { macd, signal: 0, histogram: macd };
}

function detectCandlePattern(candles) {
  if (candles.length < 3) return [];
  const patterns = [];
  const last = candles[candles.length - 1];
  const prev = candles[candles.length - 2];
  const body = Math.abs(last.close - last.open);
  const range = last.high - last.low;
  const upperWick = last.high - Math.max(last.open, last.close);
  const lowerWick = Math.min(last.open, last.close) - last.low;

  // Pin bar (錘子線/倒錘子線)
  if (lowerWick > body * 2 && upperWick < body * 0.5 && range > 0) {
    patterns.push({ name: 'bullish_pin_bar', direction: 'BUY', strength: 0.7 });
  }
  if (upperWick > body * 2 && lowerWick < body * 0.5 && range > 0) {
    patterns.push({ name: 'bearish_pin_bar', direction: 'SELL', strength: 0.7 });
  }

  // Engulfing (吞噬型態)
  const prevBody = Math.abs(prev.close - prev.open);
  if (prev.close < prev.open && last.close > last.open && body > prevBody * 1.2) {
    patterns.push({ name: 'bullish_engulfing', direction: 'BUY', strength: 0.8 });
  }
  if (prev.close > prev.open && last.close < last.open && body > prevBody * 1.2) {
    patterns.push({ name: 'bearish_engulfing', direction: 'SELL', strength: 0.8 });
  }

  // Doji (十字線 — 猶豫)
  if (body < range * 0.1 && range > 0) {
    patterns.push({ name: 'doji', direction: 'NEUTRAL', strength: 0.5 });
  }

  return patterns;
}

// ========== SIGNAL SCORING ==========
function analyzeMarket(candles_1h, candles_15m) {
  if (!candles_1h.length || !candles_15m.length) return null;

  const closes_1h = candles_1h.map(c => c.close);
  const closes_15m = candles_15m.map(c => c.close);
  const currentPrice = closes_15m[closes_15m.length - 1];

  const rsi_1h = calcRSI(closes_1h);
  const rsi_15m = calcRSI(closes_15m);
  const ema8 = calcEMA(closes_15m, 8);
  const ema21 = calcEMA(closes_15m, 21);
  const bb = calcBollinger(closes_15m);
  const macd = calcMACD(closes_15m);
  const patterns = detectCandlePattern(candles_15m);

  let buyScore = 0, sellScore = 0, signals = [];

  // RSI
  if (rsi_15m < 30) { buyScore += 1.5; signals.push(`RSI_15M超賣(${rsi_15m.toFixed(1)})`); }
  else if (rsi_15m < 40) { buyScore += 0.5; }
  if (rsi_15m > 70) { sellScore += 1.5; signals.push(`RSI_15M超買(${rsi_15m.toFixed(1)})`); }
  else if (rsi_15m > 60) { sellScore += 0.5; }

  if (rsi_1h < 35) { buyScore += 1; signals.push(`RSI_1H低檔(${rsi_1h.toFixed(1)})`); }
  if (rsi_1h > 65) { sellScore += 1; signals.push(`RSI_1H高檔(${rsi_1h.toFixed(1)})`); }

  // EMA 交叉
  if (ema8 > ema21) { buyScore += 1; signals.push('EMA8>21多頭'); }
  else { sellScore += 1; signals.push('EMA8<21空頭'); }

  // 布林帶
  if (currentPrice < bb.lower) { buyScore += 1.5; signals.push('觸布林下軌'); }
  if (currentPrice > bb.upper) { sellScore += 1.5; signals.push('觸布林上軌'); }
  if (bb.width < 2) { signals.push('布林擠壓中'); }

  // MACD
  if (macd.histogram > 0) { buyScore += 0.5; }
  else { sellScore += 0.5; }

  // K線型態
  for (const p of patterns) {
    if (p.direction === 'BUY') { buyScore += p.strength; signals.push(p.name); }
    if (p.direction === 'SELL') { sellScore += p.strength; signals.push(p.name); }
  }

  const maxScore = Math.max(buyScore, sellScore);
  const totalPossible = 7;
  const confidence = maxScore / totalPossible;
  const direction = buyScore > sellScore ? 'BUY' : 'SELL';

  return {
    direction,
    confidence,
    buyScore,
    sellScore,
    rsi_1h,
    rsi_15m,
    ema8,
    ema21,
    bb,
    macd,
    patterns,
    signals,
    currentPrice
  };
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
    return [];
  }
}

// ========== POSITION MANAGEMENT ==========
function checkPositions(state, tickers) {
  const toClose = [];
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

    // 止損
    if (pnlPct <= -SIM_CONFIG.risk_management.stop_loss_pct) {
      toClose.push({ pos, reason: 'STOP_LOSS', pnlPct, pnlTWD });
      continue;
    }

    // 止盈
    if (pnlPct >= SIM_CONFIG.risk_management.take_profit_min_pct) {
      // 移動止損：獲利超過 TP 後，如果回撤超過 trailing_stop 就平倉
      if (!pos.peakPnl || pnlPct > pos.peakPnl) pos.peakPnl = pnlPct;
      if (pos.peakPnl - pnlPct >= SIM_CONFIG.risk_management.trailing_stop_pct) {
        toClose.push({ pos, reason: 'TRAILING_STOP', pnlPct, pnlTWD });
      }
    }
  }
  return toClose;
}

// ========== MAIN ENGINE ==========
async function run() {
  const state = loadState();
  const rm = SIM_CONFIG.risk_management;
  const now = new Date();

  // 檢查是否到期（null = 無期限）
  if (SIM_CONFIG.simulation.end_time) {
    const endTime = new Date(SIM_CONFIG.simulation.end_time);
    if (now > endTime) {
      console.log('⏰ 模擬已結束');
      appendLog({ event: 'SIM_ENDED', capital: state.capital, pnl: state.realizedPnl });
      await updateDashboard(state);
      return;
    }
  }

  // 檢查暫停
  if (state.pausedUntil && now < new Date(state.pausedUntil)) {
    console.log(`⏸️ 暫停中，到 ${state.pausedUntil}`);
    await updateDashboard(state);
    return;
  }

  // 冷卻期
  if (state.lastLossTime) {
    const cooldownEnd = new Date(new Date(state.lastLossTime).getTime() + rm.cooldown_after_loss_minutes * 60000);
    if (now < cooldownEnd) {
      console.log(`❄️ 冷卻中，到 ${cooldownEnd.toISOString()}`);
      await updateDashboard(state);
      return;
    }
  }

  // 抓最新行情
  const tickers = [];
  for (const m of SIM_CONFIG.watchlist.twd_pairs) {
    try {
      const t = await rest.getTicker({ market: m });
      if (t && t.last) tickers.push({ market: m, last: t.last, open: t.open, high: t.high, low: t.low, vol: t.vol });
    } catch (e) {}
  }

  // 1. 檢查現有持倉 — 止損/止盈
  const toClose = checkPositions(state, tickers);
  for (const { pos, reason, pnlPct, pnlTWD } of toClose) {
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
      if (state.consecutiveLosses >= rm.max_consecutive_losses_before_pause) {
        state.pausedUntil = new Date(now.getTime() + rm.pause_duration_hours * 3600000).toISOString();
        appendLog({ event: 'PAUSED', reason: `${state.consecutiveLosses} consecutive losses`, until: state.pausedUntil });
      }
    }

    // 更新策略統計
    const strat = pos.strategy || 'unknown';
    if (!state.strategyStats[strat]) state.strategyStats[strat] = { wins: 0, losses: 0, pnl: 0 };
    state.strategyStats[strat].pnl += pnlTWD;
    if (pnlTWD >= 0) state.strategyStats[strat].wins++;
    else state.strategyStats[strat].losses++;

    // 最大回撤
    if (state.capital > state.peakCapital) state.peakCapital = state.capital;
    const dd = ((state.peakCapital - state.capital) / state.peakCapital) * 100;
    if (dd > state.maxDrawdown) state.maxDrawdown = dd;

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
      openTime: pos.openTime,
      closeTime: now.toISOString(),
      outcome: pnlTWD >= 0 ? 'WIN' : 'LOSS'
    };
    state.closedTrades.push(closedTrade);
    if (state.closedTrades.length > 50) state.closedTrades = state.closedTrades.slice(-50);

    appendLog({ event: 'CLOSE', ...closedTrade });
    console.log(`📍 平倉 ${pos.direction} ${pos.market} | ${reason} | PnL: $${pnlTWD.toFixed(2)} (${pnlPct.toFixed(2)}%)`);

    // 從持倉移除
    state.positions = state.positions.filter(p => p !== pos);
  }

  // 2. 找新機會
  if (state.positions.length < rm.max_concurrent_positions) {
    const exposure = state.positions.reduce((sum, p) => sum + p.sizeTWD, 0);
    const maxExposure = state.capital * (rm.max_total_exposure_pct / 100);
    const heldMarkets = state.positions.map(p => p.market);

    for (const m of SIM_CONFIG.watchlist.twd_pairs) {
      if (heldMarkets.includes(m)) continue;
      if (exposure >= maxExposure) break;
      if (state.positions.length >= rm.max_concurrent_positions) break;

      const candles_1h = await getCandles(m, 60, 100);
      const candles_15m = await getCandles(m, 15, 100);
      const analysis = analyzeMarket(candles_1h, candles_15m);

      if (!analysis || analysis.confidence < SIM_CONFIG.strategy.min_confidence) continue;

      // 滾動複利：根據資本調整倉位
      const riskAmount = state.capital * (rm.max_risk_per_trade_pct / 100);
      const sizeTWD = Math.min(riskAmount / (rm.stop_loss_pct / 100), maxExposure - exposure);
      if (sizeTWD < 100) continue; // 太小不做

      const newPos = {
        market: m,
        direction: analysis.direction,
        entryPrice: analysis.currentPrice,
        sizeTWD: Math.round(sizeTWD),
        strategy: analysis.signals.slice(0, 3).join('+'),
        signals: analysis.signals,
        confidence: Math.round(analysis.confidence * 100) / 100,
        rsi_15m: Math.round(analysis.rsi_15m * 10) / 10,
        rsi_1h: Math.round(analysis.rsi_1h * 10) / 10,
        openTime: now.toISOString(),
        peakPnl: 0
      };

      state.positions.push(newPos);
      state.available -= sizeTWD;

      appendLog({ event: 'OPEN', ...newPos });
      console.log(`🚀 開倉 ${analysis.direction} ${m} @ ${analysis.currentPrice} | 信心: ${(analysis.confidence * 100).toFixed(0)}% | 倉位: NT$${sizeTWD.toFixed(0)} | ${analysis.signals.join(', ')}`);
    }
  }

  saveState(state);
  await updateDashboard(state);
  console.log(`💰 資本: NT$${state.capital.toFixed(2)} | 持倉: ${state.positions.length} | 勝率: ${state.totalTrades > 0 ? ((state.wins / state.totalTrades) * 100).toFixed(1) : '--'}% | PnL: NT$${state.realizedPnl.toFixed(2)}`);
}

// ========== DASHBOARD UPDATE ==========
async function updateDashboard(state) {
  try {
    // 讀取現有數據
    let dashData = {};
    if (fs.existsSync(DASHBOARD_FILE)) {
      dashData = JSON.parse(fs.readFileSync(DASHBOARD_FILE, 'utf8'));
    }

    // 加入模擬交易數據
    const totalTrades = state.totalTrades;
    const winRate = totalTrades > 0 ? ((state.wins / totalTrades) * 100).toFixed(1) + '%' : '--';
    const elapsed = (new Date() - new Date(SIM_CONFIG.simulation.start_time)) / 3600000;
    const remaining = SIM_CONFIG.simulation.end_time ? Math.max(0, ((new Date(SIM_CONFIG.simulation.end_time) - new Date()) / 3600000)).toFixed(1) : 'unlimited';

    dashData.simulation = {
      enabled: true,
      status: (SIM_CONFIG.simulation.end_time && new Date() > new Date(SIM_CONFIG.simulation.end_time)) ? 'ENDED' : 'RUNNING',
      initialCapital: SIM_CONFIG.simulation.initial_capital_twd,
      currentCapital: Math.round(state.capital * 100) / 100,
      available: Math.round(state.available * 100) / 100,
      realizedPnl: Math.round(state.realizedPnl * 100) / 100,
      returnPct: Math.round(((state.capital - SIM_CONFIG.simulation.initial_capital_twd) / SIM_CONFIG.simulation.initial_capital_twd) * 10000) / 100,
      totalTrades,
      wins: state.wins,
      losses: state.losses,
      winRate,
      maxDrawdown: Math.round(state.maxDrawdown * 100) / 100,
      positions: state.positions.map(p => ({
        market: p.market,
        direction: p.direction,
        entryPrice: p.entryPrice,
        currentPrice: p.currentPrice || p.entryPrice,
        sizeTWD: p.sizeTWD,
        pnlPct: p.pnlPct || 0,
        pnlTWD: p.pnlTWD || 0,
        strategy: p.strategy,
        confidence: p.confidence,
        openTime: p.openTime
      })),
      closedTrades: state.closedTrades.slice(-15),
      strategyStats: state.strategyStats,
      consecutiveLosses: state.consecutiveLosses,
      pausedUntil: state.pausedUntil,
      hoursRemaining: remaining,
      lastUpdate: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })
    };

    fs.writeFileSync(DASHBOARD_FILE, JSON.stringify(dashData, null, 2));
  } catch (e) {
    console.error('Dashboard update error:', e.message);
  }
}

run().catch(e => {
  console.error('❌ Engine error:', e.message);
  appendLog({ event: 'ERROR', error: e.message });
});
