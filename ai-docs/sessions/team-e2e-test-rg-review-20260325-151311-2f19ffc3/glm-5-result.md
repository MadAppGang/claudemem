Now I have a complete picture. Let me analyze the current test suite and identify gaps.

---

## Tests to Remove (test nothing)

1. **"pattern only defaults searchPath to '.'"** — Near-duplicate of "simple pattern and path" with slightly different input. Tests obvious default behavior.

2. **"no pattern returns undefined"** — Tests that missing pattern = undefined. Obvious TypeScript behavior.

3. **"empty args returns undefined pattern and defaults"** — Trivial, confirms all defaults with zero input.

4. **"passthroughArgs equals original args (simple pattern and path)"** — Tests identity, not behavior.

5. **"passthroughArgs equals original args (-e flag)"** — Same as above, different input variant.

6. **"passthroughArgs equals original args (combined short flags)"** — Same as above, different input variant.

7. **"passthroughArgs equals original args (count mode)"** — Same as above, different input variant.

8. **"args are not mutated by parseRgArgs"** — Defensive test of implementation detail, not core functionality.

9. **"returns same array reference when -n already present"** — Implementation detail about object identity, not behavior.

10. **"returns same array reference when --line-number already present"** — Same as above.

11. **"does not duplicate -n"** + **"does not duplicate --line-number"** — Could be merged into one test.

12. **"output ends with newline when results present"** — Tests extremely obvious behavior (newline-terminated output).

13. **"empty merge result signals no matches"** — Tests empty string but not the critical exit code behavior it references in the comment.

14. **"returns empty string when rg output is empty"** (count mode) — Near-duplicate of content-mode version.

15. **"empty inputs return empty string"** (files-with-matches) — Near-duplicate of content-mode version.

**Total low-value tests: ~15 tests** that could be removed or consolidated.

---

## Missing E2E Tests (concrete proposals)

### 1. Test: "spawnRg returns real rg output with --line-number"
**Why:** No test validates that `spawnRg` correctly invokes the actual `@vscode/ripgrep` binary and returns parseable output.
**Asserts:**
- rg binary exists and is executable
- Output format matches `file:line:content`
- Works with Claude Code's typical flags (`-n`, `--color=never`)

```typescript
test("spawnRg returns real rg output with --line-number", async () => {
  // Create temp file with known content
  const tmpDir = mkdtempSync(join(tmpdir(), "rg-test-"));
  writeFileSync(join(tmpDir, "test.ts"), "function handleSearch() {}\n");
  
  const output = await spawnRg(["handleSearch", tmpDir]);
  
  expect(output).toMatch(/test\.ts:\d+:function handleSearch/);
  expect(output).toEndWith("\n");
});
```

### 2. Test: "handleRgPassthrough exits 0 with matches, 1 without"
**Why:** The exit code contract is critical for Claude Code's Grep tool but never tested.
**Asserts:** Process exit code matches rg semantics.

```typescript
test("handleRgPassthrough exits 1 when no matches found", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "rg-test-"));
  // NO .mnemex directory → falls back to rg-only
  
  const exitCode = await runCli(["rg", "nonexistent_pattern_xyz", tmpDir]);
  expect(exitCode).toBe(1);
});

test("handleRgPassthrough exits 0 when matches found", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "rg-test-"));
  writeFileSync(join(tmpDir, "test.ts"), "export const MATCHME = 1;\n");
  
  const exitCode = await runCli(["rg", "MATCHME", tmpDir]);
  expect(exitCode).toBe(0);
});
```

### 3. Test: "handleRgPassthrough falls back to rg-only when .mnemex missing"
**Why:** The fast-path optimization at line 7527-7530 is untested. If this breaks, mnemex rg becomes unusable in non-indexed dirs.
**Asserts:** No error when .mnemex/ absent, output matches pure rg.

```typescript
test("handleRgPassthrough falls back to rg-only when .mnemex missing", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "rg-test-"));
  writeFileSync(join(tmpDir, "test.ts"), "const x = 1;\n");
  // No .mnemex/ directory
  
  const { stdout, exitCode } = await runCliWithOutput(["rg", "const", tmpDir]);
  
  expect(exitCode).toBe(0);
  expect(stdout).toContain("test.ts");
  // Should NOT attempt mnemex search (fast path)
});
```

### 4. Test: "handleRgPassthrough merges mnemex + rg results with correct ordering"
**Why:** The core value proposition — semantic results first — is untested at the integration level.
**Asserts:** Mnemex results appear before pure-rg results in merged output.

