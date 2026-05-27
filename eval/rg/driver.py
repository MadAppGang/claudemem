#!/usr/bin/env python3
"""Run one Claude Code x mnemex-rg eval case and emit JSON.

This driver is shared by the promptfoo smoke eval and the Inspect AI harness.
It launches Claude Code against the pinned rg testdata, injects a temporary
logging `rg` shim, routes that shim through the current repo's built
`dist/index.js`, and captures enough evidence to score the tool trajectory.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
TESTDATA = REPO_ROOT / "tests" / "testdata" / "rg-corpus"
DIST_CLI = REPO_ROOT / "dist" / "index.js"
VSCODE_RG = REPO_ROOT / "node_modules" / "@vscode" / "ripgrep" / "bin" / "rg"
RG_SHIM_PATH = Path.home() / ".local" / "bin" / "rg"
LOG_DIR = REPO_ROOT / "eval" / "rg" / "logs"

STARTUP_RG_RE = re.compile(r"args=(--version|--files\b)")
FORBIDDEN_TOOLS = {"Bash"}


class EvalError(RuntimeError):
    """Precondition or execution error that should be reported as JSON."""


def shell_quote(path: Path | str) -> str:
    return shlex.quote(str(path))


def require_preconditions(build_index: bool) -> None:
    if not TESTDATA.is_dir():
        raise EvalError(f"testdata missing at {TESTDATA}")
    if not DIST_CLI.is_file():
        raise EvalError(f"built CLI missing at {DIST_CLI}; run `bun run build`")
    if not VSCODE_RG.is_file():
        raise EvalError(f"bundled rg missing at {VSCODE_RG}; run `bun install`")
    if shutil.which("bun") is None:
        raise EvalError("bun not on PATH")
    if shutil.which("claude") is None:
        raise EvalError("claude CLI not on PATH")

    index_db = TESTDATA / ".mnemex" / "index.db"
    if not index_db.is_file():
        if not build_index:
            raise EvalError(f"testdata index missing at {TESTDATA / '.mnemex'}")
        subprocess.run(
            ["bun", str(DIST_CLI), "index", "--force"],
            cwd=TESTDATA,
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
        )


class TemporaryShims:
    """Install temporary logging shims and restore the user's rg afterwards."""

    def __init__(self, work_dir: Path, rg_trace: Path, mnemex_trace: Path) -> None:
        self.work_dir = work_dir
        self.bin_dir = work_dir / "bin"
        self.rg_trace = rg_trace
        self.mnemex_trace = mnemex_trace
        self.original_rg: bytes | None = None
        self.original_mode: int | None = None

    def __enter__(self) -> "TemporaryShims":
        self.bin_dir.mkdir(parents=True, exist_ok=True)
        RG_SHIM_PATH.parent.mkdir(parents=True, exist_ok=True)

        if RG_SHIM_PATH.exists():
            self.original_rg = RG_SHIM_PATH.read_bytes()
            self.original_mode = stat.S_IMODE(RG_SHIM_PATH.stat().st_mode)

        mnemex_wrapper = self.bin_dir / "mnemex"
        mnemex_wrapper.write_text(
            "\n".join(
                [
                    "#!/bin/sh",
                    "# MNEMEX_RG_EVAL_MNEMEX_SHIM",
                    'TRACE="${MNEMEX_SHIM_TRACE:-/tmp/mnemex-rg-eval-mnemex.log}"',
                    'echo "[$(date +%H:%M:%S)] MNEMEX_HIT pid=$$ ppid=$PPID args=$*" >> "$TRACE"',
                    f"exec bun {shell_quote(DIST_CLI)} \"$@\"",
                    "",
                ]
            ),
            encoding="utf-8",
        )
        mnemex_wrapper.chmod(0o755)

        RG_SHIM_PATH.write_text(
            "\n".join(
                [
                    "#!/bin/sh",
                    "# MNEMEX_RG_EVAL_RG_SHIM",
                    'TRACE="${RG_SHIM_TRACE:-/tmp/mnemex-rg-eval-rg.log}"',
                    'echo "[$(date +%H:%M:%S)] SHIM_HIT pid=$$ ppid=$PPID args=$*" >> "$TRACE"',
                    'exec mnemex rg "$@"',
                    "",
                ]
            ),
            encoding="utf-8",
        )
        RG_SHIM_PATH.chmod(0o755)
        return self

    def __exit__(self, *_exc: object) -> None:
        if self.original_rg is not None:
            RG_SHIM_PATH.write_bytes(self.original_rg)
            if self.original_mode is not None:
                RG_SHIM_PATH.chmod(self.original_mode)
        else:
            try:
                if RG_SHIM_PATH.read_text(encoding="utf-8").startswith("#!/bin/sh\n# MNEMEX_RG_EVAL_RG_SHIM"):
                    RG_SHIM_PATH.unlink()
            except FileNotFoundError:
                pass


