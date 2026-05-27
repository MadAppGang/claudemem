# Test Analysis: tests/rg.test.ts

## Tests to Remove (test nothing)

**1. "returns same array reference when -n already present" (ensureLineNumbers)**
The test asserts `ensureLineNumbers(args) toBe(args)` (reference equality) when `-n` is already present. This tests an implementation micro-optimization (return-same-reference) that has no behavioral significance. Whether the function returns the same reference or a copy with identical contents is irrelevant to callers. A caller cannot and should not rely on reference identity here. This test encodes an implementation detail, not a behavioral requirement.

**2. "returns same array reference when --line-number already present" (ensureLineNumbers)**
Same reasoning as above. Reference identity is an implementation choice, not a behavioral contract. Removing these two reference-equality tests would not weaken behavioral coverage at all.

**3. "args are not mutated by parseRgArgs" (parseRgArgs — additional edge cases)**
The test copies the input args, calls `parseRgArgs`, then asserts the original is unchanged. While immutability is a reasonable property, the implementation always does `return { ..., passthroughArgs: args }` — it just returns the original reference unchanged. So the test trivially passes because the function never touches the array. It does not guard against any realistic mutation bug; any future code change that did mutate args would be caught by existing tests whose assertions would break. At the same time, this is a very low-cost test so it is borderline — but it provides near-zero incremental bug-catching value.

**4. "empty merge result signals no matches" (mergeResults — empty output contract)**
```typescript
test("empty merge result signals no matches", () => {
    const output = mergeResults("", [], "nonexistent", "content");
    expect(output).toBe("");
    // In handleRgPassthrough, empty merged output → process.exit(1)
});
```
This is an exact duplicate of "empty rg output and empty mnemex results returns empty string" already in `describe("mergeResults — content mode")`. It adds a comment explaining the downstream consequence but tests no new code path. The comment belongs in documentation or the actual e2e test, not as a distinct unit test.

**5. "passthroughArgs equals original args (simple pattern and path)" / "passthroughArgs equals original args (-e flag)" / "passthroughArgs equals original args (combined short flags)" / "passthroughArgs equals original args (count mode)" — four tests**
These four tests all assert `result.passthroughArgs toEqual(args)`. Looking at the implementation: `passthroughArgs: args` — the function literally returns the input reference. These tests are trivially true by construction and would never catch a real bug (any bug in passthrough would already surface in the `spawnRg` flow that uses these args, not here). As a group these four tests validate a one-liner that cannot be wrong.

**Summary of tests to remove (8 total):**
1. `ensureLineNumbers` — "returns same array reference when -n already present"
2. `ensureLineNumbers` — "returns same array reference when --line-number already present"
3. `parseRgArgs` — "args are not mutated by parseRgArgs"
4. `mergeResults — empty output contract` — "empty merge result signals no matches"
5. `parseRgArgs additional edge cases` — "passthroughArgs equals original args (simple pattern and path)"
6. `parseRgArgs additional edge cases` — "passthroughArgs equals original args (-e flag)"
7. `parseRgArgs additional edge cases` — "passthroughArgs equals original args (combined short flags)"
8. `parseRgArgs additional edge cases` — "passthroughArgs equals original args (count mode)"

---

## Missing E2E Tests (concrete proposals)

### Group A — Full handleRgPassthrough flow (process-level)

**Test 1: "rg passthrough falls back to direct rg when .mnemex/ dir does not exist"**

Why: `handleRgPassthrough` calls `execRgDirect` immediately when `!existsSync(mnemexDir)`. This is the zero-overhead fast path. If this check breaks, every install without a mnemex index gets mnemex overhead or a crash. No current test exercises this path.

Asserts:
- When invoked in a tmpdir with real files but no `.mnemex/` directory, stdout output is identical to running rg directly
- Exit code is 0 when matches exist

Pseudocode:
```typescript
test("falls back to raw rg when no .mnemex/ dir exists", async () => {
    // Create a temp dir with a known file, no .mnemex/
    const dir = mkdtempSync(...);
    writeFileSync(join(dir, "hello.ts"), "export function greet() {}\n");

    // Spawn: node dist/cli.js rg greet .
    const result = spawnSync(
        process.execPath, [cliPath, "rg", "greet", "."],
        { cwd: dir, encoding: "utf-8" }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("hello.ts");
    expect(result.stdout).toMatch(/hello\.ts:\d+:.*greet/);
});
```

---

**Test 2: "rg passthrough produces exactly file:line:content format per line"**

