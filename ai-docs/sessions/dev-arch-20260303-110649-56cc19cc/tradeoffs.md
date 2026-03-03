# Trade-Off Analysis: Cloud/Team claudemem Alternatives

**Session**: dev-arch-20260303-110649-56cc19cc
**Date**: 2026-03-03
**Status**: Complete

---

## 1. Scoring Methodology

Each alternative is scored 1–5 on each dimension, where **5 = best outcome** for that dimension. Scores represent the realistic best-case for an MVP implementation, accounting for the risks and mitigations described in the alternatives document.

The 10 dimensions map directly to the requirements in `requirements.md`:

| # | Dimension | Primary Requirement |
|---|---|---|
| 1 | Source code privacy | FR-4: code never leaves machine |
| 2 | Search latency | NFR-1.3: results in under 2 seconds |
| 3 | Embedding cost reduction | FR-5: 70%+ dedup target |
| 4 | Team onboarding speed | NFR-1.5: new dev indexes in < 5 minutes |
| 5 | Server operational complexity | TC-4: timeline + phasing; new product viability |
| 6 | Client complexity | TC-2: additive only; backward compatibility |
| 7 | Offline resilience | NFR-2.3: graceful degradation when cloud unreachable |
| 8 | Build effort | TC-4: MVP must ship; new product |
| 9 | Scalability | NFR-4: 500K chunks, 100 developers |
| 10 | Git workflow integration | FR-7: natural developer workflow fit |

---

## 2. Trade-Off Matrix

| Dimension | Alt 1: Thin Cloud | Alt 2: Smart Cloud | Alt 3: Git-Native |
|---|:---:|:---:|:---:|
| **1. Source code privacy** | 5 | 2 | 5 |
| **2. Search latency** | 4 | 3 | 5* |
| **3. Embedding cost reduction** | 4 | 5 | 2 |
| **4. Team onboarding speed** | 5 | 5 | 2 |
| **5. Server operational complexity** | 4 | 1 | 5 |
| **6. Client complexity** | 4 | 3 | 2 |
| **7. Offline resilience** | 3 | 2 | 5 |
| **8. Build effort** | 4 | 2 | 4 |
| **9. Scalability** | 4 | 5 | 1 |
| **10. Git workflow integration** | 4 | 4 | 3 |
| **Total** | **41** | **32** | **34** |
| **Weighted total (privacy x2)** | **46** | **34** | **39** |

*Alt 3's score of 5 on search latency is conditional — it only applies after a successful sync. An out-of-date sync returns stale results, which is a correctness problem independent of latency. The latency score would drop to 1 before sync completes.

---

## 3. Dimension-by-Dimension Reasoning

### Dimension 1: Source Code Privacy

**Alt 1 — Score: 5**

The client sends only `(contentHash, float32[] vector, chunkMetadata)` to the cloud. The metadata is non-identifying: chunk type, symbol name, function signature (not body), line numbers, and language. The cloud never receives source text, AST trees, or chunk body content. Even with full cloud database access, an attacker cannot reconstruct the source because embedding vectors are not invertible and content hashes are one-way. This satisfies FR-4.1 through FR-4.4 without caveats.

**Alt 2 — Score: 2**

The client sends chunk content (function bodies, class definitions) to the cloud for server-side embedding. The alternatives document acknowledges this directly: "Teams with strict zero-source-code-upload requirements cannot use this alternative." While FR-4.1 is literally satisfied ("raw source code MUST NOT be transmitted" — chunk content is derived, not raw), the intent of FR-4 is clearly violated. A security review from an enterprise customer would classify chunk text as source code regardless of the syntactic definition. This is a critical commercial risk: the requirements document emphasizes that source code privacy is non-negotiable.

**Alt 3 — Score: 5**

Data is transmitted only to the existing git remote the team already trusts. No new trust boundary is introduced. The transmitted data is the same opaque vectors and metadata as Alt 1. This is the strongest possible privacy posture.

---

### Dimension 2: Search Latency

**Alt 1 — Score: 4**

