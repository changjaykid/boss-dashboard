const { MAX } = require('max-exchange-api-node');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'crypto_config.json'), 'utf8'));
const client = new MAX({
  accessKey: CONFIG.api.access_key,
  secretKey: CONFIG.api.secret_key
});

async function getRealTotalBalance() {
  try {
    console.log('--- MAX 帳戶完整資產抓取 (Final Deep Fix) ---');
    
    // 依據 SDK 要求傳入正確參數
    const accounts = await client.rest.spotWallet.getAccounts({});
    const markets = ['btctwd', 'ethtwd', 'soltwd', 'dogetwd', 'usdttwd'];
    const tickers = await client.rest.getTickers({ markets: markets });
    
    const prices = {};
    tickers.forEach(t => {
      prices[t.market] = parseFloat(t.last);
    });
    prices['twdtwd'] = 1;

    let totalTwd = 0;
    console.log('當前實時持倉明細 (來自 API):');
    
    accounts.forEach(acc => {
      const currency = acc.currency.toLowerCase();
      const balance = parseFloat(acc.balance || 0);
      const locked = parseFloat(acc.locked || 0);
      const total = balance + locked;
      
      if (total > 0.00000001) {
        let valueTwd = 0;
        if (currency === 'twd') {
          valueTwd = total;
        } else {
          const market = `${currency}twd`;
          if (prices[market]) {
            valueTwd = total * prices[market];
          } else if (currency === 'usdt') {
            valueTwd = total * (prices['usdttwd'] || 32.5);
          }
        }
        
        if (valueTwd > 0.1 || total > 0.0001) {
            totalTwd += valueTwd;
            console.log(`- ${acc.currency.toUpperCase()}: ${total.toFixed(8)} (可用: ${balance.toFixed(8)}, 鎖定: ${locked.toFixed(8)}) ≈ ${valueTwd.toFixed(2)} TWD`);
        }
      }
    });
    
    console.log(`\n==============================`);
    console.log(`🔥 API 真實帳戶總計: ${totalTwd.toFixed(2)} TWD`);
    console.log(`==============================`);
    
    // 強制更新本地狀態檔案，避免引擎讀取舊狀態
    const btctwdStatePath = path.join(DATA_DIR, 'money_maker_state_btctwd.json');
    if (fs.existsSync(btctwdStatePath)) {
        const btcAcc = accounts.find(a => a.currency === 'btc') || { balance: '0', locked: '0' };
        const btcState = JSON.parse(fs.readFileSync(btctwdStatePath, 'utf8'));
        const realBtcTotal = parseFloat(btcAcc.balance) + parseFloat(btcAcc.locked);
        if (Math.abs(btcState.totalCoinHeld - realBtcTotal) > 0.0000001) {
            console.log(`⚠️ 修正 BTC 持倉狀態: ${btcState.totalCoinHeld} -> ${realBtcTotal}`);
            btcState.totalCoinHeld = realBtcTotal;
            if (realBtcTotal === 0) btcState.buyBatches = [];
            fs.writeFileSync(btctwdStatePath, JSON.stringify(btcState, null, 2));
        }
    }

    const soltwdStatePath = path.join(DATA_DIR, 'money_maker_state_soltwd.json');
    if (fs.existsSync(soltwdStatePath)) {
        const solAcc = accounts.find(a => a.currency === 'sol') || { balance: '0', locked: '0' };
        const solState = JSON.parse(fs.readFileSync(soltwdStatePath, 'utf8'));
        const realSolTotal = parseFloat(solAcc.balance) + parseFloat(solAcc.locked);
        if (Math.abs(solState.totalCoinHeld - realSolTotal) > 0.0000001) {
            console.log(`⚠️ 修正 SOL 持倉狀態: ${solState.totalCoinHeld} -> ${realSolTotal}`);
            solState.totalCoinHeld = realSolTotal;
            if (realSolTotal === 0) solState.buyBatches = [];
            fs.writeFileSync(soltwdStatePath, JSON.stringify(solState, null, 2));
        }
    }
    
    const dashboardPath = path.join(__dirname, '..', 'dashboard.json');
    if (fs.existsSync(dashboardPath)) {
        const dashboard = JSON.parse(fs.readFileSync(dashboardPath, 'utf8'));
        dashboard.totalEquity = Math.round(totalTwd);
        dashboard.netEquity = Math.round(totalTwd);
        dashboard.twdCash = Math.round(parseFloat(accounts.find(a => a.currency === 'twd')?.balance || 0));
        dashboard.lastUpdate = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
        fs.writeFileSync(dashboardPath, JSON.stringify(dashboard, null, 2));
        console.log('✅ 已強制同步至本地狀態與主控板');
    }
  } catch (err) {
    console.error('❌ 失敗原因:', err);
  }
}

getRealTotalBalance();
