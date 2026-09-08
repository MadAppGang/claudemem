# mnemex Development Guide

## Publishing
- We publish with CI/CD (automated releases)

## Architecture Overview

mnemex is a local semantic code search tool that combines:
- **AST parsing** (tree-sitter) for intelligent code chunking
- **Embeddings** (OpenRouter/Ollama) for semantic similarity
- **Symbol graph** with PageRank for importance ranking
- **LanceDB** for local vector storage

### Core Modules

```
src/
├── core/
│   ├── analysis/        # Code analysis (dead-code, test-gaps, impact)
│   │   ├── analyzer.ts      # CodeAnalyzer class
│   │   └── test-detector.ts # Language-aware test file detection
│   ├── graph/           # Symbol graph with PageRank
│   ├── enrichment/      # LLM-based code summaries
│   ├── indexer/         # Code indexing pipeline
│   ├── search/          # Hybrid search (vector + BM25)
│   └── watcher/         # File system watcher
├── git/                 # Git hook integration
│   └── hook-manager.ts  # Post-commit hook management
├── cli.ts               # Main CLI entry point
├── mcp-server.ts        # MCP server for Claude Code
├── ai-instructions.ts   # Role-based AI agent prompts
└── ai-skill.ts          # Skill documents for embedding
```

## Key Commands (v0.3.0)

### Symbol Graph
- `map [query]` - Repo structure with PageRank ranking
- `symbol <name>` - Find symbol definition
- `callers <name>` - What depends on this symbol
- `callees <name>` - What this symbol depends on
- `context <name>` - Full context: symbol + callers + callees

### Code Analysis
- `dead-code` - Find unused symbols (zero callers + low PageRank)
- `test-gaps` - Find untested high-PageRank symbols
- `impact <name>` - Transitive callers across all files

### Developer Experience
- `watch` - Auto-reindex on file changes (daemon)
- `hooks install` - Git post-commit hook for auto-indexing

## Development Patterns

### Adding New Commands
1. Add command case in `cli.ts` switch statement
2. Create handler function following existing patterns
3. Update help text in `printHelp()` function
4. Update README.md CLI reference section
5. Update ai-instructions.ts and ai-skill.ts for AI agents

### Code Analysis Pattern
```typescript
import { createCodeAnalyzer } from "./core/analysis/index.js";

const analyzer = await createCodeAnalyzer(projectPath);
const results = analyzer.findDeadCode({ maxPageRank: 0.001 });
```

### Test File Detection
Uses language-specific patterns:
- TypeScript/JS: `*.test.ts`, `*.spec.ts`, `__tests__/`
- Python: `test_*.py`, `*_test.py`, `tests/`
- Go: `*_test.go`
- etc.

## Testing

```bash
# Run tests
bun test

# Type check
bun run typecheck

# Build
bun run build
```

## AI Integration

### AI Instructions (ai-instructions.ts)
Role-based prompts for different agent personas:
- `architect` - System design, dead-code detection
- `developer` - Implementation, impact analysis
- `tester` - Test coverage gaps, test planning
- `debugger` - Error tracing, bug impact

### AI Skills (ai-skill.ts)
Multiple skill document variants for different contexts:
- `MNEMEX_SKILL` - Full comprehensive skill (~200 lines)
- `MNEMEX_SKILL_COMPACT` - Tight context budgets
- `MNEMEX_MCP_SKILL` - MCP server integration
- `MNEMEX_QUICK_REF` - Minimal token reference

## Evaluation

Evaluation and benchmark work lives in the sibling `../mnemex-bench/` repo. (The old `../agentbench/` pointer is dead — that directory no longer exists, and the `agentbench-eval` skill still describes that layout.)

Layout: `../mnemex-bench/experiments/` holds numbered, self-contained experiment directories, each with its own README. Currently 001–012, e.g. `009-mnemex-vs-serena`, `011-n-way-code-tool-benchmark`, `012-swebench-context-ablation`. Start at `../mnemex-bench/README.md`.

## Common Gotchas

