# Errors

## [ERR-20260412-001] exec

**Logged**: 2026-04-12T00:07:00Z
**Priority**: medium
**Status**: pending
**Area**: infra

### Summary
OpenClaw exec preflight rejected a chained `cd && node ... && bash ...` command as a complex interpreter invocation.

### Error
```
exec preflight: complex interpreter invocation detected; refusing to run without script preflight validation. Use a direct `python <file>.py` or `node <file>.js` command.
```

### Context
- Command attempted: `cd /Users/kid/.openclaw/workspace/workers/money-maker/engine && node money_maker_engine.js && bash /Users/kid/.openclaw/workspace/workers/sync_dashboards.sh`
- Environment: OpenClaw exec tool on workspace host
- Follow-up: succeeded by splitting into direct `node money_maker_engine.js` with `workdir` and a separate `bash ...` invocation

### Suggested Fix
When using exec for Node or Python scripts, prefer a direct interpreter call with `workdir` instead of chained shell commands.

### Metadata
- Reproducible: yes
- Related Files: /Users/kid/.openclaw/workspace/.learnings/ERRORS.md

---

## [ERR-20260412-001] crypto-money-maker

**Logged**: 2026-04-12T15:51:00Z
**Priority**: high
**Status**: pending
**Area**: config

### Summary
Money maker engine failed because `workers/money-maker/data/crypto_config.json` was missing, while the actual shared MAX API config lived at `trading/crypto_config.json`.

### Error
```text
Error: ENOENT: no such file or directory, open '/Users/kid/.openclaw/workspace/workers/money-maker/data/crypto_config.json'
```

### Context
- Command attempted: `node money_maker_engine.js`
- Trigger: cron run for crypto money maker
- Engine invoked `money_maker_fetch.js`, which expects config under `workers/money-maker/data/`
- Existing config found at `/Users/kid/.openclaw/workspace/trading/crypto_config.json`

### Suggested Fix
Keep a stable symlink or unify config path resolution so engine and fetch scripts read the same shared config location.

### Metadata
- Reproducible: yes
- Related Files: workers/money-maker/engine/money_maker_fetch.js, workers/money-maker/engine/money_maker_engine.js, trading/crypto_config.json

---

## [ERR-20260413-001] money_maker_engine

**Logged**: 2026-04-12T18:10:00Z
**Priority**: high
**Status**: resolved
**Area**: backend

### Summary
money_maker_engine.js 在更新綜合 dashboard 時引用未定義的 state 變數，導致整輪執行中止

### Error
```
ReferenceError: state is not defined
    at updateCombinedDashboard (.../money_maker_engine.js:311:14)
```

### Context
- Command/operation attempted: `node money_maker_engine.js`
- Trigger point: updateCombinedDashboard() 第二段 ALL_MARKETS 迴圈
- Root cause: 迴圈內使用 `state.lastAnalysis`，但該作用域沒有宣告 state

### Suggested Fix
改為在該迴圈內讀取 `combinedState.markets[m]` 到局部變數 `mState`，再用 `mState.lastAnalysis`

### Metadata
- Reproducible: yes
- Related Files: workers/money-maker/engine/money_maker_engine.js

### Resolution
- **Resolved**: 2026-04-12T18:11:00Z
- **Notes**: 已改用 `mState`，避免 dashboard 更新時崩潰

---
