# Architecture Alternatives: Cloud/Team claudemem

**Session**: dev-arch-20260303-110649-56cc19cc
**Date**: 2026-03-03
**Status**: Draft

---

## Summary

This document presents three architecture alternatives for the cloud/team claudemem system. The central architectural question is: **where does the boundary between client and server live?**

The three alternatives stake out fundamentally different positions:

| Alternative | Client responsibility | Server responsibility | Privacy model |
|---|---|---|---|
| 1. Thin Cloud | AST + Embedding + Graph + Enrichment | Store + Query | Client never sends code; server stores opaque vectors |
| 2. Smart Cloud | AST parsing only | Embedding + Graph + Search | Client sends chunks (no source); server is semantically aware |
| 3. Git-Native | All computation | None (git is the store) | Zero network exposure; git hosting is the trust boundary |

---

## Alternative 1: "Thin Cloud" — Cloud is a Dumb Vector Store + Metadata DB

### 1. Overview and Approach

The client does all meaningful computation. The cloud is a content-addressed blob store that receives opaque vectors and returns ranked results for a given query vector. The cloud has no understanding of code structure, embeddings, or graph topology.

The core insight is that the client already has `IEmbeddingsClient`, AST parsing, symbol graph, and PageRank. The cloud adds only two capabilities the client cannot have alone: shared persistence across developers and commit-addressed indexing so teams stop duplicating work.

The client performs:
- `git diff <parent>...<HEAD>` to identify changed files
- AST parsing (tree-sitter) of changed files to produce chunks
- Content hash deduplication (query cloud: "which of these hashes are already stored?")
- Local embedding generation for only the missing hashes
- Upload: `(contentHash, embeddingVector, chunkMetadata)` tuples
- Commit index write: mapping `commitSha -> [contentHash]` for changed files; inheriting unchanged file hashes from the parent commit record
- PageRank computation locally using the full symbol graph stored in the cloud metadata
- Search: embed query locally, send query vector to cloud, receive ranked `(contentHash, score, metadata)` tuples

### 2. Component / Module Structure

```
┌──────────────────────────────────────────────────────┐
│                   CLIENT (CLI / MCP)                  │
│                                                       │
│  src/cloud/                                           │
│  ├── client.ts           ICloudIndexClient impl       │
│  ├── auth.ts             token storage + keychain     │
│  ├── uploader.ts         batch upload orchestration   │
│  ├── diff-detector.ts    GitDiffChangeDetector        │
│  └── overlay/                                         │
│      ├── overlay-index.ts  IOverlayIndex impl         │
│      └── overlay-merger.ts merge cloud + overlay      │
│                                                       │
│  src/core/ (unchanged)                                │
│  ├── chunker.ts          AST chunking (local only)    │
│  ├── embeddings.ts       IEmbeddingsClient            │
│  ├── reference-graph.ts  PageRank (local only)        │
│  ├── store.ts            LanceDB (overlay storage)    │
│  └── tracker.ts          FileTracker (SQLite)         │
│                                                       │
│  src/cli.ts              --cloud flag on index cmd    │
│  src/mcp/server.ts       ToolDeps + ICloudIndexClient │
└───────────────────┬──────────────────────────────────┘
                    │  HTTPS (REST, TLS 1.2+)
                    │  Requests: query vectors, upload tuples
                    │  Responses: ranked content hashes + metadata
                    ▼
┌──────────────────────────────────────────────────────┐
│              CLOUD SERVICE (Thin)                     │
│                                                       │
│  api/                                                 │
│  ├── POST /v1/chunks/check     hash existence check   │
│  ├── POST /v1/chunks/upload    store (hash,vec,meta)  │
│  ├── POST /v1/commits          write commit index     │
│  ├── GET  /v1/commits/:sha     read commit index      │
│  └── POST /v1/search           ANN search by vector   │
│                                                       │
│  storage/                                             │
│  ├── chunk_store               content-addressed blobs│
│  │   Key: (org/repo, contentHash)                     │
│  │   Value: (float32[] vector, metadata JSON)         │
│  ├── commit_index              commit -> chunk refs   │
│  │   Key: (org/repo, commitSha)                       │
│  │   Value: {files: {filePath: [contentHash]}}        │
│  └── vector_index              ANN index per repo     │
│       Partitioned by (org/repo, commitSha)            │
└──────────────────────────────────────────────────────┘
```

**New client-side modules required:**

| Module | Description |
|---|---|
| `src/cloud/client.ts` | Implements `ICloudIndexClient`; all HTTP calls |
| `src/cloud/auth.ts` | API token management; OS keychain + file fallback |
| `src/cloud/uploader.ts` | Orchestrates diff detect -> hash check -> embed -> upload |
| `src/cloud/diff-detector.ts` | `IChangeDetector` via `git diff`; implements `GitDiffChangeDetector` |
| `src/cloud/overlay/overlay-index.ts` | Local overlay using existing LanceDB + SQLite stack |
| `src/cloud/overlay/overlay-merger.ts` | Merges cloud search results with overlay, suppresses stale dirty-file hits |

### 3. Data Flow

#### Indexing Flow (per commit)

```
Developer runs: claudemem index --cloud
                        │
         ┌──────────────▼──────────────┐
         │  GitDiffChangeDetector      │
         │  git diff <parent>...<HEAD> │
         │  → {added, modified,        │
         │     deleted} file sets      │
         └──────────────┬──────────────┘
                        │ changed file paths
         ┌──────────────▼──────────────┐
         │  Chunker (local)            │
         │  AST parse changed files    │
         │  → chunks[] with metadata   │
         └──────────────┬──────────────┘
                        │ chunks with contentHash
         ┌──────────────▼──────────────┐
         │  CloudClient.checkHashes()  │
         │  POST /v1/chunks/check      │
         │  → {known: [], missing: []} │
         └──────────────┬──────────────┘
                  missing hashes only
         ┌──────────────▼──────────────┐
         │  IEmbeddingsClient (local)  │
         │  embed missing chunks       │
         │  → float32[] per chunk      │
         └──────────────┬──────────────┘
                        │ (hash, vector, metadata) tuples
         ┌──────────────▼──────────────┐
         │  CloudClient.uploadChunks() │
         │  POST /v1/chunks/upload     │
         │  batch=50 chunks per req    │
         └──────────────┬──────────────┘
                        │ upload confirmed
         ┌──────────────▼──────────────┐
         │  CloudClient.writeCommit()  │
         │  POST /v1/commits           │
         │  body: {                    │
         │    commitSha,               │
         │    parentSha,               │
         │    files: {                 │
         │      "src/foo.ts": [hash1], │
         │      "src/bar.ts": [hash2]  │
         │    },                       │
         │    deletedFiles: [...]      │
         │  }                          │
         │  Server merges parent index │
         │  + changed files + deletes  │
         └─────────────────────────────┘

Unchanged files: server copies contentHash refs from parent
                 commit record — no re-upload, O(1) per file.

Symbol graph / PageRank:
  Client downloads symbol metadata for all files in commit
  (via GET /v1/commits/:sha/symbols), rebuilds graph locally,
  recomputes PageRank, uploads updated PageRank scores back
  as chunk metadata patch (PATCH /v1/commits/:sha/pagerank).
```

#### Search Flow (cloud + overlay merge)

