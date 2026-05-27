Now I have a complete picture. Let me provide my analysis.

---

## Tests to Remove (test nothing)

1. **"empty args returns undefined pattern and defaults"** (line 271-276) — Tests that calling with `[]` returns defaults. This is trivial; the real code would never be called with empty args from Claude Code, and the behavior is obvious from the implementation. Zero bug-catching value.

2. **"args are not mutated by parseRgArgs"** (line 319-324) — Tests immutability of input array. While good practice, this is an implementation detail that doesn't affect output correctness. The test doesn't catch any real bug scenario Claude Code would encounter.

3. **"returns same array reference when -n already present"** (line 351-354) and **"returns same array reference when --line-number already present"** (line 356-359) — Micro-optimization tests for reference equality. These don't test observable behavior, just internal efficiency. Not a real failure mode.

4. **"does not duplicate -n"** (line 340-342) and **"does not duplicate --line-number"** (line 344-349) — Redundant with the reference equality tests above. The functionality is already covered by "adds --line-number when not present" which is the only one that matters.

5. **"invalid regex falls back to literal substring match in merge"** (line 430-437) — Duplicate test. Already tested by **"invalid regex falls back to literal substring match"** (line 384-387) in the matchesPattern describe block. Same behavior, different entry point.

6. **"passthroughArgs equals original args"** tests (lines 295-317) — Four tests that just assert passthroughArgs equals input. This is mechanical verification of a field that's never used in the codebase (search for `passthroughArgs` usage — it's dead). These tests verify nothing about actual behavior.

7. **"output ends with newline when results present"** (line 245-249) — Already implicitly tested by every other merge test that uses `expect(output).toEndWith("\n")` pattern. This specific test doesn't add coverage.

8. **"output modes are correctly detected: -l"** and similar (lines 75-79, 81-85, 87-91) — Three separate tests for `-l`, `--count`, `-c` that could be one parameterized test. Not "test nothing" per se, but overly mechanical.

---

## Missing E2E Tests (concrete proposals)

### 1. Test: "rg passthrough with real @vscode/ripgrep binary"
**Why:** The current tests mock everything. The real rg binary may produce different output formats (context separators, binary file handling, Windows line endings) that the parser doesn't handle.

**Asserts:** 
- spawnRg produces parseable output
- Output format matches expected `file:line:content` format
- Exit code 1 (no matches) is handled gracefully

**Pseudocode:**
```javascript
test("spawnRg with real binary against temp files", async () => {
  const tmpDir = setupTempDirWithFiles({ "test.ts": "function foo() {}" });
  const output = await spawnRg(["foo", tmpDir]);
  expect(output).toMatch(/test\.ts:\d+:function foo/);
  
  const noMatchOutput = await spawnRg(["nonexistent", tmpDir]);
  expect(noMatchOutput).toBe("");
});
```

### 2. Test: "handleRgPassthrough fallback when .mnemex/ doesn't exist"
**Why:** Critical path — when there's no index, must delegate to rg directly with zero overhead. Current tests don't verify this fallback or that it uses spawnSync (not spawn) to propagate exit codes.

**Asserts:**
- process.exit is called with rg's exit code
- No mnemex search is attempted
- stdout/stderr pass through unchanged

**Pseudocode:**
```javascript
test("falls back to direct rg when .mnemex dir missing", async () => {
  const tmpDir = setupTempDirWithoutMnemex();
  const exitSpy = spy(process, 'exit');
  
  await handleRgPassthrough(["foo", tmpDir]);
  
  expect(exitSpy).toHaveBeenCalledWith(0); // or 1 if no matches
  expect(process.stdout.write).not.toHaveBeenCalled(); // direct passthrough
});
```

### 3. Test: "mnemex search timeout (2s) doesn't block rg results"
**Why:** The 2-second timeout is critical for UX. Current tests don't verify timeout behavior or that rg results still display when mnemex times out.

**Asserts:**
- After 2s, searchMnemex rejects
- rg output is still displayed
- Process exits with appropriate code

**Pseudocode:**
```javascript
test("mnemex timeout falls back to rg-only results", async () => {
  const mockIndexer = { search: () => delay(5000, []), close: () => {} };
  mock(createIndexer).mockReturnValue(mockIndexer);
  
  const tmpDir = setupTempDirWithFilesAndMnemex({ "test.ts": "function foo() {}" });
  
  await handleRgPassthrough(["foo", tmpDir]);
  
  expect(process.stdout.write).toHaveBeenCalled(); // rg results shown
  // mnemex results should be empty due to timeout
});
```

