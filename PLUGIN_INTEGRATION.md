# claudemem Plugin Integration Guide

**Version:** 0.2.0
**For:** Plugin Developer Agents
**Purpose:** Comprehensive integration instructions for claudemem enriched semantic code search

---

## 1. Architecture Overview

claudemem is a **3-layer semantic code search system**:

```
┌─────────────────────────────────────────────────────────────┐
│                      SEARCH LAYER                           │
│  Query → Embed → Vector Search + BM25 → Ranked Results      │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                   ENRICHMENT LAYER (LLM)                    │
│  file_summary │ symbol_summary │ idiom │ usage_example      │
│  (1 call/file)│ (batched/file) │       │                    │
└─────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────┐
│                     INDEX LAYER                             │
│  AST Parse → Chunk (functions/classes) → Embed → LanceDB   │
└─────────────────────────────────────────────────────────────┘
```

### Key Insight
Search queries match BOTH:
- **Raw code chunks** (exact implementation, syntax)
- **LLM-enriched summaries** (semantic meaning, purpose, behavior)

This dual-matching dramatically improves semantic understanding.

---

## 2. Document Types

### 2.1 code_chunk (Raw AST Code)

**Source:** Tree-sitter AST parsing
**Content:** Actual code blocks (functions, classes, methods)
**Best for:** Implementation details, signatures, exact syntax

```typescript
interface CodeChunk {
  id: string;              // SHA256 hash
  content: string;         // Raw code
  filePath: string;
  startLine: number;       // 1-indexed
  endLine: number;
  chunkType: "function" | "class" | "method" | "module" | "block";
  name?: string;           // Function/class name
  parentName?: string;     // Enclosing class (for methods)
  signature?: string;      // Extracted signature
}
```

**When to prioritize:**
- Finding exact implementations
- Looking up function signatures
- Code completion (FIM)
- Syntax-level understanding

---

### 2.2 file_summary (LLM-Enriched)

**Source:** LLM analysis (1 call per file)
**Content:** File purpose, exports, dependencies, patterns
**Best for:** Architecture discovery, understanding file roles

```typescript
interface FileSummary {
  documentType: "file_summary";
  filePath: string;
  language: string;
  summary: string;              // High-level purpose
  responsibilities: string[];   // 2-3 bullet points
  exports: string[];            // Public API
  dependencies: string[];       // Imports
  patterns: string[];           // Middleware, hooks, etc.
}
```

**When to prioritize:**
- Understanding codebase structure
- Finding entry points
- Mapping dependencies
- Architecture analysis

**Example enriched content:**
```
File: src/core/indexer.ts
Purpose: Core indexing orchestrator for claudemem
Responsibilities:
- Coordinates file scanning, parsing, and embedding
- Manages incremental updates via content hashing
- Integrates with enrichment pipeline for LLM summaries
Exports: CodebaseIndexer, IndexStatus
Dependencies: VectorStore, FileTracker, Enricher
Patterns: Factory pattern, progress callbacks
```

---

### 2.3 symbol_summary (LLM-Enriched, Batched)

**Source:** LLM analysis (1 call for ALL symbols in file)
**Content:** Function/class documentation
**Best for:** API understanding, finding by behavior

```typescript
interface SymbolSummary {
  documentType: "symbol_summary";
  filePath: string;
  symbolName: string;
  symbolType: "function" | "class" | "method";
  summary: string;              // One sentence
  parameters?: Array<{
    name: string;
    description: string;
  }>;
  returnDescription?: string;
  sideEffects?: string[];       // API calls, state mutations
  usageContext?: string;        // When/where to use
}
```

**When to prioritize:**
- Finding functions by behavior (not name)
- Understanding parameters and returns
- Identifying side effects
- API exploration

**Example enriched content:**
```
function: enrichFiles
Summary: Enriches multiple files using batched LLM calls for efficiency
Parameters:
- files: Array of files with content and code chunks
- options: Concurrency and progress callback settings
Returns: EnrichmentResult with document counts and errors
Side effects: Stores documents in vector store, updates tracker
Usage: Called during index --enrich or standalone enrich command
```

---

