#!/usr/bin/env node
// 虛擬貨幣策略進化引擎 — 每 2 小時跑一次
// 功能：績效評估、自動升降級、生成新策略假設、回測新假設、交易量分析、更新 registry

const { MAX } = require('max-exchange-api-node');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'crypto_config.json'), 'utf8'));
const { rest } = new MAX({
  accessKey: CONFIG.api.access_key,
  secretKey: CONFIG.api.secret_key
});

const REGISTRY_FILE = path.join(__dirname, 'crypto_strategy_registry.json');
const STATE_FILE = path.join(__dirname, 'crypto_sim_state.json');
const LOG_FILE = path.join(__dirname, 'crypto_sim_log.json');
const EVOLUTION_LOG_FILE = path.join(__dirname, 'evolution_log.json');
const VOLUME_PATTERNS_FILE = path.join(__dirname, 'volume_patterns.json');
const BACKTEST_RESULTS_FILE = path.join(__dirname, 'backtest_results.json');

const WATCHLIST = ['btctwd', 'ethtwd', 'btcusdt', 'ethusdt', 'soltwd', 'dogetwd'];

// ========== HELPERS ==========
function readJSON(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return null; }
}

function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function appendEvolutionLog(entry) {
  let log = readJSON(EVOLUTION_LOG_FILE) || { entries: [] };
  log.entries.push({ ...entry, timestamp: new Date().toISOString() });
  if (log.entries.length > 200) log.entries = log.entries.slice(-200);
  writeJSON(EVOLUTION_LOG_FILE, log);
}

// ========== STEP 1: 績效評估 ==========
function evaluatePerformance(registry, state) {
  console.log('\n📊 Step 1: 績效評估');
  const strategyStats = state.strategyStats || {};
  const evaluations = {};

  for (const [name, strat] of Object.entries(registry.strategies)) {
    const stats = strategyStats[name] || { wins: 0, losses: 0, pnl: 0 };
    // Merge registry data with state data (state is the source of truth for live trades)
    const wins = stats.wins || strat.wins || 0;
    const losses = stats.losses || strat.losses || 0;
    const totalTrades = wins + losses;
    const pnl = stats.pnl || strat.pnl || 0;

    const winRate = totalTrades > 0 ? wins / totalTrades : 0;

    // Calculate profit factor from closed trades in log
    let grossWin = 0, grossLoss = 0;
    const logTrades = (readJSON(LOG_FILE) || []).filter(t => t.event === 'CLOSE' && t.strategy === name);
    for (const t of logTrades) {
      if (t.pnlTWD > 0) grossWin += t.pnlTWD;
      else grossLoss += Math.abs(t.pnlTWD);
    }
    const avgWin = wins > 0 && grossWin > 0 ? grossWin / wins : 0;
    const avgLoss = losses > 0 && grossLoss > 0 ? grossLoss / losses : 0;
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? 999 : 0);
    const expectancy = totalTrades > 0 ? pnl / totalTrades : 0;

    evaluations[name] = {
      state: strat.state,
      totalTrades,
      wins,
      losses,
      pnl: Math.round(pnl * 100) / 100,
      winRate: Math.round(winRate * 10000) / 100,
      profitFactor: Math.round(profitFactor * 100) / 100,
      expectancy: Math.round(expectancy * 100) / 100,
      avgWin: Math.round(avgWin * 100) / 100,
      avgLoss: Math.round(avgLoss * 100) / 100
    };

    // Sync wins/losses/pnl back to registry
    registry.strategies[name].wins = wins;
    registry.strategies[name].losses = losses;
    registry.strategies[name].pnl = Math.round(pnl * 100) / 100;
    registry.strategies[name].totalTrades = totalTrades;

    if (totalTrades > 0) {
      console.log(`  ${name}: ${wins}W/${losses}L | 勝率 ${evaluations[name].winRate}% | PF ${evaluations[name].profitFactor} | 期望值 ${evaluations[name].expectancy} | PnL ${evaluations[name].pnl}`);
    }
  }

  return evaluations;
}

