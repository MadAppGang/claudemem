## Your Role
You are acting as a **Research analyst and code reviewer**.
Evaluate the task below through this lens.

---

## Team Vote: Independent Review Request

You are a team member evaluating the following task independently.
Provide YOUR OWN assessment based solely on the evidence.

### Task
Review the test file `tests/rg.test.ts` for the mnemex `rg` module (a drop-in ripgrep replacement that augments rg with mnemex semantic search).

Determine:
1. Do these tests actually test the FEATURES and BEHAVIOR of the rg module, or do they just satisfy the implementation details?
2. Are the test cases comprehensive enough to catch real bugs?
3. Are edge cases properly handled?
4. Do the tests validate the actual value proposition (semantic search augmentation on top of rg)?
5. Are there missing test scenarios that should exist?

The implementation consists of:
- `src/rg/parser.ts` — parses ripgrep CLI arguments (pattern, path, output mode, flags)
- `src/rg/merger.ts` — merges rg output with mnemex SearchResult[] into rg-compatible format
- `src/rg/install.ts` — install/uninstall commands for Claude Code integration
- Integration in `src/cli.ts` — `handleRgPassthrough()` runs real rg + mnemex search in parallel

Read these files to perform your review:
- `tests/rg.test.ts` (the tests under review)
- `src/rg/parser.ts` (the parser being tested)
- `src/rg/merger.ts` (the merger being tested)
- `src/rg/install.ts` (the installer — check if it has tests)
- `src/cli.ts` (search for `handleRgPassthrough` to understand the integration)

Focus on whether the tests validate BEHAVIOR (what the user/system cares about) vs IMPLEMENTATION (internal details that could change).

### Required Vote Format

You MUST end your response with a vote block:

```vote
VERDICT: [APPROVE|REJECT|ABSTAIN]
CONFIDENCE: [1-10]
SUMMARY: [One sentence explaining your vote]
KEY_ISSUES: [Comma-separated list, or "None"]
```

### Voting Guidelines

- **APPROVE**: Tests adequately cover the features and edge cases, testing behavior over implementation
- **REJECT**: Tests are insufficient — they miss critical scenarios, test implementation not behavior, or give false confidence
- **ABSTAIN**: Cannot make determination (missing context, ambiguous requirements)

Be decisive. Abstain only when truly unable to evaluate.
