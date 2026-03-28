#!/usr/bin/env node
/**
 * Threads 社群發佈器
 * 安全模式：Threads API token 只在本機後端使用，前端零接觸
 * 
 * 流程：
 * 1. git pull 取得最新草稿狀態
 * 2. 掃描 approved 草稿
 * 3. 透過 Threads API 發佈
 * 4. 更新狀態為 published
 * 5. 同步到主控板 JSON + git push
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');

const SOCIAL_DIR = path.join(__dirname);
const DRAFTS_DIR = path.join(SOCIAL_DIR, 'drafts');
const PUBLISHED_DIR = path.join(SOCIAL_DIR, 'published');
const CONFIG_FILE = path.join(SOCIAL_DIR, 'config.json');
const DASHBOARD_DIR = path.join(__dirname, '..', 'boss-dashboard');
const SOCIAL_DATA_FILE = path.join(DASHBOARD_DIR, 'social-data.json');

// ========== THREADS API ==========

function threadsRequest(method, urlPath, body = null) {
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
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch (e) {
          resolve({ status: res.statusCode, data: { raw: data } });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function publishToThreads(text, config) {
  const token = config.threads.access_token;
  const userId = config.threads.threads_user_id;

  // Step 1: Create media container
  const createUrl = `/v1.0/${userId}/threads?media_type=TEXT&text=${encodeURIComponent(text)}&access_token=${token}`;
  const createRes = await threadsRequest('POST', createUrl);

  if (createRes.status !== 200 || !createRes.data.id) {
    return { success: false, error: createRes.data };
  }

  const containerId = createRes.data.id;

  // Step 2: Wait a moment for processing
  await new Promise(r => setTimeout(r, 3000));

  // Step 3: Publish
  const publishUrl = `/v1.0/${userId}/threads_publish?creation_id=${containerId}&access_token=${token}`;
  const publishRes = await threadsRequest('POST', publishUrl);

  if (publishRes.status !== 200 || !publishRes.data.id) {
    return { success: false, error: publishRes.data };
  }

  return { success: true, threadId: publishRes.data.id };
}

// ========== DASHBOARD SYNC ==========

function loadSocialData() {
  if (fs.existsSync(SOCIAL_DATA_FILE)) {
    return JSON.parse(fs.readFileSync(SOCIAL_DATA_FILE, 'utf8'));
  }
  return { drafts: [], published: [], lastUpdate: null, apiStatus: 'unknown' };
}

function saveSocialData(data) {
  data.lastUpdate = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  fs.writeFileSync(SOCIAL_DATA_FILE, JSON.stringify(data, null, 2));
}

function loadAllDrafts() {
  if (!fs.existsSync(DRAFTS_DIR)) return [];
  return fs.readdirSync(DRAFTS_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, f), 'utf8'));
      } catch (e) { return null; }
    })
    .filter(Boolean);
}

function loadPublished() {
  if (!fs.existsSync(PUBLISHED_DIR)) return [];
  return fs.readdirSync(PUBLISHED_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(PUBLISHED_DIR, f), 'utf8'));
      } catch (e) { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0))
    .slice(0, 20);
}

// ========== MAIN ==========

async function main() {
  const config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

  // Git pull to get latest changes (approved drafts from dashboard)
  try {
    execSync('cd ' + DASHBOARD_DIR + ' && git pull --rebase 2>/dev/null', { timeout: 10000 });
  } catch (e) { /* ignore */ }

  // Check approvalQueue from dashboard (user pressed "publish" button)
  const socialData = loadSocialData();
  if (socialData.approvalQueue && socialData.approvalQueue.length > 0) {
    console.log(`📋 處理 ${socialData.approvalQueue.length} 個審核動作`);
    for (const action of socialData.approvalQueue) {
      const draftFile = path.join(DRAFTS_DIR, `${action.id}.json`);
      if (!fs.existsSync(draftFile)) continue;
      const draft = JSON.parse(fs.readFileSync(draftFile, 'utf8'));
      if (action.action === 'approve') {
        draft.status = 'approved';
        fs.writeFileSync(draftFile, JSON.stringify(draft, null, 2));
        console.log(`✅ 草稿 ${action.id} 標記為 approved`);
      } else if (action.action === 'reject') {
        draft.status = 'rejected';
        fs.writeFileSync(draftFile, JSON.stringify(draft, null, 2));
        console.log(`❌ 草稿 ${action.id} 已拒絕`);
      }
    }
    socialData.approvalQueue = [];
    saveSocialData(socialData);
  }

  // Scan drafts directory for approved items
  const drafts = loadAllDrafts();
  const approved = drafts.filter(d => d.status === 'approved');

  if (approved.length === 0) {
    // Still update dashboard data with current state
    socialData.drafts = drafts.filter(d => d.status === 'pending');
    socialData.published = loadPublished();
    socialData.apiStatus = 'connected';
    saveSocialData(socialData);
    console.log('📭 沒有待發佈的草稿');
    return;
  }

  console.log(`📬 找到 ${approved.length} 篇待發佈草稿`);

  for (const draft of approved) {
    const fullText = draft.hashtags
      ? `${draft.content}\n\n${draft.hashtags}`
      : draft.content;

    console.log(`📤 發佈中: ${draft.id} — ${fullText.substring(0, 50)}...`);

    try {
      const result = await publishToThreads(fullText, config);

      if (result.success) {
        console.log(`✅ 發佈成功! Thread ID: ${result.threadId}`);

        // Move to published
        draft.status = 'published';
        draft.published_at = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
        draft.thread_id = result.threadId;
        draft.thread_url = `https://www.threads.net/@${config.threads.username}/post/${result.threadId}`;

        // Save to published directory
        if (!fs.existsSync(PUBLISHED_DIR)) fs.mkdirSync(PUBLISHED_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(PUBLISHED_DIR, `${draft.id}.json`),
          JSON.stringify(draft, null, 2)
        );

        // Remove from drafts
        const draftFile = path.join(DRAFTS_DIR, `${draft.id}.json`);
        if (fs.existsSync(draftFile)) fs.unlinkSync(draftFile);

      } else {
        console.error(`❌ 發佈失敗:`, JSON.stringify(result.error));
        draft.status = 'failed';
        draft.error = result.error;
        fs.writeFileSync(
          path.join(DRAFTS_DIR, `${draft.id}.json`),
          JSON.stringify(draft, null, 2)
        );
      }
    } catch (e) {
      console.error(`❌ 發佈錯誤: ${e.message}`);
      draft.status = 'failed';
      draft.error = e.message;
      fs.writeFileSync(
        path.join(DRAFTS_DIR, `${draft.id}.json`),
        JSON.stringify(draft, null, 2)
      );
    }

    // Rate limit: wait 5s between posts
    await new Promise(r => setTimeout(r, 5000));
  }

  // Update dashboard data
  socialData.drafts = loadAllDrafts().filter(d => d.status === 'pending' || d.status === 'failed');
  socialData.published = loadPublished();
  socialData.apiStatus = 'connected';
  saveSocialData(socialData);

  // Git push
  try {
    execSync(`cd ${DASHBOARD_DIR} && git add -A && git diff --cached --quiet || (git commit -m "social: publish $(date '+%Y-%m-%d %H:%M')" && git push origin main)`, { timeout: 15000 });
    console.log('📊 主控板已更新');
  } catch (e) {
    console.error('Git push error:', e.message);
  }
}

main().catch(e => {
  console.error('Publisher error:', e.message);
  process.exit(1);
});
