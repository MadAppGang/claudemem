
import type { TerminalLine } from './types';

export const HERO_SEQUENCE: TerminalLine[] = [
  { 
    id: 'cmd-1', 
    type: 'system', 
    content: 'claudemem index', 
    delay: 500 
  },
  { 
    id: 'idx-1', 
    type: 'thinking', 
    content: 'Parsing codebase (tree-sitter)...', 
    delay: 1200 
  },
  { 
    id: 'idx-3', 
    type: 'success', 
    content: '✓ Indexing complete. 12,482 symbols mapped (0.4s)', 
    delay: 2000 
  },
  { 
    id: 'cmd-2', 
    type: 'system', 
    content: 'claude', 
    delay: 3000 
  },
  { 
    id: 'welcome', 
    type: 'welcome', 
    content: 'Welcome', 
    data: {
        version: 'v2.0.76', 
        model: 'Opus 4.5'
    },
    delay: 3800 
  },
  { 
    id: 'prompt-1', 
    type: 'rich-input', 
    content: 'Find the main authentication logic', 
    delay: 4800 
  },
  { 
    id: 'tool-1', 
    type: 'tool', 
    content: 'claudemem(query="authentication logic")',
    data: {
        details: 'Searching 3 granular levels (File, Symbol, Intent)...'
    },
    delay: 6500 
  },
  { 
    id: 'res-header', 
    type: 'info', 
    content: 'Found 3 highly relevant files:', 
    delay: 7200 
  },
  { 
    id: 'res-1', 
    type: 'success', 
    content: 'src/auth/SecurityService.ts (Rank: 0.94)', 
    delay: 7400 
  },
  { 
    id: 'res-2', 
    type: 'success', 
    content: 'src/middleware/AuthGuard.ts (Rank: 0.88)', 
    delay: 7500 
  },
  { 
    id: 'summary', 
    type: 'info', 
    content: 'The core authentication logic resides in SecurityService.ts, specifically the validateToken method...', 
    delay: 8000 
  }
];

export const RESEARCH_LEVELS = [
  {
    level: "File-level",
    capture: "Path, functionality overview, key exports, dependencies",
    benefit: "Initial filtering, broad queries — achieves ~80% codebase reduction"
  },
  {
    level: "Class/Module",
    capture: "Purpose, inheritance, public interface, responsibility",
    benefit: "Architecture understanding, API discovery"
  },
  {
    level: "Function-level",
    capture: "Signature, parameters, natural language purpose, usage context",
    benefit: "Precise queries, code completion — 53% accuracy improvement in tests"
  }
];

export const COMPARISON_MATRIX = [
  { feature: "Cost", claudemem: "Free / MIT", context: "Free (needs API)", serena: "Free / MIT", brokk: "Free / GPL-3.0", graph: "Free", greptile: "$30/dev/mo", amp: "$1,000+ min" },
  { feature: "Privacy", claudemem: "100% Local", context: "Cloud default", serena: "Local", brokk: "Local", graph: "Local", greptile: "Cloud", amp: "Cloud only" },
  { feature: "CLI Tool", claudemem: "✅", context: "❌", serena: "❌", brokk: "❌", graph: "❌", greptile: "❌", amp: "❌" },
  { feature: "Claude Code Plugin", claudemem: "✅ MCP", context: "✅ MCP", serena: "✅ MCP", brokk: "❌ Desktop app", graph: "✅ MCP", greptile: "API", amp: "✅ MCP" },
  { feature: "Adaptive Learning", claudemem: "✅ EMA-based", context: "✅", serena: "❌", brokk: "❌", graph: "❌", greptile: "❌", amp: "❌" },
  { feature: "Embedding Models", claudemem: "Any (cloud/local)", context: "Fixed", serena: "N/A", brokk: "Fixed", graph: "N/A", greptile: "Fixed", amp: "Fixed" },
  { feature: "Summarizer LLM", claudemem: "Any (cloud/local)", context: "N/A", serena: "N/A", brokk: "Fixed", graph: "N/A", greptile: "Fixed", amp: "Fixed" },
  { feature: "Built-in Benchmarks", claudemem: "✅ Full suite", context: "❌", serena: "❌", brokk: "❌", graph: "❌", greptile: "❌", amp: "❌" },
  { feature: "PageRank", claudemem: "✅ Symbol-level", context: "❌", serena: "❌", brokk: "✅", graph: "✅", greptile: "?", amp: "Relevance" },
  { feature: "Semantic Search", claudemem: "✅ Hybrid", context: "✅", serena: "❌", brokk: "✅", graph: "❌", greptile: "✅", amp: "✅" },
  { feature: "Hierarchical Summaries", claudemem: "✅", context: "❌", serena: "❌", brokk: "Skeletons", graph: "❌", greptile: "?", amp: "AGENTS.md" },
  { feature: "Symbol Graph", claudemem: "✅ Pre-computed", context: "❌", serena: "Via LSP", brokk: "Full CPG", graph: "✅", greptile: "✅", amp: "SCIP" },
  { feature: "Languages", claudemem: "12+", context: "12+", serena: "30+", brokk: "Java-focused", graph: "25+", greptile: "Many", amp: "Many" }
];