The query embedding is computed locally (~100–200ms for typical providers). The cloud ANN search with payload filter (`commitSha`) over 500K vectors with Qdrant returns results in ~50–150ms over a well-provisioned connection. The overlay search runs in parallel (local LanceDB, ~10–30ms). Total: 200–400ms in the common case. Well within the 2-second NFR-1.3 target. The main risk is embedding provider latency on the local machine — Ollama can spike to 500ms+ on first invocation.

**Alt 2 — Score: 3**

The cloud receives the raw query text and embeds it server-side before searching. This adds server-side embedding time (~100–200ms at Voyage AI API latency) on top of the network round-trip. More significantly, the overlay search embeds locally using `IEmbeddingsClient`, producing scores in a different space from the cloud's embedding output. The `OverlayMerger` must apply min-max normalization across both result sets before interleaving, which adds complexity and can produce degraded result ranking when result sets are small. Total: 400–800ms realistic. Within target but with less headroom.

**Alt 3 — Score: 5 (post-sync) / 1 (before sync)**

After a successful `claudemem sync`, search is fully local: LanceDB ANN lookup is under 50ms for 500K vectors. This is the fastest possible outcome. However, the score is conditional. Before sync (or with a stale sync), results are either absent or out of date. In the watch daemon scenario where sync runs every 60 seconds, there is a systematic staleness window. The score of 5 represents the best case; in practice, teams relying on cross-developer search freshness will experience the 1-case regularly unless the watch daemon is always running.

---

### Dimension 3: Embedding Cost Reduction

**Alt 1 — Score: 4**

The deduplication protocol (FR-5.2: `POST /v1/chunks/check` before embedding) ensures no embedding computation is repeated for content hashes already in the cloud. In a stable codebase where most commits change fewer than 5% of files, the vast majority of chunks are already in the cloud after the first developer indexes. The 70% target (NFR-1.4) is achievable within the first week of a team using the shared index. The first developer to index a commit pays full embedding cost; subsequent developers pay nothing for the same content.

The residual 4 (not 5) accounts for: (a) new developers joining do not pay for old content but still pay for their own dirty-file overlays, and (b) the initial full-repo index by the first developer has no deduplication benefit.

**Alt 2 — Score: 5**

The cloud owns embedding computation. All developers share the single set of embeddings computed by the cloud service. No developer ever computes embeddings for committed code — the cloud handles it. Even for the first commit, the embedding cost is paid once by the cloud service (not by a developer). New developers joining an existing project can search immediately without any embedding API key or cost. LLM enrichment is similarly centralized and deduplicated. This is the maximum achievable embedding cost reduction.

**Alt 3 — Score: 2**

Each developer computes all their own embeddings locally for everything they index. Other team members who sync receive the pre-computed vector files, so they do not recompute embeddings for content they sync. This means the original indexing developer pays full embedding cost, but teammates who sync that index get the vectors for free.

However, this only works if all developers use the identical embedding model (same model ID, same API provider, same version). If even one developer uses a different model, their imported vectors are incommensurable with locally-computed overlay vectors, producing incorrect search results. The alternatives document rates this risk as "High" and "Critical." In practice, teams using multiple embedding providers (e.g., one developer uses Ollama locally, another uses Voyage AI) cannot safely share indexes. The 2 score reflects that deduplication exists in theory but is fragile in practice.

---

### Dimension 4: Team Onboarding Speed

**Alt 1 — Score: 5**

A new developer runs `claudemem sync`. The client fetches the commit index for HEAD from the cloud: a PostgreSQL query over the commit->file->hash mapping, followed by downloading pre-existing vector data for chunks not yet in the local cache. For a 10,000-chunk repo with 1024-dimension float32 vectors, this is approximately 10,000 × 1024 × 4 bytes = ~40MB of vector data, plus lightweight metadata. On a standard broadband connection, this completes in well under 5 minutes. The developer can then search immediately — no embedding computation required. NFR-1.5 is satisfied with margin.

**Alt 2 — Score: 5**

