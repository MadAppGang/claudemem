# mnemex Indexing Lock — Before / Now / Ideal

Visual map of the indexing-hang problem, the fix we shipped, and the gap to ideal.

---

## 1. BEFORE — the broken state (what bit you)

The lock tracked **liveness** (is the process alive?) but never **progress**
(is indexing actually advancing?). The heartbeat was a dumb timer.

```
  mnemex index (PID 31733)                     .indexing.lock
  ┌──────────────────────────┐                ┌─────────────────────┐
  │ indexing work…           │                │ pid: 31733          │
  │   embed → LanceDB write  │                │ heartbeat: <now>    │ ◀─┐
  │                          │                └─────────────────────┘   │
  │ ┌──────────────────────┐ │                                          │
  │ │ setInterval(1s)      │ ├── stamps heartbeat = now EVERY SECOND ───┘
  │ │  heartbeat = now()   │ │   …whether or not ANY work happened
  │ └──────────────────────┘ │
  └──────────────────────────┘

  ✗ THE HANG:
  LanceDB 0.13.0 table.add() deadlocks → all threads park in Condvar::wait
  → 0% CPU, 0 bytes written… but the 1s timer KEEPS STAMPING the heartbeat.
```

What every other process saw when it tried to index:

```
  another mnemex index  ──▶  isLockStale()?
                              ├─ pid alive?      YES (zombie is "alive")   ✓
                              └─ heartbeat fresh? YES (timer still ticking) ✓
                              ▶ "healthy, working" → WAIT / already_running
                                                     │
                              … waits forever ───────┘   (13h observed)
```

```
  TIMELINE (before)
  t=0     acquire lock, start indexing
  t=30s   LanceDB write() hangs ───────────┐ real work STOPS here
  t=1s…   heartbeat keeps ticking          │
  t=13h   STILL "fresh", STILL blocking ◀──┘ only a human `kill` ends it
```

**Root failure:** liveness ≠ progress. A hung-but-alive process is invisible to
staleness detection, so it blocks everyone and only a manual kill recovers it.

---

## 2. NOW — what we shipped (auto-detect + auto-reclaim)

Added a SECOND timestamp, `lastProgressAt`, that advances ONLY when real work
finishes. The timer heartbeat still means "alive"; progress means "advancing".

```
  mnemex index (PID)                           .indexing.lock
  ┌──────────────────────────┐                ┌──────────────────────────┐
  │ ┌──────────────────────┐ │                │ pid: …                   │
  │ │ setInterval(1s)      │ ├─ heartbeat ────▶│ heartbeat:     <timer>   │ "alive"
  │ │  heartbeat = now()   │ │                 │ lastProgressAt:<work>    │ "advancing"
  │ └──────────────────────┘ │                └──────────────────────────┘
  │                          │                      ▲
  │ embed batch done ────────┼── recordProgress() ──┤  (7 real-work sites:
  │ LanceDB addChunks done ──┼── recordProgress() ──┘   after each embed +
  │                          │                          each vector write)
  └──────────────────────────┘
```

Staleness now trips on a HANG:

```
  another mnemex index  ──▶  isLockStale()?
                              ├─ pid dead?                    → STALE (as before)
                              ├─ no progress in 5 min?  ◀NEW  → STALE  ✓ THE HANG
                              └─ heartbeat old (secondary)    → STALE
                              ▶ if stale: delete lock, RECLAIM, take over
```

```
  TIMELINE (now)
  t=0      acquire, lastProgressAt = now
  t=30s    LanceDB write() hangs → recordProgress() never called again
  t=1s…    heartbeat still ticks (process is alive)  …but progress is frozen
  t=5min   lastProgressAt now > PROGRESS_TIMEOUT
           ▶ next `mnemex index` sees indexing_hung → reclaims lock → resumes
           NO human, NO kill, NO coding session.
```

New MCP status so the system can SAY what's happening:
```
  pid dead                       → "stale_lock"
  pid alive + progressing        → "indexing_in_progress"
  pid alive + NOT progressing    → "indexing_hung"   ◀ NEW (auto-reclaimed)
```

