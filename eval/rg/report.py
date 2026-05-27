#!/usr/bin/env python3
"""Generate a self-contained HTML dashboard for the rg agent eval."""

from __future__ import annotations

import argparse
import datetime as dt
import html
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[2]
EVAL_ROOT = Path(__file__).resolve().parent
DRIVER = EVAL_ROOT / "driver.py"
DEFAULT_OUTPUT = EVAL_ROOT / "report" / "index.html"


CASES: list[dict[str, Any]] = [
    {
        "id": "plain-symbol-search",
        "title": "Plain symbol search",
        "prompt": "Use only the Grep tool. Search for 'isArray' in the directory path `source` (not `src`) and list the first 3 hits.",
        "expect": {"pattern": "isArray", "contains": "source/index.ts"},
    },
    {
        "id": "count-mode",
        "title": "Count mode",
        "prompt": "Use only the Grep tool with output_mode set to count. Count how many times 'isArray' appears in the directory path `source` (not `src`).",
        "expect": {
            "pattern": "isArray",
            "output_mode": "count",
            "preview_regex": r"source/index\.ts:\s*\d+",
        },
    },
    {
        "id": "files-with-matches",
        "title": "Files with matches",
        "prompt": "Use only the Grep tool with output_mode files_with_matches. Find which files in the directory path `source` (not `src`) contain 'isAsyncFunction'.",
        "expect": {
            "pattern": "isAsyncFunction",
            "output_mode": "files_with_matches",
            "contains": "source/index.ts",
        },
    },
    {
        "id": "glob-restriction",
        "title": "Glob restriction",
        "prompt": "Use only the Grep tool with path `test` and glob set to `*.ts` to find where the regex `is\\.bigint` is tested.",
        "expect": {
            "pattern": "is\\.bigint",
            "glob": "*.ts",
            "contains": "test/test.ts",
        },
    },
    {
        "id": "regex-pattern",
        "title": "Regex pattern",
        "prompt": "Use only the Grep tool. Search for the regex 'isArray(Buffer|Like)' in the directory path `source` (not `src`).",
        "expect": {
            "pattern": "isArray(Buffer|Like)",
            "non_empty_preview": True,
        },
    },
    {
        "id": "no-match",
        "title": "No-match path",
        "prompt": "Use only the Grep tool. Search for 'zzz_no_such_symbol_xyzzy' in the directory path `source` (not `src`).",
        "expect": {
            "pattern": "zzz_no_such_symbol_xyzzy",
            "allow_empty_preview": True,
        },
    },
]


def read_tail(path: str | None, lines: int = 12) -> str:
    if not path:
        return ""
    try:
        content = Path(path).read_text(encoding="utf-8", errors="replace").splitlines()
    except FileNotFoundError:
        return ""
    return "\n".join(content[-lines:])


def redact_text(value: str) -> str:
    replacements = [
        (str(REPO_ROOT), "<repo>"),
        (str(Path.home()), "~"),
    ]
    for source, target in replacements:
        value = value.replace(source, target)
    return value


def sanitize_report(value: Any) -> Any:
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, list):
        return [sanitize_report(item) for item in value]
    if isinstance(value, dict):
        return {key: sanitize_report(item) for key, item in value.items()}
    return value


def has_call(calls: list[dict[str, Any]], key: str, expected: str) -> bool:
    return any(call.get(key) == expected for call in calls if isinstance(call, dict))


def add_check(checks: list[dict[str, Any]], label: str, ok: bool, detail: str) -> None:
    checks.append({"label": label, "ok": bool(ok), "detail": detail})