Why: Claude Code's Grep tool parser expects `file:line:content` on each match line (no ANSI color codes, no heading separators by default when called with `--no-heading --color=never`). If the wrapper injects any extra decoration, Claude Code cannot parse it. No current test verifies the exact byte-level output format from the full flow.

Asserts:
- Every non-separator output line matches the regex `/^[^:]+:\d+:.+$/`
- No ANSI escape sequences present (`\x1b[`) in output
- Output ends with `\n`

Pseudocode:
```typescript
test("output format is parseable file:line:content with no color codes", async () => {
    const dir = setupTmpDirWithFiles({
        "src/utils.ts": "export function parseQuery(q: string) { return q; }\n"
    });
    createMnemexIndexStub(dir); // create empty .mnemex/ dir so passthrough is NOT triggered

    const result = spawnSync(cliPath, [
        "rg", "--no-heading", "--color=never", "parseQuery", "."
    ], { cwd: dir, encoding: "utf-8" });

    const lines = result.stdout.split("\n").filter(Boolean);
    for (const line of lines) {
        if (line === "--") continue; // context separator
        expect(line).toMatch(/^[^:]+:\d+:.+/);
        expect(line).not.toMatch(/\x1b\[/);
    }
});
```

---

**Test 3: "rg passthrough --files-with-matches produces one file path per line"**

Why: Claude Code calls `rg --files-with-matches` to get file lists. The output must be bare file paths, one per line, no decoration. The merger does emit `\n`-terminated output but this is never validated end-to-end with a real rg invocation.

Asserts:
- Each output line is a valid file path (no `:line:content` suffix)
- File paths that actually exist on disk
- No duplicates

Pseudocode:
```typescript
test("--files-with-matches output is one file path per line", async () => {
    const dir = setupTmpDir({
        "a.ts": "function foo() {}",
        "b.ts": "function bar() {}",
        "c.ts": "function foo() {} // also foo",
    });
    createMnemexDirStub(dir);

    const result = spawnSync(cliPath, [
        "rg", "--files-with-matches", "foo", "."
    ], { cwd: dir, encoding: "utf-8" });

    const lines = result.stdout.split("\n").filter(Boolean);
    // Each line must be a path, no colons followed by digits
    for (const line of lines) {
        expect(line).not.toMatch(/:\d+:/);
        expect(existsSync(join(dir, line))).toBe(true);
    }
    // Deduplication: a.ts and c.ts match, no duplicates
    expect(new Set(lines).size).toBe(lines.length);
});
```

---

**Test 4: "rg passthrough exit code is 1 when pattern has no matches"**

Why: `handleRgPassthrough` calls `process.exit(1)` when `merged.trim()` is empty. rg itself exits 1 for no-match. If the wrapper exits 0 for no-match, Claude Code's Grep tool would misinterpret silence as success. This is not tested anywhere.

Asserts:
- Exit code is 1 when pattern matches nothing in the given directory

Pseudocode:
```typescript
test("exits with code 1 when no matches found", async () => {
    const dir = setupTmpDir({ "file.ts": "const x = 1;\n" });
    createMnemexDirStub(dir);

    const result = spawnSync(cliPath, [
        "rg", "TOTALLY_ABSENT_SYMBOL_XYZ987", "."
    ], { cwd: dir });

    expect(result.status).toBe(1);
    expect(result.stdout.toString()).toBe("");
});
```

---

**Test 5: "rg passthrough --count mode passes through to rg without mnemex augmentation"**

Why: `handleRgPassthrough` calls `execRgDirect` for `count` mode, meaning it goes straight to rg with no mnemex overhead. The current merger unit tests verify the passthrough in isolation, but there is no test that verifies the full pipeline chooses the right branch and produces valid count output (e.g., `file.ts:3`).

Asserts:
- Output format is `filepath:count` per matched file
- Exit code is 0 when matches exist

Pseudocode:
```typescript
test("--count mode outputs file:count lines", async () => {
    const dir = setupTmpDir({
        "a.ts": "foo\nfoo\nfoo\n",
        "b.ts": "bar\n",
    });
    createMnemexDirStub(dir);

    const result = spawnSync(cliPath, ["rg", "--count", "foo", "."], {
        cwd: dir, encoding: "utf-8"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/a\.ts:3/);
    expect(result.stdout).not.toContain("b.ts");
});
```

---

**Test 6: "rg passthrough mnemex timeout falls back to rg-only output"**

Why: `searchMnemex` has a 2-second hard timeout; on timeout `Promise.allSettled` receives a rejection and `mnemexHits` becomes `[]`. The merged output should then be rg-only — no crash, no hang, and crucially no empty output if rg found matches. No current test simulates a timeout scenario.

