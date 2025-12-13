/**
 * Comprehensive AI Agent Skill for claudemem
 *
 * Token-efficient instruction format based on:
 * - Anthropic context engineering research
 * - XML tags for Claude compatibility
 * - Declarative phrasing
 * - Inline anti-patterns with alternatives
 */

import { getInstructions, getCompactInstructions, type AgentRole, VALID_ROLES } from "./ai-instructions.js";

/**
 * Full agentic skill document for claudemem
 * Designed for embedding in CLAUDE.md or system prompts
 */
export const CLAUDEMEM_SKILL = `<skill name="claudemem" version="0.1">
<purpose>
Semantic code search using vector embeddings.
Finds code by MEANING, not just text matching.
Use INSTEAD of grep/find for: architecture discovery, pattern matching, understanding codebases.
</purpose>

<capabilities>
INDEXING: Parse code → chunk by AST (functions/classes/methods) → embed → store in LanceDB
SEARCH: Natural language → vector similarity + BM25 keyword → ranked results with file:line
AUTO-INDEX: Changed files re-indexed automatically before search
</capabilities>

<tools>
CLI:
  claudemem index [path] [-f]      # Index codebase (force with -f)
  claudemem search "query" [-n N]  # Search (auto-indexes changes)
  claudemem status                 # Show index info
  claudemem clear                  # Remove index
  claudemem ai <role>              # Get role instructions

MCP (Claude Code integration):
  search_code        query, limit?, language?, autoIndex?
  index_codebase     path?, force?, model?
  get_status         path?
  clear_index        path?
  list_embedding_models  freeOnly?
</tools>

<search-patterns>
SEMANTIC (find by meaning):
  "authentication flow user login"
  "data validation before save"
  "error handling with retry"
  "convert request to response"

STRUCTURAL (find by architecture):
  "service layer business logic"
  "repository pattern data access"
  "factory creation pattern"
  "dependency injection setup"

FUNCTIONAL (find by purpose):
  "parse JSON configuration"
  "send HTTP request"
  "handle database connection"
  "validate user input"

KEYWORD-ENHANCED (specific terms):
  "stripe webhook payment"
  "JWT token authentication"
  "redis cache invalidation"
  "graphql resolver mutation"
</search-patterns>

<workflow>
1. CHECK STATUS
   claudemem status
   → Verify index exists, see file/chunk counts

2. SEARCH SEMANTICALLY
   claudemem search "what you're looking for"
   → Returns: file:line, score, code snippet

3. READ FULL CONTEXT
   After search → read returned file:line for full understanding

4. CHAIN SEARCHES (narrow down)
   Broad: claudemem search "authentication"
   Specific: claudemem search "JWT token validation middleware"
</workflow>

<result-format>
Each result contains:
  filePath:startLine-endLine    # Location
  chunkType: function|class|method|module|block
  name: functionName            # If extractable
  parentName: ClassName         # For methods
  score: 85% (vector: 80%, keyword: 90%)
  content: [code snippet]
</result-format>

<supported-languages>
TypeScript (.ts, .tsx), JavaScript (.js, .jsx)
Python (.py), Go (.go), Rust (.rs)
C (.c, .h), C++ (.cpp, .hpp), Java (.java)
</supported-languages>

<best-practices>
✓ Use natural language queries (not regex)
✓ Include context: "error handling IN payment flow"
✓ Chain searches: broad → specific
✓ Trust high scores (>70%), verify low scores
✓ Combine with file reads: search → read → understand
✓ Re-index after major changes: claudemem index -f
</best-practices>

<avoid>
× grep/find for semantic discovery
  grep "auth" → 500 matches, no ranking
  INSTEAD: claudemem search "authentication flow"

× Single-word queries
  "error" → too broad
  INSTEAD: "error handling database connection"

× Reading all files sequentially
  cat src/**/*.ts → context overload
  INSTEAD: claudemem search → targeted reads

× Ignoring search scores
  Low score (<50%) = weak semantic match
  INSTEAD: Verify manually or refine query

× Skipping auto-index
  Files changed but not searching fresh data
  INSTEAD: Let auto-index run (default: on)
</avoid>

<configuration>
Project: .claudemem/config.json
  model: "qwen/qwen3-embedding-8b"
  excludePatterns: ["*.test.ts", "dist/**"]
  includeExtensions: [".ts", ".tsx"]

Global: ~/.claudemem/config.json
  openrouterApiKey: "sk-or-..."
  embeddingProvider: "openrouter" | "ollama" | "voyage"
  defaultModel: "..."

Environment:
  OPENROUTER_API_KEY    # API key
  CLAUDEMEM_MODEL       # Override model
</configuration>

<providers>
OpenRouter (cloud, default):
  Models: qwen3-embedding-8b (recommended), text-embedding-3-small
  Cost: ~$0.01/1M tokens

Ollama (local, free):
  Models: nomic-embed-text, mxbai-embed-large
  Requires: ollama pull nomic-embed-text

Voyage AI (specialized):
  Models: voyage-code-3 (best for code)
  Cost: ~$0.06/1M tokens
</providers>
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
SEMANTIC CODE SEARCH via embeddings. Use INSTEAD of grep for meaning-based discovery.

COMMANDS:
  claudemem search "query"   # Natural language → ranked results (file:line, score)
  claudemem index [-f]       # Index codebase (auto-runs before search)
  claudemem status           # Check index
  claudemem ai <role>        # Role instructions (architect|developer|tester|debugger)

QUERY PATTERNS:
  "authentication flow login" (semantic)
  "stripe webhook handler" (keyword-enhanced)
  "service layer business logic" (structural)

BEST: Natural language, chain broad→specific, trust high scores (>70%)
AVOID: grep (no semantics), single words ("error"), reading all files
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
 */
export const CLAUDEMEM_MCP_SKILL = `<mcp-skill name="claudemem">
TOOLS AVAILABLE:
  search_code(query, limit?, language?)     # Semantic search, returns file:line + code
  index_codebase(path?, force?)             # Index project (usually auto-runs)
  get_status(path?)                         # Check index exists
  clear_index(path?)                        # Reset index
  list_embedding_models(freeOnly?)          # See available models

USAGE PATTERN:
  1. search_code("authentication middleware") → get results
  2. Read returned file:line for full context
  3. Chain: search_code("jwt validation") for specifics

WHEN TO USE:
  ✓ Finding code by purpose/meaning
  ✓ Architecture discovery
  ✓ Understanding unfamiliar codebase
  ✓ Locating patterns across files

WHEN NOT TO USE:
  × Exact string search (use grep)
  × Known file path (use read)
  × Simple filename search (use glob)
</mcp-skill>`;

/**
 * Quick reference card (minimal tokens)
 */
export const CLAUDEMEM_QUICK_REF = `claudemem: semantic code search
  search "query"  → file:line results
  index -f        → rebuild index
  ai <role>       → architect|developer|tester|debugger
Use for: meaning-based discovery, architecture, patterns
Avoid: grep (no semantics), single-word queries`;
