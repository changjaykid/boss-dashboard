#!/usr/bin/env node
// 外匯 + 虛擬貨幣 每日新聞更新器
// cron: 0 8,20 * * * 每天 08:00/20:00 執行
// 輸出：boss-dashboard/forex-news.json、boss-dashboard/crypto-news.json
// 使用 OpenAI gpt-4o-mini 翻譯 + 分析

const https = require('https');
const fs = require('fs');
const path = require('path');

const OPENAI_CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'openai_config.json'), 'utf8'));
const DASHBOARD_DIR = path.join(__dirname, '..', 'boss-dashboard');

// ─── 工具函數 ───

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : require('http');
    const req = mod.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      timeout: 15000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function askOpenAI(prompt, maxTokens = 2000) {
  const body = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: '你是專業金融新聞分析師。只回覆JSON格式。所有內容用繁體中文。' },
      { role: 'user', content: prompt }
    ],
    max_tokens: maxTokens,
    temperature: 0.3
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_CONFIG.api_key}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      timeout: 60000
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          resolve(j.choices?.[0]?.message?.content || '');
        } catch (e) { resolve(''); }
      });
    });
    req.on('error', () => resolve(''));
    req.on('timeout', () => { req.destroy(); resolve(''); });
    req.write(body);
    req.end();
  });
}

function parseJsonFromResponse(raw) {
  try {
    // Try array first
    const arrMatch = raw.match(/\[[\s\S]*\]/);
    if (arrMatch) return JSON.parse(arrMatch[0]);
    // Try object
    const objMatch = raw.match(/\{[\s\S]*\}/);
    if (objMatch) return JSON.parse(objMatch[0]);
  } catch (e) {}
  return null;
}

function getNow() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  // Asia/Taipei = UTC+8
  const tp = new Date(d.getTime() + 8 * 3600000);
  return `${tp.getUTCFullYear()}-${pad(tp.getUTCMonth() + 1)}-${pad(tp.getUTCDate())} ${pad(tp.getUTCHours())}:${pad(tp.getUTCMinutes())}:${pad(tp.getUTCSeconds())}`;
}

// ─── RSS / Reddit 抓取 ───

async function fetchGoogleNewsRSS(query) {
  try {
    const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
    const xml = await fetchUrl(url);
    const items = xml.split('<item>').slice(1, 11);
    const results = [];
    for (const item of items) {
      const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/);
      const linkMatch = item.match(/<link>(.*?)<\/link>/);
      const dateMatch = item.match(/<pubDate>(.*?)<\/pubDate>/);
      const sourceMatch = item.match(/<source[^>]*>(.*?)<\/source>/);
      const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : '';
      const link = linkMatch ? linkMatch[1].trim() : '';
      const pubDate = dateMatch ? dateMatch[1].trim() : '';
      const source = sourceMatch ? sourceMatch[1].trim() : '';
      if (title) results.push({ title, link, pubDate, source });
    }
    return results;
  } catch (e) {
    console.log(`RSS 失敗 [${query}]: ${e.message}`);
    return [];
  }
}

async function fetchRedditPosts(subreddit, limit = 10) {
  try {
    const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=${limit}`;
    const raw = await fetchUrl(url);
    const data = JSON.parse(raw);
    return (data.data?.children || []).map(c => ({
      title: c.data.title,
      link: `https://reddit.com${c.data.permalink}`,
      pubDate: new Date(c.data.created_utc * 1000).toUTCString(),
      score: c.data.score,
      author: c.data.author ? `u/${c.data.author}` : '',
      source: 'Reddit'
    }));
  } catch (e) {
    console.log(`Reddit 失敗 [${subreddit}]: ${e.message}`);
    return [];
  }
}

// ─── 搜尋關鍵字 ───

const FOREX_NEWS_QUERIES = [
  'XAUUSD gold price news',
  'EUR/USD GBP/USD USD/JPY forex',
  'Fed interest rate CPI inflation',
  'NFP jobs ECB BOE BOJ policy',
  'US30 SPX500 NAS100 index',
  '外匯 重大新聞 央行 利率',
  '黃金價格 美元指數'
];

