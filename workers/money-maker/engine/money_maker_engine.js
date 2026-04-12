#!/usr/bin/env node
/**
 * 虛擬貨幣賺錢機 v7 — BTC+SOL 集中火力波段引擎
 * 
 * v7 改版重點（老闆 2026-04-10 指示）：
 * 1. 砍到 2 幣（BTC+SOL），每幣 5,000 TWD
 * 2. 波段目標 3%+，不做小波段
 * 3. 修 RSI 邏輯：超買禁買、準備賣
 * 4. cron 從 3 分鐘改 10 分鐘
 * 5. 核心：做少、做大、賺的抱住
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ============ v7: 只做 BTC + SOL ============
const ALL_MARKETS = ['btctwd', 'soltwd'];

const WORKER_DIR = path.join(__dirname, '..');
const TRADING_DIR = path.join(WORKER_DIR, 'data');
const DASHBOARD_DIR = WORKER_DIR;
const DASHBOARD_FILE = path.join(DASHBOARD_DIR, 'dashboard.json');

// ============ 核心參數 ============
const CAPITAL_PER_MARKET = 5000;          // 每幣本金（從 2500 翻倍）
const TOTAL_CAPITAL = ALL_MARKETS.length * CAPITAL_PER_MARKET;
const DAILY_LOSS_LIMIT = 800;             // 日虧上限（提高，因為倉位加大）
const CONSEC_LOSS_PAUSE = 3;              // 連虧暫停
const MAKER_FEE = 0.0008;
const TAKER_FEE = 0.0016;
const ROUND_TRIP_FEE = MAKER_FEE + TAKER_FEE; // 0.24%
const MIN_PROFIT_PCT = 0.03;             // v7: 最小獲利目標 3%（從 0.5% 提高）
const MIN_TRADE_TWD = 300;               // 最低交易金額

const MARKET_CONFIGS = {
  btctwd:  { minAmount: 0.0001, decimals: 8, minTwd: 250, coin: 'btc' },
  soltwd:  { minAmount: 0.09,   decimals: 4, minTwd: 250, coin: 'sol' },
};

// v7: 分批買入，但拉大間距
const BUY_BATCHES = 3;
const BATCH_COOLDOWN_MS = 30 * 60 * 1000;  // v7: 30 分鐘冷卻（從 5 分鐘拉長）

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

// ============ Dashboard ============

function updateCombinedDashboard() {
  let totalEquity = 0;
  let totalUnrealized = 0;
  let totalRealized = 0;
  let totalTrades = 0;
  let totalWins = 0;
  let totalLosses = 0;
  let totalConsecLosses = 0;
  const positions = [];
  const marketStats = {};

  let btcPrice = 0;
  let btcChange24h = 0;

  for (const m of ALL_MARKETS) {
    const sFile = path.join(TRADING_DIR, `money_maker_state_${m}.json`);
    const mFile = path.join(TRADING_DIR, `money_maker_market_${m}.json`);
    const state = readJSON(sFile, getDefaultState());
    const mData = readJSON(mFile, null);

    const price = mData && mData.ticker ? parseFloat(mData.ticker.last) : 0;
    const open = mData && mData.ticker ? parseFloat(mData.ticker.open) : 0;

    if (m === 'btctwd' && price > 0) {
      btcPrice = price;
      btcChange24h = open > 0 ? ((price - open) / open * 100) : 0;
    }

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
      positions.push({
        market: m,
        held: parseFloat(held.toFixed(8)),
        value: Math.round(value),
        avgEntry: Math.round(state.avgBuyPrice || 0),
        pnl: Math.round(unrealized)
      });
    }

    marketStats[m] = {
      trades: state.totalTrades || 0,
      wins: state.wins || 0,
      pnl: Math.round(state.totalPnl || 0)
    };
  }

  const dashData = {
    lastUpdate: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace('T', ' ').slice(0, 16),
    status: 'RUNNING',
    mode: 'v7_concentrated_swing',
    capital: TOTAL_CAPITAL,
    totalEquity: Math.round(totalEquity),
    netEquity: Math.round(totalEquity),
    totalPnl: Math.round(totalRealized),
    btcPrice: Math.round(btcPrice),
    btcChange24h: parseFloat(btcChange24h.toFixed(2)),
    holdings: {
      btc: 0,
      avgCost: 0,
      unrealizedPnl: Math.round(totalUnrealized),
      positions: positions.map(p => ({
        coin: p.market.replace('twd','').toUpperCase(),
        held: p.held,
        value: p.value,
        pnl: p.pnl,
      }))
    },
    buyOrders: totalTrades,
    sellOrders: totalWins + totalLosses,
    consecutiveLosses: totalConsecLosses,
    fearGreedIndex: '--',
    nextAction: positions.length > 0 ? '持倉監控中' : '等待買入信號',
    signals: {
      technical: '--',
      news: '--',
      sentiment: '--',
      overall: '運行中'
    },
    dailyLimit: { remaining: DAILY_LOSS_LIMIT },
    positions,
    marketStats,
    riskStatus: {
      dailyLossLimit: DAILY_LOSS_LIMIT,
      consecLossPause: CONSEC_LOSS_PAUSE,
      currentConsecLosses: totalConsecLosses,
      totalWinRate: totalTrades > 0 ? ((totalWins / totalTrades) * 100).toFixed(1) + '%' : '--',
      avgPnlPerTrade: totalTrades > 0 ? Math.round(totalRealized / totalTrades) : 0,
    },
    marketSignals: {},
    recentTrades: [],
  };

  // BTC holdings
  const btcPos = positions.find(p => p.market === 'btctwd');
  if (btcPos) {
    dashData.holdings.btc = btcPos.held;
    dashData.holdings.avgCost = btcPos.avgEntry;
  }

  // 各幣種即時信號
  for (const m of ALL_MARKETS) {
    const mFile = path.join(TRADING_DIR, `money_maker_market_${m}.json`);
    const mData = readJSON(mFile, null);
    if (mData && mData.indicators) {
      const m15 = mData.indicators['15m'];
      const h1 = mData.indicators['1h'];
      const coin = m.replace('twd','').toUpperCase();
      const mPrice = mData.ticker ? mData.ticker.last : 0;
      const rsiVal = h1 && h1.rsi ? h1.rsi.toFixed(1) : (m15 && m15.rsi ? m15.rsi.toFixed(1) : '--');
      let bbPos = '--';
      if (h1 && h1.bollinger && mPrice > 0) {
        bbPos = (((mPrice - h1.bollinger.lower) / (h1.bollinger.upper - h1.bollinger.lower)) * 100).toFixed(0) + '%';
      }
      dashData.marketSignals[coin] = { price: Math.round(mPrice), rsi: rsiVal, bbPos };
    }
  }

  // 最近交易
  const allTrades = [];
  for (const m of ALL_MARKETS) {
    const sFile = path.join(TRADING_DIR, `money_maker_state_${m}.json`);
    const state = readJSON(sFile, getDefaultState());
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

  // 用 API 餘額覆蓋，但策略持倉與 legacy 持倉分開顯示，避免主控板殘影污染策略狀態
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
            legacyPositions.push({
              market: mkt,
              coin: coin.toUpperCase(),
              held: heldAmt,
              value: Math.round(legacyVal),
              avgEntry: 0,
              pnl: 0,
              note: 'legacy'
            });
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
  } catch(e) { /* fallback */ }

  writeJSON(DASHBOARD_FILE, dashData);
  console.log(`📊 總主控版已更新`);
}

