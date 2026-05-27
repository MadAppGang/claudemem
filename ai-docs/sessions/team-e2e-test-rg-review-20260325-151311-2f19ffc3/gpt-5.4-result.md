## Tests to Remove (test nothing)
1. `"passthroughArgs equals original args (simple pattern and path)"` — this only asserts `passthroughArgs: args` from `parseRgArgs` in `src/rg/parser.ts:225-230`. It cannot catch a meaningful bug unless that field stops being a passthrough entirely, and three more copies of the same assertion already exist.

2. `"passthroughArgs equals original args (-e flag)"` — same issue as above; duplicate low-value assertion of a trivial field assignment in `src/rg/parser.ts:229`.

3. `"passthroughArgs equals original args (combined short flags)"` — same trivial coverage, no new behavior.

4. `"passthroughArgs equals original args (count mode)"` — same trivial coverage, no bug-catching value beyond the first copy.

5. `"returns same array reference when -n already present"` — reference identity is not part of the wrapper’s external contract. The important behavior is “don’t duplicate line-number flags,” already covered by `ensureLineNumbers` tests. This locks in an unnecessary implementation detail from `src/rg/parser.ts:88-91`.

6. `"returns same array reference when --line-number already present"` — same issue: tests identity, not behavior.

7. `"empty merge result signals no matches"` — this only reasserts that `mergeResults("", [], ..., "content") === ""`, already covered by `"empty rg output and empty mnemex results returns empty string"`. The comment about `process.exit(1)` is not actually asserted, so it adds zero coverage.

8. `"rg results only returned when no mnemex results"` — weak value. It checks `toContain` on two filenames but not exact output order/shape/newline contract. If kept, it should be replaced with an exact-output assertion; as written it barely tests anything important for rg compatibility.

9. `"preserves rg lines without line numbers"` — low value because `mergeResults(..., [], ...)` effectively appends unparsable raw lines unchanged from `src/rg/merger.ts:145-152,204-210`. It does not exercise interaction with mnemex results, which is where real bugs would be.

## Missing E2E Tests (concrete proposals)
1. Test: `"handleRgPassthrough returns exact rg output when .mnemex is missing"`
   Why: The most important fallback path is in `src/cli.ts:7526-7530`. Right now there is no test proving the wrapper behaves exactly like rg when no index exists.
   Asserts: same stdout bytes and same exit code as the real rg binary for the same args.
   Pseudocode:
   ```ts
   setup temp repo without .mnemex/
   write files:
     src/a.ts -> "function handleSearch() {}\n"
     src/b.ts -> "const x = 1\n"

   expected = run real rg binary with:
     ["--line-number", "--no-heading", "--color=never", "handleSearch", tempDir]

   actual = run CLI entrypoint:
     ["rg", "--no-heading", "--color=never", "handleSearch", tempDir]

   expect(actual.exitCode).toBe(expected.exitCode)
   expect(actual.stdout).toBe(expected.stdout)
   expect(actual.stderr).toBe(expected.stderr)
   ```

2. Test: `"handleRgPassthrough uses rg-only path for --count"`
   Why: `src/cli.ts:7535-7538` bypasses augmentation for count mode. Count output is extremely format-sensitive and currently only unit-tested in merger, not in the real flow.
   Asserts: exact `rg --count` output, no semantic results injected, exit code matches rg.
   Pseudocode:
   ```ts
   setup temp repo with .mnemex/ present
   write file with 3 textual matches
   expected = run real rg ["--count", "--color=never", "foo", tempDir]
   actual = run CLI ["rg", "--count", "--color=never", "foo", tempDir]
   expect(actual.stdout).toBe(expected.stdout)
   expect(actual.exitCode).toBe(expected.exitCode)
   ```

3. Test: `"handleRgPassthrough prepends semantic hits before rg hits in content mode"`
   Why: This is the core promise in `src/cli.ts:7541-7553` and `src/rg/merger.ts:188-210`, but current tests never exercise the full parallel flow.
   Asserts: semantic hit lines appear first, rg hits remain after them, duplicates removed, output remains `file:line:content`.
   Pseudocode:
   ```ts
   setup temp repo with .mnemex/
   files:
     alpha.ts -> no literal regex match but semantically relevant chunk
     beta.ts -> literal "handleSearch" match
   stub/create mnemex index so search returns alpha.ts line 12 first
   run CLI ["rg", "--no-heading", "--color=never", "handleSearch", tempDir]

   lines = stdout.trim().split("\n")
   expect(lines[0]).toBe("alpha.ts:12:<expected line>")
   expect(lines.some(l => l === "beta.ts:3:function handleSearch() {}")).toBe(true)
   expect(all lines).toMatch(/^.+:\d+:.+$/)
   expect(no duplicate file:line pairs)
   ```

