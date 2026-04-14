#!/usr/bin/env node
/**
 * 虛擬貨幣賺錢機 v9 — Grid Trading + 情緒過濾引擎
 *
 * v9 改版重點：
 * 1. Grid Trading：BTC 5格/1.5%/NT$1000、SOL 5格/2%/NT$1000
 * 2. 掛單簿情緒過濾（MAX orderbook bid/ask ratio）
 * 3. Binance 大戶多空比過濾
 * 4. 4H EMA20 趨勢過濾
 * 5. SOL 舊倉處理：均價 2649，target 2660 清倉後才啟動 grid
 * 6. 每 24h 重新平衡 grid 中心
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const https = require('https');

// ============ Markets ============
const ALL_MARKETS = ['btctwd', 'soltwd'];

const WORKER_DIR = path.join(__dirname, '..');
const TRADING_DIR = path.join(WORKER_DIR, 'data');
const DASHBOARD_DIR = WORKER_DIR;
const DASHBOARD_FILE = path.join(DASHBOARD_DIR, 'dashboard.json');

// ============ Grid 參數 ============
const GRID_CONFIGS = {
  btctwd: { grids: 5, spacing: 0.015, amountPerGrid: 1000, coin: 'btc', minAmount: 0.0001, decimals: 8, minTwd: 250 },
  soltwd: { grids: 5, spacing: 0.02,  amountPerGrid: 1000, coin: 'sol', minAmount: 0.09,   decimals: 4, minTwd: 250 },
};

const CAPITAL_PER_MARKET = 5000;
const TOTAL_CAPITAL = ALL_MARKETS.length * CAPITAL_PER_MARKET;
const MAKER_FEE = 0.0008;
const TAKER_FEE = 0.0016;
const GRID_REBALANCE_MS = 24 * 60 * 60 * 1000; // 24h

// SOL 舊倉
const SOL_LEGACY_AVG = 2649;
const SOL_LEGACY_TARGET = 2660;

function log(market, msg) {
  const line = `[${new Date().toISOString()}] [${market}] ${msg}`;
  console.log(line);
  try {
    fs.appendFileSync(path.join(TRADING_DIR, 'money_maker_cron.log'), line + '\n');
  } catch (_) {}
}

function readJSON(filepath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); } catch { return fallback; }
}

function writeJSON(filepath, data) {
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
}

// ============ State ============
const COMBINED_STATE_FILE = path.join(TRADING_DIR, 'state.json');

function getDefaultState() {
  return {
    version: 9,
    status: 'RUNNING',
    // Grid state
    gridMode: 'inactive',   // inactive | pending_legacy | active
    gridCenter: 0,
    gridSpacing: 0,
    gridLevels: [],          // [{price, side:'buy'|'sell', status:'empty'|'filled', filledAt, filledPrice}]
    gridLastReset: 0,
    gridPnl: 0,
    gridTrades: 0,
    // Legacy compat
    buyBatches: [],
    sellBatches: [],
    avgBuyPrice: 0,
    totalCoinHeld: 0,
    totalTwdInvested: 0,
    dailyPnl: 0,
    dailyDate: new Date().toISOString().slice(0, 10),
    totalPnl: 0,
    totalTrades: 0,
    wins: 0,
    losses: 0,
    consecutiveLosses: 0,
    maxDrawdown: 0,
    peakEquity: CAPITAL_PER_MARKET,
    pauseUntil: null,
    lastBuyTime: null,
    lastSellTime: null,
    lastAnalysis: null,
  };
}

function getDefaultCombinedState() {
  const markets = {};
  for (const market of ALL_MARKETS) markets[market] = getDefaultState();
  return { version: 9, status: 'RUNNING', markets, globalStats: { totalPnl: 0, totalTrades: 0, wins: 0, losses: 0, peakEquity: TOTAL_CAPITAL } };
}

function refreshGlobalStats(cs) {
  let totalPnl = 0, totalTrades = 0, wins = 0, losses = 0;
  for (const m of ALL_MARKETS) {
    const s = cs.markets[m] || getDefaultState();
    totalPnl += s.totalPnl || 0;
    totalTrades += s.totalTrades || 0;
    wins += s.wins || 0;
    losses += s.losses || 0;
  }
  cs.globalStats = { totalPnl, totalTrades, wins, losses, peakEquity: TOTAL_CAPITAL };
  cs.version = 9;
  cs.status = cs.status || 'RUNNING';
  return cs;
}

function loadCombinedState() {
  let cs = readJSON(COMBINED_STATE_FILE, null);
  if (!cs || !cs.markets) {
    cs = getDefaultCombinedState();
    // Migrate from old state
    for (const market of ALL_MARKETS) {
      const legacyFile = path.join(TRADING_DIR, `money_maker_state_${market}.json`);
      const old = readJSON(legacyFile, null) || {};
      const state = getDefaultState();
      for (const key of ['status','buyBatches','sellBatches','avgBuyPrice','totalCoinHeld','totalTwdInvested','dailyPnl','dailyDate','totalPnl','totalTrades','wins','losses','consecutiveLosses','maxDrawdown','peakEquity','pauseUntil','lastBuyTime','lastSellTime']) {
        if (old[key] !== undefined) state[key] = old[key];
      }
      if (old.totalBtcHeld && !state.totalCoinHeld) state.totalCoinHeld = old.totalBtcHeld;
      cs.markets[market] = state;
    }
    writeJSON(COMBINED_STATE_FILE, refreshGlobalStats(cs));
    log('SYSTEM', '📦 State 升級到 v9 (Grid Trading)');
  }
  for (const m of ALL_MARKETS) {
    if (!cs.markets[m]) cs.markets[m] = getDefaultState();
    // Ensure grid fields exist on old states
    const s = cs.markets[m];
    if (s.gridMode === undefined) s.gridMode = 'inactive';
    if (!s.gridLevels) s.gridLevels = [];
    if (!s.gridCenter) s.gridCenter = 0;
    if (!s.gridSpacing) s.gridSpacing = 0;
    if (!s.gridLastReset) s.gridLastReset = 0;
    if (!s.gridPnl) s.gridPnl = 0;
    if (!s.gridTrades) s.gridTrades = 0;
  }
  return refreshGlobalStats(cs);
}

function saveState(market, state) {
  const cs = loadCombinedState();
  cs.markets[market] = state;
  writeJSON(COMBINED_STATE_FILE, refreshGlobalStats(cs));
}

// ============ MAX API helpers ============

function getBalance() {
  try {
    const result = execSync(`/usr/local/bin/node ${path.join(__dirname, 'money_maker_order.js')} balance`, { encoding: 'utf8', timeout: 15000 });
    return JSON.parse(result.trim());
  } catch (e) {
    log('SYSTEM', `❌ 查餘額失敗: ${e.message}`);
    return null;
  }
}

function placeOrder(market, cmd) {
  try {
    const result = execSync(`/usr/local/bin/node ${path.join(__dirname, 'money_maker_order.js')} ${market} ${cmd}`, { encoding: 'utf8', timeout: 15000 });
    const trimmed = result.trim();
    let depth = 0, end = -1, start = -1;
    for (let i = trimmed.length - 1; i >= 0; i--) {
      if (trimmed[i] === '}') { if (end === -1) end = i; depth++; }
      else if (trimmed[i] === '{') { depth--; if (depth === 0) { start = i; break; } }
    }
    if (start >= 0 && end > start) {
      try { return JSON.parse(trimmed.slice(start, end + 1)); } catch (_) {}
    }
    return null;
  } catch (e) {
    log(market, `❌ 下單失敗: ${e.message}`);
    return null;
  }
}

function fetchMarketData(market) {
  const MARKET_FILE = path.join(TRADING_DIR, `money_maker_market_${market}.json`);
  try {
    execSync(`/usr/local/bin/node ${path.join(__dirname, 'money_maker_fetch.js')} ${market}`, { encoding: 'utf8', timeout: 30000 });
    const data = readJSON(MARKET_FILE, null);
    if (!data) return null;
    const dataAge = Date.now() - new Date(data.timestamp).getTime();
    if (dataAge > 15 * 60 * 1000) {
      log(market, `⚠️ 市場資料過期`);
      return null;
    }
    return data;
  } catch (e) {
    log(market, `❌ 抓市場資料失敗: ${e.message}`);
    return null;
  }
}

// ============ 情緒過濾 ============

function httpGetJSON(url, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function fetchOrderbookSentiment(market) {
  // Returns: { ratio, action: 'boost'|'pause'|'normal' }
  try {
    const data = await httpGetJSON(`https://max-api.maicoin.com/api/v2/depth?market=${market}&limit=20`);
    if (!data || !data.bids || !data.asks) return { ratio: 1, action: 'normal' };
    let bidVol = 0, askVol = 0;
    for (const b of data.bids) bidVol += parseFloat(b[1]);
    for (const a of data.asks) askVol += parseFloat(a[1]);
    if (askVol === 0) return { ratio: 99, action: 'normal' };
    const ratio = bidVol / askVol;
    let action = 'normal';
    if (ratio > 1.3) action = 'boost';
    else if (ratio < 0.7) action = 'pause';
    log(market, `📊 Orderbook sentiment: bid/ask=${ratio.toFixed(2)} → ${action}`);
    return { ratio, action };
  } catch (e) {
    log(market, `⚠️ Orderbook fetch error: ${e.message}`);
    return { ratio: 1, action: 'normal' };
  }
}

async function fetchBinanceLongShortRatio() {
  // Returns: { ratio, action: 'normal'|'boost'|'pause' }
  try {
    const data = await httpGetJSON('https://fapi.binance.com/futures/data/topLongShortPositionRatio?symbol=BTCUSDT&period=1h&limit=3');
    if (!data || !Array.isArray(data) || data.length === 0) return { ratio: 1, action: 'normal' };
    const latest = data[data.length - 1];
    const ratio = parseFloat(latest.longShortRatio);
    let action = 'normal';
    if (ratio > 1.05) action = 'boost';
    else if (ratio < 0.95) action = 'pause';
    log('BTC', `📊 Binance L/S ratio: ${ratio.toFixed(3)} → ${action}`);
    return { ratio, action };
  } catch (e) {
    log('BTC', `⚠️ Binance L/S fetch error: ${e.message}`);
    return { ratio: 1, action: 'normal' };
  }
}

function checkEMATrend(marketData) {
  // 4H EMA20 trend filter: price < EMA20 → pause buy
  if (!marketData || !marketData.indicators) return 'normal';
  const h4 = marketData.indicators['4h'];
  if (!h4 || !h4.ema20) return 'normal';
  const price = marketData.ticker.last;
  const ema20 = h4.ema20;
  if (price < ema20) {
    return 'pause'; // 4H EMA downtrend
  }
  return 'normal';
}

// ============ Grid Logic ============

function initGridLevels(centerPrice, gcfg) {
  // Create grid levels: grids below (buy) + grids above (sell)
  const levels = [];
  for (let i = 1; i <= gcfg.grids; i++) {
    // Buy levels below center
    levels.push({
      price: Math.round(centerPrice * (1 - gcfg.spacing * i)),
      side: 'buy',
      status: 'empty',
      filledAt: null,
      filledPrice: null,
    });
    // Sell levels above center
    levels.push({
      price: Math.round(centerPrice * (1 + gcfg.spacing * i)),
      side: 'sell',
      status: 'empty',
      filledAt: null,
      filledPrice: null,
    });
  }
  // Sort buy levels desc (closest first), sell levels asc
  levels.sort((a, b) => a.price - b.price);
  return levels;
}

function processGrid(state, market, currentPrice, gcfg, filters) {
  const { orderbookAction, binanceAction, emaTrend } = filters;
  const actions = []; // collect actions to execute

  // Check if grid needs rebalance (24h)
  if (state.gridLastReset && (Date.now() - state.gridLastReset) > GRID_REBALANCE_MS) {
    log(market, `🔄 Grid rebalance: old center=${state.gridCenter} → new center=${Math.round(currentPrice)}`);
    state.gridCenter = Math.round(currentPrice);
    state.gridLevels = initGridLevels(currentPrice, gcfg);
    state.gridLastReset = Date.now();
    return { state, actions };
  }

  // Should we pause buying?
  const pauseBuy = (orderbookAction === 'pause') ||
    (market === 'btctwd' && binanceAction === 'pause') ||
    (emaTrend === 'pause');

  if (pauseBuy) {
    log(market, `⏸️ Grid 買入暫停 (orderbook=${orderbookAction}, binance=${binanceAction}, ema=${emaTrend})`);
  }

  // Determine buy amount multiplier
  let buyMultiplier = 1.0;
  if (orderbookAction === 'boost') buyMultiplier = 1.2;
  if (market === 'btctwd' && binanceAction === 'boost') buyMultiplier *= 1.1;

  // Process buy levels (check if price dropped below an empty buy level)
  const buyLevels = state.gridLevels.filter(l => l.side === 'buy' && l.status === 'empty');
  for (const level of buyLevels) {
    if (currentPrice <= level.price && !pauseBuy) {
      const buyTwd = Math.round(gcfg.amountPerGrid * buyMultiplier);
      actions.push({ type: 'BUY', level, twd: buyTwd, reason: `Grid買(${level.price})${buyMultiplier > 1 ? ` x${buyMultiplier.toFixed(1)}` : ''}` });
      break; // One grid action per cycle
    }
  }

  // Process sell levels (check if price rose above a filled sell level)
  // A sell level becomes active when its corresponding buy level was filled
  // Strategy: when a buy level is filled, mark the next sell level above as 'filled' (ready to sell)
  const sellLevels = state.gridLevels.filter(l => l.side === 'sell' && l.status === 'filled');
  for (const level of sellLevels) {
    if (currentPrice >= level.price) {
      actions.push({ type: 'SELL', level, reason: `Grid賣(${level.price})` });
      break; // One grid action per cycle
    }
  }

  return { state, actions };
}

function findMatchingSellLevel(gridLevels, buyLevelPrice) {
  // Find the nearest empty sell level above the buy level
  const sellLevels = gridLevels
    .filter(l => l.side === 'sell' && l.status === 'empty')
    .sort((a, b) => a.price - b.price);
  return sellLevels.length > 0 ? sellLevels[0] : null;
}

// ============ Dashboard ============

function updateCombinedDashboard() {
  const combinedState = loadCombinedState();
  let totalEquity = 0, totalUnrealized = 0, totalRealized = 0;
  let totalTrades = 0, totalWins = 0, totalLosses = 0, totalConsecLosses = 0;
  const positions = [];
  const marketStats = {};
  let btcPrice = 0, btcChange24h = 0;

  for (const m of ALL_MARKETS) {
    const mFile = path.join(TRADING_DIR, `money_maker_market_${m}.json`);
    const state = combinedState.markets[m] || getDefaultState();
    const mData = readJSON(mFile, null);
    const price = mData && mData.ticker ? parseFloat(mData.ticker.last) : 0;
    const open = mData && mData.ticker ? parseFloat(mData.ticker.open) : 0;
    if (m === 'btctwd' && price > 0) { btcPrice = price; btcChange24h = open > 0 ? ((price - open) / open * 100) : 0; }

    const held = state.totalCoinHeld || 0;
    const invested = state.totalTwdInvested || 0;
    const value = held > 0 && price > 0 ? held * price : 0;
    const unrealized = value - invested;
    const cash = CAPITAL_PER_MARKET - invested;
    totalEquity += cash + value;
    totalUnrealized += unrealized;
    totalRealized += (state.totalPnl || 0);
    totalTrades += (state.totalTrades || 0);
    totalWins += (state.wins || 0);
    totalLosses += (state.losses || 0);
    totalConsecLosses = Math.max(totalConsecLosses, state.consecutiveLosses || 0);

    if (held > 0 && price > 0) {
      positions.push({ market: m, held: parseFloat(held.toFixed(8)), value: Math.round(value), avgEntry: Math.round(state.avgBuyPrice || 0), pnl: Math.round(unrealized) });
    }
    marketStats[m] = {
      trades: state.totalTrades || 0, wins: state.wins || 0, pnl: Math.round(state.totalPnl || 0),
      gridMode: state.gridMode || 'inactive', gridPnl: Math.round(state.gridPnl || 0), gridTrades: state.gridTrades || 0,
      gridCenter: state.gridCenter || 0,
      gridLevels: (state.gridLevels || []).map(l => ({ price: l.price, side: l.side, status: l.status })),
    };
  }

  const dashData = {
    lastUpdate: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace('T', ' ').slice(0, 16),
    status: 'RUNNING',
    mode: 'v9_grid_trading',
    capital: TOTAL_CAPITAL,
    totalEquity: Math.round(totalEquity),
    netEquity: Math.round(totalEquity),
    totalPnl: Math.round(totalRealized),
    btcPrice: Math.round(btcPrice),
    btcChange24h: parseFloat(btcChange24h.toFixed(2)),
    holdings: {
      btc: 0, avgCost: 0, unrealizedPnl: Math.round(totalUnrealized),
      positions: positions.map(p => ({ coin: p.market.replace('twd','').toUpperCase(), held: p.held, value: p.value, pnl: p.pnl }))
    },
    buyOrders: totalTrades, sellOrders: totalWins + totalLosses,
    consecutiveLosses: totalConsecLosses,
    nextAction: 'Grid Trading 運行中',
    signals: { technical: '--', news: '--', sentiment: '--', overall: 'Grid Trading' },
    dailyLimit: { remaining: 800 },
    positions, marketStats,
    riskStatus: {
      dailyLossLimit: 800, consecLossPause: 3,
      currentConsecLosses: totalConsecLosses,
      totalWinRate: totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) + '%' : '--',
      avgPnlPerTrade: totalTrades > 0 ? Math.round(totalRealized / totalTrades) : 0,
    },
    marketSignals: {}, recentTrades: [], checklists: {},
  };

  const btcPos = positions.find(p => p.market === 'btctwd');
  if (btcPos) { dashData.holdings.btc = btcPos.held; dashData.holdings.avgCost = btcPos.avgEntry; }

  // Market signals from indicators
  for (const m of ALL_MARKETS) {
    const mFile = path.join(TRADING_DIR, `money_maker_market_${m}.json`);
    const mData = readJSON(mFile, null);
    if (mData && mData.indicators) {
      const h1 = mData.indicators['1h'];
      const m15 = mData.indicators['15m'];
      const coin = m.replace('twd','').toUpperCase();
      const mPrice = mData.ticker ? mData.ticker.last : 0;
      const rsiVal = h1 && h1.rsi ? h1.rsi.toFixed(1) : (m15 && m15.rsi ? m15.rsi.toFixed(1) : '--');
      dashData.marketSignals[coin] = { price: Math.round(mPrice), rsi: rsiVal };
    }
  }

  // Recent trades
  const allTrades = [];
  for (const m of ALL_MARKETS) {
    const state = combinedState.markets[m] || getDefaultState();
    const coin = m.replace('twd','').toUpperCase();
    for (const b of (state.buyBatches || [])) {
      allTrades.push({ exitTime: b.time || 0, coin, side: 'BUY', amount: b.coin || 0, entryPrice: Math.round(b.price || 0), twd: b.twd || 0, pnl: 0, reason: b.reason || '' });
    }
    for (const s of (state.sellBatches || [])) {
      allTrades.push({ exitTime: s.time || 0, coin, side: 'SELL', amount: s.coin || 0, entryPrice: Math.round(s.buyPrice || 0), exitPrice: Math.round(s.price || 0), twd: s.twd || 0, pnl: s.pnl || 0, reason: s.reason || '' });
    }
  }
  allTrades.sort((a, b) => (b.exitTime || 0) - (a.exitTime || 0));
  dashData.recentTrades = allTrades.slice(0, 20);

  // API balance overlay
  try {
    const balData = getBalance();
    if (balData && balData.twd) {
      const twdCash = parseFloat(balData.twd.available || 0) + parseFloat(balData.twd.locked || 0);
      let strategyHoldingValue = 0;
      for (const p of positions) strategyHoldingValue += p.value;
      const legacyPositions = [];
      let legacyHoldingValue = 0;
      const legacyCfg = { eth: 'ethtwd', doge: 'dogetwd', avax: 'avaxtwd' };
      for (const [coin, mkt] of Object.entries(legacyCfg)) {
        const heldAmt = balData[coin] ? (parseFloat(balData[coin].available || 0) + parseFloat(balData[coin].locked || 0)) : 0;
        if (heldAmt > 0) {
          const mFile2 = path.join(TRADING_DIR, `money_maker_market_${mkt}.json`);
          const mData2 = readJSON(mFile2, null);
          if (mData2 && mData2.ticker) {
            const legacyVal = heldAmt * mData2.ticker.last;
            legacyHoldingValue += legacyVal;
            legacyPositions.push({ market: mkt, coin: coin.toUpperCase(), held: heldAmt, value: Math.round(legacyVal), avgEntry: 0, pnl: 0, note: 'legacy' });
          }
        }
      }
      dashData.totalEquity = Math.round(twdCash + strategyHoldingValue + legacyHoldingValue);
      dashData.netEquity = dashData.totalEquity;
      dashData.totalPnl = Math.round(dashData.totalEquity - TOTAL_CAPITAL);
      dashData.twdCash = Math.round(twdCash);
      dashData.positions = positions;
      dashData.legacyPositions = legacyPositions;
      dashData.strategyEquity = Math.round(twdCash + strategyHoldingValue);
      dashData.legacyEquity = Math.round(legacyHoldingValue);
    }
  } catch (e) { /* fallback */ }

  writeJSON(DASHBOARD_FILE, dashData);
  console.log(`📊 總主控版已更新`);
}