**Shipped & verified:** 38/38 tests pass, incl. the exact previously-broken case
and end-to-end auto-reclaim. Touched: lock.ts, indexer.ts, index-state.ts,
legacy.ts + 3 test files.

⚠️ LIMITATION: this RECOVERS from the hang. It does NOT PREVENT it. A reclaiming
process can hang at the same LanceDB spot, get reclaimed again — a recover loop,
not a cure. Net effect today: instead of blocking forever, it self-heals every
~5 min, but may not make net forward progress if every attempt hangs.

---

## 3. IDEAL — what a great solution does

Four layers. We have layer 1. Layers 2–4 are the gap.

```
  ┌─────────────────────────────────────────────────────────────────────┐
  │ LAYER 4  PRIORITY        Index critical things first                  │
  │          ┌────────────────────────────────────────────────────────┐  │
  │          │ pass 1: entry points, recently-changed, import fan-in   │  │
  │          │ pass 2: everything else  → search works in seconds,     │  │
  │          │ (PageRank later, once the graph exists)   not minutes   │  │
  │          └────────────────────────────────────────────────────────┘  │
  ├─────────────────────────────────────────────────────────────────────┤
  │ LAYER 3  NON-BLOCKING     Serve stale index WHILE reindexing          │
  │          search ──▶ current index (instant)                           │
  │          reindex ─▶ runs in background, swaps in when done            │
  │          → you are NEVER blocked, even during a full reindex          │
  ├─────────────────────────────────────────────────────────────────────┤
  │ LAYER 2  PREVENT          Writes can't hang forever                   │
  │          table.add(data)  wrapped in timeout(60s)                     │
  │          hang → throws → caught → lock released → fails LOUD          │
  │          + LanceDB upgraded off 0.13.0                                │
  ├─────────────────────────────────────────────────────────────────────┤
  │ LAYER 1  RECOVER  ✅ DONE  Hung holder auto-detected & reclaimed       │
  │          progress-based staleness → no zombie blocks the queue        │
  └─────────────────────────────────────────────────────────────────────┘
```

Ideal end-to-end experience:
```
  open project ─▶ pass-1 index (seconds) ─▶ SEARCHABLE
                                            │
                  background top-up ────────┤  always serves current index
                  file changes ─▶ debounced ┘  (never blocks)
                  a write hangs ─▶ times out, retries, logged (never wedges)
```

---

## 4. HOW FAR ARE WE?

```
  LAYER 1  Recover (auto-reclaim hung lock)     ████████████████████ 100% ✅ shipped
  LAYER 2  Prevent (write watchdog)             ██████████████████░░  ~90% ✅ watchdog shipped; LanceDB upgrade still open
  LAYER 3  Non-blocking (serve stale)           █████████████░░░░░░░  ~65% scaffolded on this branch*
  LAYER 4  Priority (critical-first)            ░░░░░░░░░░░░░░░░░░░░   0%  design only

  PLUS: honest phase-aware heartbeat shipped — the 1s timer no longer lies.
  Lock now carries phase ('embedding' | 'writing:lance' | …) + phaseStartedAt,
  so a hang reports "alive, stuck in writing:lance for 6m" instead of "fine".

  * src/mcp/reindexer.ts (detached background index), state-manager.ts
    (freshness), completion-detector.ts, index-state.ts (now incl. hung) already
    exist. Missing: actually serving the OLD index for reads while a reindex runs,
    + atomic swap on completion. Layer 3 only pays off once Layer 2 stops the hangs.
```

### Recommended order (impact-first)
1. **Layer 2 — write watchdog + LanceDB upgrade.** Highest impact: turns an
   infinite hang into a loud, recoverable error. Without it, Layer 1 just loops.
2. **Layer 3 — serve-stale reads.** Wire the existing scaffolding so search never
   blocks on a reindex. Directly kills "we are blocked until it finishes."
3. **Layer 4 — critical-first ordering.** Makes the FIRST index useful in seconds.
   Needs a cheap proxy for importance (PageRank isn't available yet at pass 1).

### One-line status
"Blocked forever" → fixed (auto-reclaim). "Never hangs" + "never blocks" +
"useful instantly" = still ahead of us, roughly 1 + 2 + 1 focused changes away.
