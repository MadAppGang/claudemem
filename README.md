<p align="center">
  <img src="assets/logo.svg" alt="CLAUDEMEM" width="700">
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/claude-codemem"><img src="https://img.shields.io/npm/v/claude-codemem.svg" alt="npm version"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
  <a href="https://github.com/MadAppGang/claudemem"><img src="https://img.shields.io/github/stars/MadAppGang/claudemem?style=social" alt="GitHub stars"></a>
</p>

---

Local semantic code search for Claude Code. Index your codebase once, search it with natural language.

## Install

```bash
# npm
npm install -g claude-codemem

# homebrew (macOS)
brew tap MadAppGang/claude-mem && brew install --cask claudemem

# or just curl it
curl -fsSL https://raw.githubusercontent.com/MadAppGang/claudemem/main/install.sh | bash
```

## Why this exists

Claude Code's built-in search (grep/glob) works fine for exact matches. But when you're trying to find "where do we handle auth tokens" or "error retry logic" — good luck.

claudemem fixes that. It chunks your code using tree-sitter (so it actually understands functions/classes, not just lines), generates embeddings via OpenRouter, and stores everything locally in LanceDB.

The search combines keyword matching with vector similarity. Works surprisingly well for finding stuff you kinda-sorta remember but can't grep for.

## Quick start

```bash
# first time setup
claudemem init

# index your project
claudemem index

# search
claudemem search "authentication flow"
claudemem search "where do we validate user input"
```

That's it. Changed some files? Just search again — it auto-reindexes modified files before searching.

## Embedding Model Benchmark

We benchmarked popular embedding models on real code search tasks. Quality score measures how well the model ranks relevant code chunks (higher is better).

| Model | Quality | Speed | Cost | Notes |
|-------|---------|-------|------|-------|
| **voyage-code-3** | 10/10 | 4s | $0.18/1M | Best for code, recommended |
| **voyage-3.5** | 10/10 | 4s | $0.06/1M | Great balance |
| **voyage-3.5-lite** | 10/10 | 4s | $0.02/1M | Best value |
| **voyage-3-large** | 10/10 | 4s | $0.18/1M | High quality |
| text-embedding-3-small | 6/10 | 7s | $0.02/1M | Decent, cheap |
| gemini-embedding-001 | 5/10 | 7s | FREE | Free option |
| text-embedding-3-large | 4/10 | 7s | $0.13/1M | Surprisingly weak |
| all-minilm-l6-v2 | 4/10 | 7s | FREE | Local, fast |
| mistral-embed-2312 | 0/10 | 7s | $0.10/1M | Failed to embed |

> Voyage models dominate code search. The lite variant offers identical quality at 1/9th the price.

## Embedding providers

claudemem supports three embedding providers:

### OpenRouter (cloud, default)
```bash
claudemem init  # select "OpenRouter"
# requires API key from https://openrouter.ai/keys
# ~$0.01 per 1M tokens
```

### Ollama (local, free)
```bash
# install Ollama first: https://ollama.ai
ollama pull nomic-embed-text

claudemem init  # select "Ollama"
```

Recommended Ollama models:
- `nomic-embed-text` — best quality, 768d, 274MB
- `mxbai-embed-large` — large context, 1024d, 670MB
- `all-minilm` — fastest, 384d, 46MB

### Custom endpoint (local server)
```bash
claudemem init  # select "Custom endpoint"
# expects OpenAI-compatible /embeddings endpoint
```

View available models:
```bash
claudemem --models           # OpenRouter models
claudemem --models --ollama  # Ollama models
```

## Using with Claude Code

Run it as an MCP server:

```bash
claudemem --mcp
```

Then Claude Code can use these tools:
- `search_code` — semantic search (auto-indexes changes)
- `index_codebase` — manual full reindex
- `get_status` — check what's indexed
- `clear_index` — start fresh

## What it actually does

1. **Parses code** with tree-sitter — extracts functions, classes, methods as chunks (not dumb line splits)
2. **Generates embeddings** via OpenRouter (default: voyage-3.5-lite, best value)
3. **Stores locally** in LanceDB — everything stays in `.claudemem/` in your project
4. **Hybrid search** — BM25 for exact matches + vector similarity for semantic. Combines both.

## Supported languages

TypeScript, JavaScript, Python, Go, Rust, C, C++, Java.

If your language isn't here, it falls back to line-based chunking. Works, but not as clean.

## CLI reference

```
claudemem init              # setup wizard
claudemem index [path]      # index codebase
claudemem search <query>    # search (auto-reindexes changed files)
claudemem status            # what's indexed
claudemem clear             # nuke the index
claudemem models            # list embedding models
claudemem benchmark         # benchmark embedding models
claudemem --mcp             # run as MCP server
```

Search flags:
```
-n, --limit <n>       # max results (default: 10)
-l, --language <lang> # filter by language
-y, --yes             # auto-create index without asking
--no-reindex          # skip auto-reindex
```

## Config

Env vars:
- `OPENROUTER_API_KEY` — for OpenRouter provider
- `CLAUDEMEM_MODEL` — override embedding model

Files:
- `~/.claudemem/config.json` — global config (provider, model, endpoints)
- `.claudemem/` — project index (add to .gitignore)

## Limitations

- First index takes a minute on large codebases
- Ollama is slower than cloud (runs locally, no batching)
- Embedding quality depends on the model you pick
- Not magic — sometimes grep is still faster for exact strings

## License

MIT

---

[GitHub](https://github.com/MadAppGang/claudemem) · [npm](https://www.npmjs.com/package/claude-codemem) · [OpenRouter](https://openrouter.ai)
