# claudemem Website Content
## Complete Content for Website Creator

---

# SECTION 1: LANDING PAGE (HOMEPAGE)

## Hero Section

### Headline
**Local Semantic Code Search for AI Agents**

### Subheadline
Give Claude Code, Cursor, and AI assistants deep understanding of your codebase. Privacy-first indexing with PageRank-powered symbol importance.

### Primary CTA
**Get Started Free** → Installation guide

### Secondary CTA
**See Benchmark Results** → /benchmarks

---

## Problem Statement Section

### Headline
**AI Assistants Don't Really Understand Your Code**

### Content
When you ask Claude or Cursor to help with your codebase, they're essentially searching blind. They can grep for keywords and read files, but they don't understand:

- Which functions are **critical** vs. rarely used
- How symbols **connect** across your codebase
- What code **actually does** (not just what it's named)
- Which files are **related** to what you're working on

**The result?** AI suggestions that miss context, break dependencies, or ignore important patterns in your code.

---

## Solution Section

### Headline
**Semantic Understanding, Not Just Keyword Matching**

### Feature 1: Smart Code Chunking
**How it works:** We use tree-sitter AST parsing to understand code structure. Functions, classes, and modules are chunked intelligently—not arbitrarily split at line boundaries.

**Why it matters:** When you search for "authentication", you get the complete auth function—not half of it cut off mid-logic.

### Feature 2: PageRank Importance
**How it works:** We build a symbol graph of your codebase and run PageRank to identify which functions matter most. High PageRank = many other parts depend on it.

**Why it matters:** AI assistants can prioritize showing you the important code first, not random utility functions.

### Feature 3: Semantic Similarity
**How it works:** Code is converted to embeddings that capture meaning. "validate user input" finds sanitization functions even if they're named `checkData()`.

**Why it matters:** Natural language queries work. Describe what you want, not the exact function name.

### Feature 4: 100% Local & Private
**How it works:** Everything runs on your machine. Your code never leaves your laptop. Index stored locally in LanceDB.

**Why it matters:** Use it on proprietary code, client projects, anything—without security concerns.

---

## Comparison Section

### Headline
**How claudemem Compares**

| Feature | claudemem | Greptile | Sourcegraph | Cursor |
|---------|-----------|----------|-------------|--------|
| **Privacy** | 100% Local | Cloud-only | Cloud/Self-host | Cloud |
| **Cost** | Free/Open Source | $30/dev/month | Enterprise pricing | Included |
| **AI Integration** | MCP Server | API | API | Built-in |
| **Code Understanding** | AST + PageRank + Embeddings | Embeddings | Graph + Search | Embeddings |
| **Setup Time** | 5 minutes | Account required | Days/weeks | Built-in |

### Key Differentiators

**vs. Greptile ($30/dev/month)**
- claudemem is free and open source
- Your code stays local (Greptile requires cloud upload)
- Same AI integration via MCP protocol

**vs. Sourcegraph**
- No enterprise sales process
- Works on laptop, not just large orgs
- Simpler setup (one command vs. infrastructure)

**vs. Built-in Cursor/Claude search**
- PageRank ranking (they just do similarity)
- Symbol graph navigation (callers/callees)
- Persistent index (they re-scan each session)

---

## How It Works Section (Brief)

### Step 1: Index Your Codebase
```bash
claudemem index
```
Tree-sitter parses your code into semantic chunks. Each function, class, and module becomes a searchable unit.

### Step 2: Build Symbol Graph
Automatically maps dependencies: what calls what, what imports what. PageRank identifies your most important code.

### Step 3: Generate Embeddings
Each code chunk is converted to a vector embedding capturing its semantic meaning. Stored locally in LanceDB.

### Step 4: Connect to AI
Add claudemem as an MCP server to Claude Code. Your AI assistant now has deep codebase understanding.

**→ Learn more:** [How Indexing Works](/how-it-works)

---

## Use Cases Section

### For Individual Developers
- Ask Claude "where is authentication handled?" and get the right files
- Understand unfamiliar codebases quickly
- Find all code related to a feature, not just keyword matches

### For Teams
- Onboard new developers faster
- Consistent codebase understanding across AI tools
- No cloud dependencies or vendor lock-in

### For AI Tool Builders
- MCP server protocol for easy integration
- Benchmark your models against our test suite
- Contribute to open source improvements

---

## Testimonials/Social Proof Section
(Placeholder for future testimonials)

---

## Final CTA Section

### Headline
**Give Your AI Real Code Understanding**

### Content
5-minute setup. 100% local. Free forever.

### Buttons
- **Install Now** → Installation guide
- **View Benchmarks** → /benchmarks
- **GitHub** → Repository

---
---

# SECTION 2: BENCHMARK RESULTS PAGE

## Page Header

### Headline
**Model Benchmark Results**

### Subheadline
We rigorously test embedding models and LLMs to find what actually works for code understanding. All tests run on real codebases, not synthetic benchmarks.

---

## Why We Test Section

### Headline
**Not All Models Are Created Equal**

### Content
Marketing claims don't match reality. We found:

- **Some "code-optimized" embedding models perform worse than general models**
- **Expensive models aren't always better**
- **Local models can match cloud performance for many tasks**

Our benchmarks test what matters for code search: Can the model help you find the right code?

---

## Embedding Models Leaderboard

### Headline
**Embedding Model Rankings**

### Table Headers
| Rank | Model | Retrieval Score | Contrastive Score | Overall | Cost | Latency |

### Current Top Models (Example Data)
| 1 | voyage-code-3 | 0.92 | 0.88 | 0.90 | $0.001/1K | 150ms |
| 2 | text-embedding-3-large | 0.89 | 0.85 | 0.87 | $0.0001/1K | 100ms |
| 3 | qwen2.5-coder-7b (local) | 0.85 | 0.82 | 0.83 | Free | 200ms |

### Metric Explanations

**Retrieval Score**
When you search for "database connection", does the model return the actual database code? We test with known queries and measure precision@1 (first result correct), precision@5 (any of top 5 correct), and MRR (mean reciprocal rank).

**Contrastive Score**
Can the model distinguish similar code? We test with positive/negative pairs: "Does this search return the auth function, not the similar-looking validation function?"

---

## LLM Judge Leaderboard

### Headline
**LLM Model Rankings (for Code Understanding)**

### Table Headers
| Rank | Model | Pointwise | Pairwise | Self-Eval | Overall | Cost |

### Metric Explanations

**Pointwise Scoring**
We show the LLM a code description and ask it to rate relevance 1-5. Tests: Does the model understand what code does?

**Pairwise Comparison**
We show two code snippets and ask "Which better matches this query?" Tests: Can the model compare code quality?

**Self-Evaluation**
The model generates its own search queries, executes them, and evaluates results. Tests: End-to-end code understanding.

---

## Methodology Summary

### How We Run Tests

1. **Real Codebases**: Tests run on actual open-source projects (TypeScript, Python, Go), not synthetic examples

2. **Ground Truth Labels**: Human-verified correct answers for each query

3. **Multiple Judges**: Results validated by multiple LLM judges to reduce bias

4. **Statistical Rigor**: Confidence intervals, multiple runs, reproducible results

**→ Full methodology:** [How We Test Models](/testing-methodology)

---

## Filter Controls (UI Elements)

- **Codebase Type**: All / TypeScript / Python / Go / Mixed
- **Model Type**: All / Embedding / LLM
- **Cost Tier**: All / Free / < $0.01 / Any
- **Sort By**: Overall Score / Retrieval / Cost / Latency

---

## Call to Action

### Test Your Own Models
```bash
claudemem benchmark --generators "model1,model2" --sample 50
```

Results automatically uploaded to our public leaderboard (opt-out available).

---
---

# SECTION 3: HOW INDEXING WORKS

## Page Header

### Headline
**How claudemem Understands Your Code**

### Subheadline
A technical deep-dive into AST parsing, symbol graphs, PageRank ranking, and semantic embeddings.

---

## Overview Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                        YOUR CODEBASE                             │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 1: AST PARSING (tree-sitter)                              │
│  ─────────────────────────────────────────────────────────────  │
│  • Parse each file into Abstract Syntax Tree                    │
│  • Identify functions, classes, methods, modules                │
│  • Extract symbol names, parameters, return types               │
│  • Preserve code structure and relationships                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 2: INTELLIGENT CHUNKING                                   │
│  ─────────────────────────────────────────────────────────────  │
│  • Group related code into semantic units                       │
│  • Respect function/class boundaries                            │
│  • Include context (imports, types, comments)                   │
│  • Optimal chunk size for embedding models                      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 3: SYMBOL GRAPH + PAGERANK                                │
│  ─────────────────────────────────────────────────────────────  │
│  • Build graph: nodes = symbols, edges = dependencies           │
│  • Track: function calls, imports, type references              │
│  • Run PageRank to compute importance scores                    │
│  • High PageRank = many things depend on this                   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 4: SEMANTIC EMBEDDINGS                                    │
│  ─────────────────────────────────────────────────────────────  │
│  • Convert each chunk to vector embedding                       │
│  • Captures semantic meaning, not just keywords                 │
│  • Multiple model options (cloud or local)                      │
│  • Store in LanceDB for fast similarity search                  │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  STEP 5: HYBRID SEARCH INDEX                                    │
│  ─────────────────────────────────────────────────────────────  │
│  • Vector similarity (semantic matching)                        │
│  • BM25 keyword search (exact matches)                          │
│  • Combined ranking with PageRank boost                         │
│  • Sub-second queries on large codebases                        │
└─────────────────────────────────────────────────────────────────┘
```

---

## Step 1: AST Parsing

### What It Does
Instead of treating code as plain text, we parse it into an Abstract Syntax Tree using tree-sitter. This gives us structural understanding of your code.

### Example
```typescript
// Your code:
function validateUser(email: string): boolean {
  return email.includes('@') && email.length > 5;
}

// What we extract:
{
  type: "function",
  name: "validateUser",
  parameters: [{ name: "email", type: "string" }],
  returnType: "boolean",
  body: "return email.includes('@') && email.length > 5;",
  location: { file: "auth.ts", line: 42 }
}
```

### Supported Languages
TypeScript, JavaScript, Python, Go, Rust, Java, C++, Ruby, PHP, and more via tree-sitter grammars.

---

## Step 2: Intelligent Chunking

### The Problem with Naive Chunking
Most tools split code at arbitrary character limits:

```
❌ Naive: Split every 1000 characters
   Result: Functions cut in half, context lost

✓ claudemem: Split at semantic boundaries
   Result: Complete functions with their context
```

### Our Approach
1. **Primary units**: Functions, classes, methods
2. **Include context**: Imports, type definitions, docstrings
3. **Respect size limits**: Split large functions at logical points
4. **Preserve relationships**: Keep related code together

---

## Step 3: Symbol Graph + PageRank

### Building the Graph

```
┌──────────────┐     calls      ┌──────────────┐
│   main()     │ ──────────────▶│  processData │
└──────────────┘                └──────────────┘
       │                               │
       │ calls                         │ calls
       ▼                               ▼
┌──────────────┐                ┌──────────────┐
│ validateUser │◀───────────────│   saveUser   │
└──────────────┘     calls      └──────────────┘
```

### PageRank Intuition
- **High PageRank**: Many functions call this → it's important
- **Low PageRank**: Nothing calls this → utility or dead code
- **Analogy**: Like Google ranking web pages by incoming links

### Why This Matters
When AI searches your code, we boost important results:
- Query: "user validation"
- Without PageRank: Random validation helper function
- With PageRank: Core `validateUser()` that everything depends on

---

## Step 4: Semantic Embeddings

### How Embeddings Work

```
Code: "function sanitizeInput(data) { return data.replace(/<[^>]*>/g, ''); }"
         │
         ▼
    Embedding Model
         │
         ▼
Vector: [0.23, -0.45, 0.12, 0.89, ...] (1536 dimensions)
```

### Why Embeddings Beat Keywords

| Query | Keyword Search | Semantic Search |
|-------|---------------|-----------------|
| "clean user input" | ❌ No match (different words) | ✓ Finds `sanitizeInput` |
| "XSS prevention" | ❌ No match | ✓ Finds HTML stripping code |
| "validate email format" | ❌ Finds any "email" mention | ✓ Finds actual validation logic |

### Model Options
- **Cloud**: OpenAI, Voyage AI, Anthropic (best quality)
- **Local**: Ollama, LM Studio (free, private)
- **Hybrid**: Use local for indexing, cloud for queries

---

## Step 5: Hybrid Search

### Combining Multiple Signals

```
Final Score = (0.5 × Vector Similarity)
            + (0.3 × BM25 Keyword Score)
            + (0.2 × PageRank Importance)
```

### Why Hybrid?
- **Vector alone**: Might miss exact keyword matches
- **Keywords alone**: Misses semantic similarity
- **PageRank alone**: Ignores query relevance
- **Combined**: Best of all approaches

---

## Performance Characteristics

| Codebase Size | Index Time | Index Size | Query Time |
|---------------|------------|------------|------------|
| Small (<10K lines) | ~30 seconds | ~50 MB | <100ms |
| Medium (10-100K) | ~5 minutes | ~200 MB | <200ms |
| Large (100K-1M) | ~30 minutes | ~1 GB | <500ms |

### Incremental Updates
After initial index, only changed files are re-indexed. Typical update: <5 seconds.

---
---

# SECTION 4: HOW WE TEST MODELS

## Page Header

### Headline
**Our Testing Methodology**

### Subheadline
Rigorous, reproducible benchmarks that test what actually matters for code understanding.

---

## Philosophy Section

### Headline
**Why We Built Our Own Benchmarks**

### Content
Existing benchmarks don't test real-world code search:

- **HumanEval/MBPP**: Test code generation, not understanding
- **CodeSearchNet**: Outdated, doesn't match modern codebases
- **Vendor benchmarks**: Cherry-picked to make their model look good

We built benchmarks that answer: **"Can this model help developers find and understand code?"**

---

## The Five Tests We Run

### Test 1: Retrieval Accuracy

**What we test:** Given a natural language query, does the model return the correct code?

**How it works:**
1. We create queries with known correct answers (human-verified)
2. Example: Query "database connection pooling" → Should return `db/pool.ts`
3. Model generates embeddings, we search, check if correct file is in results

**Metrics:**
- **Precision@1**: Is the #1 result correct? (hardest test)
- **Precision@5**: Is correct answer in top 5?
- **MRR**: Mean Reciprocal Rank (how high is correct answer?)

**Why it matters:** If search returns wrong results, AI gives wrong suggestions. This is the foundation of code understanding.

---

### Test 2: Contrastive Discrimination

**What we test:** Can the model tell similar code apart?

**How it works:**
1. We create "positive" and "negative" pairs
2. Positive: Code that matches the query
3. Negative: Code that looks similar but doesn't match
4. Example:
   - Query: "user authentication"
   - Positive: `authenticateUser()` function
   - Negative: `validateUserInput()` function (similar name, different purpose)

**Metrics:**
- **Accuracy**: How often does model rank positive above negative?
- **Margin**: How confident is the distinction?

**Why it matters:** Real codebases have many similar-looking functions. Model must understand purpose, not just names.

---

### Test 3: Pointwise Judging

**What we test:** Can an LLM judge whether code matches a description?

**How it works:**
1. Show LLM: code snippet + description
2. Ask: "Rate relevance 1-5"
3. Compare to human ground truth ratings

**Example prompt:**
```
Code: [function that handles login]
Description: "Session management and cookie handling"
Rate relevance 1-5:
```

**Why it matters:** Tests if LLM understands code semantics well enough to evaluate relevance.

---

### Test 4: Pairwise Comparison

**What we test:** Can an LLM compare two code options and pick the better one?

**How it works:**
1. Show LLM: query + two code snippets
2. Ask: "Which code better matches the query?"
3. Check if LLM picks the human-verified correct answer

**Example prompt:**
```
Query: "Error handling for API requests"

Option A: [try-catch wrapper for fetch calls]
Option B: [input validation function]

Which better matches the query?
```

**Why it matters:** This is what happens in real RAG systems—the model must rank retrieved results.

---

### Test 5: Self-Evaluation (End-to-End)

**What we test:** Can the model use code search effectively from start to finish?

**How it works:**
1. Give model a task: "Find how authentication works in this codebase"
2. Model generates its own search queries
3. Model executes searches against the index
4. Model evaluates: "Did I find what I was looking for?"
5. We verify against ground truth

**Metrics:**
- **Task completion**: Did model find the right code?
- **Query quality**: Were search queries effective?
- **Self-accuracy**: Does model know when it succeeded/failed?

**Why it matters:** This tests the full loop—exactly how AI assistants actually use code search.

---

### Bonus Test: Iterative Refinement

**What we test:** Can the model improve results through multiple rounds?

**How it works:**
1. Model searches, evaluates results
2. If not satisfied, model refines query and searches again
3. Repeat until satisfied or max rounds reached

**Why it matters:** Smart models should be able to recover from bad initial queries.

---

## Test Infrastructure

### Real Codebases, Not Synthetic

We test on actual open-source projects:
- **TypeScript**: React apps, Node.js servers, CLI tools
- **Python**: Django apps, data science projects, APIs
- **Go**: Microservices, CLI tools, system utilities
- **Mixed**: Monorepos with multiple languages

### Ground Truth Creation

1. **Human annotation**: Developers label correct answers
2. **Cross-validation**: Multiple annotators must agree
3. **Edge case coverage**: Include ambiguous and tricky cases

### Statistical Rigor

- **Multiple runs**: Each test runs 3+ times
- **Confidence intervals**: Report uncertainty, not just point estimates
- **Sample size**: Minimum 50 queries per benchmark
- **Reproducibility**: All test data and code is open source

---

## Running Your Own Benchmarks

### Quick Start
```bash
# Install claudemem
npm install -g claudemem

# Index your codebase
claudemem index

# Run benchmark with default models
claudemem benchmark

# Compare specific models
claudemem benchmark --generators "voyage-code-3,text-embedding-3-large"

# Larger sample size for more reliable results
claudemem benchmark --sample 100
```

### Interpreting Results

| Score | Meaning |
|-------|---------|
| > 0.9 | Excellent - production ready |
| 0.8-0.9 | Good - suitable for most use cases |
| 0.7-0.8 | Acceptable - may miss edge cases |
| < 0.7 | Poor - not recommended |

---

## Contributing

We welcome contributions to our benchmark suite:
- **New test queries**: Help expand coverage
- **New codebases**: Add projects in other languages
- **Model results**: Run benchmarks and submit results
- **Methodology improvements**: Better metrics, fairer tests

GitHub: [link to repo]

---
---

# SECTION 5: INSTALLATION & QUICK START

## Installation

### Prerequisites
- Node.js 18+ or Bun
- Git (for MCP integration with Claude Code)

### Install
```bash
# Using npm
npm install -g claudemem

# Using bun (recommended)
bun install -g claudemem
```

---

## Quick Start

### 1. Index Your Codebase
```bash
cd your-project
claudemem index
```

### 2. Search (Command Line)
```bash
# Semantic search
claudemem search "authentication handling"

# Symbol lookup
claudemem symbol "validateUser"

# Find callers
claudemem callers "processPayment"
```

### 3. Connect to Claude Code
```bash
# Add as MCP server
claude mcp add claudemem -- claudemem mcp

# Now Claude Code can search your codebase semantically
```

---

## Common Commands

| Command | Description |
|---------|-------------|
| `claudemem index` | Index current directory |
| `claudemem search <query>` | Semantic code search |
| `claudemem map` | Show codebase structure with PageRank |
| `claudemem symbol <name>` | Find symbol definition |
| `claudemem callers <name>` | Find what calls this symbol |
| `claudemem callees <name>` | Find what this symbol calls |
| `claudemem context <name>` | Full context: definition + callers + callees |
| `claudemem watch` | Auto-reindex on file changes |
| `claudemem benchmark` | Run model quality benchmarks |

---
---

# SECTION 6: FOOTER / GLOBAL ELEMENTS

## Footer Links

### Product
- Features
- Benchmarks
- How It Works
- Installation

### Resources
- Documentation
- GitHub
- Changelog
- Contributing

### Community
- Discord (placeholder)
- Twitter (placeholder)
- Blog (placeholder)

---

## SEO Metadata

### Homepage
- **Title**: claudemem - Local Semantic Code Search for AI Agents
- **Description**: Give Claude Code and AI assistants deep understanding of your codebase. Privacy-first indexing with PageRank-powered symbol importance. Free and open source.
- **Keywords**: code search, semantic search, AI code assistant, Claude Code, MCP server, code understanding, PageRank, embeddings

### Benchmarks Page
- **Title**: Embedding & LLM Model Benchmarks | claudemem
- **Description**: Rigorous benchmarks testing which AI models actually work for code understanding. Compare retrieval accuracy, contrastive discrimination, and end-to-end performance.

### How Indexing Works
- **Title**: How Code Indexing Works | claudemem
- **Description**: Technical deep-dive into AST parsing, symbol graphs, PageRank ranking, and semantic embeddings for intelligent code search.

### Testing Methodology
- **Title**: How We Test AI Models for Code | claudemem
- **Description**: Our rigorous benchmark methodology: retrieval accuracy, contrastive discrimination, pointwise judging, pairwise comparison, and self-evaluation tests.

---

# END OF CONTENT DOCUMENT