Identical onboarding experience to Alt 1 from the developer's perspective. The cloud fetches the commit index and delivers it. If the developer does not plan to commit code, they need zero embedding configuration: the cloud handles all embedding server-side. This is actually marginally better than Alt 1 for read-heavy team members (e.g., senior architects reviewing code), but the onboarding time is the same.

**Alt 3 — Score: 2**

A new developer runs `claudemem sync`, which triggers `git fetch origin refs/claudemem/indexes/<HEAD-sha>` followed by selective download of missing chunk Arrow files from the shared pool. For a 10,000-chunk repo with 1024-dimension vectors, the Arrow file payload is approximately 40–60MB (same as Alt 1). This is within the 5-minute window on fast connections.

However, for a repository with 100,000 chunks (a medium-sized monorepo), the vector Arrow files approach 400MB. Git fetch operations at this scale are slow and error-prone. Git LFS must be pre-configured (a non-trivial setup step for new developers). The risk of timeout or corrupted partial fetch is higher than with a purpose-built REST API with retry logic. The score of 2 reflects the realistic large-repo scenario, not the happy-path small-repo case.

---

### Dimension 5: Server Operational Complexity

**Alt 1 — Score: 4**

The cloud service requires approximately 5 REST endpoints, a PostgreSQL database (commit index + chunk metadata), and a vector search service (Qdrant or pgvector). No ML workloads run server-side. A single container deployment on Fly.io or AWS Fargate is viable for the MVP. The API is stateless and horizontally scalable at the query path. Operational burden is comparable to a standard REST API + database + cache stack that any backend-capable team can manage. The main operational concern is maintaining the ANN index as the number of commits grows — periodic compaction of old commit entries is needed.

**Alt 2 — Score: 1**

The cloud service requires: an embedding service (with ML model management, GPU or API cost management), a symbol graph service (stateful, must handle concurrent writes from 100 developers), an enrichment queue (Redis or SQS + LLM API management), a BM25 full-text index, and a search service that coordinates ANN + BM25 reranking. This is a multi-service architecture that requires container orchestration (Kubernetes or ECS), queue management, and ML infrastructure. The alternatives document estimates 10–12 person-weeks just for the initial build. Ongoing operations require expertise in all these systems. This is a significant operational investment for a new product.

**Alt 3 — Score: 5**

Zero server infrastructure. The git remote is the store. No deployment, no monitoring, no on-call rotation, no database migrations, no scaling decisions. The operational cost is truly zero. This is the maximum simplicity score.

---

### Dimension 6: Client Complexity

**Alt 1 — Score: 4**

Six new TypeScript source files in `src/cloud/`: HTTP client, auth manager, uploader orchestrator, diff detector, overlay index, and overlay merger. The existing `src/core/` modules are completely unchanged. The new interfaces (`ICloudIndexClient`, `IChangeDetector`, `IOverlayIndex`) integrate cleanly with the existing factory-function and dependency injection patterns already present in the codebase. The alternatives document notes that `IEmbeddingsClient`, `ILLMClient`, and `IDocumentExtractor` are explicitly not changed (TC-2.3). Client complexity is moderate and well-contained.

**Alt 2 — Score: 3**

Client complexity is similar to Alt 1, but with two additional complications. First, the polling loop for server-side embedding status (Step 5 in the alternatives document) adds a non-trivial async coordination layer — the client must poll until all accepted hashes have been embedded before writing the commit index. This polling is inherently fragile (timeout handling, exponential backoff, partial completion states). Second, score normalization in the `OverlayMerger` is more complex because the cloud returns scores from its embedding space and the overlay returns scores from the local embedding space, which are not commensurable without normalization.

**Alt 3 — Score: 2**

The client must implement LanceDB-to-Arrow serialization, Arrow-to-LanceDB deserialization, orphan branch management (create, populate, commit, push, cleanup), selective git refspec fetching, manifest diffing against parent index, and Git LFS integration. The git subprocess orchestration involves detached HEAD state manipulation and orphan branch cleanup, which is error-prone and difficult to test. A partial push that leaves the repository in an inconsistent orphan branch state requires careful recovery logic. The client surface area is larger than Alternatives 1 or 2, and the failure modes are harder to recover from gracefully.