```typescript
test("handleRgPassthrough merges mnemex + rg results with mnemex first", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "rg-test-"));
  // Create .mnemex index with semantic match
  // Create file with non-semantic match
  
  const { stdout } = await runCliWithOutput(["rg", "pattern", tmpDir]);
  
  const lines = stdout.split("\n").filter(l => l.length > 0);
  // First lines should be from mnemex (higher score)
  // Later lines from rg only
  expect(lines.findIndex(l => l.includes("semantic_match")))
    .toBeLessThan(lines.findIndex(l => l.includes("text_only_match")));
});
```

### 5. Test: "handleRgPassthrough handles mnemex timeout gracefully"
**Why:** 2-second timeout at line 7509 is untested. If mnemex hangs, rg must still return.
**Asserts:** Output produced even if mnemex times out; rg results still returned.

```typescript
test("handleRgPassthrough handles mnemex timeout gracefully", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "rg-test-"));
  // Create .mnemex with slow/corrupt index
  writeFileSync(join(tmpDir, "test.ts"), "const MATCHME = 1;\n");
  
  // Mock slow mnemex search (>2000ms)
  const { stdout, exitCode } = await runCliWithOutput(
    ["rg", "MATCHME", tmpDir],
    { timeout: 5000 }
  );
  
  // Should still get rg results despite mnemex timeout
  expect(exitCode).toBe(0);
  expect(stdout).toContain("MATCHME");
});
```

### 6. Test: "handleRgPassthrough with --files-with-matches produces filenames only"
**Why:** Claude Code uses `-l`/`--files-with-matches` mode; output must be one file per line, no line numbers.
**Asserts:** Output format matches rg's `-l` behavior exactly.

```typescript
test("handleRgPassthrough -l produces filenames only, one per line", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "rg-test-"));
  writeFileSync(join(tmpDir, "a.ts"), "function foo() {}\n");
  writeFileSync(join(tmpDir, "b.ts"), "function bar() {}\n");
  
  const { stdout } = await runCliWithOutput(["rg", "-l", "function", tmpDir]);
  
  const lines = stdout.trim().split("\n");
  for (const line of lines) {
    // Each line should be a path only, no colons with line numbers
    expect(line).not.toMatch(/:\d+:/);
    expect(existsSync(join(tmpDir, line))).toBe(true);
  }
});
```

### 7. Test: "handleRgPassthrough with --glob filter works correctly"
**Why:** Claude Code uses `--glob` extensively. Pattern extraction + passthrough must work together.
**Asserts:** Glob filter applies to both rg and mnemex results.

```typescript
test("handleRgPassthrough --glob=*.ts filters to ts files only", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "rg-test-"));
  writeFileSync(join(tmpDir, "a.ts"), "const MATCHME = 1;\n");
  writeFileSync(join(tmpDir, "b.js"), "const MATCHME = 2;\n");
  
  const { stdout } = await runCliWithOutput(
    ["rg", "--glob=*.ts", "MATCHME", tmpDir]
  );
  
  expect(stdout).toContain("a.ts");
  expect(stdout).not.toContain("b.js");
});
```

### 8. Test: "handleRgPassthrough with -C context flag preserves context lines"
**Why:** Context lines use `--` separator; merger must preserve these non-match lines.
**Asserts:** Context lines appear in output, separator preserved.

```typescript
test("handleRgPassthrough -C 2 includes context lines with separator", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "rg-test-"));
  writeFileSync(join(tmpDir, "test.ts"), 
    "line 1\nline 2\nMATCH HERE\nline 4\nline 5\n");
  
  const { stdout } = await runCliWithOutput(
    ["rg", "-C", "2", "MATCH", tmpDir]
  );
  
  // Should include 2 lines before and after
  expect(stdout).toContain("line 2");
  expect(stdout).toContain("MATCH HERE");
  expect(stdout).toContain("line 4");
});
```

### 9. Test: "handleRgPassthrough --count mode passes through unchanged"
**Why:** Count mode is explicitly a passthrough (merger.ts line 81-84) but never tested end-to-end.
**Asserts:** Output is exact rg count format, no mnemex augmentation.

```typescript
test("handleRgPassthrough --count returns pure rg output", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "rg-test-"));
  writeFileSync(join(tmpDir, "test.ts"), "x\nx\nx\n");
  
  const { stdout } = await runCliWithOutput(
    ["rg", "--count", "x", tmpDir]
  );
  
  // Format: filename:count
  expect(stdout.trim()).toMatch(/test\.ts:3/);
});
```

### 10. Test: "rg install creates wrapper script with correct content"
**Why:** Install creates `~/.local/bin/rg` wrapper; untested at filesystem level.
**Asserts:** Wrapper file exists, is executable, contains correct shebang.