1. **Always use `--agent`** for machine-parseable output (replaces --nologo --raw --plain)
2. **PageRank > 0.05** indicates high-importance symbols
3. **Test file detection** is language-specific (see test-detector.ts)
4. **Impact analysis** uses BFS with depth limiting to avoid infinite loops
5. **Watch mode** uses native `fs.watch` (no external deps like chokidar)
6. **OpenTUI `<text>` overlap**: Multiple `<text>` siblings in a `<box>` render at (0,0). Use single `<text>` per `<box>`, or `<box flexDirection="row">` with each `<text>` in its own `<box>`
7. **OpenTUI `screenMode: "main-screen"`** appends lines on re-render instead of overwriting — not suitable for progress bars. Use ANSI cursor-based rendering (`\x1b[${lines}A`) for progress displays. (OpenTUI ≥ 0.5 replaced the boolean `useAlternateScreen` with `screenMode: "alternate-screen" | "main-screen" | "split-footer"`.)
8. **CLI alias ordering**: Flag-style command aliases (e.g. `--watch` → `watch`) must mutate `args` BEFORE `const command = args[0]` to take effect
9. **Data directory**: mnemex uses `.mnemex/` (migrated from `.claudemem/` automatically on first run)
10. **Env vars**: `MNEMEX_MODEL`, `MNEMEX_LLM`, `MNEMEX_DOCS_ENABLED` (renamed from CLAUDEMEM_*)
11. **Wire protocol migration**: HTTP headers renamed `X-ClaudeMem-*` → `X-Mnemex-*`. Server accepts BOTH during migration window; clients send only `X-Mnemex-*`. See `src/cloud/server/middleware.ts` for dual-read logic. Do NOT remove legacy fallback until all deployed clients have upgraded.
12. **Homebrew formula**: lives in the unified tap at `../homebrew-tap/Formula/mnemex.rb` (repo `MadAppGang/homebrew-tap`). The old `homebrew/claudemem.rb` formula in this repo has been deleted.
13. **Fresh checkout needs 3 steps before `bun test` means anything**: `bun install` → `bun run download-grammars` → `bun run build`. Grammars are gitignored and fetched at build time; several e2e suites spawn the built `dist/index.js` and fail their preconditions without it. Skipping either step produces mass failures that look like code breakage. Any dependency change also invalidates `dist/` — rebuild before testing or you will misattribute staleness to the dep.
14. **`dotenv` must be loaded with `quiet: true`** (`src/index.ts`). dotenv ≥ 17 prints an "injected env" banner to stdout by default, which corrupts `mnemex rg` (contractually byte-identical to ripgrep) and every `--agent` consumer.
15. **Vector dimension is locked at table creation**: LanceDB infers schema from the first batch, so empty embeddings create a permanently unqueryable `FixedSizeList[0]` column. Four guards exist because this failed four different ways; do not remove any of them.

    **Where the empty vectors came from (the root cause, fixed in 0.34.0).** `OllamaEmbeddingsClient.embed` caught per-chunk errors, pushed `[]` and continued, re-throwing only for `ECONNREFUSED`. A model the provider does not have returns 404 for *every* chunk, so every vector was empty and the table was born `FixedSizeList[0]`. The lesson generalises past this one client: a 100% failure rate is never a per-item condition, and an embeddings client that can return `[]` is a corrupt-index generator. `isFatalEmbeddingFailure()` / `assertNotTotalFailure()` in `src/core/embeddings.ts` hold that line for the Ollama, OpenRouter and Voyage clients, and `embedOne` refuses a zero-length vector.

    **Write side**: `assertVectorDimension()` rejects a 0-dim batch at all three write paths. **Read side**: `assertQueryableTableDimension()` rejects `listSize === 0` in `ensureTableOpen()`, the one place every read and write opens the table — reaching native code with such a table panics in Rust on LanceDB 0.13 (`attempt to divide by zero`, uncatchable from JS), raises `LanceError(Schema)` on 0.33+, and returns zero rows in silence on a scan. Compare against `0`, never truthiness; `0` is falsy and is the only value worth catching. **Repair**: an already-corrupt index is now detected at open and rebuilt by the next index run — `clear()` drops the table without going through `ensureTableOpen()`, which is what keeps the repair path reachable. LanceDB ≥ 0.33 refuses to *create* a 0-dim column at all, so only an index written by an older build can be in this state — which also means the fixture cannot be constructed in a test. See `docs/lancedb-0.33-migration-research.md`.

