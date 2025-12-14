# claudemem Agent Instructions

> Semantic code search and structural analysis for AI coding agents.
> This document describes the optimal way to use claudemem for codebase understanding.

## Quick Reference

```bash
# Always run with --nologo for clean output
claudemem --nologo <command>

# Core commands for agents
claudemem map [query]              # Get structural overview (repo map)
claudemem symbol <name>            # Find symbol definition
claudemem callers <name>           # What calls this symbol?
claudemem callees <name>           # What does this symbol call?
claudemem context <name>           # Full context (symbol + dependencies)
claudemem search <query>           # Semantic search with --raw for parsing
claudemem search <query> --map     # Search + include repo map context
```

## Output Format

All commands support `--raw` flag for machine-readable output:

```
# Raw output format (line-based, easy to parse)
file: src/core/indexer.ts
line: 45-120
kind: class
name: Indexer
signature: class Indexer
pagerank: 0.0842
exported: true
---
file: src/core/store.ts
line: 12-89
kind: class
name: VectorStore
...
```

Records are separated by `---`. Each field is `key: value` on its own line.

---

## The Correct Workflow

### Phase 1: Understand Structure First (ALWAYS DO THIS)

Before reading any code files, get the structural overview:

```bash
# For a specific task, get focused repo map
claudemem --nologo map "authentication flow" --raw

# Output shows relevant symbols ranked by importance (PageRank):
# file: src/auth/AuthService.ts
# line: 15-89
# kind: class
# name: AuthService
# pagerank: 0.0921
# signature: class AuthService
# ---
# file: src/middleware/auth.ts
# ...
```

This tells you:
- Which files contain relevant code
- Which symbols are most important (high PageRank = heavily used)
- The structure before you read actual code

### Phase 2: Locate Specific Symbols

Once you know what to look for:

```bash
# Find exact location of a symbol
claudemem --nologo symbol AuthService --raw

# Output:
# file: src/auth/AuthService.ts
# line: 15-89
# kind: class
# name: AuthService
# signature: class AuthService implements IAuthProvider
# exported: true
# pagerank: 0.0921
# docstring: Handles user authentication and session management
```

### Phase 3: Understand Dependencies

Before modifying code, understand what depends on it:

```bash
# What calls AuthService? (impact of changes)
claudemem --nologo callers AuthService --raw

# Output:
# caller: LoginController.authenticate
# file: src/controllers/login.ts
# line: 34
# kind: call
# ---
# caller: SessionMiddleware.validate
# file: src/middleware/session.ts
# line: 12
# kind: call
```

```bash
# What does AuthService call? (its dependencies)
claudemem --nologo callees AuthService --raw

# Output:
# callee: Database.query
# file: src/db/database.ts
# line: 45
# kind: call
# ---
# callee: TokenManager.generate
# file: src/auth/tokens.ts
# line: 23
# kind: call
```

### Phase 4: Get Full Context

For complex modifications, get everything at once:

```bash
claudemem --nologo context AuthService --raw

# Output includes:
# [symbol]
# file: src/auth/AuthService.ts
# line: 15-89
# kind: class
# name: AuthService
# ...
# [callers]
# caller: LoginController.authenticate
# ...
# [callees]
# callee: Database.query
# ...
```

### Phase 5: Search for Code

When you need actual code snippets:

```bash
# Semantic search
claudemem --nologo search "password hashing" --raw

# Search with repo map context (recommended for complex tasks)
claudemem --nologo search "password hashing" --map --raw
```

---

## Scenarios

### Scenario 1: Bug Fix

**Task**: "Fix the null pointer exception in user authentication"

```bash
# Step 1: Get overview of auth-related code
claudemem --nologo map "authentication null pointer" --raw

# Step 2: Locate the specific symbol mentioned in error
claudemem --nologo symbol authenticate --raw

# Step 3: Check what calls it (to understand how it's used)
claudemem --nologo callers authenticate --raw

# Step 4: Read the actual code at the identified location
# Now you know exactly which file:line to read
```

### Scenario 2: Add New Feature

**Task**: "Add rate limiting to the API endpoints"

```bash
# Step 1: Understand API structure
claudemem --nologo map "API endpoints rate" --raw

# Step 2: Find the main API handler
claudemem --nologo symbol APIController --raw

# Step 3: See what the API controller depends on
claudemem --nologo callees APIController --raw

# Step 4: Check if rate limiting already exists somewhere
claudemem --nologo search "rate limit" --raw

# Step 5: Get full context for the modification point
claudemem --nologo context APIController --raw
```

### Scenario 3: Refactoring

**Task**: "Rename DatabaseConnection to DatabasePool"

```bash
# Step 1: Find the symbol
claudemem --nologo symbol DatabaseConnection --raw

# Step 2: Find ALL callers (these all need updating)
claudemem --nologo callers DatabaseConnection --raw

# Step 3: The output shows every file:line that references it
# Update each location systematically
```

### Scenario 4: Understanding Unfamiliar Codebase

**Task**: "How does the indexing pipeline work?"

```bash
# Step 1: Get high-level structure
claudemem --nologo map "indexing pipeline" --raw

# Step 2: Find the main entry point (highest PageRank)
claudemem --nologo symbol Indexer --raw

# Step 3: Trace the flow - what does Indexer call?
claudemem --nologo callees Indexer --raw

# Step 4: For each major callee, get its callees
claudemem --nologo callees VectorStore --raw
claudemem --nologo callees FileTracker --raw

# Now you have the full pipeline traced
```