4. Test: `"handleRgPassthrough falls back when mnemex search throws"`
   Why: `Promise.allSettled` in `src/cli.ts:7542-7549` is explicitly meant to degrade gracefully on mnemex failure. No current test proves this.
   Asserts: wrapper still returns rg output exactly, no crash, exit code 0/1 based on rg only.
   Pseudocode:
   ```ts
   setup temp repo with .mnemex/
   mock searchMnemex/indexer.search to reject("boom")
   expected = run real rg with same args
   actual = run CLI ["rg", "--no-heading", "--color=never", "needle", tempDir]
   expect(actual.stdout).toBe(expected.stdout)
   expect(actual.exitCode).toBe(expected.exitCode)
   ```

5. Test: `"handleRgPassthrough falls back when mnemex search times out after 2s"`
   Why: Timeout is a critical production path in `src/cli.ts:7508-7512`. Without this, Claude Code grep could hang or produce partial garbage.
   Asserts: command completes without waiting forever, output matches rg-only output, no semantic lines leak in after timeout.
   Pseudocode:
   ```ts
   setup temp repo with .mnemex/
   mock indexer.search to never resolve
   expected = run real rg
   start timer
   actual = run CLI ["rg", "--no-heading", "--color=never", "needle", tempDir]
   expect(elapsedMs).toBeLessThan(3000)
   expect(actual.stdout).toBe(expected.stdout)
   expect(actual.exitCode).toBe(expected.exitCode)
   ```

6. Test: `"handleRgPassthrough returns exit code 1 when neither rg nor mnemex find matches"`
   Why: Exit semantics matter for tool callers; this is implemented in `src/cli.ts:7556-7559` but not tested end-to-end.
   Asserts: empty stdout and exit code 1.
   Pseudocode:
   ```ts
   setup temp repo with .mnemex/
   ensure rg finds nothing
   ensure mnemex returns []
   actual = run CLI ["rg", "--no-heading", "--color=never", "definitely_missing", tempDir]
   expect(actual.stdout).toBe("")
   expect(actual.exitCode).toBe(1)
   ```

7. Test: `"handleRgPassthrough preserves exact files-with-matches format with semantic-first ordering"`
   Why: Claude Code uses `--files-with-matches`; this mode has its own merge logic in `src/rg/merger.ts:94-132` and must emit plain file paths only.
   Asserts: output is newline-delimited file paths only, semantic files first, deduped, no `:line:` segments.
   Pseudocode:
   ```ts
   setup temp repo with .mnemex/
   rg finds: src/b.ts, src/c.ts
   mnemex returns chunks from src/a.ts and src/b.ts
   run CLI ["rg", "--files-with-matches", "--no-heading", "--color=never", "query", tempDir]
   expect(stdout).toBe("src/a.ts\nsrc/b.ts\nsrc/c.ts\n")
   expect(stdout).not.toContain(":1:")
   ```

## Missing Real-Scenario Tests
1. Test: `"Claude Code content-mode flag bundle produces rg-compatible output"`
   Why: The parser exists specifically to survive Claude Code’s actual Grep invocations, but no test uses the real bundle from the task description. This is the biggest gap.
   Asserts: exact compatibility for `--line-number --no-heading --color=never -i -A/-B/-C --glob --type`.
   Pseudocode:
   ```ts
   setup temp repo with ts/js/non-ts files and context lines around matches
   args = [
     "--line-number",
     "--no-heading",
     "--color=never",
     "-i",
     "-C", "1",
     "--glob", "*.ts",
     "--type", "ts",
     "handlesearch",
     tempDir
   ]

   expected = run real rg(args)
   actual = run CLI(["rg", ...args]) with .mnemex absent
   expect(actual.stdout).toBe(expected.stdout)
   expect(actual.exitCode).toBe(expected.exitCode)
   ```

2. Test: `"Claude Code files-with-matches flag bundle stays parseable by Grep tool"`
   Why: The Grep tool expects exact path-only output for this mode. Any semantic line formatting leak breaks the caller.
   Asserts: every non-empty line is a path to an existing file; exact expected order when semantic hits are present.
   Pseudocode:
   ```ts
   setup temp repo with .mnemex/
   run CLI [
     "rg",
     "--files-with-matches",
     "--no-heading",
     "--color=never",
     "--glob", "*.ts",
     "--type", "ts",
     "query",
     tempDir
   ]
   for each line in stdout.trim().split("\n"):
     expect(line).not.toMatch(/:\d+:/)
     expect(existsSync(join(tempDir, line))).toBe(true)
   ```