const CRYPTO_NEWS_QUERIES = [
  'Bitcoin BTC news today',
  'Ethereum ETH crypto news',
  'crypto regulation SEC',
  'Bitcoin ETF whale transaction',
  'SOL DOGE altcoin news',
  '比特幣 以太坊 加密貨幣新聞',
  'Fear Greed Index crypto market'
];

const FOREX_SOCIAL_SUBREDDITS = ['algotrading', 'Forex', 'Trading'];
const CRYPTO_SOCIAL_SUBREDDITS = ['algotrading', 'CryptoCurrency', 'Bitcoin'];

const FOREX_SOCIAL_X_QUERIES = [
  'forex trading bot site:x.com OR site:twitter.com',
  'AI forex trading site:x.com OR site:twitter.com',
  'automated forex site:x.com OR site:twitter.com',
  'forex EA site:x.com OR site:twitter.com'
];

const CRYPTO_SOCIAL_X_QUERIES = [
  'crypto trading bot site:x.com OR site:twitter.com',
  'AI crypto trader site:x.com OR site:twitter.com',
  'automated crypto site:x.com OR site:twitter.com',
  'DeFi bot site:x.com OR site:twitter.com'
];

// ─── 新聞抓取與分析 ───

async function fetchAllNews(queries) {
  let allNews = [];
  for (const q of queries) {
    const news = await fetchGoogleNewsRSS(q);
    allNews = allNews.concat(news);
    await new Promise(r => setTimeout(r, 800));
  }
  // 去重
  const seen = new Set();
  return allNews.filter(n => {
    if (seen.has(n.title)) return false;
    seen.add(n.title);
    return true;
  });
}

async function analyzeForexNews(allNews) {
  const titles = allNews.slice(0, 25).map((n, i) =>
    `${i + 1}. [${n.source || 'Unknown'}] ${n.title} (${n.pubDate || ''})`
  ).join('\n');

  const prompt = `以下是最近的外匯/金融相關新聞標題：
${titles}

我們的交易系統聚焦：XAUUSD, EUR/USD, GBP/USD, USD/JPY, US30, SPX500, NAS100

請從中挑出對交易影響最大的 5 則，回覆JSON陣列格式：
[
  {
    "title": "繁體中文標題（英文要翻譯成中文）",
    "source": "新聞來源名稱（如 Reuters, Bloomberg 等）",
    "time": "新聞發布時間（格式：YYYY-MM-DD HH:mm UTC，盡量從 pubDate 推導）",
    "summary": "重點大意（2-3句繁體中文，說明這則新聞在講什麼）",
    "analysis": "對我們交易的影響解析（2-3句繁體中文，具體說明對哪些品種有什麼影響）",
    "impact": {
      "instruments": ["受影響的交易品種，如 GOLD, EURUSD, USDJPY, US30, SPX500, NAS100"],
      "direction": "影響方向描述（如：美元走弱 → 金價利多）",
      "severity": "high/medium/low"
    },
    "originalIndex": 原始編號
  }
]`;

  const raw = await askOpenAI(prompt, 2500);
  const parsed = parseJsonFromResponse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.map(item => {
    const original = allNews[(item.originalIndex || 1) - 1];
    return {
      title: item.title || '',
      source: item.source || original?.source || '',
      time: item.time || original?.pubDate || '',
      summary: item.summary || '',
      analysis: item.analysis || '',
      impact: {
        instruments: item.impact?.instruments || [],
        direction: item.impact?.direction || '',
        severity: item.impact?.severity || 'medium'
      }
    };
  });
}

