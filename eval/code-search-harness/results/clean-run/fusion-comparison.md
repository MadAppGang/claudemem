# Fusion Comparison — RRF vs TM2C2

**Generated**: 2026-08-14T01:37:55.794Z  
**Dataset**: eval/datasets/mnemex-git  
**Project**: /Users/jack/mag/mnemex/.claude/worktrees/mnemex-fix  
**Paired queries**: 135  
**Active backends**: symbol-graph, semantic, location, tree-sitter

## Paired metrics

| Metric | rrf | tm2c2 | Delta | Improved | Regressed | Tied | p | r |
|--------|------|------|-------|----------|-----------|------|---|---|
| mrr | 0.5453 | 0.5368 | -0.0085 | 2 | 6 | 127 | 0.1834 | 0.470 |
| ndcg_at_5 | 0.4125 | 0.4078 | -0.0047 | 2 | 5 | 128 | 0.0910 | 0.639 |
| ndcg_at_10 | 0.4436 | 0.4379 | -0.0057 | 3 | 7 | 125 | 0.1263 | 0.483 |
| recall_at_1 | 0.1811 | 0.1759 | -0.0052 | 0 | 2 | 133 | 0.3711 | 0.632 |
| recall_at_5 | 0.4360 | 0.4335 | -0.0025 | 0 | 1 | 134 | 1.0000 | 0.000 |
| recall_at_10 | 0.5477 | 0.5427 | -0.0049 | 0 | 2 | 133 | 0.3711 | 0.632 |

## Latency (ms)

| Condition | Mean | P50 | P95 |
|-----------|------|-----|-----|
| rrf | 2078.7 | 1217.8 | 7035.5 |
| tm2c2 | 3069.2 | 1651.6 | 8325.0 |

## Zero-result queries

- rrf: 0 / 135
- tm2c2: 0 / 135

## Fusion reach

- Queries whose ranking differs between arms: **128 / 135**
- The remainder were routed to a single backend, where RRF and TM2C2 are
  order-identical by construction.

## Top per-query MRR movers

| Query ID | Delta | Query |
|----------|-------|-------|
| e3e2ee6 | -0.500 | add auto-update command and version check. - Add `claudemem update` command to c |
| a8b2456 | -0.500 | add OpenAI-compatible provider support and improve indexing performance. - Add g |
| caae4b1 | +0.167 | rename opencode plugin and vscode autocomplete extension. Rewrite the renamed in |
| 38b020b | -0.167 | shebang node→bun and clear update cache on explicit update. - Change shebang fro |
| ac610bf | -0.167 | upgrade web-tree-sitter to support grammar version 15. - Upgrade web-tree-sitter |
| a21fca2 | +0.024 | use new Query() constructor instead of deprecated Language.query(). Updates tree |
| 7daf9a7 | -0.005 | comprehensive embedding quality test based on MTEB/CodeSearchNet research. Redes |
| 91ffb37 | -0.002 | highlight all tied winners/losers in benchmark table. Use rounded values for com |
