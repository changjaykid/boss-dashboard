#!/usr/bin/env node
/**
 * 虛擬貨幣賺錢機 v2 — BTC/TWD 分批低買高賣
 * 
 * 核心邏輯：分批建倉、分批出場、靠均價取勝
 * 不追求完美進場點，而是在合理區間內持續累積
 * 
 * 策略：
 * 1. 根據技術面判斷「買入區間」和「賣出區間」
 * 2. 在買入區間內分 3 批建倉
 * 3. 在賣出區間內分 3 批出場
 * 4. 嚴格停損保護本金
 * 5. FGI 極度恐懼 = 加碼信號
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const TRADING_DIR = __dirname;
const DASHBOARD_DIR = path.join(__dirname, '..', 'boss-dashboard');
const MARKET_FILE = path.join(TRADING_DIR, 'money_maker_market.json');
const STATE_FILE = path.join(TRADING_DIR, 'money_maker_state.json');
const LOG_FILE = path.join(TRADING_DIR, 'money_maker_log.json');
const DASHBOARD_FILE = path.join(DASHBOARD_DIR, 'money-maker-data.json');
const CRYPTO_NEWS_FILE = path.join(DASHBOARD_DIR, 'crypto-news.json');

const CAPITAL = 10000;
const MAX_DAILY_LOSS = 800;          // 日虧上限
const MAX_TOTAL_LOSS = 2000;         // 總虧上限（保護 80% 本金）
const MAKER_FEE = 0.0008;
const TAKER_FEE = 0.0016;

// 分批設定
const GRID_LEVELS = 3;               // 分 3 批買入
const MIN_BUY_TWD = 300;             // 最小單筆買入金額（MAX 最低 250）
const MAX_TOTAL_POSITION = 6000;     // 最大總倉位（60% 資金）

function log(msg) {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function readJSON(fp, fb = null) {
  try { return JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { return fb; }
}

function writeJSON(fp, data) {
  fs.writeFileSync(fp, JSON.stringify(data, null, 2));
}

function getBalance() {
  try {
    const r = execSync(`/usr/local/bin/node ${path.join(TRADING_DIR, 'money_maker_order.js')} balance`, { encoding: 'utf8', timeout: 15000 });
    return JSON.parse(r);
  } catch (e) { log(`❌ 查餘額失敗: ${e.message}`); return null; }
}

function placeOrder(cmd) {
  try {
    const r = execSync(`/usr/local/bin/node ${path.join(TRADING_DIR, 'money_maker_order.js')} ${cmd}`, { encoding: 'utf8', timeout: 15000 });
    const trimmed = r.trim();
    let depth = 0, end = -1, start = -1;
    for (let i = trimmed.length - 1; i >= 0; i--) {
      if (trimmed[i] === '}') { if (end === -1) end = i; depth++; }
      else if (trimmed[i] === '{') { depth--; if (depth === 0) { start = i; break; } }
    }
    if (start >= 0 && end > start) {
      try { return JSON.parse(trimmed.slice(start, end + 1)); } catch {}
    }
    return null;
  } catch (e) { log(`❌ 下單失敗: ${e.message}`); return null; }
}

function fetchMarketData() {
  try {
    execSync(`/usr/local/bin/node ${path.join(TRADING_DIR, 'money_maker_fetch.js')}`, { encoding: 'utf8', timeout: 30000 });
    const data = readJSON(MARKET_FILE, null);
    if (!data) return null;
    const age = Date.now() - new Date(data.timestamp).getTime();
    if (age > 5 * 60 * 1000) { log(`⚠️ 資料過期 ${Math.round(age / 60000)} 分鐘`); return null; }
    return data;
  } catch (e) { log(`❌ 抓市場資料失敗: ${e.message}`); return null; }
}

function getFGI() {
  const news = readJSON(CRYPTO_NEWS_FILE, null);
  if (!news) return null;
  const str = JSON.stringify(news);
  const match = str.match(/fgi["\s:]+(\d+)/i) || str.match(/fearGreed["\s:]+(\d+)/i) || str.match(/"index["\s:]+(\d+)/);
  return match ? parseInt(match[1]) : null;
}

function getDefaultState() {
  return {
    version: 2,
    status: 'RUNNING',
    mode: 'grid_dca',
    // 持倉：多筆分批紀錄
    positions: [],       // [{ entryPrice, amount, twd, time, batch }]
    totalInvested: 0,    // 已投入台幣
    avgEntryPrice: 0,    // 加權平均成本
    totalBtc: 0,         // 持有 BTC 總量
    // 網格參數（動態計算）
    gridBuyZone: null,   // { low, mid, high } — 買入區間
    gridSellZone: null,  // { low, mid, high } — 賣出區間
    stopLoss: null,      // 硬停損價
    // 統計
    dailyPnl: 0,
    dailyDate: new Date().toISOString().slice(0, 10),
    totalPnl: 0,
    totalTrades: 0,
    wins: 0,
    losses: 0,
    maxDrawdown: 0,
    peakEquity: CAPITAL,
    pauseUntil: null,
    lastDecision: null,
    tradeLog: []
  };
}

function loadState() {
  let state = readJSON(STATE_FILE, null);
  if (!state || state.version !== 2) {
    // 保留舊 state 的統計數據
    const old = state || {};
    state = getDefaultState();
    state.totalPnl = old.totalPnl || 0;
    state.totalTrades = old.totalTrades || 0;
    state.wins = old.wins || 0;
    state.losses = old.losses || 0;
    state.maxDrawdown = old.maxDrawdown || 0;
    writeJSON(STATE_FILE, state);
  }
  const today = new Date().toISOString().slice(0, 10);
  if (state.dailyDate !== today) {
    state.dailyPnl = 0;
    state.dailyDate = today;
    state.pauseUntil = null;
  }
  return state;
}

// ============ 市場分析 ============

function analyzeMarket(market) {
  const m15 = market.indicators['15m'];
  const h1 = market.indicators['1h'];
  const h4 = market.indicators['4h'];
  const price = market.ticker.last;

  if (!m15 || !h1) return { action: 'WAIT', reason: '資料不完整', confidence: 0 };

  const rsi15 = m15.rsi || 50;
  const rsi1h = h1.rsi || 50;
  const atr = m15.atr || price * 0.005;
  const bb = m15.bollinger || {};
  const ema8 = m15.ema8 || price;
  const ema21 = m15.ema21 || price;
  const volRatio = m15.volumeRatio || 0;

  // 判斷市場狀態
  let marketState = 'NEUTRAL';
  let trend = 'NEUTRAL';

  // 1H 趨勢
  if (h1.emaRelation === 'bullish' && rsi1h > 45) trend = 'UP';
  else if (h1.emaRelation === 'bearish' && rsi1h < 55) trend = 'DOWN';

  // 4H 大趨勢
  let bigTrend = 'NEUTRAL';
  if (h4 && h4.trend) {
    if (h4.trend.includes('up')) bigTrend = 'UP';
    else if (h4.trend.includes('down')) bigTrend = 'DOWN';
  }

  // BB 寬度判斷波動率
  const bbWidth = bb.width || 1;
  if (bbWidth < 1) marketState = 'SQUEEZE';
  else if (bbWidth > 3) marketState = 'HIGH_VOL';
  else marketState = 'NORMAL';

  // ============ 買入信號 ============
  let buyScore = 0;
  let buyReasons = [];

  // RSI 超賣區
  if (rsi15 < 25) { buyScore += 3; buyReasons.push(`RSI極度超賣${rsi15.toFixed(0)}`); }
  else if (rsi15 < 30) { buyScore += 2; buyReasons.push(`RSI超賣${rsi15.toFixed(0)}`); }
  else if (rsi15 < 40) { buyScore += 1; buyReasons.push(`RSI偏低${rsi15.toFixed(0)}`); }

  // 價格在 BB 下軌附近
  if (bb.lower && price < bb.lower) { buyScore += 2; buyReasons.push('跌破BB下軌'); }
  else if (bb.lower && price < bb.lower * 1.003) { buyScore += 1; buyReasons.push('接近BB下軌'); }

  // EMA 支撐
  if (price > ema21 && price < ema21 * 1.002) { buyScore += 1; buyReasons.push('EMA21支撐'); }

  // MACD 底部翻轉
  if (m15.macd && m15.macd.histogram > m15.macd.prevHistogram && m15.macd.histogram < 0) {
    buyScore += 1; buyReasons.push('MACD柱縮短(底部收斂)');
  }
  if (m15.macd && m15.macd.histogram > 0 && m15.macd.prevHistogram <= 0) {
    buyScore += 2; buyReasons.push('MACD柱翻正');
  }

  // 1H 趨勢順向加分
  if (trend === 'UP') { buyScore += 1; buyReasons.push('1H趨勢向上'); }

  // FGI 極度恐懼 = 逆向做多
  const fgi = getFGI();
  if (fgi !== null && fgi <= 15) { buyScore += 2; buyReasons.push(`FGI=${fgi}極度恐懼(逆向買入)`); }
  else if (fgi !== null && fgi <= 25) { buyScore += 1; buyReasons.push(`FGI=${fgi}恐懼`); }

  // K 線型態
  if (m15.candlePatterns) {
    for (const p of m15.candlePatterns) {
      if (['bullish_engulfing', 'hammer', 'pin_bar_bullish', 'morning_star'].includes(p)) {
        buyScore += 1.5; buyReasons.push(`看多K線:${p}`);
      }
    }
  }

  // ============ 賣出信號 ============
  let sellScore = 0;
  let sellReasons = [];

  if (rsi15 > 75) { sellScore += 3; sellReasons.push(`RSI極度超買${rsi15.toFixed(0)}`); }
  else if (rsi15 > 70) { sellScore += 2; sellReasons.push(`RSI超買${rsi15.toFixed(0)}`); }
  else if (rsi15 > 60) { sellScore += 1; sellReasons.push(`RSI偏高${rsi15.toFixed(0)}`); }

  if (bb.upper && price > bb.upper) { sellScore += 2; sellReasons.push('突破BB上軌'); }
  else if (bb.upper && price > bb.upper * 0.997) { sellScore += 1; sellReasons.push('接近BB上軌'); }

  if (m15.macd && m15.macd.histogram < m15.macd.prevHistogram && m15.macd.histogram > 0) {
    sellScore += 1; sellReasons.push('MACD柱縮短(頂部收斂)');
  }
  if (m15.macd && m15.macd.histogram < 0 && m15.macd.prevHistogram >= 0) {
    sellScore += 2; sellReasons.push('MACD柱翻負');
  }

  if (trend === 'DOWN') { sellScore += 1; sellReasons.push('1H趨勢向下'); }

  if (m15.candlePatterns) {
    for (const p of m15.candlePatterns) {
      if (['bearish_engulfing', 'shooting_star', 'pin_bar_bearish', 'evening_star'].includes(p)) {
        sellScore += 1.5; sellReasons.push(`看空K線:${p}`);
      }
    }
  }

  // ============ 決策 ============
  let action = 'WAIT';
  let confidence = 0;
  let reasons = [];

  if (buyScore >= 3 && buyScore > sellScore * 1.5) {
    action = 'BUY_ZONE';
    confidence = Math.min(buyScore / 6, 1);
    reasons = buyReasons;
  } else if (sellScore >= 3 && sellScore > buyScore * 1.5) {
    action = 'SELL_ZONE';
    confidence = Math.min(sellScore / 6, 1);
    reasons = sellReasons;
  } else {
    reasons = [...buyReasons.slice(0, 2), ...sellReasons.slice(0, 2)];
    if (reasons.length === 0) reasons = ['無明確信號'];
  }

  return {
    action,
    confidence,
    reasons,
    price,
    rsi15,
    rsi1h,
    atr,
    trend,
    bigTrend,
    marketState,
    buyScore,
    sellScore,
    fgi,
    bbUpper: bb.upper,
    bbLower: bb.lower,
    bbMiddle: bb.middle
  };
}

// ============ 分批買入 ============

function executeBuy(state, analysis, balance) {
  const price = analysis.price;
  const availableTwd = balance.twd.available;
  const { confidence, atr, fgi } = analysis;

  // 計算這批要買多少
  let buyAmount = MIN_BUY_TWD;

  // 根據信心度調整
  if (confidence >= 0.8) buyAmount = 1500;
  else if (confidence >= 0.6) buyAmount = 1000;
  else if (confidence >= 0.4) buyAmount = 600;
  else buyAmount = MIN_BUY_TWD;

  // FGI 極度恐懼時加碼
  if (fgi !== null && fgi <= 15) {
    buyAmount = Math.min(buyAmount * 1.5, 2000);
    log(`🔥 FGI=${fgi} 極度恐懼，加碼買入`);
  }

  // 檢查：不超過最大倉位
  if (state.totalInvested + buyAmount > MAX_TOTAL_POSITION) {
    buyAmount = MAX_TOTAL_POSITION - state.totalInvested;
    if (buyAmount < MIN_BUY_TWD) {
      log(`⚠️ 已達最大倉位 NT$${state.totalInvested}/${MAX_TOTAL_POSITION}，不再加碼`);
      return state;
    }
  }

  // 檢查：餘額足夠
  if (availableTwd < buyAmount) {
    if (availableTwd >= MIN_BUY_TWD) {
      buyAmount = Math.floor(availableTwd / 100) * 100; // 取整百
    } else {
      log(`⚠️ 餘額不足 NT$${availableTwd.toFixed(0)}，無法買入`);
      return state;
    }
  }

  // 檢查：和上一筆買入間隔 > 5 分鐘（避免同價位重複買）
  if (state.positions.length > 0) {
    const lastBuy = state.positions[state.positions.length - 1];
    if (Date.now() - lastBuy.time < 5 * 60 * 1000) {
      log(`⏳ 距上次買入不到 5 分鐘，等待`);
      return state;
    }
    // 如果和上一筆價差 < 0.3%，也不買（避免同價堆疊）
    const priceDiff = Math.abs(price - lastBuy.entryPrice) / lastBuy.entryPrice;
    if (priceDiff < 0.003) {
      log(`⏳ 價差 ${(priceDiff * 100).toFixed(2)}% 太小，等更好的價位`);
      return state;
    }
  }

  // 下單
  log(`📥 分批買入第 ${state.positions.length + 1} 批：NT$${buyAmount} @ ~${price}`);
  const result = placeOrder(`buy_market ${buyAmount}`);

  if (!result || result.error) {
    log(`❌ 買入失敗: ${JSON.stringify(result)}`);
    return state;
  }

  // 更新持倉
  const btcAmount = buyAmount / price; // 估算
  const batch = {
    entryPrice: price,
    amount: btcAmount,
    twd: buyAmount,
    time: Date.now(),
    batch: state.positions.length + 1,
    reason: analysis.reasons.slice(0, 2).join(', ')
  };

  state.positions.push(batch);
  state.totalInvested += buyAmount;
  state.totalBtc += btcAmount;
  state.avgEntryPrice = state.totalInvested / state.totalBtc;

  // 設定停損：平均成本 - ATR * 2.5（給足空間）
  const slDistance = atr * 2.5;
  state.stopLoss = Math.round(state.avgEntryPrice - slDistance);

  log(`✅ 已買入 ${btcAmount.toFixed(8)} BTC | 均價 ${state.avgEntryPrice.toFixed(0)} | 停損 ${state.stopLoss} | 總倉位 NT$${state.totalInvested}`);

  return state;
}

// ============ 分批賣出 ============

function executeSell(state, analysis, balance) {
  const price = analysis.price;
  const btcAvailable = balance.btc.available;

  if (btcAvailable < 0.00001 || state.positions.length === 0) {
    log(`⚠️ 無 BTC 可賣`);
    state.positions = [];
    state.totalInvested = 0;
    state.totalBtc = 0;
    state.avgEntryPrice = 0;
    return state;
  }

  // 檢查獲利 %
  const pnlPct = (price - state.avgEntryPrice) / state.avgEntryPrice;

  // 獲利不到 0.3% 不急著賣（扣手續費後要有賺）
  const feesCost = TAKER_FEE * 2; // 買+賣手續費
  if (pnlPct < feesCost + 0.002) {
    log(`⏳ 獲利 ${(pnlPct * 100).toFixed(2)}% 尚不足以覆蓋手續費+利潤，繼續持有`);
    return state;
  }

  // 賣出量：根據獲利幅度決定
  let sellPct;
  if (pnlPct >= 0.015) { sellPct = 1.0; log(`💰 獲利 ${(pnlPct * 100).toFixed(2)}% ≥ 1.5%，全部出場`); }
  else if (pnlPct >= 0.01) { sellPct = 0.6; log(`💰 獲利 ${(pnlPct * 100).toFixed(2)}% ≥ 1%，賣 60%`); }
  else if (pnlPct >= 0.005) { sellPct = 0.4; log(`💰 獲利 ${(pnlPct * 100).toFixed(2)}% ≥ 0.5%，賣 40%`); }
  else { sellPct = 0.3; log(`💰 獲利 ${(pnlPct * 100).toFixed(2)}%，先賣 30% 鎖利`); }

  const sellBtc = Math.floor(btcAvailable * sellPct * 100000000) / 100000000;

  // MAX 最小賣出金額 250 TWD
  if (sellBtc * price < 250) {
    if (btcAvailable * price >= 250) {
      // 全賣
      return executeSellAll(state, analysis, balance, '金額太小改全賣');
    } else {
      log(`⚠️ 賣出金額不足 NT$250，跳過`);
      return state;
    }
  }

  // 和上次賣出間隔 > 5 分鐘
  if (state.lastSellTime && Date.now() - state.lastSellTime < 5 * 60 * 1000) {
    log(`⏳ 距上次賣出不到 5 分鐘，等待`);
    return state;
  }

  log(`📤 分批賣出 ${(sellPct * 100).toFixed(0)}%：${sellBtc.toFixed(8)} BTC @ ~${price}`);
  const result = placeOrder(`sell_market ${sellBtc}`);

  if (!result || result.error) {
    log(`❌ 賣出失敗: ${JSON.stringify(result)}`);
    return state;
  }

  const soldTwd = sellBtc * price;
  const pnl = soldTwd - (sellBtc / state.totalBtc * state.totalInvested);

  // 更新持倉
  state.totalBtc -= sellBtc;
  state.totalInvested -= (sellBtc / (state.totalBtc + sellBtc)) * state.totalInvested;
  state.lastSellTime = Date.now();

  if (state.totalBtc < 0.00001) {
    // 全部賣完
    state.positions = [];
    state.totalInvested = 0;
    state.totalBtc = 0;
    state.avgEntryPrice = 0;
    state.stopLoss = null;
  } else {
    // 移除最早的幾筆
    const removed = Math.ceil(state.positions.length * sellPct);
    state.positions = state.positions.slice(removed);
    state.avgEntryPrice = state.totalInvested / state.totalBtc;
  }

  // 記錄
  recordTrade(state, pnl, price, 'SELL_PARTIAL', analysis.reasons.slice(0, 2).join(', '));
  log(`✅ 賣出完成 | 損益 NT$${pnl.toFixed(0)} | 剩餘 ${state.totalBtc.toFixed(8)} BTC`);

  return state;
}

function executeSellAll(state, analysis, balance, reason) {
  const btcAvailable = balance.btc.available;
  const price = analysis.price;

  if (btcAvailable < 0.00001) return state;

  log(`📤 全部賣出：${btcAvailable.toFixed(8)} BTC @ ~${price} | ${reason}`);
  const result = placeOrder(`sell_market ${btcAvailable}`);

  if (!result || result.error) {
    log(`❌ 賣出失敗: ${JSON.stringify(result)}`);
    return state;
  }

  const soldTwd = btcAvailable * price;
  const pnl = soldTwd - state.totalInvested;

  recordTrade(state, pnl, price, 'SELL_ALL', reason);
  log(`✅ 全部賣出 | 損益 NT$${pnl.toFixed(0)}`);

  state.positions = [];
  state.totalInvested = 0;
  state.totalBtc = 0;
  state.avgEntryPrice = 0;
  state.stopLoss = null;
  state.lastSellTime = Date.now();

  return state;
}

function recordTrade(state, pnl, exitPrice, type, reason) {
  state.totalPnl += pnl;
  state.dailyPnl += pnl;
  state.totalTrades++;
  if (pnl >= 0) state.wins++;
  else state.losses++;

  const equity = CAPITAL + state.totalPnl;
  if (equity > state.peakEquity) state.peakEquity = equity;
  const dd = state.peakEquity - equity;
  if (dd > state.maxDrawdown) state.maxDrawdown = dd;

  let tradeLog = readJSON(LOG_FILE, []);
  if (!Array.isArray(tradeLog)) tradeLog = [];
  tradeLog.push({
    time: new Date().toISOString(),
    type,
    exitPrice,
    pnl: Math.round(pnl),
    reason,
    avgEntry: state.avgEntryPrice ? state.avgEntryPrice.toFixed(0) : 'N/A',
    totalPnl: Math.round(state.totalPnl)
  });
  if (tradeLog.length > 100) tradeLog = tradeLog.slice(-100);
  writeJSON(LOG_FILE, tradeLog);
}

// ============ 主控版更新 ============

function updateDashboard(state, market, analysis) {
  const balance = getBalance();
  const twdAvail = balance ? balance.twd.available : 0;
  const btcHeld = balance ? balance.btc.available : 0;
  const btcValue = btcHeld * (market ? market.ticker.last : 0);
  const netEquity = twdAvail + btcValue;

  const dashData = {
    lastUpdate: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).slice(0, 16),
    status: state.pauseUntil && Date.now() < state.pauseUntil ? 'PAUSED' : 'RUNNING',
    mode: '分批低買高賣 v2',
    capital: CAPITAL,
    available: Math.round(twdAvail),
    netEquity: Math.round(netEquity),
    todayPnl: Math.round(state.dailyPnl),
    totalPnl: Math.round(state.totalPnl),
    totalTrades: state.totalTrades,
    wins: state.wins,
    losses: state.losses,
    winRate: state.totalTrades > 0 ? `${((state.wins / state.totalTrades) * 100).toFixed(0)}%` : '--',
    maxDrawdown: Math.round(state.maxDrawdown),
    holdings: {
      btc: btcHeld,
      btcValue: Math.round(btcValue),
      avgEntry: state.avgEntryPrice ? Math.round(state.avgEntryPrice) : null,
      batches: state.positions.length,
      totalInvested: Math.round(state.totalInvested),
      unrealizedPnl: state.avgEntryPrice ? Math.round(btcValue - state.totalInvested) : 0,
      stopLoss: state.stopLoss
    },
    signals: analysis ? {
      action: analysis.action,
      buyScore: analysis.buyScore.toFixed(1),
      sellScore: analysis.sellScore.toFixed(1),
      rsi15: analysis.rsi15.toFixed(0),
      trend: analysis.trend,
      marketState: analysis.marketState,
      fgi: analysis.fgi || '--',
      reasons: analysis.reasons.slice(0, 4)
    } : null,
    btcPrice: market ? market.ticker.last : 0,
    btcChange24h: market ? parseFloat(market.ticker.change24h.toFixed(2)) : 0,
    recentTrades: (readJSON(LOG_FILE, []) || []).slice(-10).reverse(),
    dailyLimit: { maxLoss: MAX_DAILY_LOSS, currentLoss: Math.abs(Math.min(state.dailyPnl, 0)) },
    alerts: []
  };

  if (state.pauseUntil && Date.now() < state.pauseUntil) dashData.alerts.push('⛔ 暫停中');
  if (state.dailyPnl <= -MAX_DAILY_LOSS * 0.7) dashData.alerts.push(`⚠️ 日虧接近上限`);

  writeJSON(DASHBOARD_FILE, dashData);
  log(`📊 主控版已更新`);
}

// ============ MAIN ============

async function main() {
  log('🚀 賺錢機 v2 引擎啟動');

  let state = loadState();

  // 暫停檢查
  if (state.pauseUntil && Date.now() < state.pauseUntil) {
    log(`⏸️ 暫停中`);
    const market = readJSON(MARKET_FILE, null);
    if (market) updateDashboard(state, market, { action: 'WAIT', buyScore: 0, sellScore: 0, rsi15: 50, trend: 'N/A', marketState: 'PAUSED', fgi: null, reasons: ['暫停中'] });
    writeJSON(STATE_FILE, state);
    return;
  }

  // 日虧/總虧檢查
  if (state.dailyPnl <= -MAX_DAILY_LOSS) {
    log(`⛔ 日虧達上限 NT$${MAX_DAILY_LOSS}，今日停機`);
    state.pauseUntil = Date.now() + 86400000;
    writeJSON(STATE_FILE, state);
    return;
  }
  if (state.totalPnl <= -MAX_TOTAL_LOSS) {
    log(`⛔ 總虧達上限 NT$${MAX_TOTAL_LOSS}，停機等老闆指示`);
    state.status = 'STOPPED';
    writeJSON(STATE_FILE, state);
    return;
  }

  // 抓市場資料
  const market = fetchMarketData();
  if (!market) { log('❌ 無法取得市場資料'); return; }

  const price = market.ticker.last;
  log(`📈 BTC/TWD: ${price} | 24H: ${market.ticker.change24h >= 0 ? '+' : ''}${market.ticker.change24h.toFixed(2)}%`);

  // 分析
  const analysis = analyzeMarket(market);
  log(`🔍 判斷: ${analysis.action} (buy=${analysis.buyScore.toFixed(1)} sell=${analysis.sellScore.toFixed(1)}) | RSI=${analysis.rsi15.toFixed(0)} | ${analysis.trend} | FGI=${analysis.fgi || '--'}`);

  // 同步實際餘額
  const balance = getBalance();
  if (!balance) { log('❌ 無法取得餘額'); writeJSON(STATE_FILE, state); return; }

  // 同步 BTC 持倉（以實際帳戶為準）
  const actualBtc = balance.btc.available;
  if (state.totalBtc > 0 && actualBtc < 0.00001) {
    log(`⚠️ State 顯示有持倉但實際 BTC=0，清除 state`);
    state.positions = [];
    state.totalInvested = 0;
    state.totalBtc = 0;
    state.avgEntryPrice = 0;
    state.stopLoss = null;
  }

  // ============ 停損檢查（最高優先級）============
  if (state.stopLoss && state.totalBtc > 0 && price <= state.stopLoss) {
    log(`🛑 觸發停損！價格 ${price} ≤ 停損 ${state.stopLoss}`);
    state = executeSellAll(state, analysis, balance, `停損觸發 @ ${state.stopLoss}`);
    writeJSON(STATE_FILE, state);
    updateDashboard(state, market, analysis);
    return;
  }

  // ============ 決策執行 ============
  if (analysis.action === 'BUY_ZONE' && state.positions.length < GRID_LEVELS) {
    state = executeBuy(state, analysis, balance);
  } else if (analysis.action === 'SELL_ZONE' && state.totalBtc > 0) {
    state = executeSell(state, analysis, balance);
  } else if (state.totalBtc > 0) {
    // 持倉中但沒有明確信號 → 檢查是否該止盈
    const pnlPct = (price - state.avgEntryPrice) / state.avgEntryPrice;
    if (pnlPct >= 0.02) {
      log(`💰 獲利已達 ${(pnlPct * 100).toFixed(2)}%，主動止盈`);
      state = executeSellAll(state, analysis, balance, `獲利 ${(pnlPct * 100).toFixed(2)}% 主動止盈`);
    } else if (pnlPct <= -0.015) {
      // 虧超過 1.5% 但還沒到停損 → 檢查是否該減倉
      log(`⚠️ 浮虧 ${(pnlPct * 100).toFixed(2)}%，觀察中`);
    } else {
      log(`⏳ 持倉中 | 浮動 ${(pnlPct * 100).toFixed(2)}% | 均價 ${state.avgEntryPrice.toFixed(0)} | 停損 ${state.stopLoss || 'N/A'}`);
    }
  } else {
    log(`⏳ 等待信號... ${analysis.reasons.slice(0, 3).join(', ')}`);
  }

  state.lastDecision = {
    time: new Date().toISOString(),
    action: analysis.action,
    reasons: analysis.reasons.slice(0, 3).join(', '),
    price
  };

  writeJSON(STATE_FILE, state);
  updateDashboard(state, market, analysis);
  log('✅ 本輪完成');
}

main().catch(e => { log(`💥 引擎錯誤: ${e.message}`); process.exit(1); });
