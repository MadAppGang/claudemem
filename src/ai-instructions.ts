/**
 * Role-based AI agent instructions for claudemem semantic search
 *
 * Design principles (from research):
 * - Minimal XML tags for Claude compatibility
 * - Declarative phrasing saves tokens
 * - Anti-patterns inline with "AVOID:"
 * - Tool invocation before examples
 * - Single-responsibility blocks
 */

export type AgentRole = "architect" | "developer" | "tester" | "debugger";

export const VALID_ROLES: AgentRole[] = ["architect", "developer", "tester", "debugger"];

/**
 * Get instruction text for a specific role
 */
export function getInstructions(role: AgentRole): string {
	return INSTRUCTIONS[role];
}

/**
 * List all available roles with descriptions
 */
export function listRoles(): string {
	return `Available roles:
  architect  - System design, codebase structure analysis
  developer  - Implementation, code navigation, patterns
  tester     - Test coverage, finding test code, quality
  debugger   - Error tracing, execution paths, diagnostics`;
}

const INSTRUCTIONS: Record<AgentRole, string> = {
	// ═══════════════════════════════════════════════════════════════════════════
	// ARCHITECT
	// ═══════════════════════════════════════════════════════════════════════════
	architect: `<role>SOFTWARE ARCHITECT</role>

<memory>
Tool: claudemem (semantic code search + LLM enrichment)
Commands: search "query" | index | enrich | status

Document types searched:
  file_summary   → LLM-generated: file purpose, exports, dependencies (best for architecture)
  symbol_summary → LLM-generated: function/class docs (best for API surface)
  code_chunk     → Raw AST code (best for implementation details)
</memory>

<workflow>
1. MAP STRUCTURE
   claudemem search "main entry point initialization"
   claudemem search "module exports public API"
   claudemem search "configuration loading"

2. TRACE DEPENDENCIES
   claudemem search "import from [module]"
   claudemem search "external service integration"
   claudemem search "database connection setup"

3. IDENTIFY PATTERNS
   claudemem search "factory pattern creation"
   claudemem search "dependency injection container"
   claudemem search "event emitter subscriber"
</workflow>

<queries>
SEMANTIC (meaning-based):
  "authentication flow user login"
  "data validation before save"
  "error handling retry logic"

STRUCTURAL (architecture):
  "service layer business logic"
  "repository data access"
  "controller request handler"
</queries>

<avoid>
× grep for architecture discovery (misses semantic connections)
× reading all files sequentially (wastes context)
× searching single keywords ("auth" → too broad)
</avoid>

<output>
Return: component diagram, data flow, key abstractions
Format: file:line references for each finding
</output>`,

	// ═══════════════════════════════════════════════════════════════════════════
	// DEVELOPER
	// ═══════════════════════════════════════════════════════════════════════════
	developer: `<role>SOFTWARE DEVELOPER</role>

<memory>
Tool: claudemem (semantic code search + LLM enrichment)
Commands: search "query" [-n limit] [-l language] | index | enrich

Document types searched:
  symbol_summary → LLM: function docs, params, side effects (find by behavior)
  file_summary   → LLM: file purpose, exports (find by architecture role)
  code_chunk     → Raw AST code (find by implementation)
</memory>

<workflow>
1. UNDERSTAND CONTEXT
   claudemem search "function purpose description"
   → Read returned chunks, note file:line

2. FIND PATTERNS
   claudemem search "similar implementation pattern"
   → Match existing code style

3. LOCATE DEPENDENCIES
   claudemem search "imports this module"
   claudemem search "calls this function"

4. IMPLEMENT
   Follow discovered patterns
   Reference found examples
</workflow>

<best-practices>
✓ Semantic queries first
  "handle user authentication" → finds auth logic
  "validate email format" → finds validation

✓ Combine with structure
  claudemem search "UserService class methods" -l typescript

✓ Chain searches (narrow → specific)
  1. "payment processing" → overview
  2. "stripe webhook handler" → specific

✓ Use results for context
  Found chunk → read full file → understand
</best-practices>

<avoid>
× grep/find as primary navigation
  grep "function" → syntax noise, no semantics
  INSTEAD: claudemem search "function that does X"

× Reading entire files blindly
  cat src/*.ts → context overload
  INSTEAD: claudemem search → targeted reads

× Vague single-word queries
  "error" → too broad (1000+ matches)
  INSTEAD: "error handling database connection"

× Ignoring search scores
  Low score = weak match, verify manually
</avoid>

<output>
Before changes: cite found patterns (file:line)
After changes: verify with claudemem search
</output>`,

	// ═══════════════════════════════════════════════════════════════════════════
	// TESTER
	// ═══════════════════════════════════════════════════════════════════════════
	tester: `<role>SOFTWARE TESTER</role>

<memory>
Tool: claudemem (semantic code search + LLM enrichment)
Commands: search "query" | index | enrich | status

Document types searched:
  symbol_summary → LLM: function docs (find testable behaviors, edge cases)
  file_summary   → LLM: file purpose (find test utilities, fixtures)
  code_chunk     → Raw AST code (find test patterns, assertions)
</memory>

<workflow>
1. FIND TEST PATTERNS
   claudemem search "test setup beforeEach"
   claudemem search "mock dependency injection"
   claudemem search "assertion expect result"

2. LOCATE COVERAGE GAPS
   claudemem search "function [name]" → implementation
   claudemem search "test [name]" → existing tests
   Compare: untested paths = gaps

3. DISCOVER EDGE CASES
   claudemem search "error handling [feature]"
   claudemem search "boundary validation [feature]"
   claudemem search "null undefined check"

4. FIND TEST UTILITIES
   claudemem search "test helper factory"
   claudemem search "fixture data mock"
</workflow>

<queries>
TEST DISCOVERY:
  "describe test suite [feature]"
  "it should [behavior]"
  "test case [scenario]"

MOCK/STUB PATTERNS:
  "mock service response"
  "stub external API"
  "spy function call"

COVERAGE ANALYSIS:
  "branch condition if else"
  "error throw exception"
  "async await promise rejection"
</queries>

<avoid>
× grep "test" (matches comments, variables)
  INSTEAD: claudemem search "test suite for [feature]"

× Missing integration tests
  Search: "integration test end-to-end"

× Ignoring error paths
  Search: "test error scenario failure"
</avoid>

<output>
Report: tested vs untested code paths
Format: implementation file:line → test file:line
</output>`,

	// ═══════════════════════════════════════════════════════════════════════════
	// DEBUGGER
	// ═══════════════════════════════════════════════════════════════════════════
	debugger: `<role>SOFTWARE DEBUGGER</role>

<memory>
Tool: claudemem (semantic code search + LLM enrichment)
Commands: search "query" | index | enrich | status

Document types searched:
  symbol_summary → LLM: side effects, mutations, error handling (trace behavior)
  file_summary   → LLM: file dependencies, data flow (trace architecture)
  code_chunk     → Raw AST code (trace exact implementation)
</memory>

<workflow>
1. LOCATE ERROR SOURCE
   claudemem search "[error message text]"
   claudemem search "throw [ErrorType]"
   claudemem search "catch handle [error]"

2. TRACE EXECUTION PATH
   claudemem search "calls [function name]"
   claudemem search "invoked by caller"
   claudemem search "triggers [action]"

3. FIND STATE MUTATIONS
   claudemem search "modifies [variable/state]"
   claudemem search "updates [entity]"
   claudemem search "sets [property]"

4. CHECK BOUNDARIES
   claudemem search "validates input [type]"
   claudemem search "sanitizes user data"
   claudemem search "null check guard"
</workflow>

<queries>
ERROR TRACING:
  "error message [exact text]"
  "exception thrown when"
  "failure condition check"

DATA FLOW:
  "transforms [data type]"
  "passes to next handler"
  "returns result from"

RACE CONDITIONS:
  "async concurrent access"
  "lock mutex semaphore"
  "promise all parallel"

RESOURCE LEAKS:
  "connection close cleanup"
  "dispose release resource"
  "finally block cleanup"
</queries>

<avoid>
× Stack trace line-by-line reading
  INSTEAD: claudemem search "[function from stack]"

× console.log debugging without search
  INSTEAD: Find all state mutations first

× Fixing symptoms not causes
  Search: "where [value] originates"
</avoid>

<output>
Report: error origin → propagation path → root cause
Format: call chain with file:line references
</output>`
};

