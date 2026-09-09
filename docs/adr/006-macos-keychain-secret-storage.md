# ADR 006 — API keys in the macOS Keychain

- **Status:** Accepted
- **Date:** 2026-09-01
- **Supersedes:** the unreleased `src/core/keychain.ts` added in `b5cd2e3`

## Context

mnemex holds six API keys: `openrouter`, `voyage`, `anthropic`, `context7`, `cloud` and
(new) `ollama`. Until this change every one of them lived in plaintext in
`~/.mnemex/config.json` at mode `0644`.

An earlier keychain module existed on `main` but **never shipped**: `git ls-tree -r
--name-only v0.32.0 -- src/core/keychain.ts` is empty and its only commit post-dates the
tag. So the installed population is *everyone with plaintext keys in a world-readable
file*, and *nobody with a keychain item*. That inversion decided most of what follows.

Seven measured defects in the old module:

| # | Defect |
|---|---|
| D1 | A failed keychain write still deleted the key from `config.json` (the boolean was discarded, then `stripSecrets` ran unconditionally) |
| D2 | Off-darwin every secret was destroyed on save — nothing stored anywhere |
| D3 | Secrets appeared in `argv`, readable via `ps` (a shell string with `-w '<secret>'`) |
| D4 | ~7 `security` spawns per `getApiKey()` (101.3 ms measured) |
| D5 | "Could not read" was indistinguishable from "nothing stored" (bare `catch`) |
| D6 | No test coverage at all |
| D7 | `OLLAMA_API_KEY` never consulted the keychain |

## Decision

**One driven port, at exactly one seam.** `KeychainDeps` (`platform()`, `run(args, stdin?,
timeoutMs?)`) is the only route to the outside world. Production supplies a `Bun.spawnSync`
adapter over `/usr/bin/security`; tests supply a recording stub. Hexagonal is chosen here
and nowhere else in the feature, because the force it answers — *"I need to swap the side
effect for tests"* — is present here and nowhere else.

**Two layers, sharply separated.** `src/core/keychain.ts` speaks keychain vocabulary and
knows nothing about `GlobalConfig`. `src/core/secrets.ts` is a Facade in the only form
TypeScript needs — a module of functions — holding the registry and the policy, and knowing
nothing about argv.

**A key is never lost.** A secret leaves `config.json` **iff** this save both received it
and proved the keychain holds that exact value. The proof is a verified write or a
byte-identical read. Delete is symmetric: an unconfirmed delete reports `clear-failed` and
keeps the field.

**`undefined` means untouched; only `""` clears.** An explicitly-`undefined` field removes
nothing, from the keychain or from the file. This is not cosmetic: `{...existing,
...jsonSafe}` followed by `JSON.stringify` deletes an `undefined`-valued key from disk
*silently and outside the report entirely*, which reproduced the original key-destruction
defect through the merge. Removing a non-secret field is `removeGlobalConfigFields`'s job.

**A keychain-sourced value never reaches the file.** `loadGlobalConfigWithSecrets()` overlays
keychain values onto the object it returns, and that object comes back to `saveGlobalConfig`.
When a save cannot prove the keychain holds a value it normally keeps it in `config.json` —
correct for something the user just typed, and a *leak* for something the keychain handed us.
Provenance is recorded at hydration and consulted at exactly the points that would otherwise
write plaintext.

**Migration writes create-only.** `migrateFileSecrets` omits `-U`, so `security` refuses to
replace an existing item rather than the code deciding not to. "Never overwrite" stops being
the conclusion of a check with a window after it.

**The Ollama credential is bound to the Ollama Cloud endpoint, not to the provider type.**
`ollama-cloud/<model>` resolves to provider `"local"` at `https://ollama.com/v1`; so do LM
Studio and any endpoint a user configures. Resolving `OLLAMA_API_KEY` for provider `"local"`
therefore sent it to third-party and self-hosted servers. The implicit fallbacks (keychain,
config, `process.env`) are gated on endpoint identity; an explicitly-passed key is always
honoured.

**Incoming fields only.** `persistSecrets` is never handed the file-merged object. A save
carrying no secret makes zero `security` calls.

**Failure is not absence.** `KeychainRead` is a three-way union and
`KeychainEnumeration.failed` sits beside the answer. The five getters collapse the two
(the config file is a valid answer either way), but the cache entry, the diagnostic and the
decision to exit do not.

**Time is bounded per process.** A 3 s burst memo, a store-wide failure latch, a circuit
breaker, and a 6 s process budget applied as a **pre-flight clamp** on each spawn's timeout.

**Migration is opt-in and two-step.** Upgrading moves nothing. `mnemex keychain migrate`
copies and verifies but leaves the file copy; `mnemex keychain prune`, run later, removes
only the copies that re-verify.

## Alternatives rejected

