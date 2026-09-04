# Changelog

All notable changes to mnemex are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [0.34.0] - 2026-09-04

A release about failing loudly. Two silent failures are gone: an index built with
one embedding model and searched with another was destroyed and rebuilt without
being asked, and a model the provider did not have produced an index that could
never answer a single query. Both now stop and say what to do about it.

### Added

- **`onModelMismatch` decides what happens when the index and the config disagree
  about the embedding model.** `use-indexed` (the default) keeps the index and
  switches to the model it was built with; `force-model` clears and rebuilds with
  the configured one, which is what every version until now did unconditionally.
  Readable from project config, global config, or `MNEMEX_ON_MODEL_MISMATCH`.
- **`mnemex index` accepts `-m` / `--model`.** It never has: the value was
  silently consumed as the project path. This matters more than it sounds,
  because the remedy the mismatch error has been printing for users to run —
  `mnemex index --force --model <name>` — could therefore never have worked.

### Changed

- **On a model mismatch, the default is now to use the model the index was built
  with.** Rebuilding spends money and time; adopting the stored model costs
  nothing and loses nothing. The failure mode of the new default is an error you
  can act on, and the failure mode of the old one was a silent bill. Set
  `"onModelMismatch": "force-model"` to keep the previous behaviour.
- **The embedding provider is recorded alongside the model.** Without it the
  feature above cannot work at all: the provider is inferred from the model
  *string*, so a bare name like `nomic-embed-text` matches no prefix rule and is
  requested from whatever provider the config happens to name today. An index
  written before this release has no provider on record and says so by name.
- LanceDB 0.33 → 0.38.
- An error that escapes a command prints its message and nothing else. Previously
  bun's default handler rendered four frames of minified `dist/` paths, two
  "missing sourcemaps" notes and a version banner for ordinary operational
  failures. `MNEMEX_DEBUG=1` restores the stack.

### Fixed

- **A missing embedding model no longer writes an index that can never be read.**
  Only connection errors failed fast; everything else — including the 404 for a
  model the provider does not have — was treated as a skippable chunk that
  contributed an empty vector. Every chunk failing meant every vector empty, and
  LanceDB fixes the column width at creation, so the table was born
  `FixedSizeList[0]` and was unreadable forever. A missing model is now fatal, a
  100% failure rate throws whatever the cause, and `embedOne` refuses to return a
  zero-length vector. The deliberate skip for a genuine *partial* failure is
  unchanged and pinned by a test.
- **An index already in that state is detected when its table opens, and repaired
  by the next index run.** Reaching native code with it produced a Rust panic on
  LanceDB 0.13 (`attempt to divide by zero`, twice, with cargo paths), a
  `LanceError(Schema)` on 0.33 and later, and on a plain scan zero rows in
  silence. `mnemex status` explains the state instead of reporting an empty index.
- **An unreachable model is reported before it is used, not after.** The check
  had a single caller inside the indexing path, which agent mode skips entirely,
  so a search produced `No vector column found to match with the query vector
  dimension: 0`. It now names the model, the provider on record and the
  provider's own error, and leaves the index untouched.
- The MCP search tool no longer swallows an unavailable-model error as a
  non-fatal auto-index failure.
- Mismatch and repair notices no longer go to stdout, which is the JSON-RPC
  stream when running as an MCP server.

## [0.33.0] - 2026-09-02

A correctness and performance release. Search is roughly 18x faster, and seven
defects are fixed — every one of which failed **silently**, several while
reporting success.

### Fixed

- **Search no longer rebuilds the BM25 index on every query.** `ensureFtsIndex()`
  forced a full rebuild guarded by a per-instance flag, while a fresh store is
  constructed per search. Measured on a real 19,862-row store: the redundant
  rebuild cost **275 ms**, about half of total search latency and 32x the query
  it was enabling. End-to-end search **554 ms -> 30.8 ms**. It was also a source
  of non-determinism, so results are now more stable, not less.

- **Deletes could silently do nothing and report success.** `deleteByFile`,
  `deleteByFileHash`, `deleteAllByFile` and `deleteByDocumentType` checked a raw
  table handle, but the table is opened lazily by the search path. On a store
  where nothing had opened it yet the delete no-opped and returned 0 —
  indistinguishable from "nothing to delete". Live on three paths: `docs clear`
  printed "Cleared documentation" while orphaned chunks stayed searchable;
  `docs fetch` never deleted before re-fetching; and the incremental indexer left
  chunks of **deleted files searchable forever**, recoverable only by
  `index --force`.