---

### Dimension 7: Offline Resilience

**Alt 1 — Score: 3**

When the cloud is unreachable, the system degrades to local-only mode. The local overlay (uncommitted changes) continues to work. The shared team index is unavailable, but the developer can still search their own commits if a local cache of the cloud index was previously populated via `claudemem sync`. NFR-2.3 requires "clear user-facing warning" — this is straightforward to implement. The score is 3 (not higher) because the cloud is required for real-time team search; offline mode is a fallback, not a first-class mode.

**Alt 2 — Score: 2**

Same as Alt 1 for developers who have a local cache of the cloud index. However, developers who relied on the cloud for embedding (i.e., search-only developers without a local embedding API key configured) lose all cloud search functionality when offline. The overlay can still work if a local embedding provider is available (Ollama), but a developer using only the cloud embedding path is completely blocked. This is a more severe degradation than Alt 1.

**Alt 3 — Score: 5**

After `claudemem sync`, search is fully local indefinitely. The system has no network dependency at query time. The `CLAUDEMEM_OFFLINE=1` environment variable (TC-3.3) fully disables network operations — including git push (for publishing). Air-gapped environments work without modification after the initial sync. This is the strongest offline story of the three alternatives.

---

### Dimension 8: Build Effort

**Alt 1 — Score: 4**

Estimated 6–7 person-weeks for MVP including client code and cloud service. The cloud service is straightforward (5 endpoints, standard database, Qdrant or pgvector). The client work leverages existing interfaces and factory patterns. This is a realistic timeline for a small team (2 engineers). The TC-4.1 phasing constraint (MVP = core cloud index + diff-based reindexing; overlay and enrichment dedup are later phases) allows further scope reduction.

**Alt 2 — Score: 2**

Estimated 10–12 person-weeks. The cloud service alone requires building: an embedding pipeline, a symbol graph store, a PageRank service, an enrichment queue + LLM integration, and a hybrid BM25 + ANN search service. Each of these is a non-trivial engineering workload. The client work is similar to Alt 1. For a new product where build effort is explicitly flagged as a priority concern, this timeline is a significant risk.

**Alt 3 — Score: 4**

Estimated 6–7 person-weeks, equal to Alt 1 in raw person-week estimate. However, the work is distributed differently: zero server cost but more complex client code (serialization, git subprocess management, LFS integration). The client code is also harder to test (requires a real or mocked git remote with LFS support), which increases testing time. The estimate is similar but the uncertainty range is wider — git edge cases (orphan branch failures, partial pushes, LFS quota issues) can add significant debugging time.

---

### Dimension 9: Scalability

**Alt 1 — Score: 4**

Qdrant handles 500K+ vectors natively with payload filtering by commit SHA. The commit index table uses a normalized relational model where unchanged files are stored by reference (not duplicated), so storage scales with unique chunk count, not commit count. 100 concurrent developers uploading to different commits are handled by content-addressed deduplication and transactional commit writes (PostgreSQL transactions prevent corruption). The main scaling challenge is ANN index scoping as commit count grows into the thousands — Qdrant payload filters perform well but periodic compaction of obsolete commit entries is required. NFR-4.4 (horizontal scaling of query path independent of write path) is achievable with read replicas.

**Alt 2 — Score: 5**

The cloud is purpose-built for scale: embedding service scales horizontally behind a queue, Qdrant handles ANN at high vector counts, PostgreSQL handles the symbol graph with standard indexing, and the search service can be scaled independently. The authoritative server-side symbol graph (one per commit, not per-developer) avoids consistency issues at scale. This is the architecturally strongest scaling story, designed explicitly for 500K chunks and 100-developer teams.

**Alt 3 — Score: 1**

Git is not designed to store large binary files or handle concurrent writes from 100 developers to shared branches. The critical failure modes at scale are:

1. **Git object store bloat**: 500K chunks × 1024-dimension float32 vectors = ~2GB of binary data. Without Git LFS, this makes the repository unusable for normal git operations. With Git LFS, it requires LFS storage capacity and incurs LFS bandwidth costs on every clone.

