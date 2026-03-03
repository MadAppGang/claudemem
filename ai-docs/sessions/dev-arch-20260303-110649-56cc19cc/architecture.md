# Architecture: Cloud/Team claudemem — Dual Mode (Thin + Smart)

**Session**: dev-arch-20260303-110649-56cc19cc
**Date**: 2026-03-03
**Status**: Final

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Data Design](#2-data-design)
3. [Technical Specifications](#3-technical-specifications)
4. [Security Design](#4-security-design)
5. [Implementation Plan](#5-implementation-plan)
6. [Testing Strategy](#6-testing-strategy)

---

## 1. System Overview

### 1.1 Purpose

Cloud/team claudemem extends the single-developer local tool into a shared, git-commit-addressed search index. All team members working at the same commit share one canonical cloud index, eliminating redundant embedding computation and enabling instant onboarding for new developers.

Two configurable modes govern how data flows between client and cloud:

- **`cloud_mode: "thin"`** (default): The client computes all embeddings locally, uploads only float vectors + content hashes + metadata. Source code and chunk text never leave the developer's machine. Privacy-first.
- **`cloud_mode: "smart"`**: The client sends chunk text and metadata to the cloud; the cloud computes embeddings centrally. Lower embedding API cost. Suitable for teams without strict source-code-off-device requirements.

Both modes share the same cloud API contract, differ only in which fields are populated in upload requests.

### 1.2 Architecture Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                    DEVELOPER MACHINE                         │
│                                                              │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  claudemem CLI / MCP Server                         │    │
│  │                                                     │    │
│  │  ┌──────────────┐  ┌──────────────────────────────┐ │    │
│  │  │  LocalIndex  │  │  CloudAwareIndexer           │ │    │
│  │  │  (existing)  │  │  (new, additive)             │ │    │
│  │  └──────────────┘  └────────────┬─────────────────┘ │    │
│  │                                 │                   │    │
│  │  ┌──────────────────────────────▼─────────────────┐ │    │
│  │  │  OverlayIndex  (.claudemem/overlay/)           │ │    │
│  │  │  - Dirty files only (git status)               │ │    │
│  │  │  - LanceDB + SQLite (same stack as local)      │ │    │
│  │  │  - Rebuilt lazily when dirty set changes       │ │    │
│  │  └──────────────────────────────────────────────── ┘ │    │
│  │                                                     │    │
│  │  ┌──────────────┐  ┌─────────────────────────────┐ │    │
│  │  │ IEmbeddings  │  │  GitDiffChangeDetector      │ │    │
│  │  │ Client       │  │  (git diff parent..HEAD)    │ │    │
│  │  │ (unchanged)  │  └─────────────────────────────┘ │    │
│  │  └──────────────┘                                  │    │
│  └─────────────────────────────────────────────────────┘    │
│                              │                               │
│         TLS 1.2+  ──────────▼──────────────────────         │
└──────────────────────────────────────────────────────────────┘
                               │
                ┌──────────────▼──────────────────┐
                │    claudemem Cloud API           │
                │    (REST, HTTP/1.1 compatible)   │
                │                                  │
                │  ┌──────────┐  ┌──────────────┐ │
                │  │  Auth    │  │  Index API   │ │
                │  │  Service │  │  /v1/*       │ │
                │  └──────────┘  └──────┬───────┘ │
                │                       │          │
                │  ┌────────────────────▼────────┐ │
                │  │  PostgreSQL                 │ │
                │  │  orgs, repos, commits,      │ │
                │  │  chunks, symbols, enrichment│ │
                │  └────────────────────┬────────┘ │
                │                       │          │
                │  ┌────────────────────▼────────┐ │
                │  │  Qdrant (or pgvector)       │ │
                │  │  Vector search + ANN index  │ │
                │  │  Filtered by commit_sha     │ │
                │  └─────────────────────────────┘ │
                │                                  │
                │  [Smart mode only]               │
                │  ┌─────────────────────────────┐ │
                │  │  Embedding Service          │ │
                │  │  (Voyage AI / cloud model)  │ │
                │  └─────────────────────────────┘ │
                └──────────────────────────────────┘
```

### 1.3 Data Flow: Thin Mode (Indexing)

```
Developer machine                           Cloud
─────────────────────────────               ──────────────
git diff parent..HEAD
  → changed file list
    │
    ▼
tree-sitter AST parse
changed files → chunks
    │
    ▼
SHA256(content) per chunk
    │
    ├──→ POST /v1/chunks/check ─────────────→ [lookup hashes in DB]
    │    {hashes: [...]}       ←─────────────  {existing: [...]}
    │
    ▼ (only missing hashes)
IEmbeddingsClient.embed()
  → float32[] vectors
    │
    ▼
POST /v1/index ──────────────────────────→ store chunks + vectors
  {commitSha, parentSha,                    inherit parent mappings
   chunks: [{hash, vector,                  for unchanged files
             metadata}]}     ←─────────────  {indexed: true}
```

### 1.4 Data Flow: Smart Mode (Indexing)

```
Developer machine                           Cloud
─────────────────────────────               ──────────────
git diff parent..HEAD
  → changed file list
    │
    ▼
tree-sitter AST parse
changed files → chunks
    │
    ├──→ POST /v1/chunks/check ─────────────→ [lookup hashes in DB]
    │    {hashes: [...]}       ←─────────────  {existing: [...]}
    │
    ▼ (only missing hashes)
POST /v1/index ──────────────────────────→ store chunk text
  {commitSha, parentSha,                    trigger cloud embedding
   chunks: [{hash, text,                    (Voyage AI / hosted model)
             metadata}]}     ←─────────────  {indexed: true, status: "embedding"}
    │
    ▼ (polling / webhook)
GET /v1/commits/:sha/status ─────────────→ {status: "ready"|"embedding"|"failed"}
```

### 1.5 Data Flow: Search (Merged Cloud + Overlay)

```
Developer machine
────────────────────────────────────────────────────────
git status → dirty file list
                │
                ▼
OverlayIndex.isStale(dirtyFiles)
  → if stale: rebuild overlay (embed dirty files locally)
                │
                ▼
IEmbeddingsClient.embedOne(query)
  → queryVector: float32[]
                │
          ┌─────┴──────────────────────────┐
          │                                │
          ▼                                ▼
POST cloud /v1/search              OverlayIndex.search(queryVector)
  {commitSha: HEAD,                  (local LanceDB)
   vector: queryVector}
          │                                │
          ▼                                ▼
cloud results (filtered:           overlay results
  exclude dirty paths)             (authoritative for dirty files)
          │                                │
          └──────────────┬─────────────────┘
                         ▼
              OverlayMerger.merge(cloudResults, overlayResults, dirtyPaths)
                - suppress cloud results for dirty files
                - interleave by normalized score
                         │
                         ▼
              SearchResult[] (unified)
```

### 1.6 Key Components

| Component | Location | Responsibility |
|---|---|---|
| `CloudAwareIndexer` | `src/cloud/indexer.ts` | Orchestrates diff-based cloud indexing |
| `ThinCloudClient` | `src/cloud/thin-client.ts` | HTTP client for thin mode (vectors only) |
| `SmartCloudClient` | `src/cloud/smart-client.ts` | HTTP client for smart mode (text upload) |
| `GitDiffChangeDetector` | `src/cloud/git-diff.ts` | Computes changed files via `git diff` |
| `OverlayIndex` | `src/cloud/overlay.ts` | Manages dirty-file local index |
| `OverlayMerger` | `src/cloud/merger.ts` | Merges cloud + overlay search results |
| `CloudAuthManager` | `src/cloud/auth.ts` | Credential storage and token refresh |
| `FilesystemChangeDetector` | `src/core/indexer.ts` | Existing mtime/hash-based detector (unchanged) |
| `VectorStore` (local) | `src/core/store.ts` | Local LanceDB storage (unchanged) |
| `FileTracker` (local) | `src/core/tracker.ts` | Local SQLite tracker (unchanged) |

---

## 2. Data Design

### 2.1 Cloud Database Schema (PostgreSQL)

```sql
-- ============================================================
-- Organizations and repositories
-- ============================================================

CREATE TABLE orgs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug        TEXT UNIQUE NOT NULL,          -- e.g. "acme-corp"
    name        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE repos (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id          UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    slug            TEXT NOT NULL,             -- e.g. "my-repo"
    -- Derived from git remote URL, normalized
    remote_url      TEXT NOT NULL,
    embedding_model TEXT NOT NULL,             -- enforced per-repo
    embedding_dim   INT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, slug)
);

-- ============================================================
-- Commits (one row per indexed commit SHA)
-- ============================================================

CREATE TABLE commits (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    repo_id     UUID NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
    sha         TEXT NOT NULL,                 -- full 40-char git SHA
    parent_sha  TEXT,                          -- null for initial commit
    status      TEXT NOT NULL DEFAULT 'pending',
    -- 'pending' | 'embedding' | 'ready' | 'failed'
    indexed_at  TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (repo_id, sha)
);

CREATE INDEX idx_commits_repo_sha ON commits(repo_id, sha);
CREATE INDEX idx_commits_status ON commits(repo_id, status);

-- ============================================================
-- Content-addressable chunk store
-- One row per unique chunk content hash, across all repos/commits.
-- ============================================================

CREATE TABLE chunks (
    content_hash    TEXT PRIMARY KEY,          -- SHA256 of chunk content
    chunk_type      TEXT NOT NULL,             -- function|class|method|module|block|...
    name            TEXT,                      -- symbol name if available
    parent_name     TEXT,                      -- enclosing class for methods
    signature       TEXT,                      -- function/method signature
    language        TEXT NOT NULL,
    start_line      INT NOT NULL,
    end_line        INT NOT NULL,
    -- NOTE: filePath and line numbers are NOT stored here because the same
    -- content may appear at different paths in different repos (copy-paste,
    -- vendored code). File path is stored in commit_files.
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- Per-commit file → chunk mapping (the "commit index")
-- Unchanged files inherit this mapping from the parent commit
-- via a single server-side SQL copy. No data duplication.
-- ============================================================

CREATE TABLE commit_files (
    id              BIGSERIAL PRIMARY KEY,
    commit_id       UUID NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
    file_path       TEXT NOT NULL,             -- relative path from repo root
    file_hash       TEXT NOT NULL,             -- SHA256 of file content
    chunk_hashes    TEXT[] NOT NULL,           -- ordered list of chunk hashes
    -- chunk order matters for BM25 and display context
    UNIQUE (commit_id, file_path)
);

CREATE INDEX idx_commit_files_commit ON commit_files(commit_id);
CREATE INDEX idx_commit_files_hash ON commit_files(file_hash);

-- ============================================================
-- Embedding vectors (one row per content hash per model version)
-- ============================================================

CREATE TABLE chunk_embeddings (
    content_hash        TEXT NOT NULL REFERENCES chunks(content_hash),
    embedding_model     TEXT NOT NULL,         -- e.g. "voyage-code-3"
    embedding_dim       INT NOT NULL,          -- e.g. 1024
    -- Vectors stored in Qdrant; this table holds metadata only.
    -- qdrant_point_id matches the Qdrant point ID for retrieval.
    qdrant_point_id     UUID NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (content_hash, embedding_model)
);

-- ============================================================
-- Symbol graph (per commit, rebuilt on graph-changing commits)
-- ============================================================

CREATE TABLE symbols (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    commit_id       UUID NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    kind            TEXT NOT NULL,             -- function|class|method|type|...
    file_path       TEXT NOT NULL,
    start_line      INT NOT NULL,
    end_line        INT NOT NULL,
    signature       TEXT,
    is_exported     BOOLEAN NOT NULL DEFAULT false,
    language        TEXT NOT NULL,
    pagerank_score  DOUBLE PRECISION NOT NULL DEFAULT 0,
    in_degree       INT NOT NULL DEFAULT 0,
    out_degree      INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_symbols_commit ON symbols(commit_id);
CREATE INDEX idx_symbols_name ON symbols(commit_id, name);
CREATE INDEX idx_symbols_file ON symbols(commit_id, file_path);
CREATE INDEX idx_symbols_pagerank ON symbols(commit_id, pagerank_score DESC);

CREATE TABLE symbol_references (
    id              BIGSERIAL PRIMARY KEY,
    commit_id       UUID NOT NULL REFERENCES commits(id) ON DELETE CASCADE,
    from_symbol_id  UUID NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
    to_symbol_name  TEXT NOT NULL,
    to_symbol_id    UUID REFERENCES symbols(id),
    kind            TEXT NOT NULL,             -- call|type_usage|import|...
    file_path       TEXT NOT NULL,
    line            INT NOT NULL,
    is_resolved     BOOLEAN NOT NULL DEFAULT false,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_symrefs_commit ON symbol_references(commit_id);
CREATE INDEX idx_symrefs_from ON symbol_references(from_symbol_id);
CREATE INDEX idx_symrefs_to ON symbol_references(to_symbol_id);

-- ============================================================
-- LLM enrichment (optional, opt-in per team)
-- Keyed by content hash so summaries are shared across commits.
-- ============================================================

CREATE TABLE enrichment_docs (
    content_hash    TEXT NOT NULL REFERENCES chunks(content_hash),
    doc_type        TEXT NOT NULL,             -- file_summary|symbol_summary|idiom|...
    content         TEXT NOT NULL,             -- LLM-generated text
    llm_model       TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (content_hash, doc_type)
);
```

**Key design decisions:**

- `chunks` is content-addressed: one row per unique content hash, shared across all repos and commits.
- `commit_files` maps each commit to the set of file paths and their ordered chunk hashes. Unchanged files are inherited via a server-side SQL INSERT...SELECT from the parent commit record — O(1) per unchanged file.
- `chunk_embeddings` references the same content hash, associating it with a Qdrant point ID. Vectors live in Qdrant; PostgreSQL holds only the lookup key.
- Deleted files are absent from `commit_files` for the new commit; the parent's entry is not copied for deleted paths.

### 2.2 Vector Storage (Qdrant)

Each Qdrant point represents one embedded chunk:

```
Point {
    id:        UUID (= chunk_embeddings.qdrant_point_id)
    vector:    float32[dim]
    payload: {
        content_hash:    string,
        chunk_type:      string,
        name:            string | null,
        language:        string,
        embedding_model: string
    }
}
```

Searching for a commit is done with a payload filter against a collection of all vectors for that repo. The filter is applied before ANN, leveraging Qdrant's native payload index. The `commit_sha` is NOT stored in the Qdrant payload — instead, the API server resolves the set of `content_hash` values for the given commit via PostgreSQL, then passes those as an `id` filter or `must` clause to Qdrant. This avoids duplicating Qdrant points per commit.

**Alternative for small deployments:** pgvector extension on PostgreSQL. Eliminates Qdrant operational dependency at the cost of ANN performance at scale (>100K vectors). The `IVectorSearchBackend` server-side interface abstracts this choice.

### 2.3 Per-Commit Index Data Model

```
Commit C (sha="abc123")
├── parent_sha = "def456"
├── status = "ready"
└── commit_files:
    ├── src/core/store.ts  → file_hash=H1  → [chunk_hash_1, chunk_hash_2, ...]
    ├── src/core/tracker.ts → file_hash=H2 → [chunk_hash_3, ...]
    └── src/types.ts       → file_hash=H3  → [chunk_hash_4, chunk_hash_5, ...]
```

**Inheritance from parent commit (server-side, O(N_unchanged)):**

When the client posts commit C with changed files `{src/core/store.ts}`, the server:

```sql
-- Step 1: Copy unchanged files from parent commit
INSERT INTO commit_files (commit_id, file_path, file_hash, chunk_hashes)
SELECT
    $new_commit_id,
    cf.file_path,
    cf.file_hash,
    cf.chunk_hashes
FROM commit_files cf
JOIN commits parent ON cf.commit_id = parent.id
WHERE parent.sha = $parent_sha
  AND cf.file_path NOT IN ($changed_files)   -- exclude changed/deleted files
  AND cf.file_path NOT IN ($deleted_files);

-- Step 2: Insert new/modified file records (from client upload)
INSERT INTO commit_files (commit_id, file_path, file_hash, chunk_hashes)
VALUES ($commit_id, $file_path, $file_hash, $chunk_hashes)
ON CONFLICT (commit_id, file_path) DO UPDATE
  SET file_hash = EXCLUDED.file_hash,
      chunk_hashes = EXCLUDED.chunk_hashes;
```

**Immutability:** Once a commit's `status` transitions to `"ready"`, `commit_files` rows for that commit are immutable. The status transition is guarded by a PostgreSQL advisory lock keyed on `(repo_id, sha)` to handle concurrent uploads of the same commit idempotently.

**Merge commits:** For merge commits with multiple parents, the server takes the union of unchanged files from all parent commit records, deduplicating by `file_path` (last-write-wins per parent order).

### 2.4 Local Overlay Data Model

The overlay is a lightweight local index for uncommitted (dirty) files. It uses the existing LanceDB + SQLite stack at a separate path.

```
{project}/.claudemem/
├── index.db             # existing local index (unchanged)
├── vectors/             # existing LanceDB (unchanged)
└── overlay/
    ├── overlay.db       # SQLite: dirty file fingerprint + overlay metadata
    ├── vectors/         # LanceDB: vectors for dirty file chunks only
    └── .fingerprint     # SHA256 of sorted dirty file paths + mtimes
                         # Used for fast staleness check
```

**Overlay lifecycle:**

1. At query time, call `git status --porcelain` to get dirty file list.
2. Compute fingerprint: `SHA256(sorted(path + ":" + mtime for each dirty file))`.
3. Compare with `.claudemem/overlay/.fingerprint`.
4. If fingerprint changed (stale), rebuild overlay:
   - Delete existing overlay LanceDB vectors.
   - Re-read dirty files from disk.
   - AST-parse, chunk, embed locally (no LLM enrichment).
   - Write chunks to overlay LanceDB.
   - Write new `.fingerprint`.
5. Search overlay LanceDB with the query vector.

**Overlay `overlay.db` schema:**

```sql
CREATE TABLE overlay_state (
    fingerprint     TEXT NOT NULL,             -- current dirty-set fingerprint
    dirty_files     TEXT NOT NULL,             -- JSON array of dirty file paths
    rebuilt_at      TIMESTAMPTZ NOT NULL,
    chunk_count     INT NOT NULL
);

CREATE TABLE overlay_files (
    file_path       TEXT PRIMARY KEY,
    file_hash       TEXT NOT NULL,
    chunk_count     INT NOT NULL,
    indexed_at      TIMESTAMPTZ NOT NULL
);
```

**Result merging (OverlayMerger):**

The merger receives:
- `cloudResults: SearchResult[]` — from cloud API, pre-filtered to exclude dirty file paths
- `overlayResults: SearchResult[]` — from local overlay

The cloud API accepts a `suppressPaths` parameter in the search request, avoiding a client-side filtering pass. The merger normalizes both score sets to [0,1] using min-max normalization (independently per source), then interleaves results by normalized score. The cloud `suppressPaths` field is the canonical suppression mechanism; client-side filtering is a fallback.

### 2.5 Cloud API Contract

**Base URL:** `https://api.claudemem.dev/v1`

**Authentication:** `Authorization: Bearer <token>` on all requests.

**Protocol versioning:** `X-ClaudeMem-Version: 1` header on all requests. Server rejects unknown versions with `HTTP 422` and `{error: "unsupported_version", supported: [1]}`.

---

#### POST /v1/auth/token

Authenticate with org API key to obtain a short-lived personal token.

**Request:**
```json
{
    "orgApiKey": "cmk_org_...",
    "deviceName": "jack-macbook"
}
```

**Response (200):**
```json
{
    "token": "cmt_...",
    "expiresAt": "2026-03-04T11:06:49Z",
    "orgId": "uuid",
    "orgSlug": "acme-corp",
    "scopes": ["index:read", "index:write"]
}
```

---

#### POST /v1/repos/:orgSlug/:repoSlug/register

Register a repository if it does not yet exist. Idempotent.

**Request:**
```json
{
    "remoteUrl": "https://github.com/acme/my-repo.git",
    "embeddingModel": "voyage-code-3",
    "embeddingDim": 1024
}
```

**Response (200):**
```json
{
    "repoId": "uuid",
    "orgSlug": "acme-corp",
    "repoSlug": "my-repo",
    "embeddingModel": "voyage-code-3",
    "embeddingDim": 1024
}
```

**Error (409):** Embedding model mismatch with existing registration.

---

#### POST /v1/chunks/check

Batch check which content hashes already exist in the cloud (for deduplication). Call this before computing embeddings locally.

**Request:**
```json
{
    "repoSlug": "acme-corp/my-repo",
    "hashes": [
        "sha256_abc...",
        "sha256_def...",
        "sha256_ghi..."
    ]
}
```

**Response (200):**
```json
{
    "existing": [
        "sha256_abc...",
        "sha256_def..."
    ],
    "missing": [
        "sha256_ghi..."
    ]
}
```

The client only needs to compute and upload embeddings for `missing` hashes.

---

#### POST /v1/index

Upload chunk vectors (thin mode) or chunk text (smart mode) and record the commit index. The server applies parent inheritance for unchanged files.

**Request (thin mode — `cloudMode: "thin"`):**
```json
{
    "repoSlug": "acme-corp/my-repo",
    "commitSha": "abc123...",
    "parentSha": "def456...",
    "embeddingModel": "voyage-code-3",
    "embeddingDim": 1024,
    "cloudMode": "thin",
    "changedFiles": [
        {
            "filePath": "src/core/store.ts",
            "fileHash": "sha256_file...",
            "deleted": false,
            "chunks": [
                {
                    "contentHash": "sha256_chunk...",
                    "chunkType": "function",
                    "name": "initialize",
                    "parentName": "VectorStore",
                    "signature": "async initialize(): Promise<void>",
                    "language": "typescript",
                    "startLine": 140,
                    "endLine": 165,
                    "vector": [0.123, -0.456, ...]
                }
            ]
        },
        {
            "filePath": "src/deprecated.ts",
            "deleted": true,
            "chunks": []
        }
    ],
    "symbols": [
        {
            "name": "VectorStore",
            "kind": "class",
            "filePath": "src/core/store.ts",
            "startLine": 111,
            "endLine": 1230,
            "isExported": true,
            "language": "typescript"
        }
    ],
    "symbolReferences": [
        {
            "fromSymbolId": "local_uuid_...",
            "toSymbolName": "IEmbeddingsClient",
            "kind": "type_usage",
            "filePath": "src/core/store.ts",
            "line": 183
        }
    ]
}
```

**Request (smart mode — `cloudMode: "smart"`):**
Same as thin mode, but each chunk omits `vector` and instead includes `text: "..."` (the chunk body). The cloud computes embeddings asynchronously.

```json
{
    "cloudMode": "smart",
    "changedFiles": [
        {
            "filePath": "src/core/store.ts",
            "chunks": [
                {
                    "contentHash": "sha256_chunk...",
                    "chunkType": "function",
                    "name": "initialize",
                    "language": "typescript",
                    "startLine": 140,
                    "endLine": 165,
                    "text": "async initialize(): Promise<void> { ... }"
                }
            ]
        }
    ]
}
```

**Response (thin mode, 202 Accepted):**
```json
{
    "commitId": "uuid",
    "status": "ready",
    "inheritedFiles": 124,
    "newChunks": 8,
    "deduplicatedChunks": 3
}
```

**Response (smart mode, 202 Accepted):**
```json
{
    "commitId": "uuid",
    "status": "embedding",
    "pendingChunks": 8,
    "estimatedReadyAt": "2026-03-03T11:07:30Z"
}
```

---

#### GET /v1/commits/:sha/status

Check whether a commit index is ready for search.

**Query params:** `repo=acme-corp/my-repo`

**Response (200):**
```json
{
    "sha": "abc123...",
    "status": "ready",
    "indexedAt": "2026-03-03T11:06:49Z",
    "chunkCount": 3241,
    "fileCount": 89
}
```

**status values:** `"not_found"` | `"pending"` | `"embedding"` | `"ready"` | `"failed"`

---

#### GET /v1/search

Hybrid search (ANN vector + BM25) against the cloud index for a specific commit.

**Request body (POST preferred for large vectors):**

> Note: Although named GET in the API contract for semantic clarity, this endpoint accepts POST with a JSON body to avoid URL length limits for query vectors.

**POST /v1/search**

```json
{
    "repoSlug": "acme-corp/my-repo",
    "commitSha": "abc123...",
    "queryVector": [0.123, -0.456, ...],
    "queryText": "vector store initialization",
    "limit": 20,
    "suppressPaths": ["src/dirty-file.ts"],
    "filters": {
        "language": "typescript",
        "chunkType": "function",
        "pathPattern": "src/core/*"
    }
}
```

**Response (200):**
```json
{
    "results": [
        {
            "contentHash": "sha256_chunk...",
            "filePath": "src/core/store.ts",
            "startLine": 140,
            "endLine": 165,
            "chunkType": "function",
            "name": "initialize",
            "parentName": "VectorStore",
            "signature": "async initialize(): Promise<void>",
            "language": "typescript",
            "score": 0.923,
            "vectorScore": 0.941,
            "keywordScore": 0.789,
            "summary": "Initializes LanceDB connection and creates the code_chunks table.",
            "pagerankScore": 0.0842
        }
    ],
    "totalResults": 47,
    "searchDurationMs": 82
}
```

---

#### GET /v1/symbol/:name

Symbol lookup by name within a commit index.

**Query params:** `repo=acme-corp/my-repo&commit=abc123...&kind=class`

**Response (200):**
```json
{
    "symbols": [
        {
            "id": "uuid",
            "name": "VectorStore",
            "kind": "class",
            "filePath": "src/core/store.ts",
            "startLine": 111,
            "signature": "class VectorStore",
            "isExported": true,
            "pagerankScore": 0.0842
        }
    ]
}
```

---

#### GET /v1/callers/:name

All symbols that reference the named symbol within a commit index.

**Query params:** `repo=acme-corp/my-repo&commit=abc123...`

**Response (200):**
```json
{
    "symbol": { "name": "VectorStore", "kind": "class", ... },
    "callers": [
        {
            "fromSymbol": { "name": "createVectorStore", "filePath": "...", ... },
            "referenceKind": "type_usage",
            "line": 58
        }
    ],
    "totalCallers": 4
}
```

---

#### GET /v1/callees/:name

All symbols that the named symbol depends on.

**Query params:** `repo=acme-corp/my-repo&commit=abc123...`

**Response (200):** Same shape as `/v1/callers/:name`, with `callees` array.

---

#### GET /v1/map

Repo map: top symbols by PageRank for a commit, formatted for LLM context.

**Query params:** `repo=acme-corp/my-repo&commit=abc123...&maxTokens=2000&topN=50`

**Response (200):**
```json
{
    "map": "src/core/store.ts\n  VectorStore (class, rank=0.084)\n  ...",
    "entries": [...],
    "tokenEstimate": 1847
}
```

---

### 2.6 Enrichment Upload (Optional, Opt-In)

Teams that opt in to enrichment upload (`team.uploadEnrichment: true` in config) can also include enrichment docs in the index upload. This is a separate, optional field in the `POST /v1/index` request body:

```json
{
    "enrichmentDocs": [
        {
            "contentHash": "sha256_chunk...",
            "docType": "symbol_summary",
            "content": "VectorStore manages the LanceDB embedded vector database...",
            "llmModel": "claude-sonnet-4-6"
        }
    ]
}
```

The enrichment text is stored in `enrichment_docs` and served in search results as the `summary` field.

---

## 3. Technical Specifications

### 3.1 New TypeScript Interfaces

All new interfaces live in `src/cloud/types.ts` unless otherwise noted. Existing interfaces (`IEmbeddingsClient`, `ILLMClient`, `IDocumentExtractor`) are not modified.

---

#### IVectorStore

Extracted from `VectorStore` class in `src/core/store.ts`. Allows `LocalVectorStore` and `OverlayVectorStore` implementations to be substituted.

```typescript
// src/core/store.ts (interface extracted alongside existing class)

import type {
    ChunkWithEmbedding,
    CodeChunk,
    CodeUnit,
    CodeUnitWithEmbedding,
    BaseDocument,
    DocumentWithEmbedding,
    DocumentType,
    EnrichedSearchOptions,
    EnrichedSearchResult,
    SearchResult,
} from "../types.js";

export interface IVectorStore {
    // Lifecycle
    initialize(): Promise<void>;
    close(): Promise<void>;
    clear(): Promise<void>;

    // Chunk operations
    addChunks(chunks: ChunkWithEmbedding[]): Promise<void>;
    search(
        query: number[],
        queryText: string,
        limit?: number,
        language?: string,
        pathPattern?: string,
    ): Promise<SearchResult[]>;
    deleteByFile(filePath: string): Promise<number>;
    deleteByFileHash(fileHash: string): Promise<number>;
    getChunksWithVectors(filePath: string): Promise<ChunkWithEmbedding[]>;
    getChunkContents(limit?: number): Promise<string[]>;
    getStats(): Promise<{
        totalChunks: number;
        dimension: number | null;
        languages: string[];
    }>;

    // Document operations (enrichment)
    addDocuments(documents: DocumentWithEmbedding[]): Promise<void>;
    searchDocuments(
        query: number[],
        queryText: string,
        options?: EnrichedSearchOptions,
    ): Promise<EnrichedSearchResult[]>;
    deleteByDocumentType(documentType: DocumentType): Promise<number>;
    deleteAllByFile(filePath: string): Promise<number>;
    getDocumentsByFile(
        filePath: string,
        documentType?: DocumentType,
    ): Promise<BaseDocument[]>;
    getDocumentTypeStats(): Promise<Record<DocumentType, number>>;

    // Code unit operations (AST-aware)
    addCodeUnits(units: CodeUnitWithEmbedding[]): Promise<void>;
    getCodeUnitsByFile(filePath: string): Promise<CodeUnit[]>;
    searchCodeUnits(
        query: number[],
        queryText: string,
        limit?: number,
    ): Promise<EnrichedSearchResult[]>;
}
```

---

#### IFileTracker

Extracted from `FileTracker` class in `src/core/tracker.ts`. The full class has ~25 methods; the interface exposes the subset needed by the cloud-aware indexer and overlay index.

```typescript
// src/core/tracker.ts (interface extracted alongside existing class)

import type {
    DocumentType,
    EnrichmentState,
    FileState,
    SymbolDefinition,
    SymbolReference,
    SymbolKind,
    ReferenceKind,
    SymbolGraphStats,
} from "../types.js";
import type {
    FileChanges,
    EnrichmentStateMap,
    TrackedDocument,
} from "./tracker.js";

export interface IFileTracker {
    // File state management
    getChanges(currentFiles: string[]): FileChanges;
    markIndexed(filePath: string, contentHash: string, chunkIds: string[]): void;
    getChunkIds(filePath: string): string[];
    removeFile(filePath: string): void;
    getFileState(filePath: string): FileState | null;
    getAllFiles(): FileState[];

    // Metadata
    getMetadata(key: string): string | null;
    setMetadata(key: string, value: string): void;
    getStats(): { totalFiles: number; lastIndexed: string | null };
    clear(): void;
    close(): void;

    // Enrichment state
    getEnrichmentState(filePath: string): EnrichmentStateMap;
    setEnrichmentState(
        filePath: string,
        docType: DocumentType,
        state: EnrichmentState,
    ): void;
    needsEnrichment(filePath: string, documentType: DocumentType): boolean;
    getFilesNeedingEnrichment(documentType: DocumentType): string[];

    // Document tracking
    trackDocument(doc: TrackedDocument): void;
    trackDocuments(docs: TrackedDocument[]): void;
    getDocumentsForFile(filePath: string): TrackedDocument[];
    deleteDocumentsForFile(filePath: string): void;

    // Symbol graph
    insertSymbol(symbol: SymbolDefinition): void;
    insertSymbols(symbols: SymbolDefinition[]): void;
    getSymbol(id: string): SymbolDefinition | null;
    getSymbolsByFile(filePath: string): SymbolDefinition[];
    getSymbolByName(name: string, kind?: SymbolKind): SymbolDefinition[];
    getAllSymbols(): SymbolDefinition[];
    getTopSymbols(limit: number): SymbolDefinition[];
    deleteSymbolsByFile(filePath: string): void;
    insertReference(ref: SymbolReference): void;
    insertReferences(refs: SymbolReference[]): void;
    getReferencesFrom(symbolId: string): SymbolReference[];
    getReferencesTo(symbolId: string): SymbolReference[];
    updatePageRankScores(scores: Map<string, number>): void;
    updateDegreeCounts(): void;
    getSymbolGraphStats(): SymbolGraphStats;
    clearSymbolGraph(): void;
}
```

---

#### IIndexLock

Extracted from `IndexLock` class in `src/core/lock.ts`.

```typescript
// src/core/lock.ts (interface extracted alongside existing class)

import type { LockOptions, LockResult } from "./lock.js";

export interface IIndexLock {
    /** Attempt to acquire the lock. Returns result indicating success or failure. */
    acquire(options?: LockOptions): Promise<LockResult>;

    /** Release the lock. No-op if not held. */
    release(): void;

    /**
     * Check lock status without acquiring.
     * Returns {locked: true, pid} if a valid non-stale lock exists.
     */
    isLocked(staleTimeout?: number): { locked: boolean; pid?: number };

    /**
     * Force release a stale lock. Use with caution.
     * Only for --force-unlock CLI flag.
     */
    forceRelease(): void;
}
```

---

#### IChangeDetector

New interface for detecting which files changed between two versions. Replaces direct filesystem mtime/hash comparison in the cloud path.

```typescript
// src/cloud/types.ts

/** A file that changed between two versions */
export interface ChangedFile {
    /** Relative path from project root */
    filePath: string;
    /** How the file changed */
    changeType: "added" | "modified" | "deleted";
}

/** Result of change detection between two commit states */
export interface ChangeDetectionResult {
    /** Files that were added or modified */
    changedFiles: ChangedFile[];
    /** Parent commit SHA (undefined for initial commit) */
    parentSha: string | undefined;
    /** Current commit SHA */
    currentSha: string;
}

/**
 * Detects file changes between two states.
 *
 * Implementations:
 * - GitDiffChangeDetector: uses `git diff <parent>...<current>` (cloud path)
 * - FilesystemChangeDetector: uses mtime + content hash (local path, existing behavior)
 */
export interface IChangeDetector {
    /**
     * Detect changes for the current state (commit or working tree).
     * @param projectPath Absolute path to project root
     * @param currentSha Current HEAD commit SHA (git path) or undefined (filesystem path)
     * @param knownParentSha Parent SHA if known (used to skip cloud lookup)
     */
    detectChanges(
        projectPath: string,
        currentSha?: string,
        knownParentSha?: string,
    ): Promise<ChangeDetectionResult>;

    /**
     * Get the list of dirty files (uncommitted changes).
     * Used by OverlayIndex to determine which files to overlay.
     * Returns empty array for non-git implementations.
     */
    getDirtyFiles(projectPath: string): Promise<string[]>;
}
```

---

#### ICloudIndexClient

New interface for cloud API interactions. All cloud HTTP calls go through this interface, making the cloud backend swappable and testable.

```typescript
// src/cloud/types.ts

/** Chunk metadata sent to cloud (without source text in thin mode) */
export interface CloudChunkUpload {
    contentHash: string;
    chunkType: string;
    name?: string;
    parentName?: string;
    signature?: string;
    language: string;
    startLine: number;
    endLine: number;
    /** Thin mode: pre-computed vector */
    vector?: number[];
    /** Smart mode: chunk text for server-side embedding */
    text?: string;
}

/** File record for a commit index upload */
export interface CloudFileRecord {
    filePath: string;
    fileHash: string;
    deleted?: boolean;
    chunks: CloudChunkUpload[];
}

/** Symbol record for graph upload */
export interface CloudSymbolRecord {
    name: string;
    kind: string;
    filePath: string;
    startLine: number;
    endLine: number;
    signature?: string;
    isExported: boolean;
    language: string;
}

/** Symbol reference record */
export interface CloudSymbolReference {
    fromSymbolLocalId: string;
    toSymbolName: string;
    kind: string;
    filePath: string;
    line: number;
}

/** Options for POST /v1/index */
export interface IndexUploadOptions {
    repoSlug: string;
    commitSha: string;
    parentSha?: string;
    embeddingModel: string;
    embeddingDim: number;
    cloudMode: "thin" | "smart";
    changedFiles: CloudFileRecord[];
    symbols?: CloudSymbolRecord[];
    symbolReferences?: CloudSymbolReference[];
    enrichmentDocs?: CloudEnrichmentDoc[];
}

/** Enrichment doc for optional upload */
export interface CloudEnrichmentDoc {
    contentHash: string;
    docType: string;
    content: string;
    llmModel: string;
}

/** Result of POST /v1/index */
export interface IndexUploadResult {
    commitId: string;
    status: "ready" | "embedding";
    inheritedFiles: number;
    newChunks: number;
    deduplicatedChunks: number;
    pendingChunks?: number;
    estimatedReadyAt?: string;
}

/** Commit index status */
export interface CommitStatus {
    sha: string;
    status: "not_found" | "pending" | "embedding" | "ready" | "failed";
    indexedAt?: string;
    chunkCount?: number;
    fileCount?: number;
}

/** Cloud search request */
export interface CloudSearchRequest {
    repoSlug: string;
    commitSha: string;
    queryVector: number[];
    queryText?: string;
    limit?: number;
    suppressPaths?: string[];
    filters?: {
        language?: string;
        chunkType?: string;
        pathPattern?: string;
    };
}

/** Single cloud search result */
export interface CloudSearchResult {
    contentHash: string;
    filePath: string;
    startLine: number;
    endLine: number;
    chunkType: string;
    name?: string;
    parentName?: string;
    signature?: string;
    language: string;
    score: number;
    vectorScore: number;
    keywordScore: number;
    summary?: string;
    pagerankScore: number;
}

/** Cloud search response */
export interface CloudSearchResponse {
    results: CloudSearchResult[];
    totalResults: number;
    searchDurationMs: number;
}

/**
 * Cloud index client interface.
 *
 * Implementations:
 * - ThinCloudClient: sends vectors, thin mode
 * - SmartCloudClient: sends text, smart mode
 * - LocalCloudStub: in-process stub for testing
 */
export interface ICloudIndexClient {
    /**
     * Check which content hashes are already stored in the cloud.
     * Returns the subset that are already present (no upload needed).
     */
    checkChunksExist(
        repoSlug: string,
        hashes: string[],
    ): Promise<{ existing: string[]; missing: string[] }>;

    /**
     * Upload chunk data for a commit and record the commit index.
     * Server applies parent inheritance for unchanged files.
     */
    uploadIndex(options: IndexUploadOptions): Promise<IndexUploadResult>;

    /**
     * Poll commit status until ready or failed.
     * Used in smart mode where server-side embedding is async.
     */
    waitForCommit(
        repoSlug: string,
        commitSha: string,
        timeoutMs?: number,
    ): Promise<CommitStatus>;

    /**
     * Get the status of a commit index.
     */
    getCommitStatus(
        repoSlug: string,
        commitSha: string,
    ): Promise<CommitStatus>;

    /**
     * Search the cloud index for a specific commit.
     */
    search(request: CloudSearchRequest): Promise<CloudSearchResponse>;

    /**
     * Look up a symbol by name within a commit index.
     */
    getSymbol(
        repoSlug: string,
        commitSha: string,
        name: string,
        kind?: string,
    ): Promise<{ symbols: CloudSymbolRecord[] }>;

    /**
     * Get all callers of a symbol within a commit index.
     */
    getCallers(
        repoSlug: string,
        commitSha: string,
        symbolName: string,
    ): Promise<{ symbol: CloudSymbolRecord; callers: Array<{ fromSymbol: CloudSymbolRecord; referenceKind: string; line: number }> }>;

    /**
     * Get all callees of a symbol within a commit index.
     */
    getCallees(
        repoSlug: string,
        commitSha: string,
        symbolName: string,
    ): Promise<{ symbol: CloudSymbolRecord; callees: Array<{ toSymbol: CloudSymbolRecord; referenceKind: string; line: number }> }>;

    /**
     * Get the repo map for a commit index.
     */
    getMap(
        repoSlug: string,
        commitSha: string,
        options?: { maxTokens?: number; topN?: number },
    ): Promise<{ map: string; tokenEstimate: number }>;

    /**
     * Register a repository with the cloud service.
     * Idempotent. Returns error if embedding model conflicts.
     */
    registerRepo(
        orgSlug: string,
        repoSlug: string,
        remoteUrl: string,
        embeddingModel: string,
        embeddingDim: number,
    ): Promise<{ repoId: string }>;

    /**
     * Check if the cloud service is reachable and the API version is supported.
     */
    ping(): Promise<{ ok: boolean; apiVersion: number }>;
}
```

---

#### IOverlayIndex

New interface managing the local dirty-file overlay lifecycle.

```typescript
// src/cloud/types.ts

import type { SearchResult } from "../types.js";

/** Dirty file detected by git status */
export interface DirtyFile {
    filePath: string;
    status: "modified" | "added" | "untracked";
    mtime: number;
}

/** Current state of the overlay index */
export interface OverlayState {
    fingerprint: string;
    dirtyFiles: DirtyFile[];
    rebuiltAt: Date;
    chunkCount: number;
}

/**
 * Manages the local dirty-file overlay index.
 *
 * The overlay provides up-to-date search results for files that
 * have been modified locally but not yet committed. It is rebuilt
 * lazily when the dirty file set changes.
 */
export interface IOverlayIndex {
    /**
     * Check whether the overlay is stale relative to the current dirty file set.
     * Stale = fingerprint of dirty files has changed since last rebuild.
     * This is a fast operation (git status + fingerprint comparison only).
     */
    isStale(currentDirtyFiles: DirtyFile[]): Promise<boolean>;

    /**
     * Rebuild the overlay for the given set of dirty files.
     * - Parses dirty files with tree-sitter
     * - Embeds chunks locally using IEmbeddingsClient
     * - Stores in local LanceDB at .claudemem/overlay/
     * Does NOT run LLM enrichment (overlay is raw embeddings only).
     */
    rebuild(
        dirtyFiles: DirtyFile[],
        onProgress?: (current: number, total: number, file: string) => void,
    ): Promise<void>;

    /**
     * Atomically replace current overlay with a newly built one.
     * Safe for concurrent access: writes to a temp dir, then renames.
     */
    commit(newOverlay: IOverlayIndex): Promise<void>;

    /**
     * Search the overlay for the given query vector.
     * Returns results only for files currently in the overlay.
     */
    search(queryVector: number[], limit?: number): Promise<SearchResult[]>;

    /**
     * Get the set of file paths currently in the overlay.
     * Used by OverlayMerger to know which paths to suppress from cloud results.
     */
    getDirtyFilePaths(): string[];

    /**
     * Invalidate the overlay, forcing a full rebuild on next query.
     * Called when the dirty file set changes in a way that requires full reset
     * (e.g., a file is now clean after being committed).
     */
    invalidate(): Promise<void>;

    /**
     * Get the current overlay state for diagnostic display.
     */
    getState(): Promise<OverlayState | null>;
}
```

---

### 3.2 Configuration

The `ProjectConfig` type gains an optional `team` section. The existing `ProjectConfig` interface in `src/types.ts` is extended:

```typescript
// src/types.ts — additions to ProjectConfig

export interface TeamConfig {
    /**
     * Cloud API endpoint (default: https://api.claudemem.dev).
     * For self-hosted or staging deployments.
     */
    cloudEndpoint?: string;

    /**
     * Organization slug (e.g. "acme-corp").
     * Identifies the team's org on the cloud service.
     */
    orgSlug?: string;

    /**
     * Repository slug (e.g. "my-repo").
     * Derived from git remote URL if not set.
     */
    repoSlug?: string;

    /**
     * Cloud operation mode.
     * - "thin" (default): client computes embeddings locally, uploads vectors + hashes.
     *   Source code and chunk text never leave the machine.
     * - "smart": client sends chunk text to cloud; cloud computes embeddings.
     *   Lower embedding API cost but chunk text crosses the wire.
     */
    cloudMode?: "thin" | "smart";

    /**
     * Whether to upload LLM enrichment summaries to the cloud.
     * Default: false (opt-in only).
     * When true, symbol_summary and file_summary docs are uploaded to the cloud
     * and shared with all team members for that commit.
     */
    uploadEnrichment?: boolean;

    /**
     * Disable all cloud network operations.
     * Equivalent to setting CLAUDEMEM_OFFLINE=1 env var.
     * Useful for CI environments that should not hit the cloud API.
     */
    offline?: boolean;

    /**
     * Maximum number of chunks to upload per batch in POST /v1/index.
     * Default: 500. Reduce if hitting request size limits.
     */
    uploadBatchSize?: number;
}

// Extension of existing ProjectConfig:
export interface ProjectConfig {
    // ... all existing fields unchanged ...

    /**
     * Team/cloud configuration.
     * When present and orgSlug is set, cloud features are enabled.
     * Absence of this field = fully local mode (backward compatible).
     */
    team?: TeamConfig;
}
```

**Config loading integration:**

The existing `loadProjectConfig()` in `src/config.ts` reads `{project}/.claudemem/config.json`. The `team` section is loaded from the same file. No new config loading path is needed.

**Auth credentials** are stored separately from project config (never committed to git):
- macOS: OS Keychain via `keytar` npm package, service name `"claudemem"`, account `"{orgSlug}"`
- Linux: Secret Service via `keytar`
- Fallback: `~/.claudemem/credentials.json` (mode 0600)

**Cloud feature activation check:**

```typescript
// src/cloud/config.ts

export function isCloudEnabled(projectPath: string): boolean {
    if (process.env.CLAUDEMEM_OFFLINE === "1") return false;
    const config = loadProjectConfig(projectPath);
    return !!(config.team?.orgSlug);
}

export function getCloudMode(projectPath: string): "thin" | "smart" {
    const config = loadProjectConfig(projectPath);
    return config.team?.cloudMode ?? "thin";
}
```

---

### 3.3 Diff-Based Reindexing Flow

Step-by-step flow for `claudemem index --cloud` (invoked manually or via post-commit hook):

```
Step 1: Get current HEAD commit SHA
─────────────────────────────────────
git rev-parse HEAD
  → currentSha = "abc123..."

Step 2: Check if cloud already has index for this commit
──────────────────────────────────────────────────────────
ICloudIndexClient.getCommitStatus(repoSlug, currentSha)
  → status = "ready"  → EXIT EARLY (already indexed)
  → status = "not_found" | "failed" → continue

Step 3: Find parent commit SHA
────────────────────────────────
git rev-parse HEAD~1  (or HEAD^1, HEAD^2 for merge commits)
  → parentSha = "def456..."

For merge commits (git log --merges -n 1):
  → parentShas = ["def456...", "789abc..."]
  (union of changes across all parents)

Step 4: Compute git diff parent..HEAD → changed files
───────────────────────────────────────────────────────
git diff --name-status def456...abc123
  → M src/core/store.ts
  → A src/cloud/types.ts
  → D src/deprecated.ts

GitDiffChangeDetector.detectChanges(projectPath, currentSha, parentSha)
  → changedFiles: [{filePath, changeType: "modified"|"added"|"deleted"}]

Step 5: AST-parse changed (non-deleted) files locally
───────────────────────────────────────────────────────
For each modified/added file:
  chunkFileByPath(filePath) → ParsedChunk[]
  compute contentHash = SHA256(chunk.content) per chunk
  compute fileHash = SHA256(fileContent) per file

Step 6: Check cloud for existing chunk hashes (dedup)
───────────────────────────────────────────────────────
allHashes = [contentHash for each chunk across all changed files]

ICloudIndexClient.checkChunksExist(repoSlug, allHashes)
  → existing: ["sha256_a", "sha256_b"]
  → missing:  ["sha256_c", "sha256_d"]

Step 7 (thin mode only): Embed missing chunks locally
───────────────────────────────────────────────────────
missingChunks = chunks where contentHash in missing

IEmbeddingsClient.embed(missingChunks.map(c => c.content))
  → vectors: number[][]

  Progress: "Embedding 3 new chunks (8 already in cloud)..."

Step 7 (smart mode only): Prepare chunk text for upload
────────────────────────────────────────────────────────
(No local embedding needed for missing chunks)
Chunk text is included in the upload payload directly.

Step 8: Build upload payload and POST /v1/index
─────────────────────────────────────────────────
changedFiles payload:
  - For each modified/added file:
    - fileHash, filePath
    - chunks: all chunks for that file
      - contentHash (always present)
      - thin mode: vector (only for missing hashes; existing hashes omitted — server already has vectors)
      - smart mode: text (only for missing hashes; existing hashes omitted)
      - metadata (chunkType, name, signature, language, startLine, endLine)
  - For each deleted file:
    - filePath, deleted: true, chunks: []

symbols payload:
  - SymbolDefinition[] extracted from changed files by createSymbolExtractor()

symbolReferences payload:
  - SymbolReference[] extracted from changed files

ICloudIndexClient.uploadIndex({
  repoSlug, commitSha: currentSha, parentSha,
  embeddingModel, embeddingDim, cloudMode,
  changedFiles, symbols, symbolReferences
})
  → thin mode: {status: "ready", inheritedFiles: N, newChunks: M}
  → smart mode: {status: "embedding", pendingChunks: M}

Step 9 (smart mode only): Wait for server-side embedding
──────────────────────────────────────────────────────────
ICloudIndexClient.waitForCommit(repoSlug, currentSha, timeoutMs: 120000)
  → polls GET /v1/commits/:sha/status with exponential backoff (1s, 2s, 4s, 8s, max 30s)
  → returns when status = "ready" or "failed"

Step 10: Cloud recomputes PageRank (server-side, async)
─────────────────────────────────────────────────────────
Server side (triggered by /v1/index completion):
  - Takes symbol graph for this commit (inherited + new symbols)
  - Runs PageRank iteration (damping=0.85, max_iter=100)
  - Updates symbols.pagerank_score for all symbols in this commit
  - This is done asynchronously; search is available before PageRank completes
  - Status: "ready" even while PageRank is still computing
  - PageRank scores are updated in-place; no client action needed
```

**Progress reporting** throughout steps 4–9 is reported via the existing CLI progress callback pattern, matching `NFR-1.1` (< 30 seconds for 1–20 changed files).

---

### 3.4 Search Flow (Merged Cloud + Overlay)

Step-by-step flow for all search commands (`search`, `map`, `context`, `callers`, `callees`, `impact`) when cloud mode is enabled:

```
Step 1: Detect dirty files (git status)
─────────────────────────────────────────
GitDiffChangeDetector.getDirtyFiles(projectPath)
  → dirtyFiles: DirtyFile[]
  (includes M=modified, A=added, ?=untracked)

Step 2: Rebuild overlay if stale
──────────────────────────────────
IOverlayIndex.isStale(dirtyFiles)
  → compare fingerprint: SHA256(sorted(filePath + ":" + mtime))

If stale:
  IOverlayIndex.rebuild(dirtyFiles, onProgress)
    - read each dirty file from disk
    - chunkFileByPath() → chunks
    - IEmbeddingsClient.embed(chunks.map(c => c.content)) → vectors
    - write to .claudemem/overlay/ LanceDB
    - update .fingerprint
  (runs concurrently with steps 3–4; overlay search is gated on completion)

Step 3: Embed query locally
────────────────────────────
queryVector = IEmbeddingsClient.embedOne(queryText)
  (~100–200ms for cloud providers, ~50ms for local Ollama)

Step 4: Send query to cloud API for current HEAD commit
────────────────────────────────────────────────────────
dirtyFilePaths = dirtyFiles.map(f => f.filePath)

ICloudIndexClient.search({
  repoSlug,
  commitSha: currentHeadSha,
  queryVector,
  queryText,
  limit: limit * 2,          -- fetch more to allow overlay suppression
  suppressPaths: dirtyFilePaths,
  filters: { language, chunkType, pathPattern }
})
  → cloudResults: CloudSearchResult[]

  (server filters out suppressPaths before returning)

Step 5: Search local overlay (parallel with step 4)
─────────────────────────────────────────────────────
overlayResults = IOverlayIndex.search(queryVector, limit)
  → SearchResult[] (only for dirty files)

Step 6: Merge results
──────────────────────
OverlayMerger.merge(cloudResults, overlayResults, dirtyFilePaths):

  1. Map cloudResults to SearchResult[] (convert CloudSearchResult → SearchResult)
  2. Normalize cloud scores to [0, 1] via min-max (over cloud result set)
  3. Normalize overlay scores to [0, 1] via min-max (over overlay result set)
  4. For each cloud result:
     - If result.filePath is in dirtyFilePaths → DISCARD (suppressed)
       (belt-and-suspenders: server already suppressed, but verify client-side)
  5. Interleave remaining cloud results + all overlay results by normalized score
  6. Apply final limit (top N results)

Step 7: Return merged ranked results
──────────────────────────────────────
SearchResult[] with:
  - source: "cloud" | "overlay" (added field for debug/display)
  - All existing SearchResult fields populated
```

**Offline degradation (cloud unreachable):**

If step 4 fails (network error, timeout), the merger receives empty cloud results. The system:
1. Logs a user-visible warning: `"Cloud index unavailable (offline mode). Searching overlay only."`
2. Returns overlay results only (dirty files).
3. If a local sync cache exists (populated by `claudemem sync`), falls back to the local cache.
4. Never silently drops results without a warning.

**MCP server integration:**

The `ToolDeps` interface in `src/mcp/tools/deps.ts` gains an optional cloud client:

```typescript
// src/mcp/tools/deps.ts — additions

import type { ICloudIndexClient } from "../../cloud/types.js";
import type { IOverlayIndex } from "../../cloud/types.js";

export interface ToolDeps {
    // ... existing fields unchanged ...

    /**
     * Cloud index client.
     * Undefined when cloud mode is not configured.
     */
    cloudClient?: ICloudIndexClient;

    /**
     * Local overlay index for dirty files.
     * Undefined when cloud mode is not configured.
     */
    overlayIndex?: IOverlayIndex;

    /**
     * Current HEAD commit SHA.
     * Populated only in cloud mode.
     */
    currentCommitSha?: string;

    /**
     * Team config for the current project.
     */
    teamConfig?: TeamConfig;
}
```

Individual MCP tool implementations (`search_code`, `get_context`, etc.) check `deps.cloudClient` and use it instead of the local index when available. This is the only change required to existing tool implementations.

---

## 4. Security Design

### 4.1 Authentication Flow

```
1. Team admin: POST /v1/auth/token {orgApiKey: "cmk_org_..."}
   → receives short-lived token (24h TTL)

2. Developer: claudemem team login --org acme-corp
   → prompts for org API key (not stored in config)
   → calls POST /v1/auth/token
   → stores personal token in OS keychain:
      service="claudemem", account="acme-corp"
   → stores orgSlug + cloudEndpoint in {project}/.claudemem/config.json
      (no credentials in config file)

3. Subsequent requests: reads token from keychain
   → if expired: automatically refreshes using org API key
     (org API key stored in keychain as "cmk_org_..." under account "acme-corp:apikey")

4. claudemem team logout --org acme-corp
   → deletes token from keychain
   → does NOT modify project config (cloud features still configured)
```

**Token scopes:**
- `index:read` — can call `/v1/search`, `/v1/symbol`, `/v1/callers`, `/v1/map`, `/v1/commits/*/status`
- `index:write` — can call `/v1/index`, `/v1/chunks/check`, `/v1/repos/*/register`
- Default: both scopes granted to all team members

**Rate limiting:** Cloud service enforces per-org rate limits (configurable by plan). Rate limit headers: `X-RateLimit-Remaining`, `X-RateLimit-Reset`.

### 4.2 TLS Requirements

- All requests to cloud API require TLS 1.2 or higher (enforced at server level).
- Certificate validation is always enabled; no `--no-verify` option exposed.
- The client uses `fetch()` (Node.js native) for all HTTP requests; TLS is handled by the runtime.

### 4.3 What Data Crosses the Wire (by Mode)

**Thin mode (cloud_mode: "thin"):**

| Data | Transmitted? | Notes |
|---|---|---|
| Source code text | Never | Only processed locally |
| Chunk body text | Never | Only processed locally |
| AST trees | Never | Discarded after chunking |
| Content hashes (SHA256) | Yes | Used for dedup lookup |
| Embedding vectors (float32[]) | Yes | For missing hashes only |
| Chunk metadata | Yes | type, name, signature, line numbers, language |
| Symbol names + signatures | Yes | For symbol graph |
| LLM enrichment text | Only if `uploadEnrichment: true` | Opt-in |
| Personal token | Yes (Authorization header) | TLS-encrypted |

**Smart mode (cloud_mode: "smart"):**

All of the above plus:
- Chunk body text transmitted for embedding

**Reconstruction risk:**
- Thin mode: Embedding vectors are not invertible; content hashes are one-way. Full cloud database access does not permit source code reconstruction.
- Smart mode: Chunk text is stored server-side. Teams requiring strict source-code-off-device policy must use thin mode.

### 4.4 Credential Storage

```
Credential type        Storage location                     Format
─────────────────────  ─────────────────────────────────────  ──────────
Org API key            OS Keychain (keytar)                  "cmk_org_..."
                       Fallback: ~/.claudemem/credentials.json (0600)

Personal token         OS Keychain (keytar)                  "cmt_..."
                       Fallback: ~/.claudemem/credentials.json (0600)

Project config         {project}/.claudemem/config.json       No credentials
                       (committed to git, no secrets)

Global config          ~/.claudemem/config.json               No credentials
```

**credentials.json format (fallback only):**
```json
{
    "acme-corp": {
        "apiKey": "cmk_org_...",
        "token": "cmt_...",
        "tokenExpiresAt": "2026-03-04T11:06:49Z"
    }
}
```

**CLAUDEMEM_OFFLINE=1:** When set, `ICloudIndexClient` is replaced with a `NoOpCloudClient` that returns immediate errors for all write operations and empty results for all read operations. No network calls are made.

---

## 5. Implementation Plan

### Phase 1: Interface Extraction (2 weeks)

**Objective:** Extract `IVectorStore`, `IFileTracker`, and `IIndexLock` from concrete classes. No behavior change. Enables future implementations to be substituted cleanly.

**Scope:**
- Add `IVectorStore` interface to `src/core/store.ts`; make `VectorStore` implement it
- Add `IFileTracker` interface to `src/core/tracker.ts`; make `FileTracker` implement it
- Add `IIndexLock` interface to `src/core/lock.ts`; make `IndexLock` implement it
- Update `Indexer` class to reference the interfaces rather than concrete types where the overlay will need substitution
- Update factory functions (`createVectorStore`, `createFileTracker`, `createIndexLock`) to return interface types
- Update `ToolDeps` in `src/mcp/tools/deps.ts` to reference interface types

**Acceptance criteria:**
- All existing tests pass without modification
- `bun run typecheck` passes
- No change in CLI behavior (`bun run build && claudemem search "test"` produces identical output)

**Files changed:** `src/core/store.ts`, `src/core/tracker.ts`, `src/core/lock.ts`, `src/mcp/tools/deps.ts`

**Dependencies:** None. This phase is entirely refactoring.

---

### Phase 2: Cloud Client + Thin Mode (3 weeks)

**Objective:** Implement the cloud client HTTP layer, `GitDiffChangeDetector`, and the `claudemem index --cloud` command with thin mode. No overlay yet — cloud search requires overlay to be useful, but indexing is independently testable.

**Scope:**

New files:
- `src/cloud/types.ts` — all new interfaces (`IChangeDetector`, `ICloudIndexClient`, `IOverlayIndex`, `TeamConfig`)
- `src/cloud/auth.ts` — `CloudAuthManager` (keytar integration + file fallback)
- `src/cloud/git-diff.ts` — `GitDiffChangeDetector` implementing `IChangeDetector`
- `src/cloud/thin-client.ts` — `ThinCloudClient` implementing `ICloudIndexClient`
- `src/cloud/stub.ts` — `LocalCloudStub` implementing `ICloudIndexClient` (for testing)
- `src/cloud/indexer.ts` — `CloudAwareIndexer` orchestrating steps 1–10 from section 3.3
- `src/cloud/config.ts` — `isCloudEnabled()`, `getCloudMode()`, `getTeamConfig()`

Modified files:
- `src/types.ts` — add `TeamConfig` and `team?: TeamConfig` to `ProjectConfig`
- `src/cli.ts` — add `--cloud` flag to `index` command; add `team login|logout|status` commands
- `src/config.ts` — add `loadTeamConfig()`

**Acceptance criteria:**
- `claudemem index --cloud` for a repo with `team.orgSlug` configured uploads changed files to cloud
- `GET /v1/commits/:sha/status` returns "ready" after upload
- Hash deduplication: running `claudemem index --cloud` twice for the same commit uploads 0 new chunks on second run
- `bun test` passes including new cloud unit tests against `LocalCloudStub`

**Dependencies:** Phase 1 completed (interface extraction).

---

### Phase 3: Local Overlay (2 weeks)

**Objective:** Implement the overlay index and merged search. After this phase, all search commands work correctly against the merged cloud+overlay index.

**Scope:**

New files:
- `src/cloud/overlay.ts` — `OverlayIndex` implementing `IOverlayIndex`
- `src/cloud/merger.ts` — `OverlayMerger` (merge + score normalization)
- `src/cloud/search.ts` — `CloudAwareSearch` orchestrating steps 1–7 from section 3.4

Modified files:
- `src/mcp/tools/deps.ts` — add `cloudClient?`, `overlayIndex?`, `currentCommitSha?`, `teamConfig?` to `ToolDeps`
- `src/mcp-server.ts` — initialize cloud client + overlay when cloud mode enabled
- `src/cli.ts` — add `claudemem sync` command; wire cloud-aware search into existing search commands

**Acceptance criteria:**
- Search against dirty files returns overlay results (not stale cloud results)
- Modifying a file locally and searching for its content returns the local version
- Cloud search for clean files still returns cloud results
- `claudemem sync` downloads and caches the current HEAD commit index locally
- `bun test` passes for overlay + merger unit tests

**Dependencies:** Phase 2 completed (cloud client + thin mode).

---

### Phase 4: Smart Mode (1 week)

**Objective:** Add `SmartCloudClient` implementing `ICloudIndexClient` for cloud_mode: "smart". Adds chunk text upload and polling for server-side embedding completion.

**Scope:**

New files:
- `src/cloud/smart-client.ts` — `SmartCloudClient` implementing `ICloudIndexClient`

Modified files:
- `src/cloud/config.ts` — `getCloudMode()` selects `ThinCloudClient` vs `SmartCloudClient`
- `src/cloud/indexer.ts` — handle `status: "embedding"` response + `waitForCommit()` polling

**Acceptance criteria:**
- Setting `team.cloudMode: "smart"` in config uses chunk text upload instead of vectors
- Smart mode polls until status = "ready" before returning from `claudemem index --cloud`
- Unit tests for `SmartCloudClient` against a stubbed server

**Dependencies:** Phase 2 completed. Phase 3 is independent.

---

### Phase 5: Shared Enrichment + Symbol Graph in Cloud (2 weeks)

**Objective:** Upload LLM enrichment docs to cloud (opt-in). Download symbol graph for local reconstruction. Auth system CLI commands.

**Scope:**

Modified files:
- `src/cloud/indexer.ts` — include `enrichmentDocs` in upload if `uploadEnrichment: true`
- `src/cli.ts` — `team login`, `team logout`, `team status` commands
- `src/cloud/auth.ts` — complete `team login` interactive flow with org API key prompt

New files:
- `src/cloud/graph-sync.ts` — `GraphSyncer` downloads symbol graph from cloud + reconstructs local PageRank for offline use

**Acceptance criteria:**
- `claudemem team login --org acme-corp` prompts for API key, stores token in keychain
- `claudemem team status` shows org, repo, cloud mode, last indexed commit
- With `uploadEnrichment: true`, summaries appear in cloud search results for all team members
- `claudemem sync` downloads symbol graph for offline `map`, `callers`, `callees` commands

**Dependencies:** Phase 3 completed.

---

### Estimated Timeline

| Phase | Duration | Cumulative |
|---|---|---|
| Phase 1: Interface extraction | 2 weeks | 2 weeks |
| Phase 2: Cloud client + thin mode | 3 weeks | 5 weeks |
| Phase 3: Local overlay | 2 weeks | 7 weeks |
| Phase 4: Smart mode | 1 week | 8 weeks |
| Phase 5: Shared enrichment + symbol graph | 2 weeks | 10 weeks |

MVP (ship after Phase 3): 7 weeks for a system where team members can index to the cloud in thin mode, search the shared cloud index, and have dirty file results served from the local overlay.

---

## 6. Testing Strategy

### 6.1 Testing Without a Live Cloud Service

All cloud logic is tested against `LocalCloudStub`, an in-process implementation of `ICloudIndexClient` that uses in-memory Maps to simulate the cloud API. The stub validates request shapes, enforces idempotency rules (second upload of same commit SHA returns same result), and simulates deduplication (returns pre-seeded hashes as "existing").

The stub is in `src/cloud/stub.ts` and is the primary test target for unit and integration tests.

For smart mode testing, a second stub `SmartCloudStub` simulates asynchronous embedding: it accepts text upload, returns `status: "embedding"`, then transitions to `status: "ready"` after a configurable delay (default: 10ms in tests).

### 6.2 Unit Tests

```
test/cloud/
├── git-diff.test.ts        # GitDiffChangeDetector — mock git subprocess
├── auth.test.ts            # CloudAuthManager — mock keytar + file fallback
├── thin-client.test.ts     # ThinCloudClient — mock fetch responses
├── smart-client.test.ts    # SmartCloudClient — mock fetch + polling
├── overlay.test.ts         # OverlayIndex — uses real LanceDB in tmp dir
├── merger.test.ts          # OverlayMerger — pure unit test (no I/O)
├── indexer.test.ts         # CloudAwareIndexer — against LocalCloudStub
└── config.test.ts          # isCloudEnabled, getCloudMode, TeamConfig loading
```

**Key test scenarios for merger:**
- Cloud results only (no overlay): passthrough
- Overlay results only (no cloud): passthrough
- Mixed: overlay results for dirty files take precedence; cloud results for clean files included
- Score normalization: result with score 0.9 from overlay and 0.95 from cloud are interleaved correctly
- Tie-breaking: results with identical normalized scores ordered by source (overlay first)

**Key test scenarios for overlay:**
- Empty dirty file set: overlay is empty; rebuild is skipped
- Single dirty file added: rebuild indexes it; search returns results
- Fingerprint change: isStale() returns true; rebuild() triggered
- Fingerprint unchanged: isStale() returns false; rebuild() NOT triggered (fast path)
- rebuild() failure: overlay returns to previous valid state (atomic swap)

### 6.3 Integration Tests

Integration tests use a real temporary git repository with controlled commits:

```typescript
// test/cloud/integration/cloud-indexer.test.ts

describe("CloudAwareIndexer integration", () => {
    let tmpDir: string;
    let cloudStub: LocalCloudStub;

    beforeEach(async () => {
        tmpDir = await mkdtemp(join(tmpdir(), "claudemem-test-"));
        // Initialize git repo with initial commit
        await exec("git init", { cwd: tmpDir });
        await exec("git commit --allow-empty -m 'initial'", { cwd: tmpDir });
        cloudStub = new LocalCloudStub();
    });

    test("indexes initial commit: all files", async () => { ... });
    test("indexes second commit: only changed files re-embedded", async () => { ... });
    test("deduplicates across commits: stable code not re-embedded", async () => { ... });
    test("handles deleted files: not in new commit index", async () => { ... });
    test("handles merge commits: union of parent changes", async () => { ... });
    test("idempotent: double-indexing same commit is a no-op", async () => { ... });
});
```

Integration tests also cover the search merge flow end-to-end:

```typescript
describe("CloudAwareSearch integration", () => {
    test("returns cloud results for clean files", async () => { ... });
    test("returns overlay results for dirty files", async () => { ... });
    test("suppresses cloud results for dirty file paths", async () => { ... });
    test("degrades gracefully when cloud unreachable", async () => { ... });
    test("rebuilds overlay when dirty set changes", async () => { ... });
});
```

### 6.4 End-to-End Tests

E2E tests run against the real cloud API in a dedicated `test` org and `test-repo` repository. These are opt-in (require `CLAUDEMEM_CLOUD_TEST_TOKEN` env var) and run only in CI.

```bash
# E2E test matrix:
# - thin mode: index → search → verify results
# - smart mode: index → poll → search → verify results
# - team sharing: developer A indexes, developer B searches (separate tokens)
# - offline degradation: block network, verify fallback behavior
```

E2E tests use a dedicated `test` repo pre-seeded with known code, so search result assertions can be deterministic.

### 6.5 Mock and Stub Hierarchy

```
ICloudIndexClient
├── ThinCloudClient          (production: real HTTP, thin mode)
├── SmartCloudClient         (production: real HTTP, smart mode)
├── LocalCloudStub           (unit/integration tests: in-process, fast)
├── SmartCloudStub           (integration tests: async embedding simulation)
└── NoOpCloudClient          (CLAUDEMEM_OFFLINE=1: all operations no-op)

IOverlayIndex
├── OverlayIndex             (production: real LanceDB in .claudemem/overlay/)
└── InMemoryOverlayStub      (unit tests: no filesystem I/O)

IChangeDetector
├── GitDiffChangeDetector    (production: real git subprocess)
└── MockChangeDetector       (unit tests: configurable return values)
```

This hierarchy follows the existing `IEmbeddingsClient` pattern in the codebase, where multiple implementations share a common interface tested via the interface contract, not the concrete type.

---

## Appendix A: Open Questions

1. **PageRank computation timing:** Section 3.3 Step 10 states PageRank is computed asynchronously server-side. For large commits with many symbol graph changes, this may take 30–60 seconds. Should the `status: "ready"` transition wait for PageRank, or mark ready immediately and update scores in-place? Recommendation: mark ready immediately; `pagerankScore` defaults to 0 until computed. Search works but PageRank-ordered `map` results are degraded until computation completes.

2. **Qdrant vs pgvector:** For the cloud MVP, pgvector on PostgreSQL eliminates Qdrant as an operational dependency and reduces cloud service complexity. The performance difference only becomes significant above ~100K vectors per repo. Recommendation: start with pgvector; add Qdrant as an optional backend behind `IVectorSearchBackend` if performance requires it.

3. **Symbol graph inheritance:** The current design uploads the full symbol graph for changed files. For large commits with many file changes, the graph upload can be expensive. An alternative is to upload only the delta graph (changed symbols and references) and have the server merge it with the parent's graph. This is more complex but reduces upload size. Recommendation: full graph upload for MVP; evaluate delta upload in Phase 5.

4. **Enrichment doc versioning:** If a team upgrades their LLM model between commits, enrichment docs from different models coexist in the cloud. The `enrichment_docs` table has a `llm_model` column but no dedup between models. Recommendation: `doc_type + content_hash` is the primary key; multiple models can coexist, and search serves whichever doc exists (preferring the configured model version).

5. **Windows credential storage:** `keytar` supports Windows Credential Manager but requires a native module build. For the MVP, the file fallback (`~/.claudemem/credentials.json` mode 0600) is the Windows path. Keytar on Windows is a Phase 5 improvement.

---

## Appendix B: Existing Interface Reference

The following existing interfaces are referenced throughout this document but not modified:

- `IEmbeddingsClient` (`src/types.ts:349`) — embed, embedOne, getModel, getDimension, getProvider, isLocal
- `ILLMClient` (`src/types.ts:990`) — complete, completeJSON, getProvider, getModel, testConnection, getAccumulatedUsage, resetAccumulatedUsage, isCloud, getModelSizeB
- `IDocumentExtractor` (`src/types.ts:1061`) — getDocumentType, extract, needsUpdate, getDependencies
- `CodeChunk` (`src/types.ts:24`) — id, contentHash, content, filePath, startLine, endLine, language, chunkType, name, parentName, signature, fileHash
- `SearchResult` (`src/types.ts:235`) — chunk, score, vectorScore, keywordScore, summary, fileSummary, unitType
- `SearchOptions` (`src/types.ts:252`) — limit, language, chunkType, pathPattern, useCase, keywordOnly
- `SymbolDefinition` (`src/types.ts:657`) — id, name, kind, filePath, startLine, endLine, signature, docstring, parentId, isExported, language, pagerankScore
- `SymbolReference` (`src/types.ts:693`) — fromSymbolId, toSymbolName, toSymbolId, kind, filePath, line, isResolved
- `ProjectConfig` (`src/types.ts:449`) — extended with `team?: TeamConfig` in Phase 2