### 2.4 Additional Document Types (Disabled by Default)

These types are implemented but disabled due to LLM call overhead:

| Type | Purpose | LLM Calls |
|------|---------|-----------|
| `idiom` | Project patterns/conventions | Multiple/file |
| `usage_example` | Code examples per symbol | 1/symbol (up to 10) |
| `anti_pattern` | Things to avoid | Multiple/file |
| `project_doc` | Generated documentation | Project-level |

Enable via config if needed:
```json
{
  "enrichment": {
    "types": ["file_summary", "symbol_summary", "idiom"]
  }
}
```

---

## 3. Search Use Cases & Weight Presets

claudemem provides three optimized search modes:

### 3.1 FIM (Fill-in-Middle) Completion

**Use case:** Code completion, autocomplete
**Optimizes for:** Exact code patterns

```typescript
const weights = {
  code_chunk: 0.50,      // Prioritize raw code
  usage_example: 0.25,   // Examples for patterns
  idiom: 0.15,           // Project conventions
  symbol_summary: 0.10,  // Minimal semantic
};
```

**CLI:** `claudemem search "query" --use-case fim`

---

### 3.2 Search (Human Queries)

**Use case:** Developer searching codebase
**Optimizes for:** Balanced understanding

```typescript
const weights = {
  file_summary: 0.25,    // Architecture context
  symbol_summary: 0.25,  // Function docs
  code_chunk: 0.20,      // Implementation
  idiom: 0.15,           // Patterns
  usage_example: 0.10,   // Examples
  anti_pattern: 0.05,    // Warnings
};
```

**CLI:** `claudemem search "query"` (default)

---

### 3.3 Navigation (Agent Discovery)

**Use case:** AI agent exploring codebase
**Optimizes for:** Understanding structure

```typescript
const weights = {
  symbol_summary: 0.35,  // API surface
  file_summary: 0.30,    // File purposes
  code_chunk: 0.20,      // Implementation
  idiom: 0.10,           // Conventions
  project_doc: 0.05,     // High-level docs
};
```

**CLI:** `claudemem search "query" --use-case navigation`

---

## 4. CLI Commands Reference

### 4.1 Index Codebase

```bash
# Basic indexing (AST + embeddings only)
claudemem index [path]

# Force full re-index
claudemem index -f

# Index with LLM enrichment
claudemem index --enrich

# Force re-index with enrichment
claudemem index -f --enrich
```

### 4.2 Enrich Indexed Files

```bash
# Run enrichment on indexed files
claudemem enrich [path]

# Control parallelism (default: 10)
claudemem enrich --concurrency 5

# Enrich specific path
claudemem enrich ./src/core
```

### 4.3 Search

```bash
# Semantic search (default: search use case)
claudemem search "authentication middleware"

# Limit results
claudemem search "error handling" -n 20

# Filter by language
claudemem search "class definition" -l typescript

# Specific use case
claudemem search "validate input" --use-case navigation
```

### 4.4 Status

```bash
# Show index and enrichment status
claudemem status

# Output includes:
# - Total files/chunks indexed
# - Document type counts (code_chunk, file_summary, symbol_summary)
# - Enrichment progress (pending/complete)
# - Embedding model used
```

### 4.5 AI Instructions

```bash
# Get role-specific instructions
claudemem ai architect    # System design focus
claudemem ai developer    # Implementation focus
claudemem ai tester       # Test coverage focus
claudemem ai debugger     # Error tracing focus

# Raw output for clipboard
claudemem ai developer --raw | pbcopy
```

---

## 5. MCP Server Integration

For Claude Code integration via MCP:

### 5.1 Available Tools

```typescript
// Semantic search
search_code(
  query: string,
  limit?: number,        // Default: 10
  language?: string,     // Filter by language
  autoIndex?: boolean    // Auto-index changes (default: true)
)

// Index codebase
index_codebase(
  path?: string,         // Default: current directory
  force?: boolean,       // Force re-index
  model?: string         // Override embedding model
)

// Get status
get_status(path?: string)

// Clear index
clear_index(path?: string)

// List models
list_embedding_models(freeOnly?: boolean)
```

