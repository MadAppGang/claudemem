# mnemex OpenCode Integration

Plugins to integrate mnemex with [OpenCode](https://opencode.ai/).

## Available Plugins

### 1. `mnemex.ts` - Suggestion Plugin

Intercepts grep/glob/list and suggests mnemex alternatives. Non-invasive.

```bash
# Install
cp mnemex.ts /path/to/project/.opencode/plugin/

# Add to opencode.json
{
  "plugin": ["file://.opencode/plugin/mnemex.ts"]
}
```

### 2. `mnemex-tools.ts` - Custom Tools Plugin

Adds mnemex as first-class tools the LLM can use directly:
- `mnemex_search` - Semantic code search
- `mnemex_map` - Structural overview
- `mnemex_symbol` - Find symbol location
- `mnemex_callers` - Impact analysis
- `mnemex_callees` - Dependency tracing
- `mnemex_context` - Full context
- `mnemex_dead_code` - Find unused code
- `mnemex_test_gaps` - Find untested code

```bash
# Install
cp mnemex-tools.ts /path/to/project/.opencode/plugin/

# Add to opencode.json
{
  "plugin": ["file://.opencode/plugin/mnemex-tools.ts"]
}
```

## Prerequisites

1. Install mnemex:
   ```bash
   npm install -g mnemex
   ```

2. Index your project:
   ```bash
   cd /path/to/project
   mnemex init
   mnemex index
   ```

3. Set API key:
   ```bash
   export OPENROUTER_API_KEY="your-key"
   ```

## Documentation

See [OPENCODE_INTEGRATION.md](../../docs/OPENCODE_INTEGRATION.md) for complete documentation.
