# Agentic Memory for Code — 2026 Research Findings

**Date:** 2026-08-06
**Status:** Research synthesis. Supersedes the research basis of [ADR-004](adr/004-cognitive-codebase-memory.md), which remains *Proposed* and is now partly falsified.
**Method:** Five parallel research lanes, ~90 web searches, ~110 primary sources fetched (arXiv, vendor engineering blogs, official docs, benchmark repos). Every load-bearing number below carries a source URL.

---

## 1. The one-paragraph verdict

mnemex's **Layer 1 is the asset and the evidence backs it decisively.** A leak-audited, model-controlled ablation of an architecture near-identical to ours (tree-sitter AST → symbol + call graph → BM25 + vector hybrid) measured **+7.9pp resolve rate (p=0.003)** and **+39.6pp localization acc@5 (p<0.0001)** at **lower cost per solve**. Layer 2 as specified in ADR-004 is a different story: three of its four load-bearing research findings do not survive verification, and its centerpiece mechanism — ACT-R temporal scoring — is contradicted by every isolating ablation published since. The memory thesis is *not* dead, but the one configuration with a strong positive result (+9.4pp on SWE-bench Verified) looks nothing like what ADR-004 specifies.

---

## 2. Corrections to ADR-004

ADR-004 was written 2026-03-04 against a research session that used MuninnDB as its architectural blueprint. Four of its numbered findings need amendment.

### 2.1 Finding 4 — "ACT-R temporal scoring provides 37x recency advantage" — **NOT SUPPORTED**

The "37x" is a worked example from MuninnDB's own benchmarks, not an ablation against a no-decay baseline. It shows the formula produces a 37x score ratio; it does not show that ratio improves retrieval.

Five independent isolating ablations, 2025–2026, all neutral-to-negative:

| Study | Test | Result |
|---|---|---|
| Microsoft, *Human-Inspired Memory Architecture* ([2605.08538](https://arxiv.org/abs/2605.08538)) | Feature calibration on the **VSCode issue tracker** (13,127 issues, 120K events) | recency weight **0.019**, **AUC 0.51 — chance**. Verbatim: *"recency provides negligible discrimination"* |
| HeLa-Mem ([2604.16839](https://arxiv.org/abs/2604.16839)) | Ablate the forgetting module | Removing forgetting **improved all four** LoCoMo categories (multi-hop 36.04→36.71, temporal 46.23→46.50, open 29.50→30.58, single 45.04→45.24) |
| vstash ([2604.15484](https://arxiv.org/abs/2604.15484)) | Frequency+decay reranking | **−0.3% to −3.1% NDCG.** Ships with recency boost `B = 0.0` (off) |
| SCM ([2604.20943](https://arxiv.org/abs/2604.20943)) | Ablate ForgettingModule | Recall stayed **22/22 (100%)**; store grew 24→72 entries |
| TWICE ([2602.22222](https://arxiv.org/abs/2602.22222)) | Decay term vs similarity-only | **+0.0044** |

The Microsoft result is the most damaging because the corpus is software issues — the closest published analogue to our domain — and recency scored at chance as a relevance predictor.

**Decay's demonstrated value is store-size control, not ranking quality.** Microsoft measured retention precision 75.4% → **97.2%** with **58% store reduction**. That is garbage collection. If we want a temporal mechanism it belongs in eviction (λ=0.001, half-life ≈29 days), measured on store size, and it must not touch the ranking score.

**Consequence for ADR-004:** Phase 1 (1–2 days, ACT-R scoring on composite RRF) should be cut, not deferred.

### 2.2 Finding 2 — "arXiv 2602.11988 shows 0.5–8.3pp degradation" — **PARTLY FABRICATED**

The paper is real: Gloaguen, Mündler, Müller, Raychev, Vechev (ETH Zurich SRI Lab), *Evaluating AGENTS.md* ([2602.11988](https://arxiv.org/abs/2602.11988)).

- **−0.5pp on SWE-bench Lite: confirmed.** ~−2% on AGENTbench: confirmed.
- **"8.3pp" does not appear in the paper.** Verified per-model deltas are all within ±1–2pp.
- The paper reports **no confidence intervals and no significance tests**. On 300 instances, −0.5pp is 1.5 instances. The honest reading is a **null result**, not a harm result.
- What the paper *does* establish robustly: context files cost **+20–23% inference tokens** and 2.45–3.92 extra agent steps. And the useful ablation nobody quotes: with all other Markdown deleted from the repo, LLM-generated context files then *improve* performance by **+2.7%** — i.e. auto-generated overviews are mostly redundant restatements of docs the agent can already read.
- Human-written repo context: **+4%**.

The ADR built its "quality gating is non-negotiable" argument on an inflated citation. The conclusion is right; the evidence needs replacing (see 2.5).

### 2.3 Finding 1 — "No production coding tool learns from agent sessions" — **FALSE IN 2026**

| Tool | Ships | Code-linked? |
|---|---|---|
| **Claude Code** | Auto memory, **on by default**. `MEMORY.md` index capped at 200 lines / 25KB, topic files read on demand | No |
| **GitHub Copilot** | Copilot Memory — repo-level facts auto-generated from agent/review/CLI activity, with **citations back to supporting code re-validated against the current branch**, 28-day non-use expiry | **Yes** |
| **Google Antigravity** | Knowledge Items — agents both read from and contribute to a persistent knowledge base | Partly |
| **Devin** | DeepWiki auto-generated repo wikis + Playbooks created when instructions repeat | Partly |
| **claude-mem** (OSS) | 46.1K stars. Five lifecycle hooks, PostToolUse records every Read/Edit, SQLite FTS5 + Chroma hybrid | Partly |
| **agentmemory** (OSS) | Apache 2.0, **Node/TypeScript**, 26.6K stars. 4-tier consolidation, BM25 + vector + KG traversal fused with RRF, Ebbinghaus decay, contradiction detection, 12 Claude Code hooks | Partly |

First-mover positioning is gone. The defensible claim that replaces it is narrower and stronger:

> **mnemex would be the only memory anchored to symbols in a call graph, and therefore the only memory that can know when it has gone stale.**

Copilot validates against the branch but is cloud-only with opaque retrieval. Claude Code's auto memory has zero code linkage. Nobody has symbol-anchored self-invalidation.

### 2.4 Finding 5 — Hebbian co-access — **HALF SUPPORTED**

HeLa-Mem ([2604.16839](https://arxiv.org/abs/2604.16839), ACL 2026) is the same mechanism with a real ablation, and it splits:

- **Spreading activation: supported.** Removing it costs −2.16 (multi-hop), −1.87 (temporal), −1.74 (open), −1.70 (single) F1.
- **The forgetting half: contradicted** (see 2.1).
- Published constants: `w_ij(t+1) = (1−λ)·w_ij(t) + η·𝟙[co-activated]`, λ=0.995, η=0.02; one-hop spread `S(v_j) = S_base(v_j) + β·Σ S_base(v_i)·w_ij`, β=0.1.

Independent support that co-access is non-redundant with embeddings: PAM ([2602.11322](https://arxiv.org/abs/2602.11322)) measured cross-boundary Recall@20 of **0.421 for a co-occurrence predictor vs 0.000 for cosine similarity**, with a temporal-shuffle control collapsing it to 0.044 (−90%) — proving the signal is learned temporal structure, not embedding geometry. But PAM's world is synthetic, and the documented small-corpus failure modes (Matthew effect, ~80% long-tail unique queries, cold start immediately post-refactor) are exactly our operating conditions.

**Verdict: build it dark, behind a flag, and reproduce PAM's shuffle control on our own logs before enabling.** If shuffled co-access performs the same as real co-access, delete it.

### 2.5 The real evidence for quality gating

Stronger than what ADR-004 cited, and it points at a specific fix.

**SkillsBench** ([2602.12670](https://arxiv.org/abs/2602.12670)) — paired no-Skills / curated-Skills / self-generated-Skills conditions with deterministic verifiers, 7,308 trajectories:

| Condition | Δ vs baseline |
|---|---|
| Human-curated | **+16.6pp** (all 18 configs positive) |
| Self-generated, Claude Code + Opus 4.7 | **−8.1pp** |
| Self-generated, Codex + GPT-5.5 | **−11.3pp** |
| Self-generated, Gemini CLI + Gemini 3.1 Pro | **−11.5pp** |

Verbatim: *"models cannot reliably author the procedural knowledge they benefit from consuming."* Software engineering is separately the weakest domain even when curated (+4.5pp).

**Our `observe` tool, as designed, is that self-generation cell.** Diagnosed causes from their trajectory audits: agents never discover their own generated packs; authoring displaces solver effort; content is confidently wrong.

**The variable that flips the sign is verification, not prompt quality:**
- Voyager admitted skills only after successful execution.
- CODESKILL ([2605.25430](https://arxiv.org/html/2605.25430)) gates on rubric × execution-delta × **alignment** ("did the agent actually follow the note?") and is the one self-generated-skill system that beats baseline: SWE-bench Verified **57.33% → 66.00%**. Its maintenance pass halves the bank (1252 → 676 skills) for ~2pp.

**And a cheap fix with a startling effect size.** *Honest Lying* ([2605.29463](https://arxiv.org/html/2605.29463)): reflective agents confabulate. In frozen ALFWorld environments, **0 of 121 self-reflections identified the correct cause**; two environments solvable in 1 trial with no memory took 7–8 trials *with* memory (RRR ↔ trials-to-solve, r=0.808, p<0.0001). Root cause: binary pass/fail feedback carries too little causal information, so the model fabricates a plausible one. Mitigation: replace open-ended self-diagnosis with **parsed trajectory signals** — the actual failing assertion, the actual error type. Correct-cause identification **0% → 86%**, RRR 0.64 → 0.10.

We have privileged access to exactly those artifacts.

---

## 3. The positive case: what a memory layer that works looks like

The null results and the one big positive result reconcile cleanly, and the reconciliation is the design spec.

| | Null / negative results | **MemCoder** ([2603.13258](https://arxiv.org/abs/2603.13258)) |
|---|---|---|
| Stored unit | raw trajectories, free-text session notes | structured sextuple: `{keywords, problem, root_cause, solution}` |
| Anchoring | none | commit SHA |
| Cold start | empty, accumulates slowly | **mined from the repo's own git history** |
| Retrieval | embedding top-k | ANN → **cross-encoder rerank** |
| Leakage control | — | strict: only experiences predating the test issue |
| Result | 0 to −4pp | **+9.4pp** (DeepSeek-V3.2 68.4% → 77.8%); GPT-5.2 74.4% → 78.8% |

Supporting null results: CTIM-Rover ([2505.23422](https://arxiv.org/abs/2505.23422)) — unstructured cross-task episodic memory, minimal-to-negative on SWE-bench Verified. MemGym SWE-Gym track ([2605.20833](https://arxiv.org/html/2605.20833v1)) — Δ 0.0 / −1.0 / −3.2 by model. SWE-ContextBench ([2602.08316](https://arxiv.org/html/2602.08316v3)) — agent-chosen prior context **±0 at +27% cost**, agent-chosen summaries **−4.04pp**, *oracle*-selected summaries **+8.08pp**.

**The bottleneck is retrieval precision, not capture.** Same corpus, +8pp with oracle selection and −4pp with agent selection.

Also worth adopting: ReasoningBank ([Google](https://research.google/blog/reasoningbank-enabling-agents-to-learn-from-experience/)) extracts from **failures as well as successes** (46.5% success-only → 49.7% with failures) and shows more retrieved memories *hurt* (49.7% at k=1 → 44.4% at k=4).

---

## 4. Ranked recommendations

Ordered by expected gain ÷ implementation cost. Tier 1 is retrieval-layer work that pays off whether or not we ever build Layer 2.

### Tier 1 — retrieval layer (cheap, evidenced, independent of the memory question)

**1. Replace the LLM query-intent router with a TF-IDF + linear SVM classifier.**
RAGRouter-Bench ([2604.03455](https://arxiv.org/abs/2604.03455)): TF-IDF+SVM hits **0.928 macro-F1 / 93.2% accuracy**, capturing 79% of oracle-routing token savings, with zero model calls. Our LLM router costs 300ms–2s per query and consumes the entire latency budget. No published head-to-head shows an LLM router beating a classifier, and routing ablations show routing buys *cost*, not quality.
*Frees the budget for item 7.*

**2. Replace uniform-k RRF with TM2C2-normalized convex combination.**
Bruch, Gai & Ingber, TOIS 2023 ([2210.11934](https://arxiv.org/abs/2210.11934)) — still the uncontested reference ablation. `f = α·φ(f_sem) + (1−α)·φ(f_lex)` with theoretical min-max normalization beat RRF on **all nine** datasets: MS MARCO 0.454 vs 0.425, NQ 0.542 vs 0.514, HotpotQA 0.699 vs 0.675 NDCG@1000. One parameter instead of two-per-retriever, and tuned RRF k values are documented not to generalize out-of-domain. The gain is in **ordering, not recall** — exactly what matters when an agent reads the top 5–10.
*~50 LOC. Requires a labeled query set, which items 4 and 7 need anyway.*

**3. Deterministic freshness resolution.**
*Don't Ask the LLM to Track Freshness* ([2606.01435](https://arxiv.org/abs/2606.01435)): LLM identifies candidate facts, then plain `argmax(serial)` in code picks the winner. FactConsolidation single-hop **67.2% → 78.0% (+10.8pp)**, and the gap *widens* with context (at 262K: 61% → 82%, +21pp). Cost: ~50 lines, $0.0001/query.
For us the operator is `argmax(commit_ordinal)` over duplicate symbol facts. "What is the current definition of this symbol?" is precisely the "what is X currently?" question where this wins cleanly.

**4. Per-query IDF-derived fusion weights.**
vstash ([2604.15484](https://arxiv.org/abs/2604.15484)): derive fusion weights from mean IDF of query terms — rare identifiers boost BM25, prose boosts vector — plus a relaxed distance cutoff for long queries. +0.1% to +3.4% typical, **+21.4%** on the outlier query class. No model call.
Same paper's warning worth heeding: on their 786-chunk corpus, **hybrid RRF was worse than vector-only** (NDCG@10 0.803 vs 0.832). Hybrid is not free at small scale.

**5. Query-seeded Personalized PageRank.**
HippoRAG 2 ([2502.14802](https://arxiv.org/abs/2502.14802), ICML 2025). Its contribution is not PageRank — we have that — it is *where the walk is seeded*. Ours is global and computed at index time, so "important" means important-in-the-repo, not important-for-this-question. Seed the personalization vector from the top-k hybrid hits and importance becomes contextual.
Expected shape of the gain, stated honestly: concentrated on multi-hop (2Wiki recall@5 **+13.9**) and near-zero on single-hop lookups (HotpotQA F1 +0.2). GraphRAG-Bench ([2506.05690](https://arxiv.org/abs/2506.05690), ICLR 2026) independently finds basic RAG **beats** graph methods on simple fact retrieval and loses by +10 to +13 on complex reasoning. So this should be routed to, not applied universally.
Reset probability optimum in the paper: **0.05**. PPR over a ~40K-node graph, 20 power iterations on sparse CSR, is single-digit ms — but it moves PageRank from index-time to query-time.

**6. Fix the observation drop, then decide.**
`src/retrieval/backends/semantic.ts:61-64` returns `null` for every `session_observation`, so the new pipeline discards the memory layer entirely while the legacy `store.ts` path surfaces it at type weight 0.2. Whichever way we go, this inconsistency must be resolved deliberately — right now which path a caller takes silently determines whether memory exists.

**7. Small cross-encoder rerank over top-20, gated behind an eval.**
Independent 8-model benchmark: a **149M** ModernBERT cross-encoder matches a 1.2B model at 83.0% Hit@1 (+20.3pp over no rerank); jina-reranker-v3 at 81.33% Hit@1 / 188ms. LLM-style rerankers are dominated on both axes. Code-specific ([2607.05443](https://arxiv.org/abs/2607.05443)): Hybrid-Rerank MRR@10 .528 vs Hybrid-RRF .487.
**Gate it:** vstash measured cross-encoder reranking at **−0.3% to −3.1% NDCG** on their local-first corpus. And on CPU it only fits a 500ms budget if it is the *only* model call in the path — which is why item 1 comes first.

### Tier 2 — memory layer, if we build it

**8. Rebuild the observation schema on MemCoder's shape.**
Not free text. `{keywords, problem, root_cause, solution, symbol_anchors[], commit_sha, provenance}`. Embed `keywords ⊕ problem`. Retrieve ANN → cross-encoder rerank. Validate anchors against the current tree on every recall.

**9. Cold-start from git history.**
This is what produced MemCoder's +9.4pp, and it inverts the cold-start problem ADR-004 lists as a risk. We already parse the repo and have the hook.

**10. Commit-anchored bi-temporal validity + a derived/observed split.**
Take Graphiti's schema, not its LLM. Four columns; facts are superseded, never deleted. Then split what we currently treat identically:

| Class | Types | Rule |
|---|---|---|
| **Derived** | `file_summary`, `symbol_summary`, `idiom`, `usage_example`, `anti_pattern` | Re-derivable → source changes, auto-invalidate + re-enrich |
| **Observed** | `session_observation`, `project_doc` | Not re-derivable → flag stale, **never** auto-delete |

**This is the moat.** STALE ([2605.06527](https://arxiv.org/abs/2605.06527)) measures whether a model knows its own memories have gone invalid: best frontier model **55.2%**. It is hard because for conversation it needs commonsense inference. For a codebase it needs a `git diff`. Note the cautionary data point: Graphiti/Zep, which *has* bi-temporal infrastructure, scores **7%** on FactConsolidation — the schema alone buys nothing; the invalidation decision is what matters, and ours is deterministic.

**11. Post-commit curation, grounded in parsed artifacts.**
Letta's sleep-time compute ([2504.13171](https://arxiv.org/abs/2504.13171)): ~5× test-time compute reduction, +13–18% accuracy, with efficacy gated on **query predictability** — which is high in a codebase, since the next session's questions are about what just changed. Our post-commit hook is the natural idle boundary.
Follow Letta's inversion: **the curator holds the write tools, the interactive agent does not.** And follow *Honest Lying*: feed it the failing assertion, the error type, the fixing diff — never "summarize what you learned."

**12. Deduplicate, never summarize.**
Microsoft's calibrated thresholds (derived from within-session similarity distributions, not guessed): near-dedup **0.559**, cluster distance 0.404, interference 0.542. Dedup-only → **97.2% retention precision, 58% store reduction**. Aggressive consolidation with summarization → **48.4%** accuracy. Verbatim: merging into cluster summaries *"destroys the specific details needed for factual question answering."*
Sobering companion finding: **no consolidation configuration beat the raw-RAG baseline on accuracy** (78.4% raw vs 76.8% best consolidated, CIs overlapping). The architecture is *"statistically non-destructive"* — a storage trade at parity, not a quality gain.

**13. ACE's bullet data model for the store.**
Stable id, content, **helpful/harmful counters**, delta-only updates, embedding dedup ([2510.04618](https://arxiv.org/abs/2510.04618), ICLR 2026). Solves context collapse and brevity bias, and gives a demotion path that doesn't require declaring a note wrong — only that it stopped helping. Add Memp's `deprecate` as a first-class operation and CODESKILL's add/merge/drop maintenance.

**14. Cap what gets injected.** SkillsBench: 1 skill +18.0pp, 2–3 skills +19.0pp, **≥4 skills only +10.1pp**. ReasoningBank: k=1 49.7% → k=4 44.4%. Two or three notes per task, maximum.

### Tier 3 — behind a flag, with a control

**15. Hebbian co-access + one-hop spreading activation.** HeLa-Mem constants, initialized from the ground-truth call graph rather than zero (a better starting point than the paper had). Validation-gate the updates: strengthen `w_ij` only when two chunks are co-retrieved **and** the session subsequently edited one of them. Decay on file rewrite, not on wall-clock. Ship dark; reproduce PAM's temporal-shuffle control before enabling.

### Do not build

| Item | Why |
|---|---|
| **ACT-R / time decay in the ranking score** | 5 of 5 isolating ablations neutral-to-negative; recency AUC 0.51 on a software corpus. ADR-004 Phase 1. |
| **LLM-extracted knowledge graphs** | Mem0 **deleted** graph memory from OSS (April 2026) after measuring it at ~2%. Independent study: Cognee and Zep need 116.5s / 155.1s construction for their utility. We get a more accurate graph from tree-sitter for free. |
| **RAPTOR / GraphRAG communities / LightRAG** | LLM call per cluster over 40K chunks, redone on churn. RAPTOR's own ablation shows the collapsed tree beats traversal — you pay tree-construction cost for a flat index. |
| **ColBERT / PLAID late interaction** | 10–30× index storage; beaten by a tuned small dense model in the one local-scale comparison. |
| **LLM reranking on every query** | 1–4s for a job a 149M cross-encoder does in 188ms. The documented gain belongs to reranker *models*, not LLM calls. |
| **Per-source RRF k tuning** | Universally recommended, zero controlled evidence. Bruch's non-generalization finding argues against. |
| **Summarizing consolidation** | 48.4%. |
| **Ungated `observe` → memory** | The measured-negative cell. |
| **Chasing resolve-rate claims** | Coherence Collapse ([2603.24631](https://arxiv.org/abs/2603.24631), 16,758 trajectories): **60–69% of capable-model failures already reach and edit the correct functions.** Retrieval cannot fix bad edits. |
| **Any LoCoMo number** | 6.4% of the answer key is wrong (99/1540 errors), theoretical max ~93.6%, the standard judge accepts **62.81% of deliberately wrong answers**, and full-context beats every memory system on it. Vendor claims have been publicly revised by 15–26 points. |

### Operational risk

**The `mnemex rg` shim is degraded.** Claude Code 2.1.117 (April 2026) removed the Grep and Glob tools on native macOS and Linux builds, replacing them with embedded `ugrep` and `bfs` invoked through Bash ([SDK #301](https://github.com/anthropics/claude-agent-sdk-typescript/issues/301), [claude-code#51921](https://github.com/anthropics/claude-code/issues/51921)). Interception is now unreliable on the most common platform and structurally adversarial to the vendor roadmap.

The validated alternative is the two-tool MCP surface the winning ablation used: `codebase_search` (NL query + strategy: vector|lexical|graph|hybrid → ranked results with path, snippet, score, **and which index produced it**) and `codebase_graph` (symbol → callers/callees grouped by direction, with hop distance). That is also an argument for collapsing our five-backend router.

---

## 5. Measurement

Nothing above should ship as a claim without this. The field is littered with vendor numbers on a broken benchmark.

**Split the hypothesis.** H-index (the structural index helps) has a strong prior and is cheap to confirm. H-memory (accumulated observations help *beyond* the index) has a weak-to-negative prior and must be tested **on top of an index baseline**, not a bare agent.

**Conditions**, paired within-task:

| | Condition | Purpose |
|---|---|---|
| C0 | index, no memory | control |
| C1 | index + memory | treatment |
| C2 | index + raw logs, no consolidation | isolates consolidation |
| C3 | index + hand-written CLAUDE.md at matched tokens | the condition that beat memory in the one pilot |
| **C4** | **C0 given C1's token budget as extra reasoning** | **mandatory** — this control erased the gains of AWM, ASI, and ReasoningBank in [2606.15017](https://arxiv.org/abs/2606.15017) |
| **C5** | **memory harvested from an unrelated repo, same token count** | **placebo.** Nobody runs it. Cheapest, most convincing control available |

**Task set:** ≥120 tasks from real merged PRs with gold tests, ≥6 repos, ≥3 languages. **SWE-bench Pro or SWE-PolyBench Verified or SWE-bench-Live — not Verified**, which OpenAI stopped reporting after auditing 138 problematic tasks (>60% unsolvable as written; 32.67% of successful patches involved solution leakage). Structure as per-repo chronological streams. Git-history scrub with fail-closed validation and a published exclusion ledger; expect to lose ~20%.

**Metrics.** Primary: resolve rate, pre-registered, one metric. Secondary (where signal actually lives): tokens, turns, wall-clock, **$/solved**. Diagnostic: **agent-targeted localization acc@5** — credit a path only when the agent actually read or edited it. That metric moved 44.3% → 84.5% in the reference ablation and is far more sensitive than resolve rate.

**Power.** At n=17 tasks × 3 repeats the minimum detectable effect is ~30pp. **80% power for 10pp needs 120–200 tasks.** More tasks beats more repeats. Paired Wilcoxon on per-instance pass@1; cluster-bootstrap CIs with *repo* as the unit; TOST equivalence testing so a null yields a bounded claim.

**Tenure.** Evaluate at 10, 40, and 100 accumulated sessions. The one longitudinal study found a **rank inversion between week 3 and week 9**. A single-checkpoint result is a claim about a memory system at one age.

**Falsifiers, pre-registered:**
1. C1 does not beat C4 → the memory layer is worth less than spending the tokens on reasoning.
2. **C5 (foreign-repo placebo) is within noise of C1** → the effect is context volume, not memory content. Run this early; it's the killshot.
3. C1 ≈ C2 and C1 ≤ C3 → consolidation and decay are unearned complexity.
4. Localization improves but resolve doesn't → the honest claim becomes an efficiency claim. Still real, still defensible.
5. Staleness/violation rate trends up with tenure → we shipped temporal memory contamination.

**Benchmarks worth adopting:** the [supercoder-eval](https://github.com/TransformerOptimus/supercoder-eval) harness (open, leak-audited, the protocol that measured a real index gain); **CORE-Bench Level 2** ([2606.11864](https://arxiv.org/html/2606.11864)) as the retrieval yardstick — best published model scores **32.8 NDCG@10** on *locating files needing edits*, versus 71.7 on snippet understanding, so repository-state-aware retrieval is wide open; MemGym's memory-isolated paired scoring as the scoring discipline.

---

## 6. Positioning

Three claims the evidence supports, in descending order of defensibility:

1. **Efficiency and localization, locally.** Same-or-better outcomes at ~22% fewer turns, ~28% fewer tokens, ~18% lower cost per solve, ~2× rank-1 localization, with nothing leaving the machine. This is measured, not asserted.
2. **Symbol-anchored, self-invalidating memory.** The one thing markdown memory files structurally cannot do, and the one thing our graph uniquely enables — against a field where the best model scores 55.2% at knowing its own memories are stale.
3. **Multi-file blast radius.** The index's advantage is 46.4pp of localization in the 3+-gold-file bucket and near-zero on single-file tasks. Our `impact` command (transitive callers, BFS) is the most underexploited asset in the codebase.

Claims to retire: "nobody has session-accumulated memory" (false), "semantic code search" as the headline (the graph is the differentiated asset; dense vectors are the commodity layer), and any resolve-rate promise.

Note on Anthropic's position: Boris Cherny's objections to indexing were **security, privacy, staleness, and reliability** — all operational, none epistemic. Anthropic's own written guidance recommends hybrid: *"the most effective agents might employ a hybrid strategy, retrieving some data up front for speed, and pursuing further autonomous exploration at its discretion."* A local-first, incrementally-updated, never-leaves-the-machine index neutralizes all four objections. That is the argument to lead with — not that embeddings beat grep.

---

## 7. Source index

Primary sources are linked inline above. The highest-value reads, in order:

1. [Code Isn't Memory (2606.22417)](https://arxiv.org/abs/2606.22417) — the ablation of our architecture. Read the tables.
2. [Your Code Agent Can Grow Alongside You (2603.13258)](https://arxiv.org/abs/2603.13258) — MemCoder, the memory design that works.
3. [SkillsBench (2602.12670)](https://arxiv.org/abs/2602.12670) — why ungated self-generated memory is negative.
4. [Human-Inspired Memory Architecture (2605.08538)](https://arxiv.org/abs/2605.08538) — the decay and consolidation ablations, on a software corpus.
5. [Don't Ask the LLM to Track Freshness (2606.01435)](https://arxiv.org/abs/2606.01435) — deterministic conflict resolution, 50 lines.
6. [An Analysis of Fusion Functions (2210.11934)](https://arxiv.org/abs/2210.11934) — the fusion ablation that still stands.
7. [Honest Lying (2605.29463)](https://arxiv.org/html/2605.29463) — confabulation, and the parsed-artifact fix.
8. [Are We Ready For An Agent-Native Memory System? (2606.24775)](https://arxiv.org/html/2606.24775) — 12 systems evaluated as data management systems.