// ============ 處理遺留持倉 ============

function handleLegacyPositions() {
  const legacyMarkets = ['ethtwd', 'dogetwd'];
  const balance = getBalance();
  if (!balance) return;
  for (const m of legacyMarkets) {
    const cfg = { ethtwd: { coin: 'eth', min: 0.0037 }, dogetwd: { coin: 'doge', min: 80 } }[m];
    if (!cfg) continue;
    const held = balance[cfg.coin] ? balance[cfg.coin].available : 0;
    if (held >= cfg.min) {
      log('LEGACY', `⚠️ 發現舊持倉 ${cfg.coin.toUpperCase()}: ${held}，需手動處理`);
    }
  }
}

// ============ SOL 舊倉處理 ============

async function handleSolLegacy(balance, marketData) {
  if (!balance || !balance.sol) return false;
  const solHeld = parseFloat(balance.sol.available || 0);
  const gcfg = GRID_CONFIGS.soltwd;
  if (solHeld < gcfg.minAmount) return false; // No legacy position

  const price = marketData.ticker.last;
  log('soltwd', `🔄 SOL 舊倉: 持有=${solHeld.toFixed(4)}, 均價=${SOL_LEGACY_AVG}, 現價=${price}, 目標=${SOL_LEGACY_TARGET}`);

  if (price >= SOL_LEGACY_TARGET) {
    log('soltwd', `📤 SOL 舊倉達標 ${price} >= ${SOL_LEGACY_TARGET}，全部賣出`);
    const result = placeOrder('soltwd', `sell_market ${solHeld}`);
    if (result && !result.error) {
      const pnl = Math.round(solHeld * (price - SOL_LEGACY_AVG));
      log('soltwd', `✅ SOL 舊倉清倉完成，預估損益 NT$${pnl}`);
      // Record to trade log
      const LOG_FILE = path.join(TRADING_DIR, 'money_maker_log_soltwd.json');
      let tradeLog = readJSON(LOG_FILE, []);
      if (!Array.isArray(tradeLog)) tradeLog = [];
      tradeLog.push({ id: Date.now(), side: 'SELL', entryPrice: SOL_LEGACY_AVG, exitPrice: price, amount: solHeld, pnl, pnlPct: parseFloat(((price - SOL_LEGACY_AVG) / SOL_LEGACY_AVG * 100).toFixed(3)), time: new Date().toISOString(), reason: 'SOL舊倉清倉' });
      writeJSON(LOG_FILE, tradeLog);
      return false; // Cleared, grid can start next cycle
    } else {
      log('soltwd', `❌ SOL 舊倉賣出失敗`);
    }
  }
  return true; // Still holding legacy, don't start grid
}

