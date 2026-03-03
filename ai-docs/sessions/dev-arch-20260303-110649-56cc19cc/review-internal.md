# Internal Architecture Review: Cloud/Team claudemem — Dual Mode (Thin + Smart)

**Reviewed**: 2026-03-03
**Reviewer**: Internal Architecture Review
**Document reviewed**: `ai-docs/sessions/dev-arch-20260303-110649-56cc19cc/architecture.md`
**Source files checked**: `src/types.ts`, `src/core/store.ts`, `src/core/tracker.ts`, `src/mcp/tools/deps.ts`

---

## Rating Summary

| Dimension | Rating | Notes |
|---|---|---|
| Completeness | ADEQUATE | Core path solid; several gaps identified |
| Consistency | STRONG | Interface contracts align with existing code |
| Scalability | ADEQUATE | 500K chunks serviceable; 100-dev contention needs attention |
| Security | STRONG | Thin mode privacy guarantee is real and well-documented |
| Operational | ADEQUATE | pgvector choice is sound; cloud service deployment is underspecified |
| Risks | ADEQUATE | Risks identified; mitigations vary in strength |

**Overall verdict: CONDITIONAL**

---

## 1. Completeness — ADEQUATE

### What is present and well-covered

The document covers the full indexing and search path end-to-end, including the overlay lifecycle, merge algorithm, authentication flow, PostgreSQL schema, and all five implementation phases. The interface definitions are concrete and detailed. The testing strategy is mature, with a clear stub hierarchy modelled after the existing `IEmbeddingsClient` pattern.

### Gaps

**1.1 Rate limiting and back-pressure on the client are not specified.**

Section 4.1 mentions that the cloud service enforces rate limits per org, and the response headers are named (`X-RateLimit-Remaining`, `X-RateLimit-Reset`). However, the `ICloudIndexClient` interface has no corresponding retry or back-pressure mechanism. A CI environment with 10 developers pushing simultaneously would hit the `/v1/chunks/check` and `/v1/index` endpoints concurrently. There is no description of:
- How `ThinCloudClient` handles `HTTP 429` responses
- Whether `waitForCommit()` respects `Retry-After` headers
- Whether the `uploadBatchSize` config field is the only throttle available

Without specifying this, implementors will make inconsistent choices across `ThinCloudClient` and `SmartCloudClient`.

**1.2 Initial full-index path is absent.**

The architecture assumes a parent commit exists (`parent_sha` in every upload). Section 3.3 Step 3 says "null for initial commit" but the walkthrough does not explain what happens for the very first `claudemem index --cloud` run on a repository with thousands of files and no prior cloud index. There is no description of:
- How the initial commit is handled server-side when `parent_sha` is null (the inheritance SQL query references `parent.sha = $parent_sha`, which fails if `$parent_sha` is null)
- Whether the initial full index is batched differently (the entire repository, not just a diff)
- How long this takes and whether the CLI shows different progress messaging

This is a real user experience gap: the first run on a large repo is the most expensive operation, and it is the one the architecture does not describe.

**1.3 `claudemem sync` is mentioned but not designed.**

Section 3.4 and Phase 3 acceptance criteria reference a `claudemem sync` command that "downloads and caches the current HEAD commit index locally" for offline use. This command appears in the architecture multiple times but has no:
- API endpoint definition (no download-index or export endpoint in the API contract)
- Local storage format for the cached cloud index
- Lifecycle for when the local cache is invalidated

If `sync` is a Phase 3 deliverable, it needs a design. If it is deferred, the offline degradation story in Section 3.4 ("falls back to the local cache") is broken for Phase 3 MVP.

**1.4 Token refresh flow has a circular dependency.**

Section 4.1 says: "if expired: automatically refreshes using org API key (org API key stored in keychain as `cmk_org_...` under account `acme-corp:apikey`)". This implies the org API key is also stored in the keychain. But the flow for `team login` says the user is prompted for the org API key and the personal token is stored — there is no explicit step that stores the org API key as a separate keychain entry. The refresh path is described in security prose but is not reflected in the `CloudAuthManager` responsibilities or the `team login` step-by-step. An implementor reading only the interface section would not know to store the org API key.

