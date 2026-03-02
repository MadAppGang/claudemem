# claudemem MCP Server — Plugin Developer Integration Guide

Complete implementation reference for plugin developers integrating with the claudemem MCP server. This document covers server configuration, all 18 MCP tools (11 structured + 7 legacy), response formats, freshness tracking, and recommended integration patterns.

---

## Table of Contents

- [Server Overview](#server-overview)
- [Plugin Configuration (.mcp.json)](#plugin-configuration)
- [Environment Variables](#environment-variables)
- [Response Format](#response-format)
- [Freshness Metadata](#freshness-metadata)
- [Tool Reference: Structured Tools (11)](#structured-tools)
  - [search](#search)
  - [symbol](#symbol)
  - [callers](#callers)
  - [callees](#callees)
  - [context](#context)
  - [map](#map)
  - [dead_code](#dead_code)
  - [test_gaps](#test_gaps)
  - [impact](#impact)
  - [index_status](#index_status)
  - [reindex](#reindex)
- [Tool Reference: Legacy Tools (7)](#legacy-tools)
  - [index_codebase](#index_codebase)
  - [search_code](#search_code)
  - [clear_index](#clear_index)
  - [get_status](#get_status)
  - [list_embedding_models](#list_embedding_models)
  - [report_search_feedback](#report_search_feedback)
  - [get_learning_stats](#get_learning_stats)
- [Integration Patterns](#integration-patterns)
- [Error Handling](#error-handling)
- [Lifecycle & Concurrency](#lifecycle--concurrency)
- [Disk Layout](#disk-layout)

---

## Server Overview

claudemem is a local semantic code search tool that exposes an MCP (Model Context Protocol) server over stdio transport. When started with `claudemem --mcp`, it:

- Registers 18 MCP tools for code search, symbol navigation, and analysis
- Watches the workspace for file changes (auto-detects code modifications from any source)
- Auto-reindexes in the background with a configurable debounce (default: 120s)
- Returns immediately on every tool call with cached data plus freshness metadata
- Shares the `.claudemem/` index directory with CLI commands (concurrent-safe via lock file)

**Package:** `claude-codemem` (npm)
**Binary:** `claudemem`
**Transport:** stdio (stdin/stdout JSON-RPC)
**Protocol:** MCP 2024-11-05
**Server version:** 0.20.1

### Startup Sequence

```
claudemem --mcp
  │
  [1] Parse environment variables → McpConfig
  [2] Create stderr logger (configurable level)
  [3] Initialize IndexStateManager (read .reindex-timestamp, check lock files)
  [4] If no index.db → run blocking initial index (claudemem index --quiet)
  [5] Create IndexCache (lazy-load, invalidated on reindex)
  [6] Create CompletionDetector (poll for background reindex completion)
  [7] Create DebounceReindexer (timer-based, spawns detached child)
  [8] Start FileWatcher (fs.watch with pattern filtering + dedup)
  [9] Register all 18 MCP tools
  [10] Connect stdio transport → MCP handshake
  [11] Register SIGTERM/SIGINT shutdown handlers
  │
  Enter event loop (stays alive until SIGTERM)
```

---

## Plugin Configuration

Minimal `.mcp.json` — all environment variables have sensible defaults:

```json
{
  "claudemem": {
    "command": "claudemem",
    "args": ["--mcp"]
  }
}
```

With custom configuration:

```json
{
  "claudemem": {
    "command": "claudemem",
    "args": ["--mcp"],
    "env": {
      "CLAUDEMEM_DEBOUNCE_MS": "60000",
      "CLAUDEMEM_LOG_LEVEL": "info"
    }
  }
}
```

The host spawns `claudemem --mcp` and communicates via stdin/stdout using the MCP JSON-RPC protocol. The server stays alive until it receives SIGTERM (sent when the host session ends).

---

## Environment Variables

All configuration is read once at startup. No hot-reload.

| Variable | Type | Default | Description |
|---|---|---|---|
| `CLAUDEMEM_INDEX_DIR` | path (relative to CWD) | `.claudemem` | Index storage directory |
| `CLAUDEMEM_DEBOUNCE_MS` | integer | `120000` (2 min) | Delay after last file change before auto-reindex triggers |
| `CLAUDEMEM_WATCH_PATTERNS` | comma-separated globs | `**/*.{ts,tsx,js,jsx,go,py,rs,java,kt,swift,rb,php,c,cpp,h}` | File patterns to watch for changes |
| `CLAUDEMEM_IGNORE_PATTERNS` | comma-separated globs | `node_modules/**,.git/**,dist/**,build/**,.next/**,coverage/**` | Patterns to exclude from watching |
| `CLAUDEMEM_MAX_MEMORY_MB` | integer | `500` | Memory budget for in-memory index cache |
| `CLAUDEMEM_COMPLETION_POLL_MS` | integer | `2000` | Poll interval for detecting reindex completion |
| `CLAUDEMEM_LOG_LEVEL` | `debug\|info\|warn\|error` | `warn` | Minimum log level (output goes to stderr, never stdout) |

**Parsing rules:**
- Invalid numeric values silently fall back to defaults
- Comma-separated patterns: `"node_modules/**,dist/**"` → `["node_modules/**", "dist/**"]`
- Empty or missing values use defaults

---

## Response Format

Every MCP tool returns responses in the standard MCP format:

```json
{
  "content": [
    {
      "type": "text",
      "text": "{\"results\": [...], \"freshness\": \"fresh\", ...}"
    }
  ]
}
```

The `text` field contains a JSON-stringified payload. Parse it to access structured data.

**Error responses** add `isError: true`:

```json
{
  "content": [
    {
      "type": "text",
      "text": "Error: No index found at /path/.claudemem. Run 'claudemem index' first."
    }
  ],
  "isError": true
}
```

---

## Freshness Metadata

Every tool response (except `reindex`) includes freshness metadata as top-level fields in the JSON payload. This tells the caller whether the index is current or stale.

```typescript
interface FreshnessMetadata {
  freshness: "fresh" | "stale";
  lastIndexed: string | null;      // ISO 8601 timestamp
  staleSince: string | null;       // ISO 8601 timestamp
  filesChanged: string[];          // relative paths
  reindexingInProgress: boolean;
  responseTimeMs: number;          // wall-clock ms for this tool call
}
```

**Freshness rules:**

| Condition | freshness |
|---|---|
| No files changed AND lastIndexed is set AND no reindex running | `"fresh"` |
| Any file changed since last index | `"stale"` |
| Never indexed (lastIndexed is null) | `"stale"` |
| Reindex currently in progress | `"stale"` |

**Example fresh response:**
```json
{
  "results": [...],
  "freshness": "fresh",
  "lastIndexed": "2026-03-03T12:30:00.000Z",
  "staleSince": null,
  "filesChanged": [],
  "reindexingInProgress": false,
  "responseTimeMs": 47
}
```

**Example stale response:**
```json
{
  "results": [...],
  "freshness": "stale",
  "lastIndexed": "2026-03-03T12:30:00.000Z",
  "staleSince": "2026-03-03T12:32:10.000Z",
  "filesChanged": ["src/auth.ts", "lib/token.ts"],
  "reindexingInProgress": true,
  "responseTimeMs": 52
}
```

---

## Structured Tools

### search

Semantic + BM25 hybrid code search with auto-indexing of changed files.

**Input:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `query` | string (2-500 chars) | yes | — | Natural language or code search query |
| `limit` | integer (1-50) | no | 10 | Maximum number of results |
| `filePattern` | string (glob) | no | — | Filter results by file path pattern |

**Output:**

```json
{
  "results": [
    {
      "file": "src/core/indexer.ts",
      "line": 42,
      "lineEnd": 58,
      "symbol": "createIndexer",
      "snippet": "export function createIndexer(options: IndexerOptions)...",
      "score": 0.95,
      "vectorScore": 0.92,
      "keywordScore": 0.98
    }
  ],
  "totalMatches": 5,
  "autoIndexed": 2,
  "freshness": "fresh",
  "lastIndexed": "...",
  "staleSince": null,
  "filesChanged": [],
  "reindexingInProgress": false,
  "responseTimeMs": 245
}
```

**Notes:**
- `autoIndexed` shows how many changed files were incrementally indexed before searching
- `snippet` is truncated to 800 characters
- `symbol` is null for non-symbol chunks (e.g., plain text blocks)
- `vectorScore` and `keywordScore` are the individual component scores

---

### symbol

Find a symbol definition and its usages via the AST reference graph.

**Input:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `symbol` | string | yes | — | Symbol name to look up |
| `kind` | enum: `function\|class\|interface\|type\|variable\|any` | no | `any` | Filter by symbol kind |
| `includeUsages` | boolean | no | `true` | Include caller/usage locations |

**Output:**

```json
{
  "definition": {
    "file": "src/core/indexer.ts",
    "line": 42,
    "kind": "function",
    "name": "createIndexer",
    "signature": "(options: IndexerOptions) => Indexer",
    "isExported": true,
    "pageRank": 0.087
  },
  "usages": [
    {
      "file": "src/cli.ts",
      "line": 156,
      "context": "async function indexCommand(path: string)",
      "enclosingSymbol": "indexCommand"
    }
  ],
  "usageCount": 12,
  ...freshness
}
```

**Notes:**
- `definition` is `null` if the symbol is not found
- When `kind` is not `"any"`, only definitions matching that kind are returned
- `pageRank` > 0.05 indicates a high-importance symbol
- Prefers exported symbols when multiple matches exist

---

### callers

Traverse the call graph upward — find what depends on a symbol, ranked by PageRank.

**Input:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `symbol` | string | yes | — | Symbol to find callers of |
| `depth` | integer (1-5) | no | 1 | BFS traversal depth (1 = direct callers only) |
| `limit` | integer (1-100) | no | 20 | Maximum callers to return |

**Output:**

```json
{
  "totalDirectCallers": 5,
  "callers": [
    {
      "symbol": "indexCommand",
      "file": "src/cli.ts",
      "line": 156,
      "pageRank": 0.142,
      "depth": 1
    }
  ],
  ...freshness
}
```

**Notes:**
- Results are sorted by PageRank descending (most important callers first)
- `totalDirectCallers` always reflects depth=1 count regardless of the `depth` parameter
- Returns `error` field with message if symbol is not found (not `isError`)

---

### callees

Traverse the call graph downward — find what a symbol depends on.

**Input:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `symbol` | string | yes | — | Symbol to find dependencies of |
| `depth` | integer (1-5) | no | 1 | BFS traversal depth |
| `excludeExternal` | boolean | no | `false` | Exclude symbols from node_modules or external packages |

**Output:**

```json
{
  "callees": [
    {
      "symbol": "FileTracker",
      "file": "src/core/tracker.ts",
      "line": 24,
      "isExternal": false,
      "depth": 1
    }
  ],
  ...freshness
}
```

**Notes:**
- `isExternal` is true for symbols in `node_modules/` or with `external:` prefix in filePath
- When `excludeExternal` is true, external callees are still traversed (for deeper dependencies) but not included in results

---

### context

Get rich context for a file location: enclosing symbol, imports, and related symbols.

**Input:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `file` | string | yes | — | File path relative to workspace root |
| `line` | integer | no | 1 | Line number within the file |
| `radius` | integer (1-10) | no | 2 | Number of related symbols (callers + callees) to include |

**Output:**

```json
{
  "enclosingSymbol": {
    "name": "registerSearchTools",
    "kind": "function",
    "file": "src/mcp/tools/search.ts",
    "startLine": 14,
    "endLine": 103,
    "signature": "(server: McpServer, deps: ToolDeps) => void"
  },
  "imports": [
    "src/core/indexer.ts",
    "src/mcp/tools/deps.ts"
  ],
  "relatedSymbols": {
    "callers": [
      { "name": "startMcpServer", "file": "src/mcp/server.ts", "line": 191 }
    ],
    "callees": [
      { "name": "buildFreshness", "file": "src/mcp/tools/deps.ts", "line": 30 }
    ]
  },
  ...freshness
}
```

**Notes:**
- `enclosingSymbol` is the innermost symbol containing the given line (null if none found)
- `imports` lists unique file paths that symbols in the target file depend on
- File matching supports both exact paths and suffix matching (`src/foo.ts` matches `foo.ts`)

---

### map

Generate an architectural overview of the codebase with PageRank-ranked symbols.

**Input:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `root` | string | no | `"."` | Root directory (relative to workspace) to map |
| `depth` | integer (1-8) | no | 3 | Token budget in thousands (3 = ~3000 tokens of output) |
| `includeSymbols` | boolean | no | `true` | Include symbol signatures in the map |

**Output:**

```json
{
  "mapText": "# Repository Map\n\n## src/\n├── core/\n│   ├── indexer.ts\n│   │   ├── createIndexer(options) [PageRank: 0.089]\n...",
  ...freshness
}
```

**Notes:**
- `mapText` is a plain-text tree representation, not JSON
- The `depth` parameter controls output size (token budget), not directory depth
- Symbols are sorted by PageRank — most important appear first
- Useful for giving an AI agent a quick overview of project structure

---

### dead_code

Find unreferenced symbols (zero callers and low PageRank) for codebase cleanup.

**Input:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `minReferences` | integer (0-10) | no | 0 | Minimum reference count; symbols with fewer are flagged |
| `filePattern` | string (glob) | no | — | Restrict analysis to matching files |
| `limit` | integer (max 200) | no | 50 | Maximum results |

**Output:**

```json
{
  "deadSymbols": [
    {
      "symbol": "unusedHelper",
      "kind": "function",
      "file": "src/utils/old.ts",
      "line": 42,
      "referenceCount": 0,
      "pageRank": 0.0003,
      "reason": "zero_callers"
    }
  ],
  "totalAnalyzed": 12,
  ...freshness
}
```

**Notes:**
- Only flags symbols with PageRank < 0.001 (avoids false positives on well-connected code)
- `reason` explains why the symbol was flagged (e.g., `"zero_callers"`, `"low_pagerank"`)

---

### test_gaps

Find high-importance symbols (by PageRank) with no test coverage.

**Input:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `filePattern` | string | no | `"src/"` | Path prefix to restrict source file analysis |
| `testPattern` | string | no | auto-detected | Override test file pattern (default: language-aware detection) |
| `limit` | integer (max 100) | no | 30 | Maximum results |

**Output:**

```json
{
  "untestedSymbols": [
    {
      "symbol": "createIndexer",
      "kind": "function",
      "file": "src/core/indexer.ts",
      "line": 42,
      "pageRank": 0.089,
      "testReferences": 0,
      "callerCount": 12
    }
  ],
  "summary": {
    "totalSourceSymbols": 156,
    "untestedCount": 18,
    "coveragePercent": 88
  },
  ...freshness
}
```

**Notes:**
- Only flags symbols with PageRank >= 0.005 (focuses on important code)
- Test detection is language-aware: `*.test.ts`, `test_*.py`, `*_test.go`, etc.
- `coveragePercent` is based on symbol count, not line count

---

### impact

Analyze the blast radius of changing a symbol — transitive callers grouped by file.

**Input:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `symbol` | string | yes | — | Symbol to analyze |
| `depth` | integer (max 5) | no | 3 | Transitive caller traversal depth |

**Output:**

```json
{
  "directDependents": 5,
  "transitiveDependents": 23,
  "affectedFiles": ["src/cli.ts", "src/mcp/server.ts"],
  "impactedSymbols": [
    {
      "symbol": "indexCommand",
      "file": "src/cli.ts",
      "line": 156,
      "depth": 1
    }
  ],
  "riskLevel": "medium",
  ...freshness
}
```

**Risk level rules:**

| Transitive dependents | riskLevel |
|---|---|
| > 20 | `"high"` |
| > 5 | `"medium"` |
| <= 5 | `"low"` |

---

### index_status

Get index health and server status. No inputs required.

**Input:** `{}` (empty object)

**Output:**

```json
{
  "initialized": true,
  "indexPath": "/home/user/project/.claudemem",
  "indexDbLastIndexed": "2026-03-03T12:30:00.000Z",
  "indexSizeBytes": 15728640,
  "indexedFileCount": 156,
  "fileWatcherActive": true,
  "serverUptime": 3600000,
  ...freshness
}
```

**Notes:**
- `initialized` is false if `index.db` doesn't exist
- `serverUptime` is in milliseconds
- `indexedFileCount` comes from the tracker stats (may be 0 if cache not loaded yet)

---

### reindex

Trigger a background or blocking reindex. **Does NOT include freshness metadata** (it changes index state).

**Input:**

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `force` | boolean | no | `false` | Skip debounce, reindex immediately |
| `blocking` | boolean | no | `false` | Wait until reindex completes before returning |

**Output (non-blocking):**

```json
{
  "status": "started",
  "message": "Reindex started immediately."
}
```

**Possible status values:**

| status | Meaning |
|---|---|
| `"started"` | Reindex was triggered (force) or scheduled (debounced) |
| `"already_running"` | A reindex is already in progress (in-memory or disk lock) |
| `"completed"` | Blocking mode: reindex finished successfully |
| `"failed"` | Reindexer not configured, or blocking timed out |

**Output (blocking, completed):**

```json
{
  "status": "completed",
  "durationMs": 5234,
  "message": "Reindex completed successfully"
}
```

**Race condition safety:** The server checks both the in-memory `running` flag AND the disk lock file (`isRunning()`) before triggering a new reindex. If a reindex is already in progress:
- Non-blocking: returns `"already_running"` immediately
- Blocking: waits for the existing reindex to complete, then returns `"completed"` or `"failed"`

---

## Legacy Tools

These 7 tools preserve backward compatibility with older plugin versions. They return markdown-formatted text (not JSON) but include freshness metadata appended to the response.

### index_codebase

Index a project with embeddings and optional LLM enrichment.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `path` | string | CWD | Project path |
| `force` | boolean | `false` | Force re-index |
| `model` | string | — | Embedding model override |
| `enableEnrichment` | boolean | `true` | Enable LLM-based code summaries |

### search_code

Semantic search with auto-indexing (old format with learning system support).

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | — | Search query (required) |
| `limit` | integer | 10 | Max results |
| `language` | string | — | Filter by programming language |
| `path` | string | CWD | Project path |
| `autoIndex` | boolean | `true` | Auto-index changed files first |
| `useCase` | `"fim"\|"search"\|"navigation"` | — | Search preset tuning |

### clear_index

Clear the code index for a project.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `path` | string | CWD | Project path |

### get_status

Get index status in markdown format.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `path` | string | CWD | Project path |

### list_embedding_models

List available embedding models from OpenRouter.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `freeOnly` | boolean | — | Show only free models |

### report_search_feedback

Report feedback to improve adaptive ranking.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `query` | string | — | Original search query (required) |
| `allResultIds` | string[] | — | All chunk IDs from search (required) |
| `helpfulIds` | string[] | — | Chunk IDs the user found helpful |
| `unhelpfulIds` | string[] | — | Chunk IDs the user found unhelpful |
| `sessionId` | string | — | Session identifier |
| `useCase` | `"fim"\|"search"\|"navigation"` | — | Search use case |
| `path` | string | CWD | Project path |

### get_learning_stats

Get adaptive learning system statistics.

| Parameter | Type | Default | Description |
|---|---|---|---|
| `path` | string | CWD | Project path |

---

## Integration Patterns

### Pattern 1: Check freshness before expensive operations

```
1. Call index_status → check freshness
2. If stale → call reindex({ force: true, blocking: true })
3. Proceed with analysis tools
```

### Pattern 2: Fire-and-forget reindex

```
1. Call reindex({ force: true, blocking: false }) → returns immediately
2. Continue with tool calls using stale data
3. freshness metadata tells the model results may be outdated
4. On next tool call, index will be fresh
```

### Pattern 3: Symbol investigation workflow

```
1. search({ query: "authentication" }) → find relevant code
2. symbol({ symbol: "authenticateUser" }) → get definition + usages
3. callers({ symbol: "authenticateUser", depth: 2 }) → who depends on it
4. impact({ symbol: "authenticateUser" }) → blast radius if changed
```

### Pattern 4: Codebase overview for new project

```
1. index_status → verify index exists
2. map({ depth: 5 }) → architectural overview
3. test_gaps → find untested critical code
4. dead_code → find cleanup opportunities
```

### Pattern 5: Context-aware code editing

```
1. context({ file: "src/auth.ts", line: 42 }) → get enclosing symbol + imports
2. callers({ symbol: enclosingSymbol.name }) → understand who calls this
3. callees({ symbol: enclosingSymbol.name }) → understand dependencies
4. Make informed edit with full understanding of impact
```

---

## Error Handling

### Error response format

```json
{
  "content": [{ "type": "text", "text": "Error: <message>" }],
  "isError": true
}
```

### Common errors

| Error | Cause | Recovery |
|---|---|---|
| `No index found at <path>` | Index doesn't exist | Call `reindex({ force: true, blocking: true })` or `index_codebase` |
| `Symbol "<name>" not found in index` | Symbol doesn't exist or index is stale | Check spelling, try `search` first, or reindex |
| `Reindexer not configured` | Server started without watch mode | Restart server or use CLI commands |
| `Timed out waiting for reindex` | Blocking reindex exceeded 5-minute timeout | Large codebase — try non-blocking mode |

### Graceful degradation

- If the index cache fails to load, tools return errors but don't crash the server
- If auto-indexing fails during `search`, the search proceeds with the existing index
- If the file watcher fails to start, the server continues without watching (manual reindex only)

---

## Lifecycle & Concurrency

### Graceful shutdown (SIGTERM/SIGINT)

```
SIGTERM received
  → DebounceReindexer.cancelPending()  (cancel scheduled reindex)
  → FileWatcher.stop()                 (stop watching files)
  → CompletionDetector.stop()          (stop polling)
  → IndexCache.close()                 (release resources)
  → process.exit(0)
```

Any in-flight background reindex (spawned as detached process) continues to completion independently.

### CLI concurrency

The MCP server and `claudemem index` CLI can run simultaneously:

1. CLI acquires disk lock → runs index → releases lock
2. MCP server's `DebounceReindexer.isRunning()` returns true → skips its own reindex
3. MCP server's `CompletionDetector` detects: lock removed + mtime changed → fires `onReindexComplete()`
4. MCP server transparently picks up CLI-triggered reindex results

No coordination protocol needed — the lock file + mtime polling handles everything.

### Race condition protection

The `reindex` tool checks both:
- **In-memory flag** (`this.running`) — covers the gap between spawn and lock file creation
- **Disk lock** (`IndexLock.isLocked()`) — covers reindex triggered by CLI or another process

This prevents duplicate concurrent reindex operations.

---

## Disk Layout

```
{workspace}/
└── .claudemem/                    (CLAUDEMEM_INDEX_DIR)
    ├── index.db                   (LanceDB vector + BM25 index)
    ├── ast-graph.json             (symbol reference graph with PageRank)
    ├── .indexing.lock             (PID lock during active reindex)
    └── .reindex-timestamp         (ISO timestamp of last completed reindex)
```

- `index.db` — SQLite-based LanceDB database with vector embeddings and BM25 index
- `ast-graph.json` — JSON file containing the full symbol reference graph, call edges, and PageRank scores
- `.indexing.lock` — Present only during active reindex; contains the PID of the indexing process
- `.reindex-timestamp` — Written on every successful reindex completion; read on server startup to restore `lastIndexed` state
