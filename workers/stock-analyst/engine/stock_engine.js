#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const WORKER_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(WORKER_DIR, 'data');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const DASHBOARD_FILE = path.join(WORKER_DIR, 'dashboard.json');
const MEMORY_FILE = path.join(WORKER_DIR, 'memory.md');

const PICK_COUNT = 10;
const MARKET_SCAN_LIMIT = 120;
const TWSE_MI_INDEX_URL = 'https://www.twse.com.tw/rwd/zh/afterTrading/MI_INDEX?response=json&type=ALLBUT0999';

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJsonSafe(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function nowTaipeiDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Taipei',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return parts;
}

function formatTaipeiTimestamp(date = new Date()) {
  const p = nowTaipeiDateParts(date);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+08:00`;
}

function formatTaipeiDisplay(date = new Date()) {
  const p = nowTaipeiDateParts(date);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second}`;
}

function taipeiToday(date = new Date()) {
  const p = nowTaipeiDateParts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

function isWeekendInTaipei(date = new Date()) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Taipei', weekday: 'short' }).format(date);
  return weekday === 'Sat' || weekday === 'Sun';
}

async function fetchJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function avg(values) {
  if (!values.length) return 0;
  return values.reduce((sum, n) => sum + n, 0) / values.length;
}

function pct(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return 0;
  return ((to - from) / from) * 100;
}

function toFixedNumber(value, digits = 2) {
  return Number(Number(value || 0).toFixed(digits));
}

function normalizeAction(action) {
  if (!action) return 'watch';
  const text = String(action);
  if (/(買|多|布局|加碼|偏多|續抱)/.test(text)) return 'bullish';
  if (/(賣|空|減碼|停利|停損|偏空)/.test(text)) return 'bearish';
  return 'watch';
}

async function fetchYahooChart(symbol) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=3mo&includePrePost=false`;
  const data = await fetchJson(url, { 'user-agent': 'Mozilla/5.0' });
  const result = data?.chart?.result?.[0];
  if (!result) throw new Error(`Yahoo chart empty for ${symbol}`);
  const quote = result.indicators?.quote?.[0] || {};
  const closes = (quote.close || []).filter(n => Number.isFinite(n));
  const opens = (quote.open || []).filter(n => Number.isFinite(n));
  const volumes = (quote.volume || []).filter(n => Number.isFinite(n));
  if (!closes.length) throw new Error(`Yahoo close empty for ${symbol}`);
  const current = closes[closes.length - 1];
  const previous = closes.length >= 2 ? closes[closes.length - 2] : current;
  const sma5 = avg(closes.slice(-5));
  const sma20 = avg(closes.slice(-20));
  return {
    source: 'Yahoo Finance',
    current: toFixedNumber(current),
    previousClose: toFixedNumber(previous),
    change: toFixedNumber(current - previous),
    changePct: toFixedNumber(pct(previous, current)),
    open: toFixedNumber(opens[opens.length - 1] || current),
    volume: Math.round(volumes[volumes.length - 1] || 0),
    closes: closes.map(v => toFixedNumber(v)),
    sma5: toFixedNumber(sma5),
    sma20: toFixedNumber(sma20),
    momentum5: toFixedNumber(pct(closes[Math.max(0, closes.length - 6)] || previous, current)),
  };
}

async function fetchTwseQuotes(symbols) {
  const exCh = symbols.join('|');
  const url = `https://mis.twse.com.tw/stock/api/getStockInfo.jsp?ex_ch=${encodeURIComponent(exCh)}&json=1&delay=0&_=${Date.now()}`;
  const data = await fetchJson(url, {
    'user-agent': 'Mozilla/5.0',
    referer: 'https://mis.twse.com.tw/stock/index.jsp'
  });
  if (!Array.isArray(data?.msgArray)) throw new Error('TWSE msgArray empty');
  return data.msgArray;
}