---

## 2. Consistency — STRONG

### Interface contracts verified against existing code

**`IVectorStore.search` signature mismatch (minor):**

The proposed `IVectorStore` interface defines:

```typescript
search(
    query: number[],
    queryText: string,
    limit?: number,
    language?: string,
    pathPattern?: string,
): Promise<SearchResult[]>;
```

The actual `VectorStore.search` in `src/core/store.ts` (line 294) has the signature:

```typescript
async search(
    queryText: string,
    queryVector: number[] | undefined,
    options: SearchOptions = {},
): Promise<SearchResult[]>
```

The parameter order is reversed (the actual class takes `queryText` first, then `queryVector`), and the actual implementation takes an `options` object rather than individual optional parameters. This is a direct inconsistency: implementing `IVectorStore` on the existing `VectorStore` class would require either changing the concrete class's signature (a breaking change) or writing an adapter. The architecture should use the existing signature shape or explicitly call out the breaking change.

**`IVectorStore.close` return type:**

The proposed `IVectorStore` includes `close(): Promise<void>`. The actual `VectorStore` does not expose a `close()` method at all (there is no `close()` in the LanceDB code — the connection is implicitly managed). The actual `FileTracker.close()` exists and is synchronous (`close(): void`, line 464 of tracker.ts). Making `IVectorStore.close()` async is fine if a new implementation requires it, but it is inconsistent with the existing `FileTracker` pattern where `close()` is synchronous and the architecture does not explain this asymmetry.

**`IFileTracker` interface is fully consistent with `FileTracker`:**

All methods listed in the proposed `IFileTracker` interface are present in the actual `FileTracker` class with matching signatures: `getChanges`, `markIndexed`, `getChunkIds`, `removeFile`, `getFileState`, `getAllFiles`, `getMetadata`, `setMetadata`, `getStats`, `clear`, `close`, enrichment methods, document tracking methods, and the full symbol graph method set. This is the strongest part of the architecture document.

**`ToolDeps` extension is realistic:**

The proposed additions to `ToolDeps` (`cloudClient?`, `overlayIndex?`, `currentCommitSha?`, `teamConfig?`) are all optional, consistent with the existing pattern where `reindexer` and `completionDetector` are optional. The existing `ToolDeps` structure in `src/mcp/tools/deps.ts` is simple enough that adding four optional fields is low risk.

**`IEmbeddingsClient` is used correctly:**

The architecture uses `IEmbeddingsClient.embedOne(query)` for query embedding and `IEmbeddingsClient.embed(texts[])` for batch chunk embedding in both the overlay rebuild path and the thin-mode indexing path. Both methods exist on the actual interface in `src/types.ts` (lines 351–354). The usage is consistent.

**`SearchResult` field `source` added in Section 3.4:**

The search flow adds a `source: "cloud" | "overlay"` field to `SearchResult` for debug/display purposes. The existing `SearchResult` type in `src/types.ts` (line 235) does not have this field. This is a type extension that needs to appear either as a new `CloudSearchResult` wrapper type or as an explicit extension of `SearchResult`. The document does not include it in the type definitions in Section 3.1, which means it is undocumented at the type level.

---

## 3. Scalability — ADEQUATE

### 500K chunks assessment

The content-addressed `chunks` table with vectors in Qdrant (or pgvector) handles 500K chunks per repo comfortably, assuming reasonable deduplication across commits (copy-paste code, vendored libraries). The inheritance model is the key scalability enabler: unchanged files are O(1) per file via the INSERT...SELECT SQL pattern, so commit indexing time scales with the number of changed files, not the total repository size.

