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
├── mcp-server.ts        # MCP server for Codex
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
7. **OpenTUI `useAlternateScreen: false`** appends lines on re-render instead of overwriting — not suitable for progress bars. Use ANSI cursor-based rendering (`\x1b[${lines}A`) for progress displays
8. **CLI alias ordering**: Flag-style command aliases (e.g. `--watch` → `watch`) must mutate `args` BEFORE `const command = args[0]` to take effect
9. **Data directory**: mnemex uses `.mnemex/` (migrated from `.claudemem/` automatically on first run)
10. **Env vars**: `MNEMEX_MODEL`, `MNEMEX_LLM`, `MNEMEX_DOCS_ENABLED` (renamed from CLAUDEMEM_*)
11. **Wire protocol migration**: HTTP headers renamed `X-ClaudeMem-*` → `X-Mnemex-*`. Server accepts BOTH during migration window; clients send only `X-Mnemex-*`. See `src/cloud/server/middleware.ts` for dual-read logic. Do NOT remove legacy fallback until all deployed clients have upgraded.
12. **Homebrew formula**: lives in the unified tap at `../homebrew-tap/Formula/mnemex.rb` (repo `MadAppGang/homebrew-tap`). The old `homebrew/claudemem.rb` formula in this repo has been deleted.

## Historical Artifacts

The following directories intentionally retain `claudemem` references — they are frozen records of decisions/outputs made under the old name. Do NOT rewrite them:

- **`src/migration.ts`** — runtime migration code that looks for `.claudemem/` directories. Renaming breaks migration for existing users.
- **`src/cloud/**`** — contains intentional `X-ClaudeMem-*` header fallback reads (legacy client compatibility). See gotcha #11.
- **`docs/adr/**`** — architecture decision records are historical. Rewriting them falsifies the record.
- **`ai-docs/sessions/**`, `ai-docs/seo-research-claudemem-positioning.md`, `ai-docs/design-reviews/**`, `ai-docs/research-paper-*/**`** — frozen session records, research artifacts, design reviews.
- **`experiments/query-expansion/results/**`** — frozen experiment JSON outputs from benchmark runs. They may mention HuggingFace model names like `jackrudenko/claudemem-expansion-*`; these are **external identifiers** on HuggingFace, so renaming those identifiers would point at non-existent repos.
- **`eval/mnemex-search-steps-evaluation/runs/**`** — frozen eval run outputs.
- **`.agents/skills/agentbench-eval/SKILL.md`** — agentbench skill doc; references in it describe the repo at a point in time.
- **Lockfiles** (`package-lock.json`, `bun.lock`, `vscode-extension/*-lock.json`) — regenerate on next install.
