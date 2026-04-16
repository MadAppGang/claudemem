# Why the rg shim wasn't invoked — root cause and fix

Date: 2026-04-15 (corrected after live-restart test)
Topic: Claude Code (Bun-compiled v2.1.108) shim invocation under various `USE_BUILTIN_RIPGREP` settings.

## TL;DR

**The `mnemex rg install` mechanism works as designed.** Writing `USE_BUILTIN_RIPGREP="0"` to `~/.claude/settings.json` under `env` **does** route Claude Code's Grep tool through `~/.local/bin/rg`. Earlier "shim never invoked" results were test-setup artifacts, not a real problem. A clean Claude Code restart with the settings-only configuration produced 28 shim invocations, including the decisive Grep tool call.

Note on a retracted earlier claim in this session: an earlier draft argued that `settings.json[env]` was ignored because the decompiled `RVH` set contains `USE_BUILTIN_RIPGREP`. That reading was wrong. `RVH` is applied when constructing the env block passed to **child processes** (Bash tool, MCP servers, etc.), not when loading settings for Claude Code's own process. The settings.json value DOES reach Claude Code's `process.env` — it just doesn't propagate downstream.

## Decisive evidence — live restart test

Setup (this is exactly what `mnemex rg install` produces):
- `~/.claude/settings.json` → `env.USE_BUILTIN_RIPGREP = "0"` (string)
- `~/.local/bin/rg` → logging shim that forwards to bundled ripgrep
- No `USE_BUILTIN_RIPGREP` set in shell env before launching `claude`
- `~/.local/bin` present on user's PATH (shell rc)

Action: User quit the active Claude Code session, opened a fresh one, and asked the Grep tool to search `isArray` in the fixture corpus.

Result — `/tmp/shim-trace.log` captured:
```
[22:11:26] SHIM_HIT pid=40009 ppid=39616 args=--files --hidden /Users/jack/mag/mnemex
[22:11:26] SHIM_HIT pid=40011 ppid=39616 args=--version
[22:11:26] SHIM_HIT pid=40012 ppid=39616 args=--files --hidden --no-ignore --max-depth 4 --glob .orphaned_at /Users/jack/.claude/plugins/cache
[22:11:51] SHIM_HIT pid=42418 ppid=39616 args=--hidden --glob !.git ... -n isArray /Users/jack/mag/mnemex/tests/fixtures/rg-corpus/source/
```

The final line is the Grep tool's actual invocation, routed through the shim via the settings.json-only configuration.

## Selection logic (decompiled from the binary)

```js
UoH = memoize(() => {
  if (M4(process.env.USE_BUILTIN_RIPGREP)) {        // path 1: opt-into system rg
    let {cmd: K} = fx6("rg", []);                   //   look up rg via Bun.which
    if (K !== "rg")                                 //   if PATH lookup resolved
      return {mode: "system", command: K, args: []} //   use system rg
  }
  if (Hf()) {                                       // path 2: Bun-embedded (default)
    let K = {mode: "embedded", command: process.execPath, args: ["--no-config"], argv0: "rg"};
    if (cC(process.execPath)) return K;
    let {cmd: O} = fx6("rg", []);
    if (O !== "rg") return {mode: "system", command: O, args: []};
    return K
  }
  return {mode: "builtin", command: vendoredRgPath, args: []} // path 3: Node fallback
});

function M4(H) {
  if (H === undefined) return false;
  if (typeof H === "boolean") return !H;
  let _ = String(H).toLowerCase().trim();
  return ["0", "false", "no", "off"].includes(_)
}

cC = Bun.which   // on Bun-compiled claude
fx6(cmd, args) = { cmd: cC(cmd) ?? cmd, args }
```

Key properties:
- **`M4(x)` is a "falsy by name" test** — returns true for `"0"`, `"false"`, `"no"`, `"off"` (case-insensitive).
- The env-var name is counterintuitive: **`USE_BUILTIN_RIPGREP=0` opts INTO the system-rg lookup path.** Setting it to `1` or `true` keeps the embedded binary.
- The system-rg branch only wins if `Bun.which("rg")` finds `rg` on PATH (non-literal result).
- `UoH` is memoized via lodash, so the first call's result is cached for the Claude Code process lifetime. A settings change requires a Claude Code restart to take effect.

## Requirements matrix

For `mnemex rg install` to successfully route Claude Code's Grep tool through the shim, ALL four must be true:

| Requirement | How to achieve | Verify with |
|---|---|---|
| `USE_BUILTIN_RIPGREP` is falsy-by-name in Claude Code's `process.env` | Write `"0"` to `~/.claude/settings.json` under `env` (what `mnemex rg install` does today) | Check `settings.json` |
| `~/.local/bin/rg` exists and is executable | `mnemex rg install` creates it | `ls -la ~/.local/bin/rg` |
| `~/.local/bin` is on `PATH` before `claude` launches | User's shell rc (`.zshrc`/`.bashrc`) has `export PATH="$HOME/.local/bin:$PATH"` | `echo $PATH` in a fresh shell |
| Claude Code has been restarted since settings change | User restarts the session | New session |

## What the `RVH` blocklist actually does (the retracted claim, explained)

Earlier, I mis-read `GVH(H)` as the settings.json loader. It's actually the env-builder for child processes. The purpose:

- Settings.json's `env` block is meant for **user-defined env vars** the user wants to inject into child processes Claude Code spawns (Bash tool, MCP servers, custom commands).
- `RVH` blocklists ~80 Claude Code-internal env vars (`ANTHROPIC_MODEL`, `CLAUDE_CODE_USE_BEDROCK`, `USE_BUILTIN_RIPGREP`, telemetry keys, BASH limits) from being passed to child processes **even if** the user listed them in settings.json.
- This is a leak-prevention measure, not an incoming-filter. The value still lands on Claude Code's own `process.env` at startup, which is what the ripgrep selection code checks.

## Implications for `mnemex rg install` (corrected)

The current implementation is **correct** in its essentials. No major changes needed. Possible polish:

1. **Keep writing `USE_BUILTIN_RIPGREP="0"` to `settings.json[env]`.** It works.
2. **Make the restart requirement explicit** in the install output. `UoH` is memoized, so a running Claude Code session won't pick up a freshly-installed shim until restart.
3. **Add a `mnemex rg doctor` command** that validates all four requirements above and explains which is failing.
4. **Print the correct PATH instruction.** The current script says "ensure `~/.local/bin` is early in your PATH" which is right. Optionally offer to append to shell rc.

## Sources

- **Live restart test** — user configured settings.json only, restarted Claude Code, triggered Grep tool, shim hit 28 times. Sufficient positive evidence.
- **Decompiled symbols** from `/Users/jack/.local/share/claude/versions/2.1.108` (Mach-O, Bun-compiled)
  - `UoH` rg selection function
  - `M4` truthy/falsy parser
  - `RVH` child-process env blocklist (not a settings-load filter)
  - `cC` / `Bun.which` PATH lookup
- **GitHub issue #6415** (Anthropic). Anthropic engineer ant-kurt's reply confirms the `env` key shape under settings.json is the intended interface. Issue reporter confirmed "fixed in latest version" — the fix landed before v2.1.108, which is why the mechanism now works end-to-end.
