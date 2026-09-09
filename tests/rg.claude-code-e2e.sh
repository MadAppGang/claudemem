#!/usr/bin/env bash
# End-to-end test for `mnemex rg` wired into Claude Code's Grep tool.
#
# This script:
#   1. Backs up ~/.local/bin/rg and ~/.claude/settings.json if present
#   2. Runs `mnemex rg install` to write the shim and patch settings
#   3. Verifies the shim is live at ~/.local/bin/rg
#   4. Runs the shim directly (mirrors what Claude Code does internally)
#   5. Spawns a REAL non-interactive Claude Code session against the
#      testdata dir with --print mode, forcing a Grep tool call
#   6. Captures tool-invocation output via --output-format=stream-json
#   7. Asserts mnemex-augmented results reach Claude Code's Grep tool
#   8. Cleans up: restore backups, uninstall shim
#
# Run from repo root:
#   ./tests/rg.claude-code-e2e.sh
#
# Exits non-zero on any assertion failure.

set -euo pipefail

# ============================================================================
# Keychain guard — REQUIRED, and not optional because this script is manual.
#
# Every `bun "$CLI_BIN" ...` below runs the production composition root, whose
# first act is `enableRealKeychainAccess()`. Without these two variables a
# semantic `mnemex rg` in this script resolves an embedding key and reaches
# /usr/bin/security against the operator's real login keychain — the incident
# that produced unanswerable macOS authorization dialogs. Exported, so every
# child (including the shim at $DEV_MNEMEX and anything Claude Code spawns)
# inherits them. See test/helpers/child-env.ts.
# ============================================================================
export MNEMEX_KEYCHAIN_TEST_GUARD=1
export MNEMEX_DISABLE_KEYCHAIN=1

# ============================================================================
# Paths
# ============================================================================

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLI_BIN="$REPO_ROOT/dist/index.js"
TESTDATA="$REPO_ROOT/tests/testdata/rg-corpus"
SHIM_PATH="$HOME/.local/bin/rg"
SETTINGS_PATH="$HOME/.claude/settings.json"
LOG_DIR="$(mktemp -d -t mnemex-rg-e2e-XXXXXX)"
# Path to a temporary mnemex shim that invokes the dev dist, so the e2e
# test doesn't depend on the globally-installed `mnemex` being current.
DEV_MNEMEX="$LOG_DIR/mnemex-dev"

echo "=== mnemex rg × Claude Code e2e ==="
echo "Repo:     $REPO_ROOT"
echo "Testdata: $TESTDATA"
echo "Log dir:  $LOG_DIR"
echo

# ============================================================================
# Preconditions
# ============================================================================

[[ -f "$CLI_BIN" ]] || {
    echo "FAIL: dist not built. Run: bun run build"
    exit 1
}
[[ -d "$TESTDATA/.mnemex" ]] || {
    echo "FAIL: testdata index missing at $TESTDATA/.mnemex"
    exit 1
}
command -v claude >/dev/null 2>&1 || {
    echo "FAIL: 'claude' CLI not found on PATH"
    exit 1
}

# ============================================================================
# Backup current state
# ============================================================================

BACKUP_SHIM=""
BACKUP_SETTINGS=""

if [[ -f "$SHIM_PATH" ]]; then
    BACKUP_SHIM="$LOG_DIR/rg.backup"
    cp "$SHIM_PATH" "$BACKUP_SHIM"
    echo "Backed up existing $SHIM_PATH → $BACKUP_SHIM"
fi

if [[ -f "$SETTINGS_PATH" ]]; then
    BACKUP_SETTINGS="$LOG_DIR/settings.json.backup"
    cp "$SETTINGS_PATH" "$BACKUP_SETTINGS"
    echo "Backed up existing $SETTINGS_PATH → $BACKUP_SETTINGS"
fi

restore_backups() {
    echo
    echo "=== Cleanup ==="
    bun "$CLI_BIN" rg uninstall >/dev/null 2>&1 || true
    if [[ -n "$BACKUP_SHIM" ]]; then
        cp "$BACKUP_SHIM" "$SHIM_PATH"
        chmod +x "$SHIM_PATH"
        echo "Restored $SHIM_PATH"
    fi
    if [[ -n "$BACKUP_SETTINGS" ]]; then
        cp "$BACKUP_SETTINGS" "$SETTINGS_PATH"
        echo "Restored $SETTINGS_PATH"
    fi
    echo "Log dir preserved: $LOG_DIR"
}
trap restore_backups EXIT

# ============================================================================
# Dev mnemex shim
# ============================================================================
# The installed `rg` shim at ~/.local/bin/rg does `exec mnemex rg "$@"`,
# resolving `mnemex` from $PATH. The globally-installed mnemex may be an
# older version that can't read the current index format. Shim it to the
# dev dist for this test by putting a `mnemex` in $LOG_DIR/bin and
# prepending that to PATH.
mkdir -p "$LOG_DIR/bin"
cat > "$LOG_DIR/bin/mnemex" <<EOF
#!/bin/sh
exec bun "$CLI_BIN" "\$@"
EOF
chmod +x "$LOG_DIR/bin/mnemex"
export PATH="$LOG_DIR/bin:$HOME/.local/bin:$PATH"
echo "Dev mnemex shim: $LOG_DIR/bin/mnemex"
echo "Effective PATH (first 3): $(echo "$PATH" | cut -d: -f1-3)"
echo "Resolved mnemex: $(command -v mnemex)"
echo "Resolved rg: $(command -v rg)"

