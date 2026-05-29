#!/usr/bin/env bun
/**
 * Run one Claude Code x mnemex-rg eval case and emit JSON.
 *
 * This driver is shared by the promptfoo smoke eval and the HTML report. It
 * launches Claude Code against the pinned rg testdata, injects a temporary
 * logging `rg` shim, routes that shim through the current repo's built
 * `dist/index.js`, and captures enough evidence to score the tool trajectory.
 */

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type JsonObject = Record<string, unknown>;
type ToolCall = {
	id?: unknown;
	name?: unknown;
	input?: Record<string, unknown>;
};

const __filename = fileURLToPath(import.meta.url);
const EVAL_ROOT = dirname(__filename);
const REPO_ROOT = resolve(EVAL_ROOT, "../..");
const TESTDATA = join(REPO_ROOT, "tests", "testdata", "rg-corpus");
const DIST_CLI = join(REPO_ROOT, "dist", "index.js");
const VSCODE_RG = join(
	REPO_ROOT,
	"node_modules",
	"@vscode",
	"ripgrep",
	"bin",
	"rg",
);
const RG_SHIM_PATH = join(homedir(), ".local", "bin", "rg");
const LOG_DIR = join(REPO_ROOT, "eval", "rg", "logs");

const STARTUP_RG_RE = /args=(--version|--files\b)/;
const FORBIDDEN_TOOLS = new Set(["Bash"]);

class DriverError extends Error {}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function commandExists(command: string): boolean {
	const result = spawnSync("sh", ["-lc", `command -v ${shellQuote(command)}`], {
		stdio: "ignore",
	});
	return result.status === 0;
}

function requirePreconditions(buildIndex: boolean): void {
	if (!existsSync(TESTDATA)) {
		throw new DriverError(`testdata missing at ${TESTDATA}`);
	}
	if (!existsSync(DIST_CLI)) {
		throw new DriverError(
			`built CLI missing at ${DIST_CLI}; run \`bun run build\``,
		);
	}
	if (!existsSync(VSCODE_RG)) {
		throw new DriverError(
			`bundled rg missing at ${VSCODE_RG}; run \`bun install\``,
		);
	}
	if (!commandExists("bun")) {
		throw new DriverError("bun not on PATH");
	}
	if (!commandExists("claude")) {
		throw new DriverError("claude CLI not on PATH");
	}

	const indexDb = join(TESTDATA, ".mnemex", "index.db");
	if (!existsSync(indexDb)) {
		if (!buildIndex) {
			throw new DriverError(
				`testdata index missing at ${join(TESTDATA, ".mnemex")}`,
			);
		}
		const result = spawnSync("bun", [DIST_CLI, "index", "--force"], {
			cwd: TESTDATA,
			encoding: "utf8",
		});
		if (result.status !== 0) {
			throw new DriverError(
				`failed to build testdata index: ${result.stderr || result.stdout}`,
			);
		}
	}
}

class TemporaryShims {
	readonly binDir: string;
	private originalRg: Buffer | null = null;
	private originalMode: number | null = null;

	constructor(
		private readonly workDir: string,
		private readonly rgTrace: string,
		private readonly mnemexTrace: string,
	) {
		this.binDir = join(workDir, "bin");
	}