def score_result(result: dict[str, Any], expect: dict[str, Any]) -> list[dict[str, Any]]:
    calls = result.get("grep_tool_calls") if isinstance(result, dict) else []
    calls = calls if isinstance(calls, list) else []
    preview = str(result.get("grep_tool_result_preview", ""))
    output = str(result.get("output", ""))
    combined_text = f"{preview}\n{output}"
    checks: list[dict[str, Any]] = []

    add_check(checks, "Driver exit", result.get("exit_code") == 0, f"exit_code={result.get('exit_code')}")
    add_check(
        checks,
        "Grep tool used",
        int(result.get("grep_tool_call_count", 0)) >= 1,
        f"grep_tool_call_count={result.get('grep_tool_call_count', 0)}",
    )
    add_check(
        checks,
        "No Bash fallback",
        int(result.get("forbidden_tool_call_count", 0)) == 0,
        f"forbidden_tool_call_count={result.get('forbidden_tool_call_count', 0)}",
    )
    add_check(
        checks,
        "rg shim hit",
        int(result.get("shim_grep_hits", 0)) >= 1,
        f"shim_grep_hits={result.get('shim_grep_hits', 0)}",
    )
    add_check(
        checks,
        "mnemex rg hit",
        int(result.get("mnemex_rg_hits", 0)) >= 1
        and result.get("shim_reaches_mnemex_rg") is True,
        f"mnemex_rg_hits={result.get('mnemex_rg_hits', 0)}",
    )
    add_check(
        checks,
        "No absolute path leak",
        result.get("result_has_absolute_paths") is False,
        f"result_has_absolute_paths={result.get('result_has_absolute_paths')}",
    )
    add_check(
        checks,
        "No timeout",
        result.get("timed_out") is not True,
        f"timed_out={result.get('timed_out', False)}",
    )

    if pattern := expect.get("pattern"):
        add_check(checks, "Expected pattern", has_call(calls, "pattern", pattern), pattern)
    if output_mode := expect.get("output_mode"):
        add_check(
            checks,
            "Expected output mode",
            has_call(calls, "output_mode", output_mode),
            output_mode,
        )
    if glob := expect.get("glob"):
        add_check(checks, "Expected glob", has_call(calls, "glob", glob), glob)
    if contains := expect.get("contains"):
        add_check(checks, "Expected result text", contains in combined_text, contains)
    if preview_regex := expect.get("preview_regex"):
        add_check(
            checks,
            "Expected result shape",
            re.search(str(preview_regex), preview) is not None,
            str(preview_regex),
        )
    if expect.get("non_empty_preview"):
        add_check(
            checks,
            "Non-empty preview",
            len(preview.strip()) > 0,
            f"{len(preview.strip())} chars",
        )
    if expect.get("allow_empty_preview"):
        add_check(checks, "Empty preview allowed", True, "no-match case")

    return checks


def run_case(case: dict[str, Any], model: str, timeout: int) -> dict[str, Any]:
    started = time.time()
    command = [
        sys.executable,
        str(DRIVER),
        "--model",
        model,
        "--timeout",
        str(timeout),
        case["prompt"],
    ]

    try:
        proc = subprocess.run(
            command,
            cwd=REPO_ROOT,
            check=False,
            capture_output=True,
            text=True,
            timeout=timeout + 20,
        )
        try:
            result = json.loads(proc.stdout)
        except json.JSONDecodeError:
            result = {
                "exit_code": proc.returncode or 2,
                "error": "driver did not emit JSON",
                "stdout": proc.stdout[-4000:],
                "stderr": proc.stderr[-4000:],
            }
        if proc.stderr.strip():
            result["driver_stderr"] = proc.stderr.strip()[-4000:]
    except subprocess.TimeoutExpired as exc:
        result = {
            "exit_code": 124,
            "timed_out": True,
            "error": "report runner timed out waiting for driver",
            "stdout": (exc.stdout or "")[-4000:] if isinstance(exc.stdout, str) else "",
            "stderr": (exc.stderr or "")[-4000:] if isinstance(exc.stderr, str) else "",
        }

    log_files = result.get("log_files") if isinstance(result.get("log_files"), dict) else {}
    checks = score_result(result, case.get("expect", {}))
    passed = all(check["ok"] for check in checks)

    return {
        "id": case["id"],
        "title": case["title"],
        "prompt": case["prompt"],
        "expect": case.get("expect", {}),
        "passed": passed,
        "checks": checks,
        "duration_ms": result.get("duration_ms", int((time.time() - started) * 1000)),
        "result": result,
        "log_tails": {
            "rg_shim": read_tail(log_files.get("rg_shim")),
            "mnemex": read_tail(log_files.get("mnemex")),
            "stderr": read_tail(log_files.get("stderr")),
        },
    }


