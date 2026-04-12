# Strategy Categories

This directory contains strategy **category documentation**, not a fixed list.

New categories are added as the system learns new trading methods.
Individual strategies are registered in `trading/crypto_strategy_registry.json`.

## Current Categories
- `trend-following.md` — 趨勢跟隨類
- `mean-reversion.md` — 均值回歸類
- `breakout.md` — 突破類

## Categories to Add (as system evolves)
- `price-action.md` — 裸K / 價格行為類
- `elliott-wave.md` — 波浪理論類
- `wyckoff.md` — Wyckoff 方法類
- `ict-smc.md` — ICT / Smart Money Concept 類
- `on-chain.md` — 鏈上數據策略類 (whale tracking, funding rate)
- `sentiment.md` — 情緒面策略類 (Fear & Greed, social momentum)
- `composite.md` — 複合策略（多信號組合）
- `regime-adaptive.md` — 市場狀態自適應類
- `crypto-specific.md` — 加密貨幣特有策略（清算瀑布、資金費率套利等）

Each category file documents the **theory and principles**, not specific parameter sets.
Specific strategies with their parameters live in `crypto_strategy_registry.json`.