async function analyzeCryptoNews(allNews) {
  const titles = allNews.slice(0, 25).map((n, i) =>
    `${i + 1}. [${n.source || 'Unknown'}] ${n.title} (${n.pubDate || ''})`
  ).join('\n');

  const prompt = `以下是最近的加密貨幣相關新聞標題：
${titles}

我們的交易系統聚焦：BTC, ETH, SOL, DOGE 等主要幣種（交易對：BTC/TWD, ETH/TWD, BTC/USDT, ETH/USDT, SOL/TWD, DOGE/TWD）

請從中挑出對交易影響最大的 5 則，回覆JSON陣列格式：
[
  {
    "title": "繁體中文標題（英文要翻譯成中文）",
    "source": "新聞來源名稱（如 CoinDesk, CoinTelegraph 等）",
    "time": "新聞發布時間（格式：YYYY-MM-DD HH:mm UTC，盡量從 pubDate 推導）",
    "summary": "重點大意（2-3句繁體中文，說明這則新聞在講什麼）",
    "analysis": "對我們交易的影響解析（2-3句繁體中文，具體說明對哪些幣種有什麼影響）",
    "impact": {
      "coins": ["受影響的幣種，如 BTC, ETH, SOL, DOGE"],
      "direction": "影響方向描述（如：BTC 利多、ETH 承壓）",
      "severity": "high/medium/low"
    },
    "originalIndex": 原始編號
  }
]`;

  // Retry up to 2 times if empty result
  for (let attempt = 0; attempt < 2; attempt++) {
    const raw = await askOpenAI(prompt, 2500);
    const parsed = parseJsonFromResponse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.map(item => {
        const original = allNews[(item.originalIndex || 1) - 1];
        return {
          title: item.title || '',
          source: item.source || original?.source || '',
          time: item.time || original?.pubDate || '',
          summary: item.summary || '',
          analysis: item.analysis || '',
          impact: {
            coins: item.impact?.coins || [],
            direction: item.impact?.direction || '',
            severity: item.impact?.severity || 'medium'
          }
        };
      });
    }
    console.log(`虛擬貨幣新聞分析第 ${attempt+1} 次嘗試返回空，重試...`);
    await new Promise(r => setTimeout(r, 2000));
  }
  console.log('⚠️ 虛擬貨幣新聞分析失敗，使用原始標題作為備份');
  // Fallback: use raw titles
  return allNews.slice(0, 5).map(n => ({
    title: n.title || '',
    source: n.source || '',
    time: n.pubDate || '',
    summary: n.title || '',
    analysis: '（自動分析暫時不可用，請查看原文）',
    impact: { coins: ['BTC'], direction: '待分析', severity: 'medium' }
  }));
}

// ─── 社群討論抓取與分析 ───