```typescript
test("rg install creates executable wrapper at ~/.local/bin/rg", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "home-"));
  // Mock homedir() to use fakeHome
  
  await handleRgInstall();
  
  const wrapperPath = join(fakeHome, ".local", "bin", "rg");
  expect(existsSync(wrapperPath)).toBe(true);
  
  const content = readFileSync(wrapperPath, "utf-8");
  expect(content).toContain("#!/bin/sh");
  expect(content).toContain("exec mnemex rg");
  
  // Check executable bit
  const stats = statSync(wrapperPath);
  expect(stats.mode & 0o111).toBeTruthy(); // has execute bit
});
```

### 11. Test: "rg uninstall only removes mnemex wrapper, not user rg"
**Why:** Safety check at install.ts line 73-79 must not accidentally delete non-mnemex rg.
**Asserts:** Non-mnemex rg is preserved; mnemex rg is removed.

```typescript
test("rg uninstall skips non-mnemex rg binaries", async () => {
  const fakeHome = mkdtempSync(join(tmpdir(), "home-"));
  const wrapperPath = join(fakeHome, ".local", "bin", "rg");
  
  // Create a non-mnemex rg
  writeFileSync(wrapperPath, "#!/bin/sh\nexec /usr/bin/rg", { mode: 0o755 });
  
  await handleRgUninstall();
  
  // Should NOT be removed (doesn't contain "mnemex")
  expect(existsSync(wrapperPath)).toBe(true);
});
```

### 12. Test: "handleRgPassthrough handles Promise.allSettled rejection correctly"
**Why:** Line 7542 uses Promise.allSettled; if rg fails (exit >1), must still process mnemex results.
**Asserts:** Graceful degradation when rg fails with non-0/1 exit code.

```typescript
test("handleRgPassthrough returns mnemex results when rg fails", async () => {
  // Create scenario where rg exits with code 2 (error)
  // e.g., invalid regex pattern
  
  const { stdout, exitCode } = await runCliWithOutput(
    ["rg", "[invalid-regex", tmpDir]
  );
  
  // Should still get mnemex results (fallback to literal match)
  expect(stdout.length).toBeGreaterThan(0);
});
```

---

## Missing Real-Scenario Tests

### 1. Test: "Claude Code Grep tool flag combination"
**Why:** Claude Code's actual Grep tool calls use specific flag combos that must work together.
**Scenario:** `rg --line-number --color=never --no-heading -C 3 "pattern" --glob "*.ts"`

```typescript
test("Claude Code typical flag combination works end-to-end", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "rg-test-"));
  // Create realistic project structure
  
  const args = [
    "--line-number", "--color=never", "--no-heading",
    "-C", "3", "--glob", "*.ts",
    "handleSearch", tmpDir
  ];
  
  const { stdout, exitCode } = await runCliWithOutput(["rg", ...args]);
  
  // Verify output is parseable by Claude Code's output parser
  const lines = stdout.split("\n").filter(l => l.length > 0);
  for (const line of lines) {
    if (!line.startsWith("--")) {
      expect(line).toMatch(/^[^:]+:\d+:/); // file:line:content format
    }
  }
});
```

### 2. Test: "Performance: rg + mnemex parallel execution is faster than sequential"
**Why:** The parallel design (Promise.all) should be faster; if not, there's a bug.
**Asserts:** Combined time < rg time + mnemex time.

```typescript
test("parallel rg + mnemex completes within rg timeout", async () => {
  const start = Date.now();
  await runCliWithOutput(["rg", "pattern", indexedProjectDir]);
  const elapsed = Date.now() - start;
  
  // Should complete within reasonable time (< 3s even with mnemex)
  expect(elapsed).toBeLessThan(3000);
});
```

### 3. Test: "Output is byte-for-byte identical to rg for --count mode"
**Why:** Tools may parse output exactly; count mode must be perfect passthrough.
**Asserts:** Mnemex rg output === real rg output for count mode.

```typescript
test("--count output is identical to native rg", async () => {
  const tmpDir = mkdtempSync(join(tmpdir(), "rg-test-"));
  writeFileSync(join(tmpDir, "test.ts"), "x\nx\n");
  
  const mnemexOutput = await runCliCapture(["rg", "--count", "x", tmpDir]);
  const rgOutput = await runNativeRg(["--count", "x", tmpDir]);
  
  expect(mnemexOutput).toBe(rgOutput);
});
```

---

```vote
VERDICT: REJECT
CONFIDENCE: 8
SUMMARY: Current tests are pure unit tests of internal functions with zero E2E coverage of the actual rg passthrough flow that Claude Code depends on.
KEY_ISSUES: No test spawns real rg binary, no test validates exit codes, no test exercises handleRgPassthrough, no test uses actual Claude Code flag combinations, no fallback testing, no timeout testing
```
