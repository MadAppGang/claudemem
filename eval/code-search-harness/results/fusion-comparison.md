# Fusion Comparison — RRF vs TM2C2

**Generated**: 2026-08-10T15:11:59.171Z  
**Dataset**: eval/datasets/mnemex-git  
**Project**: /Users/jack/mag/mnemex/.claude/worktrees/mnemex-fix  
**Paired queries**: 135  
**Active backends**: symbol-graph, semantic, location, tree-sitter

## Paired metrics

| Metric | rrf | tm2c2 | Delta | Improved | Regressed | Tied | p | r |
|--------|------|------|-------|----------|-----------|------|---|---|
| mrr | 0.5453 | 0.5356 | -0.0097 | 2 | 4 | 129 | 0.1422 | 0.599 |
| ndcg_at_5 | 0.4120 | 0.4075 | -0.0045 | 1 | 4 | 130 | 0.1056 | 0.724 |
| ndcg_at_10 | 0.4424 | 0.4376 | -0.0048 | 3 | 8 | 124 | 0.1973 | 0.389 |
| recall_at_1 | 0.1811 | 0.1759 | -0.0052 | 0 | 2 | 133 | 0.3711 | 0.632 |
| recall_at_5 | 0.4360 | 0.4335 | -0.0025 | 0 | 1 | 134 | 1.0000 | 0.000 |
| recall_at_10 | 0.5458 | 0.5427 | -0.0031 | 1 | 2 | 132 | 0.4227 | 0.463 |

## Latency (ms)

| Condition | Mean | P50 | P95 |
|-----------|------|-----|-----|
| rrf | 4760.4 | 1896.1 | 17738.0 |
| tm2c2 | 2841.3 | 1870.3 | 8569.1 |

## Zero-result queries

- rrf: 0 / 135
- tm2c2: 0 / 135

## Fusion reach

- Queries whose ranking differs between arms: **129 / 135**
- The remainder were routed to a single backend, where RRF and TM2C2 are
  order-identical by construction.

## Top per-query MRR movers

| Query ID | Delta | Query |
|----------|-------|-------|
| e3e2ee6 | -0.500 | add auto-update command and version check. - Add `claudemem update` command to c |
| a8b2456 | -0.500 | add OpenAI-compatible provider support and improve indexing performance. - Add g |
| 38b020b | -0.167 | shebang node→bun and clear update cache on explicit update. - Change shebang fro |
| ac610bf | -0.167 | upgrade web-tree-sitter to support grammar version 15. - Upgrade web-tree-sitter |
| a21fca2 | +0.024 | use new Query() constructor instead of deprecated Language.query(). Updates tree |
| 91ffb37 | +0.003 | highlight all tied winners/losers in benchmark table. Use rounded values for com |