Estimated numbers for a 500K-chunk repo:
- 500K × 1024 float32 = ~2 GB vector storage per repo
- With pgvector and IVFFlat index, ANN search over 500K vectors is sub-100ms at recall@10=0.95
- The `suppressPaths` filter passed to cloud search adds a SQL `NOT IN` clause on `file_path`, which is a linear scan on the un-indexed `commit_files` table unless a covering index exists. Section 2.1 defines `idx_commit_files_commit` but not an index on `file_path`. For 500K chunks spread across 5K files, this suppression lookup could be slow.

### 100 developers assessment

The concurrent-upload scenario is the weakest scalability point. Section 2.3 notes that "the status transition is guarded by a PostgreSQL advisory lock keyed on `(repo_id, sha)`". This is correct for idempotency but does not address the case where 100 developers push to a monorepo feature branch within a 1-minute window and each triggers `claudemem index --cloud` from a CI hook. This generates:
- 100 simultaneous `POST /v1/chunks/check` requests (up to 500 hashes each = 50K hash lookups)
- 100 simultaneous `POST /v1/index` requests, each trying to acquire the advisory lock for the same `(repo_id, sha)` — 99 of them will queue behind the lock

The document does not describe connection pooling, queue depth limits, or shed load strategy on the cloud service. For a team of 100 with a shared CI pipeline, this is likely to cause lock queue buildup on popular commits.

### Qdrant payload filter architecture