// ============ 多幣種入口 ============

const inputMarket = process.argv[2];

if (!inputMarket) {
  (async () => {
    console.log(`🚀 賺錢機 v7 啟動（BTC+SOL 集中火力）`);
    for (const m of ALL_MARKETS) {
      try {
        console.log(`\n========== 執行幣種: ${m} ==========`);
        execSync(`/usr/local/bin/node ${__filename} ${m}`, { stdio: 'inherit' });
      } catch (e) {
        console.error(`❌ 執行 ${m} 失敗: ${e.message}`);
      }
    }
    // 處理遺留持倉（ETH/DOGE 等舊幣）
    handleLegacyPositions();
    updateCombinedDashboard();
  })();
  return;
}

// ============ 單幣種邏輯 ============

const MARKET = inputMarket;
const mcfg = MARKET_CONFIGS[MARKET];
if (!mcfg) {
  console.log(`⚠️ ${MARKET} 不在 v7 交易列表中，跳過`);
  process.exit(0);
}
const COIN = mcfg.coin;
const MIN_COIN = mcfg.minAmount;
const STATE_FILE = path.join(TRADING_DIR, `money_maker_state_${MARKET}.json`);
const MARKET_FILE = path.join(TRADING_DIR, `money_maker_market_${MARKET}.json`);
const LOG_FILE = path.join(TRADING_DIR, `money_maker_log_${MARKET}.json`);

