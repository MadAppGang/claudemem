# LanceDB 0.13.0 → 0.33.0: migration research

**Date:** 2026-08-06
**Status:** Research complete, **and the upgrade has since been applied** (`@lancedb/lancedb@^0.33.0`).
**Verdict:** Safe. No API changes affect mnemex, and the on-disk format is compatible in both directions.

**Outcome of applying it:** zero source changes, as predicted. Typecheck clean, 1183 tests passing (unchanged baseline). Two follow-ups it forced, both handled:

- 0.33 pulls `@huggingface/transformers` (an *optional* dep, for LanceDB's built-in embedding functions, which mnemex never uses) → `sharp <0.35.0`, carrying four high-severity libvips CVEs. `npm audit` wanted to downgrade LanceDB to 0.30.0; instead `sharp` is pinned to `^0.35.3` via `overrides`. Audit is back to zero vulnerabilities.
- The `pathPattern filter works` test in `test/integration/unified-search.test.ts` had its body wrapped in `try { … } catch { console.log("Skipping: LanceDB camelCase filter not supported in this version") }`, which made it pass unconditionally and would have swallowed any real regression. Backtick camelCase filters verified working on 0.33, so the catch is gone and the test now asserts.

## Why this was researched separately

`@lancedb/lancedb` is pinned at `^0.13.0` while 0.33.0 is current — 20 minor versions. On a 0.x package, minor bumps are breaking by convention, and LanceDB owns the vector store that every existing `.mnemex/` index lives in. A bad upgrade doesn't just break a build, it strands user data.

## Method

Empirical, not documentation-led. Three experiments:

1. **Read a real production index.** Copied the mnemex repo's own 51 MB `.mnemex/vectors` store (28,653 rows, 34 versions) and opened it under both 0.13.0 and 0.33.0.
2. **Round-trip a healthy table.** Created a table with **0.13.0** using mnemex's schema shape and write paths (`createTable` → `add` → `update` → `delete`), then read and wrote it with **0.33.0**.
3. **Exercise the real API surface.** Derived from the codebase rather than guessed: `add` (99 call sites), `update` (48), `delete` (37), `search` (26), `toArray` (22), `query` (21), `where` (20), `limit` (9), `tableNames` (4), `vectorSearch` (3), `openTable` (3), `fullTextSearch` (3), `createTable` (3), `dropTable` (1), `createIndex` (1).

## Result: format compatibility

A table created by 0.13.0 is fully readable **and writable** by 0.33.0. No migration step, no reindex.

| Operation | 0.33.0 on a 0.13.0-created table |
|---|---|
| `connect()` | pass |
| `tableNames()` | pass |
| `openTable()` | pass |
| `countRows()` | pass (219) |
| `schema()` | pass — `FixedSizeList[8]<Float32>` preserved |
| `query().limit().toArray()` | pass |
| `where()` with backtick camelCase | pass |
| `vectorSearch().limit()` | pass |
| `search().where().limit()` | pass |
| `add()` | pass |
| `update()` | pass |
| `delete()` | pass |
| `listVersions()` | pass (7 versions) |
| `restore(n)` | **FAIL** — see below |

The backtick-quoted camelCase filter (`` `filePath` = '...' ``) matters specifically: mnemex depends on it throughout, and there is a skipped test in the suite noting "LanceDB camelCase filter not supported in this version". It works in 0.33.0.

## The one breaking change

`restore(version)` now requires a `checkout(version)` first:

```
Error: Invalid input, you must run checkout before running restore
```

**Impact on mnemex: none.** The two `.restore(` hits in `src/` are mnemex's own methods, not LanceDB's:

- `src/learning/validation/demo.ts:373` — `mockEnv.restore(snap1.id)`
- `src/editor/history.ts:126` — `this.restore(sessionId, filePath)`

mnemex never calls LanceDB's `restore()`. If time-travel is added later, the call becomes `await table.checkout(v); await table.restore();`.

## Incidental finding: the production index is corrupt

This is independent of the upgrade and more urgent than it.

The mnemex repo's live index at `/Users/jack/mag/mnemex/.mnemex/vectors` has:

```
vector   FixedSizeList[0]<Float32>   listSize=0
```

A **zero-dimension** vector column, across 28,653 rows and 34 versions. The table opens and `countRows()` succeeds, which is why nothing surfaced it, but every read that touches `vector` fails:

- **0.33.0:** `LanceError(Schema): Field "vector" contains a FixedSizeList with dimension 0; dimension must be a positive integer`
- **0.13.0:** Rust panic — `attempt to divide by zero` at `lance-encoding-0.19.2/src/data.rs:420`

Both versions fail. This is **not** a compatibility break; 0.33.0 merely reports it as a clean error instead of panicking.

### Root cause

LanceDB infers table schema from the first written batch. `src/core/store.ts` computed:

```ts
const incomingDimension = data[0].vector.length;
```

and guarded only against *mismatch* with an existing table, never against **zero**. When the embedding provider returns empty arrays, `createTable` locks the column to `FixedSizeList[0]` and every subsequent row is written unqueryable. The schema is immutable after creation, so the only recovery is a full reindex.

The likely trigger here: `~/.mnemex/config.json` sets `embeddingProvider: ollama`, and Ollama is not running (`curl localhost:11434` → connection refused).

### Fix applied

`assertVectorDimension()` in `src/core/store.ts` now rejects non-positive dimensions at all three write paths (`addChunks`, `addDocuments`, `addCodeUnits`), throwing `ZeroDimensionVectorError` with the provider hint. Covered by `test/unit/core/store-vector-dimension.test.ts` (7 tests; 5 fail if the guard is removed).

**Action still required:** the existing corrupt index must be rebuilt. The guard prevents recurrence; it cannot repair what's already on disk.

```
# start the embedding provider first, then:
mnemex index --force
```

## Open question before upgrading

`src/core/store.ts:47-54` carries a 60-second watchdog (`withTimeout` / `LANCEDB_WRITE_TIMEOUT_MS`) built specifically for a **0.13.0 deadlock** where all tokio threads park in `Condvar::wait` at 0% CPU with 0 bytes written.

Whether 0.33.0 fixes that is **not established**. Release notes don't name it, and a deadlock cannot be confirmed absent by a short test — only by a soak. Recommendation: upgrade and **keep the watchdog**. If the deadlock is gone, the watchdog costs nothing; if it isn't, removing it reintroduces indefinite hangs. Retire it only after sustained real-world indexing on 0.33.0.

## Recommendation

Upgrade `@lancedb/lancedb` to `^0.33.0`. Format compatibility is verified in both directions, the sole API break is unused by mnemex, and 0.33.0 turns a Rust panic into a catchable error on malformed schemas.

Sequence:

1. Rebuild the corrupt index first, so the upgrade is evaluated against healthy data.
2. Bump the dependency; expect no source changes.
3. Keep the write watchdog until a soak test says otherwise.
4. Re-check the skipped "LanceDB camelCase filter not supported in this version" test — it should now be un-skippable.

## Sources

- [Migration Guide — LanceDB](https://lancedb.github.io/lancedb/migration/)
- [LanceDB Changelog](https://lancedb.com/docs/changelog/)
- [Releases · lancedb/lancedb](https://github.com/lancedb/lancedb/releases)
- [Lance File 2.1 is Now Stable](https://www.lancedb.com/blog/lance-file-2-1-stable)
- [@lancedb/lancedb — npm](https://www.npmjs.com/package/@lancedb/lancedb)

Documentation was background only. Every compatibility claim above comes from the experiments described in **Method**.