def build_report(cases: list[dict[str, Any]], model: str) -> dict[str, Any]:
    passed = sum(1 for case in cases if case["passed"])
    total_duration = sum(int(case.get("duration_ms") or 0) for case in cases)
    shim_hits = sum(int(case["result"].get("shim_grep_hits", 0)) for case in cases)
    mnemex_hits = sum(int(case["result"].get("mnemex_rg_hits", 0)) for case in cases)
    grep_calls = sum(int(case["result"].get("grep_tool_call_count", 0)) for case in cases)
    forbidden_calls = sum(int(case["result"].get("forbidden_tool_call_count", 0)) for case in cases)

    return {
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "suite": "Claude Code Grep -> mnemex rg",
        "model": model,
        "summary": {
            "total": len(cases),
            "passed": passed,
            "failed": len(cases) - passed,
            "pass_rate": round((passed / len(cases)) * 100, 1) if cases else 0,
            "duration_ms": total_duration,
            "grep_calls": grep_calls,
            "shim_hits": shim_hits,
            "mnemex_hits": mnemex_hits,
            "forbidden_calls": forbidden_calls,
        },
        "cases": cases,
    }


def ms(value: int | float | None) -> str:
    if value is None:
        return "0ms"
    value = int(value)
    if value >= 1000:
        return f"{value / 1000:.1f}s"
    return f"{value}ms"