- **A file path could delete the entire index.** Several predicates interpolated
  values directly into SQL. A path containing `x' OR filePath LIKE '%` renders a
  well-formed match-everything predicate, so a delete aimed at one file emptied
  the table. LanceDB offers no parameterized predicate API, so all ~30 predicate
  sites are now individually audited and escaped.

- **Enriched search filtered by document type returned nothing.** The `LIKE`
  escaper was applied to an `IN` list; SQL string literals do not process
  backslash escapes, so `file\_summary` matched no row. 10 of 11 document types
  contain an underscore, so type-filtered search was silently empty.

- **Incremental reindex re-embedded underscored files every run.** The same
  escaping mismatch made `getChunksWithVectors` return nothing for any path
  containing `_`, disabling vector reuse without any error.

- **Windows global installs could not find tree-sitter grammars** (issue #4). The
  dist check hardcoded a forward slash, so it was false on Windows and the
  grammar path resolved to `node_modules\grammars`. It also false-positived on
  any `dist` ancestor directory and on names like `distribution/`.

- **Local embedding providers requested the wrong URL** (issue #4). The `local`
  provider default lacked the `/v1` path segment. Normalization now happens in
  the client, so **configs already saved in the broken state repair themselves**
  with no user action. Custom gateway paths (LiteLLM and similar) are left alone.

### Added

- **Self-invalidating memory.** Every document carries `valid_from_commit` /
  `invalidated_at_commit`, backed by a new commit-provenance table. Documents
  split three ways: derived types auto-invalidate and requeue when their source
  file changes; observed types are flagged stale and **never** auto-deleted;
  external documentation is exempt, because a repo commit says nothing about it.
  Facts are superseded, never deleted.

- **A labeled retrieval eval set and a harness wired to real search.** 135
  queries derived from git history with 403 relevance judgements. The ablation
  harness existed but had never been connected to anything — it defaulted to a
  mock returning no results.

- **Three gated retrieval features, all default-off**: TM2C2 convex fusion,
  per-query adaptive fusion weights with a query-length score floor, and
  query-seeded Personalized PageRank routed to structural and semantic intents.

### Changed

- **The CLI and the MCP server now agree on whether learning is enabled.** They
  previously disagreed for anyone who had never run `mnemex init`: the CLI
  treated learning as on, the MCP server as off. Both now use one predicate with
  the CLI's existing opt-out default, so **MCP users who never configured
  learning will now have it enabled**. Set `learning: false` in config to opt out.

- **`search` and `search_code` now rank identically.** `search` previously
  discarded session observations and ignored learned file boosts, so the same
  query returned different results depending on which tool was called.

### Performance

- Search: 554 ms -> 30.8 ms (~18x).
- `FileTracker` construction: 346 us -> 35 us.
- Learning layer per search: 190 us -> 2 us.

### Known limitations

- **Root-mounted embedding endpoints now get `/v1` appended.** Endpoint
  normalization adds `/v1` to any URL with no path at all. A server that serves
  `/embeddings` at the root (`http://host:8080`) worked before and will now 404.
  Set an explicit path on the endpoint to opt out. Endpoints that already carry
  a path — including gateway prefixes like `/openai` — are left untouched.

- **A config edit made outside the process needs an MCP server restart.** The
  learning-enabled flag is cached per project path and only invalidated by
  in-process saves, so editing `config.json` in an editor is invisible to a
  long-running MCP server until it restarts.

### Notes

TM2C2 fusion was implemented, measured against the 135-query set, and **rejected**:
it loses on all six metrics, so the default remains reciprocal-rank fusion. The
measurement is committed under `eval/code-search-harness/results/clean-run/`.

A pre-release code review caught a fusion regression before it shipped: setting a
stable id on every semantic result made those hits unmergeable with the four
backends that key on `file:startLine`, so one code location surfaced twice and
lost its consensus boost. Merge keying now prefers a real code anchor and falls
back to the id only for anchor-less documents. Fixed in this release; it never
reached a published version.

[0.33.0]: https://github.com/MadAppGang/mnemex/releases/tag/v0.33.0
