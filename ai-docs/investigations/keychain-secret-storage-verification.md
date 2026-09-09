# Keychain secret storage — what was verified, and how

Companion to `docs/adr/006-macos-keychain-secret-storage.md`. The ADR records the
decisions; this file records the **evidence**, so a later change can tell which
properties are pinned by a test that can actually fail, and which rest on an
argument. Written at release of 0.36.0.

## Measured facts about the `security` CLI

These were measured on macOS, not assumed. They constrain the implementation and
will constrain any rewrite of it.

| Fact | Consequence |
|---|---|
| `find-generic-password -w` exits **44** on a miss | Absence is an exit code, not an empty read, so "missing" and "failed" stay distinguishable |
| A secret passed as an argument is visible in `ps` | Writes go over stdin (`security -i` with `-X <hex>`), never in argv |
| `execSync`/`execFileSync` with `input` hangs for the full timeout when the parent's stdin is in raw mode | The OpenTUI wizard does exactly that, so the adapter uses `Bun.spawnSync` |
| `Bun.spawnSync` honours its `timeout` (measured 1003 ms for a 1 s limit) | The per-process budget is enforceable |
| `dump-keychain` returns attributes only, in one spawn | `keychain status` renders every row without reading a single value |
| A locked keychain burns the **full** timeout on every spawn | Time must be bounded per process, not per call — see the budget below |

## The properties that are pinned by a test that can fail

Each was falsified deliberately: the guard was broken, the suite went red, the
guard was restored. A property with no recorded falsification is marked as such.

| Property | How it is asserted | Falsified by |
|---|---|---|
| A failed keychain write never deletes the key from `config.json` | bytes on disk, not the report object | forcing the disposition check false → 2 failures, `Received: "pa-OLD"` |
| The Ollama credential reaches only `ollama.com` | captured request headers | forcing the endpoint predicate true → 13 failures |
| No test spawns `/usr/bin/security` | a monotonic spawn counter at the one choke point, plus a decoy binary on `PATH` | a copy of the module with the vetoes removed → 0 spawns became 2 |
| An unrecognised flag never runs the destructive default | `storedAfter` and seam calls are empty | disabling the check → 5 failures |
| Entry-point launches all route through the guarded launcher | tree-sitter taint analysis over `src/**`, import- and alias-resolving | reverting a call site → the rule flags it |

## Two traps that cost real time

**A stopwatch is not a spawn counter.** The no-spawn assertion was first written
against `keychainProcessBudgetUsedMs()`, which is milliseconds. A *refused* call
still crosses the timed region: 0 ms idle, 1 ms under load, against 3–5 ms for two
real spawns. The ranges are adjacent, so the test passed alone and failed in the
full suite while the security property was intact the whole time. It was not
flaky, it was undecidable. Count spawns with a counter that increments after the
vetoes.

**A report object cannot show what reached the disk.** The same defect class —
a secret deleted from, or written to, `config.json` because the deletion logic was
scoped to the wrong object — appeared five times and was found five different ways.
Every occurrence passed its tests, because those tests asserted on the returned
report. Assert on the file.

## Time budget arithmetic, and what it rests on

`SPAWN_TIMEOUT_MS` is 3000 per spawn; `KEYCHAIN_PROCESS_BUDGET_MS` is 6000 for the
whole process, applied as a **pre-flight clamp** on each spawn's timeout. A
post-hoc check would let a spawn start at 5999 ms and block a further 3 s.

The bound matters because the indexer holds a lock whose staleness rule fires at
10 s. Worst case is 6000 ms blocked plus up to 1000 ms of heartbeat phase, i.e.
7000 < 10000, leaving 3 s of margin. Raising either constant eats that margin and
can hand a held index lock to a second indexer.

Note the bound rests on the clamp, **not** on credential reads having been hoisted
out of the locked region. `initialize()` still resolves credentials inside the
lock. An earlier comment claimed that region was spawn-free; it was not.

## Live verification against a real keychain

Stubs cannot prove the real protocol. Two live runs against the login keychain
closed part of that gap:

- Read paths: `keychain status` and `migrate --dry-run` complete, `dump-keychain`
  parses, the file mode tightens to 0600, and no authorization dialog appears.
  Every row resolves to `keychain`, `config.json` or `not configured` — no
  `unknown`, so each answer came from actually asking.
- The write path has one observed successful run, which created two items with the
  expected comment and left `config.json` untouched.

Still unproven: that the ACL pinned with `-T /usr/bin/security` reads back
dialog-free across a rebuilt binary. That is the reason a native keychain binding
was rejected, so it deserves a check the first time someone reworks packaging.

## Testing rules that are not negotiable

Do not create a throwaway keychain to test this. Its password is known only to the
tooling, it re-locks on an idle timer, and every spawn then raises an
authorization dialog nobody can answer. One benchmark run filled a maintainer's
screen with them. Use the injectable seam; if live proof is genuinely needed, run
one read-only command against the already-unlocked login keychain.