16. **An embedding model name does not identify its provider**: `createEmbeddingsClient` infers the provider from the model *string* — `voyage*` → voyage, `ollama/` → ollama, `lmstudio/` → lmstudio, anything containing `/` → openrouter — and otherwise keeps whatever `config.embeddingProvider` says *right now*. A bare stored name like `nomic-embed-text` matches no rule, so reading it back and rebuilding a client sends it to today's configured provider, not the one that wrote it. This is why the indexer records `embeddingProvider` in tracker metadata beside `embeddingModel`, and why `onModelMismatch: "use-indexed"` passes both into `createEmbeddingsClient`. Indexes written before 0.34.0 have no provider on record; that case is reported by name rather than guessed.
17. **Native/platform deps must be `--external` in `build`**: `@lancedb/lancedb`, `better-sqlite3`, `@opentui/core`, `@opentui/react`. OpenTUI ≥ 0.5 ships 8 per-platform binaries; bundling it makes the build fail resolving the ones for other platforms.
18. **Ollama Cloud is generation-only**: `ollama-cloud/<model>` (e.g. `MNEMEX_LLM=ollama-cloud/gemma4:31b`) routes to `https://ollama.com/v1` via the "local" provider and needs `OLLAMA_API_KEY`. Its `/api/embed` route returns **401 for every model**, so it can NOT back `embeddingProvider`. Use `openrouter` (or local Ollama) for embeddings. Benchmarked on code summarization: `gemma4:31b` 714ms/22 output tokens beats `qwen3.5:397b` 10.3s/807 tokens at equal quality — prefer non-reasoning models for enrichment.
19. **`zod` is pinned via `overrides`; the MCP SDK must share ONE copy with the root.** Two zod majors visible to `src/mcp/tools/**` make the MCP SDK's `zod-compat` `AnySchema` union collapse, giving TS2589 "excessively deep" errors. Without `overrides.zod`, bun flips the SDK's nested copy between 3.x and 4.x across installs, so typecheck passes or fails depending on install order — always keep the pin.

    The tree is on zod 4. `@lmstudio/sdk` declares `^3.22.4` and throws on client construction under zod 4, so `overrides["@lmstudio/sdk"].zod` holds it at 3.x. **npm honours that nested override (verified in `package-lock.json`: root 4.4.3, lmstudio 3.25.76).** Bun used to ignore nested overrides and hand lmstudio the root zod 4; **as of bun 1.4.0 it honours them too** — `bun.lock` moved to `lockfileVersion: 3`, which records nested overrides, and now resolves `@lmstudio/sdk/zod` to 3.25.76 while root zod stays 4.4.3. So the LM Studio **model-size metadata** casualty (LM Studio chat is unaffected — it goes through the OpenAI-compatible `LocalLLMClient`) no longer applies on bun ≥ 1.4.0; `warnLMStudioSdkUnavailable()` in `src/llm/providers/local.ts` should now stay quiet. Do not "simplify" by deleting the nested override: both package managers realise it.

    **Pin the bun version in CI.** `bun-version: latest` floated from 1.3.10 to 1.4.0 and broke `main` — 1.4.0 validates that `bun.lock` records the manifest's overrides, which `lockfileVersion: 1` did not, so `--frozen-lockfile` failed on files that were fine the day before and still passed locally. Both workflows now pin `1.4.0`. Regenerating the lockfile requires the pinned version: an older bun reports "no changes" and cannot produce a lock the newer one accepts.
20. **Progress callbacks must stamp the lock, not just the UI**: `reportProgress()` advances `lastProgressAt`, which is the *sole* input to the hung/stale decision (`lock.ts`, `DEFAULT_PROGRESS_TIMEOUT` = 5 min). `heartbeat` ticks every second regardless and proves nothing. Any long-running loop (embedding, code-unit embedding, docs embedding, enrichment, symbol extraction) must call it per item — stamping only at batch end let a **healthy** run sit 351–363s without progress, past the threshold, making the lock reclaimable and allowing a second indexer onto the same store. Phase labels must also match the work actually running, or stalls get misattributed.