	install(): void {
		mkdirSync(this.binDir, { recursive: true });
		mkdirSync(dirname(RG_SHIM_PATH), { recursive: true });

		if (existsSync(RG_SHIM_PATH)) {
			const currentRg = readFileSync(RG_SHIM_PATH);
			if (
				!currentRg
					.toString("utf8")
					.startsWith("#!/bin/sh\n# MNEMEX_RG_EVAL_RG_SHIM")
			) {
				this.originalRg = currentRg;
				this.originalMode = statSync(RG_SHIM_PATH).mode & 0o777;
			}
		}

		const mnemexWrapper = join(this.binDir, "mnemex");
		writeFileSync(
			mnemexWrapper,
			[
				"#!/bin/sh",
				"# MNEMEX_RG_EVAL_MNEMEX_SHIM",
				'TRACE="${MNEMEX_SHIM_TRACE:-/tmp/mnemex-rg-eval-mnemex.log}"',
				'echo "[$(date +%H:%M:%S)] MNEMEX_HIT pid=$$ ppid=$PPID args=$*" >> "$TRACE"',
				`exec bun ${shellQuote(DIST_CLI)} "$@"`,
				"",
			].join("\n"),
			"utf8",
		);
		chmodSync(mnemexWrapper, 0o755);

		writeFileSync(
			RG_SHIM_PATH,
			[
				"#!/bin/sh",
				"# MNEMEX_RG_EVAL_RG_SHIM",
				'TRACE="${RG_SHIM_TRACE:-/tmp/mnemex-rg-eval-rg.log}"',
				'echo "[$(date +%H:%M:%S)] SHIM_HIT pid=$$ ppid=$PPID args=$*" >> "$TRACE"',
				'exec mnemex rg "$@"',
				"",
			].join("\n"),
			"utf8",
		);
		chmodSync(RG_SHIM_PATH, 0o755);
	}

	restore(): void {
		if (this.originalRg) {
			writeFileSync(RG_SHIM_PATH, this.originalRg);
			if (this.originalMode !== null) {
				chmodSync(RG_SHIM_PATH, this.originalMode);
			}
			return;
		}

		try {
			const content = readFileSync(RG_SHIM_PATH, "utf8");
			if (content.startsWith("#!/bin/sh\n# MNEMEX_RG_EVAL_RG_SHIM")) {
				unlinkSync(RG_SHIM_PATH);
			}
		} catch {
			// Already gone.
		}
	}
}