function getDefaultState() {
  return {
    version: 7,
    status: 'RUNNING',
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
  };
}

function loadState() {
  let state = readJSON(STATE_FILE, null);
  if (!state || state.version < 7) {
    const old = state || {};
    state = getDefaultState();
    // 保留歷史績效
    state.totalPnl = old.totalPnl || 0;
    state.totalTrades = old.totalTrades || 0;
    state.wins = old.wins || 0;
    state.losses = old.losses || 0;
    state.totalCoinHeld = old.totalCoinHeld || old.totalBtcHeld || 0;
    state.maxDrawdown = old.maxDrawdown || 0;
    state.peakEquity = old.peakEquity || CAPITAL_PER_MARKET;
    // 如果有舊持倉，保留
    if (old.buyBatches && old.buyBatches.length > 0) {
      state.buyBatches = old.buyBatches;
      state.avgBuyPrice = old.avgBuyPrice || 0;
      state.totalTwdInvested = old.totalTwdInvested || 0;
    }
    writeJSON(STATE_FILE, state);
    log(MARKET, `📦 State 升級到 v7`);
  }
  const today = new Date().toISOString().slice(0, 10);
  if (state.dailyDate !== today) {
    state.dailyPnl = 0;
    state.dailyDate = today;
    state.pauseUntil = null;
  }
  return state;
}

function getBalance() {
  try {
    const result = execSync(`/usr/local/bin/node ${path.join(__dirname, 'money_maker_order.js')} balance`, { encoding: 'utf8', timeout: 15000 });
    return JSON.parse(result.trim());
  } catch (e) {
    log(MARKET, `❌ 查餘額失敗: ${e.message}`);
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
    log(MARKET, `❌ 下單失敗: ${e.message}`);
    return null;
  }
}

function fetchMarketData(market) {
  try {
    execSync(`/usr/local/bin/node ${path.join(__dirname, 'money_maker_fetch.js')} ${market}`, { encoding: 'utf8', timeout: 30000 });
    const data = readJSON(MARKET_FILE, null);
    if (!data) return null;
    const dataAge = Date.now() - new Date(data.timestamp).getTime();
    if (dataAge > 15 * 60 * 1000) { // v7: 放寬到 15 分鐘（配合 10 分鐘 cron）
      log(MARKET, `⚠️ 市場資料過期`);
      return null;
    }
    return data;
  } catch (e) {
    log(MARKET, `❌ 抓市場資料失敗: ${e.message}`);
    return null;
  }
}

// ============ v7 市場分析：修正 RSI 邏輯 + 以 1H 為主 ============