3. Test: `"context separator handling remains rg-compatible after merge"`
   Why: `mergeContentMode` appends non-parseable raw lines at the end in `src/rg/merger.ts:204-210`, which is suspicious for `-A/-B/-C`. Real rg interleaves separators and context; the current unit test only checks that `--` still exists somewhere, not that structure remains parseable.
   Asserts: merged output preserves valid rg grouping semantics, especially separator placement.
   Pseudocode:
   ```ts
   setup repo where rg emits:
     file1:10:match
     file1-11-context
     --
     file2:20:match
   add mnemex semantic result for file3
   run CLI with "-C", "1"
   assert stdout matches expected exact sequence:
     semantic hits first as file:line:content
     then untouched rg block with separators/context in original order
   // If current implementation moves "--" to the end, this test should fail.
   ```

4. Test: `"real rg binary path from @vscode/ripgrep is used successfully"`
   Why: This wrapper’s contract depends on the bundled rg in `src/cli.ts:7457-7464,7483-7487`. A smoke test should verify the binary is actually invokable in test env.
   Asserts: the CLI can execute the bundled binary and produce expected stdout on fixture files.
   Pseudocode:
   ```ts
   import { rgPath } from "@vscode/ripgrep"
   expect(existsSync(rgPath)).toBe(true)
   run binary directly against fixture
   expect(stdout).toContain("expected match")
   ```

5. Test: `"install/uninstall round-trip produces usable Claude Code integration"`
   Why: `patchClaudeSettings` is covered, but not the real install flow in `src/rg/install.ts:36-91`. Missing are wrapper creation, executable bit, and uninstall safety.
   Asserts: wrapper file contents, mode 755, settings patched, uninstall removes wrapper only if it contains mnemex.
   Pseudocode:
   ```ts
   redirect HOME to temp dir
   run handleRgInstall()
   expect(tempHome/.local/bin/rg contents).toBe('#!/bin/sh\nexec mnemex rg "$@"\n')
   expect(file mode executable).toBe(true)
   expect(settings.env.USE_BUILTIN_RIPGREP).toBe("0")

   run handleRgUninstall()
   expect(wrapper missing)
   expect(settings.env.USE_BUILTIN_RIPGREP).toBeUndefined()
   ```

6. Test: `"semantic duplicate with literal rg hit is emitted once in full flow"`
   Why: Dedup is unit-tested in merger, but not through the real CLI with rg + mnemex running together.
   Asserts: same `file:line` hit found by both backends appears once.
   Pseudocode:
   ```ts
   setup temp repo with .mnemex/
   file contains literal regex match
   mnemex returns same filePath/startLine/content
   run CLI ["rg", "--line-number", "--no-heading", "--color=never", "needle", tempDir]
   expect(count lines equal to "file.ts:7:needle text")).toBe(1)
   ```

7. Test: `"spawnRg injects --line-number only when absent"`
   Why: Claude Code often passes `--line-number`, but if not, merger depends on `ensureLineNumbers` via `src/cli.ts:7460-7463`. This deserves an integration-level assertion with the real binary.
   Asserts: output from wrapper includes line numbers even when caller omitted them; does not double-prefix when already present.
   Pseudocode:
   ```ts
   setup temp repo, .mnemex present, mock mnemex search to []
   actual1 = run CLI ["rg", "--no-heading", "--color=never", "needle", tempDir]
   expect(actual1.stdout).toMatch(/^.+:\d+:.+$/m)

   actual2 = run CLI ["rg", "--line-number", "--no-heading", "--color=never", "needle", tempDir]
   expect(actual2.stdout).toBe(actual1.stdout)
   ```

Overall assessment: the current suite is dominated by parser/merger micro-tests and misses the contract that matters: exact rg compatibility in the real Claude Code call path. The highest-priority additions are end-to-end stdout/exit-code comparisons against the actual `@vscode/ripgrep` binary across fallback, timeout, files-with-matches, and Claude-style flag bundles.

```vote
VERDICT: REJECT
CONFIDENCE: 9
SUMMARY: The current tests over-index on trivial unit behavior and do not validate the real rg-wrapper contract, especially exact output compatibility and fallback behavior in the full CLI flow.
KEY_ISSUES: Missing end-to-end tests for handleRgPassthrough, no exact-output comparisons against real rg, no timeout/failure fallback coverage, several trivial/duplicative tests
```