function readTail(path: string, lines = 20): string {
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

function parseStreamJson(path: string): JsonObject {
	const grepCalls: JsonObject[] = [];
	const grepToolIds = new Set<string>();
	const allToolCalls: ToolCall[] = [];
	const nonGrepToolCalls: ToolCall[] = [];
	const toolResultPreviews: string[] = [];
	const finalTextParts: string[] = [];
	let toolResultCount = 0;
	let grepToolResultCount = 0;

	let rawLines: string[] = [];
	try {
		rawLines = readFileSync(path, "utf8").split(/\r?\n/).filter(Boolean);
	} catch {
		rawLines = [];
	}

	for (const raw of rawLines) {
		let event: JsonObject;
		try {
			event = JSON.parse(raw) as JsonObject;
		} catch {
			continue;
		}

		const eventType = event.type;
		const message = event.message as JsonObject | undefined;
		const content = Array.isArray(message?.content)
			? message.content
			: undefined;
		if (!content) continue;

		for (const itemValue of content) {
			if (!itemValue || typeof itemValue !== "object") continue;
			const item = itemValue as JsonObject;

			if (eventType === "assistant" && item.type === "tool_use") {
				const toolName = item.name;
				const toolInput =
					item.input && typeof item.input === "object"
						? (item.input as Record<string, unknown>)
						: {};
				const toolCall: ToolCall = {
					id: item.id,
					name: toolName,
					input: toolInput,
				};
				allToolCalls.push(toolCall);

				if (toolName === "Grep") {
					if (item.id) grepToolIds.add(String(item.id));
					grepCalls.push({
						pattern: toolInput.pattern ?? null,
						path: toolInput.path ?? null,
						glob: toolInput.glob ?? null,
						head_limit: toolInput.head_limit ?? null,
						output_mode: toolInput.output_mode ?? null,
					});
				} else {
					nonGrepToolCalls.push(toolCall);
				}
			} else if (eventType === "user" && item.type === "tool_result") {
				toolResultCount += 1;
				if (!grepToolIds.has(String(item.tool_use_id))) continue;
				grepToolResultCount += 1;

				let resultContent = item.content;
				if (Array.isArray(resultContent)) {
					resultContent = resultContent
						.map((part) =>
							part && typeof part === "object"
								? String((part as JsonObject).text ?? "")
								: "",
						)
						.join(" ");
				}
				if (typeof resultContent === "string") {
					toolResultPreviews.push(resultContent.slice(0, 2000));
				}
			} else if (eventType === "assistant" && item.type === "text") {
				finalTextParts.push(String(item.text ?? ""));
			}
		}
	}

	const successfulPreviews = toolResultPreviews.filter(
		(preview) => preview.trim() && !preview.includes("<tool_use_error>"),
	);
	const grepResultPreview =
		successfulPreviews[0] ?? toolResultPreviews[0] ?? "";

	return {
		grep_tool_calls: grepCalls,
		grep_tool_call_count: grepCalls.length,
		all_tool_call_count: allToolCalls.length,
		non_grep_tool_call_count: nonGrepToolCalls.length,
		non_grep_tool_calls: nonGrepToolCalls.slice(0, 5),
		forbidden_tool_call_count: nonGrepToolCalls.filter((call) =>
			FORBIDDEN_TOOLS.has(String(call.name)),
		).length,
		forbidden_tool_calls: nonGrepToolCalls
			.filter((call) => FORBIDDEN_TOOLS.has(String(call.name)))
			.slice(0, 5),
		tool_result_count: toolResultCount,
		grep_tool_result_count: grepToolResultCount,
		tool_error_count: toolResultPreviews.filter((preview) =>
			preview.includes("<tool_use_error>"),
		).length,
		tool_result_previews: toolResultPreviews.slice(0, 5),
		grep_tool_result_preview: grepResultPreview,
		output: finalTextParts.join("\n").trim(),
		stream_event_count: rawLines.length,
	};
}

function parseTrace(path: string, kind: "rg" | "mnemex"): JsonObject {
	let lines: string[] = [];
	try {
		lines = readFileSync(path, "utf8")
			.split(/\r?\n/)
			.filter((line) => line.trim());
	} catch {
		lines = [];
	}

	if (kind === "rg") {
		const grepLines = lines.filter((line) => !STARTUP_RG_RE.test(line));
		return {
			shim_hits: lines.length,
			shim_grep_hits: grepLines.length,
			shim_trace_tail: lines.slice(-5).join("\n"),
		};
	}

	const mnemexRgLines = lines.filter((line) => /args=rg(\s|$)/.test(line));
	return {
		mnemex_hits: lines.length,
		mnemex_rg_hits: mnemexRgLines.length,
		mnemex_trace_tail: lines.slice(-5).join("\n"),
	};
}

function hasAbsolutePathLeak(text: unknown): boolean {
	return /(^|\s)\/(Users|private|tmp|var)\//.test(String(text ?? ""));
}

function runCase(
	prompt: string,
	options: {
		model: string;
		timeout: number;
		buildIndex: boolean;
		settingsOnly: boolean;
	},
): JsonObject {
	requirePreconditions(options.buildIndex);
	mkdirSync(LOG_DIR, { recursive: true });

	const workDir = mkdtempSync(join(tmpdir(), "mnemex-rg-eval-"));
	const rgTrace = join(workDir, "rg-shim.log");
	const mnemexTrace = join(workDir, "mnemex-shim.log");
	const ccOut = join(workDir, "claude-code.jsonl");
	const ccErr = join(workDir, "claude-code.err");
	writeFileSync(rgTrace, "");
	writeFileSync(mnemexTrace, "");

	const shims = new TemporaryShims(workDir, rgTrace, mnemexTrace);
	let exitCode = 2;
	let timedOut = false;
	let durationMs = 0;

	try {
		shims.install();
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PATH: `${shims.binDir}:${dirname(RG_SHIM_PATH)}:${process.env.PATH ?? ""}`,
			RG_SHIM_TRACE: rgTrace,
			MNEMEX_SHIM_TRACE: mnemexTrace,
		};
		if (!options.settingsOnly) {
			env.USE_BUILTIN_RIPGREP = "0";
		}

		const command = [
			"-p",
			prompt,
			"--allowedTools",
			"Grep",
			"--disallowedTools",
			"Bash",
			"--permission-mode",
			"acceptEdits",
			"--model",
			options.model,
			"--output-format",
			"stream-json",
			"--verbose",
		];

		const started = Date.now();
		const proc = spawnSync("claude", command, {
			cwd: TESTDATA,
			env,
			encoding: "utf8",
			timeout: options.timeout * 1000,
			maxBuffer: 20 * 1024 * 1024,
		});
		durationMs = Date.now() - started;
		writeFileSync(ccOut, proc.stdout ?? "", "utf8");
		writeFileSync(ccErr, proc.stderr ?? "", "utf8");

		const errorCode = (proc.error as NodeJS.ErrnoException | undefined)?.code;
		timedOut = errorCode === "ETIMEDOUT";
		exitCode = timedOut ? 124 : (proc.status ?? (proc.error ? 2 : 0));
	} finally {
		shims.restore();
	}

	const parsed = {
		...parseStreamJson(ccOut),
		...parseTrace(rgTrace, "rg"),
		...parseTrace(mnemexTrace, "mnemex"),
	};
	const preview = parsed.grep_tool_result_preview;
	const output = parsed.output;
	const result: JsonObject = {
		...parsed,
		exit_code: exitCode,
		timed_out: timedOut,
		duration_ms: durationMs,
		model: options.model,
		testdata: TESTDATA,
		shim_reaches_mnemex_rg: Number(parsed.mnemex_rg_hits ?? 0) >= 1,
		result_has_absolute_paths:
			hasAbsolutePathLeak(preview) || hasAbsolutePathLeak(output),
		stderr_tail: readTail(ccErr),
	};

	const runId = `${Math.floor(Date.now() / 1000)}-${process.pid}`;
	const logFiles = {
		claude_stream: join(LOG_DIR, `cc-${runId}.jsonl`),
		rg_shim: join(LOG_DIR, `shim-${runId}.log`),
		mnemex: join(LOG_DIR, `mnemex-${runId}.log`),
		stderr: join(LOG_DIR, `stderr-${runId}.log`),
	};
	copyFileSync(ccOut, logFiles.claude_stream);
	copyFileSync(rgTrace, logFiles.rg_shim);
	copyFileSync(mnemexTrace, logFiles.mnemex);
	copyFileSync(ccErr, logFiles.stderr);
	result.log_files = logFiles;

	rmSync(workDir, { recursive: true, force: true });
	return result;
}