function analyzePosition(market) {
  if (!market || !market.indicators) return { zone: 'NEUTRAL', buyScore: 0, sellScore: 0, reasons: [], rsi: null };

  const m15 = market.indicators['15m'];
  const h1 = market.indicators['1h'];
  const h4 = market.indicators['4h'];
  const price = market.ticker.last;

  if (!m15 || !h1 || !h4) return { zone: 'NEUTRAL', buyScore: 0, sellScore: 0, reasons: [], rsi: null };

  let buyScore = 0;
  let sellScore = 0;
  let reasons = [];

  // v7: 以 1H RSI 為主判斷（不再用 15m 雜訊）
  const rsi = h1.rsi || m15.rsi;

  // === 1. RSI — v7 修正：超買 = 禁買 + 賣出信號 ===
  if (rsi <= 20) { buyScore += 5; reasons.push(`RSI極度超賣${rsi.toFixed(0)}`); }
  else if (rsi <= 30) { buyScore += 4; reasons.push(`RSI超賣${rsi.toFixed(0)}`); }
  else if (rsi <= 35) { buyScore += 2.5; reasons.push(`RSI偏低${rsi.toFixed(0)}`); }
  else if (rsi <= 40) { buyScore += 1.5; reasons.push(`RSI回調${rsi.toFixed(0)}`); }
  else if (rsi >= 80) { sellScore += 5; buyScore -= 3; reasons.push(`RSI極度超買${rsi.toFixed(0)}⛔`); }
  else if (rsi >= 75) { sellScore += 4; buyScore -= 2; reasons.push(`RSI超買${rsi.toFixed(0)}⛔`); }
  else if (rsi >= 70) { sellScore += 3; buyScore -= 1.5; reasons.push(`RSI偏高${rsi.toFixed(0)}⚠️`); }
  else if (rsi >= 65) { sellScore += 1.5; reasons.push(`RSI偏強${rsi.toFixed(0)}`); }
  // 50-65 中性，不加分

  // === 2. Bollinger Bands（1H 為主）===
  const bb = h1.bollinger || m15.bollinger;
  if (bb) {
    const bbPos = (price - bb.lower) / (bb.upper - bb.lower);
    if (bbPos <= 0.05) { buyScore += 3; reasons.push('觸及BB下軌'); }
    else if (bbPos <= 0.15) { buyScore += 1.5; reasons.push('BB下緣'); }
    else if (bbPos >= 0.95) { sellScore += 3; buyScore -= 1; reasons.push('觸及BB上軌'); }
    else if (bbPos >= 0.85) { sellScore += 1.5; reasons.push('BB上緣'); }
  }

  // === 3. 1H EMA 趨勢 ===
  if (h1.ema8 !== undefined && h1.ema21 !== undefined) {
    if (h1.ema8 > h1.ema21) {
      buyScore += 2; reasons.push('1H趨勢多');
    } else {
      sellScore += 2; reasons.push('1H趨勢空');
    }
  }

  // === 4. 4H 大趨勢 ===
  if (h4.ema8 !== undefined && h4.ema21 !== undefined) {
    if (h4.ema8 > h4.ema21) {
      buyScore += 1.5; reasons.push('4H大趨勢多');
    } else {
      sellScore += 1.5; reasons.push('4H大趨勢空');
    }
  }

  // === 5. MACD 動能（1H）===
  const macdData = h1.macd || m15.macd;
  if (macdData && typeof macdData === 'object') {
    if (macdData.histogram > 0) {
      buyScore += 1.5; reasons.push('MACD多頭');
    } else if (macdData.histogram < 0) {
      sellScore += 1.5; reasons.push('MACD空頭');
    }
    // v7: MACD 柱翻轉加強信號
    if (macdData.prevHistogram !== undefined) {
      if (macdData.prevHistogram < 0 && macdData.histogram > 0) {
        buyScore += 2; reasons.push('MACD柱翻多');
      } else if (macdData.prevHistogram > 0 && macdData.histogram < 0) {
        sellScore += 2; reasons.push('MACD柱翻空');
      }
    }
  }

  // === 6. 成交量（有就加分，沒有不扣）===
  const avgVol = m15.volumeMA20 || m15.avgVolume;
  if (m15.volume !== undefined && avgVol && avgVol > 0) {
    const volRatio = m15.volume / avgVol;
    if (volRatio >= 2.0) { buyScore += 1; sellScore += 1; reasons.push(`量爆${volRatio.toFixed(1)}x`); }
    else if (volRatio < 0.3) { buyScore -= 0.5; sellScore -= 0.5; reasons.push('極量縮'); }
  }

  // === 7. 多時框共振（v7: 加大權重）===
  if (m15.ema8 !== undefined && m15.ema21 !== undefined &&
      h1.ema8 !== undefined && h1.ema21 !== undefined &&
      h4.ema8 !== undefined && h4.ema21 !== undefined) {
    const m15Up = m15.ema8 > m15.ema21;
    const h1Up = h1.ema8 > h1.ema21;
    const h4Up = h4.ema8 > h4.ema21;
    if (m15Up && h1Up && h4Up) {
      buyScore += 3; reasons.push('三框共振多🔥');
    } else if (!m15Up && !h1Up && !h4Up) {
      sellScore += 3; reasons.push('三框共振空🔥');
    }
  }

  // 確保分數不為負
  buyScore = Math.max(0, buyScore);
  sellScore = Math.max(0, sellScore);

  // === v7 Zone 判定：更嚴格 ===
  let zone = 'NEUTRAL';
  if (buyScore >= 7 && buyScore > sellScore + 3) zone = 'STRONG_BUY';
  else if (buyScore >= 5 && buyScore > sellScore + 2) zone = 'BUY_ZONE';
  else if (buyScore >= 3 && buyScore > sellScore) zone = 'SLIGHT_BUY';
  else if (sellScore >= 7 && sellScore > buyScore + 3) zone = 'STRONG_SELL';
  else if (sellScore >= 5 && sellScore > buyScore + 2) zone = 'SELL_ZONE';
  else if (sellScore >= 3 && sellScore > buyScore) zone = 'SLIGHT_SELL';

  return { zone, buyScore, sellScore, reasons, rsi };
}