| Alternative | Why not |
|---|---|
| A native keychain binding | Inside a `bun --compile` executable it presents a different code identity on every rebuild, so macOS raises a fresh authorization dialog each time. Shelling out to the Apple-signed `/usr/bin/security` and pinning the ACL with `-T /usr/bin/security` keeps later reads dialog-free |
| `execSync`/`execFileSync` with `input` | Measured to hang for the full timeout when the parent's stdin is in raw mode — exactly what the OpenTUI wizard does |
| `dump-keychain` first for single reads | Makes a cold miss cheaper (11.5 ms vs 22.4 ms) but a cold **hit** cost two spawns. The requirement is "at most one spawn on a cold call" |
| A dual-read on miss (account, then env-var name) | Same violation, and pre-migration every getter takes the miss path, so it doubles the common cost permanently to serve a hand-created item. `keychain status` surfaces those items at zero extra spawns |
| Renaming accounts to the env-var names | Free today (six values), ~120 lines of dual-read migration after release. Declined knowingly: the account is an address nothing outside the registry types, and "the account is the env var" would be false for `cloud` and half-true for `ollama` |
| Lazy `Object.defineProperty` getters on the loaded config | A spread materialises every getter, as do `JSON.stringify` and structured cloning, in places with nothing to do with secrets |
| Inert-by-default deps wired at a composition root | Hexagonally pure and the wrong trade: mnemex has several entry points, and a forgotten wiring silently disables the keychain **for real users** — a bug discovered on someone else's machine |
| `NODE_ENV === "test"` as the test guard | Measured: `bun test` sets `NODE_ENV="test"` and does **not** set `BUN_TEST`, so the guard's only live signal was a variable ordinary shells set for unrelated reasons — and the refusal is in the READ path |

## Consequences

- A secret can now legitimately remain in `~/.mnemex/config.json`, so that file is treated
  as a secret store: `0700` directory on creation, atomic tmp→rename write, an
  **unconditional** `chmodSync(path, 0o600)` on every save (measured: `writeFileSync`'s
  `mode:` is ignored for an existing file — 644 stays 644), an advisory lock, and an
  unparseable file preserved as `config.json.corrupt-<ts>` rather than merged over.
- **Availability over strictness** is the explicit trade. A key the user can still use in a
  0600 file beats a key silently destroyed.
- **Downgrade:** once a key lives only in the keychain, a downgrade to ≤ 0.32.0 reads only
  `config.json` and will not find it. The item is not destroyed — it stays in Keychain
  Access.app and is readable by hand. This is why the migration is opt-in and two-step, why
  `keychain status` exists, and why the save message says where the key is **not**.
- **The MCP server primes once at startup** into a session cache, giving up the 3 s burst
  window for the one process where a per-request synchronous spawn is indefensible. If
  priming fails the cache is left **empty**, never negatively populated.
- **No test may spawn `security`.** The adapter **denies by default**: it does not spawn until
  `enableRealKeychainAccess()` has been called, and `src/index.ts` is the only caller. See
  CLAUDE.md gotcha #24.

  This inverts the original design, and the reason is recorded because the original looked
  fine. It was allow-by-default plus three refusals, two of which were written by a single
  writer — `bunfig.toml`'s `[test] preload`, which `bun` resolves against the **current
  working directory** and does not walk up for. `cd test && bun test ../x.test.ts` left both
  unset, and a fresh process has not yet tripped the `setKeychainTestDeps` latch, so the
  "four independent layers" were all absent at once and the next read reached the real login
  keychain. Two reviewers found that path independently.

  Deny-by-default is not inherited by children, which is the property that makes it hold
  where an environment variable did not. The sentinel remains as a **veto** on top, for the
  one case deny-by-default cannot cover: a test that spawns the real entry point, which does
  call the opt-in.

  Related: the same class of assumption applies to test helpers writing `~/.mnemex/config.json`.
  `GLOBAL_CONFIG_DIR` is evaluated from `homedir()` at import and Bun's `homedir()` ignores a
  runtime `HOME` reassignment, so any helper that can write it must prove it is inside
  `tmpdir()` before doing anything (`test/helpers/sandbox-guard.ts`). A review probe that
  assumed otherwise wrote to a real user's config file.

  The residual risk was stated rather than hidden: no stub can prove the real `security`
  accepts our argv and `-i` protocol, or that the ACL reads back dialog-free. Mitigations were
  measured facts baked into the stubs and a captured real `dump-keychain` block as the parser
  fixture.

  **Partly retired since, by two live runs against the login keychain** (4 Sep by the user,
  8 Sep by the assistant with the user's authorisation, both read-only). Proven: `dump-keychain`
  parses, attribute reads work, `keychain status` and `migrate --dry-run` complete, no
  authorization dialog is raised, and the `keychain` / `config.json` / `not configured`
  distinction is answered by asking rather than by failing. The **write** path has one observed
  successful run: two items created in the same second carrying the `Stored by mnemex` comment,
  with `config.json` untouched. Shell-history timestamps identify it as
  `keychain migrate --dry-runDD` — a mistyped flag that ran a real migration (see below), which
  makes it accidental but genuine evidence that the write path, the create-only guard and the
  verified round-trip all work against the real `security`. The ACL's dialog-free re-read across
  a rebuilt binary remains unproven.
- **Unrecognised flags abort; they are never ignored.** `migrate` read its mode with
  `args.includes("--dry-run")`, so `--dry-runDD` was not an error — it selected the destructive
  default and exited 0 after writing. A boolean flag parsed by membership turns every typo of it
  into the opposite of what was typed, and here the opposite was "write to the keychain". Each
  subcommand now declares the flags it accepts (`status` and `prune`: none) and an unrecognised
  dash-argument returns 1 before the credential lock and before any keychain access, naming the
  near-miss. The regression tests assert that NOTHING was written rather than asserting an exit
  code, because the defect exited 0.
- **`excludePatterns` stores only the user's additions.** `loadGlobalConfig` prepends the 102
  defaults for the caller's convenience; writing that concatenation back grew the file by 102
  entries per save (measured on a real file: 408 entries, 102 unique). Saves now normalise.
  Effective behaviour is unchanged — `getExcludePatterns` seeds its set with the defaults
  independently.
