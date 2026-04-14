#!/usr/bin/env node
/**
 * Threads 社群發佈器 v3 (2026-04-07 重寫)
 * 
 * 🔑 核心原則：單一狀態來源 = dashboard.json
 * 
 * 不再有：
 * - drafts/ 資料夾（草稿存在 dashboard.json.drafts[]）
 * - published/ 資料夾（已發文存在 dashboard.json.published[]）
 * - published_ids.json（published[] 裡的 id 就是記錄）
 * - social-data.json 手動同步（自動從 dashboard.json 複製）
 * 
 * 流程：
 * 1. 讀 dashboard.json
 * 2. 找 status=approved 的草稿
 * 3. API 查重（硬性防護）
 * 4. 發佈到 Threads（超過 500 字自動拆主文+留言）
 * 5. 更新 dashboard.json（草稿移到 published）
 * 6. 呼叫 sync_dashboards.sh 同步到 boss-dashboard
 * 7. git push
 * 
 * 就這樣。一個檔案，一個來源。
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const WORKER_DIR = path.join(__dirname, '..');
const DASHBOARD_FILE = path.join(WORKER_DIR, 'dashboard.json');
const CONFIG_FILE = path.join(WORKER_DIR, 'data', 'config.json');
const SYNC_SCRIPT = path.join(__dirname, '..', '..', 'sync_dashboards.sh');
const MAX_CHAR = 500;

// ========== THREADS API ==========

function threadsRequest(method, urlPath) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'graph.threads.net',
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, data: JSON.parse(data) }); }
        catch (e) { resolve({ status: res.statusCode, data: { raw: data } }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ========== DUPLICATE CHECK (API-level) ==========

async function isDuplicateOnThreads(text, config) {
  const token = config.threads.access_token;
  const userId = config.threads.threads_user_id || config.threads.user_id;
  try {
    const url = `/v1.0/${userId}/threads?fields=id,text&limit=10&access_token=${token}`;
    const res = await threadsRequest('GET', url);
    if (res.status === 200 && res.data.data) {
      const needle = text.substring(0, 80);
      return res.data.data.some(p => p.text && p.text.substring(0, 80) === needle);
    }
  } catch (e) { console.error('⚠️ 查重失敗 (fail open):', e.message); }
  return false;
}

// ========== SPLIT TEXT (500 char limit) ==========

function splitText(text) {
  if (text.length <= MAX_CHAR) return { main: text, reply: null };
  
  const paragraphs = text.split('\n\n');
  let main = '';
  let splitIdx = paragraphs.length;
  
  for (let i = 0; i < paragraphs.length; i++) {
    const candidate = main + (main ? '\n\n' : '') + paragraphs[i];
    if (candidate.length > MAX_CHAR - 10) { // 留 10 字 buffer
      splitIdx = i;
      break;
    }
    main = candidate;
  }
  
  const reply = paragraphs.slice(splitIdx).join('\n\n');
  return { main, reply: reply || null };
}

// ========== PUBLISH ==========

async function publishPost(text, config, imageUrl = null) {
  const token = config.threads.access_token;
  const userId = config.threads.threads_user_id || config.threads.user_id;
  
  // Step 1: Create container
  let createUrl;
  if (imageUrl) {
    createUrl = `/v1.0/${userId}/threads?media_type=IMAGE&text=${encodeURIComponent(text)}&image_url=${encodeURIComponent(imageUrl)}&access_token=${token}`;
  } else {
    createUrl = `/v1.0/${userId}/threads?media_type=TEXT&text=${encodeURIComponent(text)}&access_token=${token}`;
  }
  
  const createRes = await threadsRequest('POST', createUrl);
  if (createRes.status !== 200 || !createRes.data.id) {
    return { success: false, error: createRes.data };
  }
  
  // Step 2: Publish
  await new Promise(r => setTimeout(r, 3000));
  const publishUrl = `/v1.0/${userId}/threads_publish?creation_id=${createRes.data.id}&access_token=${token}`;
  const publishRes = await threadsRequest('POST', publishUrl);
  
  if (publishRes.status !== 200 || !publishRes.data.id) {
    return { success: false, error: publishRes.data };
  }
  
  return { success: true, threadId: publishRes.data.id };
}

async function publishReply(text, parentId, config) {
  const token = config.threads.access_token;
  const userId = config.threads.threads_user_id || config.threads.user_id;
  
  const createUrl = `/v1.0/${userId}/threads?media_type=TEXT&text=${encodeURIComponent(text)}&reply_to_id=${parentId}&access_token=${token}`;
  const createRes = await threadsRequest('POST', createUrl);
  if (createRes.status !== 200 || !createRes.data.id) return null;
  
  await new Promise(r => setTimeout(r, 3000));
  const publishUrl = `/v1.0/${userId}/threads_publish?creation_id=${createRes.data.id}&access_token=${token}`;
  const publishRes = await threadsRequest('POST', publishUrl);
  
  return publishRes.data.id || null;
}

// ========== SYNC TO BOSS DASHBOARD ==========

function syncToBossDashboard() {
  try {
    execSync(`zsh ${SYNC_SCRIPT}`, { timeout: 20000 });
    console.log('📊 主控板已同步');
  } catch (e) {
    console.error('⚠️ 主控板同步失敗:', e.message);
  }
}

// ========== MAIN ==========

async function main() {
  // Load single source of truth
  const dashboard = JSON.parse(fs.readFileSync(DASHBOARD_FILE, 'utf8'));
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  
  // Process approval queue from boss dashboard (if any)
  if (dashboard.approvalQueue && dashboard.approvalQueue.length > 0) {
    for (const action of dashboard.approvalQueue) {
      const draft = dashboard.drafts.find(d => d.id === action.id);
      if (!draft) continue;
      if (action.action === 'approve') {
        draft.status = 'approved';
        console.log(`✅ ${action.id} approved`);
      } else if (action.action === 'reject') {
        draft.status = 'rejected';
        console.log(`❌ ${action.id} rejected`);
      }
    }
    dashboard.approvalQueue = [];
  }
  
  // Find approved drafts
  const approved = dashboard.drafts.filter(d => d.status === 'approved');
  
  if (approved.length === 0) {
    console.log('📭 沒有待發佈的草稿');
    dashboard.lastUpdate = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    fs.writeFileSync(DASHBOARD_FILE, JSON.stringify(dashboard, null, 2));
    syncToBossDashboard();
    return;
  }
  
  console.log(`📬 找到 ${approved.length} 篇待發佈`);
  
  for (const draft of approved) {
    const fullText = draft.content;
    
    // 🔒 API duplicate check
    const dupe = await isDuplicateOnThreads(fullText, config);
    if (dupe) {
      console.log(`🚫 ${draft.id} 與線上貼文重複，跳過`);
      draft.status = 'duplicate_blocked';
      continue;
    }
    
    // Also check against our own published list
    if (dashboard.published.some(p => p.id === draft.id)) {
      console.log(`🚫 ${draft.id} 已在 published 列表，跳過`);
      draft.status = 'duplicate_blocked';
      continue;
    }
    
    // Split if needed
    const { main: mainText, reply: replyText } = splitText(fullText);
    const imageUrl = (draft.image_url && draft.image_url.startsWith('http')) ? draft.image_url : null;
    
    console.log(`📤 發佈: ${draft.id} (${mainText.length} 字${replyText ? ' + 留言' + replyText.length + '字' : ''})`);
    
    try {
      const result = await publishPost(mainText, config, imageUrl);
      
      if (result.success) {
        console.log(`✅ ${draft.id} 發佈成功! ID: ${result.threadId}`);
        
        // Publish reply if needed
        let replyId = null;
        if (replyText) {
          await new Promise(r => setTimeout(r, 3000));
          replyId = await publishReply(replyText, result.threadId, config);
          if (replyId) console.log(`✅ 留言發佈成功! ID: ${replyId}`);
        }
        
        // Update draft → published (in dashboard.json)
        draft.status = 'published';
        draft.published_at = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
        draft.thread_id = result.threadId;
        draft.thread_url = `https://www.threads.net/@${config.threads.username}/post/${result.threadId}`;
        if (replyId) draft.reply_id = replyId;
        
        // Move from drafts[] to published[]
        dashboard.published.unshift(draft);
        dashboard.drafts = dashboard.drafts.filter(d => d.id !== draft.id);
        
      } else {
        console.error(`❌ ${draft.id} 發佈失敗:`, JSON.stringify(result.error));
        draft.status = 'failed';
        draft.error = result.error;
      }
    } catch (e) {
      console.error(`❌ ${draft.id} 錯誤:`, e.message);
      draft.status = 'failed';
      draft.error = e.message;
    }
    
    // Wait between posts
    await new Promise(r => setTimeout(r, 5000));
  }
  
  // Save dashboard (single write, single source)
  dashboard.lastUpdate = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  fs.writeFileSync(DASHBOARD_FILE, JSON.stringify(dashboard, null, 2));
  console.log('💾 dashboard.json 已更新');
  
  // Sync to boss dashboard (copy, not independent state)
  syncToBossDashboard();
  
  console.log('🎉 完成');
}

main().catch(e => {
  console.error('Publisher error:', e.message);
  process.exit(1);
});