def render_html(report: dict[str, Any]) -> str:
    safe_report = sanitize_report(report)
    data_json = json.dumps(safe_report, sort_keys=True).replace("</", "<\\/")
    title = html.escape(str(safe_report.get("suite", "Eval report")))
    generated_at = html.escape(str(safe_report.get("generated_at", "")))
    summary = safe_report["summary"]

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{title} report</title>
  <style>
    :root {{
      color-scheme: dark;
      --bg: #090d12;
      --panel: #0f151d;
      --panel-2: #141b24;
      --line: #263241;
      --line-soft: #1b2531;
      --text: #e6edf6;
      --muted: #94a3b8;
      --soft: #c6d0de;
      --accent: #64d994;
      --accent-2: #73b7ff;
      --danger: #ff6b7a;
      --warn: #f3c969;
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      --sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }}

    * {{ box-sizing: border-box; }}
    html, body {{ margin: 0; min-height: 100%; background: var(--bg); color: var(--text); }}
    body {{ font-family: var(--sans); letter-spacing: 0; }}
    button, input {{ font: inherit; }}

    .shell {{
      min-height: 100vh;
      display: grid;
      grid-template-rows: auto auto 1fr;
    }}

    header {{
      border-bottom: 1px solid var(--line);
      padding: 28px clamp(18px, 4vw, 48px) 22px;
      background: #0b1016;
    }}

    .header-row {{
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 24px;
    }}

    h1 {{
      margin: 0;
      font-size: clamp(28px, 4vw, 46px);
      line-height: 1.05;
      font-weight: 720;
      color: var(--text);
    }}

    .eyebrow {{
      margin: 0 0 10px;
      color: var(--accent-2);
      font: 13px/1.2 var(--mono);
      text-transform: uppercase;
    }}

    .subtitle {{
      margin: 12px 0 0;
      color: var(--muted);
      max-width: 760px;
      font-size: 15px;
      line-height: 1.55;
    }}

    .run-meta {{
      min-width: 260px;
      color: var(--muted);
      text-align: right;
      font: 13px/1.6 var(--mono);
    }}

    .status {{
      display: inline-flex;
      align-items: center;
      gap: 9px;
      margin-bottom: 9px;
      color: var(--accent);
      font-weight: 700;
    }}

    .status::before {{
      content: "";
      width: 9px;
      height: 9px;
      border-radius: 999px;
      background: var(--accent);
      box-shadow: 0 0 0 5px rgba(100, 217, 148, 0.12);
    }}

    .summary {{
      display: grid;
      grid-template-columns: repeat(6, minmax(120px, 1fr));
      gap: 1px;
      border-bottom: 1px solid var(--line);
      background: var(--line);
    }}

    .metric {{
      min-height: 96px;
      padding: 18px clamp(16px, 3vw, 28px);
      background: var(--panel);
    }}

    .metric-label {{
      color: var(--muted);
      font-size: 12px;
      text-transform: uppercase;
      line-height: 1.2;
    }}

    .metric-value {{
      display: block;
      margin-top: 10px;
      color: var(--text);
      font: 700 26px/1 var(--mono);
    }}

    .workspace {{
      display: grid;
      grid-template-columns: minmax(360px, 0.95fr) minmax(420px, 1.35fr);
      min-height: 0;
    }}

    .case-list {{
      border-right: 1px solid var(--line);
      background: #0b1016;
      min-width: 0;
    }}

    .toolbar {{
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 18px clamp(16px, 3vw, 28px);
      border-bottom: 1px solid var(--line);
    }}

    .toolbar h2 {{
      margin: 0;
      font-size: 15px;
      color: var(--soft);
      font-weight: 680;
    }}

    .filters {{
      display: inline-flex;
      border: 1px solid var(--line);
      background: #0d131a;
      border-radius: 8px;
      overflow: hidden;
    }}

    .filters button, .tabs button, .copy-button {{
      border: 0;
      background: transparent;
      color: var(--muted);
      cursor: pointer;
    }}

    .filters button {{
      padding: 8px 11px;
      font-size: 12px;
    }}

    .filters button.active {{
      background: var(--panel-2);
      color: var(--text);
    }}

    .case-row {{
      width: 100%;
      border: 0;
      border-bottom: 1px solid var(--line-soft);
      background: transparent;
      color: inherit;
      text-align: left;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 16px;
      padding: 18px clamp(16px, 3vw, 28px);
      cursor: pointer;
    }}

    .case-row:hover, .case-row.active {{
      background: var(--panel);
    }}

    .case-row h3 {{
      margin: 0 0 8px;
      font-size: 16px;
      line-height: 1.25;
    }}

    .case-row p {{
      margin: 0;
      color: var(--muted);
      font-size: 13px;
      line-height: 1.45;
      max-width: 68ch;
    }}

    .badge {{
      align-self: start;
      border: 1px solid var(--line);
      border-radius: 999px;
      padding: 5px 9px;
      font: 700 12px/1 var(--mono);
      color: var(--accent);
      background: rgba(100, 217, 148, 0.08);
    }}

    .badge.fail {{
      color: var(--danger);
      background: rgba(255, 107, 122, 0.08);
    }}

    .detail {{
      min-width: 0;
      background: var(--bg);
    }}

    .detail-header {{
      padding: 24px clamp(18px, 4vw, 36px);
      border-bottom: 1px solid var(--line);
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 20px;
      align-items: start;
    }}

    .detail-header h2 {{
      margin: 0;
      font-size: 24px;
      line-height: 1.15;
    }}

    .prompt {{
      margin: 12px 0 0;
      color: var(--muted);
      font-size: 14px;
      line-height: 1.55;
      max-width: 860px;
    }}

    .case-metrics {{
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      justify-content: flex-end;
    }}

    .mini {{
      border: 1px solid var(--line);
      color: var(--soft);
      border-radius: 8px;
      padding: 7px 9px;
      font: 12px/1 var(--mono);
      background: var(--panel);
    }}

    .tabs {{
      display: flex;
      gap: 2px;
      padding: 0 clamp(18px, 4vw, 36px);
      border-bottom: 1px solid var(--line);
      background: #0b1016;
    }}

    .tabs button {{
      padding: 15px 14px 13px;
      border-bottom: 2px solid transparent;
      font-size: 13px;
    }}

    .tabs button.active {{
      color: var(--text);
      border-bottom-color: var(--accent-2);
    }}

    .panel {{
      padding: 24px clamp(18px, 4vw, 36px) 36px;
    }}

    .checks {{
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 10px;
    }}

    .check {{
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 10px;
      align-items: start;
      padding: 12px 0;
      border-bottom: 1px solid var(--line-soft);
    }}

    .check-dot {{
      width: 10px;
      height: 10px;
      border-radius: 999px;
      margin-top: 5px;
      background: var(--accent);
    }}

    .check-dot.fail {{ background: var(--danger); }}
    .check strong {{ display: block; font-size: 14px; color: var(--text); }}
    .check span {{ display: block; margin-top: 4px; color: var(--muted); font: 12px/1.4 var(--mono); }}

    .tool-calls {{
      display: grid;
      gap: 10px;
    }}

    .tool-call {{
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 14px;
      font: 13px/1.55 var(--mono);
      overflow: auto;
    }}

    pre {{
      margin: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      color: #dce5ef;
      font: 12px/1.55 var(--mono);
    }}

    .log-grid {{
      display: grid;
      gap: 14px;
    }}

    .log-title {{
      color: var(--accent-2);
      margin: 0 0 7px;
      font: 12px/1.2 var(--mono);
      text-transform: uppercase;
    }}

    .raw-head {{
      display: flex;
      justify-content: flex-end;
      margin-bottom: 10px;
    }}

    .copy-button {{
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 8px 10px;
      background: var(--panel);
      font-size: 12px;
    }}

    .hidden {{ display: none !important; }}

    @media (max-width: 980px) {{
      .header-row, .detail-header {{ grid-template-columns: 1fr; display: grid; }}
      .run-meta {{ text-align: left; }}
      .summary {{ grid-template-columns: repeat(2, 1fr); }}
      .workspace {{ grid-template-columns: 1fr; }}
      .case-list {{ border-right: 0; border-bottom: 1px solid var(--line); }}
      .checks {{ grid-template-columns: 1fr; }}
      .case-metrics {{ justify-content: flex-start; }}
    }}
  </style>