21. **A `private xReady = false` guard on a per-request object never fires**: three separate defects had this exact shape — `FeedbackStore.initializeSchema()`, `FileTracker`'s constructor DDL, and `ensureFtsIndex()`. Each guarded expensive-but-idempotent setup with a per-INSTANCE flag, inside a class constructed once per request, so the setup ran on every call. `IF NOT EXISTS` and `replace: true` make these operations look free; they are idempotent, which is not the same as cheap. Costs measured before fixing: FTS index rebuilt per query at **275 ms** (~50% of search latency), `FileTracker` at **346 µs**, feedback-store DDL at **190 µs**. When reviewing any such guard, do not ask whether it is correct — ask how often the enclosing object is constructed. Memoize on real resource identity (`PRAGMA database_list` file + inode is the established sqlite key here) and always exclude in-memory databases, which report `""` and genuinely need their own setup.

22. **`store.ts` needs THREE SQL-escaping rules, chosen by operator context**: LanceDB 0.33 has no parameterized predicate API (`Table.delete`, `countRows` and `Query.where` all take a pre-rendered string), so escaping is the caller's job — and any uniform rule breaks something. Equality and `IN` over arbitrary values need quote-doubling only (`escapeSqlLiteral`); `LIKE` patterns need quote-doubling **plus** backslash-escaping of `%` and `_` (`escapeFilterValue`); an `IN` over a closed union with no quotes (`DocumentType`) needs no escaping at all. SQL string literals do not process backslash escapes, so the LIKE escaper in an equality predicate renders `filePath = 'src/my\_file.ts'` and matches **zero rows** — that is what silently disabled incremental-reindex vector reuse for underscored filenames, and what made every type-filtered enriched search return nothing (10 of 11 `DocumentType` members contain an underscore). A test pins the two helpers apart; do not "unify" them. The durable fix is a predicate-builder seam that takes values rather than fragments, so the operator context picks the escaper — proposed, not built.

23. **The shebang in `src/index.ts` and `--compile-exec-argv` in the binary builds carry `--env-file=/dev/null`** because bun auto-loads cwd `.env` into `process.env` before any user code runs; without it `TERM_THEME`/`MNEMEX_THEME` from a `.env` file are indistinguishable from the real environment (FR3 of the theme feature). `dotenv` in `src/index.ts` is the only `.env` loader. Dev runs need `bun --env-file=/dev/null src/index.ts` to get the same behaviour. The spelling must be `--env-file=/dev/null` (not `--no-env-file`, which leaks through `--compile-exec-argv`).

## Historical Artifacts

The following directories intentionally retain `claudemem` references — they are frozen records of decisions/outputs made under the old name. Do NOT rewrite them:

- **`src/migration.ts`** — runtime migration code that looks for `.claudemem/` directories. Renaming breaks migration for existing users.
- **`src/cloud/**`** — contains intentional `X-ClaudeMem-*` header fallback reads (legacy client compatibility). See gotcha #11.
- **`docs/adr/**`** — architecture decision records are historical. Rewriting them falsifies the record.
- **`ai-docs/sessions/**`, `ai-docs/seo-research-claudemem-positioning.md`, `ai-docs/design-reviews/**`, `ai-docs/research-paper-*/**`** — frozen session records, research artifacts, design reviews.
- **`experiments/query-expansion/results/**`** — frozen experiment JSON outputs from benchmark runs.
- **`experiments/query-expansion/training/**`, `experiments/query-expansion/bench/run-finetuned.py`** — training scripts that reference HuggingFace model names like `jackrudenko/claudemem-expansion-*`. These are **external identifiers** on HuggingFace — renaming here would point at non-existent repos.
- **`eval/mnemex-search-steps-evaluation/runs/**`** — frozen eval run outputs.
- **`.agents/skills/agentbench-eval/SKILL.md`** — agentbench skill doc; references in it describe the repo at a point in time.
- **Lockfiles** (`package-lock.json`, `bun.lock`, `vscode-extension/*-lock.json`) — regenerate on next install.