### 5.2 MCP Configuration

Add to `.mcp.json`:
```json
{
  "mcpServers": {
    "claudemem": {
      "command": "claudemem",
      "args": ["--mcp"]
    }
  }
}
```

---

## 6. Integration Patterns for Plugins

### 6.1 Pattern: Semantic-First Discovery

**Anti-pattern:** Sequential file reads, grep for keywords
**Best practice:** Semantic search → targeted file reads

```typescript
// WRONG: Read all files
const files = await glob("src/**/*.ts");
for (const file of files) {
  const content = await read(file);
  if (content.includes("auth")) { /* ... */ }
}

// RIGHT: Semantic search first
const results = await claudemem.search("authentication flow user login");
for (const result of results) {
  // Only read high-scoring matches
  if (result.score > 0.7) {
    const fullFile = await read(result.document.filePath);
    // Process with context
  }
}
```

### 6.2 Pattern: Use Case Selection

Match search mode to task:

```typescript
// For code completion agent
const snippets = await claudemem.searchForFIM("async function handle");

// For architecture exploration
const structure = await claudemem.searchForNavigation("service layer");

// For human-like queries
const results = await claudemem.searchForHuman("how is auth implemented");
```

### 6.3 Pattern: Document Type Filtering

Request specific document types:

```typescript
// Only get LLM-enriched summaries (skip raw code)
const summaries = await claudemem.search("payment processing", {
  documentTypes: ["file_summary", "symbol_summary"],
  includeCodeChunks: false,
});

// Only get raw code (skip summaries)
const code = await claudemem.search("validateEmail function", {
  documentTypes: ["code_chunk"],
});
```

### 6.4 Pattern: Progressive Discovery

Start broad, narrow down:

```typescript
// Step 1: Broad architecture search
const architecture = await claudemem.search("authentication", {
  documentTypes: ["file_summary"],
  limit: 5,
});

// Step 2: Specific function search
const authFiles = architecture.map(r => r.document.filePath);
const functions = await claudemem.search("validate JWT token", {
  documentTypes: ["symbol_summary"],
  pathPattern: authFiles.join("|"),
});

// Step 3: Implementation details
const impl = await claudemem.search("JWT verification", {
  documentTypes: ["code_chunk"],
  limit: 3,
});
```

---

## 7. Best Practices

### 7.1 Query Construction

| Goal | Bad Query | Good Query |
|------|-----------|------------|
| Find auth code | `"auth"` | `"authentication flow user login"` |
| Find validators | `"validate"` | `"input validation before save"` |
| Find error handling | `"error"` | `"error handling retry logic"` |
| Find API endpoints | `"route"` | `"REST API endpoint handler"` |

### 7.2 Score Interpretation

| Score | Meaning | Action |
|-------|---------|--------|
| > 0.85 | Strong match | Use directly |
| 0.70-0.85 | Good match | Review briefly |
| 0.50-0.70 | Partial match | Verify manually |
| < 0.50 | Weak match | Refine query |

### 7.3 Document Type Selection

| Task | Primary Types | Why |
|------|---------------|-----|
| Architecture discovery | `file_summary` | Understands file purposes |
| API exploration | `symbol_summary` | Has params, returns, side effects |
| Code completion | `code_chunk` | Exact syntax needed |
| Understanding behavior | `symbol_summary` | LLM-analyzed purpose |
| Finding patterns | `idiom` | Project conventions |

### 7.4 Performance Tips

1. **Use specific queries** - Vague queries waste API calls
2. **Limit results** - Don't fetch 100 when you need 5
3. **Filter by type** - Skip document types you don't need
4. **Check enrichment status** - Verify index is enriched before relying on summaries
5. **Use navigation mode for agents** - Optimized weights for AI exploration

---

## 8. Anti-Patterns to Avoid

### 8.1 grep for Semantic Discovery

```bash
# WRONG: No semantic understanding
grep -r "function.*auth" src/

# RIGHT: Semantic matching
claudemem search "authentication handler"
```

### 8.2 Reading All Files

```bash
# WRONG: Context overload
cat src/**/*.ts | head -10000

# RIGHT: Targeted discovery
claudemem search "entry point" -n 5
# Then read specific files
```

