const { MAX } = require('max-exchange-api-node');

const client = new MAX({
  accessKey: "YdxcAwrheJHg9LEJeFoRf2Jdlxebhrx36IzQd991",
  secretKey: "1ShpN4lxB3St7opi1v74bJIjRjGq0gHsA4NG7KeG"
});

client.getMe().then(me => {
  const eth = me.accounts.find(a => a.currency === 'eth');
  const doge = me.accounts.find(a => a.currency === 'doge');
  
  console.log("ETH:", eth);
  console.log("DOGE:", doge);
  
  if (eth && parseFloat(eth.balance) >= 0.0037) {
    console.log(`Selling ETH: ${eth.balance}`);
    client.createOrder({
      market: 'ethtwd',
      side: 'sell',
      volume: eth.balance,
      ord_type: 'market'
    }).then(console.log).catch(console.error);
  }

  if (doge && parseFloat(doge.balance) >= 80) {
    console.log(`Selling DOGE: ${doge.balance}`);
    client.createOrder({
      market: 'dogetwd',
      side: 'sell',
      volume: Math.floor(parseFloat(doge.balance)).toString(),
      ord_type: 'market'
    }).then(console.log).catch(console.error);
  }
}).catch(console.error);