</head>
<body>
  <div class="shell">
    <header>
      <div class="header-row">
        <div>
          <p class="eyebrow">rg plugin eval</p>
          <h1>{title}</h1>
          <p class="subtitle">End-to-end validation that Claude Code Grep calls route through the temporary rg shim and into mnemex rg against indexed testdata.</p>
        </div>
        <div class="run-meta">
          <div class="status" id="overall-status">PASS</div>
          <div>model: <span id="model"></span></div>
          <div>generated: <span>{generated_at}</span></div>
        </div>
      </div>
    </header>

    <section class="summary" aria-label="Eval summary">
      <div class="metric"><span class="metric-label">Pass rate</span><span class="metric-value" id="pass-rate">{summary["pass_rate"]}%</span></div>
      <div class="metric"><span class="metric-label">Cases</span><span class="metric-value" id="case-count">{summary["passed"]}/{summary["total"]}</span></div>
      <div class="metric"><span class="metric-label">Duration</span><span class="metric-value" id="duration">{ms(summary["duration_ms"])}</span></div>
      <div class="metric"><span class="metric-label">Grep calls</span><span class="metric-value" id="grep-calls">{summary["grep_calls"]}</span></div>
      <div class="metric"><span class="metric-label">Shim hits</span><span class="metric-value" id="shim-hits">{summary["shim_hits"]}</span></div>
      <div class="metric"><span class="metric-label">mnemex hits</span><span class="metric-value" id="mnemex-hits">{summary["mnemex_hits"]}</span></div>
    </section>

    <main class="workspace">
      <section class="case-list">
        <div class="toolbar">
          <h2>Cases</h2>
          <div class="filters" aria-label="Case filters">
            <button class="active" data-filter="all">All</button>
            <button data-filter="pass">Pass</button>
            <button data-filter="fail">Fail</button>
          </div>
        </div>
        <div id="case-list"></div>
      </section>

      <section class="detail">
        <div class="detail-header">
          <div>
            <h2 id="detail-title"></h2>
            <p class="prompt" id="detail-prompt"></p>
          </div>
          <div class="case-metrics" id="case-metrics"></div>
        </div>
        <nav class="tabs" aria-label="Case detail tabs">
          <button class="active" data-tab="checks">Checks</button>
          <button data-tab="tools">Tool Calls</button>
          <button data-tab="logs">Logs</button>
          <button data-tab="raw">Raw JSON</button>
        </nav>
        <div class="panel">
          <div id="tab-checks"></div>
          <div id="tab-tools" class="hidden"></div>
          <div id="tab-logs" class="hidden"></div>
          <div id="tab-raw" class="hidden"></div>
        </div>
      </section>
    </main>
  </div>

  <script id="report-data" type="application/json">{data_json}</script>
  <script>
    const report = JSON.parse(document.getElementById('report-data').textContent);
    const cases = report.cases || [];
    let filter = 'all';
    let activeCase = cases[0];
    let activeTab = 'checks';

    const qs = (selector) => document.querySelector(selector);
    const listEl = qs('#case-list');
    const detailTitle = qs('#detail-title');
    const detailPrompt = qs('#detail-prompt');
    const caseMetrics = qs('#case-metrics');

    qs('#model').textContent = report.model || 'unknown';
    qs('#overall-status').textContent = report.summary.failed === 0 ? 'PASS' : 'FAIL';

    function fmtMs(value) {{
      value = Number(value || 0);
      return value >= 1000 ? (value / 1000).toFixed(1) + 's' : value + 'ms';
    }}

    function esc(value) {{
      return String(value ?? '').replace(/[&<>"']/g, (char) => ({{
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#039;'
      }}[char]));
    }}

    function previewPrompt(prompt) {{
      return prompt.length > 158 ? prompt.slice(0, 155) + '...' : prompt;
    }}

    function visibleCases() {{
      return cases.filter((item) => {{
        if (filter === 'pass') return item.passed;
        if (filter === 'fail') return !item.passed;
        return true;
      }});
    }}

    function renderList() {{
      const rows = visibleCases();
      listEl.innerHTML = rows.map((item) => `
        <button class="case-row ${{activeCase && activeCase.id === item.id ? 'active' : ''}}" data-id="${{esc(item.id)}}">
          <span>
            <h3>${{esc(item.title)}}</h3>
            <p>${{esc(previewPrompt(item.prompt))}}</p>
          </span>
          <span class="badge ${{item.passed ? '' : 'fail'}}">${{item.passed ? 'PASS' : 'FAIL'}}</span>
        </button>
      `).join('');

      listEl.querySelectorAll('.case-row').forEach((row) => {{
        row.addEventListener('click', () => {{
          activeCase = cases.find((item) => item.id === row.dataset.id) || activeCase;
          render();
        }});
      }});
    }}

    function renderMetrics(item) {{
      const result = item.result || {{}};
      caseMetrics.innerHTML = [
        ['Duration', fmtMs(item.duration_ms)],
        ['Grep', result.grep_tool_call_count || 0],
        ['Shim', result.shim_grep_hits || 0],
        ['mnemex', result.mnemex_rg_hits || 0]
      ].map(([label, value]) => `<span class="mini">${{esc(label)}}: ${{esc(value)}}</span>`).join('');
    }}

    function renderChecks(item) {{
      qs('#tab-checks').innerHTML = `<div class="checks">${{item.checks.map((check) => `
        <div class="check">
          <span class="check-dot ${{check.ok ? '' : 'fail'}}"></span>
          <span><strong>${{esc(check.label)}}</strong><span>${{esc(check.detail)}}</span></span>
        </div>
      `).join('')}}</div>`;
    }}

    function renderTools(item) {{
      const calls = (item.result && item.result.grep_tool_calls) || [];
      const preview = item.result && item.result.grep_tool_result_preview;
      qs('#tab-tools').innerHTML = `
        <div class="tool-calls">
          ${{calls.length ? calls.map((call, index) => `
            <div class="tool-call"><pre>Grep call #${{index + 1}}\\n${{esc(JSON.stringify(call, null, 2))}}</pre></div>
          `).join('') : '<p class="prompt">No Grep calls captured.</p>'}}
          <div class="tool-call"><pre>result preview\\n${{esc(preview || '')}}</pre></div>
        </div>
      `;
    }}

    function renderLogs(item) {{
      const tails = item.log_tails || {{}};
      qs('#tab-logs').innerHTML = `
        <div class="log-grid">
          <div><p class="log-title">rg shim</p><div class="tool-call"><pre>${{esc(tails.rg_shim || 'No rg shim log tail captured.')}}</pre></div></div>
          <div><p class="log-title">mnemex</p><div class="tool-call"><pre>${{esc(tails.mnemex || 'No mnemex log tail captured.')}}</pre></div></div>
          <div><p class="log-title">stderr</p><div class="tool-call"><pre>${{esc(tails.stderr || 'No stderr output.')}}</pre></div></div>
        </div>
      `;
    }}

    function renderRaw(item) {{
      qs('#tab-raw').innerHTML = `
        <div class="raw-head"><button class="copy-button" id="copy-json">Copy JSON</button></div>
        <div class="tool-call"><pre>${{esc(JSON.stringify(item.result || {{}}, null, 2))}}</pre></div>
      `;
      qs('#copy-json').addEventListener('click', async () => {{
        await navigator.clipboard.writeText(JSON.stringify(item.result || {{}}, null, 2));
        qs('#copy-json').textContent = 'Copied';
        setTimeout(() => qs('#copy-json').textContent = 'Copy JSON', 1100);
      }});
    }}

    function renderTabs(item) {{
      ['checks', 'tools', 'logs', 'raw'].forEach((tab) => {{
        qs(`#tab-${{tab}}`).classList.toggle('hidden', tab !== activeTab);
        document.querySelector(`[data-tab="${{tab}}"]`).classList.toggle('active', tab === activeTab);
      }});
      renderChecks(item);
      renderTools(item);
      renderLogs(item);
      renderRaw(item);
      ['checks', 'tools', 'logs', 'raw'].forEach((tab) => {{
        qs(`#tab-${{tab}}`).classList.toggle('hidden', tab !== activeTab);
      }});
    }}

    function render() {{
      if (!activeCase && cases.length) activeCase = cases[0];
      renderList();
      if (!activeCase) return;
      detailTitle.textContent = activeCase.title;
      detailPrompt.textContent = activeCase.prompt;
      renderMetrics(activeCase);
      renderTabs(activeCase);
    }}

    document.querySelectorAll('[data-filter]').forEach((button) => {{
      button.addEventListener('click', () => {{
        filter = button.dataset.filter;
        document.querySelectorAll('[data-filter]').forEach((item) => item.classList.toggle('active', item === button));
        const rows = visibleCases();
        if (rows.length && !rows.find((item) => item.id === activeCase.id)) activeCase = rows[0];
        render();
      }});
    }});

    document.querySelectorAll('[data-tab]').forEach((button) => {{
      button.addEventListener('click', () => {{
        activeTab = button.dataset.tab;
        renderTabs(activeCase);
      }});
    }});

    render();
  </script>
</body>
</html>
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model", default="haiku", help="Claude Code model alias")
    parser.add_argument("--timeout", type=int, default=120, help="Per-case driver timeout")
    parser.add_argument(
        "--output",
        type=Path,
        default=DEFAULT_OUTPUT,
        help="Path for the generated HTML report",
    )
    args = parser.parse_args()

    rendered_cases = []
    for index, case in enumerate(CASES, start=1):
        print(f"[{index}/{len(CASES)}] {case['title']}", file=sys.stderr)
        rendered_cases.append(run_case(case, model=args.model, timeout=args.timeout))

    report = build_report(rendered_cases, model=args.model)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(render_html(report), encoding="utf-8")

    summary = report["summary"]
    print(
        f"wrote {args.output} ({summary['passed']}/{summary['total']} passed, "
        f"{ms(summary['duration_ms'])})"
    )
    return 0 if summary["failed"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
