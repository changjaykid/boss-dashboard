#!/usr/bin/env node
/**
 * 虛擬貨幣賺錢機 v5 — BTC/TWD 現貨分批低買高賣引擎
 * 
 * 2026-04-06 全新設計：
 * - 現貨只能做多（低買高賣），沒有做空
 * - 分批買入：價格越低越買，分 3 批佈局
 * - 分批賣出：價格越高越賣，分 3 批獲利
 * - 手續費考量：Maker 0.08% / Taker 0.16%，來回至少 0.24%
 * - 最小波段利潤目標 0.5%（扣手續費後淨賺 ~0.26%）
 * - 結合技術指標 + 新聞/社群情緒判斷相對高低
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

// ============ 核心參數 ============
const CAPITAL = 10000;                    // 本金
const DAILY_LOSS_LIMIT = 500;             // 日虧上限
const CONSEC_LOSS_PAUSE = 4;              // 連虧暫停
const MAKER_FEE = 0.0008;                 // 限價手續費
const TAKER_FEE = 0.0016;                 // 市價手續費
const MIN_PROFIT_PCT = 0.005;             // 最小獲利目標 0.5%（含手續費）
const MIN_TRADE_TWD = 260;                // 最低交易金額
const MIN_BTC = 0.0001;                   // BTC 最小交易量
const CASH_RESERVE_PCT = 0.2;             // 永遠保留 20% 現金
const MAX_SINGLE_BUY_TWD = 2500;          // 單批最大買入
const BASE_ENTRY_DROP_PCT = 0.008;        // 第二批起至少比前批低 0.8%
const HARD_STOP_LOSS_PCT = 0.05;          // 現貨硬停損 5%

// 分批參數
const BUY_BATCHES = 3;                    // 分 3 批買
const SELL_BATCHES = 3;                   // 分 3 批賣
const BATCH_COOLDOWN_MS = 5 * 60 * 1000;  // 每批間隔至少 5 分鐘

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
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

function round8(n) {
  return Math.round(n * 1e8) / 1e8;
}

// ============ State ============

function getDefaultState() {
  return {
    version: 5,
    status: 'RUNNING',
    mode: 'batch_swing_v5',
    // 買入批次追蹤
    buyBatches: [],        // [{ price, twd, btc, time }]
    sellBatches: [],       // [{ price, btc, twd, time, profit }]
    avgBuyPrice: 0,        // 加權平均買入價
    totalBtcHeld: 0,       // 目前持有 BTC
    totalTwdInvested: 0,   // 已投入 TWD
    // 績效
    dailyPnl: 0,
    dailyDate: new Date().toISOString().slice(0, 10),
    totalPnl: 0,
    totalTrades: 0,
    wins: 0,
    losses: 0,
    consecutiveLosses: 0,
    maxDrawdown: 0,
    peakEquity: CAPITAL,
    pauseUntil: null,
    lastBuyTime: null,
    lastSellTime: null,
  };
}

function loadState() {
  let state = readJSON(STATE_FILE, null);
  if (!state || state.version !== 5) {
    const old = state || {};
    state = getDefaultState();
    state.totalPnl = old.totalPnl || 0;
    state.totalTrades = old.totalTrades || 0;
    state.wins = old.wins || 0;
    state.losses = old.losses || 0;
    state.maxDrawdown = old.maxDrawdown || 0;
    state.peakEquity = old.peakEquity || CAPITAL;
    writeJSON(STATE_FILE, state);
    log('📦 State 升級到 v5（分批低買高賣）');
  }
  const today = new Date().toISOString().slice(0, 10);
  if (state.dailyDate !== today) {
    state.dailyPnl = 0;
    state.dailyDate = today;
    state.pauseUntil = null;
  }
  return state;
}

function rebuildStateFromBalance(state, balance, market) {
  const btcAvailable = balance?.btc?.available || 0;
  if (btcAvailable < MIN_BTC || !market?.ticker?.last) return state;

  const needsRepair = !state.avgBuyPrice || state.buyBatches.length === 0 || Math.abs((state.totalBtcHeld || 0) - btcAvailable) > MIN_BTC;
  if (!needsRepair) return state;

  const fallbackPrice = market.indicators?.['1h']?.ema21 || market.indicators?.['4h']?.ema21 || market.ticker.last;
  const estimatedCost = Math.min(btcAvailable * fallbackPrice, CAPITAL * 0.85);

  state.buyBatches = [{
    price: fallbackPrice,
    twd: Math.round(estimatedCost),
    btc: round8(btcAvailable),
    time: Date.now(),
    reason: 'recovered_from_balance'
  }];
  state.avgBuyPrice = fallbackPrice;
  state.totalBtcHeld = round8(btcAvailable);
  state.totalTwdInvested = Math.round(estimatedCost);
  log(`🩹 狀態修復: 偵測到帳戶有 ${btcAvailable.toFixed(8)} BTC，回補持倉成本 ${Math.round(fallbackPrice)}`);
  return state;
}

// ============ 帳戶操作 ============

function getBalance() {
  try {
    const result = execSync(`/usr/local/bin/node ${path.join(TRADING_DIR, 'money_maker_order.js')} balance`, {
      encoding: 'utf8', timeout: 15000
    });
    return JSON.parse(result.trim());
  } catch (e) {
    log(`❌ 查餘額失敗: ${e.message}`);
    return null;
  }
}

function placeOrder(cmd) {
  try {
    const result = execSync(`/usr/local/bin/node ${path.join(TRADING_DIR, 'money_maker_order.js')} ${cmd}`, {
      encoding: 'utf8', timeout: 15000
    });
    const trimmed = result.trim();
    let depth = 0, end = -1, start = -1;
    for (let i = trimmed.length - 1; i >= 0; i--) {
      if (trimmed[i] === '}') { if (end === -1) end = i; depth++; }
      else if (trimmed[i] === '{') { depth--; if (depth === 0) { start = i; break; } }
    }
    if (start >= 0 && end > start) {
      try { return JSON.parse(trimmed.slice(start, end + 1)); } catch (_) {}
    }
    log(`⚠️ 下單回傳無法解析: ${trimmed.slice(0, 300)}`);
    return null;
  } catch (e) {
    log(`❌ 下單失敗: ${e.message}`);
    return null;
  }
}

function fetchMarketData() {
  try {
    execSync(`/usr/local/bin/node ${path.join(TRADING_DIR, 'money_maker_fetch.js')}`, {
      encoding: 'utf8', timeout: 30000
    });
    const data = readJSON(MARKET_FILE, null);
    if (!data) return null;
    const dataAge = Date.now() - new Date(data.timestamp).getTime();
    if (dataAge > 5 * 60 * 1000) {
      log(`⚠️ 市場資料過期 ${Math.round(dataAge / 60000)} 分鐘，跳過`);
      return null;
    }
    return data;
  } catch (e) {
    log(`❌ 抓市場資料失敗: ${e.message}`);
    return null;
  }
}

// ============ 市場分析：判斷現在是相對高還是相對低 ============

function analyzePosition(market) {
  if (!market || !market.indicators) return { zone: 'NEUTRAL', score: 0, reasons: [] };

  const m15 = market.indicators['15m'];
  const h1 = market.indicators['1h'];
  const h4 = market.indicators['4h'];
  const price = market.ticker.last;

  if (!m15 || !h1 || !h4) return { zone: 'NEUTRAL', score: 0, reasons: [] };

  let buyScore = 0;   // 正 = 適合買（相對低）
  let sellScore = 0;  // 正 = 適合賣（相對高）
  let reasons = [];

  // === RSI 位置 ===
  const rsi = m15.rsi;
  if (rsi <= 25) { buyScore += 4; reasons.push(`RSI極度超賣${rsi.toFixed(0)}`); }
  else if (rsi <= 30) { buyScore += 3; reasons.push(`RSI超賣${rsi.toFixed(0)}`); }
  else if (rsi <= 35) { buyScore += 2; reasons.push(`RSI偏低${rsi.toFixed(0)}`); }
  else if (rsi <= 40) { buyScore += 1.5; reasons.push(`RSI回調${rsi.toFixed(0)}`); }
  else if (rsi <= 50) { buyScore += 0.5; reasons.push(`RSI中性偏低${rsi.toFixed(0)}`); }
  else if (rsi >= 80) { sellScore += 4; reasons.push(`RSI極度超買${rsi.toFixed(0)}`); }
  else if (rsi >= 75) { sellScore += 3; reasons.push(`RSI超買${rsi.toFixed(0)}`); }
  else if (rsi >= 70) { sellScore += 2; reasons.push(`RSI偏高${rsi.toFixed(0)}`); }
  else if (rsi >= 65) { sellScore += 1; reasons.push(`RSI偏強${rsi.toFixed(0)}`); }

  // === BB 位置 ===
  if (m15.bollinger) {
    const bb = m15.bollinger;
    const bbPos = (price - bb.lower) / (bb.upper - bb.lower);
    if (bbPos <= 0.05) { buyScore += 3; reasons.push('觸及BB下軌'); }
    else if (bbPos <= 0.2) { buyScore += 2; reasons.push('靠近BB下軌'); }
    else if (bbPos <= 0.35) { buyScore += 1; reasons.push('BB中低區'); }
    else if (bbPos >= 0.95) { sellScore += 3; reasons.push('觸及BB上軌'); }
    else if (bbPos >= 0.8) { sellScore += 2; reasons.push('靠近BB上軌'); }
    else if (bbPos >= 0.65) { sellScore += 1; reasons.push('BB中高區'); }
  }

  // === MACD 方向 ===
  if (m15.macd) {
    const hist = m15.macd.histogram;
    const prev = m15.macd.prevHistogram;
    if (hist > 0 && prev <= 0) { buyScore += 1.5; reasons.push('MACD翻多'); }
    else if (hist < 0 && prev >= 0) { sellScore += 1.5; reasons.push('MACD翻空'); }
    else if (hist < 0 && hist > prev) { buyScore += 0.5; reasons.push('MACD空方收斂'); }
    else if (hist > 0 && hist < prev) { sellScore += 0.5; reasons.push('MACD多方衰減'); }
  }

  // === K 線型態 ===
  if (m15.candlePatterns) {
    for (const p of m15.candlePatterns) {
      if (['bullish_engulfing', 'hammer', 'pin_bar_bullish', 'morning_star'].includes(p)) {
        buyScore += 1.5; reasons.push(`看多K線:${p}`);
      }
      if (['bearish_engulfing', 'shooting_star', 'pin_bar_bearish', 'evening_star'].includes(p)) {
        sellScore += 1.5; reasons.push(`看空K線:${p}`);
      }
    }
  }

  // === 1H 趨勢 ===
  if (h1.trend === 'strong_up') { sellScore += 0.5; reasons.push('1H強勢↑(注意回調)'); }
  if (h1.trend === 'strong_down') { buyScore += 0.5; reasons.push('1H弱勢↓(注意反彈)'); }

  // === EMA 交叉 ===
  if (m15.emaCross === 'golden_cross') { buyScore += 1; reasons.push('15M金叉'); }
  if (m15.emaCross === 'death_cross') { sellScore += 1; reasons.push('15M死叉'); }

  // === 量能 ===
  if (m15.volumeRatio >= 2) {
    // 放量 + RSI 超賣 = 恐慌拋售結束信號
    if (rsi <= 35) { buyScore += 1; reasons.push('放量+低RSI(恐慌抄底)'); }
    // 放量 + RSI 超買 = 高潮出貨
    if (rsi >= 70) { sellScore += 1; reasons.push('放量+高RSI(高潮出貨)'); }
  }

  // === 多時間框架 ===
  const mtf = market.multiTimeframe;
  if (mtf && mtf.direction === 'BUY') { buyScore += 0.5; }
  if (mtf && mtf.direction === 'SELL') { sellScore += 0.5; }

  // === 新聞 + 社群情緒 ===
  const newsResult = analyzeNewsSentiment();
  if (newsResult.signal === 'BULLISH') { buyScore += 1; reasons.push(newsResult.reasons[0]); }
  else if (newsResult.signal === 'BEARISH') { sellScore += 1; reasons.push(newsResult.reasons[0]); }
  else if (newsResult.signal === 'SLIGHTLY_BULLISH') { buyScore += 0.5; }
  else if (newsResult.signal === 'SLIGHTLY_BEARISH') { sellScore += 0.5; }

  // 判斷區域
  let zone = 'NEUTRAL';
  if (buyScore >= 3 && buyScore > sellScore + 1) zone = 'BUY_ZONE';
  else if (buyScore >= 2 && buyScore > sellScore) zone = 'SLIGHT_BUY';
  else if (sellScore >= 3 && sellScore > buyScore + 1) zone = 'SELL_ZONE';
  else if (sellScore >= 2 && sellScore > buyScore) zone = 'SLIGHT_SELL';

  return { zone, buyScore, sellScore, reasons, rsi, newsResult };
}

function analyzeNewsSentiment() {
  const news = readJSON(CRYPTO_NEWS_FILE, null);
  if (!news) return { score: 0.5, signal: 'NEUTRAL', reasons: ['無新聞資料'] };

  let bullish = 0, bearish = 0;
  const newsStr = JSON.stringify(news).toLowerCase();
  const bullWords = ['etf流入', '機構買入', '降息', '利好', '突破', '新高', '採用', 'adoption', 'bullish', '大漲', '反彈', 'rally', 'pump', '買入'];
  const bearWords = ['etf流出', '監管', '打壓', '被駭', 'hack', '利空', '崩盤', '暴跌', 'bearish', '禁止', 'ban', 'dump', '清算', 'liquidat'];
  for (const w of bullWords) { if (newsStr.includes(w)) bullish++; }
  for (const w of bearWords) { if (newsStr.includes(w)) bearish++; }

  // 社群情緒
  let socialBull = 0, socialBear = 0;
  if (news.socialDiscussions && Array.isArray(news.socialDiscussions)) {
    for (const post of news.socialDiscussions) {
      const text = JSON.stringify(post).toLowerCase();
      if (['bullish', '看多', '做多', 'long', 'buy', '突破', 'moon', '利好', '反彈'].some(w => text.includes(w))) socialBull++;
      if (['bearish', '看空', '做空', 'short', 'sell', '崩盤', 'crash', '利空', '暴跌'].some(w => text.includes(w))) socialBear++;
    }
  }

  const totalBull = bullish + socialBull;
  const totalBear = bearish + socialBear;
  let signal = 'NEUTRAL', reasons = [];
  if (totalBull > totalBear + 2) { signal = 'BULLISH'; reasons.push(`新聞社群偏多(${totalBull}/${totalBear})`); }
  else if (totalBull > totalBear) { signal = 'SLIGHTLY_BULLISH'; reasons.push(`新聞社群略多(${totalBull}/${totalBear})`); }
  else if (totalBear > totalBull + 2) { signal = 'BEARISH'; reasons.push(`新聞社群偏空(${totalBull}/${totalBear})`); }
  else if (totalBear > totalBull) { signal = 'SLIGHTLY_BEARISH'; reasons.push(`新聞社群略空(${totalBull}/${totalBear})`); }
  else { reasons.push(`新聞社群中性(${totalBull}/${totalBear})`); }

  return { signal, reasons, details: `news=${bullish}/${bearish} social=${socialBull}/${socialBear}` };
}

// ============ 交易決策 ============

function decideBuy(state, market, analysis, balance) {
  const price = market.ticker.last;
  const availableTwd = balance.twd.available;
  const minReserve = CAPITAL * CASH_RESERVE_PCT;
  const spendableTwd = Math.max(0, availableTwd - minReserve);

  // 基本檢查
  if (spendableTwd < MIN_TRADE_TWD) {
    log(`💰 可動用現金不足 NT$${spendableTwd.toFixed(0)}，保留現金不買`);
    return null;
  }

  // 冷卻檢查
  if (state.lastBuyTime && (Date.now() - state.lastBuyTime) < BATCH_COOLDOWN_MS) {
    const remain = Math.round((BATCH_COOLDOWN_MS - (Date.now() - state.lastBuyTime)) / 60000);
    log(`🧊 買入冷卻中 ${remain}分鐘`);
    return null;
  }

  // 已買批數
  const batchesBought = state.buyBatches.length;
  if (batchesBought >= BUY_BATCHES) {
    log(`📦 已滿 ${BUY_BATCHES} 批，等待賣出`);
    return null;
  }

  // 買入區域判斷
  const { zone, buyScore, sellScore } = analysis;

  // 根據信號強度決定買入批量
  let buyTwd = 0;
  let reason = '';

  if (zone === 'BUY_ZONE' || buyScore >= 3) {
    // 強買入信號：用可用資金的 40%
    buyTwd = Math.min(spendableTwd * 0.35, MAX_SINGLE_BUY_TWD);
    reason = `強買入(${buyScore.toFixed(1)})`;
  } else if (zone === 'SLIGHT_BUY' || buyScore >= 2) {
    // 中等信號：用 25%
    buyTwd = Math.min(spendableTwd * 0.22, 1800);
    reason = `佈局買入(${buyScore.toFixed(1)})`;
  } else if (buyScore >= 1.5 && sellScore < 1) {
    // 弱信號但不看空：小量佈局
    buyTwd = Math.min(spendableTwd * 0.12, 1200);
    reason = `小額佈局(${buyScore.toFixed(1)})`;
  }

  // 越低批越買越多
  if (batchesBought > 0 && buyTwd > 0) {
    const lastBuyPrice = state.buyBatches[state.buyBatches.length - 1].price;
    const dropPct = (lastBuyPrice - price) / lastBuyPrice;
    if (dropPct > BASE_ENTRY_DROP_PCT) {
      // 比上一批低 0.8% 以上，加碼
      buyTwd = Math.min(buyTwd * 1.35, spendableTwd * 0.45, MAX_SINGLE_BUY_TWD);
      reason += ` +加碼(跌${(dropPct*100).toFixed(1)}%)`;
    } else if (dropPct < -0.002) {
      // 比上一批高 → 不追加（應該等回調）
      log(`📈 比上批高${(-dropPct*100).toFixed(2)}%，等回調再加碼`);
      return null;
    } else {
      log(`🧊 距離上批跌幅不足 ${(BASE_ENTRY_DROP_PCT*100).toFixed(1)}%，不追單`);
      return null;
    }
  }

  if (buyTwd < MIN_TRADE_TWD) return null;

  buyTwd = Math.round(buyTwd);
  return { action: 'BUY', twd: buyTwd, reason };
}

function decideSell(state, market, analysis, balance) {
  const price = market.ticker.last;
  const btcAvailable = balance.btc.available;

  if (btcAvailable < MIN_BTC) {
    return null;
  }

  // 冷卻檢查
  if (state.lastSellTime && (Date.now() - state.lastSellTime) < BATCH_COOLDOWN_MS) {
    return null;
  }

  // 計算持倉成本
  const avgCost = state.avgBuyPrice || 0;
  if (avgCost === 0) return null;

  const profitPct = (price - avgCost) / avgCost;
  const btcValue = btcAvailable * price;
  const { zone, buyScore, sellScore } = analysis;

  let sellBtc = 0;
  let reason = '';

  // 獲利判斷（必須扣除手續費後有賺）
  const netProfitPct = profitPct - (MAKER_FEE + TAKER_FEE);

  if (netProfitPct < 0) {
    // 還沒到獲利點
    if (profitPct <= -HARD_STOP_LOSS_PCT) {
      sellBtc = btcAvailable;
      reason = `硬停損(${(profitPct*100).toFixed(2)}%)`;
    } else if (profitPct < -0.03) {
      // 虧損超過 3%，如果在強賣區就停損
      if (sellScore >= 4 || zone === 'SELL_ZONE') {
        sellBtc = btcAvailable;
        reason = `停損(${(profitPct*100).toFixed(2)}%)+強賣信號`;
      }
    }
    if (sellBtc === 0) {
      log(`📊 持倉 ${(profitPct*100).toFixed(2)}%(淨${(netProfitPct*100).toFixed(2)}%) 未達獲利點`);
      return null;
    }
  }

  // 獲利了，決定賣多少
  if (sellBtc === 0) {
    if (netProfitPct >= 0.02 || (zone === 'SELL_ZONE' && netProfitPct >= 0.004)) {
      // 淨獲利 2%+ 或在賣出區且淨獲利 0.3%+：賣 50%
      sellBtc = btcAvailable * 0.5;
      reason = `獲利了結(淨+${(netProfitPct*100).toFixed(2)}%)`;
    } else if (netProfitPct >= 0.01 && sellScore >= 2) {
      // 淨獲利 1%+ 且看空信號：賣 40%
      sellBtc = btcAvailable * 0.4;
      reason = `賣出信號(淨+${(netProfitPct*100).toFixed(2)}%)`;
    } else if (netProfitPct >= 0.005 && sellScore >= 3) {
      // 淨獲利 0.5%+ 且強賣出信號：賣 30%
      sellBtc = btcAvailable * 0.3;
      reason = `強賣信號(淨+${(netProfitPct*100).toFixed(2)}%)`;
    } else if (netProfitPct >= 0.003) {
      // 淨獲利 0.3%，先不急，等更高
      log(`📈 淨利+${(netProfitPct*100).toFixed(2)}%，等更高再賣`);
      return null;
    }
  }

  // 極端信號：全賣
  if (sellScore >= 5 && netProfitPct >= 0.003) {
    sellBtc = btcAvailable;
    reason = `極強賣出信號，全部獲利了結`;
  }

  if (sellBtc < MIN_BTC) return null;

  // 確保賣出金額 >= 250 TWD
  if (sellBtc * price < 250) {
    sellBtc = btcAvailable; // 太少就全賣
  }

  sellBtc = parseFloat(sellBtc.toFixed(8));
  return { action: 'SELL', btc: sellBtc, reason, profitPct, netProfitPct };
}

// ============ 執行交易 ============

function executeBuy(state, decision, market) {
  const price = market.ticker.last;
  log(`📥 分批買入 第${state.buyBatches.length + 1}/${BUY_BATCHES}批: NT$${decision.twd} @ ~${price} | ${decision.reason}`);

  const result = placeOrder(`buy_market ${decision.twd}`);
  if (!result || result.error) {
    log(`❌ 買入失敗: ${JSON.stringify(result)}`);
    return state;
  }

  const btcAmount = decision.twd / price * (1 - TAKER_FEE);
  const batch = {
    price,
    twd: decision.twd,
    btc: btcAmount,
    time: Date.now(),
    reason: decision.reason
  };

  state.buyBatches.push(batch);
  state.lastBuyTime = Date.now();

  // 重算加權平均
  let totalTwd = 0, totalBtc = 0;
  for (const b of state.buyBatches) {
    totalTwd += b.twd;
    totalBtc += b.btc;
  }
  state.avgBuyPrice = totalTwd / totalBtc;
  state.totalBtcHeld = totalBtc;
  state.totalTwdInvested = totalTwd;

  log(`✅ 買入成功 | 均價: ${state.avgBuyPrice.toFixed(0)} | 持有: ${totalBtc.toFixed(8)} BTC (NT$${totalTwd.toFixed(0)})`);
  return state;
}

function executeSell(state, decision, market) {
  const price = market.ticker.last;
  const pnl = decision.btc * price * decision.netProfitPct;

  log(`📤 分批賣出: ${decision.btc.toFixed(8)} BTC @ ~${price} | ${decision.reason}`);

  const result = placeOrder(`sell_market ${decision.btc}`);
  if (!result || result.error) {
    log(`❌ 賣出失敗: ${JSON.stringify(result)}`);
    return state;
  }

  const sellRecord = {
    price,
    btc: decision.btc,
    twd: decision.btc * price * (1 - TAKER_FEE),
    time: Date.now(),
    profitPct: decision.profitPct,
    netProfitPct: decision.netProfitPct,
    reason: decision.reason
  };

  state.sellBatches.push(sellRecord);
  state.lastSellTime = Date.now();

  // 計算獲利
  const grossPnl = Math.round(decision.btc * price * decision.netProfitPct);
  state.totalPnl += grossPnl;
  state.dailyPnl += grossPnl;
  state.totalTrades++;

  if (grossPnl >= 0) {
    state.wins++;
    state.consecutiveLosses = 0;
  } else {
    state.losses++;
    state.consecutiveLosses++;
  }

  const equity = CAPITAL + state.totalPnl;
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
    amount: decision.btc,
    pnl: grossPnl,
    pnlPct: parseFloat((decision.netProfitPct * 100).toFixed(3)),
    time: new Date().toISOString(),
    reason: decision.reason
  });
  if (tradeLog.length > 100) tradeLog = tradeLog.slice(-100);
  writeJSON(LOG_FILE, tradeLog);

  log(`✅ 賣出成功 | 獲利: ${grossPnl >= 0 ? '+' : ''}NT$${grossPnl} (${(decision.netProfitPct*100).toFixed(2)}%)`);

  // 如果全部賣完，重置批次
  const balance = getBalance();
  if (balance && balance.btc.available < MIN_BTC) {
    log(`📭 持倉已清空，重置批次`);
    state.buyBatches = [];
    state.sellBatches = [];
    state.avgBuyPrice = 0;
    state.totalBtcHeld = 0;
    state.totalTwdInvested = 0;
  } else {
    // 更新剩餘持倉數量
    state.totalBtcHeld = balance ? balance.btc.available : state.totalBtcHeld - decision.btc;
  }

  // 暫停規則
  if (state.consecutiveLosses >= CONSEC_LOSS_PAUSE) {
    state.pauseUntil = Date.now() + 3600000;
    log(`⛔ 連虧${CONSEC_LOSS_PAUSE}筆，暫停1小時`);
  }
  if (state.dailyPnl <= -DAILY_LOSS_LIMIT) {
    state.pauseUntil = Date.now() + 86400000;
    log(`⛔ 日虧超限，今日停機`);
  }

  return state;
}

// ============ 主控版 ============

function updateDashboard(state, market, analysis) {
  const balance = getBalance();
  const price = market ? market.ticker.last : 0;
  const availableTwd = balance ? balance.twd.available : 0;
  const btcHeld = balance ? balance.btc.available : 0;
  const btcValue = btcHeld * price;
  const realizedCapital = CAPITAL + (state.totalPnl || 0);
  const netEquity = Math.round(availableTwd + btcValue);

  const profitPct = state.avgBuyPrice > 0 ? ((price - state.avgBuyPrice) / state.avgBuyPrice * 100).toFixed(2) : '--';

  const zoneEmoji = {
    'BUY_ZONE': '🟢 買入區',
    'SLIGHT_BUY': '🟡 可佈局',
    'NEUTRAL': '⚪ 中性',
    'SLIGHT_SELL': '🟡 可減持',
    'SELL_ZONE': '🔴 賣出區',
  };

  const dashData = {
    lastUpdate: new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Taipei' }).replace('T', ' ').slice(0, 16),
    status: state.pauseUntil && Date.now() < state.pauseUntil ? 'PAUSED' : 'RUNNING',
    mode: 'batch_swing_v5',
    capital: CAPITAL,
    realizedCapital: Math.round(realizedCapital),
    available: Math.round(availableTwd),
    btcHeld: btcHeld.toFixed(8),
    btcValue: Math.round(btcValue),
    netEquity,
    todayPnl: Math.round(state.dailyPnl),
    totalPnl: Math.round(state.totalPnl),
    totalTrades: state.totalTrades,
    wins: state.wins,
    losses: state.losses,
    winRate: state.totalTrades > 0 ? `${((state.wins / state.totalTrades) * 100).toFixed(0)}%` : '--',
    maxDrawdown: Math.round(state.maxDrawdown),
    avgBuyPrice: state.avgBuyPrice > 0 ? Math.round(state.avgBuyPrice) : null,
    unrealizedPnlPct: profitPct,
    buyBatches: state.buyBatches.length,
    maxBuyBatches: BUY_BATCHES,
    currentZone: zoneEmoji[analysis.zone] || analysis.zone,
    signals: {
      buyScore: analysis.buyScore.toFixed(1),
      sellScore: analysis.sellScore.toFixed(1),
      reasons: analysis.reasons.slice(0, 5).join(', '),
      news: analysis.newsResult ? analysis.newsResult.signal : '--'
    },
    btcPrice: price,
    btcChange24h: market ? parseFloat(market.ticker.change24h.toFixed(2)) : 0,
    recentTrades: (readJSON(LOG_FILE, []) || []).slice(-10).reverse(),
    nextAction: state.avgBuyPrice > 0
      ? `持倉中(均價${Math.round(state.avgBuyPrice)}) ${profitPct}%`
      : analysis.zone.includes('BUY') ? '準備佈局買入' : '等待買入機會',
    alerts: []
  };

  if (state.pauseUntil && Date.now() < state.pauseUntil) {
    dashData.alerts.push('⛔ 暫停中');
  }
  if (state.dailyPnl <= -300) {
    dashData.alerts.push(`⚠️ 日虧NT$${Math.abs(Math.round(state.dailyPnl))}`);
  }

  writeJSON(DASHBOARD_FILE, dashData);
  log(`📊 主控版已更新`);
}

// ============ MAIN ============

async function main() {
  log('🚀 賺錢機 v5 啟動（分批低買高賣 + 社群情緒）');

  let state = loadState();

  // 暫停檢查
  if (state.pauseUntil && Date.now() < state.pauseUntil) {
    const remaining = Math.round((state.pauseUntil - Date.now()) / 60000);
    log(`⏸️ 暫停中，${remaining}分鐘後恢復`);
    const market = readJSON(MARKET_FILE, null);
    if (market) updateDashboard(state, market, { zone: 'NEUTRAL', buyScore: 0, sellScore: 0, reasons: ['暫停中'], newsResult: null });
    writeJSON(STATE_FILE, state);
    return;
  }

  // 日虧上限
  if (state.dailyPnl <= -DAILY_LOSS_LIMIT) {
    log('⛔ 日虧超限，停機');
    state.pauseUntil = Date.now() + 86400000;
    writeJSON(STATE_FILE, state);
    return;
  }

  // 抓市場資料
  const market = fetchMarketData();
  if (!market) { log('❌ 無市場資料，跳過'); return; }

  const price = market.ticker.last;
  log(`📈 BTC/TWD: ${price} | 24H: ${market.ticker.change24h >= 0 ? '+' : ''}${market.ticker.change24h.toFixed(2)}%`);

  // 分析市場位置
  const analysis = analyzePosition(market);
  log(`🔍 判斷: ${analysis.zone} (buy=${analysis.buyScore.toFixed(1)} sell=${analysis.sellScore.toFixed(1)}) | RSI=${analysis.rsi.toFixed(0)} | ${analysis.reasons.slice(0, 3).join(', ')}`);

  // 取餘額
  const balance = getBalance();
  if (!balance) { log('❌ 無法取得餘額'); return; }

  state = rebuildStateFromBalance(state, balance, market);

  log(`💰 TWD: ${balance.twd.available.toFixed(0)} | BTC: ${balance.btc.available.toFixed(8)} (≈NT$${(balance.btc.available * price).toFixed(0)})`);

  // 持倉狀態
  if (state.avgBuyPrice > 0) {
    const holdPct = ((price - state.avgBuyPrice) / state.avgBuyPrice * 100).toFixed(2);
    log(`📊 持倉均價: ${state.avgBuyPrice.toFixed(0)} | 浮盈: ${holdPct}% | 批次: ${state.buyBatches.length}/${BUY_BATCHES}`);
  }

  // 優先處理賣出（有持倉時）
  if (balance.btc.available >= MIN_BTC && state.avgBuyPrice > 0) {
    const sellDecision = decideSell(state, market, analysis, balance);
    if (sellDecision) {
      state = executeSell(state, sellDecision, market);
      writeJSON(STATE_FILE, state);
      updateDashboard(state, market, analysis);
      log('✅ 本輪完成（賣出）');
      return;
    }
  }

  // 處理買入
  const buyDecision = decideBuy(state, market, analysis, balance);
  if (buyDecision) {
    state = executeBuy(state, buyDecision, market);
  } else {
    log(`⏳ 等待... ${analysis.reasons.slice(0, 3).join(', ')}`);
  }

  // 儲存
  writeJSON(STATE_FILE, state);
  updateDashboard(state, market, analysis);
  log('✅ 本輪完成');
}

main().catch(e => {
  log(`💥 引擎錯誤: ${e.message}`);
  process.exit(1);
});
