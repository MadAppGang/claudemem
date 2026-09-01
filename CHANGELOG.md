# Changelog

All notable changes to mnemex are documented here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

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
