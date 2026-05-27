"""Inspect AI eval for Claude Code -> Grep -> mnemex rg plugin behavior.

Run from the repo root:

    inspect eval eval/rg/inspect_eval.py@rg_plugin

This task does not ask Inspect to call a model directly. The solver delegates
to driver.py, which launches `claude -p` and records the real tool trajectory.
"""

from __future__ import annotations

import asyncio
import json
import re
import sys
from pathlib import Path
from typing import Any

from inspect_ai import Task, task
from inspect_ai.dataset import Sample
from inspect_ai.model import ModelOutput
from inspect_ai.scorer import CORRECT, INCORRECT, Score, Target, accuracy, scorer, stderr
from inspect_ai.solver import Generate, TaskState, solver


DRIVER = Path(__file__).resolve().parent / "driver.py"


CASES: list[Sample] = [
    Sample(
        id="plain-symbol-search",
        input="Use only the Grep tool. Search for 'isArray' in the directory path `source` (not `src`) and list the first 3 hits.",
        target="Grep routes through mnemex rg and returns source/index.ts",
        metadata={"pattern": "isArray", "contains": "source/index.ts"},
    ),
    Sample(
        id="count-mode",
        input="Use only the Grep tool with output_mode set to count. Count how many times 'isArray' appears in the directory path `source` (not `src`).",
        target="Count mode reaches mnemex rg and returns file counts",
        metadata={
            "pattern": "isArray",
            "output_mode": "count",
            "preview_regex": r"source/index\.ts:\s*\d+",
        },
    ),
    Sample(
        id="files-with-matches",
        input="Use only the Grep tool with output_mode files_with_matches. Find which files in the directory path `source` (not `src`) contain 'isAsyncFunction'.",
        target="Files-with-matches mode reaches mnemex rg and returns source/index.ts",
        metadata={
            "pattern": "isAsyncFunction",
            "output_mode": "files_with_matches",
            "contains": "source/index.ts",
        },
    ),
    Sample(
        id="glob-restriction",
        input="Use only the Grep tool with path `test` and glob set to `*.ts` to find where the regex `is\\.bigint` is tested.",
        target="Glob restriction reaches mnemex rg and returns test/test.ts",
        metadata={
            "pattern": "is\\.bigint",
            "glob": "*.ts",
            "contains": "test/test.ts",
        },
    ),
    Sample(
        id="regex-pattern",
        input="Use only the Grep tool. Search for the regex 'isArray(Buffer|Like)' in the directory path `source` (not `src`).",
        target="Regex pattern reaches mnemex rg and produces a non-empty result",
        metadata={
            "pattern": "isArray(Buffer|Like)",
            "non_empty_preview": True,
        },
    ),
    Sample(
        id="no-match",
        input="Use only the Grep tool. Search for 'zzz_no_such_symbol_xyzzy' in the directory path `source` (not `src`).",
        target="No-match search still reaches mnemex rg without failing the driver",
        metadata={
            "pattern": "zzz_no_such_symbol_xyzzy",
            "allow_empty_preview": True,
        },
    ),
]


@solver
def claude_code_rg(model: str = "haiku", timeout: int = 120):
    async def solve(state: TaskState, _generate: Generate) -> TaskState:
        proc = await asyncio.create_subprocess_exec(
            sys.executable,
            str(DRIVER),
            "--model",
            model,
            "--timeout",
            str(timeout),
            state.input_text,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr_bytes = await proc.communicate()

        try:
            result = json.loads(stdout.decode("utf-8"))
        except json.JSONDecodeError:
            result = {
                "exit_code": proc.returncode or 2,
                "error": "driver did not emit JSON",
                "stdout": stdout.decode("utf-8", errors="replace")[-2000:],
                "stderr": stderr_bytes.decode("utf-8", errors="replace")[-2000:],
            }

        if proc.returncode not in (0, None) and "driver_returncode" not in result:
            result["driver_returncode"] = proc.returncode
        stderr_text = stderr_bytes.decode("utf-8", errors="replace").strip()
        if stderr_text:
            result["driver_stderr"] = stderr_text[-2000:]

        state.output = ModelOutput.from_content(
            model=f"claude-code/{model}",
            content=json.dumps(result, sort_keys=True),
        )
        state.completed = True
        return state

    return solve


def _result(state: TaskState) -> dict[str, Any]:
    try:
        value = json.loads(state.output.completion)
    except json.JSONDecodeError:
        return {"error": "completion was not JSON", "raw": state.output.completion}
    return value if isinstance(value, dict) else {"error": "completion was not an object"}


def _tool_calls(result: dict[str, Any]) -> list[dict[str, Any]]:
    calls = result.get("grep_tool_calls", [])
    return calls if isinstance(calls, list) else []


def _has_call_matching(calls: list[dict[str, Any]], key: str, expected: str) -> bool:
    return any(call.get(key) == expected for call in calls if isinstance(call, dict))


@scorer(metrics=[accuracy(), stderr()])
def rg_contract():
    async def score(state: TaskState, _target: Target) -> Score:
        result = _result(state)
        metadata = state.metadata or {}
        calls = _tool_calls(result)
        preview = str(result.get("grep_tool_result_preview", ""))
        final_output = str(result.get("output", ""))
        combined_text = f"{preview}\n{final_output}"

        checks: dict[str, bool] = {
            "driver_exit_zero": result.get("exit_code") == 0,
            "grep_tool_called": int(result.get("grep_tool_call_count", 0)) >= 1,
            "rg_shim_hit": int(result.get("shim_grep_hits", 0)) >= 1,
            "mnemex_rg_hit": int(result.get("mnemex_rg_hits", 0)) >= 1
            and result.get("shim_reaches_mnemex_rg") is True,
            "no_absolute_path_leak": result.get("result_has_absolute_paths") is False,
            "not_timed_out": result.get("timed_out") is not True,
            "no_forbidden_tools": int(result.get("forbidden_tool_call_count", 0)) == 0,
        }

        if pattern := metadata.get("pattern"):
            checks["expected_pattern"] = _has_call_matching(calls, "pattern", str(pattern))
        if output_mode := metadata.get("output_mode"):
            checks["expected_output_mode"] = _has_call_matching(
                calls, "output_mode", str(output_mode)
            )
        if glob := metadata.get("glob"):
            checks["expected_glob"] = _has_call_matching(calls, "glob", str(glob))
        if contains := metadata.get("contains"):
            checks["expected_text_present"] = str(contains) in combined_text
        if preview_regex := metadata.get("preview_regex"):
            checks["expected_regex_present"] = re.search(str(preview_regex), preview) is not None
        if metadata.get("non_empty_preview"):
            checks["non_empty_preview"] = len(preview.strip()) > 0
        if metadata.get("allow_empty_preview"):
            checks["empty_preview_allowed"] = True

        passed = all(checks.values())
        return Score(
            value=CORRECT if passed else INCORRECT,
            answer=json.dumps(checks, sort_keys=True),
            explanation=json.dumps(result, indent=2, sort_keys=True),
            metadata={"checks": checks, "log_files": result.get("log_files", {})},
        )

    return score


@task
def rg_plugin(model: str = "haiku", timeout: int = 120) -> Task:
    return Task(
        dataset=CASES,
        solver=claude_code_rg(model=model, timeout=timeout),
        scorer=rg_contract(),
    )
