// ========== OVERVIEW v2 — 真正的一頁總覽 ==========
async function loadOverview(){
try{
const [trR,crR,soR,stR,fxR,cnR,mmR,cfR,skR]=await Promise.allSettled([
fetch('trading-data.json?t='+Date.now()).then(r=>r.json()),
fetch('crypto-trading-data.json?t='+Date.now()).then(r=>r.json()),
fetch('social-data.json?t='+Date.now()).then(r=>r.json()),
fetch('stock-data.json?t='+Date.now()).then(r=>r.json()),
fetch('forex-news.json?t='+Date.now()).then(r=>r.json()),
fetch('crypto-news.json?t='+Date.now()).then(r=>r.json()),
fetch('money-maker-data.json?t='+Date.now()).then(r=>r.json()),
fetch('crypto-futures-data.json?t='+Date.now()).then(r=>r.json()),
fetch('skills-data.json?t='+Date.now()).then(r=>r.json()),
]);
const g=s=>s.status==='fulfilled'?s.value:{};
const tr=g(trR),cr=g(crR),so=g(soR),st=g(stR),fxn=g(fxR),crn=g(cnR),mm=g(mmR),cf=g(cfR),sk=g(skR);
const box=document.getElementById('overview-content');if(!box)return;
const pC=n=>n>=0?'text-green-400':'text-red-400';
const fmt$=(v,p='$')=>v!=null?(v>=0?'+':'')+p+Math.abs(v).toFixed(2):'--';
const fmtNT=(v)=>v!=null?(v>=0?'+':'')+'NT$'+Math.abs(v).toFixed(0):'--';

// --- Data extraction ---
const fxBal=tr.account?.balance||0,fxUr=tr.account?.unrealizedPnl||0,fxPnl=tr.account?.realizedPnl||0;
const fxNet=tr.account?.netEquity||fxBal,fxPos=(tr.openPositions||[]).length,fxWR=tr.account?.winRate||'--';
const fxToday=tr.account?.todayPnl||0;

const crCap=cr.account?.netEquity||cr.simulation?.currentCapital||0;
const crPnl=cr.simulation?.realizedPnl||cr.account?.realizedPnl||0;
const crPos=(cr.simulation?.positions||cr.openPositions||[]).length;

const mmEquity=mm.totalEquity||mm.netEquity||mm.capital||0;
const mmPnl=mm.totalPnl||0;
const mmStatus=mm.status||'STANDBY';
const mmPos=mm.currentPosition||mm.holdings?.btc>0?1:0;

const cfEquity=cf.account?.netEquity||0;
const cfPnl=cf.account?.totalPnl||0;
const cfStatus=cf.status||'STANDBY';
const cfPos=cf.position?1:0;

const pubCnt=(so.published||[]).length,pendCnt=(so.drafts||[]).length;
const tx=st.market?.taiex||{};

let h='';

// ===== 1. 資產總覽 — 一行看清所有錢 =====
const totalUSD = fxNet + cfEquity;
const totalTWD = crCap + mmEquity;
h+=`<section class="bg-gradient-to-r from-indigo-900/30 to-purple-900/30 border border-indigo-700/30 p-4 md:p-6 rounded-xl">
<div class="flex items-center justify-between mb-4">
  <h3 class="text-sm md:text-xl font-medium text-indigo-300">💰 資產總覽</h3>
  <span class="text-[10px] text-gray-500">${new Date().toLocaleString('zh-TW',{timeZone:'Asia/Taipei',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</span>
</div>
<div class="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">
  <div class="stat-card border border-indigo-700/30 p-3 md:p-5 rounded-xl bg-indigo-900/20">
    <p class="text-[10px] md:text-xs text-indigo-400 uppercase">💱 外匯 (Capital.com)</p>
    <p class="text-lg md:text-2xl font-bold text-white">$${fxNet.toLocaleString()}</p>
    <p class="text-[10px] ${pC(fxPnl)}">已實現 ${fmt$(fxPnl)}</p>
    <p class="text-[10px] ${pC(fxUr)}">浮動 ${fmt$(fxUr)}</p>
    <p class="text-[10px] text-gray-400">${fxPos} 持倉 · 勝率 ${fxWR}</p>
  </div>
  <div class="stat-card border border-blue-700/30 p-3 md:p-5 rounded-xl bg-blue-900/20">
    <p class="text-[10px] md:text-xs text-blue-400 uppercase">📈 合約 (Binance)</p>
    <p class="text-lg md:text-2xl font-bold text-white">$${cfEquity.toFixed(2)}</p>
    <p class="text-[10px] ${pC(cfPnl)}">累計 ${fmt$(cfPnl)}</p>
    <p class="text-[10px] text-gray-400">${cfPos} 持倉 · ${cfStatus==='RUNNING'?'🟢 運行中':'🟡 '+cfStatus}</p>
  </div>
  <div class="stat-card border border-yellow-700/30 p-3 md:p-5 rounded-xl bg-yellow-900/20">
    <p class="text-[10px] md:text-xs text-yellow-400 uppercase">💰 賺錢機 (MAX)</p>
    <p class="text-lg md:text-2xl font-bold text-white">NT$${mmEquity.toLocaleString()}</p>
    <p class="text-[10px] ${pC(mmPnl)}">累計 ${fmtNT(mmPnl)}</p>
    <p class="text-[10px] text-gray-400">${mmStatus==='RUNNING'?'🟢 運行中':mmStatus==='PAUSED'?'⏸️ 暫停':'🟡 待命'}</p>
  </div>
  <div class="stat-card border border-orange-700/30 p-3 md:p-5 rounded-xl bg-orange-900/20">
    <p class="text-[10px] md:text-xs text-orange-400 uppercase">🪙 虛擬幣現貨 (MAX)</p>
    <p class="text-lg md:text-2xl font-bold text-white">NT$${crCap.toLocaleString()}</p>
    <p class="text-[10px] ${pC(crPnl)}">已實現 ${fmtNT(crPnl)}</p>
    <p class="text-[10px] text-gray-400">${crPos} 持倉</p>
  </div>
</div>
</section>`;

// ===== 2. 市場快照（分區顯示）=====
const fxPrices = fxn.prices?.instruments || fxn.prices || {};

h+=`<section class="bg-gray-800/50 border border-gray-700/50 p-4 md:p-6 rounded-xl">
<h3 class="text-sm md:text-xl font-medium text-yellow-300 mb-3">📊 市場快照</h3>`;

// 台股
h+=`<p class="text-[10px] text-gray-500 uppercase mb-2 mt-2">🇹🇼 台股</p>
<div class="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">
  <div class="stat-card border border-gray-700/50 p-3 rounded-xl">
    <p class="text-[10px] text-gray-500">加權指數</p>
    <p class="text-lg font-bold ${pC(tx.change||0)}">${tx.close?.toLocaleString()||'--'}</p>
    <p class="text-[10px] ${pC(tx.change||0)}">${(tx.change||0)>=0?'▲':'▼'} ${Math.abs(tx.change||0)} (${tx.changePct||0}%)</p>
  </div>`;
const usm=st.market?.usMarket||{};
if(usm.djia){h+=`<div class="stat-card border border-gray-700/50 p-3 rounded-xl"><p class="text-[10px] text-gray-500">道瓊</p><p class="text-lg font-bold ${pC(usm.djia.change||0)}">${usm.djia.close?.toLocaleString()||'--'}</p><p class="text-[10px] ${pC(usm.djia.change||0)}">${(usm.djia.change||0)>=0?'▲':'▼'} ${usm.djia.changePct||0}%</p></div>`}
if(usm.nasdaq){h+=`<div class="stat-card border border-gray-700/50 p-3 rounded-xl"><p class="text-[10px] text-gray-500">那斯達克</p><p class="text-lg font-bold ${pC(usm.nasdaq.change||0)}">${usm.nasdaq.close?.toLocaleString()||'--'}</p><p class="text-[10px] ${pC(usm.nasdaq.change||0)}">${(usm.nasdaq.change||0)>=0?'▲':'▼'} ${usm.nasdaq.changePct||0}%</p></div>`}
h+=`</div>`;

// 外匯
const xau=fxPrices.XAUUSD||{};const eur=fxPrices.EURUSD||{};const jpy=fxPrices.USDJPY||{};const gbp=fxPrices.GBPUSD||{};
h+=`<p class="text-[10px] text-gray-500 uppercase mb-2">💱 外匯</p>
<div class="grid grid-cols-2 md:grid-cols-4 gap-2 mb-4">`;
[{k:xau,n:'黃金',p:'$'},{k:eur,n:'EUR/USD',p:''},{k:gbp,n:'GBP/USD',p:''},{k:jpy,n:'USD/JPY',p:''}].forEach(({k,n,p})=>{
  const pr=k.price||k.last||0;const cp=parseFloat(k.changePercent||k.changePct||k.change||0);
  if(pr)h+=`<div class="stat-card border border-gray-700/50 p-3 rounded-xl"><p class="text-[10px] text-gray-500">${n}</p><p class="text-lg font-bold text-white">${p}${pr.toLocaleString(undefined,{maximumFractionDigits:4})}</p><p class="text-[10px] ${pC(cp)}">${cp>=0?'▲':'▼'} ${Math.abs(cp).toFixed(2)}%</p></div>`;
});
h+=`</div>`;

// 虛擬貨幣
const btcPrice = mm.btcPrice || 0;
const btcChg = mm.btcChange24h || 0;
const fgi = mm.fearGreedIndex || cf.riskStatus?.fearGreed || crn.prices?.fearGreed?.value || '';
h+=`<p class="text-[10px] text-gray-500 uppercase mb-2">₿ 虛擬貨幣</p>
<div class="grid grid-cols-2 md:grid-cols-4 gap-2">`;
if(btcPrice){h+=`<div class="stat-card border border-gray-700/50 p-3 rounded-xl"><p class="text-[10px] text-gray-500">BTC/TWD</p><p class="text-lg font-bold text-yellow-400">NT$${btcPrice.toLocaleString()}</p><p class="text-[10px] ${pC(btcChg)}">${btcChg>=0?'▲':'▼'} ${Math.abs(btcChg).toFixed(2)}%</p></div>`}
if(fgi){h+=`<div class="stat-card border border-gray-700/50 p-3 rounded-xl"><p class="text-[10px] text-gray-500">恐懼貪婪指數</p><p class="text-lg font-bold text-orange-400">${fgi}</p></div>`}
h+=`</div>
</section>`;

// ===== 4. 社群專案狀態 =====
h+=`<section class="bg-gray-800/50 border border-gray-700/50 p-4 md:p-6 rounded-xl">
<h3 class="text-sm md:text-xl font-medium text-pink-300 mb-3">🌐 社群專案</h3>
<div class="grid grid-cols-2 md:grid-cols-4 gap-2">
  <div class="stat-card border border-gray-700/50 p-3 rounded-xl">
    <p class="text-[10px] text-gray-500">🧵 Threads 已發佈</p>
    <p class="text-lg font-bold text-white">${pubCnt} 篇</p>
  </div>
  <div class="stat-card border border-gray-700/50 p-3 rounded-xl">
    <p class="text-[10px] text-gray-500">📝 待審核</p>
    <p class="text-lg font-bold ${pendCnt>0?'text-yellow-400':'text-gray-400'}">${pendCnt} 篇</p>
  </div>
  <div class="stat-card border border-gray-700/50 p-3 rounded-xl">
    <p class="text-[10px] text-gray-500">📸 IG 輪播</p>
    <p class="text-lg font-bold text-white">每日產出</p>
    <p class="text-[10px] text-gray-400">上傳至 Google Drive</p>
  </div>
  <div class="stat-card border border-gray-700/50 p-3 rounded-xl">
    <p class="text-[10px] text-gray-500">API 狀態</p>
    <p class="text-lg font-bold ${so.apiStatus==='connected'?'text-green-400':'text-yellow-400'}">${so.apiStatus==='connected'?'✅ 正常':'⚠️ 待確認'}</p>
  </div>
</div>`;

// 如果有待審核草稿，直接顯示第一篇
const pendDrafts = so.drafts || [];
if(pendDrafts.length){
  const dr = pendDrafts[0];
  h+=`<div class="mt-3 p-3 bg-yellow-900/20 rounded-lg border border-yellow-700/30">
    <div class="flex items-center gap-2 mb-1">
      <span class="px-1.5 py-0.5 text-[10px] rounded-full bg-indigo-900/50 text-indigo-300 border border-indigo-700/50">${dr.pillar_name||dr.pillar||''}</span>
      <span class="text-[10px] text-yellow-400">⏳ 待審核</span>
    </div>
    <p class="text-xs text-gray-200 line-clamp-3">${(dr.content||'').substring(0,200)}...</p>
    <p class="text-[10px] text-gray-500 mt-1">💬 在 LINE 跟管家說「發」或「不要」</p>
  </div>`;
}
h+=`</section>`;

// ===== 5. 最新動態 =====
const ev=[];
// 交易動態
if(fxPos>0)ev.push({i:'💱',t:'外匯持倉 '+fxPos+' 筆，浮動 '+(fxUr>=0?'+':'')+' $'+fxUr.toFixed(2),d:tr.lastUpdate,c:pC(fxUr)});
if(cfPos>0){const cp=cf.position.pnl||0;ev.push({i:'📈',t:'合約 '+cf.position.side+' '+cf.position.symbol+' 浮動 '+(cp>=0?'+':'')+'$'+cp.toFixed(2),d:cf.lastUpdate,c:pC(cp)})}
if(mmPos>0){const mp=mm.holdings?.unrealizedPnl||0;ev.push({i:'💰',t:'賺錢機持有 BTC 浮動 '+(mp>=0?'+':'')+'NT$'+mp.toFixed(0),d:mm.lastUpdate,c:pC(mp)})}

// 最近平倉
const fxCl=tr.closedTrades||[];if(fxCl.length){const l=fxCl[fxCl.length-1];const lp=typeof l.pnl==='number'?l.pnl:0;
  ev.push({i:lp>=0?'✅':'❌',t:'外匯最近平倉：'+(l.instrumentName||l.instrument||'')+' '+l.direction+' $'+lp.toFixed(2),d:l.time,c:pC(lp)})}

// 保證金警告
const mg=tr.account?.marginUsagePercent;if(mg){const mp=parseFloat(mg);if(mp>60)ev.push({i:'🚨',t:'外匯保證金使用 '+mg+'！',d:tr.lastUpdate,a:true})}

// 新聞
const fxNs=Array.isArray(fxn.news)?fxn.news:[];if(fxNs.length)ev.push({i:'📰',t:'外匯新聞 '+fxNs.length+' 則更新',d:fxn.lastUpdate});
const crNs=Array.isArray(crn.news)?crn.news:[];if(crNs.length)ev.push({i:'📰',t:'幣圈新聞 '+crNs.length+' 則更新',d:crn.lastUpdate});

// 台股
if(st.lastUpdate)ev.push({i:'📈',t:'台股分析 '+(st.watchlist||[]).length+' 檔精選已更新',d:st.lastUpdate});

// 社群
if(pendCnt>0)ev.push({i:'📝',t:pendCnt+' 篇 Threads 草稿待你審核',d:so.lastUpdate});

h+=`<section class="bg-gray-800/50 border border-gray-700/50 p-4 md:p-6 rounded-xl">
<h3 class="text-sm md:text-xl font-medium text-indigo-300 mb-3">⚡ 最新動態</h3>
<div class="space-y-2">`;
if(!ev.length)h+='<p class="text-xs text-gray-400 text-center py-3">一切正常，無特殊動態</p>';
else ev.forEach(e=>{h+=`<div class="flex items-start space-x-3 p-2.5 bg-gray-800 rounded-lg border ${e.a?'border-red-700/30':'border-gray-700'}">
  <span class="text-sm mt-0.5 flex-shrink-0">${e.i}</span>
  <div class="min-w-0 flex-1">
    <p class="text-xs ${e.a?'text-red-300':e.c||'text-gray-200'}">${e.t}</p>
    ${e.d?'<p class="text-[10px] text-gray-500 mt-0.5">'+e.d+'</p>':''}
  </div>
</div>`});
h+=`</div></section>`;

// ===== 6. 系統健康 =====
h+=`<section class="bg-gray-800/50 border border-gray-700/50 p-4 md:p-6 rounded-xl">
<h3 class="text-sm md:text-xl font-medium text-gray-400 mb-3">🕐 系統健康</h3>
<div class="grid grid-cols-2 md:grid-cols-4 gap-2">`;
// 判斷是否在 2 小時內更新過（交易類），24 小時內（新聞/分析類）
const isRecent=(ts,hours=2)=>{if(!ts)return false;try{const d=new Date(ts);const diff=Date.now()-d.getTime();return diff<hours*3600000}catch(e){return false}};
const systems = [
  {name:'外匯交易',t:tr.lastUpdate,running:!!tr.lastUpdate},
  {name:'合約交易',t:cf.lastUpdate,running:!!cf.lastUpdate},
  {name:'賺錢機',t:mm.lastUpdate,running:!!mm.lastUpdate},
  {name:'台股分析',t:st.lastUpdate,running:!!st.lastUpdate},
  {name:'Threads',t:so.lastUpdate,running:so.apiStatus==='connected'},
  {name:'外匯新聞',t:fxn.lastUpdate,running:!!fxn.lastUpdate},
  {name:'幣圈新聞',t:crn.lastUpdate,running:!!crn.lastUpdate},
  {name:'IG 輪播',t:'Cron 每日 11:00/18:00',running:true},
];
systems.forEach(s=>{
  h+=`<div class="p-2 bg-gray-800 rounded-lg border border-gray-700">
    <div class="flex items-center gap-1.5">
      <span class="text-[10px]">${s.running?'🟢':'🔴'}</span>
      <p class="text-[10px] text-gray-500">${s.name}</p>
    </div>
    <p class="text-xs text-gray-300 mt-0.5">${s.t||'--'}</p>
  </div>`;
});
h+=`</div></section>`;

box.innerHTML=h;
}catch(e){console.log('overview err',e)}
}

