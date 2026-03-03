# Requirements: Cloud/Team claudemem

**Session**: dev-arch-20260303-110649-56cc19cc
**Date**: 2026-03-03
**Status**: Draft

---

## 1. Background and Motivation

claudemem is currently a single-developer local tool. Each developer maintains their own independent index in `{project}/.claudemem/`. On a team, this means:

- Every developer re-indexes from scratch independently (wasted compute)
- Embeddings and LLM enrichment are duplicated per developer
- No shared search context across the team
- Index state is not tied to git history (ephemeral, machine-local)

The cloud/team version eliminates this waste by making the index a shared, git-commit-addressed artifact that team members contribute to and consume collectively.

---

## 2. Functional Requirements

### FR-1: Per-Commit Cloud Index

**FR-1.1** Each git commit SHA maps to exactly one canonical index stored in the cloud. All team members working at the same commit share the same cloud index.

**FR-1.2** The cloud index for a given commit is immutable once written. If two team members simultaneously attempt to write the same commit index, the system must be idempotent (same chunks, same embeddings, same outcome).

**FR-1.3** The cloud index is addressed by `{org}/{repo}/{commit_sha}`. The org and repo are derived from the git remote URL.

**FR-1.4** Team members must be able to query a cloud index without having to index themselves, as long as the index for their current HEAD commit already exists.

**FR-1.5** The system must support querying indexes for past commits, enabling point-in-time code search (e.g., "search at the commit before the refactor").

### FR-2: Diff-Based Incremental Reindexing

**FR-2.1** When creating the index for commit `C`, the system computes `git diff <parent_sha>...<C>` to identify changed files.

**FR-2.2** Only changed files are re-chunked, re-embedded, and re-enriched. Unchanged files inherit their chunks and embeddings from the parent commit's cloud index directly.

**FR-2.3** Deleted files are removed from the new commit's index. Their entries must not appear in search results for that commit.

**FR-2.4** The system handles the initial commit (no parent) by indexing all files.

**FR-2.5** The system handles merge commits with multiple parents by computing the union of changes across all parent diffs, deduplicating chunks shared across parents.

**FR-2.6** The incremental update must preserve the BM25 full-text index and symbol graph consistency (PageRank scores must be recomputed for commits that change the symbol graph).

### FR-3: Local Dirty File Overlay

**FR-3.1** Files that the developer has modified locally but not yet committed (working tree changes detected via `git status --porcelain`) are indexed locally in a temporary overlay index.

**FR-3.2** The overlay index is stored locally at `{project}/.claudemem/overlay/`. It is ephemeral — it is invalidated and rebuilt whenever the set of dirty files changes.

**FR-3.3** Search queries are executed against both the cloud commit index and the local overlay simultaneously. Results are merged, with local overlay results taking precedence for files that exist in both (the overlay is the authoritative source for dirty files).

**FR-3.4** Files that are dirty locally are suppressed from the cloud index results to prevent stale data surfacing. Only the local overlay's version of a dirty file appears in results.

**FR-3.5** The overlay must be lightweight: it must complete within a few seconds for typical dirty file sets (fewer than 50 files). The overlay does NOT require LLM enrichment — raw embeddings only.

**FR-3.6** The overlay is invalidated (and rebuilt on next query) when the set of dirty files changes. This can be detected lazily at query time using `git status`.

### FR-4: Source Code Privacy

**FR-4.1** Raw source code MUST NOT be transmitted to the cloud. The cloud receives only:
  - AST-parsed chunk metadata (chunk type, name, signature, start/end lines, language)
  - SHA256 content hashes (used as deduplication keys)
  - Pre-computed embedding vectors (float arrays)
  - LLM-generated summaries (enrichment text — see FR-4.2)

**FR-4.2** LLM enrichment (code summaries, usage examples) is computed locally on the developer's machine before upload. The summary text MAY be stored in the cloud. Teams that do not want summary text in the cloud can disable enrichment upload via configuration.

**FR-4.3** The source code used for AST parsing and embedding generation never leaves the local machine. Embeddings are generated locally (using the configured embedding provider) before upload.

**FR-4.4** The cloud service operates on opaque float vectors and hashed identifiers only, making it infeasible to reconstruct source code from cloud-stored data alone.

### FR-5: Shared Embeddings and Enrichment

**FR-5.1** Embeddings are computed once per unique content hash across the entire team. If chunk with `contentHash=abc123` is already in the cloud, no team member needs to recompute it.