// ============ 多幣種入口 ============

const inputMarket = process.argv[2];

if (!inputMarket) {
  (async () => {
    console.log(`🚀 賺錢機 v9 啟動（Grid Trading + 情緒過濾）`);

    // Fetch Binance L/S ratio once (shared for BTC)
    const binanceLSR = await fetchBinanceLongShortRatio();

    for (const m of ALL_MARKETS) {
      try {
        console.log(`\n========== 執行幣種: ${m} ==========`);
        // Pass binance data via env
        const env = { ...process.env, BINANCE_LS_ACTION: binanceLSR.action, BINANCE_LS_RATIO: String(binanceLSR.ratio) };
        execSync(`/usr/local/bin/node ${__filename} ${m}`, { stdio: 'inherit', env });
      } catch (e) {
        console.error(`❌ 執行 ${m} 失敗: ${e.message}`);
      }
    }
    handleLegacyPositions();
    updateCombinedDashboard();
  })();
  return;
}

// ============ 單幣種邏輯 ============

const MARKET = inputMarket;
const GCFG = GRID_CONFIGS[MARKET];
if (!GCFG) {
  console.log(`⚠️ ${MARKET} 不在 v9 交易列表中，跳過`);
  process.exit(0);
}
const COIN = GCFG.coin;
const MIN_COIN = GCFG.minAmount;
const LOG_FILE = path.join(TRADING_DIR, `money_maker_log_${MARKET}.json`);

