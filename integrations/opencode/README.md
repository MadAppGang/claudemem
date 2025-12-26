# claudemem OpenCode Integration

Plugins to integrate claudemem with [OpenCode](https://opencode.ai/).

## Available Plugins

### 1. `claudemem.ts` - Suggestion Plugin

Intercepts grep/glob/list and suggests claudemem alternatives. Non-invasive.

```bash
# Install
cp claudemem.ts /path/to/project/.opencode/plugin/

# Add to opencode.json
{
  "plugin": ["file://.opencode/plugin/claudemem.ts"]
}
```

### 2. `claudemem-tools.ts` - Custom Tools Plugin

Adds claudemem as first-class tools the LLM can use directly:
- `claudemem_search` - Semantic code search
- `claudemem_map` - Structural overview
- `claudemem_symbol` - Find symbol location
- `claudemem_callers` - Impact analysis
- `claudemem_callees` - Dependency tracing
- `claudemem_context` - Full context
- `claudemem_dead_code` - Find unused code
- `claudemem_test_gaps` - Find untested code

```bash
# Install
cp claudemem-tools.ts /path/to/project/.opencode/plugin/

# Add to opencode.json
{
  "plugin": ["file://.opencode/plugin/claudemem-tools.ts"]
}
```

## Prerequisites

1. Install claudemem:
   ```bash
   npm install -g claude-codemem
   ```

2. Index your project:
   ```bash
   cd /path/to/project
   claudemem init
   claudemem index
   ```

3. Set API key:
   ```bash
   export OPENROUTER_API_KEY="your-key"
   ```

## Documentation

See [OPENCODE_INTEGRATION.md](../../docs/OPENCODE_INTEGRATION.md) for complete documentation.
