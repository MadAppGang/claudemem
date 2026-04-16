# Session report: `mnemex rg` finalise + e2e

Date: 2026-04-14 → 2026-04-15
Scope: Finish loose ends on the `mnemex rg` feature, commit, run real e2e tests against Claude Code.

## Outcome

Mixed. The code-level work is complete and tested; the integration premise is broken.

**Done and validated:**
- `src/rg/` module — parser, merger, install/uninstall. 92 unit + e2e tests pass.
- 2 bugs found and fixed during testing:
  - Absolute-path leakage: mnemex's absolute paths bled into merged output alongside rg's relative paths. Fixed with `normalizePath` using `pathRelative(cwd, abspath)`.
  - Pseudo-file leakage: `docs:typescript` enrichment entries appeared in `-l` output. Fixed with `isRealFilePath` filter.
- **Flag semantics fix** (Task #2): `matchesPattern` now honors `-F`, `-w`, `-x`, `-i`, `-s`, `-S`. Parser extracts these flags into `MatchFlags`; merger threads them through.
- **Process teardown fix** (Task #3): 31.1s → 2.13s per invocation (14.6× speedup). Root cause was LanceDB native handles keeping Bun event loop alive after stdout flush; fixed with `process.exit()` after output.
- **Fixture corpus**: `tests/fixtures/rg-corpus/` — sindresorhus/is @ v6.1.0, 5 source files, committed `.mnemex/` index (5.5MB, 241 chunks, Voyage embeddings).
- **E2e test suite**: `tests/rg.e2e.test.ts` — 13 tests covering semantic-prepend, rg-preservation, fallback byte-equality, flag fidelity. All passing.
- **README updated**: `rg install`/`uninstall` documented, integrated into CLI reference.

**The broken integration premise:**

The `mnemex rg install` → `~/.local/bin/rg` shim + `USE_BUILTIN_RIPGREP=0` flow does **not** redirect Claude Code's Grep tool on the stable Bun-compiled Claude Code binary (v2.1.108). Empirically confirmed with a logging shim:

| Env var | `--bare` | Result |
|---------|----------|--------|
| `USE_BUILTIN_RIPGREP=0` | no | Shim not invoked. Grep result in natural file-walk order. |
| `USE_BUILTIN_RIPGREP=1` | no | Shim not invoked. |
| `USE_BUILTIN_RIPGREP=true` | no | Shim not invoked. |
| `USE_BUILTIN_RIPGREP=1` | yes | Shim not invoked. |

Inspecting Claude Code's binary reveals why: the ripgrep selection logic short-circuits to `embedded` mode on Bun builds before `USE_BUILTIN_RIPGREP` is checked. The `system` mode path is unreachable from user env.

```js
// Simplified from Claude Code binary
if (USE_BUILTIN_RIPGREP truthy) { /* system */ }   // path 1 — never reached on Bun
if (Hf() /* Bun? */) {
  /* embedded: process.execPath --no-config rg */   // path 2 — always wins on Bun
}
/* vendored builtin */                              // path 3 — unreached
```

## Investigation of alternative integration mechanisms

| Mechanism | Works? | Complexity | Notes |
|-----------|--------|-----------|-------|
| PreToolUse hook on Grep | Partial (block-only) | Low | Can deny or modify input params; can't inject alternative tool_result. Breaks the agentic loop. |
| PostToolUse hook on Grep | Partial (annotate-only) | Medium | Can add `additionalContext` but can't replace result content. Relies on model choosing to use the extra context. |
| Plugin shadow built-in | **No** | N/A | Plugins cannot override built-in tools. |
| MCP custom tool alongside Grep | Yes | Low | Exposes `search_code` as a separate tool (mnemex already does this). Policy-level, not mechanism-level — relies on the model picking mnemex's tool over native Grep. |
| Undocumented env vars | None found | N/A | No `CLAUDE_RIPGREP_PATH` or equivalent. |
| Non-Bun Claude Code build | Probably works | High | Would require a Node-based install path. Currently unsupported upstream. |

## Recommendation

1. **Do not commit the `mnemex rg install` flow as-is with the README claim that Claude Code will use it.** That's false on current stable builds.
2. The `src/rg/` standalone CLI work is still valuable for:
   - Direct shell use (`mnemex rg <pattern>`)
   - Non-Claude-Code grep tools that honour PATH
   - A future Claude Code version that exposes a proper override
3. If the goal is real Claude Code integration today, the paths are:
   - Short term: lean harder on the MCP `search_code` tool (already shipped) and update docs to recommend it over native Grep.
   - Medium term: file an upstream issue requesting an unconditional `CLAUDE_RIPGREP_COMMAND` env hook.
   - Long term: build a PreToolUse hook that detects Grep calls, denies them, and injects a prompt nudge to retry via the MCP search tool. Fragile but doable.

## Artifacts

- Code: `src/rg/*`, `src/cli.ts` (handleRg wiring, path normalization), `src/rg/merger.ts` (flag semantics, path normalization, pseudo-file filter)
- Tests: `tests/rg.test.ts` (79 unit tests), `tests/rg.e2e.test.ts` (13 e2e tests)
- Fixture: `tests/fixtures/rg-corpus/` with committed `.mnemex/` index
- Shell test: `tests/rg.claude-code-e2e.sh` (install + direct-shim + claude-session)
- Docs: README section added, `claude-code-integration-finding.md` written up