// ========== STEP 2: 自動升降級 ==========
function autoPromoteDemote(registry, evaluations) {
  console.log('\n🔄 Step 2: 自動升降級');
  const changes = [];

  for (const [name, eval_] of Object.entries(evaluations)) {
    const strat = registry.strategies[name];
    const { totalTrades, winRate, profitFactor } = eval_;
    const prevState = strat.state;

    // TESTING → ACTIVE: ≥10 筆 + 勝率>40% + PF>1.2
    if (strat.state === 'TESTING' && totalTrades >= 10 && winRate > 40 && profitFactor > 1.2) {
      strat.state = 'ACTIVE';
      changes.push({ name, from: prevState, to: 'ACTIVE', reason: `${totalTrades}筆 WR=${winRate}% PF=${profitFactor}` });
    }

    // ACTIVE → PROMOTED: ≥20 筆 + 勝率>45% + PF>1.5
    if (strat.state === 'ACTIVE' && totalTrades >= 20 && winRate > 45 && profitFactor > 1.5) {
      strat.state = 'PROMOTED';
      strat.promotedAt = new Date().toISOString();
      changes.push({ name, from: prevState, to: 'PROMOTED', reason: `${totalTrades}筆 WR=${winRate}% PF=${profitFactor}` });
    }

    // ACTIVE → DEMOTED: ≥10 筆 + (勝率<30% 或 PF<0.8)
    if (strat.state === 'ACTIVE' && totalTrades >= 10 && (winRate < 30 || profitFactor < 0.8)) {
      strat.state = 'DEMOTED';
      strat.demotedAt = new Date().toISOString();
      changes.push({ name, from: prevState, to: 'DEMOTED', reason: `${totalTrades}筆 WR=${winRate}% PF=${profitFactor}` });
    }

    // DEMOTED → RETIRED: ≥20 筆 + 仍不達標
    if (strat.state === 'DEMOTED' && totalTrades >= 20 && (winRate < 30 || profitFactor < 0.8)) {
      strat.state = 'RETIRED';
      changes.push({ name, from: prevState, to: 'RETIRED', reason: `${totalTrades}筆 仍不達標` });
    }
  }

  if (changes.length === 0) {
    console.log('  無升降級變動');
  } else {
    for (const c of changes) {
      console.log(`  ${c.name}: ${c.from} → ${c.to} (${c.reason})`);
      appendEvolutionLog({ event: 'STATE_CHANGE', strategy: c.name, from: c.from, to: c.to, reason: c.reason });
    }
  }

  return changes;
}