// ============ v7 買入決策：只在明確低位進場 ============

function decideBuy(state, marketData, analysis, balance) {
  const price = marketData.ticker.last;
  if (!balance.twd || !balance[COIN]) { log(MARKET, '⚠️ 餘額缺漏，跳過買入'); return null; }
  const availableTwd = balance.twd.available;

  const invested = state.totalTwdInvested;
  const budgetLeft = CAPITAL_PER_MARKET - invested;
  const usableTwd = Math.min(availableTwd, budgetLeft);

  if (usableTwd < MIN_TRADE_TWD) return null;
  if (state.lastBuyTime && (Date.now() - state.lastBuyTime) < BATCH_COOLDOWN_MS) return null;
  if (state.buyBatches.length >= BUY_BATCHES) return null;

  const { zone, buyScore, sellScore, rsi } = analysis;
  let buyTwd = 0;
  let reason = '';

  // v7: RSI > 65 禁止買入（不管其他信號多強）
  if (rsi && rsi > 65) {
    log(MARKET, `🚫 RSI ${rsi.toFixed(0)} > 65，禁止買入`);
    return null;
  }

  // v7: 只在 BUY_ZONE 或更強才買
  if (zone === 'STRONG_BUY' && buyScore >= 7) {
    buyTwd = Math.min(usableTwd * 0.5, 2000);
    reason = `強買(score=${buyScore.toFixed(1)}, RSI=${rsi?.toFixed(0)})`;
  } else if (zone === 'BUY_ZONE' && buyScore >= 5) {
    buyTwd = Math.min(usableTwd * 0.35, 1500);
    reason = `買入(score=${buyScore.toFixed(1)}, RSI=${rsi?.toFixed(0)})`;
  } else if (zone === 'SLIGHT_BUY' && buyScore >= 4 && state.buyBatches.length === 0) {
    // 第一批可以在 SLIGHT_BUY 小量試探
    buyTwd = Math.min(usableTwd * 0.2, 800);
    reason = `試探(score=${buyScore.toFixed(1)}, RSI=${rsi?.toFixed(0)})`;
  }

  // v7: 加碼邏輯 — 必須比上次買更低才加碼
  if (state.buyBatches.length > 0 && buyTwd > 0) {
    const lastBuyPrice = state.buyBatches[state.buyBatches.length - 1].price;
    const dropPct = (lastBuyPrice - price) / lastBuyPrice;
    if (dropPct >= 0.02) {
      // 跌 2%+ 加碼，加大量
      buyTwd = Math.min(buyTwd * 1.5, usableTwd * 0.5);
      reason += ` +加碼(跌${(dropPct*100).toFixed(1)}%)`;
    } else if (dropPct < 0.005) {
      // 沒跌或微跌，不加碼
      log(MARKET, `⏳ 等更低再加碼（距上次買僅 ${(dropPct*100).toFixed(2)}%）`);
      return null;
    }
  }

  if (buyTwd < MIN_TRADE_TWD) return null;
  return { action: 'BUY', twd: Math.round(buyTwd), reason };
}

