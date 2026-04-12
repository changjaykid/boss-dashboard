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