```
User runs: claudemem search "parse AST nodes"
                        │
         ┌──────────────▼──────────────┐
         │  OverlayMerger              │
         │  1. git status --porcelain  │
         │  2. Check overlay staleness │
         │  3. Rebuild overlay if stale│
         └──────┬──────────────┬───────┘
                │              │
    ┌───────────▼──┐    ┌──────▼────────────┐
    │ Cloud Search │    │ Overlay Search     │
    │              │    │                   │
    │ 1. Embed     │    │ 1. Embed query    │
    │    query     │    │    locally        │
    │    locally   │    │ 2. Vector search  │
    │ 2. POST      │    │    LanceDB overlay│
    │    /v1/search│    │    (local only)   │
    │    {vector,  │    │ 3. Return results │
    │    commitSha,│    │    tagged dirty:  │
    │    limit}    │    │    true           │
    │ 3. Receive   │    └──────┬────────────┘
    │    (hash,    │           │
    │    score,    │           │
    │    metadata) │           │
    └───────┬──────┘           │
            │                  │
         ┌──▼──────────────────▼─┐
         │  OverlayMerger.merge() │
         │                        │
         │  1. Collect dirty paths│
         │     from overlay       │
         │  2. Filter cloud results│
         │     removing any result│
         │     whose filePath is  │
         │     in dirty set       │
         │  3. Interleave cloud + │
         │     overlay by score   │
         │  4. Return merged list │
         └────────────────────────┘
```

### 4. Technology Choices for the Cloud Service

| Layer | Choice | Rationale |
|---|---|---|
| API framework | Go (net/http or Chi) or Node.js (Fastify) | Go preferred for low latency and simple binary deployment; Fastify acceptable given team TypeScript familiarity |
| ANN vector index | Qdrant (self-hosted) or pgvector (PostgreSQL) | Qdrant: native ANN, payload filtering by commitSha; pgvector: simpler ops if already running Postgres |
| Commit index store | PostgreSQL | Relational: commit -> file -> [contentHash] with parent inheritance query is a natural JOIN |
| Chunk metadata store | PostgreSQL JSONB or DynamoDB | JSONB for flexibility; DynamoDB if serverless ops preferred |
| Content-addressed chunk blobs | S3-compatible object store (AWS S3, Cloudflare R2) | contentHash as key; immutable; cheap at scale |
| Authentication | JWT signed with org secret; short-lived tokens | Simple; compatible with all HTTP/1.1 clients |
| Hosting | Single-region container (AWS ECS Fargate, Fly.io) | Low operational complexity for MVP |

The ANN index is partitioned per `(org, repo)`. For search, the cloud filters vectors to only those belonging to the current `commitSha` using vector store payload filters (Qdrant) or a PostgreSQL WHERE clause (pgvector). This avoids separate index tables per commit while maintaining per-commit scoping.

### 5. Per-Commit Index Storage Data Model

The commit index is a normalized relational structure. Unchanged files are stored by reference, not by value.

```
Table: commit_indexes
  PK: (org_id, repo_id, commit_sha)
  Fields:
    parent_sha      TEXT          -- parent commit SHA (nullable for root)
    created_at      TIMESTAMP
    status          ENUM(pending, complete, failed)
    embedding_model TEXT          -- e.g. "voyage-code-3"
    embedding_dim   INTEGER       -- e.g. 1024

Table: commit_file_chunks
  PK: (org_id, repo_id, commit_sha, file_path)
  Fields:
    content_hashes  TEXT[]        -- ordered list of chunk hashes for this file
    -- No actual chunk content or vectors stored here
    -- All chunk data lives in chunk_store keyed by content_hash

Table: chunk_store
  PK: (org_id, repo_id, content_hash)
  Fields:
    embedding_vector  VECTOR(1024) -- stored in pgvector or Qdrant payload
    chunk_type        TEXT         -- function, class, method, file, etc.
    name              TEXT         -- symbol name
    signature         TEXT         -- function signature (no body)
    language          TEXT
    start_line        INTEGER
    end_line          INTEGER
    enrichment_text   TEXT NULLABLE  -- LLM summary (opt-in upload)
    created_at        TIMESTAMP
```

**Commit index construction (diff-based inheritance):**

When a client writes a new commit `C` with parent `P`:

1. Server copies all rows from `commit_file_chunks` where `commit_sha = P` into new rows with `commit_sha = C`.
2. Server applies the client's diff payload:
   - For modified/added files: upsert new `content_hashes` arrays for those file paths.
   - For deleted files: delete those file path rows from the `C` partition.
3. Server sets `status = complete` on `commit_indexes` row for `C`.

This makes write cost proportional to the number of changed files, not total repo size. Reads are a single JOIN: `SELECT content_hashes FROM commit_file_chunks WHERE commit_sha = :sha`.

### 6. Diff-Based Reindexing Step-by-Step

```
Step 1: Resolve parent commit
  git log --format="%P" -n 1 <HEAD>
  → parent_sha (or null for initial commit)

Step 2: Compute file-level diff
  git diff --name-status <parent_sha> <HEAD>
  → Added (A), Modified (M), Deleted (D), Renamed (R) file list

Step 3: Fetch parent commit index (for reference)
  GET /v1/commits/<parent_sha>
  → {files: {filePath: [contentHash[]]}}
  (Used to confirm parent exists; server uses it server-side for inheritance)

Step 4: Chunk added + modified files (local)
  For each A/M file:
    chunker.chunkFile(filePath) → CodeChunk[]
    For each chunk:
      chunk.contentHash = sha256(chunk.content after CRLF normalization)

Step 5: Hash deduplication check
  POST /v1/chunks/check
  Body: {hashes: [contentHash, ...]}  -- up to 1000 per request
  Response: {known: [hash...], missing: [hash...]}

Step 6: Embed missing chunks (local)
  IEmbeddingsClient.embed([missing chunk texts])
  → float32[][] vectors

Step 7: Upload missing chunks
  POST /v1/chunks/upload
  Body: [{
    contentHash,
    vector: float32[],
    chunkType, name, signature, language, startLine, endLine
  }, ...]
  Batch size: 50 chunks per HTTP request

Step 8: Write commit index
  POST /v1/commits
  Body: {
    commitSha: "<HEAD>",
    parentSha: "<parent_sha>",
    embeddingModel: "voyage-code-3",
    files: {
      "src/foo.ts": ["hash_a", "hash_b"],   -- changed files only
      "src/bar.ts": ["hash_c"]
    },
    deletedFiles: ["src/old.ts"]
  }
  Server action:
    1. BEGIN TRANSACTION
    2. INSERT commit_indexes row (status=pending)
    3. Copy all commit_file_chunks rows from parent_sha to HEAD sha
    4. For each file in body.files: UPSERT commit_file_chunks
    5. For each file in body.deletedFiles: DELETE from commit_file_chunks
    6. UPDATE commit_indexes SET status=complete
    7. COMMIT

Step 9: Symbol graph update (async, optional)
  Client rebuilds reference graph from symbol metadata
  (downloaded as part of chunk metadata in step 8 response)
  Runs PageRank locally
  PATCH /v1/commits/<HEAD>/pagerank
  Body: {symbolId -> pageRankScore}
  Server stores as chunk metadata updates
```

**Merge commit handling:** For commits with multiple parents `P1, P2`, the client runs `git diff P1 <HEAD>` and `git diff P2 <HEAD>`, takes the union of changed files, deduplicates, and proceeds from Step 4. The server inherits from the first parent `P1` (by convention, the branch being merged into), then applies the full union diff.

### 7. Local Overlay Merge at Search Time

The overlay is built once per dirty-file-set fingerprint and lives at `{project}/.claudemem/overlay/`.