// ========== STEP 3: 生成新策略假設 ==========
function generateHypotheses(registry, evaluations) {
  console.log('\n🧬 Step 3: 生成新策略假設');
  const hypotheses = [];

  // Find top performing strategies
  const activeStrats = Object.entries(evaluations)
    .filter(([name, e]) => {
      const s = registry.strategies[name];
      return s && ['ACTIVE', 'PROMOTED', 'TESTING'].includes(s.state) && e.totalTrades > 0;
    })
    .sort((a, b) => b[1].expectancy - a[1].expectancy);

  // a) 參數變體 — EMA period variations
  const emaVariants = [
    { fast: 5, slow: 13, trend: 34, suffix: 'fast' },
    { fast: 10, slow: 30, trend: 60, suffix: 'slow' },
    { fast: 8, slow: 21, trend: 100, suffix: 'long_trend' },
  ];
  for (const v of emaVariants) {
    const name = `trend_ema_cross_${v.suffix}`;
    if (!registry.strategies[name]) {
      hypotheses.push({
        name,
        state: 'HYPOTHESIS',
        type: 'trend',
        description: `EMA ${v.fast}/${v.slow}/${v.trend} 交叉（${v.suffix} 變體）`,
        params: { fast: v.fast, slow: v.slow, trend: v.trend },
        basedOn: 'trend_ema_cross',
        mutationType: 'param_variant'
      });
    }
  }

  // RSI threshold variants
  const rsiVariants = [
    { oversold: 25, overbought: 75, suffix: 'tight' },
    { oversold: 35, overbought: 65, suffix: 'loose' },
  ];
  for (const v of rsiVariants) {
    const name = `reversion_rsi_divergence_${v.suffix}`;
    if (!registry.strategies[name]) {
      hypotheses.push({
        name,
        state: 'HYPOTHESIS',
        type: 'reversion',
        description: `RSI 背離（${v.suffix}：${v.oversold}/${v.overbought}）`,
        params: { oversold: v.oversold, overbought: v.overbought },
        basedOn: 'reversion_rsi_divergence',
        mutationType: 'param_variant'
      });
    }
  }

  // b) 組合策略 — combine top 2 conditions
  if (activeStrats.length >= 2) {
    const [best1, best2] = activeStrats.slice(0, 2);
    const comboName = `combo_${best1[0]}_${best2[0]}`.replace(/trend_|reversion_|breakout_/g, '').substring(0, 40);
    if (!registry.strategies[comboName]) {
      hypotheses.push({
        name: comboName,
        state: 'HYPOTHESIS',
        type: 'combo',
        description: `組合 ${best1[0]} + ${best2[0]}（雙重確認）`,
        params: { strategy1: best1[0], strategy2: best2[0] },
        basedOn: `${best1[0]}+${best2[0]}`,
        mutationType: 'combination'
      });
    }
  }

  // c) BB squeeze variants
  const bbVariants = [
    { maxWidth: 1.0, suffix: 'tight_squeeze' },
    { maxWidth: 2.0, suffix: 'loose_squeeze' },
  ];
  for (const v of bbVariants) {
    const name = `breakout_bollinger_squeeze_${v.suffix}`;
    if (!registry.strategies[name]) {
      hypotheses.push({
        name,
        state: 'HYPOTHESIS',
        type: 'breakout',
        description: `BB 擠壓突破（width < ${v.maxWidth}）`,
        params: { maxWidth: v.maxWidth },
        basedOn: 'breakout_bollinger_squeeze',
        mutationType: 'param_variant'
      });
    }
  }

  // d) Volume-filtered versions of top strategies
  if (activeStrats.length > 0) {
    const bestStrat = activeStrats[0][0];
    const volFilterName = `${bestStrat}_vol_filter`;
    if (!registry.strategies[volFilterName]) {
      hypotheses.push({
        name: volFilterName,
        state: 'HYPOTHESIS',
        type: registry.strategies[bestStrat]?.type || 'trend',
        description: `${bestStrat} + 量能過濾（量比>1.5 才進場）`,
        params: { base: bestStrat, minVolRatio: 1.5 },
        basedOn: bestStrat,
        mutationType: 'volume_filter'
      });
    }
  }

  // Limit new hypotheses per evolution cycle
  const maxNew = 3;
  const newHypotheses = hypotheses.slice(0, maxNew);

  // Add to registry
  for (const h of newHypotheses) {
    registry.strategies[h.name] = {
      state: h.state,
      type: h.type,
      description: h.description,
      params: h.params,
      wins: 0,
      losses: 0,
      pnl: 0,
      totalTrades: 0,
      createdAt: new Date().toISOString(),
      lastTradeAt: null,
      promotedAt: null,
      demotedAt: null,
      basedOn: h.basedOn,
      mutationType: h.mutationType
    };
    console.log(`  🆕 ${h.name} (${h.mutationType}) → HYPOTHESIS`);
    appendEvolutionLog({ event: 'NEW_HYPOTHESIS', strategy: h.name, type: h.mutationType, basedOn: h.basedOn });
  }

  if (newHypotheses.length === 0) {
    console.log('  無新策略假設（已全部生成過）');
  }

  return newHypotheses;
}

