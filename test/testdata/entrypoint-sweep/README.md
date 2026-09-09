# Entry-point sweep fixtures

Every `.ts` file in this directory is a **deliberately unsafe** spawn of the
mnemex entry point. None of them is executed. They exist so the static sweep in
`test/unit/core/keychain.test.ts` can be shown to REJECT each spelling of a
constructed entry-point path, on real files with real extensions, rather than on
strings written next to the assertion.

The sweep skips this directory by path (`SWEEP_FIXTURE_DIR`) and a separate test
scans it, requiring every file to come back `spawns=true unguarded=true`.

Why they exist: for three review rounds the sweep reported green while
`tests/rg.test.ts` spawned `src/index.ts` with `{ ...process.env }`. The path was
written `join(import.meta.dir, "..", "src", "index.ts")`, so the components were
separate arguments and the detector's contiguous `src/index.ts` regex never
matched. A detector is only worth its assertion if the shapes it misses are
enumerated somewhere that fails when it stops catching them.

## The two families

**Round 3 — the entry point as a PATH.** `constructed-join-path.ts`,
`hoisted-argv.ts`, `interpolated-path.ts`, `guard-in-the-wrong-place.ts`. Each
builds `src/index.ts` or `dist/index.js` in a way that hides the contiguous
string.

**Round 4 — the entry point with NO PATH AT ALL.** The sweep after round 3 hunted
entry-point *paths*, so it could not see `src/editor/editor.ts:262`:

```js
spawn("mnemex", ["index", "--quiet", "--files", filePath], …)
```

`which mnemex` answers on any developer machine, so that spawn ran the production
entry point — and `src/index.ts:32` calls `enableRealKeychainAccess()`, so the
child could reach the real login keychain. `SymbolEditor` is constructed by
`test/helpers/test-workspace.ts` and driven by two e2e suites, so it was live.
The fixtures for that family:

| File | Spelling |
|---|---|
| `bare-binary-name.ts` | `spawn("mnemex", …)` — the bug, verbatim |
| `absolute-binary-path.ts` | `/opt/homebrew/bin/mnemex`, hoisted into a const |
| `hoisted-bare-name.ts` | the bare name behind two levels of indirection |
| `package-runner.ts` | `npx mnemex@latest` / `bunx mnemex` |
| `self-reexec.ts` | `process.execPath` + `process.argv[1]` |
| `shell-string.ts` | `execSync("mnemex index")` and Bun's `` $`…` `` tag |

**Round 9 (the 0.35.0 merge) — the guard constant, impersonated.**

| File | Spelling |
|---|---|
| `impostor-guard-constant.ts` | a LOCAL `const KEYCHAIN_CHILD_GUARD_ENV = {}`, spread at the spawn |

The merge brought four upstream e2e suites that build a minimal child env from
scratch rather than inheriting one, so `keychainSafeChildEnv()` was the wrong
shape for three of them and they spread `KEYCHAIN_CHILD_GUARD_ENV` instead. The
sweep was widened to accept that constant — and the acceptance is conditional on
the file IMPORTING it from `helpers/child-env.js`, because the name alone proves
nothing. This fixture is that condition's falsification: drop the import check
and its row in the verdicts map flips to `unguarded=false`.

**Do not "fix" these files.** Adding `keychainSafeChildEnv()` here makes the
fixture test fail, which is the point.