// ============ v7 賣出決策：目標 3%+，追蹤止盈 ============

function decideSell(state, marketData, analysis, balance) {
  const price = marketData.ticker.last;
  if (!balance[COIN]) return null;
  const coinAvailable = balance[COIN].available;

  if (coinAvailable < MIN_COIN) return null;
  if (state.lastSellTime && (Date.now() - state.lastSellTime) < 10 * 60 * 1000) return null; // 賣出冷卻 10 分鐘

  const avgCost = state.avgBuyPrice || 0;
  if (avgCost === 0) return null;

  const profitPct = (price - avgCost) / avgCost;
  const netProfitPct = profitPct - ROUND_TRIP_FEE;
  const { zone, sellScore, rsi } = analysis;

  let sellCoin = 0;
  let reason = '';

  // === 停損（鐵律）===
  if (profitPct < -0.05) {
    // 虧 5%+ 強制全砍
    sellCoin = coinAvailable;
    reason = `⛔停損(${(profitPct*100).toFixed(2)}%)`;
  } else if (profitPct < -0.03 && sellScore >= 4) {
    // 虧 3% + 強賣信號 → 砍
    sellCoin = coinAvailable;
    reason = `停損(${(profitPct*100).toFixed(2)}%, sell=${sellScore.toFixed(1)})`;
  }

  // === 獲利了結 ===
  if (sellCoin === 0 && netProfitPct > 0) {
    if (netProfitPct >= 0.05) {
      // 淨賺 5%+ → 賣 60%，讓 40% 繼續跑
      sellCoin = coinAvailable * 0.6;
      reason = `大獲利(淨+${(netProfitPct*100).toFixed(1)}%)🎉`;
    } else if (netProfitPct >= 0.03) {
      // 淨賺 3%+ → 目標達成
      if (zone === 'SELL_ZONE' || zone === 'STRONG_SELL' || sellScore >= 4) {
        // 有賣出信號 → 賣 50%
        sellCoin = coinAvailable * 0.5;
        reason = `目標達成+賣出信號(淨+${(netProfitPct*100).toFixed(1)}%)`;
      } else if (rsi && rsi >= 75) {
        // RSI 超買 → 賣 40%
        sellCoin = coinAvailable * 0.4;
        reason = `目標達成+RSI超買(淨+${(netProfitPct*100).toFixed(1)}%)`;
      } else {
        // 目標達成但無賣出信號 → 繼續抱
        log(MARKET, `📈 淨利+${(netProfitPct*100).toFixed(1)}%，無賣出信號，繼續抱`);
      }
    } else if (netProfitPct >= 0.015 && (zone === 'STRONG_SELL' || sellScore >= 6)) {
      // 淨賺 1.5% + 極強賣出信號 → 保利賣出
      sellCoin = coinAvailable * 0.3;
      reason = `保利(淨+${(netProfitPct*100).toFixed(1)}%, sell=${sellScore.toFixed(1)})`;
    }
  }

  // === 極端超買全賣 ===
  if (sellCoin === 0 && netProfitPct >= 0.02 && rsi && rsi >= 80 && sellScore >= 5) {
    sellCoin = coinAvailable * 0.7;
    reason = `RSI極度超買+強賣(淨+${(netProfitPct*100).toFixed(1)}%)`;
  }

  // 修正最小賣出量
  if (sellCoin > 0 && (sellCoin < MIN_COIN || sellCoin * price < 250)) {
    sellCoin = coinAvailable;
  }
  if (sellCoin < MIN_COIN) return null;

  return { action: 'SELL', coinAmount: sellCoin, reason, profitPct, netProfitPct };
}

