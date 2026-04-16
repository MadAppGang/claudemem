#!/usr/bin/env bash
# Promptfoo exec provider driver for mnemex rg × Claude Code end-to-end eval.
#
# Invoked once per test case by promptfoo. Reads the prompt from $1 (promptfoo
# passes `{{prompt}}` positionally), spawns `claude -p` inside the fixture dir
# with the logging shim installed, captures tool-call telemetry, and emits a
# single JSON object on stdout.
#
# The JSON schema promptfoo consumes:
# {
#   "output": "<final model text response>",
#   "shim_hits": <int>,
#   "shim_grep_hits": <int>,
#   "grep_tool_calls": [ { "pattern": "...", "path": "..." }, ... ],
#   "grep_tool_result_preview": "<first 500 chars of grep output shown to model>",
#   "shim_trace_tail": "<last 5 lines of shim log>",
#   "exit_code": <claude exit code>
# }
#
# Promptfoo will parse this JSON and each assertion can pluck fields via
# `javascript` matchers (output.shim_grep_hits > 0, etc).

set -u
set -o pipefail

PROMPT="${1:-}"
if [ -z "$PROMPT" ]; then
  echo '{"error":"drive.sh requires a prompt argument"}' >&2
  exit 2
fi

REPO_ROOT="/Users/jack/mag/mnemex"
FIXTURE="$REPO_ROOT/tests/fixtures/rg-corpus"
SHIM_PATH="$HOME/.local/bin/rg"
VSCODE_RG="$REPO_ROOT/node_modules/@vscode/ripgrep/bin/rg"

# Per-invocation trace log so concurrent promptfoo workers do not clobber
# each other. The shim reads $RG_SHIM_TRACE from its env at exec time.
SHIM_TRACE="$(mktemp -t mnemex-rg-shim-XXXXXX.log)"
export RG_SHIM_TRACE="$SHIM_TRACE"

# ---------- Preconditions ---------------------------------------------------

if [ ! -d "$FIXTURE/.mnemex" ]; then
  echo "Building fixture index (first run)..." >&2
  (cd "$FIXTURE" && bun "$REPO_ROOT/dist/index.js" index --force) >&2 2>&1 || {
    echo "{\"error\":\"failed to build fixture index at $FIXTURE/.mnemex\"}" >&2
    exit 2
  }
fi
if [ ! -x "$VSCODE_RG" ]; then
  echo "{\"error\":\"bundled rg missing at $VSCODE_RG (run: bun install)\"}" >&2
  exit 2
fi
if ! command -v claude >/dev/null 2>&1; then
  echo '{"error":"claude CLI not on PATH"}' >&2
  exit 2
fi

# ---------- Install / refresh the logging shim ------------------------------
#
# We overwrite on every run so the trace-format stays in sync with this
# script. The shim forwards every rg call to the bundled @vscode/ripgrep
# binary so mnemex's own augmentation can run against real rg output.

mkdir -p "$(dirname "$SHIM_PATH")"
# The shim reads RG_SHIM_TRACE from its env at exec time so each promptfoo
# worker can target its own per-invocation log file. Falls back to a default
# when run manually outside this harness.
cat > "$SHIM_PATH" <<EOF
#!/bin/sh
TRACE="\${RG_SHIM_TRACE:-/tmp/shim-trace.log}"
echo "[\$(date +%H:%M:%S)] SHIM_HIT pid=\$\$ ppid=\$PPID args=\$*" >> "\$TRACE"
exec "$VSCODE_RG" "\$@"
EOF
chmod +x "$SHIM_PATH"

# The mktemp above creates the file empty; nothing to clear.
: > "$SHIM_TRACE"

# ---------- Invoke Claude Code ----------------------------------------------
#
# We launch with cwd = fixture dir so the shim's `mnemex rg` (once wired — see
# note below) would find the fixture's `.mnemex/` index. PATH must include
# ~/.local/bin so Bun.which("rg") inside Claude Code resolves to the shim.
# USE_BUILTIN_RIPGREP=0 is read from ~/.claude/settings.json env block; we do
# not set it in shell env here so we test the settings-only path (matching
# what `mnemex rg install` produces).

