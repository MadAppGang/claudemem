I now have a complete picture. Let me compile my review.

---

## Test Review: `tests/rg.test.ts`

### Executive Summary

The test file provides **reasonable unit coverage** for the parser and merger functions but has **critical gaps** that undermine confidence in the rg module. Most significantly, the `install.ts` module has **zero tests**, and there are **no integration tests** validating the end-to-end behavior.

---

### Strengths

**Parser Tests (15 cases):**
- Good coverage of basic flag parsing (`-e`, `--regexp`, positionals)
- Output mode detection covered (`-l`, `-c`, `--files-with-matches`, `--count`)
- Combined short flags tested (`-in`, `-il`)
- Value-consuming flags tested (`-A`, `--glob`)
- Edge case for `--` separator handled

**Merger Tests (15 cases):**
- Content mode: deduplication, ordering (mnemex first), pattern filtering
- Files-with-matches mode: file-level deduplication and ordering
- Count mode passthrough correctly tested
- Output formatting verified (trailing newlines)

**Test Quality:**
Tests focus on **observable behavior** (input → output) rather than implementation internals—this is the right approach.

---

### Critical Gaps

#### 1. **Zero tests for `install.ts`**
The entire install/uninstall flow is untested:
- Wrapper script creation in `~/.local/bin/`
- `chmod 0o755` permission setting
- `~/.claude/settings.json` modification (reading, parsing, writing)
- Safety check: `"mnemex"` presence before deletion
- Directory creation with `recursive: true`
- JSON parse error handling (lines 102-109 in install.ts)
- Edge case: `env` object cleanup when empty (lines 131-134)

This is a **filesystem-modifying module with no test coverage**.

#### 2. **No integration tests for main entry points**
The functions `handleRgPassthrough`, `spawnRg`, `searchMnemex`, and `execRgDirect` have zero tests:
- Missing `.mnemex/` index → should fall back to `execRgDirect`
- Parallel execution: `Promise.allSettled([spawnRg, searchMnemex])`
- Error handling: rg exits with code >1, mnemex timeout (2-second limit)
- Real spawn behavior (`stdio: ["inherit", "pipe", "pipe"]`)

#### 3. **Parser gaps:**
| Missing Test | Code Path |
|--------------|-----------|
| `-A3` attached value | `VALUE_FLAGS.has(singleFlag) && arg.length > 2` |
| `-B`, `-C`, `-f`, `-m` flags | In `VALUE_FLAGS` but untested |
| Multiple `-e` flags | `pattern ?? args[i]` logic |
| Flags after positionals | Not tested (rg allows: `pattern -i path`) |
| Empty args array | `parseRgArgs([])` |
| `passthroughArgs` field | Never validated |

#### 4. **Merger gaps:**
| Missing Test | Risk |
|--------------|------|
| Regex patterns needing escape | `parseRgLine` would fail on malformed `file:line:content` |
| `matchesPattern` regex fallback | Invalid regex → substring fallback untested |
| `--json` mode output | Would break parser completely |
| Context lines (`-A/-B/-C`) | `nonMatchLines` path not tested |
| Malformed rg output | Lines without `file:line:` prefix |
| Windows paths (`C:\foo`) | Comment mentions this, but not tested |

#### 5. **Value proposition untested:**
The key feature—"semantic ranking" where mnemex results appear **first**—is tested structurally but not semantically:
- Tests verify ordering (`mnemexFiles[0]` appears first)
- Tests do NOT verify scoring/ranking quality
- No tests for `searchMnemex` timeout behavior
- No tests for vector/BM25 fallback paths

---

### Specific Code Paths Untested

From `cli.ts:7444-7502`:

```typescript
// spawnRg: ensures --line-number is added
const rgArgs = args.includes("-n") || args.includes("--line-number")
  ? args
  : ["--line-number", ...args];
```
**No test validates this line-number injection.**

```typescript
// spawnRg: exit code handling
if (code === 0 || code === 1) {
  resolve(Buffer.concat(chunks).toString("utf-8"));
} else {reject(new Error(...));}
```
**No test for exit code 1 (no matches) vs code 0 (matches found).**

```typescript
// searchMnemex: 2-second timeout
const timeoutPromise = new Promise<never>((_, reject) =>
  setTimeout(() => reject(new Error("mnemex search timeout")), 2000),
);
```
**No test for timeout behavior or indexer.close() finally block.

---

### Verdict

```vote
VERDICT: REJECT
CONFIDENCE: 8
SUMMARY: Tests cover parser/merger unit logic adequately but miss critical modules (install.ts), integration points (handleRgPassthrough, spawnRg, searchMnemex), and edge cases that would catch real-world failures.
KEY_ISSUES: No tests for install.ts filesystem modifications, no integration tests for rg+/mnemex parallel execution, missing tests for value-consuming flags (-B/-C/-f), missing tests for regex pattern escaping, missing tests for --json mode compatibility, missing tests for mnemex timeout/fallback behavior
```