The design (Section 2.2) stores `commit_sha` off the Qdrant payload and instead resolves `content_hash` IDs from PostgreSQL, then passes them as an ID filter to Qdrant. This is architecturally clean but introduces a round-trip: every search requires a PostgreSQL query to get the hash set before Qdrant can be queried. For a commit with 500K chunks, this hash set is large (500K × 32 bytes = 16 MB). Passing 500K IDs as a filter to Qdrant in a single request is not practical. The architecture does not describe how this is chunked or whether ANN pre-filtering (Qdrant's `should`/`must` with payload index) is used instead. This is an implementation risk that should be called out explicitly.

---

## 4. Security — STRONG

### Thin mode privacy guarantee

The privacy guarantee is the strongest design element of the document. The data transmission table in Section 4.3 is clear and correct. Embedding vectors are not generally invertible from the model outputs used here (Voyage AI, Ollama), and the one-way SHA256 hashes provide no source reconstruction path. The "reconstruction risk" section is honest about the smart mode tradeoff.

### What is transmitted in thin mode — signal data concern

The document correctly identifies that symbol names, function signatures, and line numbers are transmitted in thin mode. For some teams (legal, security), function and type names from proprietary code can themselves be sensitive. The document does not acknowledge this as a limitation of the thin mode privacy guarantee, only stating "content hashes are one-way." A team with strict classification requirements should be warned that symbol names and signatures cross the wire even in thin mode. This is not a design flaw, but it is a documentation gap.

### OS Keychain dependency (`keytar`)

The architecture depends on the `keytar` npm package, which requires a native module build and has known issues with certain Node.js runtime environments. `keytar` is also unmaintained (last release 2022). The fallback to `~/.claudemem/credentials.json` at mode 0600 is reasonable for Linux/macOS, but on shared machines (development servers, Docker containers), 0600 on a file owned by the process user is the entire security boundary. This is acceptable for a developer tool but should be documented as a deployment constraint.

### No SSRF/injection surface on the client

The client only calls a fixed cloud API endpoint derived from config. There is no URL construction from user-provided code content (thin mode uploads only hashes and vectors). This is a clean design with minimal injection surface.

---

## 5. Operational — ADEQUATE

### Cloud service deployment

The architecture specifies PostgreSQL + Qdrant (or pgvector) as the cloud backend. The pgvector recommendation for MVP is the right call operationally — it eliminates a second stateful service and is well-supported in managed PostgreSQL (RDS, Cloud SQL, Supabase). The `IVectorSearchBackend` abstraction that would allow switching to Qdrant later is mentioned in Section 2.2 but its interface is not defined anywhere in the document. If the MVP ships with pgvector and a Qdrant migration is planned for Phase 5+, the server-side interface needs to be defined now to avoid retrofitting.

### PageRank computation scaling

Section 3.3 Step 10 defers PageRank computation to a background async job per commit. For large repos with 50K+ symbols, a full PageRank iteration (damping=0.85, max_iter=100) on the complete symbol graph is CPU-intensive. The document does not describe:
- Where this job runs (same API server process, separate worker, queue?)
- What happens if it fails (symbols permanently stuck at `pagerankScore = 0`?)
- Whether there is a retry mechanism

For the MVP, this is acceptable if PageRank is a best-effort feature, but the "status: `ready` even while PageRank is still computing" note in Appendix A should be in the main document, not an appendix question.

### Monitoring and observability

No observability design is present. For a cloud service with a 100-developer team, the following are needed at MVP:
- Structured request logs with `(org_id, repo_id, commit_sha)` on every request
- Latency histograms for `/v1/index`, `/v1/search`, `/v1/chunks/check`
- Alert on: advisory lock queue depth > threshold, Qdrant/pgvector query latency, embedding service failures

The absence of an observability section is a completeness gap but acceptable for a design document (implementation detail), as long as the implementors understand it is required.

---

## 6. Risks — ADEQUATE

### Risk 1: Overlay rebuild blocking user queries (HIGH probability, MEDIUM impact)

Section 3.4 Step 2 states that overlay rebuild "runs concurrently with steps 3–4; overlay search is gated on completion." For a developer with 30 dirty files in a large repo, the overlay rebuild requires:
- Reading all dirty files from disk
- Tree-sitter parsing
- Calling the embedding API for potentially hundreds of chunks

At an average of 200ms per embedding call with batching, rebuilding an overlay for 30 files with 10 chunks each = 300 chunks could take 3–5 seconds via cloud embedding API, or 1–2 seconds via local Ollama. A user typing `claudemem search "..."` would wait that long before seeing any results. The architecture notes this gating but does not propose a mitigation (e.g., returning cloud-only results immediately while overlay rebuilds in background, with a second response refresh).

This is the weakest UX point in the design and the most likely source of user complaints.

### Risk 2: Vector dimension mismatch in shared cloud index (LOW probability, HIGH impact)

Section 2.1 stores `embedding_dim` per repo and returns HTTP 409 if a developer tries to register with a conflicting model. However, consider this scenario: a team uses `voyage-code-3` (dim=1024). One developer switches to a different model locally and uploads a commit. The 409 is returned correctly and the upload is rejected. But the `ThinCloudClient` error handling for this case is not specified — what does the CLI show the developer? Does the error surface clearly enough that the developer understands they need to align their model config?

More critically: the cloud index and the local overlay use different embedding models if a developer overrides `embeddingModel` in local config. Their overlay vectors (dim=768) and cloud vectors (dim=1024) would be merged by `OverlayMerger` using normalized scores, which assumes both score spaces are comparable. They are not. The architecture does not address what happens when local `embeddingModel` differs from the cloud repo's registered `embeddingModel`.

### Risk 3: Git subprocess dependency in `GitDiffChangeDetector` (LOW probability, MEDIUM impact)

The `GitDiffChangeDetector` shells out to `git diff --name-status` and `git status --porcelain`. This is fragile in:
- CI environments where the git working tree is detached or shallow-cloned (no parent commit reachable)
- Git LFS repos where `git status` is slow
- Repos with submodules (git diff output format differs)
- Windows environments with CRLF line endings in `git diff` output

The architecture does not describe how `GitDiffChangeDetector` handles these edge cases. The `IChangeDetector` interface is well-designed for substitution, but the concrete implementation risks are not addressed.

### Risk 4: `overlay.db` TIMESTAMPTZ in SQLite (LOW probability, LOW impact)

Section 2.4 defines `overlay.db` with columns using `TIMESTAMPTZ` type. SQLite has no native `TIMESTAMPTZ` type — it stores all datetime values as TEXT, REAL, or INTEGER and does not enforce or interpret timezone information. The existing `tracker.ts` correctly uses `TEXT NOT NULL` for timestamp columns (e.g., `indexed_at TEXT NOT NULL`). The overlay schema should match the existing pattern (`TEXT NOT NULL`) for consistency. This is a minor schema documentation error but could cause confusion if a developer copies the SQL verbatim.

---

## 3 Specific Improvement Suggestions

### Suggestion 1: Resolve the `IVectorStore.search` signature conflict before Phase 1 ships

The proposed `IVectorStore.search(query: number[], queryText: string, ...)` conflicts with the actual `VectorStore.search(queryText: string, queryVector: number[] | undefined, options: SearchOptions)`. This must be resolved in Phase 1 (interface extraction). The recommended resolution is to use an options object matching the existing class:

```typescript
export interface IVectorStore {
    search(
        queryText: string,
        queryVector: number[] | undefined,
        options?: {
            limit?: number;
            language?: string;
            filePath?: string;
            pathPattern?: string;
            keywordOnly?: boolean;
            useCase?: SearchUseCase;
        },
    ): Promise<SearchResult[]>;
    // ...
}
```

This allows `VectorStore` to implement `IVectorStore` without any signature change. Do not invert the parameter order — it would require touching every call site in the codebase.

### Suggestion 2: Define the overlay rebuild concurrency contract explicitly, with a fallback path

The overlay rebuild blocking query latency (Risk 1) is the most user-visible risk in the design. The architecture should specify one of two strategies and document the choice:

**Option A (Stale-while-revalidate):** Return cloud results immediately (suppressing dirty file paths), then trigger an async overlay rebuild. Return a second result set via a streaming or polling mechanism once the overlay is ready. This is more complex but provides immediate results.

**Option B (Short-circuit with threshold):** If the overlay rebuild is estimated to take longer than a configurable threshold (e.g., 2 seconds), skip the overlay and return cloud-only results with a user-visible notice: `"Dirty files not indexed in this search (overlay rebuilding in background). Run again when ready."` This is simpler and acceptable for most workflows.

Without specifying this, Phase 3 implementors will make ad-hoc choices about the blocking behavior, leading to inconsistent UX across the CLI and MCP server.

### Suggestion 3: Add a missing-chunks handling specification for the initial full-index path

Define explicitly what happens on the first `claudemem index --cloud` for a repository with no prior cloud index. This requires:

1. A note in Section 3.3 Step 3 that when `parent_sha` is null (initial commit or no prior cloud index found), the server's inheritance SQL query is skipped entirely and all files are treated as changed.
2. Guidance on batch size: a 500K-chunk initial index cannot be uploaded in a single `POST /v1/index` request. The `uploadBatchSize` config field (default: 500 chunks) should be described as also governing multi-batch initial uploads, with the document explaining that the server handles partial uploads for the same `commitSha` idempotently.
3. A progress message pattern: `"Initial index: embedding 500 / 12,847 chunks..."` distinct from the incremental `"Embedding 3 new chunks (8 already in cloud)..."` message used for subsequent commits.

---

## Overall Verdict: CONDITIONAL

The architecture is well-reasoned and the core design is sound. The thin/smart dual-mode privacy model is a genuinely good design choice. The content-addressed chunk store with commit inheritance is elegant and scales correctly. The interface extraction strategy in Phase 1 is the right way to introduce testability without destabilizing existing functionality.

The conditional is based on three blockers that must be resolved before implementation begins:

1. The `IVectorStore.search` signature conflict must be corrected in the architecture document to avoid a Phase 1 breaking change.
2. The overlay rebuild blocking behavior must be given a concrete specification (Option A or B above) before Phase 3 implementation.
3. The initial full-index path must be described, as it is the first experience every team member will have with the system.

The remaining gaps (monitoring, sync design, token refresh flow detail, TIMESTAMPTZ typo) are addressable during implementation without requiring a document revision.