CC_OUT="$(mktemp -t rg-eval-cc-XXXXXX.jsonl)"
CC_ERR="$(mktemp -t rg-eval-cc-XXXXXX.err)"

(
  cd "$FIXTURE"
  PATH="$HOME/.local/bin:$PATH" claude \
    -p "$PROMPT" \
    --allowedTools Grep \
    --permission-mode acceptEdits \
    --model haiku \
    --output-format stream-json \
    --verbose \
    > "$CC_OUT" 2> "$CC_ERR"
) || true

EXIT_CODE=$?

# ---------- Extract findings --------------------------------------------------

python3 - "$CC_OUT" "$SHIM_TRACE" "$EXIT_CODE" <<'PY'
import json, sys, re
jsonl_path, trace_path, exit_code = sys.argv[1], sys.argv[2], int(sys.argv[3])

# Parse stream-json to find Grep tool uses and final assistant text
grep_calls = []
grep_result_preview = ""
final_text_parts = []

try:
    with open(jsonl_path) as f:
        for raw in f:
            try:
                ev = json.loads(raw)
            except Exception:
                continue
            t = ev.get("type")
            msg = ev.get("message") or {}
            content = msg.get("content") if isinstance(msg, dict) else None
            if not isinstance(content, list):
                continue
            for c in content:
                if not isinstance(c, dict):
                    continue
                if t == "assistant" and c.get("type") == "tool_use" and c.get("name") == "Grep":
                    inp = c.get("input") or {}
                    grep_calls.append({
                        "pattern": inp.get("pattern"),
                        "path": inp.get("path"),
                        "head_limit": inp.get("head_limit"),
                        "output_mode": inp.get("output_mode"),
                    })
                if t == "user" and c.get("type") == "tool_result":
                    # Only capture the first Grep result we see
                    if not grep_result_preview:
                        rc = c.get("content")
                        if isinstance(rc, list):
                            rc = " ".join(p.get("text", "") for p in rc if isinstance(p, dict))
                        if isinstance(rc, str):
                            grep_result_preview = rc[:500]
                if t == "assistant" and c.get("type") == "text":
                    final_text_parts.append(c.get("text", ""))
except FileNotFoundError:
    pass

# Count shim hits. Any line in the trace IS a shim invocation since the trace
# is per-driver-invocation (mktemp). We classify each line as either a Claude
# Code startup probe (--files-only listing, --version probe, plugin cache scan)
# or a Grep-tool invocation. The Grep tool always invokes rg with a search
# pattern, so it never has --files as its primary mode.
shim_hits = 0
shim_grep_hits = 0
shim_lines = []
STARTUP_RE = re.compile(r"args=(--version|--files\b)")
try:
    with open(trace_path) as f:
        for line in f:
            line = line.rstrip("\n")
            if not line:
                continue
            shim_hits += 1
            shim_lines.append(line)
            if not STARTUP_RE.search(line):
                shim_grep_hits += 1
except FileNotFoundError:
    pass

result = {
    "output": "\n".join(final_text_parts).strip(),
    "shim_hits": shim_hits,
    "shim_grep_hits": shim_grep_hits,
    "grep_tool_calls": grep_calls,
    "grep_tool_call_count": len(grep_calls),
    "grep_tool_result_preview": grep_result_preview,
    "shim_trace_tail": "\n".join(shim_lines[-5:]),
    "exit_code": exit_code,
}
print(json.dumps(result))
PY

# Keep logs for debugging but don't spam the caller. Each driver run writes
# to its own logs file keyed by PID so concurrent workers don't overwrite
# each other's artifacts.
mkdir -p "$REPO_ROOT/eval/rg/logs"
cp "$CC_OUT" "$REPO_ROOT/eval/rg/logs/cc-$$.jsonl" 2>/dev/null || true
cp "$SHIM_TRACE" "$REPO_ROOT/eval/rg/logs/shim-$$.log" 2>/dev/null || true
rm -f "$CC_OUT" "$CC_ERR" "$SHIM_TRACE"