```
Overlay staleness check (at query time):
  1. git status --porcelain → current dirty file set D_current
  2. Compute fingerprint: sha256(sorted D_current paths + mtimes)
  3. Compare with stored fingerprint in overlay/metadata.json
  4. If different → rebuild overlay (async, blocks first query)

Overlay build (for dirty files):
  For each file in D_current:
    chunker.chunkFile(filePath) → chunks[]
    IEmbeddingsClient.embed(chunks) → vectors[]
    Write to overlay LanceDB at .claudemem/overlay/vectors/
    Write to overlay SQLite at .claudemem/overlay/index.db
  Write new fingerprint to overlay/metadata.json
  No LLM enrichment (FR-3.5 requirement)

Search merge (OverlayMerger):
  parallel:
    cloud_results = CloudClient.search({
      queryVector: embed(queryText),
      commitSha: git rev-parse HEAD,
      limit: 20
    })

    overlay_results = overlayStore.search({
      queryVector: embed(queryText),  -- reuse cached vector
      limit: 10
    })

  dirty_paths = Set(D_current file paths)

  filtered_cloud = cloud_results.filter(r =>
    !dirty_paths.has(r.filePath)
  )

  merged = interleave(filtered_cloud, overlay_results, by=score)
           .slice(0, requestedLimit)

  return merged
```

The query vector is computed once and shared between cloud and overlay searches (both are async parallel calls). The overlay embed call reuses the same local `IEmbeddingsClient` instance used for indexing.

### 8. Pros and Cons

**Pros:**
- Maximum source code privacy: raw source, AST trees, and intermediate representations never leave the machine. The cloud stores only float vectors and metadata with no semantic understanding.
- Satisfies FR-4.1 through FR-4.4 and all `TC-3.*` constraints without special configuration.
- Client remains computation-sovereign: any change to embedding models, chunking strategies, or graph algorithms is a client update only, requiring no server changes.
- The cloud API is extremely simple (5 endpoints): fast to implement, easy to test, and cheap to operate. No ML workloads run server-side.
- Server-side logic is almost purely CRUD + ANN lookup. Horizontal scaling of the read path (search) is trivial.
- Works with any embedding provider the client supports today (Voyage AI, OpenRouter, Ollama, LMStudio) — no cloud-side model management.
- Backward compatibility: local-only mode is unchanged. Cloud is purely additive.

**Cons:**
- Every developer must run embeddings locally. On large commits, embedding compute time dominates indexing latency. The hash deduplication (FR-5.2) mitigates this but only for unchanged content — new files always require local compute.
- Symbol graph and PageRank are computed locally per developer. If two developers upload different PageRank scores for the same commit (e.g., due to slightly different graph resolution), the cloud has inconsistent metadata. Requires a "PageRank is best-effort" policy.
- The client is responsible for managing the entire upload transaction across multiple HTTP requests. A network interruption between Step 7 (upload chunks) and Step 8 (write commit index) leaves orphaned chunks. The server must handle idempotent retry (safe: chunks are content-addressed so re-upload is a no-op).
- ANN index must be scoped per commit, which is the hardest scaling problem: Qdrant payload filtering at commit granularity degrades as the number of commits grows. Periodic index compaction (dropping old commit entries) is required.
- Embedding vectors from different developers using different providers (e.g., one uses Voyage AI, another uses Ollama) are incommensurable. If a team is not uniform on embedding model, the deduplication benefit (FR-5.1) breaks down and results can be incorrect. Requires strict enforcement of a single team-wide embedding model.

### 9. Estimated Complexity

| Work item | Estimate |
|---|---|
| `ICloudIndexClient` interface + HTTP client (`src/cloud/client.ts`) | 3 days |
| `GitDiffChangeDetector` (git subprocess, merge commit handling) | 2 days |
| `uploader.ts` (batch orchestration, progress display) | 2 days |
| `auth.ts` (keychain + file fallback, `team login/logout/status` CLI commands) | 2 days |
| Overlay index (`overlay-index.ts`, `overlay-merger.ts`) | 3 days |
| CLI changes (`--cloud` flag, `sync` command, `watch` daemon cloud mode) | 2 days |
| MCP server `ToolDeps` extension + tool changes | 1 day |
| **Cloud service** (API + PostgreSQL schema + Qdrant/pgvector integration) | 8-10 days |
| Integration tests + local cloud stub | 3 days |
| **Total** | **~26-28 days (~6-7 person-weeks)** |

### 10. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| ANN index per-commit scoping degrades at scale | Medium | High | Use Qdrant payload filters with commit_sha; compact old commits; benchmark at 1000+ commits |
| Developer embedding model divergence breaks deduplication | High | Medium | Enforce team-wide embedding model in config; detect mismatch at upload time and reject with clear error |
| Network interruption leaves orphaned chunks | Medium | Low | Chunks are content-addressed; safe to re-upload. Commit index write is the atomic boundary |
| PageRank inconsistency across developers | Medium | Low | Document as best-effort; use the most recent uploaded PageRank score |
| Hash collision (SHA256) | Very Low | High | Academically negligible at chunk scale |
| Embedding latency on large initial commit | High | Medium | Show progress; parallelize embedding requests; skip enrichment on first cloud upload |

---

## Alternative 2: "Smart Cloud" — Cloud Runs Embedding + Graph Computation

### 1. Overview and Approach

The client's responsibility is narrowed to AST parsing only. The client sends code chunks (content text + metadata, not raw source files) to the cloud. The cloud owns embedding generation, symbol graph construction, PageRank computation, and enrichment orchestration. The cloud becomes a semantically aware index service rather than a dumb store.

The key insight is that by moving embedding and graph computation to the cloud, the team embedding cost is paid once and shared by all developers automatically. A developer who joins an existing project downloads embeddings from the cloud rather than generating them locally — no embedding API key required for search-only workflows.

The client performs:
- AST parsing (tree-sitter) of changed files
- Extracting chunk content and metadata (symbol names, signatures, line ranges, language)
- `git diff` change detection
- Sending chunks to the cloud
- Running the local dirty overlay (still embedded locally for speed)
- Querying the cloud by text (not vector)

The cloud performs:
- Receiving chunk content
- Computing embeddings (server-side embedding model)
- Deduplicating by content hash
- Building the symbol reference graph across all team pushes
- Running PageRank
- Orchestrating LLM enrichment
- Serving hybrid search queries (text in → ranked results out)

Note: This alternative sends chunk content (function bodies, class definitions) to the cloud, which is a meaningful privacy trade-off compared to Alternative 1. However, it satisfies FR-4.1 as written: "raw source code MUST NOT be transmitted" — parsed chunks are derived artifacts, not raw files. Teams with strict zero-source-code-upload requirements should use Alternative 1 or 3.

### 2. Component / Module Structure