2. **Concurrent publish conflicts**: 100 developers simultaneously pushing to `refs/claudemem/chunks` (the shared chunk pool) will produce frequent push conflicts, requiring rebasing or force-push semantics that corrupt the shared pool.

3. **GitHub/GitLab per-repo limits**: GitHub has a 5GB repository size limit (with LFS quota). A large team's index data can approach or exceed this.

4. **Per-file size limits**: GitHub enforces a 100MB per-file limit. Arrow files for large symbol tables can exceed this.

The alternatives document rates the git object store bloat risk as "High / High" and the initial publish timeout as "High / Medium." At 500K chunks and 100 developers, this alternative fails operationally.

---

### Dimension 10: Git Workflow Integration

**Alt 1 — Score: 4**

`claudemem index --cloud` maps cleanly to the post-commit hook pattern already implemented in `git/hook-manager.ts`. The watch daemon's cloud-aware mode triggers an incremental cloud index update after each commit. `claudemem sync` is a clear, purposeful command for pulling team indexes. The git workflow is not altered — developers commit as usual and the cloud index updates happen automatically in the background. The integration is additive and does not require developers to change their workflow.

**Alt 2 — Score: 4**

From the developer workflow perspective, Alt 2 is identical to Alt 1. The `claudemem index --cloud` command triggers the cloud path. Developers do not need to know that embedding is happening server-side vs. locally. The polling wait (Step 5) is the only visible behavioral difference — the indexing command may take slightly longer to return as it waits for cloud embedding completion. This is addressable with a progress indicator. Git workflow integration is equally natural.

**Alt 3 — Score: 3**

The core git integration is more intrusive. The `claudemem index --publish` command must create an orphan branch, manipulate the working tree, commit, push to a non-standard refspec, and restore the original branch — a complex sequence of git operations that executes within the developer's repository. If interrupted partway through, the developer may be left in a detached HEAD state or with an uncommitted claudemem branch in their working tree.

Additionally, developers unfamiliar with claudemem will see unexpected branches in `git branch -a` output (`refs/claudemem/indexes/*`, `refs/claudemem/chunks`). A `claudemem git-config` command to configure local fetch refspec hiding is required as part of onboarding — adding friction. The git workflow integration is workable but less clean than Alternatives 1 or 2.

---

## 4. Critical Factor Deep Dives

### 4.1 Why Source Code Privacy Eliminates Alternative 2

The requirements document states in FR-4.1: "Raw source code MUST NOT be transmitted to the cloud." The user has emphasized that source code privacy is critical. Alternative 2 transmits chunk text — the actual content of functions, classes, and methods — to the cloud. While this is technically derived content (not raw files), it is semantically equivalent to source code for any practical confidentiality purpose.

Enterprise customers (the primary market for a team tool) evaluate "what data leaves our machines?" Any answer other than "only opaque float vectors and hashes" will fail security review at most regulated enterprises. The alternatives document's own risk table rates this as "High / High": "Chunk content privacy rejection by enterprise customers."

Alternative 2 would require maintaining two separate product tiers (privacy-preserving and smart-cloud), which doubles product complexity. For an MVP, this is not viable.

**Alternative 2 is eliminated from recommendation by FR-4.1 and the user's stated privacy priority.**

### 4.2 Why Git-Native Fails at Scale

Alternative 3 is architecturally pure and operationally simple, but it has two hard failure modes that occur before the system reaches the scale targets in NFR-4:

**Embedding model divergence (rated Critical in alternatives document):** Embedding vectors from Voyage AI (`voyage-code-3`, 1024 dimensions) are mathematically incommensurable with vectors from Ollama (`nomic-embed-text`, 768 dimensions). A team where even one developer uses a different provider produces incorrect search results when vectors are mixed in the same LanceDB table. The alternatives document rates this as "High likelihood / Critical impact." While model enforcement via config is possible, it cannot be enforced programmatically at git push time — a developer can push a non-compliant index without detection until search results degrade. Teams with strict model discipline (all using the same hosted provider) can avoid this, but the assumption of team-wide embedding uniformity is fragile.