---

## Anti-Patterns (DO NOT DO THESE)

### Anti-Pattern 1: Blind File Reading

```bash
# BAD: Reading files without knowing what's in them
cat src/core/*.ts | head -1000

# GOOD: First understand structure, then read specific locations
claudemem --nologo map "your task" --raw
# Then read only the relevant file:line ranges
```

**Why it's bad**: Wastes tokens on irrelevant code, misses important files in other directories.

### Anti-Pattern 2: Grep Without Context

```bash
# BAD: Grep returns matches without understanding relationships
grep -r "Database" src/

# GOOD: Use symbol lookup for precise results
claudemem --nologo symbol Database --raw
claudemem --nologo callers Database --raw
```

**Why it's bad**: Grep returns string matches, not semantic understanding. You get noise (comments, strings, unrelated matches) instead of the actual symbol definitions and their relationships.

### Anti-Pattern 3: Modifying Without Impact Analysis

```bash
# BAD: Change a function without knowing what uses it
# Edit src/auth/tokens.ts and hope nothing breaks

# GOOD: Check callers BEFORE modifying
claudemem --nologo callers generateToken --raw
# Now you know exactly what will be affected
```

**Why it's bad**: Changes may break callers. You won't know until tests fail (or worse, production breaks).

### Anti-Pattern 4: Searching Before Mapping

```bash
# BAD: Search immediately without structural context
claudemem search "fix the bug" --raw

# GOOD: Get structure first, then search
claudemem --nologo map "the specific feature" --raw
claudemem --nologo search "specific query" --raw
```

**Why it's bad**: Search results lack context. You don't know if a result is a core abstraction or an unused utility.

### Anti-Pattern 5: Ignoring PageRank

```bash
# BAD: Treat all symbols equally
# Read every file that matches "Database"

# GOOD: Focus on high-PageRank symbols first
claudemem --nologo map "database" --raw
# PageRank 0.09 = core abstraction, understand this first
# PageRank 0.001 = utility helper, read later if needed
```

**Why it's bad**: Low-PageRank symbols are often utilities that don't help you understand the architecture. High-PageRank symbols are the core abstractions that everything else depends on.

### Anti-Pattern 6: Not Using --nologo

```bash
# BAD: Parse output that includes ASCII art
claudemem search "query"

# GOOD: Always use --nologo for machine-readable output
claudemem --nologo search "query" --raw
```

**Why it's bad**: Logo and decorations make parsing unreliable.

---

## Command Reference

### claudemem map [query]

Get structural overview of the codebase. Optionally focused on a query.

```bash
# Full repo map (top symbols by PageRank)
claudemem --nologo map --raw

# Focused on specific task
claudemem --nologo map "authentication" --raw

# Limit tokens
claudemem --nologo map "auth" --tokens 500 --raw
```

**Output fields**: file, line, kind, name, signature, pagerank, exported

### claudemem symbol <name>

Find a symbol by name. Disambiguates using PageRank and export status.

```bash
claudemem --nologo symbol Indexer --raw
claudemem --nologo symbol "search" --file retriever --raw  # hint which file
```

**Output fields**: file, line, kind, name, signature, pagerank, exported, docstring

### claudemem callers <name>

Find all symbols that call/reference the given symbol.

```bash
claudemem --nologo callers AuthService --raw
```

**Output fields**: caller (name), file, line, kind (call/import/extends/etc)

### claudemem callees <name>

Find all symbols that the given symbol calls/references.

```bash
claudemem --nologo callees AuthService --raw
```

**Output fields**: callee (name), file, line, kind

### claudemem context <name>

Get full context: the symbol plus its callers and callees.

```bash
claudemem --nologo context Indexer --raw
claudemem --nologo context Indexer --callers 10 --callees 20 --raw
```

**Output sections**: [symbol], [callers], [callees]

### claudemem search <query>

Semantic search across the codebase.

```bash
claudemem --nologo search "error handling" --raw
claudemem --nologo search "error handling" --map --raw  # include repo map
claudemem --nologo search "auth" -n 5 --raw  # limit results
```

**Output fields**: file, line, kind, name, score, content (truncated)

---

## Token Efficiency Guide

| Action | Token Cost | When to Use |
|--------|------------|-------------|
| `map` (focused) | ~500 | Always first - understand structure |
| `symbol` | ~50 | When you know the name |
| `callers` | ~100-500 | Before modifying anything |
| `callees` | ~100-500 | To understand dependencies |
| `context` | ~200-800 | For complex modifications |
| `search` | ~1000-3000 | When you need actual code |
| `search --map` | ~1500-4000 | For unfamiliar codebases |

**Optimal order**: map → symbol → callers/callees → search (only if needed)

---

## Integration Pattern

For maximum efficiency, follow this pattern:

```
1. RECEIVE TASK
   ↓
2. claudemem map "<task keywords>" --raw
   → Understand structure, identify key symbols
   ↓
3. claudemem symbol <high-pagerank-symbol> --raw
   → Get exact location
   ↓
4. claudemem callers <symbol> --raw  (if modifying)
   → Know the impact radius
   ↓
5. claudemem callees <symbol> --raw  (if needed)
   → Understand dependencies
   ↓
6. READ specific file:line ranges (not whole files)
   ↓
7. MAKE CHANGES with full awareness
   ↓
8. CHECK callers still work
```

This pattern typically uses 80% fewer tokens than blind exploration.