**FR-5.2** Before computing embeddings locally, the client queries the cloud for a batch of content hashes. The cloud returns pre-existing embedding vectors for hashes it has seen before. Only missing hashes require local embedding computation.

**FR-5.3** LLM enrichment (summaries) is similarly deduplicated by content hash. If a summary exists in the cloud for a given hash, it is fetched rather than re-generated.

**FR-5.4** The embedding model and version used to generate embeddings is stored as metadata on every stored vector. Mixed-model indexes (where different developers use different models) are detected and handled gracefully — the client falls back to local re-embedding if the cloud model does not match the configured model.

### FR-6: Authentication and Team Access Control

**FR-6.1** Each team has an org-level API key. Individual developers authenticate using personal API tokens scoped to their org.

**FR-6.2** Access control is at the repository level. A team member can access cloud indexes only for repositories they have been granted access to.

**FR-6.3** The CLI supports `claudemem team login`, `claudemem team logout`, and `claudemem team status` commands for managing team credentials.

**FR-6.4** Unauthenticated or unauthorized requests return clear error messages guiding the developer to authenticate, rather than silently falling back to local-only mode.

### FR-7: CLI Integration

**FR-7.1** The existing `claudemem index` command gains a `--cloud` flag to trigger cloud-aware indexing (diff-based, upload to cloud).

**FR-7.2** The existing `claudemem search` and all search-adjacent commands (`map`, `context`, `callers`, `callees`, `impact`) work transparently against the merged cloud+overlay index.

**FR-7.3** A new `claudemem sync` command fetches the cloud index for the current HEAD commit and caches it locally for offline operation.

**FR-7.4** The `claudemem watch` daemon gains cloud-aware mode: when a commit is detected, it triggers an incremental cloud index update in the background.

**FR-7.5** All cloud operations display progress to the user (chunks uploaded, embeddings reused vs. computed, time elapsed).

### FR-8: MCP Server Integration

**FR-8.1** The MCP server's `search_code`, `get_context`, `find_callers`, and `find_callees` tools operate against the merged cloud+overlay index when cloud mode is configured.

**FR-8.2** The MCP server's `ToolDeps` dependency injection is extended to include a cloud index client, so tools can resolve cloud-vs-local queries without modification to individual tool implementations.

---

## 3. Non-Functional Requirements

### NFR-1: Performance

**NFR-1.1** Incremental cloud index update for a typical commit (1–20 changed files) must complete within 30 seconds on a standard developer machine with a stable internet connection, excluding embedding computation time.

**NFR-1.2** Local dirty overlay indexing (without LLM enrichment) must complete within 10 seconds for up to 50 dirty files.

**NFR-1.3** Merged search query (cloud + overlay) must return results within 2 seconds for typical queries, matching current local-only latency.

**NFR-1.4** Embedding deduplication (hash lookup before compute) must reduce redundant embedding API calls by at least 70% in steady-state team workflows.

**NFR-1.5** The cloud index download/sync for a new team member joining an existing project must complete within 5 minutes for a repository with 10,000 indexed chunks, using incremental download (not a full dump).

### NFR-2: Reliability and Consistency

**NFR-2.1** The system must handle partial upload failures gracefully. An incomplete cloud index write for a commit does not corrupt the parent's index. Writes are transactional per commit.

**NFR-2.2** The local cache of the cloud index is treated as a read-through cache. A cache miss triggers a cloud fetch, not an error. Cache corruption triggers automatic re-fetch.

**NFR-2.3** If the cloud is unreachable, all operations degrade gracefully to local-only mode with a clear user-facing warning. No operations fail silently.

**NFR-2.4** The overlay index consistency is checked at query time using a lightweight dirty-file set fingerprint. Stale overlays are re-built atomically (new overlay replaces old only after successful build).

### NFR-3: Security

**NFR-3.1** All communication with the cloud service uses TLS 1.2 or higher. No plaintext transmission of any data.

**NFR-3.2** API tokens are stored in the OS keychain (macOS Keychain, Linux Secret Service, Windows Credential Manager) when available, falling back to a permission-restricted file at `~/.claudemem/credentials.json` (mode 0600).

**NFR-3.3** The cloud stores only vectors, hashes, and metadata. Even with full cloud access, source code is not recoverable from cloud-stored data (vectors are not invertible; hashes are one-way).

**NFR-3.4** Chunk content is never logged, cached in plaintext beyond the local LanceDB store, or included in error reports sent to the cloud.

**NFR-3.5** The cloud service enforces rate limiting per org API key to prevent abuse.