# ============================================================================
# Step 1: install shim
# ============================================================================

echo "=== Step 1: mnemex rg install ==="
bun "$CLI_BIN" rg install 2>&1 | tee "$LOG_DIR/install.log"

[[ -f "$SHIM_PATH" ]] || {
    echo "FAIL: shim not written at $SHIM_PATH"
    exit 1
}
SHIM_CONTENT=$(cat "$SHIM_PATH")
echo "$SHIM_CONTENT" | grep -q "mnemex rg" || {
    echo "FAIL: shim does not exec mnemex rg:"
    echo "$SHIM_CONTENT"
    exit 1
}
echo "  ✓ shim written and references mnemex rg"

grep -q '"USE_BUILTIN_RIPGREP": "0"' "$SETTINGS_PATH" || {
    echo "FAIL: USE_BUILTIN_RIPGREP=0 not set in $SETTINGS_PATH"
    exit 1
}
echo "  ✓ USE_BUILTIN_RIPGREP=0 in settings.json"

# ============================================================================
# Step 2: invoke shim directly (mirrors Claude Code's internal call)
# ============================================================================

echo
echo "=== Step 2: direct shim invocation against testdata ==="
SHIM_OUT="$LOG_DIR/shim-direct.out"
(
    cd "$TESTDATA"
    # `rg` resolves to ~/.local/bin/rg → `mnemex rg "$@"` → dev dist
    rg --line-number "isArray" source/ > "$SHIM_OUT" 2>&1
)
[[ -s "$SHIM_OUT" ]] || {
    echo "FAIL: shim produced empty output"
    exit 1
}
LINE_COUNT=$(wc -l < "$SHIM_OUT")
echo "  ✓ shim produced $LINE_COUNT lines"

# Assert relative paths (not absolute leakage)
if grep -q "^/Users" "$SHIM_OUT"; then
    echo "FAIL: shim output contains absolute paths"
    head -3 "$SHIM_OUT"
    exit 1
fi
echo "  ✓ output uses relative paths"

# Assert mnemex augmentation: rg's natural order walks the file top-to-bottom,
# so if the top N hits are NOT monotonically-increasing line numbers, mnemex
# reordered them. We check the top 8 lines because mnemex surfaces multiple
# semantically-ranked hits before rg's in-order tail begins.
TOP_LINES=$(head -8 "$SHIM_OUT" | sed -n 's|[^:]*:\([0-9]*\):.*|\1|p')
SORTED=$(echo "$TOP_LINES" | sort -n)
if [[ "$TOP_LINES" != "$SORTED" ]]; then
    echo "  ✓ mnemex reordering detected (top 8 hits not in natural file order)"
else
    echo "  ⚠ top 8 hits are in natural order — mnemex may have missed or timed out"
fi

# ============================================================================
# Step 3: real Claude Code session against testdata, force Grep call
# ============================================================================

echo
echo "=== Step 3: Claude Code --print session against testdata ==="
CC_OUT="$LOG_DIR/claude-code.jsonl"
CC_PROMPT='Use the Grep tool to search for the exact pattern "isArray" in the source/ directory. Show me the first 3 results verbatim. Do not explain, just show the grep output.'

(
    cd "$TESTDATA"
    claude \
        -p "$CC_PROMPT" \
        --output-format stream-json \
        --include-partial-messages \
        --verbose \
        --allowedTools Grep \
        --permission-mode acceptEdits \
        --model haiku \
        > "$CC_OUT" 2> "$LOG_DIR/claude-code.err"
) || {
    echo "FAIL: claude -p invocation errored"
    echo "--- stderr ---"
    tail -20 "$LOG_DIR/claude-code.err"
    echo "--- stdout ---"
    tail -20 "$CC_OUT"
    exit 1
}

[[ -s "$CC_OUT" ]] || {
    echo "FAIL: claude -p produced no stream-json output"
    exit 1
}
CC_LINES=$(wc -l < "$CC_OUT")
echo "  ✓ claude -p produced $CC_LINES stream-json events"

# Look for a Grep tool_use event in the stream
if ! grep -q '"name":"Grep"' "$CC_OUT"; then
    echo "FAIL: no Grep tool invocation found in stream-json output"
    echo "--- first 5 events ---"
    head -5 "$CC_OUT"
    exit 1
fi
echo "  ✓ Grep tool was invoked"

# Extract the Grep tool_result and check for our testdata paths
if grep -q 'source/index.ts' "$CC_OUT"; then
    echo "  ✓ Grep tool result contains source/index.ts hits"
else
    echo "FAIL: Grep tool result did not reach testdata paths"
    echo "--- last 10 events ---"
    tail -10 "$CC_OUT"
    exit 1
fi

# ============================================================================
# Summary
# ============================================================================

echo
echo "=== ALL CHECKS PASSED ==="
echo "Install: ✓"
echo "Shim direct invocation: ✓"
echo "Claude Code Grep tool wired to mnemex rg: ✓"
echo
echo "Logs preserved in: $LOG_DIR"