Asserts:
- When mnemex search exceeds timeout (stubbed), output still contains rg matches
- Exit code is 0

Pseudocode:
```typescript
test("mnemex timeout does not suppress rg results", async () => {
    // Create a project with a valid .mnemex/ dir that is intentionally
    // corrupted or points to a non-responding DB, so searchMnemex times out.
    const dir = setupTmpDir({
        "app.ts": "export function computeHash(input: string) { return input; }\n"
    });
    // Create .mnemex/ dir with corrupted/empty contents to force timeout
    mkdirSync(join(dir, ".mnemex"), { recursive: true });
    writeFileSync(join(dir, ".mnemex", "index.lancedb"), "garbage");

    const result = spawnSync(cliPath, ["rg", "computeHash", "."], {
        cwd: dir, encoding: "utf-8", timeout: 10000
    });

    // rg results must appear even when mnemex fails
    expect(result.stdout).toContain("computeHash");
    expect(result.status).toBe(0);
});
```

---

**Test 7: "rg passthrough with --glob flag restricts results to matching files"**

Why: Claude Code frequently calls `rg --glob '*.ts'` to restrict search to TypeScript. The `parseRgArgs` parser correctly identifies `--glob` as a value-consuming flag (pattern stays correct), but the glob is passed through to real rg. A regression in the passthrough args (e.g., dropping the `--glob` flag) would cause false positives across all file types. No current test validates that glob filtering actually works end-to-end.

Asserts:
- Only `.ts` files appear in output when `--glob '*.ts'` is used
- `.js` files in same directory are absent from output

Pseudocode:
```typescript
test("--glob flag restricts matched files end-to-end", async () => {
    const dir = setupTmpDir({
        "match.ts": "function targetFn() {}",
        "also-match.js": "function targetFn() {}",
        "ignore.md": "targetFn is mentioned here",
    });
    createMnemexDirStub(dir);

    const result = spawnSync(cliPath, [
        "rg", "--glob", "*.ts", "targetFn", "."
    ], { cwd: dir, encoding: "utf-8" });

    expect(result.stdout).toContain("match.ts");
    expect(result.stdout).not.toContain("also-match.js");
    expect(result.stdout).not.toContain("ignore.md");
});
```

---

**Test 8: "rg passthrough context flags -A/-B/-C produce context lines in output"**

Why: Claude Code can call `rg -A 2 pattern` to get surrounding context lines. These appear as `file-line-content` (dash separator, not colon) in rg output. The merger currently passes non-parseable lines through via `nonMatchLines`. A regression that strips context lines would silently degrade Claude Code's results. No current test validates context lines survive the full pipeline.

Asserts:
- With `-A 1`, output contains the match line AND the line following it
- Context separator `--` appears between distinct match groups
- Context lines use the `file-linenum-content` (dash) format, not `:` format

Pseudocode:
```typescript
test("-A 1 includes one line of context after each match", async () => {
    const dir = setupTmpDir({
        "code.ts": [
            "function alpha() {",
            "  return 1;",   // context after match
            "}",
            "function beta() {}", // unrelated
        ].join("\n") + "\n"
    });
    createMnemexDirStub(dir);

    const result = spawnSync(cliPath, [
        "rg", "-A", "1", "alpha", "."
    ], { cwd: dir, encoding: "utf-8" });

    expect(result.stdout).toContain("alpha");
    expect(result.stdout).toContain("return 1"); // context line
});
```

---

**Test 9: "spawnRg adds --line-number to args before calling rg binary"**

Why: `spawnRg` calls `ensureLineNumbers(args)` before spawning rg. If this call is removed or the wrong args are passed to the real rg binary, the merger receives output without line numbers and cannot parse `file:line:content` format — silently returning empty mnemex results with rg passthrough. This is the most critical integration point and is completely untested.

Asserts:
- Even when called without `-n`/`--line-number`, rg output contains line numbers
- Output lines match `file:line:content` format parseable by `parseRgLine`

Pseudocode:
```typescript
test("spawnRg output always contains line numbers regardless of input args", async () => {
    // Call spawnRg (exported or tested via handleRgPassthrough) WITHOUT -n
    // and verify the raw rg output contains line numbers
    const dir = setupTmpDir({ "x.ts": "const val = 42;\n" });

    // Since spawnRg is not exported, test via the full passthrough:
    // Verify merged output contains line numbers
    createMnemexDirStub(dir);
    const result = spawnSync(cliPath, ["rg", "val", "."], {
        cwd: dir, encoding: "utf-8"
    });

    // Must contain line number in output
    expect(result.stdout).toMatch(/x\.ts:\d+:.*val/);
});
```

