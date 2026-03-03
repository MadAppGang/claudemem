# claudemem for VS Code

Semantic code search and symbol navigation right in your VS Code sidebar.

claudemem uses AST-aware code chunking, vector embeddings, and a PageRank-based symbol graph to help you find code by *meaning*, not just text matching.

## Features

### Semantic Search
Search your codebase using natural language queries. Find functions, classes, and modules by what they *do*, not just their names.

- Color-coded relevance scores (green/orange/red)
- File path with line range display
- Click to open and highlight the matching code region

### Symbol Navigation
Explore your codebase's dependency graph:

- **Symbol lookup** -- find any symbol's definition
- **Callers** -- what depends on this symbol
- **Callees** -- what this symbol depends on
- **Context** -- full picture: definition + callers + callees

### Code Analysis
- **Dead code detection** -- find unused symbols with zero callers and low PageRank
- **Test gap analysis** -- find high-importance symbols missing test coverage
- **Impact analysis** -- see the transitive blast radius of changing a symbol

### Companion Panel
Auto-follows your cursor and shows the current symbol's context, callers, callees, and source code. Open with `Cmd+Shift+M`.

## Prerequisites

Install the claudemem CLI first:

```bash
npm install -g claude-codemem
```

Then index your project:

```bash
cd your-project
claudemem index .
```

## Getting Started

1. Install this extension
2. Open a project that has been indexed with `claudemem index`
3. Click the claudemem icon in the activity bar (left sidebar)
4. Start searching!

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `claudemem.binaryPath` | auto-detect | Path to the claudemem binary |
| `claudemem.commandTimeoutSeconds` | 60 | Timeout for CLI commands |

## Commands

- **claudemem: Open Search** -- focus the search sidebar
- **claudemem: Re-index Project** -- rebuild the index for the current workspace
- **claudemem: Open Symbol Context Panel** -- open the companion panel (`Cmd+Shift+M`)

## Links

- [claudemem CLI on npm](https://www.npmjs.com/package/claude-codemem)
- [GitHub Repository](https://github.com/MadAppGang/claudemem)
- [Report Issues](https://github.com/MadAppGang/claudemem/issues)