// ========== STEP 4: 回測新假設 ==========
async function backtestHypotheses(registry) {
  console.log('\n🔬 Step 4: 回測新假設');

  const hypotheses = Object.entries(registry.strategies)
    .filter(([, s]) => s.state === 'HYPOTHESIS');

  if (hypotheses.length === 0) {
    console.log('  無 HYPOTHESIS 待回測');
    return;
  }

  for (const [name, strat] of hypotheses) {
    console.log(`  回測 ${name}...`);

    try {
      // Run backtester as subprocess for strategies that have implementations
      // For param variants, we use the base strategy's backtester
      const baseName = strat.basedOn?.split('+')[0] || name;
      const backtesterPath = path.join(__dirname, 'crypto_backtester.js');

      // Use the base strategy's backtest results as proxy for variants
      let btResults = readJSON(BACKTEST_RESULTS_FILE);

      // Try to find existing backtest result for base strategy
      let baseResult = null;
      if (btResults && btResults.results) {
        for (const market of WATCHLIST) {
          const key = `${baseName}__${market}`;
          if (btResults.results[key] && btResults.results[key].trades > 0) {
            baseResult = btResults.results[key];
            break;
          }
        }
      }

      if (!baseResult) {
        // Run backtester for base strategy
        try {
          console.log(`    執行 ${baseName} 回測...`);
          execSync(`/usr/local/bin/node "${backtesterPath}" --strategy ${baseName} --market btcusdt --period 14`, {
            timeout: 60000,
            stdio: 'pipe'
          });
          btResults = readJSON(BACKTEST_RESULTS_FILE);
          baseResult = btResults?.results?.[`${baseName}__btcusdt`];
        } catch (e) {
          console.log(`    ⚠️ 回測執行失敗: ${e.message?.substring(0, 80)}`);
        }
      }

      if (baseResult && baseResult.profitFactor > 1.0) {
        // Pass: upgrade to TESTING
        strat.state = 'TESTING';
        console.log(`    ✅ ${name} 通過 (base PF=${baseResult.profitFactor}) → TESTING`);
        appendEvolutionLog({ event: 'BACKTEST_PASS', strategy: name, profitFactor: baseResult.profitFactor });
      } else if (baseResult) {
        // Fail: retire
        strat.state = 'RETIRED';
        console.log(`    ❌ ${name} 未通過 (base PF=${baseResult.profitFactor || 0}) → RETIRED`);
        appendEvolutionLog({ event: 'BACKTEST_FAIL', strategy: name, profitFactor: baseResult?.profitFactor || 0 });
      } else {
        // No data: keep as HYPOTHESIS for next round
        console.log(`    ⏭️ ${name} 無回測數據，保留 HYPOTHESIS`);
      }
    } catch (e) {
      console.log(`    ⚠️ ${name} 回測異常: ${e.message?.substring(0, 80)}`);
    }
  }
}

