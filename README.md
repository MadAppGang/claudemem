# claudemem

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
# first time setup - grabs your OpenRouter API key
# (free tier works fine, or pay ~$0.01 per 1M tokens)
claudemem init

# index your project
claudemem index

# search
claudemem search "authentication flow"
claudemem search "where do we validate user input"
```

That's it. Changed some files? Just search again — it auto-reindexes modified files before searching.

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
2. **Generates embeddings** via OpenRouter (default: qwen3-embedding-8b, good quality, cheap)
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
- `OPENROUTER_API_KEY` — required
- `CLAUDEMEM_MODEL` — override embedding model

Files:
- `~/.claudemem/config.json` — global config
- `.claudemem/` — project index (add to .gitignore)

## Limitations

- Needs OpenRouter API key (free tier exists)
- First index takes a minute on large codebases
- Embedding quality depends on the model you pick
- Not magic — sometimes grep is still faster for exact strings

## License

MIT

---

[GitHub](https://github.com/MadAppGang/claudemem) · [npm](https://www.npmjs.com/package/claude-codemem) · [OpenRouter](https://openrouter.ai)
