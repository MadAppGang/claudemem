## Your Role
You are acting as a **Testing specialist focused on test strategy**.
Evaluate the task below through this lens.

---

## Team Vote: Independent Review Request

You are a team member evaluating the following task independently.
Provide YOUR OWN assessment based solely on the evidence.

### Task

Investigate the test file `tests/rg.test.ts` for the mnemex `rg` module — a drop-in ripgrep replacement that augments rg with mnemex semantic search, designed to work as Claude Code's Grep tool backend.

Your job is to produce a CONCRETE ACTION PLAN:

1. **Identify tests that test nothing** — tests that are trivially true, test obvious behavior, or provide zero bug-catching value. List them by name with reasoning for each.

2. **Identify missing e2e/integration tests** — the module is meant to work in Claude Code's environment where:
   - Claude Code calls `rg` with specific flags (`--line-number`, `--files-with-matches`, `--glob`, `--type`, `-A`, `-B`, `-C`, `-i`, `--no-heading`, `--color=never`)
   - The wrapper must produce EXACTLY rg-compatible output
   - Real rg runs in parallel with mnemex semantic search
   - Results are merged with mnemex-ranked results first
   - Falls back to rg-only when mnemex fails/times out/no index

3. **Propose specific e2e test scenarios** that would catch real-world failures:
   - Test with actual rg binary (from `@vscode/ripgrep`) against real files
   - Test the full `handleRgPassthrough` flow (spawn rg + search mnemex + merge)
   - Test that output is parseable by Claude Code's Grep tool (exact format)
   - Test fallback when `.mnemex/` dir doesn't exist
   - Test timeout behavior
   - Test with the actual flag combinations Claude Code uses

4. **For each proposed test**: provide the test name, description, and pseudocode showing what it should assert.

### Files to read
- `tests/rg.test.ts` (current 59 tests)
- `src/rg/parser.ts`, `src/rg/merger.ts`, `src/rg/install.ts` (modules under test)
- `src/cli.ts` (search for `handleRgPassthrough`, `spawnRg`, `searchMnemex`, `execRgDirect`, `ensureLineNumbers`)

### Output format

Structure your response as:

```
## Tests to Remove (test nothing)
1. "test name" — reason
2. ...

## Missing E2E Tests (concrete proposals)
1. Test: "name"
   Why: explanation
   Asserts: what it checks
   Pseudocode: ...

2. ...

## Missing Real-Scenario Tests
1. ...
```

### Required Vote Format

You MUST end your response with a vote block:

```vote
VERDICT: [APPROVE|REJECT|ABSTAIN]
CONFIDENCE: [1-10]
SUMMARY: [One sentence explaining your vote]
KEY_ISSUES: [Comma-separated list, or "None"]
```

### Voting Guidelines

- **APPROVE**: Current tests + your proposed additions would provide adequate coverage
- **REJECT**: Current tests are fundamentally wrong in approach and need rewriting
- **ABSTAIN**: Cannot determine

Be decisive.
