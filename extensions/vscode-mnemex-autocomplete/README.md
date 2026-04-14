# claudemem Autocomplete (VS Code)

Inline code completion powered by `claudemem` semantic retrieval (FIM use case) + a configurable LLM (Ollama / LM Studio / OpenRouter).

## Requirements

- `claudemem` available on your PATH (or set `claudememAutocomplete.binaryPath`)
- A project index: run `claudemem init` then `claudemem index --enrich`

## Configuration

- `claudememAutocomplete.llmProvider`: `local` (Ollama/LM Studio) or `openrouter`
- `claudememAutocomplete.llmEndpoint`: e.g. `http://localhost:11434/v1` (Ollama) or `http://localhost:1234/v1` (LM Studio)
- `claudememAutocomplete.llmModel`: e.g. `qwen2.5-coder:7b` (local) or `anthropic/claude-3.5-sonnet` (OpenRouter)

To store an OpenRouter key securely: run **“claudemem: Set OpenRouter API Key”** (uses VS Code Secret Storage).