async function fetchSocialPosts(subreddits, xQueries) {
  let allPosts = [];

  for (const sub of subreddits) {
    const posts = await fetchRedditPosts(sub, 10);
    allPosts = allPosts.concat(posts);
    await new Promise(r => setTimeout(r, 1000));
  }

  for (const q of xQueries) {
    const news = await fetchGoogleNewsRSS(q);
    allPosts = allPosts.concat(news.map(n => ({ ...n, source: 'X', author: '' })));
    await new Promise(r => setTimeout(r, 800));
  }

  // 去重
  const seen = new Set();
  allPosts = allPosts.filter(n => {
    const key = n.title.slice(0, 30);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  allPosts.sort((a, b) => (b.score || 0) - (a.score || 0));
  return allPosts;
}

async function analyzeSocialPosts(posts, type) {
  const titles = posts.slice(0, 25).map((n, i) =>
    `${i + 1}. [${n.source || 'Unknown'}] ${n.title} (by ${n.author || 'unknown'})`
  ).join('\n');
  const label = type === 'forex' ? '外匯' : '加密貨幣';
  const focusKeywords = type === 'forex'
    ? 'forex trading bot, AI forex, automated forex, forex EA'
    : 'crypto trading bot, AI crypto trader, automated crypto, DeFi bot';

  const prompt = `以下是 X(Twitter) 和 Reddit 上關於「AI 自動${label}交易」的熱門討論：
${titles}

搜尋關鍵字：${focusKeywords}

我正在做 AI 自動${label}交易系統，想從社群學到具體可執行的東西。

請從中挑出最有實戰參考價值的 3-5 則，回覆JSON陣列格式：
[
  {
    "platform": "X 或 Reddit",
    "title": "繁體中文標題（英文要翻譯）",
    "author": "作者名稱（如 @username 或 u/username）",
    "summary": "內容大意（2-3句繁體中文，具體寫出：用什麼語言/平台？什麼策略/指標？參數怎麼設？效果如何？）",
    "whatTheyDid": "他具體做了什麼（1-2句，如：用 Python + ccxt 串接幣安，RSI<30 買入 RSI>70 賣出，15min K線）",
    "whatWeCanLearn": "我們可以參考什麼（1-2句，如：加入 RSI 過濾條件到我們的入場邏輯）",
    "originalIndex": 原始編號
  }
]

重要：summary 和 whatTheyDid 必須寫出具體做法，不能只說「他分享了經驗」。`;

  const raw = await askOpenAI(prompt, 2500);
  const parsed = parseJsonFromResponse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.map(item => {
    const original = posts[(item.originalIndex || 1) - 1];
    return {
      platform: item.platform || original?.source || '',
      title: item.title || '',
      author: item.author || original?.author || '',
      summary: item.summary || '',
      whatTheyDid: item.whatTheyDid || '',
      whatWeCanLearn: item.whatWeCanLearn || '',
      url: original?.link || ''
    };
  });
}

// ─── 總結 conclusion ───

async function generateConclusion(newsItems, socialItems, type) {
  const label = type === 'forex' ? '外匯' : '加密貨幣';
  const instruments = type === 'forex'
    ? 'XAUUSD, EUR/USD, GBP/USD, USD/JPY, US30, SPX500, NAS100'
    : 'BTC, ETH, SOL, DOGE（交易對：BTC/TWD, ETH/TWD, BTC/USDT, ETH/USDT, SOL/TWD, DOGE/TWD）';

  const newsSummary = newsItems.map((n, i) => `${i + 1}. ${n.title}: ${n.summary}`).join('\n');
  const socialSummary = socialItems.map((s, i) => `${i + 1}. ${s.title}: ${s.whatWeCanLearn}`).join('\n');

  const prompt = `你是我的 AI 自動${label}交易系統的管家。
交易品種：${instruments}

今天的新聞重點：
${newsSummary || '（無）'}

社群討論重點：
${socialSummary || '（無）'}

請根據以上資訊，產出一份對老闆有用的總結，回覆JSON格式：
{
  "marketOutlook": "市場展望（3-5句繁體中文，綜合分析目前市場狀態與短期趨勢）",
  "tradingImplications": [
    "對我們交易系統的具體影響1（如：金價受避險需求推動，系統應加大黃金做多權重）",
    "對我們交易系統的具體影響2",
    "對我們交易系統的具體影響3"
  ],
  "suggestedActions": [
    "建議操作方向1（如：黃金維持做多偏多策略，支撐 4600 阻力 4700）",
    "建議操作方向2（如：美日短線偏空，等待 160 關口確認方向）"
  ],
  "keyTimeline": [
    "關鍵事件時間軸1（如：4/8 美國 CPI 數據公布，注意美元波動）",
    "關鍵事件時間軸2（如：4/10 ECB 利率決議，影響歐元走勢）"
  ],
  "systemOptimization": [
    "系統優化建議1（如：高波動期加大止損距離，避免假突破被掃）",
    "系統優化建議2"
  ]
}

所有內容用繁體中文，具體到可以執行的程度。`;

  const raw = await askOpenAI(prompt, 1500);
  const parsed = parseJsonFromResponse(raw);
  if (parsed && parsed.marketOutlook) {
    return {
      marketOutlook: parsed.marketOutlook || '',
      tradingImplications: parsed.tradingImplications || [],
      suggestedActions: parsed.suggestedActions || [],
      keyTimeline: parsed.keyTimeline || [],
      systemOptimization: parsed.systemOptimization || []
    };
  }
  return {
    marketOutlook: '資料不足，無法產出市場展望。',
    tradingImplications: [],
    suggestedActions: [],
    keyTimeline: [],
    systemOptimization: []
  };
}

// ─── 主程式 ───

async function main() {
  const now = getNow();
  console.log(`[${now}] 開始抓取新聞...`);

  // Step 0: 先跑 Python 價格抓取腳本（forex prices from Yahoo Finance）
  try {
    const { execSync } = require('child_process');
    const scriptPath = path.join(__dirname, '..', 'skills', 'forex-news', 'scripts', 'update_forex_prices.py');
    if (fs.existsSync(scriptPath)) {
      console.log('🔄 執行價格抓取腳本 (update_forex_prices.py)...');
      const output = execSync(`python3 "${scriptPath}"`, { encoding: 'utf8', timeout: 60000 });
      console.log(output);
    } else {
      console.log('⚠️ 價格腳本不存在，跳過價格更新');
    }
  } catch (e) {
    console.log(`⚠️ 價格腳本執行失敗: ${e.message}`);
  }

  // 並行抓取新聞 RSS + 社群討論
  const [forexRaw, cryptoRaw, forexSocialPosts, cryptoSocialPosts] = await Promise.all([
    fetchAllNews(FOREX_NEWS_QUERIES),
    fetchAllNews(CRYPTO_NEWS_QUERIES),
    fetchSocialPosts(FOREX_SOCIAL_SUBREDDITS, FOREX_SOCIAL_X_QUERIES),
    fetchSocialPosts(CRYPTO_SOCIAL_SUBREDDITS, CRYPTO_SOCIAL_X_QUERIES)
  ]);

  console.log(`抓取完成 — 外匯原始: ${forexRaw.length} | 虛擬貨幣原始: ${cryptoRaw.length} | 外匯社群: ${forexSocialPosts.length} | 虛擬貨幣社群: ${cryptoSocialPosts.length}`);

  // 並行 OpenAI 分析新聞 + 社群
  const [forexNews, cryptoNews, forexSocial, cryptoSocial] = await Promise.all([
    analyzeForexNews(forexRaw),
    analyzeCryptoNews(cryptoRaw),
    analyzeSocialPosts(forexSocialPosts, 'forex'),
    analyzeSocialPosts(cryptoSocialPosts, 'crypto')
  ]);

  console.log(`分析完成 — 外匯新聞: ${forexNews.length} | 虛擬貨幣新聞: ${cryptoNews.length} | 外匯社群: ${forexSocial.length} | 虛擬貨幣社群: ${cryptoSocial.length}`);

  // 並行產出 conclusion
  const [forexConclusion, cryptoConclusion] = await Promise.all([
    generateConclusion(forexNews, forexSocial, 'forex'),
    generateConclusion(cryptoNews, cryptoSocial, 'crypto')
  ]);

  // 寫入 forex-news.json（保留腳本產生的 prices 區塊）
  let existingFx = {};
  try {
    existingFx = JSON.parse(fs.readFileSync(path.join(DASHBOARD_DIR, 'forex-news.json'), 'utf8'));
  } catch (e) {}
  const fxOutput = {
    lastUpdate: now,
    updateCycle: '08:00/20:00',
    ...(existingFx.prices ? { prices: existingFx.prices } : {}),
    news: forexNews,
    socialDiscussions: forexSocial,
    conclusion: forexConclusion
  };
  fs.writeFileSync(path.join(DASHBOARD_DIR, 'forex-news.json'), JSON.stringify(fxOutput, null, 2));

  // 寫入 crypto-news.json
  const cryptoOutput = {
    lastUpdate: now,
    updateCycle: '08:00/20:00',
    news: cryptoNews,
    socialDiscussions: cryptoSocial,
    conclusion: cryptoConclusion
  };
  fs.writeFileSync(path.join(DASHBOARD_DIR, 'crypto-news.json'), JSON.stringify(cryptoOutput, null, 2));

  console.log(`外匯新聞: ${forexNews.length} 則 | 虛擬貨幣新聞: ${cryptoNews.length} 則`);
  console.log(`外匯社群: ${forexSocial.length} 則 | 虛擬貨幣社群: ${cryptoSocial.length} 則`);

  // Git push
  try {
    const { execSync } = require('child_process');
    execSync(`cd ${DASHBOARD_DIR} && git pull --rebase origin main 2>/dev/null; git add forex-news.json crypto-news.json && git commit -m "auto: 每日新聞更新 ${now}" && git push origin main`, { stdio: 'ignore' });
    console.log('Git push 完成');
  } catch (e) {}

  console.log(`[${getNow()}] 新聞更新完成`);
}

main().catch(console.error);