**Git scalability ceiling:** At the NFR-4 targets (500K chunks, 100 developers), git becomes a bottleneck: the object store bloats, concurrent pushes to shared pool branches produce conflicts, and GitHub/GitLab file size and repo size limits are approached. These are not mitigatable through client code — they are fundamental constraints of using git as a binary blob store.

**Alternative 3 is viable for small teams (< 10 developers) with < 50K chunks and strict model discipline, but does not satisfy NFR-4.**

### 4.3 Why Diff-Based Reindexing Favors Alternative 1

The user specifically asked for diff-based reindexing efficiency. Alternative 1 implements this most directly and most efficiently:

1. Client computes `git diff <parent>...<HEAD>` → gets changed file list.
2. Client chunks only changed files → content hashes.
3. Client sends hashes to cloud via `POST /v1/chunks/check` → receives list of already-stored hashes.
4. Client embeds only missing hashes → uploads.
5. Client sends commit index write with changed files only.
6. Server copies unchanged file->hash mappings from parent commit record (O(1) per unchanged file in a single SQL copy).

The hash deduplication step (step 3) is the key efficiency lever. In a team actively working on a shared codebase, most chunks in any given commit already exist from other developers' prior commits (common dependencies, stable utility code, etc.). The 70%+ dedup target (NFR-1.4) is achievable with very modest team activity — even a team of 3 developers sharing a codebase will quickly saturate the hash store for stable code.

Alternative 3 also supports diff-based publishing (checking parent manifest before uploading), but the deduplication benefit only helps future consumers — the indexing developer pays full embedding cost regardless.

### 4.4 Existing Codebase Readiness for Alternative 1

The requirements document (Section 6, Internal Dependencies) identifies that the existing codebase already has:

- `IEmbeddingsClient` interface (already stable — TC-2.3 confirms it will not change)
- Factory functions for indexer components
- `git/hook-manager.ts` for post-commit hook integration
- `mcp-server.ts` with `ToolDeps` dependency injection container

The new abstractions required for Alt 1 (`IVectorStore`, `IFileTracker`, `IIndexLock`, `IChangeDetector`, `ICloudIndexClient`, `IOverlayIndex`) are all additive — they extract interfaces from existing concrete classes or introduce new interfaces above the existing stack. TC-2.2 confirms existing local indexes are not affected. TC-4.2 confirms the MVP must not require changes to the local indexing path.

Alternative 1 is the architecture that most naturally extends the existing codebase patterns without requiring structural changes.

---

## 5. Risk Comparison

| Risk | Alt 1 (Thin Cloud) | Alt 2 (Smart Cloud) | Alt 3 (Git-Native) |
|---|---|---|---|
| Source code leaves machine | None | High — chunk text sent to cloud | None |
| Embedding model divergence | Mitigable — client enforces model at upload time; server rejects mismatched vectors | Eliminated — single cloud model | Critical — detected only after incorrect search results appear |
| Offline team search | Degraded to last sync cache | More degraded (search-only devs may lose access entirely) | Best — fully local after sync |
| Build complexity | Medium — custom cloud service (simple) | High — multi-service cloud (complex) | Medium — git subprocess complexity |
| Scalability ceiling | High — Qdrant + PostgreSQL + horizontal scaling | Highest — purpose-built multi-service | Low — git binary storage and concurrent write limits |
| Stale search results | None — cloud query is always fresh | None — cloud query is always fresh | Systematic — results are from last sync |
| First-developer embedding cost | Full cost paid once per unique chunk | Zero (cloud pays) | Full cost paid per developer |
| Enterprise adoption blocker | None | High — chunk text privacy rejection | Moderate — git LFS setup friction |

---

## 6. Recommendation

### Recommended Alternative: Alternative 1 (Thin Cloud)

**Alternative 1 is the correct choice for the MVP.**

The recommendation is based on the following hierarchy of priorities as stated in the user's requirements:

**Priority 1: Source code privacy.** Alternative 1 sends only float vectors and content hashes to the cloud. Alternative 2 is eliminated by FR-4.1 and the user's explicit emphasis on privacy.