// ============ 執行交易 ============

function executeBuy(state, decision, marketData) {
  const price = marketData.ticker.last;
  log(MARKET, `📥 買入: NT$${decision.twd} @ ~${price} | ${decision.reason}`);

  const result = placeOrder(MARKET, `buy_market ${decision.twd}`);
  if (!result || result.error) {
    log(MARKET, `❌ 買入失敗: ${JSON.stringify(result)}`);
    return state;
  }

  const amount = decision.twd / price * (1 - TAKER_FEE);
  state.buyBatches.push({ price, twd: decision.twd, coin: amount, time: Date.now(), reason: decision.reason });
  state.lastBuyTime = Date.now();

  let totalTwd = 0, totalCoin = 0;
  for (const b of state.buyBatches) { totalTwd += b.twd; totalCoin += b.coin; }
  state.avgBuyPrice = totalTwd / totalCoin;
  state.totalCoinHeld = totalCoin;
  state.totalTwdInvested = totalTwd;

  log(MARKET, `✅ 買入成功 | 均價: ${state.avgBuyPrice.toFixed(0)} | 持有: ${totalCoin.toFixed(6)} | 投入: NT$${totalTwd}`);
  return state;
}

function executeSell(state, decision, marketData) {
  const price = marketData.ticker.last;
  log(MARKET, `📤 賣出: ${decision.coinAmount.toFixed(4)} @ ~${price} | ${decision.reason}`);

  const result = placeOrder(MARKET, `sell_market ${decision.coinAmount}`);
  if (!result || result.error) {
    log(MARKET, `❌ 賣出失敗: ${JSON.stringify(result)}`);
    return state;
  }

  const grossPnl = Math.round(decision.coinAmount * price * decision.netProfitPct);
  state.totalPnl += grossPnl;
  state.dailyPnl += grossPnl;
  state.totalTrades++;

  if (grossPnl >= 0) { state.wins++; state.consecutiveLosses = 0; }
  else { state.losses++; state.consecutiveLosses++; }

  const equity = CAPITAL_PER_MARKET + state.totalPnl;
  if (equity > state.peakEquity) state.peakEquity = equity;
  const dd = state.peakEquity - equity;
  if (dd > state.maxDrawdown) state.maxDrawdown = dd;

  // 記錄到 trade log
  let tradeLog = readJSON(LOG_FILE, []);
  if (!Array.isArray(tradeLog)) tradeLog = [];
  tradeLog.push({
    id: Date.now(),
    side: 'SELL',
    entryPrice: state.avgBuyPrice,
    exitPrice: price,
    amount: decision.coinAmount,
    pnl: grossPnl,
    pnlPct: parseFloat((decision.netProfitPct * 100).toFixed(3)),
    time: new Date().toISOString(),
    reason: decision.reason
  });
  if (tradeLog.length > 100) tradeLog = tradeLog.slice(-100);
  writeJSON(LOG_FILE, tradeLog);

  log(MARKET, `✅ 賣出完成 | ${grossPnl >= 0 ? '+' : ''}NT$${grossPnl} (${(decision.netProfitPct*100).toFixed(2)}%)`);

  // 持倉更新
  const balance = getBalance();
  if (balance && balance[COIN] && balance[COIN].available < MIN_COIN) {
    log(MARKET, `📭 持倉清空，重置批次`);
    state.buyBatches = [];
    state.sellBatches = [];
    state.avgBuyPrice = 0;
    state.totalCoinHeld = 0;
    state.totalTwdInvested = 0;
  } else {
    state.totalCoinHeld = (balance && balance[COIN]) ? balance[COIN].available : state.totalCoinHeld - decision.coinAmount;
  }

  // 暫停規則
  if (state.consecutiveLosses >= CONSEC_LOSS_PAUSE) {
    state.pauseUntil = Date.now() + 3600000;
    log(MARKET, `⛔ 連虧${CONSEC_LOSS_PAUSE}筆，暫停1小時`);
  }
  if (state.dailyPnl <= -DAILY_LOSS_LIMIT) {
    state.pauseUntil = Date.now() + 86400000;
    log(MARKET, `⛔ 日虧超限，今日停機`);
  }

  state.lastSellTime = Date.now();
  return state;
}