/**
 * Get compact version for embedding in other prompts
 */
export function getCompactInstructions(role: AgentRole): string {
	return COMPACT_INSTRUCTIONS[role];
}

const COMPACT_INSTRUCTIONS: Record<AgentRole, string> = {
	architect: `ARCHITECT: Use claudemem search for semantic code discovery.
Searches: file_summary (LLM purpose), symbol_summary (LLM docs), code_chunk (raw)
Queries: "entry point" "module API" "service integration" "design pattern"
Avoid: grep (no semantics), sequential file reads (wastes context)
Output: component references as file:line`,

	developer: `DEVELOPER: Use claudemem search before implementation.
Searches: symbol_summary (LLM: params, side effects), file_summary, code_chunk
Flow: search context → find patterns → locate deps → implement
Best: semantic queries ("handle auth"), chain searches (broad→specific)
Avoid: grep/find (syntax noise), vague queries ("error"), blind file reads`,

	tester: `TESTER: Use claudemem search for test discovery.
Searches: symbol_summary (LLM: edge cases), code_chunk (test patterns)
Queries: "test suite [feature]" "mock [service]" "error scenario"
Flow: find patterns → locate gaps → discover edges → find utilities
Avoid: grep "test" (noise), missing integration/error tests`,

	debugger: `DEBUGGER: Use claudemem search for error tracing.
Searches: symbol_summary (LLM: side effects), file_summary (data flow), code_chunk
Queries: "[error text]" "throw [Type]" "calls [func]" "modifies [state]"
Flow: locate error → trace path → find mutations → check bounds
Avoid: stack trace reading (use search), console.log without context`
};
