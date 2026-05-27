## Review: `tests/rg.test.ts`

### What the tests cover

The test suite has 26 tests total across four describe blocks:
- **parseRgArgs**: 14 tests covering flag parsing (positional, `-e`, `--regexp`, `-l`, `-c`, combined shorts, `--`, `--glob=`, etc.)
- **mergeResults — content mode**: 7 tests covering empty output, rg-only, mnemex-only, deduplication, ordering, pattern filtering, and line deduplication
- **mergeResults — files-with-matches mode**: 6 tests covering empty, rg-only, ordering, deduplication, trailing newline
- **mergeResults — count mode**: 2 tests covering passthrough behavior

---

### Critical Gaps

**1. `install.ts` has zero test coverage.** This is a filesystem-modifying module that writes scripts to `~/.local/bin/` and patches `~/.claude/settings.json`. The safety check in `handleRgUninstall` that verifies `content.includes("mnemex")` before deleting is entirely untested. Corrupting the settings file is also untested.

**2. Exit codes are never validated.** `handleRgPassthrough` (the actual user-facing behavior) exits 1 when no results, 0 when results exist. No tests cover exit code behavior for any merge scenario. This is arguably the single most important behavior of a CLI tool.

**3. rg stderr / error handling is invisible to the merger layer.** When `spawnRg` rejects (exit code ≠ 0/1), the code silently falls back to empty string. When `searchMnemex` rejects (2000ms timeout or index error), it silently returns `[]`. No tests verify these degradation behaviors — particularly important because the 2-second mnemex timeout is a silent fallback path that users will hit under load.

**4. `passthroughArgs` is returned but never checked.** The `parseRgArgs` tests verify `pattern`, `searchPath`, and `mode` for every case, but `passthroughArgs` (the complete original args array) is returned at line 217 and used nowhere in tests. If the passthrough args get malformed, tests won't catch it.

**5. `nonMatchLines` in `mergeContentMode` is untested.** The merger preserves unparseable rg lines (context separators, non-standard output). There's no test that passes in raw rg output containing such lines and verifies they're preserved.

**6. Pattern filtering edge cases missing:**
   - `--count-matches` mode (supported in parser at line 122, but not tested)
   - Invalid regex in mnemex chunk content (the `matchesPattern` catch fallback at merger:57)
   - `-A0` (value attached form for context flag)
   - Multiple `-e` flags (only one pattern captured)
   - Negative pattern with `-v` flag interaction

**7. Integration-level behavior is entirely absent.** The end-to-end flow — running `spawnRg` + `searchMnemex` in parallel, merging stdout, setting exit codes — has no tests. The 2-second mnemex timeout is invisible at the test layer.

---

### Assessment: Behavior vs. Implementation

The tests lean toward **testing implementation details over user-visible behavior**. They verify:
- Parser extracts correct `pattern`/`searchPath`/`mode` values
- Merger produces correct line-level transformations

But they don't verify:
- Exit codes (CLI correctness)
- Error degradation paths (reliability)
- rg/mnemex failure scenarios (resilience)
- Integration with the actual spawn/merge/exit pipeline

The `install.ts` gap is particularly glaring — a file that writes shell scripts and mutates JSON config is completely untested.

---

```vote
VERDICT: REJECT
CONFIDENCE: 8
SUMMARY: The test suite has solid coverage of unit-level flag parsing and line-merging logic but misses critical behavioral assertions (exit codes, error fallbacks, rg stderr handling), leaves the high-risk install/uninstall module completely untested, and provides no integration-level validation of the actual user-facing rg augmentation pipeline.
KEY_ISSUES: install.ts zero coverage; no exit code tests; silent error fallback paths untested; passthroughArgs validated by no test; nonMatchLines preservation untested; --count-matches mode untested; invalid regex fallback untested; no end-to-end integration tests
```