// ============ 處理遺留持倉（ETH/DOGE 等不再交易的幣）============

function handleLegacyPositions() {
  const legacyMarkets = ['ethtwd', 'dogetwd'];
  const balance = getBalance();
  if (!balance) return;

  for (const m of legacyMarkets) {
    const cfg = { ethtwd: { coin: 'eth', min: 0.0037 }, dogetwd: { coin: 'doge', min: 80 }, avaxtwd: { coin: 'avax', min: 0.88 } }[m];
    if (!cfg) continue;
    const held = balance[cfg.coin] ? balance[cfg.coin].available : 0;
    if (held >= cfg.min) {
      log('LEGACY', `⚠️ 發現舊持倉 ${cfg.coin.toUpperCase()}: ${held}，需手動處理或等 RSI 高位賣出`);
      // 讀取舊 state 看有沒有成本
      const oldState = readJSON(path.join(TRADING_DIR, `money_maker_state_${m}.json`), null);
      if (oldState && oldState.avgBuyPrice > 0) {
        const mFile = path.join(TRADING_DIR, `money_maker_market_${m}.json`);
        const mData = readJSON(mFile, null);
        if (mData && mData.ticker) {
          const price = mData.ticker.last;
          const pnlPct = ((price - oldState.avgBuyPrice) / oldState.avgBuyPrice * 100).toFixed(2);
          log('LEGACY', `  ${cfg.coin.toUpperCase()} 成本=${oldState.avgBuyPrice.toFixed(0)} 現價=${price} 浮盈=${pnlPct}%`);
        }
      }
    }
  }
}

// ============ MAIN ============

async function runMarket() {
  let state = loadState();

  if (state.pauseUntil && Date.now() < state.pauseUntil) {
    const remaining = Math.round((state.pauseUntil - Date.now()) / 60000);
    log(MARKET, `⏸️ 暫停中，${remaining}分鐘後恢復`);
    return;
  }
  if (state.dailyPnl <= -DAILY_LOSS_LIMIT) {
    state.pauseUntil = Date.now() + 86400000;
    writeJSON(STATE_FILE, state);
    return;
  }

  const marketData = fetchMarketData(MARKET);
  if (!marketData) return;

  const analysis = analyzePosition(marketData);
  const balance = getBalance();
  if (!balance) return;

  const price = marketData.ticker.last;
  const held = balance[COIN] ? balance[COIN].available : 0;
  const profitInfo = (held >= MIN_COIN && state.avgBuyPrice > 0) ? ` | 成本=${state.avgBuyPrice.toFixed(0)} 浮盈=${(((price - state.avgBuyPrice) / state.avgBuyPrice) * 100).toFixed(2)}%` : '';
  log(MARKET, `📊 價=${price.toFixed(0)} RSI=${analysis.rsi?.toFixed(0) || '--'} zone=${analysis.zone} buy=${analysis.buyScore?.toFixed(1)||0} sell=${analysis.sellScore?.toFixed(1)||0} 持倉=${held.toFixed(6)}${profitInfo}`);

  // 優先賣出
  if (balance[COIN] && balance[COIN].available >= MIN_COIN && state.avgBuyPrice > 0) {
    const sellDecision = decideSell(state, marketData, analysis, balance);
    if (sellDecision) {
      state = executeSell(state, sellDecision, marketData);
      writeJSON(STATE_FILE, state);
      return;
    }
  }

  // 買入
  const buyDecision = decideBuy(state, marketData, analysis, balance);
  if (buyDecision) {
    state = executeBuy(state, buyDecision, marketData);
  }

  writeJSON(STATE_FILE, state);
}

runMarket().catch(e => log(MARKET, `💥 錯誤: ${e.message}`));
