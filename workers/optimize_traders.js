#!/usr/bin/env node
/**
 * optimize_traders.js — 強制重新抓取並驗證持倉
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKSPACE = process.env.HOME + '/.openclaw/workspace';

async function optimize() {
    console.log('--- 啟動交易系統優化機制 ---');
    
    // 1. 強制執行數據抓取
    console.log('1. 正在同步 MAX 與 Binance 實時數據...');
    execSync('node ' + WORKSPACE + '/workers/money-maker/engine/money_maker_fetch.js', {stdio: 'inherit'});
    execSync('node ' + WORKSPACE + '/workers/futures-trader/engine/binance_futures_fetch.js', {stdio: 'inherit'});
    
    // 2. 執行策略引擎 (決定是否平倉或加倉)
    console.log('2. 正在運行策略引擎邏輯...');
    execSync('node ' + WORKSPACE + '/workers/money-maker/engine/money_maker_engine.js', {stdio: 'inherit'});
    execSync('node ' + WORKSPACE + '/workers/futures-trader/engine/binance_futures_engine.js', {stdio: 'inherit'});
    
    // 3. 強制同步主控板
    console.log('3. 推送真實數據至 GitHub Pages...');
    execSync(WORKSPACE + '/workers/sync_dashboards.sh', {stdio: 'inherit'});
    
    console.log('--- 優化同步完成 ---');
}

optimize().catch(console.error);