// ========== SKILLS (dynamic from skills-data.json) ==========
async function loadSkillsData(){
try{
const r=await fetch('skills-data.json?t='+Date.now());if(!r.ok)return;
const d=await r.json();
const box=document.getElementById('skills-dynamic-content');if(!box)return;
let h='';

h+=`<section class="bg-gray-800/50 border border-gray-700/50 p-3 md:p-6 rounded-xl"><h3 class="text-sm md:text-xl font-medium text-indigo-300 mb-3">🧠 AI 模型</h3><div class="grid grid-cols-1 gap-2 md:grid-cols-2 md:gap-4">`;
(d.models||[]).forEach(m=>{
const sc=m.status==='active'?'bg-green-900/50 text-green-300 border border-green-700/50':'bg-gray-700 text-gray-300 border border-gray-600';
h+=`<div class="p-3 bg-gray-800 rounded-lg border border-gray-700/50"><div class="flex items-center justify-between"><span class="text-xs font-bold text-white">${m.name}</span><span class="px-1.5 py-0.5 text-[10px] rounded-full ${sc}">${m.role}</span></div><p class="text-[10px] text-gray-400 mt-1">${m.note} · ${m.context} context</p></div>`});
h+=`</div></section>`;

const cs=d.customSkills||[];
h+=`<section class="bg-gray-800/50 border border-gray-700/50 p-3 md:p-6 rounded-xl"><div class="flex items-center justify-between mb-3"><h3 class="text-sm md:text-xl font-medium text-cyan-300">🔧 客製化 Skill</h3><span class="px-2 py-0.5 bg-cyan-900/30 border border-cyan-700/50 text-cyan-300 text-[10px] rounded-full">${cs.length} skills</span></div><div class="grid grid-cols-1 gap-2">`;
cs.forEach(s=>{
const sb=s.status==='running'?'🟢 運行中':s.status==='ready'?'🟡 就緒':'⚪ 待設定';
const sc2=s.status==='running'?'bg-green-900/30 text-green-300 border-green-700/50':s.status==='ready'?'bg-yellow-900/30 text-yellow-300 border-yellow-700/50':'bg-gray-700 text-gray-300 border-gray-600';
h+=`<div class="p-2.5 bg-gray-800 rounded-lg border border-cyan-700/30"><div class="flex items-center justify-between"><div class="flex items-center space-x-2"><span>${s.emoji}</span><div><p class="text-xs font-bold text-white">${s.name}</p><p class="text-[10px] text-gray-400">${s.desc}</p></div></div><div class="text-right flex-shrink-0"><span class="px-1.5 py-0.5 text-[10px] rounded-full ${sc2} border">${sb}</span>${s.cron?'<p class="text-[9px] text-gray-500 mt-0.5">⏰ '+s.cron+'</p>':''}</div></div></div>`});
h+=`</div></section>`;

const is2=d.installedSkills||[];
h+=`<section class="bg-gray-800/50 border border-gray-700/50 p-3 md:p-6 rounded-xl"><div class="flex items-center justify-between mb-3"><h3 class="text-sm md:text-xl font-medium text-green-300">✅ 已安裝技能</h3><span class="px-2 py-0.5 bg-green-900/30 border border-green-700/50 text-green-300 text-[10px] rounded-full">${is2.length} skills</span></div><div class="grid grid-cols-1 gap-2">`;
is2.forEach(s=>{h+=`<div class="p-2.5 bg-gray-800 rounded-lg border border-gray-700"><div class="flex items-center space-x-2"><span>${s.emoji}</span><div><p class="text-xs font-bold text-white">${s.name}</p><p class="text-[10px] text-gray-400">${s.desc}</p></div></div></div>`});
h+=`</div></section>`;

h+=`<p class="text-[10px] text-gray-500 text-center">最後更新：${d.lastUpdate||'--'}</p>`;
box.innerHTML=h;
}catch(e){console.log('skills err',e)}
}
