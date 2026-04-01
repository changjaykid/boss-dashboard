// ========== OVERVIEW (dynamic from all JSONs) ==========
async function loadOverview(){
try{
const [trR,crR,soR,stR,fxR,cnR]=await Promise.allSettled([
fetch('trading-data.json?t='+Date.now()).then(r=>r.json()),
fetch('crypto-trading-data.json?t='+Date.now()).then(r=>r.json()),
fetch('social-data.json?t='+Date.now()).then(r=>r.json()),
fetch('stock-data.json?t='+Date.now()).then(r=>r.json()),
fetch('forex-news.json?t='+Date.now()).then(r=>r.json()),
fetch('crypto-news.json?t='+Date.now()).then(r=>r.json()),
]);
const g=s=>s.status==='fulfilled'?s.value:{};
const tr=g(trR),cr=g(crR),so=g(soR),st=g(stR),fxn=g(fxR),crn=g(cnR);
const box=document.getElementById('overview-content');if(!box)return;
const pC=n=>n>=0?'text-green-400':'text-red-400';
const fxBal=tr.account?.balance||0,fxUr=tr.account?.unrealizedPnl||0,fxPnl=tr.account?.realizedPnl||0;
const fxNet=tr.account?.netEquity||fxBal,fxPos=(tr.openPositions||[]).length,fxWR=tr.account?.winRate||'--';
const crCap=cr.account?.netEquity||cr.simulation?.currentCapital||0;
const crPnl=cr.simulation?.realizedPnl||cr.account?.realizedPnl||0;
const crUr=cr.simulation?.unrealizedPnl||cr.account?.unrealizedPnl||0;
const crPos=(cr.simulation?.positions||cr.openPositions||[]).length,crWR=cr.account?.winRate||cr.simulation?.winRate||'--';
const pubCnt=(so.published||[]).length,pendCnt=(so.drafts||[]).length;
const tx=st.market?.taiex||{};
let h='';

// Stats cards
h+=`<section class="bg-gray-800/50 border border-gray-700/50 p-4 md:p-6 rounded-xl"><h3 class="text-sm md:text-xl font-medium text-indigo-300 mb-3">📊 系統總覽</h3><div class="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-4">`;
h+=`<div class="stat-card border border-gray-700/50 p-3 rounded-xl"><p class="text-[10px] text-gray-500">💱 外匯淨值</p><p class="text-lg font-bold text-white">$${fxNet.toLocaleString()}</p><p class="text-[10px] ${pC(fxPnl)}">已實現 ${fxPnl>=0?'+':''}$${fxPnl.toFixed(2)}</p><p class="text-[10px] ${pC(fxUr)}">浮動 ${fxUr>=0?'+':''}$${fxUr.toFixed(2)}</p><p class="text-[10px] text-gray-400">持倉 ${fxPos} · 勝率 ${fxWR}</p></div>`;
h+=`<div class="stat-card border border-gray-700/50 p-3 rounded-xl"><p class="text-[10px] text-gray-500">🪙 虛擬貨幣</p><p class="text-lg font-bold text-white">NT$${crCap.toLocaleString()}</p><p class="text-[10px] ${pC(crPnl)}">已實現 ${crPnl>=0?'+':''}NT$${crPnl.toFixed(0)}</p><p class="text-[10px] text-blue-400">持倉 ${crPos} · 勝率 ${crWR}</p></div>`;
h+=`<div class="stat-card border border-gray-700/50 p-3 rounded-xl"><p class="text-[10px] text-gray-500">📈 加權指數</p><p class="text-lg font-bold ${pC(tx.change||0)}">${tx.close?.toLocaleString()||'--'}</p><p class="text-[10px] ${pC(tx.change||0)}">${(tx.change||0)>=0?'▲':'▼'} ${Math.abs(tx.change||0)} (${tx.changePct||0}%)</p></div>`;
h+=`<div class="stat-card border border-gray-700/50 p-3 rounded-xl"><p class="text-[10px] text-gray-500">🌐 Threads</p><p class="text-lg font-bold text-white">${pubCnt} 篇</p><p class="text-[10px] text-yellow-400">待審 ${pendCnt} 篇</p><p class="text-[10px] text-gray-400">API ${so.apiStatus==='connected'?'✅ 已連接':'⚠️ 未設定'}</p></div>`;
h+=`</div></section>`;

// Events
const ev=[];
const mg=tr.account?.marginUsagePercent;if(mg){const mp=parseFloat(mg);if(mp>80)ev.push({i:'🚨',t:'外匯保證金使用 '+mg+'，風險偏高！',d:tr.lastUpdate,a:true})}
if(fxPos>0)ev.push({i:'💱',t:'外匯持倉 '+fxPos+' 筆，浮動 '+(fxUr>=0?'+':'')+' $'+fxUr.toFixed(2),d:tr.lastUpdate});
if(crPos>0)ev.push({i:'🪙',t:'虛擬貨幣持倉 '+crPos+' 筆，浮動 '+(crUr>=0?'+':'')+'NT$'+crUr.toFixed(0),d:cr.lastUpdate||cr.simulation?.lastUpdate});
const fxCl=tr.closedTrades||[];if(fxCl.length){const l=fxCl[fxCl.length-1];const lp=typeof l.pnl==='number'?l.pnl:0;ev.push({i:lp>=0?'✅':'❌',t:'外匯最近平倉：'+(l.instrumentName||l.instrument||'')+' '+l.direction+' '+(l.outcome||'')+' $'+lp.toFixed(2),d:l.time})}
if(st.lastUpdate)ev.push({i:'📈',t:'台股分析：'+(st.watchlist||[]).length+' 檔精選',d:st.lastUpdate});
if(pendCnt>0)ev.push({i:'📝',t:pendCnt+' 篇 Threads 草稿待審核',d:so.lastUpdate});
const fxNs=Array.isArray(fxn.news)?fxn.news:[];if(fxNs.length)ev.push({i:'📰',t:'外匯新聞 '+fxNs.length+' 則',d:fxn.lastUpdate});
const crNs=Array.isArray(crn.news)?crn.news:[];if(crNs.length)ev.push({i:'📰',t:'幣圈新聞 '+crNs.length+' 則',d:crn.lastUpdate});

h+=`<section class="bg-gray-800/50 border border-gray-700/50 p-4 md:p-6 rounded-xl"><h3 class="text-sm md:text-xl font-medium text-indigo-300 mb-3">⚡ 最新動態</h3><div class="space-y-2">`;
if(!ev.length)h+='<p class="text-xs text-gray-400 text-center py-3">暫無動態</p>';
else ev.forEach(e=>{h+=`<div class="flex items-start space-x-3 p-2.5 bg-gray-800 rounded-lg border ${e.a?'border-red-700/30':'border-gray-700'}"><span class="text-sm mt-0.5 flex-shrink-0">${e.i}</span><div class="min-w-0 flex-1"><p class="text-xs ${e.a?'text-red-300':'text-gray-200'}">${e.t}</p>${e.d?'<p class="text-[10px] text-gray-500 mt-0.5">'+e.d+'</p>':''}</div></div>`});
h+=`</div></section>`;

// Update times
h+=`<section class="bg-gray-800/50 border border-gray-700/50 p-4 md:p-6 rounded-xl"><h3 class="text-sm md:text-xl font-medium text-gray-400 mb-3">🕐 各系統最後更新</h3><div class="grid grid-cols-2 md:grid-cols-3 gap-2">`;
[['外匯交易',tr.lastUpdate],['虛擬貨幣',cr.lastUpdate||cr.simulation?.lastUpdate],['Threads',so.lastUpdate],['台股',st.lastUpdate],['外匯新聞',fxn.lastUpdate],['幣圈新聞',crn.lastUpdate]].forEach(([n,t])=>{h+=`<div class="p-2 bg-gray-800 rounded-lg border border-gray-700"><p class="text-[10px] text-gray-500">${n}</p><p class="text-xs text-gray-300">${t||'--'}</p></div>`});
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

// Models
h+=`<section class="bg-gray-800/50 border border-gray-700/50 p-3 md:p-6 rounded-xl"><h3 class="text-sm md:text-xl font-medium text-indigo-300 mb-3">🧠 AI 模型</h3><div class="grid grid-cols-1 gap-2 md:grid-cols-2 md:gap-4">`;
(d.models||[]).forEach(m=>{
const sc=m.status==='active'?'bg-green-900/50 text-green-300 border border-green-700/50':'bg-gray-700 text-gray-300 border border-gray-600';
h+=`<div class="p-3 bg-gray-800 rounded-lg border border-gray-700/50"><div class="flex items-center justify-between"><span class="text-xs font-bold text-white">${m.name}</span><span class="px-1.5 py-0.5 text-[10px] rounded-full ${sc}">${m.role}</span></div><p class="text-[10px] text-gray-400 mt-1">${m.note} · ${m.context} context</p></div>`});
h+=`</div></section>`;

// Custom skills
const cs=d.customSkills||[];
h+=`<section class="bg-gray-800/50 border border-gray-700/50 p-3 md:p-6 rounded-xl"><div class="flex items-center justify-between mb-3"><h3 class="text-sm md:text-xl font-medium text-cyan-300">🔧 客製化 Skill</h3><span class="px-2 py-0.5 bg-cyan-900/30 border border-cyan-700/50 text-cyan-300 text-[10px] rounded-full">${cs.length} skills</span></div><div class="grid grid-cols-1 gap-2">`;
cs.forEach(s=>{
const sb=s.status==='running'?'🟢 運行中':s.status==='ready'?'🟡 就緒':'⚪ 待設定';
const sc2=s.status==='running'?'bg-green-900/30 text-green-300 border-green-700/50':s.status==='ready'?'bg-yellow-900/30 text-yellow-300 border-yellow-700/50':'bg-gray-700 text-gray-300 border-gray-600';
h+=`<div class="p-2.5 bg-gray-800 rounded-lg border border-cyan-700/30"><div class="flex items-center justify-between"><div class="flex items-center space-x-2"><span>${s.emoji}</span><div><p class="text-xs font-bold text-white">${s.name}</p><p class="text-[10px] text-gray-400">${s.desc}</p></div></div><div class="text-right flex-shrink-0"><span class="px-1.5 py-0.5 text-[10px] rounded-full ${sc2} border">${sb}</span>${s.cron?'<p class="text-[9px] text-gray-500 mt-0.5">⏰ '+s.cron+'</p>':''}</div></div></div>`});
h+=`</div></section>`;

// Installed skills
const is2=d.installedSkills||[];
h+=`<section class="bg-gray-800/50 border border-gray-700/50 p-3 md:p-6 rounded-xl"><div class="flex items-center justify-between mb-3"><h3 class="text-sm md:text-xl font-medium text-green-300">✅ 已安裝技能</h3><span class="px-2 py-0.5 bg-green-900/30 border border-green-700/50 text-green-300 text-[10px] rounded-full">${is2.length} skills</span></div><div class="grid grid-cols-1 gap-2">`;
is2.forEach(s=>{h+=`<div class="p-2.5 bg-gray-800 rounded-lg border border-gray-700"><div class="flex items-center space-x-2"><span>${s.emoji}</span><div><p class="text-xs font-bold text-white">${s.name}</p><p class="text-[10px] text-gray-400">${s.desc}</p></div></div></div>`});
h+=`</div></section>`;

h+=`<p class="text-[10px] text-gray-500 text-center">最後更新：${d.lastUpdate||'--'}</p>`;
box.innerHTML=h;
}catch(e){console.log('skills err',e)}
}
