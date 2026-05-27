Now I have a complete picture. Let me produce the assessment.

---

## Tests to Remove (test nothing)

1. **"empty rg output and empty mnemex results returns empty string"** — Trivially empty input → empty output is the most obvious code path. No bug could hide here.

2. **"empty inputs return empty string"** (files-with-matches) — Same trivial case.

3. **"empty merge result signals no matches"** — Tests `mergeResults("", [], "nonexistent", "content") === ""`. The boundary condition with no inputs is the most obvious outcome.

4. **"returns empty string when rg output is empty"** (count mode) — In count mode the function literally does `return rgOutput`. This tests `"" === ""`.

5. **"rg results only returns rg output unchanged"** — With zero mnemex results, the function is *designed* to return rg output unchanged. This is the "nothing to merge" case tested before any real logic.

6. **"returns same array reference when -n already present"** — Tests `includes()` returns true when the element is present. `ensureLineNumbers` literally calls `includes()` on the array; this is a language guarantee test.

7. **"returns same array reference when --line-number already present"** — Same as above.

8. **"passthroughArgs equals original args"** (all 4 variants) — `passthroughArgs: args` is literally a pass-through property. These tests verify JavaScript variable assignment, not the parser's logic.

9. **"args are not mutated by parseRgArgs"** — The function never touches `args`; it only reads it. This tests the absence of an obvious bug that would be immediately visible.

10. **"install is idempotent when USE_BUILTIN_RIPGREP=0 already set"** — The write-skipping branch when value already equals `"0"` is tested. But `existing.trim() === existing.trim()` is trivially true, and the test verifies internal state (file unchanged) not user-visible behavior.

11. **"uninstall is a no-op when USE_BUILTIN_RIPGREP not present"** — File-unchanged when key absent is tested. The "no-op" is an internal optimization with no observable difference to the caller.

12. **"install adds USE_BUILTIN_RIPGREP=0 to existing settings without env key"** — Only exercises the code path where `env` doesn't exist yet. Useful but only covers the add case, not modify, which is already covered.

---

## Missing E2E Tests (concrete proposals)

### 1. Test: "rg binary produces correct format output"
**Why:** `mergeResults` is tested against hardcoded strings, but never against real `rg` stdout which has exact format requirements (file:line:content, context separators, etc.)
**Asserts:** Output is valid `file:line:content` format, all lines parseable by the merger
**Pseudocode:**
```typescript
test("real rg output is valid mergeResults input", () => {
  // Setup temp dir with known files
  const dir = mkdtempSync(join(tmpdir(), "rg-e2e-"));
  writeFileSync(join(dir, "a.ts"), "function foo() {}\nfunction bar() {}\n");
  writeFileSync(join(dir, "b.ts"), "function foo() {}\n");

  // Spawn real rg
  const { rgPath } = require("@vscode/ripgrep");
  const result = spawnSync(rgPath, ["--line-number", "function", dir]);
  const rgOutput = result.stdout.toString();

  // Feed through mergeResults — must not throw
  const merged = mergeResults(rgOutput, [], "function", "content");

  // Every non-separator line must match file:line:content
  for (const line of merged.split("\n")) {
    if (line === "" || line === "--") continue;
    expect(line).toMatch(/^[^:]+:\d+:/);
  }
});
```

### 2. Test: "handleRgPassthrough falls back to rg when .mnemex/ does not exist"
**Why:** The `.mnemex/` check is the primary fallback path in `handleRgPassthrough` (line 7527-7530 of cli.ts) but has zero test coverage.
**Asserts:** Output matches real rg output, process exits with correct code
**Pseudocode:**
```typescript
test("falls back to rg when .mnemex/ dir absent", async () => {
  const dir = mkdtempSync(join(tmpdir(), "rg-fallback-"));
  writeFileSync(join(dir, "test.ts"), "hello world\n");
  const originalCwd = process.cwd;
  process.cwd = () => dir; // override cwd

  let stdout = "";
  const originalWrite = process.stdout.write;
  process.stdout.write = (chunk) => { stdout += chunk.toString(); return true; };

  await handleRgPassthrough(["hello"]);

  process.stdout.write = originalWrite;
  process.cwd = originalCwd;

  expect(stdout).toContain("test.ts:");
  expect(stdout).toContain("hello world");
});
```

### 3. Test: "handleRgPassthrough propagates correct exit codes"
**Why:** rg exit code 1 = no matches (not an error), exit code 2 = error. `handleRgPassthrough` calls `process.exit(1)` when merged output is empty but never tests actual exit code propagation from rg itself.
**Asserts:** Exit code 1 when no matches, exit code 0 when matches found, exit code 2 propagated on rg error
**Pseudocode:**
```typescript
test("exit code 1 when no matches", async () => {
  // Cannot easily test process.exit in bun:test — use stdio capture approach
  const proc = spawn(process.execPath, ["cli.js", "rg", "nonexistentpatternxyz", dir]);
  const exitCode = await new Promise(r => proc.on("close", (code) => r(code)));
  expect(exitCode).toBe(1);
});
```

