#!/usr/bin/env bun
/**
 * Generate a self-contained HTML dashboard for the rg agent eval.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;

type EvalCase = {
	id: string;
	title: string;
	prompt: string;
	expect: {
		pattern?: string;
		output_mode?: string;
		glob?: string;
		contains?: string;
		preview_regex?: string;
		non_empty_preview?: boolean;
		allow_empty_preview?: boolean;
	};
};

type Check = {
	label: string;
	ok: boolean;
	detail: string;
};

const __filename = fileURLToPath(import.meta.url);
const EVAL_ROOT = dirname(__filename);
const REPO_ROOT = resolve(EVAL_ROOT, "../..");
const DRIVER = join(EVAL_ROOT, "driver.ts");
const DEFAULT_OUTPUT = join(EVAL_ROOT, "report", "index.html");

const CASES: EvalCase[] = [
	{
		id: "plain-symbol-search",
		title: "Plain symbol search",
		prompt:
			"Use only the Grep tool. Search for 'isArray' in the directory path `source` (not `src`) and list the first 3 hits.",
		expect: { pattern: "isArray", contains: "source/index.ts" },
	},
	{
		id: "count-mode",
		title: "Count mode",
		prompt:
			"Use only the Grep tool with output_mode set to count. Count how many times 'isArray' appears in the directory path `source` (not `src`).",
		expect: {
			pattern: "isArray",
			output_mode: "count",
			preview_regex: "source/index\\.ts:\\s*\\d+",
		},
	},
	{
		id: "files-with-matches",
		title: "Files with matches",
		prompt:
			"Use only the Grep tool with output_mode files_with_matches. Find which files in the directory path `source` (not `src`) contain 'isAsyncFunction'.",
		expect: {
			pattern: "isAsyncFunction",
			output_mode: "files_with_matches",
			contains: "source/index.ts",
		},
	},
	{
		id: "glob-restriction",
		title: "Glob restriction",
		prompt:
			"Use only the Grep tool with path `test` and glob set to `*.ts` to find where the regex `is\\.bigint` is tested.",
		expect: {
			pattern: "is\\.bigint",
			glob: "*.ts",
			contains: "test/test.ts",
		},
	},
	{
		id: "regex-pattern",
		title: "Regex pattern",
		prompt:
			"Use only the Grep tool. Search for the regex 'isArray(Buffer|Like)' in the directory path `source` (not `src`).",
		expect: {
			pattern: "isArray(Buffer|Like)",
			non_empty_preview: true,
		},
	},
	{
		id: "no-match",
		title: "No-match path",
		prompt:
			"Use only the Grep tool. Search for 'zzz_no_such_symbol_xyzzy' in the directory path `source` (not `src`).",
		expect: {
			pattern: "zzz_no_such_symbol_xyzzy",
			allow_empty_preview: true,
		},
	},
];

function asRecord(value: unknown): JsonObject {
	return value && typeof value === "object" ? (value as JsonObject) : {};
}

function asArray(value: unknown): JsonObject[] {
	return Array.isArray(value)
		? (value.filter((item) => item && typeof item === "object") as JsonObject[])
		: [];
}

function readTail(path: unknown, lines = 12): string {
	if (typeof path !== "string") return "";
	try {
		return readFileSync(path, "utf8")
			.split(/\r?\n/)
			.filter(Boolean)
			.slice(-lines)
			.join("\n");
	} catch {
		return "";
	}
}

function redactText(value: string): string {
	return value.replaceAll(REPO_ROOT, "<repo>").replaceAll(homedir(), "~");
}

function sanitizeReport(value: unknown): unknown {
	if (typeof value === "string") return redactText(value);
	if (Array.isArray(value)) return value.map((item) => sanitizeReport(item));
	if (value && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, sanitizeReport(item)]),
		);
	}
	return value;
}

function hasCall(calls: JsonObject[], key: string, expected: string): boolean {
	return calls.some((call) => call[key] === expected);
}

function addCheck(
	checks: Check[],
	label: string,
	ok: boolean,
	detail: string,
): void {
	checks.push({ label, ok, detail });
}

function scoreResult(result: JsonObject, expect: EvalCase["expect"]): Check[] {
	const calls = asArray(result.grep_tool_calls);
	const preview = String(result.grep_tool_result_preview ?? "");
	const output = String(result.output ?? "");
	const combinedText = `${preview}\n${output}`;
	const checks: Check[] = [];

	addCheck(
		checks,
		"Driver exit",
		result.exit_code === 0,
		`exit_code=${result.exit_code}`,
	);
	addCheck(
		checks,
		"Grep tool used",
		Number(result.grep_tool_call_count ?? 0) >= 1,
		`grep_tool_call_count=${result.grep_tool_call_count ?? 0}`,
	);
	addCheck(
		checks,
		"No Bash fallback",
		Number(result.forbidden_tool_call_count ?? 0) === 0,
		`forbidden_tool_call_count=${result.forbidden_tool_call_count ?? 0}`,
	);
	addCheck(
		checks,
		"rg shim hit",
		Number(result.shim_grep_hits ?? 0) >= 1,
		`shim_grep_hits=${result.shim_grep_hits ?? 0}`,
	);
	addCheck(
		checks,
		"mnemex rg hit",
		Number(result.mnemex_rg_hits ?? 0) >= 1 &&
			result.shim_reaches_mnemex_rg === true,
		`mnemex_rg_hits=${result.mnemex_rg_hits ?? 0}`,
	);
	addCheck(
		checks,
		"No absolute path leak",
		result.result_has_absolute_paths === false,
		`result_has_absolute_paths=${String(result.result_has_absolute_paths)}`,
	);
	addCheck(
		checks,
		"No timeout",
		result.timed_out !== true,
		`timed_out=${String(result.timed_out ?? false)}`,
	);

	if (expect.pattern)
		addCheck(
			checks,
			"Expected pattern",
			hasCall(calls, "pattern", expect.pattern),
			expect.pattern,
		);
	if (expect.output_mode) {
		addCheck(
			checks,
			"Expected output mode",
			hasCall(calls, "output_mode", expect.output_mode),
			expect.output_mode,
		);
	}
	if (expect.glob)
		addCheck(
			checks,
			"Expected glob",
			hasCall(calls, "glob", expect.glob),
			expect.glob,
		);
	if (expect.contains)
		addCheck(
			checks,
			"Expected result text",
			combinedText.includes(expect.contains),
			expect.contains,
		);
	if (expect.preview_regex) {
		addCheck(
			checks,
			"Expected result shape",
			new RegExp(expect.preview_regex).test(preview),
			expect.preview_regex,
		);
	}
	if (expect.non_empty_preview) {
		addCheck(
			checks,
			"Non-empty preview",
			preview.trim().length > 0,
			`${preview.trim().length} chars`,
		);
	}
	if (expect.allow_empty_preview) {
		addCheck(checks, "Empty preview allowed", true, "no-match case");
	}

	return checks;
}

function runCase(
	testCase: EvalCase,
	model: string,
	timeout: number,
): JsonObject {
	const started = Date.now();
	const proc = spawnSync(
		"bun",
		[DRIVER, "--model", model, "--timeout", String(timeout), testCase.prompt],
		{
			cwd: REPO_ROOT,
			encoding: "utf8",
			timeout: (timeout + 20) * 1000,
			maxBuffer: 20 * 1024 * 1024,
		},
	);

	let result: JsonObject;
	try {
		result = JSON.parse(proc.stdout ?? "{}") as JsonObject;
	} catch {
		result = {
			exit_code: proc.status ?? 2,
			error: "driver did not emit JSON",
			stdout: String(proc.stdout ?? "").slice(-4000),
			stderr: String(proc.stderr ?? "").slice(-4000),
		};
	}

	if (String(proc.stderr ?? "").trim()) {
		result.driver_stderr = String(proc.stderr).trim().slice(-4000);
	}
	const logFiles = asRecord(result.log_files);
	const checks = scoreResult(result, testCase.expect);

	return {
		id: testCase.id,
		title: testCase.title,
		prompt: testCase.prompt,
		expect: testCase.expect,
		passed: checks.every((check) => check.ok),
		checks,
		duration_ms: result.duration_ms ?? Date.now() - started,
		result,
		log_tails: {
			rg_shim: readTail(logFiles.rg_shim),
			mnemex: readTail(logFiles.mnemex),
			stderr: readTail(logFiles.stderr),
		},
	};
}

function buildReport(cases: JsonObject[], model: string): JsonObject {
	const passed = cases.filter((testCase) => testCase.passed).length;
	const totalDuration = cases.reduce(
		(sum, testCase) => sum + Number(testCase.duration_ms ?? 0),
		0,
	);
	const sumResult = (key: string) =>
		cases.reduce(
			(sum, testCase) => sum + Number(asRecord(testCase.result)[key] ?? 0),
			0,
		);

	return {
		generated_at: new Date().toISOString(),
		suite: "Claude Code Grep -> mnemex rg",
		model,
		summary: {
			total: cases.length,
			passed,
			failed: cases.length - passed,
			pass_rate: cases.length
				? Math.round((passed / cases.length) * 1000) / 10
				: 0,
			duration_ms: totalDuration,
			grep_calls: sumResult("grep_tool_call_count"),
			shim_hits: sumResult("shim_grep_hits"),
			mnemex_hits: sumResult("mnemex_rg_hits"),
			forbidden_calls: sumResult("forbidden_tool_call_count"),
		},
		cases,
	};
}

function ms(value: unknown): string {
	const numberValue = Number(value ?? 0);
	return numberValue >= 1000
		? `${(numberValue / 1000).toFixed(1)}s`
		: `${numberValue}ms`;
}

function escapeHtml(value: unknown): string {
	return String(value ?? "")
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

function renderHtml(report: JsonObject): string {
	const safeReport = sanitizeReport(report) as JsonObject;
	const dataJson = JSON.stringify(safeReport).replaceAll("</", "<\\/");
	const summary = asRecord(safeReport.summary);
	const title = escapeHtml(safeReport.suite ?? "Eval report");
	const generatedAt = escapeHtml(safeReport.generated_at);

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} report</title>
  <style>
    :root {
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
      --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
      --sans: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }
    * { box-sizing: border-box; }
    html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); }
    body { font-family: var(--sans); letter-spacing: 0; }
    button { font: inherit; }
    header { border-bottom: 1px solid var(--line); padding: 28px clamp(18px, 4vw, 48px) 22px; background: #0b1016; }
    .header-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
    h1 { margin: 0; font-size: clamp(28px, 4vw, 46px); line-height: 1.05; font-weight: 720; }
    .eyebrow { margin: 0 0 10px; color: var(--accent-2); font: 13px/1.2 var(--mono); text-transform: uppercase; }
    .subtitle { margin: 12px 0 0; color: var(--muted); max-width: 760px; font-size: 15px; line-height: 1.55; }
    .run-meta { min-width: 260px; color: var(--muted); text-align: right; font: 13px/1.6 var(--mono); }
    .status { display: inline-flex; align-items: center; gap: 9px; margin-bottom: 9px; color: var(--accent); font-weight: 700; }
    .status::before { content: ""; width: 9px; height: 9px; border-radius: 999px; background: var(--accent); box-shadow: 0 0 0 5px rgba(100, 217, 148, 0.12); }
    .summary { display: grid; grid-template-columns: repeat(6, minmax(120px, 1fr)); gap: 1px; border-bottom: 1px solid var(--line); background: var(--line); }
    .metric { min-height: 96px; padding: 18px clamp(16px, 3vw, 28px); background: var(--panel); }
    .metric-label { color: var(--muted); font-size: 12px; text-transform: uppercase; line-height: 1.2; }
    .metric-value { display: block; margin-top: 10px; color: var(--text); font: 700 26px/1 var(--mono); }
    .workspace { display: grid; grid-template-columns: minmax(360px, 0.95fr) minmax(420px, 1.35fr); min-height: 0; }
    .case-list { border-right: 1px solid var(--line); background: #0b1016; min-width: 0; }
    .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 18px clamp(16px, 3vw, 28px); border-bottom: 1px solid var(--line); }
    .toolbar h2 { margin: 0; font-size: 15px; color: var(--soft); font-weight: 680; }
    .filters { display: inline-flex; border: 1px solid var(--line); background: #0d131a; border-radius: 8px; overflow: hidden; }
    .filters button, .tabs button, .copy-button { border: 0; background: transparent; color: var(--muted); cursor: pointer; }
    .filters button { padding: 8px 11px; font-size: 12px; }
    .filters button.active { background: var(--panel-2); color: var(--text); }
    .case-row { width: 100%; border: 0; border-bottom: 1px solid var(--line-soft); background: transparent; color: inherit; text-align: left; display: grid; grid-template-columns: 1fr auto; gap: 16px; padding: 18px clamp(16px, 3vw, 28px); cursor: pointer; }
    .case-row:hover, .case-row.active { background: var(--panel); }
    .case-row h3 { margin: 0 0 8px; font-size: 16px; line-height: 1.25; }
    .case-row p { margin: 0; color: var(--muted); font-size: 13px; line-height: 1.45; max-width: 68ch; }
    .badge { align-self: start; border: 1px solid var(--line); border-radius: 999px; padding: 5px 9px; font: 700 12px/1 var(--mono); color: var(--accent); background: rgba(100, 217, 148, 0.08); }
    .badge.fail { color: var(--danger); background: rgba(255, 107, 122, 0.08); }
    .detail { min-width: 0; background: var(--bg); }
    .detail-header { padding: 24px clamp(18px, 4vw, 36px); border-bottom: 1px solid var(--line); display: grid; grid-template-columns: 1fr auto; gap: 20px; align-items: start; }
    .detail-header h2 { margin: 0; font-size: 24px; line-height: 1.15; }
    .prompt { margin: 12px 0 0; color: var(--muted); font-size: 14px; line-height: 1.55; max-width: 860px; }
    .case-metrics { display: flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
    .mini { border: 1px solid var(--line); color: var(--soft); border-radius: 8px; padding: 7px 9px; font: 12px/1 var(--mono); background: var(--panel); }
    .tabs { display: flex; gap: 2px; padding: 0 clamp(18px, 4vw, 36px); border-bottom: 1px solid var(--line); background: #0b1016; }
    .tabs button { padding: 15px 14px 13px; border-bottom: 2px solid transparent; font-size: 13px; }
    .tabs button.active { color: var(--text); border-bottom-color: var(--accent-2); }
    .panel { padding: 24px clamp(18px, 4vw, 36px) 36px; }
    .checks { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
    .check { display: grid; grid-template-columns: auto 1fr; gap: 10px; align-items: start; padding: 12px 0; border-bottom: 1px solid var(--line-soft); }
    .check-dot { width: 10px; height: 10px; border-radius: 999px; margin-top: 5px; background: var(--accent); }
    .check-dot.fail { background: var(--danger); }
    .check strong { display: block; font-size: 14px; color: var(--text); }
    .check span { display: block; margin-top: 4px; color: var(--muted); font: 12px/1.4 var(--mono); }
    .tool-call { border: 1px solid var(--line); background: var(--panel); border-radius: 8px; padding: 14px; font: 13px/1.55 var(--mono); overflow: auto; margin-bottom: 10px; }
    pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; color: #dce5ef; font: 12px/1.55 var(--mono); }
    .log-title { color: var(--accent-2); margin: 0 0 7px; font: 12px/1.2 var(--mono); text-transform: uppercase; }
    .hidden { display: none !important; }
    @media (max-width: 980px) {
      .header-row, .detail-header { grid-template-columns: 1fr; display: grid; }
      .run-meta { text-align: left; }
      .summary { grid-template-columns: repeat(2, 1fr); }
      .workspace { grid-template-columns: 1fr; }
      .case-list { border-right: 0; border-bottom: 1px solid var(--line); }
      .checks { grid-template-columns: 1fr; }
      .case-metrics { justify-content: flex-start; }
    }
  </style>
</head>
<body>
  <header>
    <div class="header-row">
      <div>
        <p class="eyebrow">rg plugin eval</p>
        <h1>${title}</h1>
        <p class="subtitle">End-to-end validation that Claude Code Grep calls route through the temporary rg shim and into mnemex rg against indexed testdata.</p>
      </div>
      <div class="run-meta">
        <div class="status">PASS</div>
        <div>model: <span id="model"></span></div>
        <div>generated: <span>${generatedAt}</span></div>
      </div>
    </div>
  </header>
  <section class="summary" aria-label="Eval summary">
    <div class="metric"><span class="metric-label">Pass rate</span><span class="metric-value">${summary.pass_rate}%</span></div>
    <div class="metric"><span class="metric-label">Cases</span><span class="metric-value">${summary.passed}/${summary.total}</span></div>
    <div class="metric"><span class="metric-label">Duration</span><span class="metric-value">${ms(summary.duration_ms)}</span></div>
    <div class="metric"><span class="metric-label">Grep calls</span><span class="metric-value">${summary.grep_calls}</span></div>
    <div class="metric"><span class="metric-label">Shim hits</span><span class="metric-value">${summary.shim_hits}</span></div>
    <div class="metric"><span class="metric-label">mnemex hits</span><span class="metric-value">${summary.mnemex_hits}</span></div>
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
  <script id="report-data" type="application/json">${dataJson}</script>
  <script>
    const report = JSON.parse(document.getElementById('report-data').textContent);
    const cases = report.cases || [];
    let filter = 'all';
    let activeCase = cases[0];
    let activeTab = 'checks';
    const qs = (selector) => document.querySelector(selector);
    const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[ch]));
    const ms = (value) => Number(value || 0) >= 1000 ? (Number(value) / 1000).toFixed(1) + 's' : String(value || 0) + 'ms';
    qs('#model').textContent = report.model || '';
    function filteredCases() {
      if (filter === 'pass') return cases.filter((item) => item.passed);
      if (filter === 'fail') return cases.filter((item) => !item.passed);
      return cases;
    }
    function renderList() {
      qs('#case-list').innerHTML = filteredCases().map((item, index) => \`
        <button class="case-row \${activeCase && activeCase.id === item.id ? 'active' : ''}" data-id="\${escapeHtml(item.id)}">
          <span><h3>\${escapeHtml(item.title)}</h3><p>\${escapeHtml(item.prompt)}</p></span>
          <span class="badge \${item.passed ? '' : 'fail'}">\${item.passed ? 'PASS' : 'FAIL'}</span>
        </button>
      \`).join('');
      qs('#case-list').querySelectorAll('.case-row').forEach((row) => {
        row.addEventListener('click', () => {
          activeCase = cases.find((item) => item.id === row.dataset.id) || activeCase;
          render();
        });
      });
    }
    function renderChecks() {
      qs('#tab-checks').innerHTML = '<div class="checks">' + (activeCase.checks || []).map((check) => \`
        <div class="check"><span class="check-dot \${check.ok ? '' : 'fail'}"></span><span><strong>\${escapeHtml(check.label)}</strong><span>\${escapeHtml(check.detail)}</span></span></div>
      \`).join('') + '</div>';
    }
    function renderTools() {
      const calls = (activeCase.result && activeCase.result.grep_tool_calls) || [];
      const preview = activeCase.result && activeCase.result.grep_tool_result_preview ? activeCase.result.grep_tool_result_preview : 'No result preview.';
      qs('#tab-tools').innerHTML = calls.map((call, index) => \`
        <div class="tool-call"><strong>Grep call #\${index + 1}</strong><pre>\${escapeHtml(JSON.stringify(call, null, 2))}</pre></div>
      \`).join('') + \`<div class="tool-call"><strong>result preview</strong><pre>\${escapeHtml(preview)}</pre></div>\`;
    }
    function renderLogs() {
      const logs = activeCase.log_tails || {};
      qs('#tab-logs').innerHTML = ['rg_shim', 'mnemex', 'stderr'].map((key) => \`
        <p class="log-title">\${escapeHtml(key.replace('_', ' '))}</p>
        <div class="tool-call"><pre>\${escapeHtml(logs[key] || 'No output.')}</pre></div>
      \`).join('');
    }
    function renderRaw() {
      qs('#tab-raw').innerHTML = \`<div class="tool-call"><pre>\${escapeHtml(JSON.stringify(activeCase, null, 2))}</pre></div>\`;
    }
    function renderDetail() {
      if (!activeCase) return;
      qs('#detail-title').textContent = activeCase.title;
      qs('#detail-prompt').textContent = activeCase.prompt;
      const result = activeCase.result || {};
      qs('#case-metrics').innerHTML = [
        ['Duration', ms(activeCase.duration_ms)],
        ['Grep', result.grep_tool_call_count || 0],
        ['Shim', result.shim_grep_hits || 0],
        ['mnemex', result.mnemex_rg_hits || 0],
      ].map(([label, value]) => \`<span class="mini">\${label}: \${value}</span>\`).join('');
      renderChecks();
      renderTools();
      renderLogs();
      renderRaw();
      ['checks', 'tools', 'logs', 'raw'].forEach((tab) => {
        qs('#tab-' + tab).classList.toggle('hidden', tab !== activeTab);
      });
    }
    function render() {
      renderList();
      renderDetail();
    }
    document.querySelectorAll('.filters button').forEach((button) => {
      button.addEventListener('click', () => {
        filter = button.dataset.filter;
        document.querySelectorAll('.filters button').forEach((item) => item.classList.toggle('active', item === button));
        renderList();
      });
    });
    document.querySelectorAll('.tabs button').forEach((button) => {
      button.addEventListener('click', () => {
        activeTab = button.dataset.tab;
        document.querySelectorAll('.tabs button').forEach((item) => item.classList.toggle('active', item === button));
        renderDetail();
      });
    });
    render();
  </script>
</body>
</html>
`;
}

function parseArgs(argv: string[]): {
	model: string;
	timeout: number;
	output: string;
} {
	let model = "haiku";
	let timeout = 120;
	let output = DEFAULT_OUTPUT;
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--model") model = argv[++index] ?? model;
		else if (arg === "--timeout") timeout = Number(argv[++index] ?? timeout);
		else if (arg === "--output") output = resolve(argv[++index] ?? output);
	}
	return { model, timeout, output };
}

const args = parseArgs(Bun.argv.slice(2));
if (!existsSync(DRIVER)) {
	throw new Error(`driver missing at ${DRIVER}`);
}

const cases: JsonObject[] = [];
for (const [index, testCase] of CASES.entries()) {
	console.error(`[${index + 1}/${CASES.length}] ${testCase.title}`);
	cases.push(runCase(testCase, args.model, args.timeout));
}

const report = buildReport(cases, args.model);
mkdirSync(dirname(args.output), { recursive: true });
writeFileSync(args.output, renderHtml(report), "utf8");

const summary = asRecord(report.summary);
console.log(
	`wrote ${args.output} (${summary.passed}/${summary.total} passed, ${ms(summary.duration_ms)})`,
);