def read_tail(path: Path, lines: int = 20) -> str:
    try:
        content = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except FileNotFoundError:
        return ""
    return "\n".join(content[-lines:])


def parse_stream_json(path: Path) -> dict[str, Any]:
    grep_calls: list[dict[str, Any]] = []
    grep_tool_ids: set[str] = set()
    all_tool_calls: list[dict[str, Any]] = []
    non_grep_tool_calls: list[dict[str, Any]] = []
    tool_result_previews: list[str] = []
    final_text_parts: list[str] = []
    tool_result_count = 0
    grep_tool_result_count = 0

    try:
        raw_lines = path.read_text(encoding="utf-8", errors="replace").splitlines()
    except FileNotFoundError:
        raw_lines = []

    for raw in raw_lines:
        try:
            event = json.loads(raw)
        except json.JSONDecodeError:
            continue

        event_type = event.get("type")
        message = event.get("message") or {}
        content = message.get("content") if isinstance(message, dict) else None
        if not isinstance(content, list):
            continue

        for item in content:
            if not isinstance(item, dict):
                continue
            if event_type == "assistant" and item.get("type") == "tool_use":
                tool_name = item.get("name")
                tool_input = item.get("input") or {}
                tool_call = {
                    "id": item.get("id"),
                    "name": tool_name,
                    "input": tool_input,
                }
                all_tool_calls.append(tool_call)
                if tool_name == "Grep":
                    if item.get("id"):
                        grep_tool_ids.add(str(item.get("id")))
                    grep_calls.append(
                        {
                            "pattern": tool_input.get("pattern"),
                            "path": tool_input.get("path"),
                            "glob": tool_input.get("glob"),
                            "head_limit": tool_input.get("head_limit"),
                            "output_mode": tool_input.get("output_mode"),
                        }
                    )
                else:
                    non_grep_tool_calls.append(tool_call)
            elif event_type == "user" and item.get("type") == "tool_result":
                tool_result_count += 1
                if str(item.get("tool_use_id")) not in grep_tool_ids:
                    continue
                grep_tool_result_count += 1
                result_content = item.get("content")
                if isinstance(result_content, list):
                    result_content = " ".join(
                        part.get("text", "")
                        for part in result_content
                        if isinstance(part, dict)
                    )
                if isinstance(result_content, str):
                    tool_result_previews.append(result_content[:2000])
            elif event_type == "assistant" and item.get("type") == "text":
                final_text_parts.append(item.get("text", ""))

    successful_previews = [
        preview
        for preview in tool_result_previews
        if preview.strip() and "<tool_use_error>" not in preview
    ]
    grep_result_preview = (
        successful_previews[0]
        if successful_previews
        else (tool_result_previews[0] if tool_result_previews else "")
    )

    return {
        "grep_tool_calls": grep_calls,
        "grep_tool_call_count": len(grep_calls),
        "all_tool_call_count": len(all_tool_calls),
        "non_grep_tool_call_count": len(non_grep_tool_calls),
        "non_grep_tool_calls": non_grep_tool_calls[:5],
        "forbidden_tool_call_count": sum(
            1 for call in non_grep_tool_calls if call.get("name") in FORBIDDEN_TOOLS
        ),
        "forbidden_tool_calls": [
            call for call in non_grep_tool_calls if call.get("name") in FORBIDDEN_TOOLS
        ][:5],
        "tool_result_count": tool_result_count,
        "grep_tool_result_count": grep_tool_result_count,
        "tool_error_count": sum(
            1 for preview in tool_result_previews if "<tool_use_error>" in preview
        ),
        "tool_result_previews": tool_result_previews[:5],
        "grep_tool_result_preview": grep_result_preview,
        "output": "\n".join(final_text_parts).strip(),
        "stream_event_count": len(raw_lines),
    }


def parse_trace(path: Path, kind: str) -> dict[str, Any]:
    try:
        lines = [
            line.rstrip("\n")
            for line in path.read_text(encoding="utf-8", errors="replace").splitlines()
            if line.strip()
        ]
    except FileNotFoundError:
        lines = []

    if kind == "rg":
        grep_lines = [line for line in lines if not STARTUP_RG_RE.search(line)]
        return {
            "shim_hits": len(lines),
            "shim_grep_hits": len(grep_lines),
            "shim_trace_tail": "\n".join(lines[-5:]),
        }

    mnemex_rg_lines = [line for line in lines if re.search(r"args=rg(\s|$)", line)]
    return {
        "mnemex_hits": len(lines),
        "mnemex_rg_hits": len(mnemex_rg_lines),
        "mnemex_trace_tail": "\n".join(lines[-5:]),
    }