### 4. Test: "merged output is parseable by Claude Code Grep tool"
**Why:** The output must match rg's exact format for Claude Code to parse it. This includes `-A/-B/-C` context format, `--no-heading` format, and `--color=never` output.

**Asserts:**
- Lines with context (`-A`, `-B`, `-C`) preserve separators
- `--no-heading` format is correct
- `--color=never` output has no ANSI codes

**Pseudocode:**
```javascript
test("output format matches Claude Code Grep tool expectations", () => {
  const rgOutput = `file1.ts:10:match line
file1.ts-11-context after
--
file2.ts:5:another match
`;
  const merged = mergeResults(rgOutput, [], "match", "content");
  
  // Context lines use - separator after line number
  expect(merged).toMatch(/file1\.ts-\d+-context/);
  // No ANSI color codes
  expect(merged).not.toContain(\u001b[);
});
```

### 5. Test: "handleRgPassthrough with actual Claude Code flag combinations"
**Why:** Claude Code uses specific flag combinations. Tests should verify these exact combinations work end-to-end.

**Asserts:**
- `--line-number --files-with-matches --glob "*.ts"` works
- `-i --no-heading --color=never` works  
- `-A 2 -B 2` context is preserved in merge

**Pseudocode:**
```javascript
const CLAUDE_CODE_FLAG_COMBOS = [
  ["--line-number", "--files-with-matches", "--glob", "*.ts", "pattern", "."],
  ["-i", "--no-heading", "--color=never", "pattern", "."],
  ["-A", "2", "-B", "2", "pattern", "."],
];

for (const combo of CLAUDE_CODE_FLAG_COMBOS) {
  test(`handleRgPassthrough handles Claude Code flags: ${combo.join(" ")}`, async () => {
    const tmpDir = setupTempDirWithFiles({ "test.ts": "function foo() {}" });
    const args = [...combo.slice(0, -1), tmpDir];
    
    await expect(handleRgPassthrough(args)).not.toThrow();
  });
}
```

### 6. Test: "spawnRg handles special characters in file paths"
**Why:** Files with spaces, Unicode, or (on Windows) drive letters may break the `file:line:content` parser.

**Asserts:**
- Spaces in paths are handled
- Unicode filenames work
- Windows paths with drive letters parse correctly

**Pseudocode:**
```javascript
test("spawnRg and merger handle filenames with spaces", async () => {
  const tmpDir = setupTempDirWithFiles({ 
    "my folder/my file.ts": "function foo() {}" 
  });
  
  const output = await spawnRg(["foo", tmpDir]);
  const merged = mergeResults(output, [], "foo", "content");
  
  expect(merged).toContain("my folder/my file.ts:");
});
```

### 7. Test: "merger handles Windows CRLF line endings"
**Why:** rg outputs CRLF on Windows. The parser's `parseRgLine` may break if content includes `\r`.

**Asserts:**
- CRLF line endings don't break file:line:content parsing
- Output preserves expected format

**Pseudocode:**
```javascript
test("parseRgLine handles CRLF line endings", () => {
  const rgOutput = "file.ts:10:function foo() {}\r\nfile.ts:11:bar()\r\n";
  const parsed = mergeResults(rgOutput, [], "foo", "content");
  
  expect(parsed).toContain("file.ts:10:function foo()");
});
```

### 8. Test: "parallel execution: rg and mnemex race correctly"
**Why:** The Promise.allSettled pattern should return results even if one side fails. Tests should verify failure isolation.

**Asserts:**
- If rg fails but mnemex succeeds, mnemex results display
- If mnemex fails but rg succeeds, rg results display
- Both failing produces empty output with exit code 1

**Pseudocode:**
```javascript
test("rg failure while mnemex succeeds shows mnemex results", async () => {
  mock(spawnRg).mockRejectedValue(new Error("rg crashed"));
  mock(searchMnemex).mockResolvedValue([mockResult("x.ts", 1, "pattern", 0.9)]);
  
  await handleRgPassthrough(["pattern", "."]);
  
  expect(process.stdout.write).toHaveBeenCalledWith(
    expect.stringContaining("x.ts:1:")
  );
});
```

---

## Missing Real-Scenario Tests

### 1. Integration test with actual Claude Code Grep tool invocation