function parseArgs(argv: string[]): {
	prompt: string;
	model: string;
	timeout: number;
	buildIndex: boolean;
	settingsOnly: boolean;
} {
	let model = "haiku";
	let timeout = 120;
	let buildIndex = true;
	let settingsOnly = false;
	const promptParts: string[] = [];

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--model") {
			model = argv[++index] ?? model;
		} else if (arg === "--timeout") {
			timeout = Number(argv[++index] ?? timeout);
		} else if (arg === "--no-build-index") {
			buildIndex = false;
		} else if (arg === "--settings-only") {
			settingsOnly = true;
		} else {
			promptParts.push(arg);
		}
	}

	const prompt = promptParts.join(" ").trim();
	if (!prompt) {
		throw new DriverError("prompt is required");
	}

	return { prompt, model, timeout, buildIndex, settingsOnly };
}

function errorResult(error: unknown): JsonObject {
	return {
		error: error instanceof Error ? error.message : String(error),
		exit_code: 2,
		grep_tool_calls: [],
		grep_tool_call_count: 0,
		all_tool_call_count: 0,
		non_grep_tool_call_count: 0,
		non_grep_tool_calls: [],
		forbidden_tool_call_count: 0,
		forbidden_tool_calls: [],
		shim_hits: 0,
		shim_grep_hits: 0,
		mnemex_hits: 0,
		mnemex_rg_hits: 0,
		shim_reaches_mnemex_rg: false,
	};
}

let result: JsonObject;
try {
	const args = parseArgs(Bun.argv.slice(2));
	result = runCase(args.prompt, {
		model: args.model,
		timeout: args.timeout,
		buildIndex: args.buildIndex,
		settingsOnly: args.settingsOnly,
	});
} catch (error) {
	result = errorResult(error);
}

process.stdout.write(`${JSON.stringify(result)}\n`);
