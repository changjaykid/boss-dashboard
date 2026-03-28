#!/usr/bin/env node
// 外匯 + 虛擬貨幣 每日新聞更新器
// 每天中午 12:00 執行，抓取最近 24 小時重大新聞
// 用 OpenAI gpt-4o-mini 翻譯 + 解析影響

const https = require('https');
const fs = require('fs');
const path = require('path');

const OPENAI_CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'openai_config.json'), 'utf8'));
const DASHBOARD_DIR = path.join(__dirname, '..', 'boss-dashboard');

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

async function askOpenAI(prompt) {
  const body = JSON.stringify({
    model: 'gpt-4o-mini',
    messages: [
      { role: 'system', content: '你是專業金融新聞分析師。只回覆JSON格式。所有內容用繁體中文。' },
      { role: 'user', content: prompt }
    ],
    max_tokens: 1500,
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
      timeout: 30000
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
      
      const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : '';
      const link = linkMatch ? linkMatch[1].trim() : '';
      const pubDate = dateMatch ? dateMatch[1].trim() : '';
      
      if (title) {
        results.push({ title, link, pubDate });
      }
    }
    return results;
  } catch (e) {
    console.log(`RSS 失敗 [${query}]: ${e.message}`);
    return [];
  }
}

async function getForexNews() {
  const queries = ['外匯 重大新聞', 'forex market news', '美元 利率 央行', '黃金 原油 價格'];
  let allNews = [];
  
  for (const q of queries) {
    const news = await fetchGoogleNewsRSS(q);
    allNews = allNews.concat(news);
    await new Promise(r => setTimeout(r, 1000));
  }
  
  // 去重
  const seen = new Set();
  allNews = allNews.filter(n => {
    if (seen.has(n.title)) return false;
    seen.add(n.title);
    return true;
  });
  
  // 用 OpenAI 篩選最重要的 5 則並解析
  const titles = allNews.slice(0, 20).map((n, i) => `${i + 1}. ${n.title}`).join('\n');
  
  const prompt = `以下是最近的外匯/金融相關新聞標題：
${titles}

請從中挑出最重要的 5 則（對外匯交易影響最大的），回覆JSON格式：
[
  {
    "title": "繁體中文標題（如果是英文要翻譯）",
    "summary": "一句話摘要，說明這則新聞的重點",
    "impact": "對外匯市場的具體影響分析（2-3句話）",
    "affected": "受影響的幣對或商品（如 XAUUSD、EURUSD、US500）",
    "sentiment": "利多/利空/中性",
    "originalIndex": 原始編號
  }
]`;

  const raw = await askOpenAI(prompt);
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return parsed.map(item => {
        const original = allNews[item.originalIndex - 1];
        return {
          ...item,
          url: original?.link || '',
          pubDate: original?.pubDate || ''
        };
      });
    }
  } catch (e) {}
  return [];
}

async function getCryptoNews() {
  const queries = ['比特幣 新聞', 'ethereum crypto news', '加密貨幣 重大', 'bitcoin market'];
  let allNews = [];
  
  for (const q of queries) {
    const news = await fetchGoogleNewsRSS(q);
    allNews = allNews.concat(news);
    await new Promise(r => setTimeout(r, 1000));
  }
  
  const seen = new Set();
  allNews = allNews.filter(n => {
    if (seen.has(n.title)) return false;
    seen.add(n.title);
    return true;
  });
  
  const titles = allNews.slice(0, 20).map((n, i) => `${i + 1}. ${n.title}`).join('\n');
  
  const prompt = `以下是最近的加密貨幣相關新聞標題：
${titles}

請從中挑出最重要的 5 則（對加密貨幣交易影響最大的），回覆JSON格式：
[
  {
    "title": "繁體中文標題（如果是英文要翻譯）",
    "summary": "一句話摘要，說明這則新聞的重點",
    "impact": "對加密貨幣市場的具體影響分析（2-3句話）",
    "affected": "受影響的幣種（如 BTC、ETH、SOL）",
    "sentiment": "利多/利空/中性",
    "originalIndex": 原始編號
  }
]`;

  const raw = await askOpenAI(prompt);
  try {
    const match = raw.match(/\[[\s\S]*\]/);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return parsed.map(item => {
        const original = allNews[item.originalIndex - 1];
        return {
          ...item,
          url: original?.link || '',
          pubDate: original?.pubDate || ''
        };
      });
    }
  } catch (e) {}
  return [];
}

async function main() {
  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  console.log(`[${now}] 開始抓取新聞...`);
  
  const [forexNews, cryptoNews] = await Promise.all([getForexNews(), getCryptoNews()]);
  
  // 寫入 trading-data.json（外匯）
  const fxFile = path.join(DASHBOARD_DIR, 'trading-data.json');
  let fxData = {};
  try { fxData = JSON.parse(fs.readFileSync(fxFile, 'utf8')); } catch (e) {}
  fxData.news = {
    items: forexNews,
    lastUpdate: now
  };
  fs.writeFileSync(fxFile, JSON.stringify(fxData, null, 2));
  
  // 寫入 crypto-trading-data.json（虛擬貨幣）
  const cryptoFile = path.join(DASHBOARD_DIR, 'crypto-trading-data.json');
  let cryptoData = {};
  try { cryptoData = JSON.parse(fs.readFileSync(cryptoFile, 'utf8')); } catch (e) {}
  cryptoData.news = {
    items: cryptoNews,
    lastUpdate: now
  };
  fs.writeFileSync(cryptoFile, JSON.stringify(cryptoData, null, 2));
  
  console.log(`外匯新聞: ${forexNews.length} 則 | 虛擬貨幣新聞: ${cryptoNews.length} 則`);
  
  // 推送
  try {
    const { execSync } = require('child_process');
    execSync(`cd ${DASHBOARD_DIR} && git add -A && git commit -m "auto: 每日新聞更新 ${now}" && git push origin main`, { stdio: 'ignore' });
  } catch (e) {}
  
  console.log(`[${now}] 新聞更新完成`);
}

main().catch(console.error);