**Scenario:** Call `mnemex rg` from Claude Code as the Grep backend and verify the UI parses results correctly.

**Why:** Only way to catch integration issues like ANSI code injection, incorrect exit codes, or format mismatches that break Claude Code's parser.

**Pseudocode:**
```javascript
test("Claude Code Grep tool integration with mnemex rg", async () => {
  // This would require running Claude Code with USE_BUILTIN_RIPGREP=0
  // and MNEMEX_rg pointing to mnemex's rg wrapper, then asserting
  // the search results panel renders correctly
});
```

### 2. Large repository performance test

**Scenario:** Run rg with mnemex on a repo with 10K+ files, verify timeout and memory behavior.

**Why:** The 2s timeout might be too short for large repos, or might not trigger when mnemex search scales poorly.

**Pseudocode:**
```javascript
test("large repo: mnemex times out, rg still returns in time", async () => {
  const largeRepo = setupLargeRepo(10000); // 10K files
  
  const start = Date.now();
  await handleRgPassthrough(["commonPattern", largeRepo]);
  const elapsed = Date.now() - start;
  
  expect(elapsed).toBeLessThan(5000); // Should complete quickly
});
```

### 3. Concurrent rg invocations (race condition test)

**Scenario:** Claude Code may spawn multiple rg calls concurrently. Verify no shared state corruption.

**Why:** If mergeResults or spawnRg uses shared mutable state, concurrent calls could interleave results.

**Pseudocode:**
```javascript
test("concurrent handleRgPassthrough calls don't interleave results", async () => {
  const tmpDir1 = setupTempDirWithFiles({ "a.ts": "function aaa() {}" });
  const tmpDir2 = setupTempDirWithFiles({ "b.ts": "function bbb() {}" });
  
  const [result1, result2] = await Promise.all([
    handleRgPassthrough(["aaa", tmpDir1]),
    handleRgPassthrough(["bbb", tmpDir2]),
  ]);
  
  // Verify results didn't cross-contaminate
});
```

### 4. Index corruption/migration edge case

**Scenario:** Test what happens when `.mnemex/` exists but is corrupted or from an incompatible version.

**Why:** handleRgPassthrough checks only existence, not validity. A corrupted index could cause searchMnemex to throw.

**Pseudocode:**
```javascript
test("corrupted .mnemex index falls back to rg-only gracefully", async () => {
  const tmpDir = setupTempDirWithCorruptedMnemex();
  
  await expect(handleRgPassthrough(["pattern", tmpDir])).resolves.not.toThrow();
  // Should fall back to rg, not crash
});
```

### 5. Glob pattern interaction test

**Scenario:** `--glob "*.ts"` should filter both rg AND mnemex results to match.

**Why:** mergrResults doesn't apply glob filtering to mnemex results. If mnemex returns `.tsx` results when `--glob "*.ts"` is passed, they'll leak through.

**Pseudocode:**
```javascript
test("--glob *.ts filters mnemex results to TypeScript only", async () => {
  // Setup: test.ts and test.tsx both contain pattern
  const tmpDir = setupTempDirWithFiles({
    "a.ts": "function foo() {}",
    "b.tsx": "function foo() {}"
  });
  
  await handleRgPassthrough(["--glob", "*.ts", "foo", tmpDir]);
  
  // Should NOT include b.tsx in output
  expect(process.stdout.write).toHaveBeenCalledWith(
    expect.not.stringContaining("b.tsx")
  );
});
```

---

## Summary Assessment

The current test suite is **unit-test-heavy but integration-light**. It thoroughly tests the parser and merger in isolation but has zero tests for:

1. **The actual spawnRg/execRgDirect functions** that interact with the real rg binary
2. **The handleRgPassthrough orchestration** that ties everything together
3. **Failure modes** (timeout, index missing, index corrupted, rg crash)
4. **Output format compliance** with what Claude Code's Grep tool expects

Most critically, **none of the 59 tests actually verify the wrapper works as a drop-in rg replacement** — they test helper functions but not the core value proposition.

---

```vote
VERDICT: REJECT
CONFIDENCE: 8
SUMMARY: Current tests thoroughly verify parser/merger helpers but fail to test the actual rg wrapper integration, fallback behavior, timeout handling, or output compatibility with Claude Code.
KEY_ISSUES: No e2e tests, no real rg binary tests, no timeout/fallback tests, no Claude Code format validation, no failure mode testing
```
