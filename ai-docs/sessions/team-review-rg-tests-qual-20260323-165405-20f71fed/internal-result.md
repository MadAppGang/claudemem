# Code Review: tests/rg.test.ts

**Reviewer**: Research Analyst / Code Reviewer
**Date**: 2026-03-23
**Scope**: Test quality assessment for the mnemex `rg` module

---

## Summary Judgment

The tests are **mostly behavior-oriented and structurally sound**, but they have **meaningful coverage gaps** in both `parser.ts` and `merger.ts`, and the integration layer (`handleRgPassthrough`) and installer (`install.ts`) are entirely untested. The missing scenarios are not edge cases — some are on the critical happy path.

---

## 1. Behavior vs. Implementation

### parser tests — Mostly behavioral

The parser tests test the *contract* of `parseRgArgs`: given a raw `argv` slice, what pattern, path, and mode come out? This is the right level of abstraction. The tests do not reach into the internal data structures (`positionals` array, `endOfFlags` flag, etc.), so they would survive a full internal rewrite as long as the output contract is preserved. Good.

**Specific observations:**

- The tests cover the three modes (content, files-with-matches, count), `-e`/`--regexp` flag overrides, combined short flags (`-il`, `-in`), value-consuming flags (`-A`, `--glob`), `--glob=value` equals-form, and the `--` separator. These are the real user-visible behaviors.
- The test "combined boolean flags -in: pattern extracted, mode stays content" verifies that the parser does not incorrectly interpret `n` as consuming the next arg.
- `passthroughArgs` is **never tested**. The parser always returns `args` unchanged as `passthroughArgs`, which is the raw input forwarded to real `rg`. An accidental mutation here would corrupt downstream rg invocations. This is a behavioral omission.

### merger tests — Behavioral but incomplete

