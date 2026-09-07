# Two pre-existing TUI startup failures: the bundled `dist/index.js` and the compiled binary

Verified 2026-09-07 on bun 1.4.0, macOS 26.6 (arm64), while validating the terminal
theme feature (shipped in 0.35.0). Neither failure is caused by that feature; both
exist on `main` at `d937d2a` (v0.34.0).

## 1. `dist/index.js ui` crashes before the first render

Running the bundle (`bun run build`, then `./dist/index.js ui` or `bun dist/index.js ui`)
in a real pty prints:

```
TypeError: null is not an object (evaluating 'resolveDispatcher().useState')
    at <anonymous> (dist/index.js:86570:33)
    at AppProvider (dist/index.js:101833:60)
    at react_stack_bottom_frame (node_modules/react-reconciler/cjs/react-reconciler.development.js:17596:20)
```

**How it was verified as pre-existing:** `git archive HEAD` (d937d2a) into a scratch
directory with `node_modules` symlinked, built with the exact `bun build … --target bun
--external @lancedb/lancedb --external better-sqlite3 --external @opentui/core
--external @opentui/react` command from `package.json`, run in headless tmux: identical
error at `AppProvider`.

**Working alternative:** running from source, `bun --env-file=/dev/null src/index.ts ui`,
renders and works (search, map, results). The theme validation ran that way.

**Likely cause (inferred, not proven):** the bundle inlines one copy of `react` while the
external `@opentui/react` resolves its own from `node_modules`, so hooks run against a
dispatcher that belongs to a different React instance. The `--external` list and the
dynamic-import boundary in `src/cli.ts` are the places to look. Confirm by checking
`grep -c '"react"' dist/index.js` against `node_modules/@opentui/react`'s peer resolution
before changing anything.

## 2. The compiled binary from `build:binary` cannot start at all

`bun run build:binary` → `./mnemex --version` (from any cwd, including one with a
`node_modules` symlink to the repo's) exits 1:

```
error: Cannot find module '@opentui/core' from '/$bunfs/root/mnemex'
```

**Mechanism:** Bun's bundler hoists the TUI's static `@opentui/*` imports to module
scope of the single-file bundle even though `src/cli.ts` only reaches the TUI through
dynamic `import()` (see `grep -n '^import .* from "@opentui' dist/index.js`), so the
externals load eagerly on every run; a compiled binary resolves `--external` modules
from its virtual filesystem root, not from the cwd.

`.github/workflows/release.yml` builds the release binaries with the same
`--compile --external @opentui/core --external @opentui/react` shape, and the Homebrew
formula installs that artifact. Whether the CI-built binaries start has not been
checked here; do that before trusting the Homebrew path.

**Options (untested):** bundle `@opentui/*` into the compile per platform instead of
marking it external, or make the TUI import chain truly lazy so the bundle carries no
top-level `@opentui` import.

## Why this note exists

FR3 of the theme feature (env vars never read from `.env`) is enforced for compiled
binaries by `--compile-exec-argv="--env-file=/dev/null"`. That mechanism was verified on
a scratch compiled script, not on the product binary, because of failure 2. See
CLAUDE.md gotcha 23 for the flag and its required spelling.
