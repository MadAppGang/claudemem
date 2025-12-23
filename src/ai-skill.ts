/**
 * Comprehensive AI Agent Skill for claudemem
 *
 * Symbol graph commands:
 * - map: structural overview with PageRank ranking
 * - symbol: find symbol definitions
 * - callers/callees: dependency tracking
 * - context: full symbol context
 *
 * Code analysis commands (v0.3.0):
 * - dead-code: find unused symbols (zero callers + low PageRank)
 * - test-gaps: find untested high-PageRank symbols
 * - impact: analyze change blast radius (transitive callers)
 *
 * Developer experience:
 * - watch: auto-reindex on file changes
 * - hooks: git post-commit hook for auto-indexing
 *
 * Core principle: STRUCTURE FIRST, then targeted reads
 */

import { getInstructions, getCompactInstructions, type AgentRole, VALID_ROLES } from "./ai-instructions.js";

/**
 * Full agentic skill document for claudemem
 * Designed for embedding in CLAUDE.md or system prompts
 */
export const CLAUDEMEM_SKILL = `<skill name="claudemem" version="0.3">
<purpose>
Code intelligence via symbol graph + semantic search + code analysis.
Provides STRUCTURE FIRST understanding before reading code.

Primary use: Navigate code by SYMBOLS and DEPENDENCIES, not text.
Use INSTEAD of grep/find for: architecture discovery, impact analysis, dependency tracing.
</purpose>

<capabilities>
SYMBOL GRAPH:
  Extract symbols (functions, classes, types) from AST
  Track cross-file references (calls, imports, type usage)
  Compute PageRank = symbol importance score
  Generate token-budgeted repo maps

CODE ANALYSIS:
  Dead code detection (zero callers + low PageRank)
  Test gap analysis (high PageRank without test callers)
  Impact analysis (transitive callers across files)

SEMANTIC SEARCH:
  Natural language → vector similarity + BM25
  Searches raw code AND LLM-enriched summaries
  Use AFTER structure is understood (not first step!)

INDEXING:
  Parse code → AST chunking → embed → vector store
  Auto-reindex on file changes before search/map
  Watch mode for continuous re-indexing
  Git hooks for post-commit indexing
</capabilities>

<tools>
SYMBOL GRAPH COMMANDS (primary - always use --nologo --raw):
  claudemem map [query]       # Repo structure, symbols ranked by PageRank
  claudemem symbol <name>     # Find symbol definition (file:line, signature)
  claudemem callers <name>    # What depends on this symbol
  claudemem callees <name>    # What this symbol depends on
  claudemem context <name>    # Full context: symbol + callers + callees

CODE ANALYSIS COMMANDS:
  claudemem dead-code         # Find unused: zero callers + low PageRank
  claudemem test-gaps         # Find untested: high PageRank + no test callers
  claudemem impact <name>     # Transitive callers across all files

SEARCH (secondary - after structure understood):
  claudemem search "query"    # Semantic search, returns file:line + code
  claudemem search "q" --map  # Search + include repo map context

INDEX/STATUS:
  claudemem index [path] [-f] # Index codebase (force with -f)
  claudemem status            # Show index info
  claudemem clear             # Remove index
  claudemem watch             # Auto-reindex on file changes (daemon)
  claudemem hooks install     # Git post-commit hook for auto-indexing

AI INSTRUCTIONS:
  claudemem ai <role>         # Role instructions (architect|developer|tester|debugger)
</tools>

<output-format>
Raw output (--raw flag) for reliable parsing:

file: src/core/indexer.ts
line: 75-758
kind: class
name: Indexer
signature: export class Indexer
pagerank: 0.0842
exported: true
---
file: src/core/store.ts
line: 12-89
kind: class
name: VectorStore
...

Records separated by "---". Each field: "key: value" on own line.
</output-format>

<workflow>
1. MAP STRUCTURE (always start here)
   claudemem --nologo map "task keywords" --raw
   → See relevant symbols ranked by PageRank
   → High PageRank (>0.05) = heavily used, understand first
   → Low PageRank (<0.01) = utilities, defer

2. LOCATE SYMBOL
   claudemem --nologo symbol TargetClass --raw
   → Get exact file:line, signature, export status
   → Only read what you found, not entire files

3. CHECK IMPACT (before modifying!)
   claudemem --nologo callers TargetClass --raw
   → Direct callers that will break if you change interface
   claudemem impact TargetClass --raw
   → ALL transitive callers (full blast radius)

4. UNDERSTAND DEPENDENCIES
   claudemem --nologo callees TargetClass --raw
   → What this code can use
   → Available utilities and interfaces

5. GET FULL CONTEXT (complex changes)
   claudemem --nologo context TargetClass --raw
   → Symbol + all callers + all callees at once

6. CODE ANALYSIS (when relevant)
   claudemem dead-code --raw       → Find unused code
   claudemem test-gaps --raw       → Find untested code

7. SEARCH (when needed)
   claudemem --nologo search "specific query" --raw
   → Use for natural language discovery
   → After structure is understood
</workflow>

<pagerank-guide>
PageRank indicates symbol importance in the codebase:

HIGH (>0.05):
  Core abstractions everyone depends on
  Understand these FIRST - changes have wide impact
  Examples: main entry points, core services, key interfaces

MEDIUM (0.01-0.05):
  Feature implementations, business logic
  Important for specific functionality
  Moderate impact radius

LOW (<0.01):
  Utilities, helpers, leaf nodes
  Safe to read later, low impact
  Often implementation details
</pagerank-guide>

<best-practices>
✓ STRUCTURE FIRST: map → symbol → callers → then read code
✓ Check PageRank before reading files (high = important)
✓ Check callers BEFORE modifying anything
✓ Use exact file:line from symbol output (not whole files)
✓ Trace full caller chain before complex changes
✓ Use --nologo --raw for all agent commands
</best-practices>

<avoid>
× grep for code discovery
  grep "auth" → 500 matches, no ranking, no relationships
  INSTEAD: claudemem map "authentication" --raw

× Reading entire files
  cat src/auth.ts → 80% irrelevant, token waste
  INSTEAD: claudemem symbol → read exact line range

× Modifying without checking callers
  Change signature → break unknown callers
  INSTEAD: claudemem callers <symbol> BEFORE changes

× Ignoring PageRank
  Low PageRank = probably utility, not core
  INSTEAD: Focus on high PageRank symbols first

× Starting with search
  Search returns snippets, not structure
  INSTEAD: map → understand → then search if needed

× Not using --raw for parsing
  Decorated output breaks parsing
  INSTEAD: Always use --nologo --raw
</avoid>

<scenarios>
BUG FIX:
  1. claudemem map "error keywords" --raw
  2. claudemem symbol FunctionFromStackTrace --raw
  3. claudemem callers FunctionFromStackTrace --raw
  4. claudemem impact BuggyFunction --raw (assess scope)
  5. Read identified file:line ranges
  6. Fix bug, verify callers still work

NEW FEATURE:
  1. claudemem map "feature area" --raw
  2. claudemem callees ExistingFeature --raw (see patterns)
  3. claudemem context ModificationPoint --raw
  4. Implement following existing patterns
  5. claudemem test-gaps --raw (check coverage)

REFACTORING:
  1. claudemem symbol SymbolToRename --raw
  2. claudemem impact SymbolToRename --raw (full scope)
  3. Update all caller locations from output
  4. Verify each file:line updated

UNDERSTANDING CODEBASE:
  1. claudemem map --raw (overall structure)
  2. Identify top 5 by PageRank
  3. claudemem context <top-symbol> --raw for each
  4. Trace flow via callees

CLEANUP (new!):
  1. claudemem dead-code --raw (find unused)
  2. Review each symbol for dynamic usage
  3. Remove confirmed dead code

TEST PLANNING (new!):
  1. claudemem test-gaps --raw (prioritized list)
  2. Focus on high PageRank symbols
  3. claudemem impact <symbol> --raw for test scope
</scenarios>

<supported-languages>
TypeScript (.ts, .tsx), JavaScript (.js, .jsx)
Python (.py), Go (.go), Rust (.rs)
C (.c, .h), C++ (.cpp, .hpp), Java (.java)
</supported-languages>
</skill>`;