**Priority 2: Shared cloud indexes with local overlay.** The user explicitly asked for shared cloud indexes with a local overlay for uncommitted changes. Alternative 3's sync-based approach means the "shared cloud index" is a local copy that can be stale. Alternative 1 provides true real-time cloud search with authoritative results.

**Priority 3: Diff-based reindexing efficiency.** Alternative 1 implements this most efficiently: the hash deduplication check before embedding (Step 3 in the indexing flow) means embeddings are computed once per unique chunk across the entire team. This directly achieves the 70%+ dedup target in NFR-1.4.

**Priority 4: Build effort.** At 6–7 person-weeks, Alternative 1 is tied with Alternative 3 in raw estimate but has lower risk variance. Alternative 2 at 10–12 person-weeks is incompatible with MVP priorities for a new product.

**Priority 5: Existing codebase readiness.** The existing factory functions and dependency injection patterns are precisely the right foundation for the new `ICloudIndexClient` interface and the `src/cloud/` module structure. No existing interfaces need to change.

### Why Not Alternative 3?

Alternative 3 is eliminated by two hard technical constraints:

1. **Embedding model divergence** is rated Critical and High-likelihood. This risk cannot be fully mitigated at the client level and degrades the core value proposition (accurate semantic search) silently.

2. **Git scalability ceiling** (NFR-4: 500K chunks, 100 developers) is not achievable with git as a binary object store. The system would require a complete architectural migration before reaching this scale target.

Alternative 3 is appropriate as a future self-hosted or air-gapped offering — it is architecturally correct for that constraint set — but it cannot be the primary cloud/team MVP.

### Why Not Alternative 2?

Alternative 2 is eliminated by FR-4.1 as interpreted by the user's privacy emphasis. Chunk text leaving the machine is functionally equivalent to source code leaving the machine for enterprise security purposes.

The secondary elimination factor is build effort: 10–12 person-weeks for an MVP is inconsistent with "build effort matters" as a stated priority.

### Recommended Phasing (Alternative 1)

Align with the TC-4.1 phasing constraint:

**Phase 1 (MVP — 6-7 weeks):** Core cloud index with diff-based reindexing.
- `ICloudIndexClient` interface + HTTP client
- `GitDiffChangeDetector`
- Uploader with hash deduplication (`POST /v1/chunks/check` + `POST /v1/chunks/upload`)
- Commit index write (`POST /v1/commits`) with server-side parent inheritance
- `claudemem index --cloud` flag
- `claudemem sync` command
- Cloud service: PostgreSQL schema + Qdrant + 5 REST endpoints

**Phase 2 (4-5 weeks):** Local dirty overlay.
- `IOverlayIndex` + `IOverlayMerger`
- Overlay stored in `{project}/.claudemem/overlay/`
- `OverlayMerger` to suppress dirty-path results from cloud and interleave by score
- Watch daemon cloud-aware mode
- MCP server `ToolDeps` extension

**Phase 3 (3-4 weeks):** Shared enrichment deduplication + symbol graph.
- LLM enrichment deduplication by content hash (server-side opt-in)
- PageRank upload (`PATCH /v1/commits/:sha/pagerank`)
- Symbol graph metadata download for local graph reconstruction
- Auth system (OS keychain, `team login/logout/status` CLI commands)

This phasing satisfies TC-4.1 explicitly (Phase 1 = MVP, Phase 2 = overlay, Phase 3 = enrichment dedup) and aligns with the TC-4.2 constraint (MVP must not require changes to existing local indexing path).

---

## 7. Final Score Summary

| Alternative | Total Score | Weighted Score (privacy x2) | Recommendation |
|---|:---:|:---:|---|
| **Alt 1: Thin Cloud** | **41/50** | **46/55** | **Recommended for MVP** |
| Alt 3: Git-Native | 34/50 | 39/55 | Recommended for air-gapped / self-hosted future offering |
| Alt 2: Smart Cloud | 32/50 | 34/55 | Not recommended — privacy violation eliminates from consideration |
