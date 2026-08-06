# Investigation: "Indexing is super slow / blocks everything"

Date: 2026-06-04
Branch: feat/mcp-structured-indexing-state

## Symptom (as reported)
"Indexing is so super slow, we are literally blocked until it finishes." Wanted:
quick first index + background top-up, race-resistant state so multiple instances
can index simultaneously, critical things first, and to understand the bottleneck.

## Root cause (CONFIRMED via clean single-process repro)
The indexers are **not slow — they hang inside LanceDB 0.13.0's write path**. What
presents as "infinite slowness" is processes that park forever in the LanceDB tokio
runtime and never finish. Confirmed deterministic and NOT concurrency-dependent.

### Decisive clean experiment (zero contention)
After killing all 6 wedged processes, ran ONE index on a 43-file copy of src/core
(`mnemex v0.31.2`), full enrichment, PID captured, nothing else running:
- Hung for 183s (killed), CPU ~0%, STAT=S the entire time.
- **0 ESTABLISHED network connections** → hangs BEFORE any embedding call.
- index.db stuck at 143360B = empty LanceDB scaffold (table schema, 0 rows).
- Log frozen at the start banner "Indexing ..." — never wrote a single chunk.
- Stack: main thread in `_pthread_cond_wait`; all tokio-runtime-workers parked in
  `Condvar::wait` inside `lancedb.darwin-arm64.node`.
=> A single, uncontended process wedges at LanceDB connect/openTable/createTable
   /first-add. Falsifies BOTH earlier theories (network-bound embeddings;
   concurrency-triggered deadlock).

### Evidence
1. **Six concurrent wedged `mnemex index` processes**, running 4h–13h:
   17494 (12h55m), 35080 (9h51m), 31733 (9h10m), 15093 (8h43m), 11640 (8h13m), 18940 (4h05m).
2. **Stack sample (`sample 11640`) — every thread parked in a condvar wait:**
   - main-thread: `_pthread_cond_wait` → `__psynch_cvwait` (idle)
   - tokio-runtime-workers inside `lancedb.darwin-arm64.node`:
     `park_timeout` → `std::sync::condvar::Condvar::wait` → `_pthread_cond_wait`
   - NO indexing code, NO fetch, NO embedding call, NO SQLite write on any stack.
3. **`index.db` size flat (0-byte delta over minutes) while heartbeat stays fresh.**
4. **Zero ESTABLISHED TCP connections** on the wedged `--no-llm` process → not
   network/embeddings bound.
5. The `--no-llm` run **still wedged** → rules out LLM enrichment AND embeddings;
   isolates the fault to LanceDB writes.

### Why it was misread as "slow"
The lock heartbeat (`lock.ts:392 startHeartbeat`) runs on its own `setInterval`
with `.unref()`, fully decoupled from indexing progress. A hung indexer keeps the
lock "fresh" forever, so:
- `isLockStale()` never trips (pid alive + heartbeat fresh).
- Every other process either waits the full `waitTimeout` or returns
  `already_running` — i.e. **blocked behind a corpse that looks alive**.

### Faulty write path
`indexer.ts` → `store.ts` `addChunks`/`addCodeUnits`/`createTable` →
`await table.add(data)` (store.ts:337, 343, 734, 1029, 1034) →
`@lancedb/lancedb@0.13.0` native module → tokio runtime deadlock.

## Bottleneck answer
NOT embeddings, NOT LLM enrichment, NOT the network. The bottleneck is a
**LanceDB 0.13.0 write/commit hang** under (apparently) concurrent indexing
processes on the machine. Earlier "network-bound on embeddings" reading was wrong.

## What already exists on this branch (relevant to the ask)
- `src/mcp/reindexer.ts` — background reindex: spawns detached `mnemex index --quiet`.
- `src/mcp/state-manager.ts` — freshness state (lastIndexed, filesChangedSince).
- `src/mcp/completion-detector.ts` — polls lock-absence + index.db mtime.
- `src/mcp/index-state.ts` — 5 structured statuses from cross-process lock truth.
- `indexer.ts` smart-incremental: reuse vectors by contentHash (oldChunksCache).
So "index in background / structured state" is largely drafted; the missing pieces
are (a) the hang fix, (b) serve-stale-while-reindexing, (c) critical-first ordering.

## Open design questions (for next phase, NOT yet decided)
1. Detect & recover hung holders: add a *progress* heartbeat (work-based, not timer)
   so a deadlocked holder goes stale and is reclaimed.
2. Fix/upgrade LanceDB 0.13.0 (concurrency); or serialize writes; or single
   indexer-daemon-per-machine instead of N detached processes.
3. Non-blocking reads: serve the existing index while a background reindex runs
   (solves the stated pain without true multi-writer concurrency).
4. Critical-first: PageRank needs the graph which needs the index → pass-1 priority
   must use a cheap proxy (entry points, recently-changed, import fan-in).

## Immediate remediation
Kill the six wedged indexers (safe — they will never complete; lock self-heals on
pid death). Then re-measure a single clean index to get true throughput numbers.

## FIX SHIPPED: auto-detect + auto-reclaim hung holders (dual heartbeat)
Date: 2026-06-05. Root cause of "mnemex can't recover on its own": the heartbeat
(lock.ts setInterval, .unref) advances every 1s regardless of work, so a hung
holder looks "fresh" forever and isLockStale() never trips → everyone blocks
behind a zombie. Liveness was tracked; progress was not.

Implemented "dual liveness + progress":
- `LockData.lastProgressAt` — advances ONLY on real work (NOT a timer).
- `IndexLock.recordProgress()` — wired at all 7 work sites in indexer.ts (after
  each embed batch + each vectorStore addChunks/addCodeUnits).
- `DEFAULT_PROGRESS_TIMEOUT = 300000` (5 min). `isLockStale()` now trips if pid
  dead OR no progress within progressTimeout. Backward compat: missing
  lastProgressAt falls back to heartbeat (`?? heartbeat`), never instant-stale.
- New `indexing_hung` status in index-state.ts (pid alive + not progressing);
  legacy.ts no longer short-circuits on it, so the next index reclaims the lock
  automatically — no manual kill, no coding session needed.
Tests: 38 pass / 0 fail (lock + inspect-lock + index-state), incl. the hang case
("live pid + fresh heartbeat + OLD lastProgressAt => STALE") and end-to-end
acquire() auto-reclaim. Typecheck clean for touched files.

## STILL OPEN (root-cause layer, NOT yet done)
The dual heartbeat RECOVERS from the hang; it does not PREVENT it. A reclaiming
process can hang at the same LanceDB spot. Follow-ups:
1. Watchdog timeout on the LanceDB writes (store.ts table.add/createTable wrapped
   in Promise.race so a hang throws instead of parking) — attacks the source.
2. Upgrade @lancedb/lancedb off 0.13.0 and re-run the clean repro.