### NFR-4: Scalability

**NFR-4.1** The cloud index must support repositories with up to 500,000 indexed chunks without degradation in search latency.

**NFR-4.2** The system must support teams of up to 100 developers concurrently uploading chunks for different commits to the same repository without write conflicts.

**NFR-4.3** Per-commit index storage must be space-efficient: unchanged chunks are stored once and referenced by multiple commits (content-addressed deduplication), not duplicated per commit.

**NFR-4.4** The cloud backend must support horizontal scaling of the query path independent of the write path.

### NFR-5: Maintainability

**NFR-5.1** The local client code must be fully testable without a live cloud service. A local cloud stub (in-process or local HTTP server) must be provided for integration tests.

**NFR-5.2** Cloud protocol versioning must allow the server to evolve its API without breaking older CLI versions, using a version negotiation handshake at connection time.

**NFR-5.3** All cloud API interactions are isolated behind an `ICloudIndexClient` interface, so the cloud backend can be swapped (e.g., different cloud providers or self-hosted) without changes to the CLI or MCP server.

---

## 4. Constraints

### TC-1: Technology Stack (Non-Negotiable)

**TC-1.1** The client (CLI + MCP server) remains TypeScript on Bun/Node.js. No new runtime dependencies that do not support both runtimes.

**TC-1.2** Local storage continues to use LanceDB for vectors and SQLite for metadata. The cloud index is a remote mirror/superset of this structure, not a replacement.

**TC-1.3** AST parsing continues to use tree-sitter WASM grammars. The parser runs locally only. The cloud never receives AST trees.

**TC-1.4** The cloud service API must be compatible with HTTP/1.1 clients (no HTTP/2 or gRPC requirements on the client side), to maximize compatibility with corporate firewalls and proxies.

**TC-1.5** The overlay index uses the existing LanceDB + SQLite stack in the `{project}/.claudemem/overlay/` path. No new local storage libraries are introduced.

### TC-2: Backward Compatibility

**TC-2.1** Developers who do not configure a cloud endpoint continue to use claudemem in fully local mode. Cloud features are opt-in.

**TC-2.2** Existing local indexes are not migrated or invalidated when cloud mode is enabled. The local index continues to function as a fallback.

**TC-2.3** The `IEmbeddingsClient`, `ILLMClient`, and `IDocumentExtractor` interfaces are not changed. The cloud layer is a new abstraction above these.

### TC-3: Privacy Constraints

**TC-3.1** The system must support a "no-upload" mode where embeddings and enrichment are computed locally but stored only locally. This satisfies compliance requirements where even opaque vectors cannot leave the developer's machine.

**TC-3.2** Enrichment (LLM summaries) upload is disabled by default. Teams must explicitly opt in to summary upload.

**TC-3.3** The cloud client must respect `CLAUDEMEM_OFFLINE=1` environment variable to fully disable all network operations, for air-gapped environments.

### TC-4: Timeline and Phasing

**TC-4.1** Phase 1 (core cloud index with diff-based reindexing) is the MVP. Local dirty overlay is Phase 2. Shared enrichment deduplication is Phase 3.

**TC-4.2** The MVP (Phase 1) must not require changes to the existing local indexing path. It is additive only.

---

## 5. Assumptions

**A-1: Git is the version control system.** The design assumes git is present and the project is a git repository. Non-git projects are not in scope for cloud features.

**A-2: A single embedding model per team.** All team members use the same configured embedding model and dimension. Mixed-model support (NFR-5.4 / FR-5.4) is a best-effort degradation path, not a first-class feature.

**A-3: Monorepo sub-directories are addressed at the sub-project level.** The `{org}/{repo}/{commit_sha}` addressing scheme applies to the full git repository root. Monorepo sub-project indexes (if needed) are scoped by the sub-project path prefix, not by a separate commit SHA.

**A-4: The cloud service is operated by the claudemem team (SaaS) in the MVP.** Self-hosted cloud deployment is a future option, but not an MVP requirement.

**A-5: Team members work on connected machines.** The offline/sync scenario (FR-7.3) is a convenience feature, not a primary workflow. Offline-first is not a design goal.

**A-6: Chunk content hashes are stable across platforms.** SHA256 is deterministic given identical source content, regardless of OS or architecture. Line ending normalization (CRLF -> LF) is applied before hashing.

**A-7: The cloud does not need to understand code semantics.** The cloud is a storage and retrieval service for opaque vectors addressed by content hashes. All semantic operations (AST parsing, embedding generation, symbol graph construction) remain local.