// ========== STEP 5: 交易量規律分析 ==========
async function analyzeVolumePatterns() {
  console.log('\n📊 Step 5: 交易量規律分析');

  const patterns = {
    lastAnalysis: new Date().toISOString(),
    markets: {},
    highVolumeHours: {},
    lowVolumeHours: {},
    divergences: []
  };

  for (const market of WATCHLIST) {
    console.log(`  分析 ${market} 量能模式...`);

    try {
      // Fetch 15m and 1h candles
      const [candles_15m, candles_1h] = await Promise.all([
        rest.getKLine({ market, period: 15, limit: 672 }),  // ~7 days of 15m
        rest.getKLine({ market, period: 60, limit: 168 })   // 7 days of 1h
      ]);

      const parsed15m = candles_15m.map(c => ({
        time: c[0], open: parseFloat(c[1]), high: parseFloat(c[2]),
        low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5])
      }));

      const parsed1h = candles_1h.map(c => ({
        time: c[0], open: parseFloat(c[1]), high: parseFloat(c[2]),
        low: parseFloat(c[3]), close: parseFloat(c[4]), volume: parseFloat(c[5])
      }));

      if (parsed1h.length < 24) continue;

      // 1H volume by hour-of-day
      const hourlyVolume = {};
      for (const c of parsed1h) {
        const hour = new Date(c.time * 1000).getHours();
        if (!hourlyVolume[hour]) hourlyVolume[hour] = [];
        hourlyVolume[hour].push(c.volume);
      }

      const hourlyAvg = {};
      for (const [hour, vols] of Object.entries(hourlyVolume)) {
        hourlyAvg[hour] = Math.round(vols.reduce((a, b) => a + b, 0) / vols.length);
      }

      const allAvg = Object.values(hourlyAvg).reduce((a, b) => a + b, 0) / Object.values(hourlyAvg).length;

      const highHours = Object.entries(hourlyAvg)
        .filter(([, avg]) => avg > allAvg * 1.3)
        .map(([h]) => parseInt(h))
        .sort((a, b) => a - b);

      const lowHours = Object.entries(hourlyAvg)
        .filter(([, avg]) => avg < allAvg * 0.7)
        .map(([h]) => parseInt(h))
        .sort((a, b) => a - b);

      patterns.markets[market] = {
        hourlyAvgVolume: hourlyAvg,
        overallAvgVolume: Math.round(allAvg),
        highVolumeHours: highHours,
        lowVolumeHours: lowHours
      };

      // Aggregate across markets
      for (const h of highHours) {
        patterns.highVolumeHours[h] = (patterns.highVolumeHours[h] || 0) + 1;
      }
      for (const h of lowHours) {
        patterns.lowVolumeHours[h] = (patterns.lowVolumeHours[h] || 0) + 1;
      }

      // 量價背離分析 (15m candles)
      if (parsed15m.length >= 40) {
        const recent = parsed15m.slice(-40);

        for (let i = 20; i < recent.length; i++) {
          const window = recent.slice(i - 20, i);
          const avgVol = window.reduce((s, c) => s + c.volume, 0) / window.length;
          const curr = recent[i];
          const prev = recent[i - 1];
          const volRatio = avgVol > 0 ? curr.volume / avgVol : 1;
          const priceChange = Math.abs(curr.close - curr.open) / curr.open * 100;

          // 量增價平：量 > 2x 平均，但價格變動 < 0.1%
          if (volRatio > 2.0 && priceChange < 0.1) {
            patterns.divergences.push({
              market,
              type: 'volume_up_price_flat',
              description: '量增價平 — 可能即將突破',
              time: new Date(curr.time * 1000).toISOString(),
              volRatio: Math.round(volRatio * 100) / 100,
              priceChange: Math.round(priceChange * 1000) / 1000
            });
          }

          // 量縮價漲：量 < 0.5x 平均，但價格上漲 > 0.5%
          if (volRatio < 0.5 && curr.close > prev.close && (curr.close - prev.close) / prev.close * 100 > 0.5) {
            patterns.divergences.push({
              market,
              type: 'volume_down_price_up',
              description: '量縮價漲 — 上漲動力不足',
              time: new Date(curr.time * 1000).toISOString(),
              volRatio: Math.round(volRatio * 100) / 100,
              priceChange: Math.round(priceChange * 1000) / 1000
            });
          }

          // 量縮價跌：量 < 0.5x 平均，但價格下跌 > 0.5%
          if (volRatio < 0.5 && curr.close < prev.close && (prev.close - curr.close) / prev.close * 100 > 0.5) {
            patterns.divergences.push({
              market,
              type: 'volume_down_price_down',
              description: '量縮價跌 — 下跌力道減弱',
              time: new Date(curr.time * 1000).toISOString(),
              volRatio: Math.round(volRatio * 100) / 100,
              priceChange: Math.round(priceChange * 1000) / 1000
            });
          }
        }
      }

      // Rate limit
      await new Promise(r => setTimeout(r, 500));

    } catch (e) {
      console.error(`  ⚠️ ${market} 量能分析失敗: ${e.message}`);
    }
  }

  // Keep only last 50 divergences
  patterns.divergences = patterns.divergences.slice(-50);

  // Determine global high/low volume hours (appear in ≥ 2 markets)
  const marketCount = Object.keys(patterns.markets).length;
  const threshold = Math.max(2, Math.floor(marketCount / 2));
  patterns.globalHighVolumeHours = Object.entries(patterns.highVolumeHours)
    .filter(([, count]) => count >= threshold)
    .map(([h]) => parseInt(h))
    .sort((a, b) => a - b);
  patterns.globalLowVolumeHours = Object.entries(patterns.lowVolumeHours)
    .filter(([, count]) => count >= threshold)
    .map(([h]) => parseInt(h))
    .sort((a, b) => a - b);

  writeJSON(VOLUME_PATTERNS_FILE, patterns);

  console.log(`  🕐 高量時段 (UTC+8): ${patterns.globalHighVolumeHours.map(h => h + ':00').join(', ') || '分析中...'}`);
  console.log(`  🕐 低量時段 (UTC+8): ${patterns.globalLowVolumeHours.map(h => h + ':00').join(', ') || '分析中...'}`);
  console.log(`  📉 量價背離信號: ${patterns.divergences.length} 個`);

  return patterns;
}

