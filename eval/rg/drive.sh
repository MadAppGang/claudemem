#!/usr/bin/env bash
# Promptfoo exec provider wrapper for one mnemex rg x Claude Code eval case.
#
# The implementation lives in driver.ts so promptfoo and the HTML report score
# the same telemetry: Claude stream-json, rg shim hits, and mnemex-rg invocations.

set -u
set -o pipefail

PROMPT="${1:-}"
if [ -z "$PROMPT" ]; then
  echo '{"error":"drive.sh requires a prompt argument","exit_code":2}' >&2
  exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
exec bun "$SCRIPT_DIR/driver.ts" "$PROMPT"
