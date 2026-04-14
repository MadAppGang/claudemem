# mnemex Autocomplete (VS Code)

Inline code completion powered by `mnemex` semantic retrieval (FIM use case) + a configurable LLM (Ollama / LM Studio / OpenRouter).

## Requirements

- `mnemex` available on your PATH (or set `mnemexAutocomplete.binaryPath`)
- A project index: run `mnemex init` then `mnemex index --enrich`

## Configuration

- `mnemexAutocomplete.llmProvider`: `local` (Ollama/LM Studio) or `openrouter`
- `mnemexAutocomplete.llmEndpoint`: e.g. `http://localhost:11434/v1` (Ollama) or `http://localhost:1234/v1` (LM Studio)
- `mnemexAutocomplete.llmModel`: e.g. `qwen2.5-coder:7b` (local) or `anthropic/claude-3.5-sonnet` (OpenRouter)

To store an OpenRouter key securely: run **"mnemex: Set OpenRouter API Key"** (uses VS Code Secret Storage).
