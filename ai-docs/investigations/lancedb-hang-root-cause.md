# Investigation: LanceDB indexing hang — root cause (revised)

Date: 2026-08-02
Branch: fix/indexing-hardening-and-benchmark-cli

## The revised finding (overturns the June "deterministic 0.13.0 bug" reading)

The hang is **intermittent and concurrency-correlated**, NOT a deterministic
LanceDB 0.13.0 write-path deadlock, and NOT database corruption.

### Live evidence (observed 2026-08-02, reproducing in real time)
Five concurrent `mnemex index` processes on DIFFERENT repos:
- 62359 meroku — WORKING (STAT R, 6.1% CPU)
- 69418 mnemex — WORKING (STAT Rs, 1.6% CPU)
- 85201 meroku worktree — WORKING (STAT R, 2.3% CPU)
- 65257 claudish worktree — HUNG (12+ min, 0.1% CPU, STAT S+, all threads in
  _pthread_cond_wait), 21 open embedding connections, parent = launchd (pid 1)

Most work fine; one wedges. The mnemex DB itself is healthy: clean sequential
manifests `_versions/1..7.manifest`, transactions `0..6.txn`, latest versions
written TODAY. No orphan/partial manifest, no corruption, ever, in this dig.

### What the processes share (the real contention surface)
NOT the same `.mnemex/vectors` dir (different repos → no LanceDB file-lock
collision). They share: one machine, one embeddings API account (OPENROUTER_API_KEY
→ shared rate limit), one global mnemex binary + LanceDB native module version.

### The volume source (architectural)
`src/mcp/reindexer.ts` spawns detached `mnemex index --quiet`
(`spawn(..., {detached:true})`). Every Claude Code session running the mnemex MCP
spawns its own background reindexer; they orphan to launchd (hence 65257's
parent=pid 1) and accumulate. N sessions → N concurrent detached indexers.

### Two hang signatures seen (same endpoint: LanceDB tokio runtime parked)
- June clean repro: 0 network connections, hung at connect/createTable (pre-embeddings).
- Aug live: 21 connections, hung after embedding activity.
Both end parked in Condvar::wait inside lancedb.darwin-arm64.node with ~0% CPU.
Embeddings fetches DO have 60s AbortController timeouts (embeddings.ts:320), so a
stalled fetch is not the unbounded wait; the unbounded wait is the LanceDB write
path (store.ts table.add/createTable — now wrapped by our watchdog).

## Classification for the recovery-service design
- CORRUPTION / terminal-broken DB: NOT OBSERVED. Marking a DB "permanently broken,
  stop retrying" would be WRONG for the dominant failure mode — it would brick a
  healthy DB that indexes fine on the next attempt.
- The dominant failure = a wedged/starved PROCESS, not a broken DB. Correct
  responses: (a) bound the wait [shipped: withTimeout watchdog], (b) reclaim the
  wedged holder [shipped: progress-based staleness], (c) stop spawning N concurrent
  indexers machine-wide [NOT shipped: needs global single-indexer coordination].

## Recommended fixes, in order of leverage
1. GLOBAL single-indexer coordination (the disease): a machine-wide lock or a
   single indexer daemon/queue, so N sessions don't run N concurrent detached
   reindexers competing for one API quota + machine. Debounce/coalesce across
   sessions, not just within one (reindexer.ts debounces per-process only).
2. Upgrade @lancedb/lancedb off 0.13.0 and re-check under concurrency (may reduce
   the wedge probability; not confirmed as full cure — DB commits fine at 0.13.0).
3. Reserve a TERMINAL "broken" state ONLY for genuine corruption (unreadable
   manifest / unclearable dimension mismatch), detected by a cheap startup
   integrity check — a rare path, not the main event. Do NOT mark broken on a
   timeout/wedge.

## LanceDB upgrade trial (2026-08-04) — REVERTED, but found the real blocker
Trialed @lancedb/lancedb 0.13.0 -> 0.33.0 (latest stable). 0.33 CAN connect,
list tables, and countRows (23459) on a 0.13-written table, but query() FAILS:

  LanceError(Schema): Field "vector" contains a FixedSizeList with dimension 0;
  dimension must be a positive integer (lance-core 9.0.0)

This is NOT a plain format-version bump — it is a DATA-MODEL constraint change.
mnemex writes dimension-0 PLACEHOLDER vectors (indexer.ts unitsWithPlaceholder
path — code units stored before enrichment / when embeddings are skipped).
LanceDB 0.13 tolerated empty FixedSizeList; 0.33 rejects dimension-0 as invalid
schema and refuses to read the table.

=> Upgrading LanceDB is a TWO-PART job, not a version bump:
   1. Change the write path to stop emitting dimension-0 placeholder vectors
      (use a real zero-filled vector of the model dim, or a separate non-vector
      placeholder table, or omit the row until it has a real embedding).
   2. Force a reindex for existing users (their tables already contain the
      now-illegal rows).
Reverted to 0.13.0 (clean; real table never touched — tested on a /tmp copy).
The hang is already mitigated (global serialization + write watchdog), so the
upgrade is deferred to its own PR gated on removing dimension-0 vectors.

## Still open (not done)
- Web/changelog confirm of LanceDB 0.13.0 concurrency hang + fixed-in version.
- The dimension-0 placeholder-vector removal (prerequisite for any LanceDB
  upgrade past ~0.13). Its own future PR.
- Whether the hung process's 21 connections are live embedding waits or dead
  keepalives (would distinguish "starved on rate-limited API" from "LanceDB hang
  after embeddings").