```
┌──────────────────────────────────────────────────────┐
│                   CLIENT (CLI / MCP)                  │
│                                                       │
│  src/cloud/                                           │
│  ├── client.ts           ICloudIndexClient impl       │
│  ├── auth.ts             token + keychain             │
│  ├── chunk-sender.ts     sends chunks to cloud        │
│  ├── diff-detector.ts    GitDiffChangeDetector        │
│  └── overlay/                                         │
│      ├── overlay-index.ts  IOverlayIndex (local embed)│
│      └── overlay-merger.ts merge cloud + overlay      │
│                                                       │
│  src/core/ (mostly unchanged)                         │
│  ├── chunker.ts          AST chunking (local only)    │
│  ├── embeddings.ts       IEmbeddingsClient (overlay)  │
│  ├── store.ts            LanceDB (overlay only)       │
│  └── tracker.ts          FileTracker (overlay SQLite) │
│                                                       │
│  Note: IEmbeddingsClient only used for overlay now.   │
│  Cloud indexing no longer calls IEmbeddingsClient.    │
└───────────────────┬──────────────────────────────────┘
                    │  HTTPS (REST, TLS 1.2+)
                    │  Requests: chunk text + metadata
                    │  Responses: search results (text in → results out)
                    ▼
┌──────────────────────────────────────────────────────┐
│              CLOUD SERVICE (Smart)                    │
│                                                       │
│  api/                                                 │
│  ├── POST /v1/chunks/ingest    receive + embed chunks │
│  ├── POST /v1/commits          write commit index     │
│  ├── GET  /v1/commits/:sha     read commit metadata   │
│  ├── POST /v1/search           text query → results   │
│  └── GET  /v1/commits/:sha/graph  symbol graph data   │
│                                                       │
│  services/                                            │
│  ├── embedding-service/    runs embedding model       │
│  │   Embedding model: Voyage AI code-3 (API)          │
│  │   or self-hosted (text-embeddings-inference)       │
│  ├── graph-service/        builds symbol graph        │
│  │   Accumulates symbol defs+refs across commits      │
│  │   Recomputes PageRank on commit write              │
│  ├── enrichment-service/   LLM summaries (async)      │
│  │   Calls ILLMClient (Anthropic/OpenRouter)          │
│  │   Enqueued per content hash; deduplicated          │
│  └── search-service/       hybrid BM25 + ANN          │
│      Embed query → ANN search → rerank → return       │
│                                                       │
│  storage/                                             │
│  ├── chunk_store (content hash → text + vector)       │
│  ├── commit_index (commitSha → file → [hashes])       │
│  ├── symbol_graph (nodes + edges + pagerank)          │
│  └── vector_index (ANN, partitioned by org/repo)      │
└──────────────────────────────────────────────────────┘
```

### 3. Data Flow

#### Indexing Flow

```
Developer runs: claudemem index --cloud
                        │
         ┌──────────────▼──────────────┐
         │  GitDiffChangeDetector      │
         │  git diff <parent>...<HEAD> │
         │  → changed file paths       │
         └──────────────┬──────────────┘
                        │
         ┌──────────────▼──────────────┐
         │  Chunker (local)            │
         │  AST parse changed files    │
         │  Extract:                   │
         │    - chunk text (content)   │
         │    - symbol metadata        │
         │    - symbol references      │
         │    - contentHash            │
         └──────────────┬──────────────┘
                        │
         ┌──────────────▼──────────────┐
         │  ChunkSender                │
         │  POST /v1/chunks/ingest     │
         │  Body: [{                   │
         │    contentHash,             │
         │    content,     ← text sent │
         │    chunkType,               │
         │    name,                    │
         │    signature,               │
         │    language,                │
         │    symbolRefs: [...]        │
         │  }, ...]                    │
         │                             │
         │  Server:                    │
         │    1. Deduplicate by hash   │
         │    2. Queue embedding jobs  │
         │    3. Update symbol graph   │
         │    4. Return {accepted:[],  │
         │               known:[]}     │
         └──────────────┬──────────────┘
                        │
         ┌──────────────▼──────────────┐
         │  Wait for embedding jobs    │
         │  GET /v1/chunks/status      │
         │  Poll until all accepted    │
         │  hashes are embedded        │
         │  (async, server-side)       │
         └──────────────┬──────────────┘
                        │
         ┌──────────────▼──────────────┐
         │  Write commit index         │
         │  POST /v1/commits           │
         │  Body: {commitSha,          │
         │    parentSha,               │
         │    files: {path: [hash]},   │
         │    deletedFiles: [...]}     │
         │                             │
         │  Server triggers:           │
         │    - Commit index merge     │
         │    - PageRank recomputation │
         │    - Enrichment queue drain │
         └─────────────────────────────┘
```

#### Search Flow

```
User runs: claudemem search "parse AST nodes"
                        │
         ┌──────────────▼──────────────┐
         │  OverlayMerger              │
         │  Check overlay staleness    │
         │  Rebuild if needed          │
         └──────┬──────────────┬───────┘
                │              │
    ┌───────────▼──┐    ┌──────▼────────────┐
    │ Cloud Search │    │ Overlay Search     │
    │              │    │                   │
    │  POST        │    │ Embed locally      │
    │  /v1/search  │    │ LanceDB ANN search │
    │  Body: {     │    │ Return dirty results│
    │    query:    │    └──────┬────────────┘
    │      "parse  │           │
    │       AST    │           │
    │       nodes",│           │
    │    commitSha,│           │
    │    limit: 20 │           │
    │  }           │           │
    │              │           │
    │  Server:     │           │
    │    1. embed  │           │
    │       query  │           │
    │    2. ANN    │           │
    │       search │           │
    │    3. rerank │           │
    │    4. return │           │
    │  results     │           │
    └───────┬──────┘           │
            │                  │
         ┌──▼──────────────────▼─┐
         │  OverlayMerger.merge() │
         │  Suppress dirty paths  │
         │  from cloud results    │
         │  Interleave by score   │
         └────────────────────────┘
```

### 4. Technology Choices for the Cloud Service

| Layer | Choice | Rationale |
|---|---|---|
| API framework | Go (Fiber or Chi) | High-throughput for embedding + search hot path |
| Embedding service | Voyage AI API (Voyage Code 3) as SaaS default; text-embeddings-inference for self-hosted | Single model version enforced by cloud; eliminates client-side model diversity problem |
| ANN index | Qdrant | Native payload filtering, fast at 500K+ vectors |
| Symbol graph store | PostgreSQL (graph tables: nodes, edges) | PageRank computed in-process on graph service |
| Enrichment queue | Redis Streams or AWS SQS | Async enrichment processing; deduplication by content hash |
| LLM enrichment | Anthropic claude-haiku-4 or OpenRouter equivalent | Low cost for summary generation; batched |
| BM25 full-text | PostgreSQL tsvector or Tantivy | Hybrid search: combine ANN score + BM25 score |
| Hosting | Multi-container (Kubernetes or ECS) | Separate embedding service, graph service, search service |

The embedding service runs asynchronously relative to the ingest endpoint. The client polls for readiness before writing the commit index, ensuring all vectors are available before the commit is queryable by the team.

### 5. Per-Commit Index Storage Data Model

The data model is similar to Alternative 1 but the `chunk_store` now owns the vector data (computed server-side) and the cloud also maintains a symbol graph.

```
Table: commit_indexes  (same as Alt 1)
Table: commit_file_chunks  (same as Alt 1)

Table: chunk_store
  PK: (org_id, repo_id, content_hash)
  Fields:
    content           TEXT          -- chunk text (source sent by client)
    embedding_vector  VECTOR(1024)  -- computed server-side
    chunk_type        TEXT
    name              TEXT
    signature         TEXT
    language          TEXT
    start_line        INTEGER
    end_line          INTEGER
    enrichment_text   TEXT NULLABLE
    embedding_status  ENUM(pending, complete, failed)
    created_at        TIMESTAMP

Table: symbol_nodes
  PK: (org_id, repo_id, symbol_id)
  Fields:
    name              TEXT
    kind              TEXT          -- function, class, method, etc.
    language          TEXT
    content_hash      TEXT          -- links to chunk_store

Table: symbol_edges
  PK: (org_id, repo_id, from_symbol_id, to_symbol_id)
  Fields:
    reference_kind    TEXT          -- call, import, inherit, etc.
    commit_sha        TEXT          -- most recent commit that added this edge

Table: symbol_pagerank
  PK: (org_id, repo_id, commit_sha, symbol_id)
  Fields:
    pagerank_score    FLOAT
    computed_at       TIMESTAMP
```