def has_absolute_path_leak(text: str) -> bool:
    return bool(re.search(r"(^|\s)/(Users|private|tmp|var)/", text))


def run_case(
    prompt: str,
    *,
    model: str,
    timeout: int,
    build_index: bool,
    settings_only: bool,
) -> dict[str, Any]:
    require_preconditions(build_index=build_index)
    LOG_DIR.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="mnemex-rg-eval-") as tmp:
        work_dir = Path(tmp)
        rg_trace = work_dir / "rg-shim.log"
        mnemex_trace = work_dir / "mnemex-shim.log"
        cc_out = work_dir / "claude-code.jsonl"
        cc_err = work_dir / "claude-code.err"
        rg_trace.touch()
        mnemex_trace.touch()

        with TemporaryShims(work_dir, rg_trace, mnemex_trace) as shims:
            env = os.environ.copy()
            env["PATH"] = f"{shims.bin_dir}:{RG_SHIM_PATH.parent}:{env.get('PATH', '')}"
            env["RG_SHIM_TRACE"] = str(rg_trace)
            env["MNEMEX_SHIM_TRACE"] = str(mnemex_trace)
            if not settings_only:
                env["USE_BUILTIN_RIPGREP"] = "0"

            command = [
                "claude",
                "-p",
                prompt,
                "--allowedTools",
                "Grep",
                "--disallowedTools",
                "Bash",
                "--permission-mode",
                "acceptEdits",
                "--model",
                model,
                "--output-format",
                "stream-json",
                "--verbose",
            ]

            started = time.time()
            timed_out = False
            try:
                with cc_out.open("w", encoding="utf-8") as stdout, cc_err.open(
                    "w", encoding="utf-8"
                ) as stderr:
                    proc = subprocess.run(
                        command,
                        cwd=TESTDATA,
                        env=env,
                        stdout=stdout,
                        stderr=stderr,
                        text=True,
                        timeout=timeout,
                    )
                exit_code = proc.returncode
            except subprocess.TimeoutExpired:
                timed_out = True
                exit_code = 124
            duration_ms = int((time.time() - started) * 1000)

        parsed = parse_stream_json(cc_out)
        parsed.update(parse_trace(rg_trace, "rg"))
        parsed.update(parse_trace(mnemex_trace, "mnemex"))

        preview = parsed.get("grep_tool_result_preview", "")
        output = parsed.get("output", "")
        result: dict[str, Any] = {
            **parsed,
            "exit_code": exit_code,
            "timed_out": timed_out,
            "duration_ms": duration_ms,
            "model": model,
            "testdata": str(TESTDATA),
            "shim_reaches_mnemex_rg": parsed.get("mnemex_rg_hits", 0) >= 1,
            "result_has_absolute_paths": has_absolute_path_leak(preview)
            or has_absolute_path_leak(output),
            "stderr_tail": read_tail(cc_err),
        }

        run_id = f"{int(time.time())}-{os.getpid()}"
        shutil.copyfile(cc_out, LOG_DIR / f"cc-{run_id}.jsonl")
        shutil.copyfile(rg_trace, LOG_DIR / f"shim-{run_id}.log")
        shutil.copyfile(mnemex_trace, LOG_DIR / f"mnemex-{run_id}.log")
        shutil.copyfile(cc_err, LOG_DIR / f"stderr-{run_id}.log")
        result["log_files"] = {
            "claude_stream": str(LOG_DIR / f"cc-{run_id}.jsonl"),
            "rg_shim": str(LOG_DIR / f"shim-{run_id}.log"),
            "mnemex": str(LOG_DIR / f"mnemex-{run_id}.log"),
            "stderr": str(LOG_DIR / f"stderr-{run_id}.log"),
        }
        return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("prompt", help="Prompt passed to `claude -p`")
    parser.add_argument("--model", default="haiku", help="Claude Code model alias")
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--no-build-index", action="store_true")
    parser.add_argument(
        "--settings-only",
        action="store_true",
        help="Do not set USE_BUILTIN_RIPGREP in the launched Claude env",
    )
    args = parser.parse_args()

    try:
        result = run_case(
            args.prompt,
            model=args.model,
            timeout=args.timeout,
            build_index=not args.no_build_index,
            settings_only=args.settings_only,
        )
    except Exception as exc:
        result = {
            "error": str(exc),
            "exit_code": 2,
            "grep_tool_calls": [],
            "grep_tool_call_count": 0,
            "all_tool_call_count": 0,
            "non_grep_tool_call_count": 0,
            "non_grep_tool_calls": [],
            "forbidden_tool_call_count": 0,
            "forbidden_tool_calls": [],
            "shim_hits": 0,
            "shim_grep_hits": 0,
            "mnemex_hits": 0,
            "mnemex_rg_hits": 0,
            "shim_reaches_mnemex_rg": False,
        }

    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
