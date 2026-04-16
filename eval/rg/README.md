# `eval/rg` — Claude Code × mnemex rg end-to-end eval

Promptfoo harness that validates the full integration chain:

```
user prompt
  → Claude Code (Haiku 4.5)
    → Grep tool
      → ~/.local/bin/rg (shim installed by `mnemex rg install`)
        → bundled ripgrep (via `mnemex rg`)
          → fixture corpus with committed `.mnemex/` index
```

The suite exists because the rest of the rg test coverage (`tests/rg.test.ts`,
`tests/rg.e2e.test.ts`) stops at the mnemex binary boundary. This eval reaches
one layer higher and confirms Claude Code itself routes Grep tool calls through
our shim, which was non-obvious to set up and documented incorrectly at first
(see `ai-docs/sessions/dev-research-rg-shim-bypass-*/report.md`).

## Prerequisites

1. `mnemex rg install` has been run — writes `~/.local/bin/rg` and sets
   `USE_BUILTIN_RIPGREP=0` in `~/.claude/settings.json[env]`.
2. `~/.local/bin` is on `$PATH` before the shell launches.
3. The fixture corpus at `tests/fixtures/rg-corpus/` is in the repo (it is).
4. `claude` CLI on PATH (v2.1.108 or newer).
5. `ANTHROPIC_API_KEY` or equivalent auth for the Haiku 4.5 driver.
6. `promptfoo` installed (`bun install -g promptfoo` or use `npx promptfoo`).

## Running

```bash
cd eval/rg
promptfoo eval
```

To view results interactively:

```bash
promptfoo view
```

Each run takes ~2 minutes (6 cases × ~20s Haiku sessions, sequential).
Logs from the last test case land in `eval/rg/logs/`.

## What each test case proves

| # | Case | Shim-chain evidence |
|---|------|---------------------|
| 1 | Plain Grep for a symbol | Tool invoked with pattern = `isArray`, shim hit ≥1 time, result contains `source/index.ts` |
| 2 | `--count` output mode | Tool invoked with `output_mode: count`, result matches `file:N` pattern |
| 3 | `files_with_matches` mode | Tool invoked with `output_mode: files_with_matches`, result is a path |
| 4 | `--glob` restriction | Glob filter reaches shim (visible in shim trace tail) |
| 5 | Regex pattern | Pattern with metacharacters flows through unbroken |
| 6 | No-match pattern | Wrapper's exit-code-1 handling doesn't break the chain |

All cases share three baseline assertions:
- `exit_code === 0` — the driver script + claude session completed
- `grep_tool_call_count >= 1` — the model chose Grep (prompt isn't misworded)
- `shim_grep_hits >= 1` — a Grep-shaped invocation actually reached the shim

## Files

- `drive.sh` — bash driver, called once per test case by promptfoo's `exec`
  provider. Installs the shim, clears the trace log, spawns `claude -p`,
  parses stream-json, emits one JSON line for assertions to consume.
- `promptfooconfig.yaml` — suite definition: provider, tests, assertions.
- `logs/last-cc.jsonl`, `logs/last-shim.log` — written on every run for
  post-mortem debugging. Safe to delete.

## Extending

To add a test case, append to `tests:` in `promptfooconfig.yaml`. The prompt
needs to clearly instruct Haiku to use the Grep tool — the model is cheap and
follows direct instructions well, but vague prompts ("find isArray") cause it
to reach for Bash or give up.

To switch the driver model (e.g. to measure how Sonnet routes tools
differently), change the `--model haiku` argument in `drive.sh`.
