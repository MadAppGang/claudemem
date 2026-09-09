# Launch-allowlist fixtures

Fixtures for the **inverted** process-launch rule in
`test/unit/core/keychain.test.ts` ("no PRODUCTION file may obtain a
process-launch capability unless it is on the allowlist"). None of these files
is executed; the sweep only reads them. `third-party-runner.ts` imports a package
that is deliberately not installed.

## Why the rule was inverted

The argument-shaped detector (`entryPointSpawnSites`, still used for the narrow
check) missed a new spelling in each of four review rounds: the literal path,
`path.join`, the bare binary name, and round 7's list — `fork(...)`,
`spawn(obj.cli, …)`, `spawn(parts.join(""), …)`, and an imported wrapper. It also
over-matched (`brew upgrade mnemex`; it would have flagged `git grep mnemex`).
A regex over arguments cannot win that race.

The new rule does not read arguments. To launch a process a file must first
**obtain a capability** — import `node:child_process` (static, dynamic or
`require`), touch `Bun.spawn`/`Bun.spawnSync`/`Bun.$`, import `$` or `spawn` from
`"bun"`, or import a known third-party runner. Those spellings are finite. A
file in `src/` that obtains one and is not in `PROCESS_LAUNCH_ALLOWLIST` is a
finding regardless of what it launches. Allowlisted files are then held to one
narrow rule: none but `src/core/entry-point-launcher.ts` may name a mnemex entry
point in a launch.

## Verdicts

| File | Verdict | Why |
|---|---|---|
| `fork-entry.ts` | fires | round 7: `fork` was not in the old call regex |
| `object-property-command.ts` | fires | round 7: command behind an object property |
| `concatenated-name.ts` | fires | round 7: name never a contiguous literal |
| `imported-wrapper.ts` | fires | round 7: the wrapper holds the capability |
| `dynamic-import.ts` | fires | lazy `import("node:child_process")`, as `src/cli.ts` does |
| `bun-global.ts` | fires | `Bun.spawn`, destructured `Bun`, `Bun.$` — no import needed |
| `third-party-runner.ts` | fires | `execa` is a launcher by another name |
| `git-grep-spawn.ts` | fires | **a launch outside the adapter set** — see below |
| `imported-wrapper-caller.ts` | silent | holds no capability; the wrapper is the finding |
| `git-grep-no-launch.ts` | silent | mentions `git grep mnemex` etc. as data only |
| `type-only-import.ts` | silent | `import type` is erased; mirrors `src/lsp/transport.ts` |

## Two consequences, stated honestly

**`spawn("git", ["grep", "mnemex"])` in a non-allowlisted file fires.** Not
because of `"mnemex"` — because it is a launch outside the adapter set, which is
the rule. The remedy is an allowlist entry with a one-line justification, after
which only the narrow entry-point check applies to that file. The over-match the
old detector had on arguments is gone; what remains is a deliberate rule about
*where* launching may happen.

**The caller of an imported wrapper is not flagged.** A file-level rule fires
where the capability is acquired, and that is the wrapper. The wrapper cannot
enter `src/` without someone writing its justification in the allowlist table,
and "forwards whatever command it is given" is the justification a reviewer must
refuse. (Until round 6 the tree had one deliberate pass-through,
`launchEntryPointDetached`, inside the launcher; it was removed because its one
caller fed it a bare `"mnemex"`, making that caller a second namer of the entry
point. Callers of the launcher are now enumerated by the import- and
alias-resolving rule in `test/unit/core/launch-capability-graph.test.ts`, with
fixtures under `../launch-capability/`.)

**Do not "fix" these files.** Their verdicts are asserted by name; changing one
changes what the rule is proved to do.
