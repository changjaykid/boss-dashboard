const crypto = require('crypto');
const https = require('https');

const API_KEY = "YdxcAwrheJHg9LEJeFoRf2Jdlxebhrx36IzQd991";
const SECRET_KEY = "1ShpN4lxB3St7opi1v74bJIjRjGq0gHsA4NG7KeG";
const BASE_URL = "max-api.maicoin.com";

function sign(payload) {
  const payloadStr = Buffer.from(JSON.stringify(payload)).toString('base64');
  const sig = crypto.createHmac('sha256', SECRET_KEY).update(payloadStr).digest('hex');
  return { payload: payloadStr, signature: sig };
}

function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    let payload = { nonce: Date.now() };
    if (body) Object.assign(payload, body);
    payload.path = path;

    const auth = sign(payload);
    const options = {
      hostname: BASE_URL,
      path: path,
      method: method,
      headers: {
        'X-MAX-ACCESSKEY': API_KEY,
        'X-MAX-PAYLOAD': auth.payload,
        'X-MAX-SIGNATURE': auth.signature,
        'Content-Type': 'application/json'
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { resolve(data); }
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(payload));
    req.end();
  });
}

async function run() {
  const me = await request('GET', '/api/v2/members/me');
  if (!me || !me.accounts) {
    console.log("Failed to fetch accounts");
    return;
  }
  
  const eth = me.accounts.find(a => a.currency === 'eth');
  const doge = me.accounts.find(a => a.currency === 'doge');
  
  if (eth && parseFloat(eth.balance) > 0.0037) {
    console.log(`Selling ETH: ${eth.balance}`);
    const res = await request('POST', '/api/v2/orders', {
      market: 'ethtwd',
      side: 'sell',
      volume: eth.balance,
      ord_type: 'market'
    });
    console.log("ETH Sell Response:", res);
  } else {
    console.log("No ETH to sell or below min size");
  }

  if (doge && parseFloat(doge.balance) > 80) {
    console.log(`Selling DOGE: ${doge.balance}`);
    const res = await request('POST', '/api/v2/orders', {
      market: 'dogetwd',
      side: 'sell',
      volume: Math.floor(parseFloat(doge.balance)).toString(),
      ord_type: 'market'
    });
    console.log("DOGE Sell Response:", res);
  } else {
    console.log("No DOGE to sell or below min size");
  }
}

run();