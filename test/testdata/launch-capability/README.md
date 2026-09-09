# Launch-capability graph fixtures

Fixtures for the import- and alias-resolving launch rule in
`test/unit/core/launch-capability-graph.test.ts` (analyzer:
`test/helpers/launch-capability-graph.ts`). None of these files is executed;
the analyzer parses them with the repo's own tree-sitter TypeScript grammar and
walks the AST. The `f-*` chain and `a-*`/`negative-allowlisted-caller.ts`
import the real launcher module by relative path so that cross-file resolution
is proved against the real file, not a stand-in.

## Why this layer exists

The regex sweep in `keychain.test.ts` ("no PRODUCTION file may obtain a
process-launch capability unless it is on the allowlist") recognises PRIMITIVE
acquisitions: `node:child_process` specifiers, `Bun.spawn*`, `Bun.$`, `$`/`spawn`
from `"bun"`, `process.binding(`. Round 8's external review showed two shapes it
cannot see: a capability obtained by **importing a local module** (the launcher),
and **aliases** (`const runtime = Bun`, `globalThis["Bun"]`, `process["binding"]`,
destructuring renames, re-export chains). The sweep stays — it is cheap and has
no parser to mis-handle. This rule sits on top and understands bindings.

Two capability KINDS, two allowlists (`test/helpers/launch-allowlists.ts`):

- `primitive` — checked against `PROCESS_LAUNCH_ALLOWLIST` (the sweep's 14).
- `launcher` — any export of `src/core/entry-point-launcher.ts`, checked against
  `LAUNCHER_CALLER_ALLOWLIST` (5 files).

A file that **calls** (or tags, for `$`) a tainted binding violates unless it is
on the allowlist for that kind. Importing without calling is reported as an
info line, not a violation.

## Verdicts

| File | Verdict | Kind | Why |
|---|---|---|---|
| `a-imports-launcher.ts` | fires | launcher | the round-8 shape: imports the launcher, nothing the sweep knows |
| `b-bun-alias.ts` | fires | primitive | `const runtime = Bun; runtime.spawn` |
| `c-globalthis-bun.ts` | fires | primitive | `globalThis["Bun"].spawn` — literal key resolved |
| `d-process-binding.ts` | fires | primitive | `process["binding"]` through a cast |
| `e-destructure-rename.ts` | fires | primitive | `const { spawn: s } = cp; s(...)` — finding is on the call |
| `f-reexport-caller.ts` | fires | launcher | two hops: `export *` over `export { x as launch } from` |
| `f-reexport-hop1.ts` | silent | — | a link in the chain; no binding, no call |
| `f-reexport-hop2.ts` | silent | — | a link in the chain; no binding, no call |
| `g-concatenated-name.ts` | fires | primitive | **by the KIND rule** — arguments are never read |
| `h-fork.ts` | fires | primitive | every `child_process` export launches |
| `i-dynamic-import-const.ts` | fires | launcher | `import(LAUNCHER)` with a same-file `const` — **resolved** (rung 3), so the launcher kind only, nothing unresolved |
| `j-dynamic-import-computed.ts` | fires | launcher **and** primitive | `import(\`${dir}/${stem}.js\`)` and `require(a + b)` — undecidable, **fail closed**: both kinds, and two `dynamic-import` entries in `unresolved` |
| `k-reexport-deep-caller.ts` | fires | launcher **and** primitive | nine `export *` hops, one past `REEXPORT_DEPTH_LIMIT` (8) — **fail closed**: both kinds, and a `reexport-depth` entry in `unresolved` at hop 9 |
| `k-reexport-deep-hop1.ts` … `hop10.ts` | silent | — | links in the chain; no binding, no call. Hop 9 is the one the analyzer refuses to follow; hop 10 holds the rename it never reads |
| `l-bare-import-computed.ts` | **unresolved only** | — | a BARE `await import(m);` for side effects, `m` computed — one `dynamic-import` entry; no call, so no violation (see "Bare imports" below) |
| `m-bare-require-computed.ts` | **unresolved only** | — | the `require(m);` twin of (l) |
| `n-let-reassigned-specifier.ts` | fires | launcher **and** primitive | `let m = "harmless"; m = launcher; import(m)` — a `let` is never a const string, so the stale literal is NOT used: **fail closed**, plus a `dynamic-import` entry |
| `o-var-specifier.ts` | fires | launcher **and** primitive | the `var` form of (n) |
| `p-const-from-const.ts` | fires | launcher **and** primitive | `const B = A; import(B)` — rung 3 is exactly ONE hop; a two-hop const **fails closed**, plus a `dynamic-import` entry |
| `negative-allowlisted-caller.ts` | silent | — | same call as (a); the test allowlists this path for kind `launcher` |
| `negative-non-launch-api.ts` | silent | — | `mnemex` in arguments to non-launch APIs |
| `negative-bare-literal-import.ts` | silent | — | bare `import("./x.js")` / `` import(`./x.js`) `` / `require("./x.js")` — literal specifiers RESOLVE; nothing unresolved, nothing acquired |

## `unresolved` is load-bearing — the fail-closed rule

Round 9's external review found two places where the analyzer returned empty
taint on something it could not read, **without recording it**: a dynamic
import whose specifier was not a string literal (`const m = "../core/entry-
point-launcher.js"; await import(m)` passed both enforcement layers), and an
`export *` chain deeper than the depth bound. Both now fail closed.

**Dynamic-import specifiers** (`import(x)`, `require(x)`) climb the same ladder
as computed member keys:

1. string literal — resolved;
2. substitution-free template — resolved;
3. same-file `const NAME = "literal"` — resolved (fixture `i`). **`const`
   only, one hop, unshadowed.** Bindings are flat per file, so a name counts
   as a const string only if EVERY binding of it in the file is
   `const NAME = <literal>` with the same value. A `let` or `var` (fixtures
   `n`, `o`), a `const` initialised from another const (`p` — two hops are
   NOT followed; a real caller writes the literal), a parameter, a
   destructuring pattern, a `for…of` head, a `catch` binding, an import, a
   function/class name or an assignment target anywhere in the file poisons
   the name and drops it to rung 4. Round 10's review showed why: with every
   literal declarator treated as constant, `let m = "./config.js"; m =
   "../core/entry-point-launcher.js"; import(m)` resolved to the STALE
   literal and loaded the launcher unreported;
4. **anything else** — an identifier that is not a same-file const, a template
   with a substitution, a concatenation, a call — is recorded in `unresolved`
   as `{ kind: "dynamic-import", file, line, text }` **and** the imported
   namespace is tainted with **both** kinds (fixture `j`). A computed specifier
   cannot be proven not to load a launch capability, so a non-allowlisted file
   performing one is a violation by construction — the same stance as the
   keychain adapter's three vetoes.

**Bare imports — every `import()` / `require()` is evaluated where it
stands.** The taint walk reaches an import only when its value flows somewhere
(a binding, a `.then`, a call), so before round 8 a side-effect-only
`await import(m);` produced no entry at all: no binding, no call, and
`collectCalls` skips `import`/`require` callees by design. The propagation
pass now evaluates the specifier of EVERY dynamic import expression, bound or
bare, and discards the result. Policy, stated: a bare computed import is
recorded in `unresolved` and is **not** a violation — it calls nothing, and
violations are calls. That is the stricter outcome, not the weaker one:
`unresolved` has no allowlist, so it fails the production tree from ANY file,
including an allowlisted caller, whereas a violation in an allowlisted file
would be silenced. Fixtures `l` (import) and `m` (require) prove the entry;
`negative-bare-literal-import.ts` proves a bare LITERAL import is not recorded
merely for being bare.

**Re-export depth.** `export *` chains are followed to `REEXPORT_DEPTH_LIMIT`
= **8** hops (exported from `test/helpers/launch-capability-graph.ts`). The
ninth hop is not followed: it is recorded as `{ kind: "reexport-depth", … }` at
the refused `export *` line and the lookup yields both kinds (fixture `k`).
The bound is proved exact in the test, which builds an 8-hop chain (resolves,
nothing unresolved) and a 9-hop chain (fails closed) in a temp dir.

**On the production tree the test asserts `unresolved` is EMPTY** — there is
no allowlist for it. A real computed import in `src/` is made resolvable (a
literal or same-file const specifier), not excused. As of round 7 every
dynamic import under `src/` is a literal; several are merely line-wrapped
(`await import(\n  "./x.js",\n)`), which tree-sitter reads as the literal it
is.

## Known limits — stated, not hidden

**False negatives (a launch the rule would not see):**

- **Function bodies are not summarised.** A wrapper that spawns fires in its own
  file (the allowlist policy) but does not become a source for *its* callers.
  `export function go() { spawn(...) }` in an allowlisted file, then `go()`
  elsewhere: only the wrapper is checked. The one module whose exports are all
  sources is the launcher, by path.
- **Parameter taint is same-file only.** `new Foo(spawnMnemexDetached)` in file
  A taints nothing in file B's `Foo`. The value is obtainable only from the
  launcher, so the rule fires in A on acquisition; B is trusted to call what it
  was given.
- **Call results carry their ARGUMENTS' taint, not their callee's.**
  `promisify(exec)` is a launcher; `spawn(...)` yields a child that is not.
  `new X(tainted)` does not propagate.
- **Non-relative specifiers** other than `child_process`, `bun` and the known
  runner packages contribute no taint. A new third-party runner goes on the
  list in the analyzer (`RUNNER_PACKAGES`), mirroring the sweep's list.
- **Computed keys** resolve for string literals, substitution-free templates,
  and same-file `const NAME = "literal"` (const only, one hop, unshadowed —
  see the ladder above). `obj[fn()]` is unresolvable; on a
  `Bun`/`process`/`globalThis`/namespace object it is treated as "could be
  anything" and taints conservatively (a false POSITIVE, not a negative).
- **Computed dynamic imports and over-deep re-export chains are NOT in this
  list.** They were, silently, before round 7; they now fail closed and are
  reported (see "`unresolved` is load-bearing" above). A bare `await import(x)`
  whose namespace is never bound or called lands in `unresolved` as of round 8
  (fixtures `l`, `m`) — before that, this paragraph claimed it did and it did
  not: the taint walk never reached an import whose value went nowhere.
- **A bare computed import is `unresolved`, not a violation.** It calls
  nothing. The production test asserts `unresolved` empty with no allowlist,
  so the outcome is a failed tree either way; the distinction matters only
  for reading the report.
- **`eval`, `new Function`, `Reflect.get(Bun, key)`** are not modelled.

**False positives (a finding that is not a launch):**

- **Bindings are flat per file** — block scope and shadowing are ignored. A
  local `const spawn = ...` in one function and an imported `spawn` in another
  share a name and therefore a taint. This can only ADD findings.
- **Unresolvable computed access on a tainted object** taints, as above.
- **An undecidable `import(x)` or a chain past `REEXPORT_DEPTH_LIMIT`** fires
  with both kinds even when the module it would have loaded is harmless — by
  design, and never silently: each one is also an `unresolved` entry.
- **`||`/`??`/`&&`/ternary** union both sides; `const run = maybeSpawn ?? noop`
  is tainted even if `noop` is what runs.

**Do not "fix" these files.** Their verdicts are asserted by name; changing one
changes what the rule is proved to do.
