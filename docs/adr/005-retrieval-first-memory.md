# ADR-005: Retrieval-First Memory Architecture

**Status:** Proposed
**Date:** 2026-08-06
**Supersedes:** [ADR-004](004-cognitive-codebase-memory.md)
**Evidence base:** [`docs/agentic-memory-research-2026.md`](../agentic-memory-research-2026.md) — five research lanes, ~110 primary sources, verified 2026-08-06

---

## Context

### Where we actually are

ADR-004 proposed a seven-phase cognitive memory layer. What shipped:

- `session_observation` document type (`src/types.ts`)
- `observe` MCP tool (`src/mcp/tools/observe.ts`) — embeds and writes observations
- Type weight `session_observation: 0.2` in the `search` use case (`src/core/store.ts`)
- `--agent` output formatting for observations (`src/output/agent.ts`)

What did not ship: ACT-R temporal scoring, Hebbian co-access, the post-session Curator, consolidation, staleness detection, differential RRF k, score explanation. Zero references to `accessCount`, `lastAccess`, Hebbian, Curator, or consolidation exist in `src/`.

Three defects in what did ship:

1. **The memory layer writes more reliably than it reads.** `src/retrieval/backends/semantic.ts:61-64` returns `null` for every `session_observation` result. The newer pipeline discards observations entirely; the legacy `store.ts` path surfaces them at weight 0.2. Whether memory exists depends on which code path a caller takes.
2. **Two unconnected memory systems.** `session_observation` documents (embedded, retrievable, in LanceDB) and `MemoryStore` (`src/memory/store.ts` — plain markdown key/value files, no embedding, no retrieval, findable only by a key the agent already knows). Nothing bridges them.
3. **No quality gate, no measurement.** Observations are written on the agent's say-so and never evaluated.

### What changed in the research

ADR-004's [correction notice](004-cognitive-codebase-memory.md) lists the falsified findings. Four results establish the new picture:

**The static index is validated.** *Code Isn't Memory* ([arXiv 2606.22417](https://arxiv.org/abs/2606.22417)) ablated an architecture near-identical to our Layer 1 — tree-sitter AST, symbol and call graph, BM25 plus vector — with the model held fixed, 3 seeds, 91 instances, leak-audited: resolve **41.9% → 50.4%** (+7.9pp, paired Wilcoxon p=0.003), localization acc@5 **44.3% → 84.5%**, turns 36.2 → 28.3, **$2.84 → $2.30 per solve**. The gain concentrates in multi-file changes (3+ gold files: 91.3 vs 44.9 acc@5).