---

**Test 10: "mergeResults preserves original rg line content unchanged"**

Why: The merger reconstructs lines from parsed rg output as `line.raw` — which is the original `raw` string from `parseRgLine`. A subtle bug (e.g., re-assembling `file:line:content` instead of using `raw`) would corrupt content that includes colons (e.g., URLs, TypeScript type annotations like `Record<string, number>`). No current test uses content with embedded colons.

Asserts:
- A line like `src/types.ts:42:type Foo = Record<string, number>;` survives the merger byte-for-byte
- Content after the second colon is preserved verbatim

Pseudocode:
```typescript
test("rg lines with colons in content are preserved verbatim", () => {
    const rgOutput =
        "src/types.ts:42:type Foo = Record<string, number>;\n" +
        "src/api.ts:10:const url = 'https://example.com/api';\n";

    const output = mergeResults(rgOutput, [], "Record", "content");

    expect(output).toContain(
        "src/types.ts:42:type Foo = Record<string, number>;"
    );
    expect(output).toContain(
        "src/api.ts:10:const url = 'https://example.com/api';"
    );
});
```

---

**Test 11: "mnemex results in files-with-matches mode that do NOT contain a literal pattern match are still included"**

Why: In `files-with-matches` mode, `mergeFilesMode` includes ALL mnemex result files regardless of whether any line in the chunk actually contains the pattern. This is intentional (semantic search — the file is semantically relevant even without a literal match). But the current test `"mnemex files appear before rg files"` uses a mockResult whose content literally contains "test", so it never exercises the case where semantic relevance diverges from literal match. If a future change adds literal filtering to `files-with-matches`, existing tests would not catch the regression.

Asserts:
- A mnemex result whose chunk content does NOT contain the search pattern still appears in `files-with-matches` output

Pseudocode:
```typescript
test("files-with-matches includes mnemex files even without literal pattern match", () => {
    // chunk content: "class DatabaseManager" — no literal "query" pattern
    const result = mockResult("src/db.ts", 1, "class DatabaseManager {}", 0.85);
    const output = mergeResults("", [result], "query", "files-with-matches");
    expect(output).toContain("src/db.ts");
});
```

---

**Test 12: "rg passthrough with -i (case-insensitive) flag still produces correct output"**

Why: Claude Code passes `-i` for case-insensitive searches. The `parseRgArgs` handles `-i` as a boolean short flag (no value consumed), keeping the pattern correct. But this is only unit-tested. An end-to-end test verifies both that rg is called with `-i` (file `UPPER.ts` is matched) and that the pattern is extracted correctly for mnemex.

Asserts:
- Searching `FOO` with `-i` matches a file containing `foo` (lowercase)

Pseudocode:
```typescript
test("-i flag enables case-insensitive matching end-to-end", async () => {
    const dir = setupTmpDir({ "lower.ts": "function fooBar() {}\n" });
    createMnemexDirStub(dir);

    const result = spawnSync(cliPath, ["rg", "-i", "FOO", "."], {
        cwd: dir, encoding: "utf-8"
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("lower.ts");
});
```

---

## Summary of gaps

The existing 59 tests cover the parser and merger units well. What is entirely absent:

1. Any test that spawns the actual `mnemex rg` CLI as a subprocess
2. Any test that invokes the real `@vscode/ripgrep` binary
3. Any test of `handleRgPassthrough` branching logic (no-index path, count-mode path, timeout fallback)
4. Any validation that output format is parseable by Claude Code's Grep tool
5. Any test of exit code semantics (0 = matches, 1 = no matches)
6. Any test of rg flags that affect output format (-A/-B/-C context, --glob, -i)
7. Any test of content with embedded colons (URL, TypeScript types) in rg output

The 12 proposed tests above cover all seven gaps. Tests 1–9 require spawning the CLI as a subprocess (true e2e). Tests 10–12 are unit-level additions that close specific behavior gaps in the merger.

---

```vote
VERDICT: REJECT
CONFIDENCE: 9
SUMMARY: The test suite covers unit behavior of parser and merger adequately but has zero end-to-end coverage of handleRgPassthrough, the critical integration path where real rg binary output is merged with mnemex results and written to stdout for Claude Code to consume.
KEY_ISSUES: No subprocess/e2e tests, exit-code semantics untested, output format never validated against Claude Code Grep parser expectations, timeout fallback untested, 8 tests provide zero incremental bug-catching value and should be removed
```