function loadState() {
  const cs = loadCombinedState();
  let state = cs.markets[MARKET] || getDefaultState();
  const today = new Date().toISOString().slice(0, 10);
  if (state.dailyDate !== today) {
    state.dailyPnl = 0;
    state.dailyDate = today;
    state.pauseUntil = null;
    saveState(MARKET, state);
  }
  return state;
}

async function runMarket() {
  let state = loadState();

  if (state.pauseUntil && Date.now() < state.pauseUntil) {
    const remaining = Math.round((state.pauseUntil - Date.now()) / 60000);
    log(MARKET, `⏸️ 暫停中，${remaining}分鐘後恢復`);
    return;
  }

  const marketData = fetchMarketData(MARKET);
  if (!marketData) return;

  const balance = getBalance();
  if (!balance) return;

  const price = marketData.ticker.last;

  // === SOL 舊倉處理 ===
  if (MARKET === 'soltwd') {
    const hasLegacy = await handleSolLegacy(balance, marketData);
    if (hasLegacy) {
      log(MARKET, `⏳ SOL 舊倉未清，Grid 暫不啟動`);
      state.gridMode = 'pending_legacy';
      saveState(MARKET, state);
      return;
    }
  }

  // === 情緒過濾 ===
  const orderbookSentiment = await fetchOrderbookSentiment(MARKET);
  const binanceAction = process.env.BINANCE_LS_ACTION || 'normal';
  const binanceRatio = parseFloat(process.env.BINANCE_LS_RATIO || '1');
  const emaTrend = checkEMATrend(marketData);

  log(MARKET, `📊 價=${price} | orderbook=${orderbookSentiment.action}(${orderbookSentiment.ratio.toFixed(2)}) | binanceLS=${binanceAction}(${binanceRatio.toFixed(3)}) | ema4h=${emaTrend}`);

  // === 初始化或重新平衡 Grid ===
  if (state.gridMode === 'inactive' || state.gridMode === 'pending_legacy' || state.gridLevels.length === 0) {
    state.gridMode = 'active';
    state.gridCenter = Math.round(price);
    state.gridSpacing = GCFG.spacing;
    state.gridLevels = initGridLevels(price, GCFG);
    state.gridLastReset = Date.now();
    log(MARKET, `🔲 Grid 初始化: center=${state.gridCenter}, spacing=${(GCFG.spacing * 100).toFixed(1)}%, grids=${GCFG.grids}`);
    state.gridLevels.forEach(l => log(MARKET, `  ${l.side === 'buy' ? '🟢' : '🔴'} ${l.side} @ ${l.price} [${l.status}]`));
    saveState(MARKET, state);
    return; // First cycle just sets up the grid
  }

  // === Grid Rebalance (24h) ===
  if (Date.now() - state.gridLastReset > GRID_REBALANCE_MS) {
    log(MARKET, `🔄 Grid 24h rebalance: ${state.gridCenter} → ${Math.round(price)}`);
    // Preserve filled sell levels (open positions waiting to sell)
    const filledSells = state.gridLevels.filter(l => l.side === 'sell' && l.status === 'filled');
    state.gridCenter = Math.round(price);
    state.gridLevels = initGridLevels(price, GCFG);
    // Re-mark any sell levels that were filled (if price range overlaps)
    for (const fs of filledSells) {
      const closest = state.gridLevels.find(l => l.side === 'sell' && l.status === 'empty' && Math.abs(l.price - fs.price) / fs.price < 0.005);
      if (closest) {
        closest.status = 'filled';
        closest.filledAt = fs.filledAt;
        closest.filledPrice = fs.filledPrice;
      }
    }
    state.gridLastReset = Date.now();
    saveState(MARKET, state);
    log(MARKET, `🔲 Grid rebalanced`);
    return;
  }

  // === Process Grid ===
  const filters = { orderbookAction: orderbookSentiment.action, binanceAction, emaTrend };
  const { actions } = processGrid(state, MARKET, price, GCFG, filters);

  if (actions.length === 0) {
    log(MARKET, `😴 Grid 無觸發 (center=${state.gridCenter})`);
    // Log grid status
    const buyLevels = state.gridLevels.filter(l => l.side === 'buy');
    const sellLevels = state.gridLevels.filter(l => l.side === 'sell');
    log(MARKET, `  Buy levels: ${buyLevels.map(l => `${l.price}[${l.status}]`).join(', ')}`);
    log(MARKET, `  Sell levels: ${sellLevels.map(l => `${l.price}[${l.status}]`).join(', ')}`);
    saveState(MARKET, state);
    return;
  }

  for (const action of actions) {
    if (action.type === 'BUY') {
      const availableTwd = balance.twd ? balance.twd.available : 0;
      if (availableTwd < GCFG.minTwd) {
        log(MARKET, `⚠️ TWD 餘額不足 (${availableTwd})，跳過買入`);
        continue;
      }
      const buyTwd = Math.min(action.twd, availableTwd);
      log(MARKET, `📥 Grid BUY: NT$${buyTwd} @ level ${action.level.price} | ${action.reason}`);

      const result = placeOrder(MARKET, `buy_market ${buyTwd}`);
      if (result && !result.error) {
        const coinBought = buyTwd / price * (1 - TAKER_FEE);
        action.level.status = 'filled';
        action.level.filledAt = Date.now();
        action.level.filledPrice = price;

        // Mark corresponding sell level as filled (ready to sell)
        const sellLevel = findMatchingSellLevel(state.gridLevels, action.level.price);
        if (sellLevel) {
          sellLevel.status = 'filled';
          sellLevel.filledPrice = price; // entry price for PnL calc
          log(MARKET, `  ↔️ Sell level ${sellLevel.price} 啟動`);
        }

        // Update position tracking
        state.buyBatches.push({ price, twd: buyTwd, coin: coinBought, time: Date.now(), reason: action.reason });
        let totalTwd = 0, totalCoin = 0;
        for (const b of state.buyBatches) { totalTwd += b.twd; totalCoin += b.coin; }
        state.avgBuyPrice = totalTwd / totalCoin;
        state.totalCoinHeld = totalCoin;
        state.totalTwdInvested = totalTwd;
        state.totalTrades++;
        state.gridTrades++;

        log(MARKET, `✅ Grid BUY 成功 | ${coinBought.toFixed(6)} ${COIN.toUpperCase()} @ ${price}`);

        // Trade log
        let tradeLog = readJSON(LOG_FILE, []);
        if (!Array.isArray(tradeLog)) tradeLog = [];
        tradeLog.push({ id: Date.now(), side: 'BUY', entryPrice: price, amount: coinBought, twd: buyTwd, time: new Date().toISOString(), reason: action.reason });
        if (tradeLog.length > 100) tradeLog = tradeLog.slice(-100);
        writeJSON(LOG_FILE, tradeLog);
      } else {
        log(MARKET, `❌ Grid BUY 失敗: ${JSON.stringify(result)}`);
      }

    } else if (action.type === 'SELL') {
      const coinAvailable = balance[COIN] ? balance[COIN].available : 0;
      if (coinAvailable < MIN_COIN) {
        log(MARKET, `⚠️ ${COIN.toUpperCase()} 餘額不足 (${coinAvailable})，跳過賣出`);
        continue;
      }

      // Sell amount = 1 grid worth
      const sellTwd = GCFG.amountPerGrid;
      let sellCoin = sellTwd / price;
      sellCoin = Math.min(sellCoin, coinAvailable);
      if (sellCoin < MIN_COIN) continue;

      log(MARKET, `📤 Grid SELL: ${sellCoin.toFixed(6)} ${COIN.toUpperCase()} @ level ${action.level.price} | ${action.reason}`);

      const result = placeOrder(MARKET, `sell_market ${sellCoin}`);
      if (result && !result.error) {
        action.level.status = 'empty';
        const entryPrice = action.level.filledPrice || state.avgBuyPrice || price;
        const pnl = Math.round(sellCoin * (price - entryPrice) - sellCoin * price * (MAKER_FEE + TAKER_FEE));
        action.level.filledAt = null;
        action.level.filledPrice = null;

        state.totalPnl += pnl;
        state.dailyPnl += pnl;
        state.gridPnl += pnl;
        state.totalTrades++;
        state.gridTrades++;
        if (pnl >= 0) { state.wins++; state.consecutiveLosses = 0; }
        else { state.losses++; state.consecutiveLosses++; }

        // Update holdings
        state.totalCoinHeld = Math.max(0, (state.totalCoinHeld || 0) - sellCoin);
        state.totalTwdInvested = Math.max(0, (state.totalTwdInvested || 0) - sellTwd);
        if (state.totalCoinHeld < MIN_COIN) {
          state.buyBatches = [];
          state.totalCoinHeld = 0;
          state.totalTwdInvested = 0;
          state.avgBuyPrice = 0;
        }

        // Record sell batch for dashboard
        state.sellBatches.push({ price, coin: sellCoin, twd: sellTwd, pnl, buyPrice: entryPrice, time: Date.now(), reason: action.reason });
        if (state.sellBatches.length > 50) state.sellBatches = state.sellBatches.slice(-50);

        log(MARKET, `✅ Grid SELL 成功 | PnL: ${pnl >= 0 ? '+' : ''}NT$${pnl}`);

        // Trade log
        let tradeLog = readJSON(LOG_FILE, []);
        if (!Array.isArray(tradeLog)) tradeLog = [];
        tradeLog.push({ id: Date.now(), side: 'SELL', entryPrice, exitPrice: price, amount: sellCoin, pnl, pnlPct: parseFloat(((price - entryPrice) / entryPrice * 100).toFixed(3)), time: new Date().toISOString(), reason: action.reason });
        if (tradeLog.length > 100) tradeLog = tradeLog.slice(-100);
        writeJSON(LOG_FILE, tradeLog);

        // Pause rules
        if (state.consecutiveLosses >= 3) {
          state.pauseUntil = Date.now() + 3600000;
          log(MARKET, `⛔ 連虧3筆，暫停1小時`);
        }
        if (state.dailyPnl <= -800) {
          state.pauseUntil = Date.now() + 86400000;
          log(MARKET, `⛔ 日虧超限，今日停機`);
        }
      } else {
        log(MARKET, `❌ Grid SELL 失敗: ${JSON.stringify(result)}`);
      }
    }
  }

  // Update analysis info for dashboard
  state.lastAnalysis = {
    zone: 'GRID',
    gridCenter: state.gridCenter,
    gridMode: state.gridMode,
    orderbookSentiment: orderbookSentiment.action,
    binanceLS: binanceAction,
    emaTrend,
    updatedAt: new Date().toISOString(),
  };

  saveState(MARKET, state);
}

runMarket().catch(e => log(MARKET, `💥 錯誤: ${e.message}`));