/**
 * Role-specific skill extensions
 */
export function getFullSkillWithRole(role: AgentRole): string {
	const roleInstructions = getInstructions(role);
	return `${CLAUDEMEM_SKILL}

<role-extension>
${roleInstructions}
</role-extension>`;
}

/**
 * Compact skill for tight context budgets
 */
export const CLAUDEMEM_SKILL_COMPACT = `<skill name="claudemem">
CODE INTELLIGENCE via symbol graph + semantic search + code analysis.
STRUCTURE FIRST: map → symbol → callers → then read code.

SYMBOL GRAPH (primary - use --nologo --raw):
  claudemem map [query]       # Repo structure, PageRank ranking
  claudemem symbol <name>     # Find definition (file:line)
  claudemem callers <name>    # What depends on this (BEFORE modifying!)
  claudemem callees <name>    # What this depends on
  claudemem context <name>    # Full context at once

CODE ANALYSIS:
  claudemem dead-code         # Find unused (zero callers + low PageRank)
  claudemem test-gaps         # Find untested (high PageRank + no test callers)
  claudemem impact <name>     # ALL transitive callers (blast radius)

SEARCH (after structure understood):
  claudemem search "query"    # Semantic search → file:line results

PAGERANK = importance:
  High (>0.05) = core abstractions, read first
  Low (<0.01) = utilities, defer

WORKFLOW: map → identify high PageRank → symbol → impact analysis → implement
AVOID: grep (no ranking), reading whole files, modifying without impact check
</skill>`;

