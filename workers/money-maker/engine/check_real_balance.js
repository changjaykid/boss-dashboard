const { MAX } = require('max-exchange-api-node');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'crypto_config.json'), 'utf8'));
const client = new MAX({
  accessKey: CONFIG.api.access_key,
  secretKey: CONFIG.api.secret_key
});

async function getRealBalance() {
  try {
    console.log('--- MAX 帳戶真實餘額查詢 ---');
    const members = await client.rest.getMembers();
    const accounts = members.accounts;
    
    // 抓取所有幣種價格以計算總額 (TWD)
    const tickers = await client.rest.getTickers();
    const prices = {};
    tickers.forEach(t => {
      prices[t.market] = parseFloat(t.last);
    });
    prices['twdtwd'] = 1;

    let totalTwd = 0;
    console.log('資產明細:');
    for (const acc of accounts) {
      const currency = acc.currency.toLowerCase();
      const balance = parseFloat(acc.balance);
      const locked = parseFloat(acc.locked);
      const total = balance + locked;
      
      if (total > 0) {
        let valueTwd = 0;
        if (currency === 'twd') {
          valueTwd = total;
        } else {
          const market = `${currency}twd`;
          if (prices[market]) {
            valueTwd = total * prices[market];
          } else if (currency === 'usdt') {
             // 假設 USDT/TWD
             valueTwd = total * (prices['usdttwd'] || 32);
          }
        }
        totalTwd += valueTwd;
        console.log(`- ${acc.currency}: ${total} (可用: ${balance}, 鎖定: ${locked}) ≈ ${valueTwd.toFixed(2)} TWD`);
      }
    }
    console.log(`\n🔥 真實總資產估值: ${totalTwd.toFixed(2)} TWD`);
  } catch (err) {
    console.error('查詢失敗:', err.message);
  }
}

getRealBalance();