**A-8: Commits are immutable.** The system assumes git commits are not rewritten after being shared (no force-push). If a commit SHA is later rewritten, the old cloud index for that SHA becomes orphaned but does not corrupt new indexes.

**A-9: The dirty overlay is best-effort for interactive use.** The overlay provides up-to-date local search for active development, but it does not need to guarantee consistency with partial saves or intermediate editor states. It reflects the last fully-written state of dirty files.

---

## 6. Dependencies

### Internal Dependencies (Existing claudemem Components)

| Component | Role in Cloud Feature | Interface Gap |
|---|---|---|
| `chunker.ts` | Local AST-based chunking (unchanged) | None — already interface-stable |
| `tracker.ts` (FileTracker) | Local dirty file detection via `git status` | Needs `IFileTracker` interface extraction |
| `store.ts` (VectorStore) | Local overlay vector storage | Needs `IVectorStore` interface extraction |
| `embeddings.ts` (IEmbeddingsClient) | Local embedding generation for new/dirty chunks | Already has interface |
| `indexer.ts` | Orchestrates the indexing pipeline | Needs `IChangeDetector` for git-diff-based change detection |
| `lock.ts` (IndexLock) | Prevents concurrent local overlay writes | Needs `IIndexLock` interface extraction |
| `git/hook-manager.ts` | Post-commit hook for triggering cloud sync | Hook script needs to call `claudemem index --cloud` |
| `core/index-version.ts` | Version tracking for local index | Cloud index format versioning is separate |
| `mcp-server.ts` (ToolDeps) | DI container for MCP tools | Needs `ICloudIndexClient` added to ToolDeps |

### New Abstractions Required

| Abstraction | Description |
|---|---|
| `IVectorStore` | Interface extracted from concrete `VectorStore` class (~15 methods). Allows `LocalVectorStore` and `CloudVectorStore` implementations. |
| `IFileTracker` | Interface extracted from concrete `FileTracker` class (~25 methods). Required for overlay tracker vs. cloud-aware tracker. |
| `IIndexLock` | Interface extracted from concrete `IndexLock` class (4 methods: `acquire`, `release`, `heartbeat`, `isLocked`). |
| `IChangeDetector` | New interface: detects which files changed between two git commits. Implementations: `GitDiffChangeDetector` (cloud path) and `FilesystemChangeDetector` (existing mtime/hash path). |
| `ICloudIndexClient` | New interface: cloud API client. Methods include `getChunksByHashes`, `uploadChunks`, `queryVectors`, `getCommitIndex`, `checkChunksExist`. |
| `IOverlayIndex` | New interface: manages the local dirty-file overlay. Methods: `rebuild`, `invalidate`, `isStale`, `search`. |

### External Dependencies (New)

| Dependency | Purpose | Notes |
|---|---|---|
| Cloud REST API (claudemem SaaS) | Store and retrieve commit indexes, vectors, enrichment | TLS-only; version-negotiated |
| OS Keychain integration | Secure credential storage | Use `keytar` npm package or `@keytar/keytar`; fallback to file |
| Git CLI (`git diff`, `git status`, `git log`) | Change detection, dirty file detection | Already partially used via hook-manager; expand to subprocess calls |

### External Dependencies (Existing, Unchanged)

- tree-sitter WASM grammars (local AST parsing)
- LanceDB (local vector storage for overlay)
- SQLite via `bun:sqlite` / `better-sqlite3` (local metadata for overlay)
- `IEmbeddingsClient` implementations (OpenRouter, Voyage AI, Ollama, LMStudio)
- `ILLMClient` implementations (Anthropic, OpenRouter, Claude Code subprocess, Ollama)

---

## 7. Out of Scope

The following are explicitly excluded from this design:

- **Real-time collaboration**: Multiple developers editing the same file simultaneously and seeing each other's search results live. This requires WebSocket infrastructure not planned for the MVP.
- **Code review integration**: Indexing PR diffs or GitHub/GitLab review comments.
- **Cross-repository search**: Searching across multiple repositories in a single query.
- **Repository hosting**: claudemem does not host or mirror source code. It only stores derived artifacts (vectors, hashes, metadata).
- **Index migration**: Automatically migrating existing local indexes to the cloud format. Developers start fresh with the cloud index.
- **Billing and usage metering**: Tracking per-team API usage for billing purposes. This is a cloud service concern, not a client concern.
- **Windows support for keychain integration**: Keychain fallback to file-based credentials is acceptable for the MVP.