**Ungated agent-authored memory measures negative.** SkillsBench ([arXiv 2602.12670](https://arxiv.org/abs/2602.12670)), paired conditions with deterministic verifiers over 7,308 trajectories: human-curated skills **+16.6pp**; self-generated skills **−8.1pp** (Claude Code + Opus 4.7), **−11.3pp** (Codex + GPT-5.5), **−11.5pp** (Gemini CLI + Gemini 3.1 Pro). Verbatim: *"models cannot reliably author the procedural knowledge they benefit from consuming."* Our `observe` tool is that experimental cell.

**Structured, commit-anchored memory measures strongly positive.** MemCoder ([arXiv 2603.13258](https://arxiv.org/abs/2603.13258)): DeepSeek-V3.2 **68.4% → 77.8%** on SWE-bench Verified (+9.4pp). The difference from every null result is schema and retrieval discipline, not whether sessions are stored.

**The bottleneck is retrieval precision, not capture.** SWE-ContextBench ([arXiv 2602.08316](https://arxiv.org/html/2602.08316v3)), same experience corpus throughout: oracle-selected summaries **+8.08pp**, agent-selected summaries **−4.04pp**, agent-retrieved raw context **±0 at +27% cost**.

---

## Decision

### D1 — Retrieval-layer work is unconditional and comes first

These pay off whether or not a memory layer is ever built. Each has an isolating ablation behind it.

| # | Change | Evidence | Cost |
|---|---|---|---|
| **1** | Replace the LLM query-intent router with a TF-IDF + linear SVM classifier | RAGRouter-Bench ([2604.03455](https://arxiv.org/abs/2604.03455)): **0.928 macro-F1 / 93.2% accuracy**, 79% of oracle token savings, zero model calls. No published head-to-head shows an LLM router winning; routing ablations show routing buys cost, not quality | ~1 day + labeled queries. Frees 300ms–2s from the hot path |
| **2** | Replace uniform-k RRF with TM2C2-normalized convex combination, one tuned α | Bruch, Gai & Ingber TOIS 2023 ([2210.11934](https://arxiv.org/abs/2210.11934)) — beat RRF on **all nine** datasets (MS MARCO 0.454 vs 0.425, NQ 0.542 vs 0.514, HotpotQA 0.699 vs 0.675 NDCG@1000). One parameter instead of two-per-retriever; tuned RRF k is documented not to generalize | ~50 LOC |
| **3** | Deterministic freshness: `argmax(commit_ordinal)` over duplicate symbol facts | *Don't Ask the LLM to Track Freshness* ([2606.01435](https://arxiv.org/abs/2606.01435)): **+10.8pp**, widening to **+21pp** at long context. LLM identifies candidates; plain `max()` picks the winner | ~50 LOC, $0.0001/query |
| **4** | Per-query IDF-derived fusion weights + relaxed distance cutoff for long queries | vstash ([2604.15484](https://arxiv.org/abs/2604.15484)): +0.1% to +3.4% typical, **+21.4%** on the outlier class. No model call | ~30 LOC |
| **5** | Query-seeded Personalized PageRank, seeds = top-k hybrid hits, reset ≈0.05 | HippoRAG 2 ([2502.14802](https://arxiv.org/abs/2502.14802), ICML 2025): multi-hop recall@5 **+13.9**; near-zero on single-hop. Our PageRank is global and index-time, so "important" means important-in-the-repo, not important-for-this-question | ~150 LOC, single-digit ms; moves PageRank to query time |
| **6** | Resolve the `semantic.ts:61-64` observation drop deliberately | Correctness. Today the answer to "does memory exist" depends on the caller's code path | ~1 hour |
| **7** | Small cross-encoder rerank (≤150M, ONNX INT8) over top-20 — **gated behind an eval** | A 149M ModernBERT cross-encoder matches a 1.2B model at 83.0% Hit@1 (+20.3pp over no rerank). Code-specific ([2607.05443](https://arxiv.org/abs/2607.05443)): Hybrid-Rerank MRR@10 .528 vs Hybrid-RRF .487. **But** vstash measured cross-encoder reranking at −0.3% to −3.1% NDCG on a local-first corpus | 1–2 days; ~200–400ms CPU, which only fits budget after #1 |

Item 5 is routed, not universal: GraphRAG-Bench ([2506.05690](https://arxiv.org/abs/2506.05690), ICLR 2026) finds basic RAG **beats** graph methods on simple fact retrieval and loses by +10 to +13 on complex reasoning.

### D2 — The memory layer is gated on a measurement, not shipped on faith

No memory work merges to the default path until the placebo control runs.

**Condition C5 — memory harvested from an unrelated repository at matched token count.** If placebo memory performs within noise of real memory, the effect is context volume rather than memory content, and the layer is abandoned. Nobody in the literature runs this control. It is cheap and it is decisive, so it runs first.

Full experimental design in [the research doc §5](../agentic-memory-research-2026.md). Non-negotiable elements:

- **C4, the token-matched control** — the baseline given the memory layer's token budget as extra reasoning steps. This control erased the published gains of AWM, ASI and ReasoningBank ([2606.15017](https://arxiv.org/abs/2606.15017)).
- **≥120 tasks** for 80% power at 10pp. At 17 tasks × 3 repeats the minimum detectable effect is ~30pp, which we will not observe.
- **SWE-bench Pro / SWE-PolyBench Verified / SWE-bench-Live — not SWE-bench Verified**, which has documented contamination (>60% of 138 audited tasks unsolvable as written; 32.67% of successful patches involved solution leakage).
- **Agent-targeted localization acc@5** as the sensitive diagnostic — credit a path only when the agent actually read or edited it.
- Tenure checkpoints at 10, 40 and 100 accumulated sessions. The one longitudinal study found a rank inversion between week 3 and week 9.

### D3 — If built, memory takes the MemCoder shape

Not free text with an enum. The stored unit is:

```typescript
interface CodeMemory {
  // MemCoder core — what makes the +9.4pp configuration different
  keywords: string[];
  problem: string;
  rootCause: string;
  solution: string;

  // Anchoring (ours; MemCoder anchors to commit only)
  symbolAnchors: string[];        // symbol@file — validated against the tree on every recall
  affectedFiles: string[];
  commitSha: string;

  // Provenance — required, per OWASP ASI06 memory-poisoning guidance
  source: "curator" | "agent" | "git-history";
  derivedFrom: string[];          // test name, error type, diff hash — never "the session"

  // ACE bullet model — demotion without deletion
  id: string;
  helpfulCount: number;
  harmfulCount: number;

  // Bi-temporal validity (D4)
  validFromCommit: string;
  invalidatedAtCommit: string | null;
}
```

Embed `keywords ⊕ problem`. Retrieve ANN → cross-encoder rerank. Cap injection at **two or three notes per task** (SkillsBench: 1 skill +18.0pp, 2–3 +19.0pp, ≥4 only +10.1pp; ReasoningBank: k=1 49.7% → k=4 44.4%).

Three write-path rules, each from a measured failure:

1. **Extract from parsed artifacts, never from introspection.** Feed the curator the failing assertion, the error type, the fixing diff. Never "summarize what you learned." *Honest Lying* ([2605.29463](https://arxiv.org/html/2605.29463)): 0 of 121 self-reflections identified the correct cause in frozen environments; the parsed-artifact fix moved correct-cause identification **0% → 86%** and cut frozen-memory rate 0.64 → 0.10.
2. **Cold-start from git history.** This is what produced MemCoder's +9.4pp, and it inverts the cold-start risk ADR-004 flagged.
3. **The curator holds the write tools; the interactive agent does not.** Letta's sleep-time inversion ([2504.13171](https://arxiv.org/abs/2504.13171)). Our post-commit hook is the natural idle boundary, and query predictability — the paper's stated precondition — is high in a codebase.

Deduplicate at calibrated cosine thresholds (near-dedup 0.559, derived from within-session similarity distributions, not guessed). **Never summarize:** the only controlled test of summarizing consolidation scored **48.4%** versus a 78.4% raw baseline, because merging into cluster summaries destroys the details factual questions need.

### D4 — Staleness is the differentiator

Split what we currently treat identically:

| Class | Types | Invalidation rule |
|---|---|---|
| **Derived** | `file_summary`, `symbol_summary`, `idiom`, `usage_example`, `anti_pattern` | Re-derivable from code → source file changes, auto-invalidate and queue re-enrichment |
| **Observed** | `session_observation`, `project_doc` | Not re-derivable → flag stale, **never** auto-delete |

Give every memory `validFromCommit` / `invalidatedAtCommit`. Facts are superseded, never deleted (Graphiti's schema, without its LLM).

This is the defensible position. STALE ([2605.06527](https://arxiv.org/abs/2605.06527)) measures whether a model knows its own memories have gone invalid: best frontier model **55.2%**, because for conversation it requires commonsense inference. For a codebase it requires a `git diff`. Note the cautionary data point: Graphiti/Zep *has* bi-temporal infrastructure and scores **7%** on FactConsolidation — the schema alone buys nothing, the invalidation decision is what matters, and ours is deterministic.

### D5 — Explicit non-goals

| Not building | Why |
|---|---|
| **ACT-R / any time-decay term in the ranking score** | 5 of 5 isolating ablations neutral-to-negative; recency scored **AUC 0.51** on a software corpus. Supersedes ADR-004 Phase 1 |
| Time decay anywhere except eviction | Its one demonstrated effect is store-size control: 97.2% retention precision, 58% store reduction. If used, measure store size — never nDCG |
| LLM-extracted knowledge graphs | Mem0 **deleted** graph memory from OSS (April 2026) after measuring it at ~2%. Independent study: Cognee and Zep need 116.5s / 155.1s construction for their utility. Tree-sitter gives us a more accurate graph for free |
| RAPTOR / GraphRAG communities / LightRAG | One LLM call per cluster over 40K chunks, redone on churn. RAPTOR's own ablation shows the collapsed tree beats traversal |
| ColBERT / PLAID late interaction | 10–30× index storage; beaten by a tuned small dense model at local scale |
| LLM reranking on every query | 1–4s for a job a 149M cross-encoder does in 188ms. The documented gain belongs to reranker *models* |
| Per-source RRF k tuning | Universally recommended, zero controlled evidence; Bruch's non-generalization finding argues against |
| Summarizing consolidation | 48.4% |
| PAS sequential transition tables | Already deferred in ADR-004; the deferral stands |
| Any LoCoMo-derived number | 6.4% of the answer key is wrong; the standard judge accepts **62.81%** of deliberately wrong answers; full-context beats every memory system on it |

**Deferred behind a flag with a control:** Hebbian co-access + one-hop spreading activation (HeLa-Mem constants λ=0.995, η=0.02, β=0.1, initialized from the ground-truth call graph rather than zero). Validation-gate the updates — strengthen only when co-retrieval is followed by an edit. Ship dark and reproduce PAM's temporal-shuffle control on our own logs before enabling; if shuffled co-access performs like real co-access, delete it.

### D6 — Positioning claims we can defend

1. **Efficiency and localization, locally.** Same-or-better outcomes at ~22% fewer turns, ~28% fewer tokens, ~18% lower cost per solve, ~2× rank-1 localization, nothing leaving the machine. Measured, not asserted.
2. **Symbol-anchored, self-invalidating memory.** What markdown memory files structurally cannot do.
3. **Multi-file blast radius.** The index's advantage is 46.4pp of localization in the 3+-gold-file bucket and near-zero on single-file tasks. `impact` is our most underexploited command.

Retired claims: *"no production coding tool learns across sessions"* (false — see the ADR-004 correction notice); *"semantic code search"* as the headline (the graph is the differentiated asset, dense vectors are the commodity layer); any resolve-rate promise — Coherence Collapse ([2603.24631](https://arxiv.org/abs/2603.24631), 16,758 trajectories) found **60–69% of capable-model failures already reach and edit the correct functions**, so retrieval cannot fix bad edits.

---

## Disposition of ADR-004's roadmap

| ADR-004 phase | Disposition |
|---|---|
| Phase 1 — ACT-R temporal scoring | **Cut.** Falsified premise (F4) |
| Phase 2 — `session_observation` type + `observe` tool | **Shipped.** Schema to be replaced per D3 |
| Phase 3 — search integration | **Superseded** by D1 items 1–7 |
| Phase 4 — post-session Curator | **Retained, redesigned** per D3: parsed artifacts, curator-holds-write-tools, git-history cold start |
| Phase 5 — staleness detection | **Promoted to the centerpiece** (D4) |
| Phase 6 — Hebbian co-access | **Deferred behind a flag with a shuffle control** |
| Phase 7 — consolidation | **Retained as dedup only.** Summarization explicitly cut |

---

## Consequences

### Positive

- The unconditional work (D1) is ~7 contained changes with isolating ablations behind each, independent of the memory question, and item 1 alone removes an LLM call from the hot path.
- Killing the LLM router frees the budget that makes a cross-encoder reranker affordable — the two changes are complementary rather than competing.
- D4 turns the field's hardest open problem into a `git diff`, which is a genuine and narrow moat.
- Cutting Phase 1 and the LLM-KG family removes work that the evidence says is neutral-to-harmful.

### Negative

- D2 makes the memory layer expensive to justify: ≥120 tasks × 6 conditions × 3 seeds per tenure checkpoint. Cutting conditions is preferable to cutting tasks; C0/C1/C4/C5 is the irreducible core.
- Query-time PPR moves cost from indexing to search and must be held inside the latency budget.
- Replacing the observation schema (D3) invalidates observations written by the current `observe` tool. Given the write path is ungated and the read path is broken, the loss is small.
- The first-mover narrative is gone and marketing copy needs rewriting.

### Risks

- **The placebo control may kill the memory layer.** That is the point. Better to learn it from C5 than from users.
- **Cross-encoder reranking has one published negative result at local-first scale** (−0.3% to −3.1% NDCG). It stays gated behind an eval set, which items 2 and 4 need built anyway.
- **`mnemex rg` is degraded independently of this ADR.** Claude Code 2.1.117 removed Grep and Glob on native macOS and Linux builds, replacing them with embedded `ugrep`/`bfs` via Bash ([SDK #301](https://github.com/anthropics/claude-agent-sdk-typescript/issues/301), [claude-code#51921](https://github.com/anthropics/claude-code/issues/51921)). Any strategy built on intercepting the agent's search subprocess is betting against the vendor roadmap. Needs its own decision.
- **`src/learning/` is 23,678 lines across 55 files** reachable only through one CLI feedback command; the MCP server never touches it. Not in scope here, but it is maintenance surface producing nothing and should get its own disposition.