/**
 * Get compact skill with role
 */
export function getCompactSkillWithRole(role: AgentRole): string {
	const roleCompact = getCompactInstructions(role);
	return `${CLAUDEMEM_SKILL_COMPACT}

${roleCompact}`;
}

/**
 * MCP-specific instruction for Claude Code integration
 * Note: CLI commands preferred for agent workflows
 */
export const CLAUDEMEM_MCP_SKILL = `<mcp-skill name="claudemem">
NOTE: For AI agents, CLI commands with --nologo --raw are preferred.
MCP tools available for Claude Code integration:

TOOLS:
  search_code(query, limit?, language?)  # Semantic search
  index_codebase(path?, force?)          # Index project
  get_status(path?)                      # Check index
  clear_index(path?)                     # Reset index

PREFERRED CLI WORKFLOW:
  claudemem map "task" --raw             # Structure first
  claudemem symbol <name> --raw          # Find definition
  claudemem callers <name> --raw         # Check direct impact
  claudemem impact <name> --raw          # Full transitive impact (blast radius)
  claudemem callees <name> --raw         # Dependencies
  claudemem dead-code --raw              # Find unused code
  claudemem test-gaps --raw              # Find untested code
  claudemem search "query" --raw         # When needed

WHEN TO USE MCP:
  ✓ Quick semantic searches
  ✓ Integration with Claude Code

WHEN TO USE CLI:
  ✓ Structure discovery (map, symbol, callers, callees)
  ✓ Code analysis (dead-code, test-gaps, impact)
  ✓ Dependency tracing
  ✓ Any workflow requiring parsed output
</mcp-skill>`;

/**
 * Quick reference card (minimal tokens)
 */
export const CLAUDEMEM_QUICK_REF = `claudemem: symbol graph + semantic search + code analysis (--nologo --raw)
  map [query]      # Structure overview, PageRank ranked
  symbol <name>    # Find definition (file:line)
  callers <name>   # What depends on this (BEFORE modifying!)
  callees <name>   # What this depends on
  context <name>   # Symbol + callers + callees
  dead-code        # Find unused (zero callers + low PageRank)
  test-gaps        # Find untested (high PageRank + no test callers)
  impact <name>    # ALL transitive callers (blast radius)
  search "query"   # Semantic search (after structure understood)
WORKFLOW: map → symbol → impact → implement
AVOID: grep, whole file reads, modifying without impact check`;