### 4. Test: "handleRgPassthrough merges rg + mnemex results end-to-end"
**Why:** All existing merge tests use mocked `SearchResult[]`. No test exercises the actual parallel spawn + mnemex search + merge pipeline.
**Asserts:** mnemex results appear before rg results in final output, both are present, no duplicates
**Pseudocode:**
```typescript
test("mnemex results appear before rg in merged output", async () => {
  // Create a file that mnemex will rank highly (after indexing)
  const dir = mkdtempSync(join(tmpdir(), "rg-merge-e2e-"));
  const file = join(dir, "target.ts");
  writeFileSync(file, "export function importantHelper() { return 42; }\n");

  // Index with mnemex
  // (Need index created — this is the hard part for unit tests)

  const output = await captureStdout(() => handleRgPassthrough(["function", dir]));
  const lines = output.split("\n").filter(l => l.includes("target.ts"));
  // mnemex-ranked lines should come first
  expect(lines[0]).toContain("importantHelper");
});
```

### 5. Test: "searchMnemex timeout produces empty mnemex results (not error)"
**Why:** `searchMnemex` wraps with a 2-second `Promise.race` timeout. If it times out, `mnemexResults.status === "rejected"` → `[]`. No test verifies this fallback.
**Asserts:** When mnemex search times out, pipeline still produces rg output, no crash
**Pseudocode:**
```typescript
test("mnemex timeout does not crash merge pipeline", async () => {
  // Mock indexer.search to hang
  const originalSearch = indexer.search;
  indexer.search = () => new Promise(() => {}); // never resolves

  const output = await captureStdout(() => handleRgPassthrough(["pattern", dir]));

  // Should have fallen back to rg-only output
  expect(output).toMatch(/file:line:content format/);
});
```

### 6. Test: "rg spawn error is handled gracefully"
**Why:** `spawnRg` rejects on non-0/non-1 exit codes. `handleRgPassthrough` handles `rejected` by treating it as `""` (rg output). No test covers this.
**Asserts:** Pipeline continues and outputs mnemex-only results when rg fails
**Pseudocode:**
```typescript
test("rg binary missing does not crash mnemex search pipeline", async () => {
  // Mock @vscode/ripgrep to return invalid path
  const originalRgPath = require("@vscode/ripgrep").rgPath;
  require("@vscode/ripgrep").rgPath = "/nonexistent/rg";

  const output = await captureStdout(() => handleRgPassthrough(["pattern", dir]));

  require("@vscode/ripgrep").rgPath = originalRgPath;
  // Should have output (mnemex-only) or empty string, not thrown
  expect(typeof output).toBe("string");
});
```

### 7. Test: "parseRgArgs handles all Claude Code flag combinations"
**Why:** Claude Code calls rg with specific combos (`--line-number`, `--files-with-matches`, `--glob`, `--type`, `-A`, `-B`, `-C`, `-i`, `--no-heading`, `--color=never`, `-n`). Missing: `--type`, `--no-heading`, `--color`, `-C/-A/-B` with values attached (`-C3`), multi-value flags like `--sort`.
**Asserts:** Parsed args are correct for each combo
**Pseudocode:**
```typescript
test("--type js sets typeFilter in passthroughArgs", () => {
  const result = parseRgArgs(["--type", "typescript", "pattern", "."]);
  expect(result.passthroughArgs).toContain("--type");
  expect(result.passthroughArgs).toContain("typescript");
});

test("-C3 attached form is parsed correctly", () => {
  const result = parseRgArgs(["-C3", "pattern", "."]);
  expect(result.passthroughArgs).toEqual(["-C3", "pattern", "."]);
  // VALUE_FLAGS handles -C as consuming next arg
});

test("--no-heading flag is passed through", () => {
  const result = parseRgArgs(["--no-heading", "pattern"]);
  expect(result.passthroughArgs).toContain("--no-heading");
});

test("--color=never is parsed correctly", () => {
  const result = parseRgArgs(["--color=never", "pattern"]);
  expect(result.passthroughArgs).toContain("--color=never");
});
```

---

## Missing Real-Scenario Tests

1. **rg + mnemex parallel race:** When mnemex is faster than rg, does the merged output still maintain ordering? (Currently mnemex results always first regardless of timing — only tested in the happy path with synchronous mock.)

2. **rg `---` context separator lines** in content mode with mnemex results present: Do separators remain in correct positions relative to grouped results?

3. **Output format compatibility with Claude Code's Grep tool:** The task states the wrapper must produce EXACTLY rg-compatible output. No test parses the actual output format a real Claude Code session would see.

4. **File paths with colons on Unix:** `parseRgLine` uses `firstColon` and `secondColon`. Unix filenames can contain colons. A file named `src:helper.ts` would break `file:line:content` parsing.

5. **Large output from rg:** When rg produces thousands of lines, does `mergeContentMode` handle them without OOM? The test uses single-digit line counts.

6. **Real `rg --count` exit code behavior:** When `mode === "count"`, `execRgDirect` is called and the function returns. The exit code of `execRgDirect` (via `spawnSync`) must propagate correctly.

7. **Wrapper script integration:** The `RG_WRAPPER_CONTENT = '#!/bin/sh\nexec mnemex rg "$@"\n'` is never tested as a script (executable, PATH resolution, argument passing with spaces).

---

## Required Vote

```vote
VERDICT: REJECT
CONFIDENCE: 8
SUMMARY: The 59 tests cover parser and merger unit logic well but are saturated with trivially-true tests (11 identified), entirely miss end-to-end integration testing of the handleRgPassthrough pipeline (rg spawn + mnemex search + merge + exit codes), and have zero coverage of the critical fallback paths and real rg output format that Claude Code depends on.
KEY_ISSUES: Missing handleRgPassthrough e2e, missing .mnemex/ fallback test, missing exit code propagation tests, missing timeout/error handling tests, missing real rg output format tests, missing --type/--no-heading/-C/-B/-A flag parsing tests, 11 trivially-true tests that waste coverage
```
