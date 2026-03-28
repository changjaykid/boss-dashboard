#!/usr/bin/env node
// 廣告業務潛在客戶搜尋器
// 搜尋來源：DuckDuckGo / Bing（不需登入）
// 關鍵字：我要發案 廣告投放 行銷 代操 廣告投手

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, '..', 'boss-dashboard', 'ad-business-data.json');

const SEARCH_QUERIES = [
  '我要發案 廣告投放',
  '我要發案 行銷',
  '我要發案 代操',
  '徵 廣告投手 代操',
  '找 廣告投放 行銷 合作',
  '#包 廣告 行銷',
  'threads 徵廣告投手',
  'facebook 我要發案 廣告',
];

const KEYWORDS_FILTER = ['廣告', '投放', '代操', '行銷', '投手', '發案', '品牌', 'FB廣告', 'Google廣告', 'Meta', '社群', '操盤'];

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { 
      headers: { 
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'zh-TW,zh;q=0.9'
      },
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

function extractSnippets(html) {
  const results = [];
  // 簡易解析搜尋結果
  const titleRegex = /<a[^>]*href="([^"]*)"[^>]*>([^<]*(?:<[^>]*>[^<]*)*)<\/a>/gi;
  const snippetRegex = /<span[^>]*class="[^"]*snippet[^"]*"[^>]*>([^<]*(?:<[^>]*>[^<]*)*)<\/span>/gi;
  
  let match;
  while ((match = titleRegex.exec(html)) !== null) {
    const url = match[1];
    const title = match[2].replace(/<[^>]*>/g, '').trim();
    if (title && url && !url.includes('duckduckgo') && !url.includes('bing.com')) {
      results.push({ url, title });
    }
  }
  return results;
}

function isRelevant(text) {
  const lower = text.toLowerCase();
  let score = 0;
  for (const kw of KEYWORDS_FILTER) {
    if (lower.includes(kw.toLowerCase())) score++;
  }
  return score >= 2; // 至少命中2個關鍵字才算相關
}

async function searchWeb(query) {
  const leads = [];
  
  // 方法1: 用 SearXNG 公開實例搜尋
  const searxInstances = [
    'https://search.sapti.me',
    'https://searx.be',
    'https://search.neet.works',
  ];
  
  for (const instance of searxInstances) {
    try {
      const url = `${instance}/search?q=${encodeURIComponent(query)}&format=json&language=zh-TW&categories=general`;
      const raw = await fetchUrl(url);
      const data = JSON.parse(raw);
      
      if (data.results && data.results.length > 0) {
        for (const r of data.results.slice(0, 10)) {
          const fullText = `${r.title || ''} ${r.content || ''}`;
          
          if (isRelevant(fullText)) {
            let platform = '其他';
            const u = r.url || '';
            if (u.includes('facebook.com') || u.includes('fb.com')) platform = 'Facebook';
            else if (u.includes('threads.net') || u.includes('threads.com')) platform = 'Threads';
            else if (u.includes('instagram.com')) platform = 'Instagram';
            else if (u.includes('ptt.cc')) platform = 'PTT';
            else if (u.includes('dcard.tw')) platform = 'Dcard';
            
            leads.push({
              platform,
              title: (r.title || '').substring(0, 100),
              summary: (r.content || '').substring(0, 300),
              reason: `搜尋「${query}」命中，內容含廣告/行銷/投放相關需求`,
              url: u,
              time: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
              score: '待判斷',
              query
            });
          }
        }
        console.log(`  ${instance} 找到 ${leads.length} 筆相關結果`);
        return leads; // 成功就不用試下一個
      }
    } catch (err) {
      console.log(`  ${instance} 失敗: ${err.message}`);
    }
  }
  
  // 方法2: 用 Google RSS 搜尋
  try {
    const gUrl = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=zh-TW&gl=TW&ceid=TW:zh-Hant`;
    const xml = await fetchUrl(gUrl);
    const items = xml.split('<item>').slice(1);
    
    for (const item of items.slice(0, 10)) {
      const titleMatch = item.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/);
      const linkMatch = item.match(/<link>(.*?)<\/link>/);
      const descMatch = item.match(/<description>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/description>/);
      
      const title = titleMatch ? titleMatch[1].replace(/<[^>]*>/g, '').trim() : '';
      const link = linkMatch ? linkMatch[1].trim() : '';
      const desc = descMatch ? descMatch[1].replace(/<[^>]*>/g, '').trim() : '';
      const fullText = `${title} ${desc}`;
      
      if (title && isRelevant(fullText)) {
        let platform = '新聞/其他';
        if (link.includes('facebook.com')) platform = 'Facebook';
        else if (link.includes('threads.')) platform = 'Threads';
        
        leads.push({
          platform,
          title: title.substring(0, 100),
          summary: desc.substring(0, 300),
          reason: `搜尋「${query}」命中，內容含廣告/行銷/投放相關需求`,
          url: link,
          time: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
          score: '待判斷',
          query
        });
      }
    }
    if (leads.length > 0) console.log(`  Google News RSS 找到 ${leads.length} 筆`);
  } catch (err) {
    console.log(`  Google News RSS 失敗: ${err.message}`);
  }
  
  return leads;
}

async function main() {
  console.log(`[${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}] 開始搜尋潛在客戶...`);
  
  let allLeads = [];
  
  // 每次隨機選 3-4 個查詢，避免被封鎖
  const shuffled = SEARCH_QUERIES.sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, 4);
  
  for (const query of selected) {
    console.log(`搜尋: ${query}`);
    const leads = await searchWeb(query);
    allLeads = allLeads.concat(leads);
    
    // 間隔 3-5 秒避免被封
    await new Promise(r => setTimeout(r, 3000 + Math.random() * 2000));
  }
  
  // 去重（用 URL）
  const seen = new Set();
  allLeads = allLeads.filter(l => {
    if (seen.has(l.url)) return false;
    seen.add(l.url);
    return true;
  });
  
  // 讀取現有資料
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    data = { project: {}, targets: [], summary: {}, leads: [], notes: [] };
  }
  
  // 合併新名單（保留最近 50 筆）
  const existingUrls = new Set((data.leads || []).map(l => l.url));
  const newLeads = allLeads.filter(l => !existingUrls.has(l.url));
  
  data.leads = [...newLeads, ...(data.leads || [])].slice(0, 50);
  
  // 更新統計
  const today = new Date().toLocaleDateString('zh-TW', { timeZone: 'Asia/Taipei' });
  const todayLeads = data.leads.filter(l => l.time && l.time.includes(today));
  
  data.summary = {
    todayLeads: todayLeads.length,
    facebookLeads: todayLeads.filter(l => l.platform === 'Facebook').length,
    threadsLeads: todayLeads.filter(l => l.platform === 'Threads').length,
    totalLeads: data.leads.length,
    lastUpdate: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
    nextAction: newLeads.length > 0 ? `新增 ${newLeads.length} 筆潛在客戶` : '持續監控中'
  };
  
  data.project = {
    name: '廣告業務',
    goal: '每天找出有機會變成客戶的人，整理在主控版給老闆看',
    status: '運行中'
  };
  
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  
  console.log(`完成！新增 ${newLeads.length} 筆，總計 ${data.leads.length} 筆`);
}

main().catch(console.error);
