# Finding: USE_BUILTIN_RIPGREP=0 does not redirect Claude Code Grep tool

Date: 2026-04-15
Context: `/dev:dev` session to finalise `mnemex rg` + e2e testing

## TL;DR

The `mnemex rg install` flow based on writing `~/.local/bin/rg` and setting
`USE_BUILTIN_RIPGREP=0` in `~/.claude/settings.json` **does not work** on the
current stable Claude Code binary (v2.1.108, Bun-compiled). The shim is
written correctly, settings are patched correctly, but Claude Code's Grep
tool continues to invoke its embedded ripgrep regardless of env var or PATH.

## Investigation

### Observed behavior

Installed the shim as documented:
```bash
mnemex rg install
# Created ~/.local/bin/rg (exec mnemex rg "$@")
# Set USE_BUILTIN_RIPGREP=0 in ~/.claude/settings.json
export PATH="$HOME/.local/bin:$PATH"
```

Replaced `~/.local/bin/rg` with a logging shim:
```sh
#!/bin/sh
echo "RG_SHIM_CALLED args=$*" >&2
exec mnemex rg "$@"
```

Ran Claude Code in `-p` mode with a prompt forcing a Grep tool call. The
shim's log line never appeared in stderr, and the Grep tool's result
content was in natural file-walk order (proving the output came from
vanilla rg, not mnemex's semantic-first ordering).

Tested both `USE_BUILTIN_RIPGREP=0` and `USE_BUILTIN_RIPGREP=1`. Neither
caused the shim to be invoked.

### Root cause (from Claude Code binary inspection)

The relevant routing logic inside Claude Code's compiled binary:

```js
UoH = M6(() => {
  if (M4(process.env.USE_BUILTIN_RIPGREP)) {
    let {cmd: K} = fx6("rg", []);
    if (K !== "rg") return {mode: "system", command: K, args: []}
  }
  if (Hf()) {
    let K = {mode: "embedded", command: process.execPath, args: ["--no-config"], argv0: "rg"};
    if (cC(process.execPath)) return K;
    let {cmd: O} = fx6("rg", []);
    if (O !== "rg") return {mode: "system", command: O, args: []};
    return K
  }
  let _ = ezH.resolve(rF4, "vendor", "ripgrep");
  return {mode: "builtin", command: ezH.resolve(_, "arm64-darwin", "rg"), args: []}
});
```

Three selection paths:
1. `USE_BUILTIN_RIPGREP` truthy AND `rg` resolves on PATH → `system` mode
2. Bun-embedded (`Hf()`) → `embedded` mode invoking `process.execPath --no-config rg`
3. Otherwise → `builtin` vendored binary

On the Bun-compiled stable binary, `Hf()` returns true and `cC(process.execPath)`
also returns true, so the function short-circuits at path 2 (embedded). Path 1
is only reached if `M4(USE_BUILTIN_RIPGREP)` is truthy AND the function is
evaluated first — but path 2's short-circuit happens before path 1 is even
checked on Bun builds.

**Net result**: on Bun-compiled Claude Code, there is no user-level env var
or settings.json flag that redirects the Grep tool to an external rg binary.

## Implications for the `mnemex rg` feature

The *semantic augmentation* (`src/rg/*`) is correct and well-tested: 92 unit
+ e2e tests pass, the wrapper produces valid rg-compatible output with
semantic hits prepended, fast-path works, fallback is byte-identical. Users
can still:

- Invoke `mnemex rg <pattern>` directly from the shell for grep + semantic search
- Use `mnemex rg install` to shadow `rg` system-wide for other tools that respect PATH
- Call `mnemex rg` from scripts, editors, or non-Claude-Code contexts

What **doesn't work** is the specific claim "Claude Code's Grep tool will use
mnemex-enhanced search" in the README. That line is currently false on Bun builds.

## Options to actually intercept Claude Code's Grep tool

Ordered rough-effort-first:

1. **Revise the README** to note that `USE_BUILTIN_RIPGREP=0` only works on
   non-Bun Claude Code builds, and the install is still useful as a PATH-level
   grep shadow for other tools.

2. **Use an MCP-server Grep tool override**. Claude Code's Grep tool is
   built-in, but an MCP server can expose a `search_code` tool (which mnemex
   already does). Users would instruct the model to prefer the MCP tool over
   native Grep. This is policy-level, not mechanism-level, so it's weaker —
   but it doesn't require a Claude Code change.

3. **File an issue against Claude Code** requesting a `CLAUDE_RIPGREP_PATH`
   env var or similar hook that unconditionally overrides the Bun-embedded path.

4. **Intercept via PreToolUse hook**: register a Claude Code hook on
   `PreToolUse:Grep` that rewrites the tool call to invoke `mnemex search`
   via Bash or transforms the result. This is the most complex path but is
   the only one that works today on stable Claude Code without a code change.

## Recommendation

Proceed with options (1) + (4) in parallel. The `src/rg/*` code is valuable
standalone and we should still ship it, but update the README to set correct
expectations and add a hook-based integration as a second installer path.