### 8.3 Single-Word Queries

```bash
# WRONG: Too broad, low signal
claudemem search "error"

# RIGHT: Contextual query
claudemem search "error handling database connection retry"
```

### 8.4 Ignoring Document Types

```typescript
// WRONG: Treating all results the same
for (const result of results) {
  console.log(result.content);
}

// RIGHT: Handle by type
for (const result of results) {
  switch (result.documentType) {
    case "file_summary":
      // Architecture context
      break;
    case "symbol_summary":
      // API documentation
      break;
    case "code_chunk":
      // Implementation details
      break;
  }
}
```

### 8.5 Skipping Enrichment Status Check

```typescript
// WRONG: Assuming enrichment is done
const results = await claudemem.search("auth", {
  documentTypes: ["symbol_summary"],  // May be empty!
});

// RIGHT: Check status first
const status = await claudemem.getStatus();
if (status.enrichment?.complete) {
  const results = await claudemem.search("auth", {
    documentTypes: ["symbol_summary"],
  });
}
```

---

## 9. Configuration Reference

### 9.1 Project Config (.claudemem/config.json)

```json
{
  "model": "qwen/qwen3-embedding-8b",
  "excludePatterns": ["*.test.ts", "dist/**", "node_modules/**"],
  "includeExtensions": [".ts", ".tsx", ".js"],
  "enrichment": {
    "enabled": true,
    "types": ["file_summary", "symbol_summary"],
    "llmProvider": "claude-code"
  },
  "searchWeights": {
    "navigation": {
      "symbol_summary": 0.4,
      "file_summary": 0.35,
      "code_chunk": 0.25
    }
  }
}
```

### 9.2 Global Config (~/.claudemem/config.json)

```json
{
  "openrouterApiKey": "sk-or-...",
  "embeddingProvider": "openrouter",
  "defaultModel": "qwen/qwen3-embedding-8b",
  "llmProvider": "anthropic",
  "anthropicApiKey": "sk-ant-...",
  "enableEnrichment": true
}
```

### 9.3 Environment Variables

```bash
OPENROUTER_API_KEY=sk-or-...    # Embeddings API
ANTHROPIC_API_KEY=sk-ant-...    # LLM enrichment
CLAUDEMEM_MODEL=voyage-code-3   # Override model
```

---

## 10. Supported Languages

| Language | Extensions | Tree-sitter Support |
|----------|------------|---------------------|
| TypeScript | .ts, .tsx | Full |
| JavaScript | .js, .jsx | Full |
| Python | .py | Full |
| Go | .go | Full |
| Rust | .rs | Full |
| C | .c, .h | Full |
| C++ | .cpp, .hpp | Full |
| Java | .java | Full |

---

## 11. Troubleshooting

### Problem: No enriched results

```bash
# Check enrichment status
claudemem status

# Run enrichment if needed
claudemem enrich
```

### Problem: Slow enrichment

```bash
# Reduce concurrency
claudemem enrich --concurrency 3

# Or disable symbol summaries (file_summary only)
# Edit .claudemem/config.json:
# "enrichment": { "types": ["file_summary"] }
```

### Problem: Low search scores

- Use more descriptive queries
- Check if files are indexed: `claudemem status`
- Try different use case: `--use-case navigation`

### Problem: Missing files

```bash
# Check exclude patterns
cat .claudemem/config.json

# Force re-index
claudemem index -f
```

---

## 12. Version History

| Version | Changes |
|---------|---------|
| 0.2.0 | LLM enrichment layer, batched symbol summaries, parallel processing |
| 0.1.x | Basic embedding search, AST chunking |

---

## Summary

1. **Search enriched content** - Queries match both raw code AND LLM summaries
2. **Use the right mode** - FIM for completion, search for humans, navigation for agents
3. **Filter by document type** - file_summary for architecture, symbol_summary for APIs
4. **Chain searches** - Broad → specific for best results
5. **Check enrichment status** - Verify summaries exist before relying on them
6. **Avoid grep/cat** - Semantic search saves context and finds meaning