The symbol graph is maintained incrementally: each ingest adds/updates symbol nodes and edges. PageRank is recomputed per commit as part of the `POST /v1/commits` handler (triggered after the graph is updated). Full graph recomputation is an O(V + E) operation using power iteration; for most repos this completes in under 5 seconds.

### 6. Diff-Based Reindexing Step-by-Step

```
Step 1: Resolve parent commit (same as Alt 1)
  git log --format="%P" -n 1 <HEAD> → parent_sha

Step 2: Compute file-level diff (same as Alt 1)
  git diff --name-status <parent_sha> <HEAD>
  → {added, modified, deleted, renamed} file sets

Step 3: AST-parse added + modified files (local)
  For each A/M file:
    chunker.chunkFile(filePath) → chunks[]
    Extract symbol definitions and references from each chunk
    contentHash = sha256(normalized chunk content)

Step 4: Send chunks to cloud for ingestion
  POST /v1/chunks/ingest
  Body: {
    chunks: [{
      contentHash,
      content,           ← chunk text
      chunkType, name, signature, language, startLine, endLine,
      symbolDefs: [{id, name, kind, ...}],
      symbolRefs: [{fromId, toName, kind, ...}]
    }],
    orgId, repoId
  }
  Server response: {
    accepted: [contentHash, ...],   -- new chunks queued for embedding
    known:    [contentHash, ...]    -- already embedded, no action needed
  }

Step 5: Poll for embedding completion (for accepted hashes)
  GET /v1/chunks/status?hashes=hash1,hash2,...
  Poll every 2 seconds until status == "complete" for all accepted hashes
  Timeout: 60 seconds (embedding service SLA)

Step 6: Write commit index (triggers PageRank recompute)
  POST /v1/commits
  Body: {
    commitSha, parentSha,
    files: {"src/foo.ts": ["hash_a", "hash_b"]},
    deletedFiles: ["src/old.ts"]
  }
  Server:
    1. Inherit parent's file-chunk mapping (same as Alt 1)
    2. Apply added/modified/deleted diff
    3. Recompute PageRank for the full symbol graph
    4. Update symbol_pagerank table for this commitSha
    5. Mark commit as complete

Step 7: (Async, server-side) Enrichment
  For each accepted content hash:
    If no enrichment exists AND enrichment is enabled for org:
      Enqueue LLM summary job
      LLM generates summary from chunk.content
      Store in chunk_store.enrichment_text
  Client does not wait for enrichment (it is async)
```

Note: Deleted files require updating the symbol graph. The server removes symbol nodes and edges for the deleted file's symbols (identified via the commit_file_chunks mapping for the parent commit). PageRank is then recomputed with those nodes removed.

### 7. Local Overlay Merge at Search Time

The overlay behavior is identical to Alternative 1 in terms of the merge algorithm. The key difference is in how the overlay search is triggered:

- The overlay still embeds locally using `IEmbeddingsClient` (same as today).
- The cloud search sends a text query (not a vector) to the cloud, which embeds it server-side.
- The two search results come back as ranked lists and are merged by the `OverlayMerger`.

One difference: since the cloud embeds the query, and the overlay embeds the query locally, the two score spaces may be incommensurable (different models could produce different score magnitudes). The `OverlayMerger` must normalize scores from both sources to `[0, 1]` before interleaving, using min-max normalization across the combined result set.

The dirty-file suppression logic is identical: any result from the cloud whose `filePath` is in the dirty set is excluded from the merged result.

### 8. Pros and Cons