async function fetchTwseMarketUniverse() {
  const res = await fetch(TWSE_MI_INDEX_URL, {
    headers: { 'user-agent': 'Mozilla/5.0' }
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${TWSE_MI_INDEX_URL}`);
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('TWSE market universe JSON parse failed');
  }

  const tables = Array.isArray(data?.tables) ? data.tables : [];
  const stockTable = tables.find(t => Array.isArray(t?.fields) && t.fields.includes('證券代號') && t.fields.includes('成交股數') && t.fields.includes('收盤價'));
  if (!stockTable || !Array.isArray(stockTable.data)) throw new Error('TWSE market universe table missing');

  return stockTable.data
    .map(row => ({
      symbol: String(row[0] || '').trim(),
      name: String(row[1] || '').trim(),
      volume: Number(String(row[2] || '0').replace(/,/g, '')),
      close: Number(String(row[8] || '0').replace(/,/g, '')),
      changePct: Number(String(row[10] || '0').replace(/,/g, '')),
      pe: Number(String(row[15] || '0').replace(/,/g, '')),
    }))
    .filter(item => /^\d{4}$/.test(item.symbol) && Number.isFinite(item.close) && item.close > 0)
    .sort((a, b) => b.volume - a.volume)
    .slice(0, MARKET_SCAN_LIMIT)
    .map(item => ({
      symbol: item.symbol,
      name: item.name,
      yahoo: `${item.symbol}.TW`,
      twse: `tse_${item.symbol}.tw`,
      marketVolume: item.volume,
      marketClose: item.close,
      marketChangePct: item.changePct,
      pe: item.pe,
    }));
}

async function fetchTaiex() {
  try {
    const yahoo = await fetchYahooChart('^TWII');
    return {
      source: yahoo.source,
      taiex: yahoo.current,
      change: yahoo.change,
      changePct: yahoo.changePct,
      volume: yahoo.volume,
      previousClose: yahoo.previousClose,
      trend: yahoo.current >= yahoo.sma20 ? '偏多' : '偏弱',
      sma5: yahoo.sma5,
      sma20: yahoo.sma20,
    };
  } catch (err) {
    try {
      const rows = await fetchTwseQuotes(['tse_t00.tw']);
      const row = rows[0];
      const price = Number(row.z || row.o || row.y || 0);
      const prev = Number(row.y || price);
      return {
        source: 'TWSE MIS',
        taiex: toFixedNumber(price),
        change: toFixedNumber(price - prev),
        changePct: toFixedNumber(pct(prev, price)),
        volume: Number(row.v || 0),
        previousClose: toFixedNumber(prev),
        trend: price >= prev ? '偏多' : '偏弱',
      };
    } catch (fallbackErr) {
      throw new Error(`TAIEX fetch failed: ${err.message}; fallback failed: ${fallbackErr.message}`);
    }
  }
}

async function fetchStocks() {
  const universe = await fetchTwseMarketUniverse();
  const stocks = [];
  let twseRows = [];
  try {
    twseRows = await fetchTwseQuotes(universe.map(s => s.twse));
  } catch {
    twseRows = [];
  }
  const twseMap = new Map(twseRows.map(row => [String(row.c || '').trim(), row]));

  for (const item of universe) {
    let quote = null;
    let errors = [];
    try {
      quote = await fetchYahooChart(item.yahoo);
    } catch (err) {
      errors.push(err.message);
    }

    if (!quote) {
      const row = twseMap.get(item.symbol);
      if (row) {
        const price = Number(row.z || row.o || row.y || 0);
        const prev = Number(row.y || price);
        quote = {
          source: 'TWSE MIS',
          current: toFixedNumber(price),
          previousClose: toFixedNumber(prev),
          change: toFixedNumber(price - prev),
          changePct: toFixedNumber(pct(prev, price)),
          open: toFixedNumber(Number(row.o || price)),
          volume: Number(row.v || 0),
          closes: [prev, price],
          sma5: toFixedNumber((prev + price) / 2),
          sma20: toFixedNumber((prev + price) / 2),
          momentum5: toFixedNumber(pct(prev, price)),
        };
      }
    }

    if (!quote) {
      stocks.push({
        symbol: item.symbol,
        name: item.name,
        error: errors.join(' | ') || 'quote unavailable',
      });
      continue;
    }

    stocks.push({
      symbol: item.symbol,
      name: item.name,
      price: quote.current,
      previousClose: quote.previousClose,
      change: quote.change,
      changePct: quote.changePct,
      volume: quote.volume,
      marketVolume: item.marketVolume || quote.volume,
      source: quote.source,
      sma5: quote.sma5,
      sma20: quote.sma20,
      momentum5: quote.momentum5,
      bullish: quote.current >= quote.sma5 && quote.sma5 >= quote.sma20,
    });
  }

  return stocks;
}

function reviewPreviousRecommendations(previousState, currentStocksMap) {
  const previous = Array.isArray(previousState?.recommendations) ? previousState.recommendations : [];
  if (!previous.length) {
    return {
      date: previousState?.date || null,
      accuracy: '0/0',
      details: [],
      summary: '無前次推薦可覆盤',
    };
  }

  let correct = 0;
  const details = previous.map(rec => {
    const current = currentStocksMap.get(rec.symbol);
    const actionType = normalizeAction(rec.action);
    let result = '資料不足';
    let isCorrect = false;
    let currentPrice = null;
    let movePct = null;

    if (current && Number.isFinite(rec.priceAtRec)) {
      currentPrice = current.price;
      movePct = toFixedNumber(pct(rec.priceAtRec, current.price));
      if (actionType === 'bullish') {
        isCorrect = movePct > 0;
        result = isCorrect ? '上漲，判斷正確' : '未上漲，判斷失準';
      } else if (actionType === 'bearish') {
        isCorrect = movePct < 0;
        result = isCorrect ? '下跌，判斷正確' : '未下跌，判斷失準';
      } else {
        isCorrect = Math.abs(movePct) <= 1.5;
        result = isCorrect ? '波動有限，觀望合理' : '波動偏大，觀望失準';
      }
    }

    if (isCorrect) correct += 1;

    return {
      symbol: rec.symbol,
      name: rec.name,
      action: rec.action,
      priceAtRec: rec.priceAtRec,
      currentPrice,
      movePct,
      result,
      correct: isCorrect,
    };
  });

  return {
    date: previousState?.date || null,
    accuracy: `${correct}/${previous.length} 正確`,
    details,
    summary: `前次 ${previous.length} 檔推薦，本次覆盤 ${correct} 檔判斷正確`,
  };
}

function buildRecommendations(marketIndex, stocks) {
  const validStocks = stocks.filter(s => Number.isFinite(s.price));
  const marketBullish = marketIndex.changePct >= 0;

  const scored = validStocks.map(stock => {
    let score = 0;
    if (stock.changePct > 1.5) score += 3;
    else if (stock.changePct > 0) score += 2;
    else if (stock.changePct > -1) score += 1;

    if (stock.momentum5 > 3) score += 3;
    else if (stock.momentum5 > 0) score += 2;
    else if (stock.momentum5 > -2) score += 1;

    if (stock.bullish) score += 3;
    if (stock.price >= stock.sma20) score += 2;
    if (stock.price >= stock.sma5) score += 1;

    const volumeBase = stock.marketVolume || stock.volume || 0;
    const volumeScore = volumeBase > 30000000 ? 3 : volumeBase > 10000000 ? 2 : volumeBase > 3000000 ? 1 : 0;
    score += volumeScore;

    if (marketBullish) score += 1;

    let action = '留意';
    if (score >= 11) action = '偏多';
    else if (score >= 8) action = '可布局';

    const reasons = [];
    reasons.push(marketBullish ? '大盤偏多加分' : '大盤偏弱但個股相對強');
    reasons.push(`日變動 ${stock.changePct}%`);
    reasons.push(`5日動能 ${stock.momentum5}%`);
    reasons.push(stock.bullish ? '短中期均線多頭排列' : '均線未完全多排但有轉強跡象');
    if (volumeScore >= 1) reasons.push(`量能活躍(${volumeBase})`);

    return {
      symbol: stock.symbol,
      name: stock.name,
      action,
      reason: reasons.join('，'),
      priceAtRec: stock.price,
      changePct: stock.changePct,
      momentum5: stock.momentum5,
      score,
    };
  });

  const selected = scored
    .sort((a, b) => b.score - a.score || b.momentum5 - a.momentum5 || b.changePct - a.changePct)
    .slice(0, PICK_COUNT);

  return selected.length ? selected : validStocks.slice(0, PICK_COUNT).map(stock => ({
    symbol: stock.symbol,
    name: stock.name,
    action: '留意',
    reason: '資料不足，暫列入觀察',
    priceAtRec: stock.price,
    changePct: stock.changePct,
    momentum5: stock.momentum5,
    score: 0,
  }));
}

function buildDashboard(previousDashboard, state) {
  const recommendationMap = new Map(state.recommendations.map(rec => [rec.symbol, rec]));
  const watchlist = state.recommendations.map(rec => {
    const stock = state.stocks.find(s => s.symbol === rec.symbol) || {};
    return {
      code: rec.symbol,
      name: rec.name,
      price: rec.priceAtRec ?? stock.price ?? null,
      reason: rec.reason,
      buyReason: rec.action,
      technical: stock.error ? '待資料恢復' : `SMA5 ${stock.sma5} / SMA20 ${stock.sma20}，5日動能 ${stock.momentum5}%`,
      target: stock.error ? 'N/A' : rec.action === '偏多' ? '續強觀察' : rec.action === '可布局' ? '回測不破可留意' : '先列觀察',
      stopLoss: stock.error ? 'N/A' : toFixedNumber((stock.price || rec.priceAtRec || 0) * 0.96),
      category: '今日精選',
      source: stock.source || 'unknown',
      changePct: stock.changePct,
      momentum5: stock.momentum5,
    };
  });

  const alerts = [];
  if (state.marketClosed) alerts.push(`📭 ${state.marketNote}`);
  else alerts.push(`📊 加權指數 ${state.marketIndex.taiex}，漲跌 ${state.marketIndex.changePct}% (${state.marketIndex.trend})`);
  state.recommendations.forEach(rec => alerts.push(`🔎 ${rec.name} ${rec.action}: ${rec.reason}`));
  if (state.previousReview?.summary) alerts.push(`📝 ${state.previousReview.summary}`);

  return {
    ...previousDashboard,
    lastUpdate: formatTaipeiDisplay(),
    market: {
      ...(previousDashboard.market || {}),
      taiex: {
        close: state.marketIndex.taiex ?? null,
        change: state.marketIndex.change ?? 0,
        changePct: state.marketIndex.changePct ?? 0,
        volume: state.marketIndex.volume ?? 0,
        note: state.marketClosed ? state.marketNote : `${state.marketIndex.source}，趨勢 ${state.marketIndex.trend}`,
      },
    },
    watchlist,
    recommendations: {
      ai: state.recommendations.map(rec => ({
        code: rec.symbol,
        name: rec.name,
        reason: rec.reason,
        buyReason: rec.action,
        price: rec.priceAtRec,
      })),
      dividend: previousDashboard.recommendations?.dividend || [],
      etf: previousDashboard.recommendations?.etf || [],
    },
    analysis: {
      ...(previousDashboard.analysis || {}),
      preMarket: state.marketClosed ? `【盤前】${state.marketNote}` : `【盤前】加權指數 ${state.marketIndex.taiex}，日變動 ${state.marketIndex.changePct}% ，市場 ${state.marketIndex.trend}`,
      keyEvents: state.marketClosed ? '休市，今日不產出新推薦。' : state.recommendations.map((rec, i) => `${i + 1}) ${rec.name}${rec.action}，${rec.reason}`).join(' '),
      outlook: state.marketClosed ? '等待下個交易日。' : `以核心權值股為主觀察。${state.marketIndex.trend === '偏多' ? '短線偏多但仍需留意追價風險。' : '短線保守，宜控管部位。'}`,
      postMarket: state.previousReview?.summary || '尚無覆盤資料',
    },
    alerts,
    selfReview: {
      ...(previousDashboard.selfReview || {}),
      totalPicks: state.recommendations.length,
      hitTarget: Number((state.previousReview?.accuracy || '0/0').split('/')[0]) || 0,
      hitStop: 0,
      openPositions: 0,
      correctRate: state.previousReview?.accuracy || '0/0',
      lastUpdate: formatTaipeiDisplay(),
    },
    dataSource: state.sources.join(' + '),
  };
}

function appendMemoryLine(text) {
  const line = `- ${formatTaipeiDisplay()}: ${text}\n`;
  try {
    fs.appendFileSync(MEMORY_FILE, line, 'utf8');
  } catch {}
}

async function main() {
  ensureDir(DATA_DIR);

  const previousState = readJsonSafe(STATE_FILE, {});
  const previousDashboard = readJsonSafe(DASHBOARD_FILE, {});
  const timestamp = formatTaipeiTimestamp();
  const today = taipeiToday();

  const marketClosedByWeekend = isWeekendInTaipei();
  let marketIndex = {
    taiex: null,
    change: 0,
    changePct: 0,
    volume: 0,
    trend: '休市',
    source: 'none',
  };
  let stocks = [];
  let marketClosed = marketClosedByWeekend;
  let marketNote = marketClosedByWeekend ? '週末休市，今日不推薦個股。' : '';
  const sources = [];

  try {
    marketIndex = await fetchTaiex();
    sources.push(marketIndex.source);
  } catch (err) {
    marketClosed = true;
    marketNote = `加權指數資料取得失敗，暫視為休市或來源異常: ${err.message}`;
  }

  if (!marketClosed) {
    try {
      stocks = await fetchStocks();
      sources.push(...new Set(stocks.filter(s => s.source).map(s => s.source)));
      const successCount = stocks.filter(s => Number.isFinite(s.price)).length;
      if (!successCount) {
        marketClosed = true;
        marketNote = '個股資料來源皆失敗，暫不產出推薦。';
      }
    } catch (err) {
      marketClosed = true;
      marketNote = `個股資料抓取失敗: ${err.message}`;
    }
  }

  const currentStocksMap = new Map(stocks.filter(s => Number.isFinite(s.price)).map(s => [s.symbol, s]));
  const previousReview = reviewPreviousRecommendations(previousState, currentStocksMap);
  const recommendations = marketClosed ? [] : buildRecommendations(marketIndex, stocks);

  const state = {
    date: today,
    lastUpdate: timestamp,
    marketClosed,
    marketNote,
    marketIndex: {
      taiex: marketIndex.taiex,
      change: typeof marketIndex.changePct === 'number' ? `${marketIndex.changePct >= 0 ? '+' : ''}${marketIndex.changePct}%` : marketIndex.changePct,
      rawChange: marketIndex.change,
      changePct: marketIndex.changePct,
      volume: marketIndex.volume,
      trend: marketIndex.trend,
      source: marketIndex.source,
    },
    stocks,
    recommendations: recommendations.map(rec => ({
      symbol: rec.symbol,
      name: rec.name,
      action: rec.action,
      reason: rec.reason,
      priceAtRec: rec.priceAtRec,
    })),
    previousReview,
    sources: [...new Set(sources)].filter(Boolean),
  };

  writeJson(STATE_FILE, state);
  const dashboard = buildDashboard(previousDashboard, state);
  writeJson(DASHBOARD_FILE, dashboard);
  appendMemoryLine(marketClosed ? `stock_engine 執行完成，休市/異常: ${marketNote}` : `stock_engine 執行完成，產出 ${state.recommendations.length} 檔推薦，覆盤 ${previousReview.accuracy}`);

  console.log(JSON.stringify({ ok: true, stateFile: STATE_FILE, dashboardFile: DASHBOARD_FILE, marketClosed, recommendationCount: state.recommendations.length }, null, 2));
}

main().catch(err => {
  const fallback = {
    date: taipeiToday(),
    lastUpdate: formatTaipeiTimestamp(),
    marketClosed: true,
    marketNote: `engine crash protected: ${err.message}`,
    marketIndex: { taiex: null, change: '0%', rawChange: 0, changePct: 0, volume: 0, trend: '異常', source: 'none' },
    stocks: [],
    recommendations: [],
    previousReview: { date: null, accuracy: '0/0', details: [], summary: 'engine 發生錯誤，已保護性降級' },
    sources: [],
  };
  try {
    ensureDir(DATA_DIR);
    writeJson(STATE_FILE, fallback);
    const previousDashboard = readJsonSafe(DASHBOARD_FILE, {});
    writeJson(DASHBOARD_FILE, buildDashboard(previousDashboard, fallback));
    appendMemoryLine(`stock_engine 發生錯誤但已降級輸出: ${err.message}`);
  } catch {}
  console.error(err.stack || err.message);
  process.exitCode = 1;
});