The merger tests verify deduplication, ordering (mnemex first), pattern filtering, multi-line chunk handling, and count passthrough. These validate the value proposition — the correct output format that callers (Claude Code's Grep tool) depend on.

**Specific observations:**

- Content mode: basic cases, rg-only, mnemex-only, dedup across rg+mnemex, ordering, multi-line filtering, intra-mnemex dedup. Good coverage.
- files-with-matches: ordering, dedup (rg+mnemex overlap, intra-mnemex), output termination with `\n`. Good.
- count mode: passthrough and empty. Adequate — count mode is intentionally trivial.

---

## 2. Coverage Gaps

### 2a. Parser — Missing scenarios

| Missing Scenario | Risk |
|---|---|
| `passthroughArgs` is never inspected in any test | Silent mutation would break rg forwarding |
| `-B` (before-context) consumes a value — not tested | If logic broke, pattern could be swallowed |
| `--type`/`-t` value flag — not tested | Pattern could be lost |
| `-e` used twice (`-e foo -e bar`) | `pattern = pattern ?? args[i]` means first wins; this is not tested or documented |
| Pattern that is a valid regex with special chars (`.`, `*`) | `matchesPattern` in merger uses regex; parser just captures the string, but no test touches this path |
| No args at all (`[]`) | Expected: pattern=undefined, mode=content, path='.'; not tested |
| Mode flag after `--` separator | e.g. `-- -l` — should `-l` set files mode? No, because `endOfFlags=true`. Not tested |
| `--count-matches` (an alias for `--count`) | Exists in parser code (`arg === "--count" || arg === "--count-matches"`), never tested |

### 2b. Merger — Missing scenarios

| Missing Scenario | Risk |
|---|---|
| Chunk content with leading/trailing whitespace | `lineContent` is the raw split line; if rg trims and mnemex does not, dedup fails |
| Invalid regex pattern passed to `matchesPattern` | Code falls back to literal match; never exercised in tests |
| rg output with context separator lines (`--`) | The `nonMatchLines` bucket collects these and appends them at the end; this behavior is not tested |
| rg output without `-n` (no line numbers) | `parseRgLine` returns null for lines without colons; they end up in `nonMatchLines`. Not tested. |
| Multi-file rg output ordering | rg output interleaves files; is final ordering stable? Not tested |
| Very high-score mnemex result whose chunk does NOT match the pattern | `matchesPattern` would exclude it; no test for this |
| Unicode/emoji in content or pattern | Not tested |

### 2c. install.ts — Zero coverage

`handleRgInstall` and `handleRgUninstall` have no tests at all. The behaviors worth testing without requiring a real filesystem:
- `patchClaudeSettings(true)` when settings.json does not exist (creates it)
- `patchClaudeSettings(true)` when it already has `USE_BUILTIN_RIPGREP=0` (no-op)
- `patchClaudeSettings(false)` removes the key and removes `env` when it becomes empty
- Uninstall safety guard: file exists but does not contain "mnemex" — must NOT delete

These are non-trivial logic branches that are entirely dark. The uninstall safety check in particular is the kind of thing that should be tested.

### 2d. handleRgPassthrough — Zero integration coverage

The integration function encodes important behavioral decisions that are not exercised by unit tests:

- When `.mnemex/` is absent, falls through to `execRgDirect` (no augmentation). No test.
- When `mode === "count"` or `pattern` is undefined, falls through to `execRgDirect`. No test.
- Parallel execution: if mnemex search fails/times out, graceful fallback to rg-only. No test.
- Exit code semantics: exits 1 when merged output is empty (standard rg behavior). No test.
- `spawnRg` auto-injects `--line-number` when not present. No test for this contract.

This is the **core value proposition** of the entire module and it has no test coverage at all. A regression here (e.g., the fallback logic silently failing, or `--line-number` injection breaking format) would not be caught.

---

## 3. Edge Cases Properly Handled?

The tests do address several meaningful edge cases:

- `--` separator for pattern-with-leading-dash (e.g., `-pattern-with-dash`): tested.
- No pattern returns `undefined`: tested.
- `--glob=value` equals form: tested.
- Overlapping rg and mnemex results at the same `file:line`: tested (deduplication).
- Two mnemex results covering the same line: tested.
- Multi-line chunks where only some lines match: tested.

But these gaps are notable edge cases:

- Pattern appears in the middle of a large combined flag string (e.g., `-ine` — would `e` be treated as boolean? The code would not detect it as a value-consuming flag because it checks `arg === "-e"` exactly. Untested).
- The `--count-matches` alias is tested in the implementation but not in the tests.
- rg output line that looks like `file:not-a-number:content` (second colon token not an integer) — `parseRgLine` returns null and it lands in `nonMatchLines`. Not tested.

---

## 4. Do Tests Validate the Value Proposition?

The value proposition of the rg module is: **augment ripgrep with semantic search, surface semantically relevant code that literal regex would miss, while remaining a transparent drop-in for rg.**

The tests validate roughly half of this:

- They confirm mnemex results appear before rg results (ranking).
- They confirm rg-compatible output format (`file:line:content`).
- They confirm deduplication (no double results).
- They confirm pattern filtering of mnemex chunks (non-matching lines excluded).

What they do NOT validate:

- That the augmentation actually fires when a `.mnemex/` index exists (integration untested).
- That the wrapper is a true drop-in (exit codes, passthrough of raw rg args, no mangling of output format under real conditions).
- That semantic-only results (things rg would miss) actually appear in the output.
- That the 2-second timeout fallback works correctly.

---

## 5. False Confidence Risk

The test suite passes without touching the integration path at all. A developer could:

- Break `spawnRg`'s `--line-number` injection (so the merger never deduplicates because line numbers are missing) — not caught.
- Break the `.mnemex/` existence check (so augmentation never fires) — not caught.
- Break `patchClaudeSettings` idempotency (double-writes `USE_BUILTIN_RIPGREP`) — not caught.

These are real-world regression paths. The unit tests for parser and merger provide good confidence in those two pure functions, but they give *no* confidence about the system as assembled.

---

## Recommended Additions (Priority Order)

1. **Integration test for `handleRgPassthrough`** — at minimum: (a) no `.mnemex/` dir bypasses augmentation, (b) `--count` mode bypasses augmentation, (c) mnemex timeout fallback still returns rg output.
2. **Test `passthroughArgs`** in parser — verify `args` is returned unchanged.
3. **Test `--count-matches` alias** in parser.
4. **Test `patchClaudeSettings` logic** in install — especially the safety guard and idempotency.
5. **Test `nonMatchLines` passthrough** in merger — rg context separators and non-numbered lines.
6. **Test `matchesPattern` invalid-regex fallback** — explicitly exercise the `catch` branch.
7. **Test empty args `[]`** in parser.

---

## Final Assessment

The unit tests for `parser.ts` and `merger.ts` are well-structured, behavior-focused, and catch a good set of real bugs. They are not implementation-coupling tests. However, the coverage has meaningful gaps in the pure units, and the integration layer plus installer are completely dark. Given that the integration layer encodes the most critical behavioral decisions (bypass logic, parallel execution, exit codes), the overall test suite provides **incomplete behavioral coverage** despite being well-written where it exists.

---

```vote
VERDICT: REJECT
CONFIDENCE: 8
SUMMARY: The unit tests for parser and merger are behavior-oriented and well-structured, but the integration layer (handleRgPassthrough) and installer (install.ts) have zero coverage, passthroughArgs is never validated, and several real regression paths (--line-number injection, bypass logic, timeout fallback, exit codes) are entirely dark.
KEY_ISSUES: No integration tests for handleRgPassthrough, install.ts completely untested, passthroughArgs never asserted, --count-matches alias untested, nonMatchLines passthrough untested, matchesPattern invalid-regex fallback untested
```
