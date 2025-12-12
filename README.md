# claudemem

Local code indexing with semantic search for Claude Code.

## Installation

### npm

```bash
npm install -g claude-codemem
```

### Homebrew (macOS)

```bash
brew tap MadAppGang/claude-mem
brew install --cask claudemem
```

### Direct Install

```bash
curl -fsSL https://raw.githubusercontent.com/MadAppGang/claudemem/main/install.sh | bash
```

## Quick Start

```bash
# Set up API key (get one at https://openrouter.ai/keys)
claudemem init

# Index your codebase
claudemem index

# Search code with natural language
claudemem search "authentication flow"
claudemem search "error handling" -n 5

# Start MCP server for Claude Code integration
claudemem --mcp
```

## Features

- **AST-based code chunking** - Uses tree-sitter for intelligent code parsing (TypeScript, JavaScript, Python, Go, Rust, C/C++, Java)
- **Vector embeddings** - Powered by OpenRouter API with free/cheap embedding models
- **Local storage** - LanceDB vector database stored per-project (no external services)
- **Hybrid search** - Combines BM25 keyword search with vector similarity
- **Auto-indexing** - Automatically indexes changed files on search
- **MCP integration** - Seamless integration with Claude Code via MCP server

## CLI Commands

```
claudemem init              Interactive setup wizard
claudemem index [path]      Index a codebase (default: current directory)
claudemem search <query>    Search indexed code
claudemem status [path]     Show index status
claudemem clear [path]      Clear the index
claudemem models            List available embedding models
claudemem --mcp             Start as MCP server
```

### Search Options

```
-n, --limit <n>        Maximum results (default: 10)
-l, --language <lang>  Filter by programming language
-p, --path <path>      Project path (default: current directory)
-y, --yes              Auto-create index if missing (no prompt)
--no-reindex           Skip auto-reindexing changed files
```

## MCP Server

claudemem can run as an MCP (Model Context Protocol) server for integration with Claude Code:

```bash
claudemem --mcp
```

### Available MCP Tools

| Tool | Description |
|------|-------------|
| `index_codebase` | Index a codebase for semantic search |
| `search_code` | Search indexed code using natural language |
| `clear_index` | Clear the code index for a project |
| `get_status` | Get index status for a project |
| `list_embedding_models` | List available embedding models |

## Configuration

### Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENROUTER_API_KEY` | API key for embeddings (required) |
| `CLAUDEMEM_MODEL` | Override default embedding model |

### Config Files

- Global config: `~/.claudemem/config.json`
- Project index: `.claudemem/` directory in project root

## Supported Languages

- TypeScript / JavaScript / TSX / JSX
- Python
- Go
- Rust
- C / C++
- Java

## How It Works

1. **Parsing** - Code is parsed using tree-sitter to extract semantic chunks (functions, classes, methods)
2. **Embedding** - Each chunk is converted to a vector using OpenRouter embedding models
3. **Storage** - Vectors are stored locally in LanceDB per-project
4. **Search** - Queries use hybrid search (BM25 + vector similarity) for best results
5. **Auto-update** - Changed files are automatically re-indexed on search

## License

MIT

## Links

- [GitHub Repository](https://github.com/MadAppGang/claudemem)
- [npm Package](https://www.npmjs.com/package/claude-codemem)
- [OpenRouter](https://openrouter.ai) - Embedding API provider
