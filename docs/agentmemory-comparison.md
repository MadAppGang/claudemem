# mnemex vs agentmemory — Architecture Comparison

**Date:** 2026-08-06
**Subject:** [rohitg00/agentmemory](https://github.com/rohitg00/agentmemory) @ `d60652a` (v0.9.28, pushed 2026-08-03)
**Compared against:** mnemex `main` @ `461a4b1` (v0.31.2)
**Method:** shallow clone + source read. No runtime execution, no benchmark reproduction.

---

## Verdict

These are not competing implementations of the same thing. Both say "memory for coding
agents," but they store different substances.

- **agentmemory remembers what the agent did.** Tool calls, prompts, errors, session
  narratives, decisions.
- **mnemex remembers what the code is.** AST chunks, symbols, reference edges, PageRank.

The overlap is exactly one layer — the hybrid retrieval engine — and there the two designs
diverge in instructive ways. Each project is strong precisely where the other is a stub.

---

## 1. Raw numbers

| | mnemex | agentmemory |
|---|---|---|
| LOC (`src`) | 122,848 across 395 files | 41,076 across 181 files |
| Stars / forks | 43 / 7 | 26,640 / 2,258 |
| Repo created | 2025-12-12 | 2026-02-25 |
| Open issues | 4 | 424 |
| License | none set | Apache-2.0 |
| MCP tools | 33 | 54 (8 visible by default, `AGENTMEMORY_TOOLS=all` for the rest) |
| REST endpoints | 0 (cloud server aside) | 129 |
| Tests | 55 files (~1,177 tests) | 1,428+ |
| Runtime model | embedded, no daemon | iii-engine daemon `:49134`, server `:3111`, viewer `:3113` |
| Build | Bun | tsdown / Node ≥20 |

### LOC by module

**mnemex**

```
23,678  src/learning        # adaptive ranking, bandit, shadow, federated
18,593  src/benchmark-v2
17,885  src/core            # indexer, store, AST, graph, enrichment
14,415  src/tui
 6,222  src/benchmark
 5,141  src/mcp
 5,111  src/cloud
 3,813  src/llm
 3,228  src/retrieval
 2,825  src/docs
 1,300  src/hooks
   185  src/memory          # <- the entire "memory" subsystem
```

**agentmemory**

```
18,123  src/functions       # ~60 modules: consolidate, decay, evict, lessons, reflect...
 3,760  src/mcp
 3,504  src/cli
 3,501  src/triggers        # REST surface
 1,885  src/state           # BM25 + vector + hybrid + persistence
 1,715  src/providers
 1,250  src/hooks           # 12 lifecycle hooks
   496  src/viewer
```

The shape tells the story. mnemex's weight is in *understanding code* and *learning to rank*.
agentmemory's weight is in *memory lifecycle operations* and *integration surface*.

> The star gap is not an engineering signal. agentmemory is 5 months old with 2,258 forks and
> an 85KB README that name-checks competitor star counts. The code underneath is genuinely
> good. Treat headline benchmark numbers as vendor-published.

---

## 2. The architectural split

### agentmemory has no parser

```bash
grep -ril "tree-sitter\|treesitter\|pagerank\|abstract syntax" src   # returns nothing
```

Their "knowledge graph" is entities and relationships an LLM emits as XML tags, regex-parsed
back out:

```
src/functions/graph.ts:397   const addEntity = (rawAttrs, propsBlock = "") => { ... }
src/functions/graph.ts:426   const relRegex = /<relationship\b([^>]*?)\/>/g;
src/functions/graph.ts:365   // ...silently dropped nodes/edges when the upstream [LLM output was malformed]
```

Their only file awareness is `src/functions/file-index.ts` — a `file path -> observation
history` map. No symbols, no call edges, no structure. Their README's answer to code
understanding is "pair with [codegraph]", which is an admission.

### mnemex has no memory lifecycle

`src/memory/store.ts` is 185 lines total: `key -> markdown file` plus a `memories.json`
index for listing. No decay, no consolidation, no contradiction detection, no eviction, no
TTL, no supersession.

This is exactly the sticky-note model agentmemory's README mocks:

> "Every AI coding agent ships with built-in memory — Claude Code has `MEMORY.md`... These
> work like sticky notes. agentmemory is the searchable database behind the sticky notes."

The criticism lands. mnemex's `observe` MCP tool (`src/mcp/tools/observe.ts`) is the better
path — it embeds observations into the same LanceDB table as code chunks so they surface in
normal search — but it is opt-in and has no lifecycle behind it.

### Deterministic vs probabilistic extraction

This is the fork that explains most downstream differences.

| | mnemex | agentmemory |
|---|---|---|
| Graph source | tree-sitter parse | LLM emits `<entity/>` / `<relationship/>` tags |
| Cost per edge | zero | one LLM call per observation |
| Determinism | total | none |
| Offline | yes | needs a provider |
| Can express | call edges, imports, symbol refs | concepts a parser can't see ("we chose Postgres because of JSONB") |
| Failure mode | parse error, loud | malformed tags silently dropped (their `graph.ts:365`) |

Neither is wrong. They buy different things.

---

## 3. Where they overlap: hybrid retrieval

Both landed on **BM25 + vector + RRF at k=60**, independently, from the same literature. The
details diverge.

### agentmemory — `src/state/hybrid-search.ts`

- **Three streams:** BM25, vector, entity-graph BFS
- Weights `0.4 / 0.6 / 0.3`, **renormalized when a stream returns nothing** (`:197-206`).
  A genuinely good detail — if vector is unavailable, BM25 and graph split the full weight
  rather than the fused score silently shrinking.
- **Session diversification:** max 3 hits per session, backfilled if under limit (`:242-276`)
- Optional cross-encoder rerank on the top 20, gated by `RERANK_ENABLED` (`:228-237`)
- **Query expansion:** original query + reformulations + temporal concretizations, all run in
  parallel, merged by max combined score (`:42-75`)
- Graph stream runs twice: once from query entities, once expanded from the top-5 vector hits
  (`:100-126`). Both wrapped in `try/catch` as best-effort.

### mnemex — `src/core/store.ts:435-503`

- **Two streams:** BM25 via LanceDB FTS, vector via LanceDB `vectorSearch`
- `typeAwareRRFFusion` weights by **document type** (code chunks / symbol summaries / docs)
  with per-use-case weight profiles via `getUseCaseWeights(useCase)`
- LLM reranker — `src/retrieval/reranking/llm-reranker.ts` (313 lines)
- Query router — `src/retrieval/routing/query-router.ts` (386 lines), picks backends per
  query shape
- Backends: semantic, symbol-graph, tree-sitter, LSP, location
  (`src/retrieval/backends/`)
- **23,678 LOC of `src/learning/`**: feedback capture, EMA weight updates, bandit, shadow
  deployment, adversarial validation, federated

**The philosophical difference:** agentmemory diversifies by *source session*; mnemex weights
by *document type and use case*, and learns the weights from feedback. Their fusion is
hand-tuned and static forever. Ours adapts.

---

## 4. The vector index — sharpest technical difference

### agentmemory: brute-force scan of a JS heap Map

`src/state/vector-index.ts:37-77`

```ts
export class VectorIndex {
  private vectors: Map<string, { embedding: Float32Array; sessionId: string }> = new Map();

  search(query: Float32Array, limit = 20) {
    for (const [obsId, entry] of this.vectors) {
      const score = cosineSimilarity(query, entry.embedding);   // O(d) per vector
      ...
    }
  }
}
```

Every query scans every vector, in the Node heap, in JS. Persistence is base64-encoded floats
inside a JSON array (`:124-136`).

Their own `benchmark/SCALE.md` reports the cost honestly:

| Observations | Index build | BM25 | Hybrid | Heap |
|---|---|---|---|---|
| 240 | 177 ms | 0.11 ms | 0.63 ms | 9 MB |
| 1,000 | 155 ms | 0.32 ms | 1.71 ms | 6 MB |
| 5,000 | 810 ms | 1.50 ms | 8.58 ms | 25 MB |
| 10,000 | 1,657 ms | 3.20 ms | 17.49 ms | 1 MB |
| 50,000 | 9,182 ms | 22.83 ms | 108.72 ms | 316 MB |

Linear in corpus size, as expected. All at **d=384** (`all-MiniLM-L6-v2`). Swap in a
1536-dim model and that 316 MB becomes roughly 1.2 GB of live JS heap.

### mnemex: also brute-force, but in Rust and off-heap

There is no `Index.ivfPq`, no HNSW, nothing ANN anywhere in `src`:

```bash
grep -rn "ivf\|IvfPq\|hnsw\|HNSW" src --include='*.ts'   # returns nothing
```

The only index created is full-text:

```
src/core/store.ts:326   await this.table.createIndex("content", {
src/core/store.ts:327     config: lancedb.Index.fts(),
```

**Same asymptotics.** The difference is where the scan runs: LanceDB executes it in Rust over
memory-mapped columnar storage, so it never enters the JS heap and the constants are far
better.

**Honest conclusion: neither project has ANN. This is a shared gap, not a differentiator.**
mnemex's version of the weakness is roughly an order of magnitude less painful in memory
pressure.

### The Buffer-pool bug worth stealing

`src/state/vector-index.ts:1-7` — the most credible thing in their repo:

```
// Pass byteOffset + byteLength explicitly so the round-trip survives
// Node's Buffer pool. Buffer.from(b64, "base64") returns a slice of a
// shared 8KB pool (poolSize), and `new Float32Array(buf.buffer)` ignores
// the slice metadata — it would mint a 2048-element view over the whole
// pool. Same risk on the encode side if the input Float32Array is itself
// a sliced view. Reported as a phantom "2048 dimensions on disk" crash
// in #455 / #469 / #584 / #587.
```

Four issue numbers. That is real production debugging, not README copy.

**Action for mnemex:** audit every place we round-trip `Float32Array` through `Buffer`. Same
class of bug. (Related: the live-index note about a 0-dim vector column.)

They also ship a dimension guard that refuses to load any persisted index containing
wrong-dimension vectors (`vector-index.ts:91-104`), which catches mid-session provider swaps.
mnemex has no equivalent.

---

## 5. Capture: automatic vs opt-in

### agentmemory — 12 lifecycle hooks, always on

| Hook | Captures |
|---|---|
| `SessionStart` | project path, session id; injects recalled context |
| `UserPromptSubmit` | user prompts (privacy-filtered) |
| `PreToolUse` | file access patterns + enriched context |
| `PostToolUse` | tool name, input, output |
| `PostToolUseFailure` | error context |
| `PreCompact` | re-injects memory before compaction |
| `SubagentStart/Stop` | sub-agent lifecycle |
| `Stop` | end-of-session summary |
| `SessionEnd` | session complete marker |

Their `AGENTS.md:94-97` documents a subtle pattern worth reading in full:

- **Context-injecting hooks** (`pre-tool-use`, `pre-compact`, `session-start`) write to stdout,
  so they must `await fetch(..., { signal: AbortSignal.timeout(N) })`.
- **Telemetry-only hooks** write nothing, so they must fire-and-forget **plus**
  `setTimeout(() => process.exit(0), 500).unref()`. Without the forced exit, Node keeps the
  event loop alive waiting for the in-flight fetch and the hook still blocks Claude Code's
  next-prompt boundary for the full timeout — exactly the bug fire-and-forget was meant to fix.

They hit that bug and fixed it. Anyone writing agent hooks should know this.

### mnemex — 4 handlers plus git

`src/hooks/handlers/`: `session-start.ts`, `pre-tool-use.ts`, `post-tool-use.ts`,
`interaction-logger.ts`, plus a git post-commit reindex hook (`src/git/hook-manager.ts`).

`interaction-logger.ts` feeds `src/learning/interaction/`, gated by `CLAUDE_LEARNING !== "off"`.

Observations arrive via the `observe` MCP tool, which the agent must choose to call.
**Automatic capture of code changes, manual capture of insight.**

---

## 6. Memory pipeline (agentmemory only)

There is no mnemex counterpart to this. Reproduced from their README for reference:

```
PostToolUse hook fires
  -> SHA-256 dedup (5min window)
  -> Privacy filter (strip secrets, API keys)
  -> Store raw observation
  -> LLM compress -> structured facts + concepts + narrative
  -> Vector embedding (6 providers + local)
  -> Index in BM25 + vector

Stop / SessionEnd hook fires
  -> Summarize session
  -> Knowledge graph extraction (GRAPH_EXTRACTION_ENABLED)
  -> Slot reflection (SLOT_REFLECT_ENABLED)

SessionStart hook fires
  -> Load project profile (top concepts, files, patterns)
  -> Hybrid search
  -> Token budget (default 2000 tokens)
  -> Inject into conversation
```

### 4-tier consolidation

| Tier | What | Analogy |
|---|---|---|
| Working | raw observations from tool use | short-term memory |
| Episodic | compressed session summaries | "what happened" |
| Semantic | extracted facts and patterns | "what I know" |
| Procedural | workflows and decision patterns | "how to do it" |

Backed by Ebbinghaus-curve decay, access-strengthening, auto-eviction, and contradiction
resolution. Implemented across ~60 modules in `src/functions/`, notably:

```
360  evict.ts        412  retention.ts     345  observe.ts
309  lessons.ts      477  reflect.ts       398  summarize.ts
     consolidate.ts       crystallize.ts        auto-forget.ts
     dedup.ts             cascade.ts            sliding-window.ts
```

---

## 7. Dependency posture

### agentmemory: a worker on someone else's engine

Everything routes through `iii-sdk` primitives — `registerFunction` / `registerTrigger` /
`sdk.trigger()`. Their `AGENTS.md:5` is explicit: *"never bypass iii-engine with standalone
SQLite or in-process alternatives."*

They pin **iii-engine v0.11.2** and refuse to attach to any other version, because "the worker
can't speak another engine's protocol." If you already run your own iii, you must stop it.

**The upside is real:** `iii worker add <name>` gets them pubsub (multi-instance memory),
cron (nightly consolidation), queue (durable embedding retries), OTEL observability, microVM
sandbox, and a SQL state adapter — with no integration work. Their README frames iii as
replacing Express, Postgres+pgvector, Socket.io, pm2, and Prometheus all at once.

**The downside is also real:** the entire product is downstream of one upstream project's
release cadence and protocol stability.

### mnemex: embedded, no daemon

LanceDB + better-sqlite3 as native modules, tree-sitter grammars downloaded at build. No
runtime service, no ports, no version pinning against a third-party engine. The cost is
install friction — a fresh checkout needs `install` + `download-grammars` + `build` or the
test suite reports misleading results.

---

## 8. Benchmarks

### agentmemory

**LongMemEval-S** (ICLR 2025, 500 questions, ~48 sessions each):

| System | R@5 | R@10 | MRR |
|---|---|---|---|
| agentmemory | 95.2% | 98.6% | 88.2% |
| BM25-only fallback | 86.2% | 94.6% | 71.5% |

Embeddings: `all-MiniLM-L6-v2`, local, no API key.

**coding-agent-life-v1** (in-house, 15 sessions):

| Adapter | P@5 | R@5 | Top-5 hit | p50 |
|---|---|---|---|---|
| agentmemory hybrid | 0.240 | 1.000 | 15/15 | 14 ms |
| grep baseline | 0.227 | 0.967 | 15/15 | 0 ms |

They label this honestly: the lift is recall + temporal, not aggregate precision, and P@5 is
at the corpus math ceiling.

Their `benchmark/COMPARISON.md` carries an explicit apples-vs-oranges caveat noting that only
their own number is reproducible and that Letta/Mem0 publish on LoCoMo, not LongMemEval. That
is better epistemics than most vendor comparison pages.

### mnemex

`src/benchmark` (6,222 LOC) + `src/benchmark-v2` (18,593 LOC), plus `eval/` and the sibling
AgentBench harness. Embedding-model benchmark in the README.

**Gap:** no number on a public standard dataset. Every mnemex figure is in-house. agentmemory
has one reproducible public-dataset number, and that changes the conversation regardless of
whether the benchmark suits code retrieval.

---

## 9. Advantages

### mnemex

- **Structural code understanding.** Symbols, callers, callees, PageRank, dead-code detection,
  test-gap analysis, impact analysis. agentmemory cannot answer "what breaks if I change this."
- **Storage that scales without eating the heap.** LanceDB is the right substrate.
- **Adaptive ranking.** 23.7K LOC of learning infrastructure. Our weights improve; theirs never
  will.
- **Zero runtime dependencies.** No daemon, no pinned engine, no ports.
- **Deterministic graph.** Free, offline, reproducible, no LLM in the loop.
- **Broader tool surface per concept:** LSP integration, TUI, pack/export, doc indexing,
  autocomplete server, `rg` grep replacement.

### agentmemory

- **A memory lifecycle that exists.** Decay, 4-tier consolidation, eviction, supersession,
  contradiction detection, TTL, crystallization. mnemex has none of this.
- **Automatic capture across 12 hooks.** Zero agent discipline required.
- **Published reproducible benchmark on a public dataset**, with an honest caveat section.
- **Observability:** real-time viewer on `:3113`, audit trail on every mutation, health
  monitoring, circuit breaker, provider fallback chain.
- **Privacy filter** stripping API keys and secrets before storage.
- **Distribution.** `npm i -g`, `agentmemory connect claude-code`, done. Wired for 8+ agents
  with native plugins.
- **Multi-agent coordination:** leases, signals, mesh, team namespacing, `AGENT_ID` scoping.
- **Language-agnostic access** via 129 REST endpoints (Python/Rust/Node all work).

---

## 10. Disadvantages

### mnemex

- **The memory story is a stub.** Flat key-value markdown with no lifecycle. If the pitch is
  "code memory," the memory half is thin.
- **No ANN index.** Fine now, a wall later.
- **No REST surface, no viewer, no audit trail.** Hard to see what it knows or why it ranked
  something.
- **Native module install pain.** LanceDB, better-sqlite3, downloaded grammars. A fresh
  checkout lies about test results if the setup order is wrong.
- **No license set** on the repo.
- **122K LOC against 55 test files.** Their ratio is much better.
- **Observations require opt-in.** The agent has to remember to remember.
- **No dimension guard** on persisted vectors.

### agentmemory

- **Hard-pinned to iii-engine v0.11.2**, refuses other versions. The whole product is a worker
  on someone else's engine.
- **Requires a running daemon plus three ports.** mnemex's CLI just runs.
- **Vector search is a JS heap scan.** Will not survive a large corpus at modern embedding
  dimensions.
- **No code understanding at all.** Their answer is to pair with a separate code-graph tool.
- **54 MCP tools + 129 REST endpoints is a huge maintenance surface.** Their `AGENTS.md` has an
  8-item checklist to add one tool and a 7-item checklist to bump a version. That is a smell.
- **Graph quality depends on an LLM emitting well-formed XML**, with silent drops on malformed
  output.
- **424 open issues.**
- **Windows is second-class** (WSL2 fast path; `agentmemory connect` unsupported natively).

---

## 11. What's worth taking

> ⚠️ **Partly superseded.** This ranking was made from a source read, before the memory
> literature was checked. Items 1, 4 and 8 are contradicted by evidence; items 2, 3, 5, 7
> stand; item 6 has since shipped. See [§13](#13-evidence-update-2026-08-06).

Ranked by value per unit of effort.

1. **Memory lifecycle.** `src/memory/store.ts` needs decay and eviction at minimum. Their
   tiering frame (working -> episodic -> semantic -> procedural) is reasonable, and
   `src/functions/evict.ts` (360 lines) and `retention.ts` (412) are readable starting points.
2. **Source diversification in fusion.** `hybrid-search.ts:242-276` is ~30 lines. Our
   type-aware fusion can over-concentrate on one file; capping hits per source is cheap
   insurance against a single hot file monopolizing top-K.
3. **Weight renormalization when a stream is empty.** `hybrid-search.ts:197-206`. If BM25
   returns nothing, our RRF still divides by the full weight sum and the fused score silently
   shrinks. Small correctness win.
4. **Run LongMemEval-S.** Their `eval/README.md` claims an adapter-pluggable harness. Dropping
   a mnemex adapter in would produce the only apples-to-apples number either project has.
5. **Audit `Float32Array` <-> `Buffer` round-trips** for the Node Buffer-pool slice bug
   (`vector-index.ts:1-7`).
6. **Dimension guard on index load** (`vector-index.ts:91-104`) — refuse to load an index whose
   vectors don't match the configured provider's dimension.
7. **Privacy filter before storage.** We index source; they strip secrets. Worth having.
8. **Automatic observation capture.** A PostToolUse hook that captures failures at minimum
   would cost little and remove the opt-in gap.

### What not to take

- The iii-engine coupling
- The 129-endpoint REST surface
- The in-heap vector index
- The README length

---

## 12. Not verified

- **LongMemEval-S 95.2% R@5.** Reproducing needs the dataset and an eval run. Their harness
  claims to be adapter-pluggable, so a side-by-side is feasible but was not attempted here.
- **Their 1,428 test count and 260+ iii function count.** Taken from `AGENTS.md`, not counted.
- **Runtime behavior of either system.** This was a source read only. No indexing run, no
  query latency measured, no memory profiling.
- **Fork/star provenance.** 2,258 forks in 5 months is unusual; not investigated.

---

## 13. Evidence update (2026-08-06)

Everything above §12 is a source read of two codebases. It establishes what each project
*does*, and it is accurate. It does not establish what *works* — and once the 2025–2026
memory literature is checked, several of its conclusions invert.

Full evidence base: [`agentic-memory-research-2026.md`](agentic-memory-research-2026.md) and
[ADR-005](adr/005-retrieval-first-memory.md) — ~110 primary sources.

### 13.1 The comparison's framing needs one correction

This document repeatedly treats "agentmemory has a memory lifecycle, mnemex has none" as a
deficit on our side. The evidence does not support reading it that way.

**No published result shows an accumulated agent-memory layer improving software-engineering
task success.** The closest controlled tests:

| Study | Condition | Δ resolve rate |
|---|---|---|
| MemGym, SWE-Gym track ([2605.20833](https://arxiv.org/html/2605.20833v1)) | memory vs none, Sonnet 4.5 | **0.0** |
| MemGym, Haiku 4.5 / GPT-OSS-120B | same | **−1.0 / −3.2** |
| SWE-ContextBench ([2602.08316](https://arxiv.org/html/2602.08316v3)) | agent-retrieved prior context | **±0**, at +27% cost |
| SWE-ContextBench | agent-written summaries | **−4.04pp** |
| SWE-ContextBench | *oracle*-selected summaries | +8.08pp |
| CTIM-Rover ([2505.23422](https://arxiv.org/abs/2505.23422)) | unstructured cross-task episodic memory | minimal to **negative** |
| Microsoft ([2605.08538](https://arxiv.org/abs/2605.08538)) | best consolidation config vs raw RAG | **76.8% vs 78.4%** (CIs overlap) |

Meanwhile the thing agentmemory has *none* of — a structural code index — is the one component
with a clean positive result. *Code Isn't Memory* ([2606.22417](https://arxiv.org/abs/2606.22417))
ablated an architecture near-identical to mnemex Layer 1 (tree-sitter AST, symbol and call
graph, BM25 + vector), model held fixed, 3 seeds, 91 instances, leak-audited:

- resolve **41.9% → 50.4%** (+7.9pp, paired Wilcoxon p=0.003)
- localization acc@5 **44.3% → 84.5%** (p<0.0001)
- turns 36.2 → 28.3, **$2.84 → $2.30 per solve**
- multi-file tasks (3+ gold files): acc@5 **91.3 vs 44.9**

So the honest reading of §2's "architectural split" is not that each project is strong where
the other is a stub. It is that **mnemex is strong where the measured effect is, and
agentmemory is elaborate where the measured effect is not.** Their 18,123 LOC of
`src/functions/` lifecycle machinery is the least-evidenced part of either codebase.

### 13.2 One factual correction to §3 and §9

§3 says *"Their fusion is hand-tuned and static forever. Ours adapts."* §9 repeats it as
*"Our weights improve; theirs never will."*

**This is not true in practice.** `src/learning/` (23,678 LOC, 55 files) is reachable only
through a CLI `learn` feedback command. The MCP server never imports it, so nothing an agent
session does feeds it. Adaptive ranking is built, not wired. As shipped, our fusion weights
are as static as theirs — we just have far more code not adapting them.

Related, and in the same spirit: `src/retrieval/backends/semantic.ts:61-64` returns `null` for
every `session_observation`, so the newer retrieval pipeline discards the memory layer
entirely while the legacy `store.ts` path surfaces it at type weight 0.2. §5's "manual capture
of insight" undersells the problem — capture is opt-in *and* the read path is broken on one of
two live code paths.

### 13.3 Revised: what's worth taking

**Contradicted — do not take:**

| § 11 item | Why it's out |
|---|---|
| **#1 Memory lifecycle: decay + eviction, 4-tier consolidation** | Split this. **Decay in the ranking score is contradicted by 5 of 5 isolating ablations** — including Microsoft measuring recency at **AUC 0.51 (chance)** as a relevance predictor on a *software issue* corpus, HeLa-Mem finding that *removing* forgetting improved all four categories, and vstash measuring decay reranking at −0.3% to −3.1% NDCG. Decay as **eviction/GC only** is fine and is worth having (Microsoft: 97.2% retention precision, 58% store reduction) — but measure store size, never nDCG. Their 4-tier consolidation is the weakest part: summarizing consolidation scored **48.4%** vs a 78.4% raw baseline, because merging into cluster summaries destroys the details factual questions need. **Deduplicate, never summarize.** |
| **#4 Run LongMemEval-S** | Wrong benchmark. It is conversational, not code; the S split is near-saturated (vendors self-report 93–95%); and every high score is self-reported. Chasing it optimizes for the thing agentmemory is already good at and mnemex has no reason to be. Use **supercoder-eval** ([the harness from 2606.22417](https://github.com/TransformerOptimus/supercoder-eval)) — open, leak-audited, and the only protocol that measured a statistically separated index gain — plus **CORE-Bench Level 2** ([2606.11864](https://arxiv.org/html/2606.11864)) for retrieval, where the best published model scores **32.8 NDCG@10** on *locating files needing edits* versus 71.7 on snippet understanding. That gap is the headroom, and it is graph-shaped. |
| **#8 Automatic observation capture via PostToolUse** | This is the configuration that measures **negative**. SkillsBench ([2602.12670](https://arxiv.org/abs/2602.12670)), paired conditions with deterministic verifiers over 7,308 trajectories: human-curated skills **+16.6pp**; self-generated skills **−8.1pp** (Claude Code + Opus 4.7), **−11.3pp** (Codex), **−11.5pp** (Gemini CLI). Verbatim: *"models cannot reliably author the procedural knowledge they benefit from consuming."* Copying agentmemory's always-on capture without a gate imports their least-defensible design decision. |

**Stand, and get stronger:**

- **#2 source diversification** (`hybrid-search.ts:242-276`) — ~30 lines, still cheap insurance.
- **#3 weight renormalization on empty streams** (`hybrid-search.ts:197-206`) — small correctness win, still real. Note it becomes moot if we move off RRF entirely (see 13.4).
- **#5 `Float32Array` ↔ `Buffer` audit** — still open.
- **#7 privacy filter before storage** — upgraded from "nice to have" to **required**. OWASP added *Memory and Context Poisoning* as **ASI06** in its 2026 Agentic AI Top 10, prescribing memory sanitization **with provenance**. A poisoning study seeded 110 records (10 poisoned, <10% of store) into MetaGPT's DataInterpreter and saw **23 of 48 retrievals (47.9%) return poisoned entries**. The realistic vector for us is not an attacker — it is a note derived from a stale API doc or a compromised dependency's README, written once into a `.mnemex/` that gets committed and shared.

**Already shipped:**

- **#6 dimension guard** — done. `assertVectorDimension()` in `src/core/store.ts` now rejects
  empty embeddings at all three write paths, after we hit the same class of bug from the other
  direction: LanceDB infers schema from the first batch, so an empty embedding creates a
  permanently unqueryable `FixedSizeList[0]` column with no repair short of
  `mnemex index --force`. See CLAUDE.md gotcha 15 and `docs/lancedb-0.33-migration-research.md`.

**New, and higher-value than anything in the original list** — none of these come from
agentmemory, which is the point:

1. **Replace the LLM query-intent router with a TF-IDF + linear SVM classifier.**
   RAGRouter-Bench ([2604.03455](https://arxiv.org/abs/2604.03455)): **0.928 macro-F1**, 79% of
   oracle token savings, zero model calls. Removes 300ms–2s from the hot path.
2. **Replace uniform-k RRF with TM2C2-normalized convex fusion.** Bruch et al. TOIS 2023
   ([2210.11934](https://arxiv.org/abs/2210.11934)) beat RRF on **all nine** datasets. One
   parameter instead of two-per-retriever; tuned RRF k is documented not to generalize.
   Both projects independently landed on RRF k=60 from the same literature — and both are
   using the weaker option.
3. **Deterministic freshness: `argmax(commit_ordinal)`.**
   ([2606.01435](https://arxiv.org/abs/2606.01435)) **+10.8pp**, widening to **+21pp** at long
   context, for ~50 lines. LLM identifies candidates; plain `max()` picks the winner.
4. **Query-seeded Personalized PageRank.** HippoRAG 2 ([2502.14802](https://arxiv.org/abs/2502.14802)).
   Our PageRank is global and index-time, so "important" means important-in-the-repo, not
   important-for-this-question. Seeding the personalization vector from the top-k hybrid hits
   is a change to one input. agentmemory cannot do this at all — they have no parsed graph.

### 13.4 If we build a memory layer, it looks nothing like theirs

The one strongly positive memory result is MemCoder ([2603.13258](https://arxiv.org/abs/2603.13258)):
DeepSeek-V3.2 **68.4% → 77.8%** on SWE-bench Verified (+9.4pp). What separates it from every
null result is schema and retrieval discipline, not whether sessions get stored:

| | agentmemory / the null results | MemCoder |
|---|---|---|
| Stored unit | raw observations, session narratives | structured `{keywords, problem, root_cause, solution}` |
| Anchoring | file-path → observation history | commit SHA + symbol |
| Cold start | empty, accumulates from live sessions | **mined from the repo's own git history** |
| Retrieval | hybrid top-k | ANN → **cross-encoder rerank** |
| Leakage control | none | strict: only experiences predating the issue |

Three write-path rules, each from a measured failure:

- **Extract from parsed artifacts, never introspection.** *Honest Lying*
  ([2605.29463](https://arxiv.org/html/2605.29463)): in frozen environments **0 of 121
  self-reflections identified the correct cause**, and two environments solvable in 1 trial
  with no memory took 7–8 trials *with* memory. Feeding the model the actual failing assertion
  and error type instead moved correct-cause identification **0% → 86%**. agentmemory's
  "LLM compress → structured facts + concepts + narrative" step is exactly the introspection
  pattern this result warns about.
- **Verification gates persistence.** CODESKILL ([2605.25430](https://arxiv.org/html/2605.25430))
  gates on rubric × execution-delta × alignment and is the one self-generated-skill system
  that beats baseline (SWE-bench Verified **57.33% → 66.00%**). Its maintenance pass halves
  the bank for ~2pp.
- **Cap injection at 2–3 notes.** SkillsBench: 1 skill +18.0pp, 2–3 +19.0pp, **≥4 only
  +10.1pp**. ReasoningBank: k=1 49.7% → k=4 44.4%.

**And the differentiator neither project has built: staleness.** STALE
([2605.06527](https://arxiv.org/abs/2605.06527)) measures whether a system knows its own
memories have gone invalid — best frontier model **55.2%**, because for conversation it needs
commonsense inference. For a codebase it needs a `git diff`. Note the cautionary data point:
Graphiti/Zep *has* bi-temporal infrastructure and scores **7%** on FactConsolidation — the
schema alone buys nothing; the invalidation decision is what matters, and ours can be
deterministic.

This is the claim that replaces "agentmemory has a lifecycle and we don't":

> mnemex would be the only memory anchored to symbols in a call graph, and therefore the only
> memory that knows when it has gone stale.

### 13.5 Forward plan

Sequenced in [ADR-005](adr/005-retrieval-first-memory.md), which supersedes
[ADR-004](adr/004-cognitive-codebase-memory.md). Summary:

- **D1 — retrieval layer first, unconditionally.** Seven contained changes, each with an
  isolating ablation behind it. Independent of the memory question; item 1 alone removes an
  LLM call from the hot path and makes a cross-encoder reranker affordable.
- **D2 — the memory layer is gated on a measurement, not shipped on faith.** The gate is the
  **placebo control**: memory harvested from an *unrelated repository* at matched token count.
  If placebo performs within noise of real memory, the effect is context volume rather than
  memory content, and the layer is abandoned. Nobody in the literature runs this. Also
  mandatory: the **token-matched control**, which erased the published gains of AWM, ASI and
  ReasoningBank ([2606.15017](https://arxiv.org/abs/2606.15017)). Honest power: 80% power for
  a 10pp effect needs **120–200 tasks**; at 17 tasks × 3 repeats the minimum detectable effect
  is ~30pp.
- **D3–D4 — if it clears the gate**, MemCoder schema, git-history cold start, commit-anchored
  bi-temporal validity, and a derived/observed split (derived docs auto-invalidate on source
  change; observed notes are flagged stale, never auto-deleted).
- **D5 — explicit non-goals**, including ACT-R temporal scoring, LLM-extracted knowledge
  graphs (Mem0 deleted theirs from OSS in April 2026 after measuring ~2%), summarizing
  consolidation, and any LoCoMo-derived number.

**Ceiling to keep in mind before promising anything.** Coherence Collapse
([2603.24631](https://arxiv.org/abs/2603.24631), 16,758 trajectories) found **60–69% of
capable-model failures already reach and edit the correct functions.** Retrieval cannot fix
bad edits. The defensible pitch is the one the ablation actually measured: same-or-better
outcomes at ~22% fewer turns, ~28% fewer tokens, ~18% lower cost per solve, ~2× rank-1
localization — locally.

### 13.6 What this changes about the competitive read

§9 and §10 stand as feature comparisons. What changes is which gaps matter:

- **Their distribution advantage is real and unaddressed by any of this.** `npm i -g` +
  `agentmemory connect claude-code` versus our install-friction story is a genuine problem,
  and no research finding makes it go away.
- **Their benchmark advantage is narrower than it looks.** One reproducible public number on
  a conversational benchmark that is near-saturated and irrelevant to code retrieval. The
  benchmark we should run — supercoder-eval, CORE-Bench L2 — neither project has run.
- **Their lifecycle advantage is mostly unearned.** The parts with evidence (dedup, eviction
  for store size, privacy/provenance) are worth ~a week. The parts without (4-tier
  consolidation, summarization, Ebbinghaus decay in ranking) are the bulk of their 18K LOC.
- **The "no production tool has this" framing is dead** independent of agentmemory. Claude
  Code ships auto memory on by default; GitHub ships Copilot Memory with code citations
  re-validated against the current branch. First-mover positioning is gone; symbol-anchored
  self-invalidation is what remains, and it is narrower and more defensible.

---

## Appendix: key file references

### agentmemory

```
src/state/vector-index.ts:37-77      brute-force cosine over JS Map
src/state/vector-index.ts:1-7        Buffer-pool slice bug writeup
src/state/vector-index.ts:91-104     dimension validation guard
src/state/hybrid-search.ts:20        RRF_K = 60
src/state/hybrid-search.ts:42-75     query expansion + merge
src/state/hybrid-search.ts:77-240    tripleStreamSearch
src/state/hybrid-search.ts:197-206   weight renormalization
src/state/hybrid-search.ts:242-276   session diversification
src/functions/graph.ts:397-426       LLM XML entity/relationship parsing
src/functions/file-index.ts          file -> observation history
AGENTS.md:5                          "never bypass iii-engine"
AGENTS.md:94-97                      hook stdout/exit semantics
benchmark/SCALE.md                   scale numbers
benchmark/COMPARISON.md              competitor matrix + caveat
```

### mnemex

```
src/core/store.ts:326-327            Index.fts() — the only index created
src/core/store.ts:435-503            unified type-aware hybrid search
src/core/store.ts:43-45              BM25_WEIGHT / vector weight
src/memory/store.ts                  the whole memory subsystem (185 lines)
src/mcp/tools/observe.ts             opt-in observation capture
src/hooks/handlers/interaction-logger.ts   feeds src/learning/interaction
src/learning/index.ts                adaptive ranking entry point
src/retrieval/routing/query-router.ts      backend selection
src/retrieval/reranking/llm-reranker.ts    LLM rerank
```