// ========== STEP 6: 更新 REGISTRY ==========
function updateRegistry(registry) {
  console.log('\n💾 Step 6: 更新 Registry');

  registry.lastEvolution = new Date().toISOString();
  registry.evolutionCount = (registry.evolutionCount || 0) + 1;

  writeJSON(REGISTRY_FILE, registry);

  // Summary
  const states = {};
  for (const [, s] of Object.entries(registry.strategies)) {
    states[s.state] = (states[s.state] || 0) + 1;
  }
  console.log(`  策略總數: ${Object.keys(registry.strategies).length}`);
  console.log(`  狀態分佈: ${Object.entries(states).map(([k, v]) => `${k}=${v}`).join(' | ')}`);
  console.log(`  進化次數: ${registry.evolutionCount}`);

  appendEvolutionLog({
    event: 'EVOLUTION_COMPLETE',
    evolutionCount: registry.evolutionCount,
    strategyCount: Object.keys(registry.strategies).length,
    stateDistribution: states
  });
}

// ========== MAIN ==========
async function main() {
  console.log('🧬 虛擬貨幣策略進化引擎 v1.0');
  console.log(`⏰ ${new Date().toISOString()}\n`);

  // Load data
  let registry = readJSON(REGISTRY_FILE);
  if (!registry) {
    console.error('❌ Registry 不存在，請先執行初始化');
    process.exit(1);
  }

  const state = readJSON(STATE_FILE);
  if (!state) {
    console.error('❌ State 不存在');
    process.exit(1);
  }

  // Step 1: Evaluate
  const evaluations = evaluatePerformance(registry, state);

  // Step 2: Auto promote/demote
  const changes = autoPromoteDemote(registry, evaluations);

  // Step 3: Generate hypotheses
  const hypotheses = generateHypotheses(registry, evaluations);

  // Step 4: Backtest hypotheses (only if there are new ones)
  if (hypotheses.length > 0) {
    try {
      await backtestHypotheses(registry);
    } catch (e) {
      console.error('  ⚠️ 回測步驟失敗:', e.message);
    }
  }

  // Step 5: Volume analysis
  try {
    await analyzeVolumePatterns();
  } catch (e) {
    console.error('  ⚠️ 量能分析失敗:', e.message);
  }

  // Step 6: Update registry
  updateRegistry(registry);

  console.log('\n✅ 進化完成');
}

main().catch(e => {
  console.error('❌ Evolver error:', e.message);
  appendEvolutionLog({ event: 'ERROR', error: e.message });
  process.exit(1);
});
