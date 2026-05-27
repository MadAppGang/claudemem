# `eval/rg` — Claude Code × mnemex rg end-to-end eval

Promptfoo + Inspect AI harnesses that validate the full integration chain:

```
user prompt
  → Claude Code (Haiku 4.5)
    → Grep tool
      → temporary ~/.local/bin/rg logging shim
        → temporary mnemex wrapper
          → bun dist/index.js rg ...
            → bundled ripgrep + mnemex semantic search
          → testdata corpus with committed `.mnemex/` index
```

The suite exists because the rest of the rg test coverage (`tests/rg.test.ts`,
`tests/rg.e2e.test.ts`) stops at the mnemex binary boundary. This eval reaches
one layer higher and confirms Claude Code itself routes Grep tool calls through
our shim, which was non-obvious to set up and documented incorrectly at first
(see `ai-docs/sessions/dev-research-rg-shim-bypass-*/report.md`).

## Layers

| Layer | Command | Purpose |
|---|---|---|
| Binary/e2e | `bun test tests/rg.test.ts tests/rg.e2e.test.ts` | Proves `mnemex rg` keeps rg-compatible output and preserves vanilla rg matches |
| Promptfoo smoke | `cd eval/rg && promptfoo eval --no-cache` | Fast YAML matrix for Claude Code Grep routing |
| Inspect eval | `inspect eval eval/rg/inspect_eval.py@rg_plugin` | Rich eval logs with per-case contract scoring and rescore support |

## Prerequisites

1. `bun run build` has produced `dist/index.js`.
2. The testdata corpus at `tests/testdata/rg-corpus/` is in the repo (it is).
3. `claude` CLI is on PATH and authenticated.
4. `ANTHROPIC_API_KEY` or equivalent auth for the Haiku driver if your Claude
   Code setup requires it.
5. For promptfoo: `promptfoo` installed (`bun install -g promptfoo` or use
   `npx promptfoo`).
6. For Inspect: `pip install -r eval/rg/requirements.txt`.

The eval driver writes a temporary logging shim to `~/.local/bin/rg`, puts a
temporary `mnemex` wrapper at the front of PATH, sets `USE_BUILTIN_RIPGREP=0`
for the launched Claude process, and restores the prior `~/.local/bin/rg`
after each case. This means the eval does not require a permanent
`mnemex rg install`.

## Running

```bash
cd eval/rg
promptfoo eval --no-cache
```

To view results interactively:

```bash
promptfoo view
```

Each run takes ~2 minutes (6 cases × ~20s Haiku sessions, sequential).

For Inspect:

```bash
pip install -r eval/rg/requirements.txt
inspect eval eval/rg/inspect_eval.py@rg_plugin
inspect view
```

Logs from each driver invocation land in `eval/rg/logs/`.

## What each test case proves

| # | Case | Contract evidence |
|---|------|---------------------|
| 1 | Plain Grep for a symbol | Tool invoked with pattern = `isArray`, rg shim hit, `mnemex rg` hit, result contains `source/index.ts` |
| 2 | `--count` output mode | Tool invoked with `output_mode: count`, result matches `file:N` pattern |
| 3 | `files_with_matches` mode | Tool invoked with `output_mode: files_with_matches`, result is a path |
| 4 | `--glob` restriction | Glob filter reaches `mnemex rg` and returns `test/test.ts` |
| 5 | Regex pattern | Pattern with metacharacters flows through unbroken |
| 6 | No-match pattern | Wrapper's exit-code-1 handling doesn't break the chain |

All cases share three baseline assertions:
- `exit_code === 0` — the driver script + claude session completed
- `grep_tool_call_count >= 1` — the model chose Grep (prompt isn't misworded)
- `forbidden_tool_call_count === 0` — the model did not recover through Bash
- `shim_grep_hits >= 1` — a Grep-shaped invocation actually reached the shim
- `mnemex_rg_hits >= 1` — the shim delegated to `mnemex rg`
- `result_has_absolute_paths === false` — output stayed rg-compatible

## Files

- `driver.py` — shared runner. Installs temporary shims, spawns `claude -p`,
  parses stream-json and trace logs, emits one JSON line.
- `drive.sh` — tiny promptfoo wrapper around `driver.py`.
- `promptfooconfig.yaml` — suite definition: provider, tests, assertions.
- `inspect_eval.py` — Inspect AI task, solver, and scorer.
- `logs/*.jsonl`, `logs/*.log` — written on every run for post-mortem
  debugging. Safe to delete.

## Extending

To add a test case, append to `tests:` in `promptfooconfig.yaml`. The prompt
needs to clearly instruct Haiku to use the Grep tool — the model is cheap and
follows direct instructions well, but vague prompts ("find isArray") cause it
to reach for Bash or give up.

To switch the driver model (e.g. to measure how Sonnet routes tools
differently), pass `-T model=sonnet` to Inspect or edit the promptfoo provider
wrapper to pass `--model sonnet` through to `driver.py`.