**Pros:**
- Embedding is computed once per unique chunk, server-side, shared by all team members. A new developer who joins an existing project can immediately search without generating any embeddings (zero API key required if they're not committing).
- Symbol graph and PageRank are authoritative server-side: there is one consistent graph per commit, not per-developer approximations.
- The client code is simpler: no embedding logic for cloud-mode indexing. No embedding provider configuration required for search-only team members.
- LLM enrichment is centralized and deduplicated: one LLM call per unique chunk content hash, not one per developer. Significant cost reduction for large teams.
- BM25 index is owned by the server, which can maintain it incrementally with full text access.
- Search quality can improve server-side without client updates (the cloud can improve reranking, BM25 weights, etc. independently).

**Cons:**
- Chunk content (function bodies, class text) is transmitted to the cloud. This is the most significant privacy trade-off in this alternative. While it does not transmit raw source files, chunk content is highly identifying. Teams with strict source code confidentiality requirements cannot use this alternative.
- The cloud service is substantially more complex: it must run an embedding pipeline, symbol graph management, PageRank computation, enrichment queue, and BM25 indexing. Cloud service build cost is estimated 60-80% higher than Alternative 1.
- Embedding service availability becomes a dependency for cloud indexing. If the cloud embedding service is unavailable, indexing blocks. (Local-only fallback is still available but defeats the shared index purpose.)
- The polling-based embedding status check (Step 5) is inelegant. A client can be held waiting up to 60 seconds if the embedding queue is backed up. Websocket or server-sent events would be cleaner but require infrastructure.
- Cross-client embedding model diversity is eliminated (good), but it means all clients are locked to the server's embedding model. Model upgrades require re-embedding the entire chunk store — an expensive migration.
- The cloud now handles more sensitive compute workloads and must be operated with correspondingly higher security and compliance standards (SOC 2, data residency considerations, etc.).

### 9. Estimated Complexity

| Work item | Estimate |
|---|---|
| `ICloudIndexClient` interface + HTTP client | 2 days |
| `GitDiffChangeDetector` | 2 days |
| `chunk-sender.ts` (send chunks, poll status) | 2 days |
| `auth.ts` + CLI auth commands | 2 days |
| Overlay index + merger (same as Alt 1) | 3 days |
| CLI / MCP server changes (same as Alt 1) | 3 days |
| **Cloud service: API + storage layer** | 6 days |
| **Cloud service: embedding service** | 5 days |
| **Cloud service: symbol graph + PageRank service** | 5 days |
| **Cloud service: enrichment queue + LLM service** | 4 days |
| **Cloud service: hybrid search (BM25 + ANN)** | 4 days |
| Integration tests + local cloud stub | 4 days |
| **Total** | **~42-46 days (~10-12 person-weeks)** |

### 10. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Chunk content privacy rejection by enterprise customers | High | High | Offer Alt 1 or Alt 3 as privacy-preserving tier; clear documentation of what is transmitted |
| Embedding service outage blocks team indexing | Medium | High | Circuit breaker: fall back to local embedding + local storage on cloud unavailability |
| Embedding model lock-in; forced re-embedding on upgrade | Medium | Medium | Version embedding model in chunk_store; keep old embeddings valid until explicit migration |
| Symbol graph consistency on concurrent pushes | Medium | Medium | Use database transactions for graph updates; last-write-wins for edges with same commit context |
| Enrichment cost explosion (LLM per chunk per commit) | Low | Medium | Strict deduplication by content hash; enrichment is opt-in per org; rate limiting |
| Polling for embedding status is a poor UX | High | Low | Acceptable for MVP; plan SSE (server-sent events) upgrade in Phase 2 |
| Complex server; high operational burden | High | Medium | Containerize all services; use managed services (RDS, Qdrant Cloud, SQS) for ops simplicity |

---

## Alternative 3: "Git-Native" — Index is a Git Artifact

### 1. Overview and Approach

There is no separate cloud service at all. The index data is stored as a git artifact — specifically as a **parallel branch** (e.g., `refs/claudemem/<commit-sha>`) containing serialized index data committed by the developer. Team sharing happens through the existing git push/pull workflow against the same git remote (GitHub, GitLab, Gitea, etc.).

Each developer:
1. Indexes locally (existing pipeline, unchanged)
2. Serializes the index into a portable format (JSON/MessagePack or Apache Arrow files)
3. Commits the serialized index to a special parallel branch or uses `git notes` to attach it to the source commit
4. Pushes the index branch to the same git remote

Other developers:
1. Pull the index branch for the commits they care about
2. Deserialize and import into local LanceDB/SQLite
3. Search locally against the imported index (no cloud queries at runtime)

The cloud is simply whatever git hosting the team already uses. No new infrastructure to operate.

### 2. Component / Module Structure

```
┌──────────────────────────────────────────────────────┐
│                   CLIENT (CLI / MCP)                  │
│                                                       │
│  src/git-index/                                       │
│  ├── serializer.ts       serialize LanceDB → files   │
│  ├── deserializer.ts     import files → LanceDB       │
│  ├── publisher.ts        git commit + push index data │
│  ├── fetcher.ts          git fetch + pull index branch│
│  ├── diff-detector.ts    GitDiffChangeDetector        │
│  └── overlay/                                         │
│      ├── overlay-index.ts  (same as Alt 1/2)         │
│      └── overlay-merger.ts (same as Alt 1/2)         │
│                                                       │
│  src/core/ (unchanged for local indexing)             │
│  ├── chunker.ts                                       │
│  ├── embeddings.ts                                    │
│  ├── reference-graph.ts                               │
│  ├── store.ts            LanceDB (primary + overlay)  │
│  └── tracker.ts          FileTracker (SQLite)         │
│                                                       │
│  src/cli.ts              new git-index commands       │
│  src/mcp/server.ts       ToolDeps (local only)        │
└───────────────────┬──────────────────────────────────┘
                    │  git push / git fetch
                    │  (standard git protocol: SSH or HTTPS)
                    │  Index branch: refs/claudemem/*
                    ▼
┌──────────────────────────────────────────────────────┐
│  GIT HOSTING (GitHub / GitLab / Gitea / self-hosted) │
│                                                       │
│  Existing remote repository                           │
│  + claudemem index branch:                            │
│    refs/claudemem/<commit-sha>                        │
│    Contains:                                          │
│      index-manifest.json  -- metadata + chunk list   │
│      chunks/              -- chunk Arrow files        │
│        <hash-prefix>/     -- sharded by hash prefix  │
│          <content-hash>.arrow                         │
│      vectors/             -- embedding Arrow files    │
│        <hash-prefix>/                                 │
│          <content-hash>.arrow                         │
│      symbols/             -- symbol graph data        │
│        nodes.arrow                                    │
│        edges.arrow                                    │
│        pagerank.json                                  │
└──────────────────────────────────────────────────────┘
```

**Storage format on the index branch:**

The index branch is an orphan branch (no parent commits, no shared history with the source branch). Each push to this branch creates a new root commit containing the full index for that source `commitSha`. The branch name encodes the source commit:

```
refs/claudemem/indexes/<commit-sha>
```

Alternatively, using `git notes`:
```
git notes --ref=claudemem/index add -F index-manifest.json <commit-sha>
```

The `git notes` approach is more integrated with git semantics but has worse tooling support and size limits. The orphan branch approach is more predictable and compatible.

### 3. Data Flow

#### Indexing Flow (with git-native publishing)

```
Developer runs: claudemem index --publish
                        │
         ┌──────────────▼──────────────┐
         │  GitDiffChangeDetector      │
         │  git diff <parent>...<HEAD> │
         │  → changed file paths       │
         └──────────────┬──────────────┘
                        │
         ┌──────────────▼──────────────┐
         │  Chunker (local)            │
         │  AST parse changed files    │
         └──────────────┬──────────────┘
                        │
         ┌──────────────▼──────────────┐
         │  IEmbeddingsClient (local)  │
         │  Embed new/changed chunks   │
         └──────────────┬──────────────┘
                        │
         ┌──────────────▼──────────────┐
         │  Local LanceDB + SQLite     │
         │  Store chunks + vectors     │
         │  (existing pipeline)        │
         └──────────────┬──────────────┘
                        │
         ┌──────────────▼──────────────┐
         │  Serializer                 │
         │  Export LanceDB vectors to  │
         │  Apache Arrow files         │
         │  Export SQLite metadata to  │
         │  Arrow or JSON              │
         │  Export symbol graph nodes/ │
         │  edges to Arrow             │
         │  Write index-manifest.json  │
         └──────────────┬──────────────┘
                        │
         ┌──────────────▼──────────────┐
         │  Publisher                  │
         │  git checkout --orphan      │
         │    claudemem/temp           │
         │  git add (index files)      │
         │  git commit -m "index:      │
         │    <source-commit-sha>"     │
         │  git push origin            │
         │    HEAD:refs/claudemem/     │
         │    indexes/<commit-sha>     │
         │  git checkout -             │
         │  (back to original branch)  │
         └─────────────────────────────┘
```

Note on diff-based reindexing: The local pipeline already supports incremental indexing via content hash diffing. When publishing, the serializer only exports the chunks that are new or changed (via diff detection). However, the published index is a **complete** self-contained index for the commit (not just the diff): the serializer merges the current full index with the parent's published index to produce a complete snapshot. This enables consumers to import a single index without needing the parent.

**Practical diff approach for publishing:**
1. Check if parent commit's index branch exists in the remote.
2. If it does: fetch parent index, diff the chunk manifests, upload only the new Arrow files. The manifest references unchanged chunks from the parent index using their content hashes.
3. If parent index does not exist: export the full current index (all chunks).

This means the published index branch is a complete manifest but uses **content-addressed chunk files** shared across commits. Chunks are stored by content hash in a flat directory:

```
refs/claudemem/chunks/<hash-prefix>/<content-hash>.arrow  (shared pool)
refs/claudemem/indexes/<commit-sha>/manifest.json         (per commit)
```

The manifest lists all chunk hashes for the commit. Chunk Arrow files are pushed to the shared pool once and referenced by many manifests.

#### Search Flow (always local after sync)

```
Developer runs: claudemem sync (one-time or on demand)
                        │
         ┌──────────────▼──────────────┐
         │  Fetcher                    │
         │  git fetch origin           │
         │    refs/claudemem/indexes/  │
         │    <HEAD-sha>               │
         │  git fetch origin           │
         │    refs/claudemem/chunks/*  │
         │    (only hashes not local)  │
         └──────────────┬──────────────┘
                        │
         ┌──────────────▼──────────────┐
         │  Deserializer               │
         │  Read manifest.json         │
         │  Import Arrow files into    │
         │  local LanceDB              │
         │  Import symbol graph into   │
         │  local SQLite               │
         └─────────────────────────────┘

Developer runs: claudemem search "parse AST nodes"
                        │
         ┌──────────────▼──────────────┐
         │  (Overlay staleness check)  │
         └──────┬──────────────┬───────┘
                │              │
    ┌───────────▼──┐    ┌──────▼───────────┐
    │ Local Search │    │  Overlay Search   │
    │ (LanceDB)    │    │  (same as Alt 1)  │
    │ Standard     │    └──────┬────────────┘
    │ hybrid search│           │
    └───────┬──────┘           │
            └──────┬───────────┘
                   │
         ┌─────────▼────────────┐
         │  OverlayMerger       │
         │  Suppress dirty paths│
         │  from local results  │
         │  (same logic)        │
         └──────────────────────┘
```

After sync, all searches are fully local — no network calls at query time.

### 4. Technology Choices for the Cloud Service

There is no cloud service to choose. The git hosting is the store. The only technology choices are:

| Concern | Choice | Notes |
|---|---|---|
| Index storage format | Apache Arrow (IPC format) | Cross-language, efficient binary, LanceDB-native for vectors |
| Manifest format | JSON | Human-readable; small per-commit file |
| Git transport | Standard git SSH/HTTPS | Compatible with GitHub, GitLab, Gitea, Bitbucket, any self-hosted |
| Chunk sharding | By first 2 chars of content hash | Avoids too many files in one directory (git tree limits) |
| Git LFS | Optional for large Arrow files | Only needed if chunk Arrow files exceed 100MB per file |
| Large index support | Git LFS pointer files for vectors | LFS handles files > 50MB without bloating git object store |

**Git LFS consideration**: For large repositories with >500K chunks, the vector Arrow files could exceed GitHub's 100MB file size limit. Git LFS is recommended for the `vectors/` subdirectory. LFS support is available on GitHub, GitLab, Gitea, and Bitbucket. Teams without LFS support would need to split vectors into smaller sharded files.

**git notes alternative**: `git notes --ref=claudemem/index` can attach metadata to source commits without creating orphan branches. However, `git notes` are not fetched by default and have poor ecosystem support. The orphan-branch approach is preferred for reliability.

### 5. Per-Commit Index Storage Data Model

The data lives as files on the git index branch, not in a database.

```
refs/claudemem/indexes/<commit-sha>/
  manifest.json
  {
    "schemaVersion": 1,
    "sourceSha": "<commit-sha>",
    "sourceRepo": "github.com/acme/myrepo",
    "embeddingModel": "voyage-code-3",
    "embeddingDim": 1024,
    "createdAt": "2026-03-03T11:00:00Z",
    "files": {
      "src/foo.ts": {
        "chunkHashes": ["abc123", "def456"],
        "inherited": false   -- true if unchanged from parent
      },
      "src/bar.ts": {
        "chunkHashes": ["ghi789"],
        "inherited": true
      }
    },
    "symbolGraph": {
      "nodeCount": 1842,
      "edgeCount": 5621,
      "pagerankFile": "../../pagerank/<commit-sha>.json"
    }
  }

refs/claudemem/chunks/<hash-prefix-2>/<content-hash>.arrow
  Arrow IPC file with schema:
  {
    content_hash: utf8
    chunk_type:   utf8
    name:         utf8
    signature:    utf8
    language:     utf8
    start_line:   int32
    end_line:     int32
    enrichment:   utf8 (nullable)
  }

refs/claudemem/vectors/<hash-prefix-2>/<content-hash>.arrow
  Arrow IPC file with schema:
  {
    content_hash:     utf8
    embedding_vector: fixed_size_list<float32>[1024]
  }

refs/claudemem/symbols/<commit-sha>/
  nodes.arrow    -- symbol definitions
  edges.arrow    -- symbol references
  pagerank.json  -- {symbolId: score}
```

Chunks marked `"inherited": true` in the manifest point to Arrow files that were pushed by a previous commit and already exist in the shared chunk pool. The fetcher skips downloading files it already has locally (checked by content hash / filename existence).

### 6. Diff-Based Reindexing Step-by-Step

```
Step 1: Run standard local incremental indexing
  claudemem index (existing pipeline)
  This uses content hash diffing to update local LanceDB + SQLite
  Only changed/new files are re-chunked and re-embedded locally

Step 2: Check for parent index on remote
  git ls-remote origin refs/claudemem/indexes/<parent-sha>
  → exists or not

Step 3a: If parent index exists
  git fetch origin refs/claudemem/indexes/<parent-sha>
  Read parent manifest.json
  Identify chunks that are in the current index but not in parent
    → new/changed chunks (need publishing)
  Identify chunks in parent but not in current
    → deleted chunks (omit from manifest; do not delete shared files)

Step 3b: If parent index does not exist
  All current local chunks are "new" (full publish)

Step 4: Serialize new/changed chunks
  For each new/changed chunk (not already in shared pool):
    Write to /tmp/claudemem-export/<hash-prefix>/<content-hash>.arrow
    Write to /tmp/claudemem-export/vectors/<hash-prefix>/<content-hash>.arrow

Step 5: Build manifest for current HEAD
  manifest.json:
    For each file in current index:
      if chunks unchanged from parent: inherited = true
      else: inherited = false, list current chunk hashes

Step 6: Push to git remote
  Create orphan branch locally (detached HEAD state)
  git checkout --orphan claudemem-export-temp
  git rm -rf . (clear working tree from orphan)
  Copy serialized files into working tree
  git add .
  git commit -m "claudemem index: <source-sha>"
  git push origin HEAD:refs/claudemem/indexes/<source-sha>
  git push origin HEAD:refs/claudemem/chunks (new chunk files only)
  git checkout - (return to original branch)
  Delete temp orphan branch

Step 7: (Optional) Write shared pool push
  git fetch origin refs/claudemem/chunks
  Merge new chunk files into shared pool branch
  git push origin refs/claudemem/chunks
```

**Performance note on Step 6:** The orphan branch creation and push is a standard git workflow but involves filesystem operations proportional to the number of new chunk files. For a commit changing 20 files with ~5 chunks each (100 Arrow files), this is fast. For an initial commit of a large repo with 10K chunks, this push could be large. Git LFS is critical for the initial publish of large repos.

### 7. Local Overlay Merge at Search Time

The overlay behaves identically to Alternative 1: local dirty files are indexed into `{project}/.claudemem/overlay/` using the existing LanceDB + SQLite stack, and the merger suppresses dirty-path results from the imported cloud index (which is now a local copy after `sync`).

The key difference from Alternatives 1 and 2: after `sync`, there are no runtime network calls. The "cloud results" are just queries against the local LanceDB table that was imported from the synced index. The overlay merger is therefore purely local:

```
Search flow (post-sync, fully local):
  1. Overlay staleness check (same as Alt 1)
  2. Local search against imported index (LanceDB primary table)
  3. Local search against overlay (LanceDB overlay table)
  4. Merge: suppress dirty paths from primary, interleave by score
  5. Return results
```

The trade-off is that search results are only as fresh as the last `sync`. If a teammate pushed a commit 10 minutes ago, the local developer's search results will not include that commit's changes until they run `claudemem sync` again. The `watch` daemon addresses this by running sync automatically when `git fetch` reveals new index refs.

**Watch daemon integration:**
```
claudemem watch (cloud-aware mode):
  1. Watch for local file changes → rebuild overlay (existing behavior)
  2. Also watch for new commits (git log polling or git hook)
     → Trigger claudemem index --publish on each commit
  3. Periodically run git fetch origin refs/claudemem/indexes/*
     → If teammate pushed new index, run claudemem sync
     → Frequency: every 60 seconds (configurable)
```

### 8. Pros and Cons

**Pros:**
- Zero infrastructure to operate. No cloud service to build, deploy, monitor, or pay for. Team sharing is free for teams with existing git hosting.
- Maximum privacy: no data leaves the developer's machine to any new service. The only data transmitted is to the existing git remote the team already trusts. No new trust boundary is introduced.
- Works offline: after `sync`, search is fully local with zero network dependency. Works in air-gapped environments where `CLAUDEMEM_OFFLINE=1` prevents all non-git-remote network calls.
- Self-hostable by definition: any team with a git server (even a bare repository on a shared NFS mount) can use this approach.
- Git provenance: the index is versioned alongside the code. You can trace exactly which developer published which index for which commit. `git log refs/claudemem/indexes/<sha>` shows the full history.
- No embedding vendor dependency for sharing: each developer uses their preferred embedding provider locally. The shared artifact is the vector (float array), not the embedding computation.
- Simplest possible client protocol: git operations. No custom API to design, version, or authenticate. Auth is git remote auth (SSH keys, GitHub tokens, etc.).

**Cons:**
- Git is not designed to store large binary files. Arrow files containing embedding vectors for a large repository can easily exceed 500MB. Without Git LFS, git object store bloat is severe. Git LFS requires separate infrastructure and is not universally available (GitLab self-hosted requires extra setup; some small git servers don't support it at all).
- Embedding vectors from different developers are incommensurable if they use different embedding models. Since each developer computes embeddings locally, the published vectors may use incompatible models. A team member who syncs another developer's index gets vectors in a different embedding space — searches against mixed-model indexes return incorrect results. This is the most serious technical risk.
- Search after sync returns stale results. Unlike Alternatives 1 and 2, where cloud search is always against the latest committed index, this alternative requires an explicit sync step. There is no live cloud index: results are always from the last pull.
- Publishing an index requires git push access to the repository. Developers in read-only or fork-based workflows cannot publish indexes.
- The initial publish for a large repository is a large git push. Even with LFS, the git operations for 500MB+ of Arrow files are slow and can time out. Initial setup for large repos requires special handling.
- Orphan branch management adds git complexity. The repository's `git clone` output includes claudemem branches unless `.gitignore`-style filtering is applied to `git fetch` refspecs in the team's `.git/config`. Developers who don't use claudemem see unfamiliar branches.
- Point-in-time search (FR-1.5) requires fetching and importing an older index, which can be time-consuming.
- No shared embedding deduplication (FR-5.1): every developer recomputes embeddings for all chunks independently. The shared artifact (the vector) saves their teammates from recomputing, but the original indexer still pays full embedding cost.
- No server-side symbol graph: PageRank scores from different developers (using different versions of the chunker or symbol extractor) can produce divergent results when merged. The last-publisher-wins semantics are implicit.

### 9. Estimated Complexity

| Work item | Estimate |
|---|---|
| `serializer.ts` (LanceDB + SQLite → Arrow files) | 4 days |
| `deserializer.ts` (Arrow files → LanceDB import) | 3 days |
| `publisher.ts` (orphan branch create + push) | 3 days |
| `fetcher.ts` (git fetch refspecs + selective download) | 3 days |
| `GitDiffChangeDetector` | 2 days |
| Overlay index + merger (same as Alt 1/2) | 3 days |
| CLI changes (`--publish`, `sync`, `watch` daemon fetch) | 2 days |
| MCP server ToolDeps (no cloud client needed; local search only) | 1 day |
| Git LFS integration (optional but recommended for large repos) | 2 days |
| Integration tests | 3 days |
| **Total** | **~26-28 days (~6-7 person-weeks)** |

Note: The client complexity is similar to Alternative 1, but the server cost is zero. Total team effort is lower but the client work is different (git operations instead of HTTP API calls).

### 10. Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Embedding model divergence across team members | High | Critical | Enforce team-wide embedding model in project `.claudemem/config.json`; validate model metadata before import; reject import if model differs |
| Git object store bloat from large Arrow files | High | High | Require Git LFS for vector files; provide `claudemem check-lfs` pre-flight; document LFS setup in team onboarding |
| Git LFS unavailable in team's hosting setup | Medium | High | Fall back to smaller shard sizes; document limitation clearly; consider chunked commits for very large repos |
| Stale index results (sync required) | High | Medium | Watch daemon auto-sync mitigates for active developers; document sync cadence; show index age in search output |
| Initial publish timeout for large repos | High | Medium | Stream push in multiple batches; retry individual chunk files; provide `claudemem publish --resume` flag |
| Read-only fork workflows cannot publish | Medium | Medium | Out of scope for MVP; document requirement for push access |
| Git repository cluttered with claudemem branches | Medium | Low | Provide `claudemem git-config` command to set local fetch refspecs; hide claudemem refs from default `git branch` |

---

## Comparative Summary

| Dimension | Alt 1: Thin Cloud | Alt 2: Smart Cloud | Alt 3: Git-Native |
|---|---|---|---|
| **Privacy** | Strongest (vectors only) | Moderate (chunk text sent to cloud) | Strongest (git remote only) |
| **Source code leaves machine** | Never | Chunk text (not raw files) | Never |
| **Infrastructure to operate** | Custom cloud service (simple) | Custom cloud service (complex) | None |
| **Embedding cost per team** | Each developer pays for new chunks only; deduplication by hash | Cloud pays once per unique chunk; developers pay nothing for search | Each developer pays for all their own chunks; synced indexes share vectors |
| **Search freshness** | Real-time (cloud query) | Real-time (cloud query) | Sync-dependent (stale until sync) |
| **Search latency** | Cloud round-trip + local embed | Cloud round-trip (no local embed) | Fully local (fastest) |
| **Symbol graph authority** | Per-developer (best-effort consistency) | Server-authoritative (one graph) | Per-developer (publisher wins) |
| **New developer onboarding** | Sync once, then search | Sync once, then search (no local embedding needed) | Run sync, then search fully locally |
| **Offline operation** | Falls back to local-only | Falls back to local-only | Works offline after sync |
| **Self-hostable** | Requires running cloud service | Requires running complex cloud service | Fully self-hostable (any git remote) |
| **Client complexity** | Medium (HTTP client + overlay) | Medium (chunk sender + overlay) | High (git ops + serialization) |
| **Server complexity** | Low (CRUD + ANN) | High (embed + graph + BM25 + enrichment) | None |
| **Total estimated effort** | 6-7 person-weeks | 10-12 person-weeks | 6-7 person-weeks |
| **Primary risk** | Embedding model divergence; ANN per-commit scoping | Chunk content privacy; operational complexity | Embedding model divergence; git LFS; stale results |
| **Recommended for** | Teams wanting real-time search with strong privacy | Teams prioritizing zero client embedding cost; willing to accept chunk-text privacy trade-off | Teams wanting zero infrastructure; self-hosted or air-gapped; offline-first |

### Recommended Approach

**Alternative 1 (Thin Cloud)** is the most balanced choice for the MVP.

It satisfies all source code privacy requirements (FR-4.1 through FR-4.4) with no exceptions, keeps the server extremely simple (fast to build, cheap to operate), and enables real-time cloud search for all team members. The embedding deduplication (FR-5.2) significantly reduces per-developer embedding cost in steady-state workflows while preserving client embedding sovereignty.

Alternative 3 is architecturally elegant and has no operational overhead, but the embedding model divergence risk is severe in practice (teams use different embedding providers), and stale results degrade the core value proposition of shared search. It is appropriate as a secondary offering for teams with strict air-gap requirements.

Alternative 2 should be considered if the team later decides that embedding cost reduction for new developers is a high-priority goal and the chunk-text privacy trade-off is acceptable. It is not recommended for the MVP due to its significantly higher build complexity.
