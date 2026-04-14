# mnemex + OpenCode Integration Guide

Integrate mnemex with [OpenCode](https://opencode.ai/) to replace grep/glob/list with intelligent semantic search.

## Table of Contents

- [Overview](#overview)
- [Quick Start](#quick-start)
- [Plugin Installation](#plugin-installation)
- [How It Works](#how-it-works)
- [Configuration Options](#configuration-options)
- [Custom Tools](#custom-tools)
- [Troubleshooting](#troubleshooting)

---

## Overview

[OpenCode](https://github.com/sst/opencode) is an open-source AI coding agent for the terminal. Like Claude Code, it has a plugin system with hooks that can intercept tool executions.

**The integration works by:**
1. Intercepting `grep`, `glob`, `list`, and `read` tool calls via `tool.execute.before` hook
2. Suggesting mnemex alternatives for semantic queries
3. Optionally replacing tools entirely with mnemex commands

```
┌─────────────────────────────────────────────────────────────────┐
│                    OPENCODE + MNEMEX                          │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  User Query: "Find authentication code"                         │
│                              ↓                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                   OPENCODE                                 │  │
│  │  LLM decides to use: grep tool                            │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              ↓                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │              tool.execute.before HOOK                      │  │
│  │  Intercepts grep → Suggests: mnemex search "auth"       │  │
│  └───────────────────────────────────────────────────────────┘  │
│                              ↓                                   │
│  ┌───────────────────────────────────────────────────────────┐  │
│  │                   MNEMEX                                │  │
│  │  Semantic search → Ranked results with PageRank           │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Step 1: Install mnemex

```bash
npm install -g mnemex
```

### Step 2: Index Your Project

```bash
cd /path/to/your/project
mnemex init    # First-time setup
mnemex index   # Index codebase
```

### Step 3: Install the Plugin

```bash
# Create plugin directory
mkdir -p .opencode/plugin

# Download the plugin
curl -o .opencode/plugin/mnemex.ts \
  https://raw.githubusercontent.com/MadAppGang/mnemex/main/integrations/opencode/mnemex.ts
```

Or create it manually (see [Plugin Installation](#plugin-installation)).

### Step 4: Configure OpenCode

Add to your `opencode.json`:

```json
{
  "plugin": [
    "file://.opencode/plugin/mnemex.ts"
  ]
}
```

---

## Plugin Installation

### Option 1: Minimal Plugin (Suggestion Only)

This version suggests mnemex alternatives without blocking the original tool:

Create `.opencode/plugin/mnemex.ts`:

```typescript
/**
 * mnemex Integration Plugin for OpenCode
 *
 * Intercepts grep/glob/list tools and suggests mnemex alternatives
 * for semantic code search.
 */

import type { Plugin } from "opencode"

export const ClaudemumPlugin: Plugin = async (ctx) => {
  const { $ } = ctx

  // Check if mnemex is available
  let mnemexAvailable = false
  try {
    const result = await $`which mnemex`
    mnemexAvailable = result.exitCode === 0
  } catch {
    mnemexAvailable = false
  }

  return {
    "tool.execute.before": async (input, output) => {
      if (!mnemexAvailable) return

      const tool = input.tool
      const args = output.args

      // Intercept grep with semantic queries
      if (tool === "grep" && args.pattern) {
        const pattern = args.pattern

        // Detect semantic queries (not regex patterns)
        const isSemanticQuery = !pattern.match(/[\[\]\(\)\|\*\+\?\{\}\\^$]/)

        if (isSemanticQuery) {
          console.log(`\n💡 Tip: For semantic search, try:`)
          console.log(`   mnemex --nologo search "${pattern}" --raw\n`)
        }
      }

      // Intercept glob for broad file searches
      if (tool === "glob" && args.pattern) {
        const pattern = args.pattern

        // Detect broad patterns like **/*.ts
        if (pattern.includes("**")) {
          console.log(`\n💡 Tip: For structural overview, try:`)
          console.log(`   mnemex --nologo map --raw\n`)
        }
      }

      // Intercept list for directory exploration
      if (tool === "list") {
        console.log(`\n💡 Tip: For codebase structure, try:`)
        console.log(`   mnemex --nologo map --raw\n`)
      }
    },
  }
}
```

### Option 2: Full Replacement Plugin

This version replaces grep/glob with mnemex when appropriate:

Create `.opencode/plugin/mnemex-replace.ts`:

```typescript
/**
 * mnemex Full Replacement Plugin for OpenCode
 *
 * Replaces grep/glob with mnemex for semantic queries.
 * Falls back to original tools for regex patterns.
 */

import type { Plugin } from "opencode"

interface ClaudemumResult {
  file: string
  line: string
  kind: string
  name: string
  score?: number
  content?: string
}

export const ClaudemumReplacePlugin: Plugin = async (ctx) => {
  const { $ } = ctx

  // Check if mnemex is available and indexed
  let mnemexReady = false
  try {
    const result = await $`mnemex status 2>/dev/null`
    mnemexReady = result.exitCode === 0
  } catch {
    mnemexReady = false
  }

  // Helper to parse mnemex --raw output
  const parseClaudemumOutput = (output: string): ClaudemumResult[] => {
    const results: ClaudemumResult[] = []
    const records = output.split("---")

    for (const record of records) {
      const lines = record.trim().split("\n")
      const result: Partial<ClaudemumResult> = {}

      for (const line of lines) {
        const [key, ...valueParts] = line.split(": ")
        const value = valueParts.join(": ").trim()
        if (key && value) {
          result[key as keyof ClaudemumResult] = value
        }
      }

      if (result.file) {
        results.push(result as ClaudemumResult)
      }
    }

    return results
  }

  return {
    "tool.execute.before": async (input, output) => {
      if (!mnemexReady) return

      const tool = input.tool
      const args = output.args

      // Replace grep with mnemex search for semantic queries
      if (tool === "grep" && args.pattern) {
        const pattern = args.pattern

        // Detect if this is a semantic query (not a regex)
        const isRegex = /[\[\]\(\)\|\*\+\?\{\}\\^$]/.test(pattern)

        if (!isRegex) {
          try {
            const result = await $`mnemex --nologo search ${pattern} --raw -n 10`

            if (result.exitCode === 0 && result.stdout.trim()) {
              const matches = parseClaudemumOutput(result.stdout)

              // Format as grep-like output
              const formatted = matches.map(m =>
                `${m.file}:${m.line}: ${m.name} (${m.kind})`
              ).join("\n")

              // Return the result, preventing original grep execution
              output.result = formatted
              output.skip = true

              console.log(`\n🔍 mnemex semantic search: ${matches.length} results\n`)
            }
          } catch (e) {
            // Fall back to original grep on error
            console.log(`\n⚠️ mnemex failed, using grep\n`)
          }
        }
      }

      // Replace glob with mnemex map for broad searches
      if (tool === "glob" && args.pattern) {
        const pattern = args.pattern

        // Only intercept very broad patterns
        if (pattern === "**/*" || pattern === "**/*.ts" || pattern === "**/*.js") {
          try {
            const result = await $`mnemex --nologo map --raw --tokens 2000`

            if (result.exitCode === 0 && result.stdout.trim()) {
              output.result = result.stdout
              output.skip = true

              console.log(`\n📊 mnemex map: structural overview\n`)
            }
          } catch {
            // Fall back to original glob
          }
        }
      }
    },
  }
}
```

### Option 3: Custom Tools Plugin

Add mnemex as custom tools alongside built-in tools:

Create `.opencode/plugin/mnemex-tools.ts`:

```typescript
/**
 * mnemex Custom Tools Plugin for OpenCode
 *
 * Adds mnemex commands as first-class tools.
 */

import type { Plugin } from "opencode"
import { tool } from "opencode"

export const ClaudemumToolsPlugin: Plugin = async (ctx) => {
  const { $ } = ctx

  return {
    tool: {
      // Semantic code search
      mnemex_search: tool({
        description: "Semantic code search using natural language. Better than grep for understanding code meaning.",
        args: {
          query: tool.schema.string().describe("Natural language search query"),
          limit: tool.schema.number().optional().describe("Max results (default: 10)"),
        },
        async execute({ query, limit = 10 }) {
          const result = await $`mnemex --nologo search ${query} --raw -n ${limit}`
          return result.stdout || "No results found"
        },
      }),

      // Repository structure map
      mnemex_map: tool({
        description: "Get structural overview of codebase with PageRank-ranked symbols. Use before diving into code.",
        args: {
          query: tool.schema.string().optional().describe("Focus area (optional)"),
          tokens: tool.schema.number().optional().describe("Max tokens (default: 2000)"),
        },
        async execute({ query, tokens = 2000 }) {
          const cmd = query
            ? $`mnemex --nologo map ${query} --raw --tokens ${tokens}`
            : $`mnemex --nologo map --raw --tokens ${tokens}`
          const result = await cmd
          return result.stdout || "No symbols found"
        },
      }),

      // Find symbol definition
      mnemex_symbol: tool({
        description: "Find exact location of a symbol (function, class, etc.) by name.",
        args: {
          name: tool.schema.string().describe("Symbol name to find"),
        },
        async execute({ name }) {
          const result = await $`mnemex --nologo symbol ${name} --raw`
          return result.stdout || `Symbol '${name}' not found`
        },
      }),

      // Find callers (impact analysis)
      mnemex_callers: tool({
        description: "Find all code that calls/uses a symbol. Essential before modifying any code.",
        args: {
          name: tool.schema.string().describe("Symbol name"),
        },
        async execute({ name }) {
          const result = await $`mnemex --nologo callers ${name} --raw`
          return result.stdout || `No callers found for '${name}'`
        },
      }),

      // Find callees (dependencies)
      mnemex_callees: tool({
        description: "Find all symbols that a function/class calls. Traces data flow and dependencies.",
        args: {
          name: tool.schema.string().describe("Symbol name"),
        },
        async execute({ name }) {
          const result = await $`mnemex --nologo callees ${name} --raw`
          return result.stdout || `No callees found for '${name}'`
        },
      }),

      // Full context
      mnemex_context: tool({
        description: "Get full context: symbol definition + callers + callees. Use for complex modifications.",
        args: {
          name: tool.schema.string().describe("Symbol name"),
        },
        async execute({ name }) {
          const result = await $`mnemex --nologo context ${name} --raw`
          return result.stdout || `Context not found for '${name}'`
        },
      }),
    },
  }
}
```

---

## How It Works

### Hook Types Used

| Hook | Purpose |
|------|---------|
| `tool.execute.before` | Intercept grep/glob/list before execution |
| `tool.execute.after` | (Optional) Post-process results |

### Tools Intercepted

| OpenCode Tool | mnemex Alternative | When to Replace |
|---------------|----------------------|-----------------|
| `grep` | `mnemex search` | Semantic/natural language queries |
| `glob` | `mnemex map` | Broad file pattern searches |
| `list` | `mnemex map` | Directory structure exploration |
| `read` | (No replacement) | Use after mnemex locates files |

### Decision Logic

```
grep "authentication flow"
  → Is it a regex? (has special chars like [, ], |, *, etc.)
    → YES: Use original grep
    → NO: Use mnemex search (semantic)

glob "**/*.ts"
  → Is it a broad pattern?
    → YES: Suggest mnemex map
    → NO: Use original glob
```

---

## Configuration Options

### opencode.json

```json
{
  "plugin": [
    "file://.opencode/plugin/mnemex.ts"
  ],
  "tools": {
    "mnemex_search": true,
    "mnemex_map": true,
    "mnemex_symbol": true,
    "mnemex_callers": true,
    "mnemex_callees": true,
    "mnemex_context": true
  }
}
```

### Environment Variables

```bash
# Required for mnemex
export OPENROUTER_API_KEY="your-key"

# Optional: Override default model
export MNEMEX_MODEL="voyage/voyage-code-3"
```

---

## Custom Tools

When using the custom tools plugin, OpenCode's LLM can directly call:

| Tool | Example |
|------|---------|
| `mnemex_search` | "Find error handling code" |
| `mnemex_map` | "Show me the codebase structure" |
| `mnemex_symbol` | "Find the UserService class" |
| `mnemex_callers` | "What calls processPayment?" |
| `mnemex_callees` | "What does AuthService depend on?" |
| `mnemex_context` | "Full context for DatabasePool" |

### Benefits Over Built-in Tools

| Built-in Tool | Limitation | mnemex Advantage |
|---------------|------------|---------------------|
| grep | String matching only | Semantic understanding |
| glob | Returns all matches | PageRank-ranked results |
| list | Flat directory listing | Symbol graph with importance |
| read | Reads whole files | Targeted file:line locations |

---

## Troubleshooting

### "mnemex: command not found"

```bash
# Install globally
npm install -g mnemex

# Verify
which mnemex
mnemex --version
```

### "No index found"

```bash
# Index your project
mnemex init
mnemex index
mnemex status
```

### Plugin not loading

```bash
# Check plugin syntax
bun check .opencode/plugin/mnemex.ts

# Verify opencode.json
cat opencode.json | jq '.plugin'
```

### Hook not firing

The `tool.execute.before` hook only fires when the LLM actually uses the tool. If you're not seeing interception:

1. Ensure the plugin is loaded (check OpenCode logs)
2. Verify mnemex is installed and indexed
3. Check that the query triggers grep/glob (not another tool)

---

## Comparison: Claude Code vs OpenCode

| Feature | Claude Code | OpenCode |
|---------|-------------|----------|
| Hook system | PreToolUse/PostToolUse | tool.execute.before/after |
| Plugin location | `.claude/plugins/` | `.opencode/plugin/` |
| Config format | `plugin.json` | `opencode.json` |
| Tool interception | Block + return message | Set `output.skip = true` |
| Custom tools | MCP servers | `tool` export in plugin |

The integration pattern is nearly identical - both use pre-execution hooks to intercept and optionally replace tool behavior.

---

## Sources

- [OpenCode Official Site](https://opencode.ai/)
- [OpenCode GitHub](https://github.com/sst/opencode)
- [OpenCode Plugins Documentation](https://opencode.ai/docs/plugins/)
- [OpenCode Tools Documentation](https://opencode.ai/docs/tools/)
- [OpenCode Config Documentation](https://opencode.ai/docs/config/)
- [Plugin Development Guide](https://gist.github.com/rstacruz/946d02757525c9a0f49b25e316fbe715)

---

**Maintained by:** MadAppGang
**Last Updated:** December 2025
