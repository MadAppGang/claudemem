/**
 * Parent-side launcher for sandboxed children.
 *
 * Every child:
 *   - gets a FRESH temp HOME under the real tmpdir, prefixed `mnemex-bb-`
 *   - gets its env from the repo's blessed `keychainSafeChildEnv()` (test/helpers/child-env.ts),
 *     which applies MNEMEX_KEYCHAIN_TEST_GUARD=1 and MNEMEX_DISABLE_KEYCHAIN=1 last; HOME and
 *     the MNEMEX_TEST_SANDBOX_HOME declaration are layered on top, and inherited credential
 *     vars are dropped inside the child before any mnemex module loads
 *   - runs with cwd = that temp HOME, so no repo `.env` or `.mnemex/` is in reach
 *   - has stdin ignored so it can never block on a prompt
 */
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { keychainSafeChildEnv } from "../../helpers/child-env.js";
import type { FakeKeychainCall, FakeKeychainOptions } from "./fake-keychain.js";

const ROOT = resolve(import.meta.dir, "../../..");
const RUNNER = join(import.meta.dir, "child-runner.ts");
const PRELOAD = join(import.meta.dir, "cli-preload.ts");
const ENTRY = join(ROOT, "src/index.ts");
const REAL_TMP = realpathSync(tmpdir());

export interface FileState {
	exists: boolean;
	text?: string;
	json?: Record<string, unknown> | null;
	mode?: string;
}

function makeHome(): string {
	return mkdtempSync(join(REAL_TMP, "mnemex-bb-"));
}

/**
 * The additions layered ON TOP of the repo's blessed child env. Every spawn below is
 * `env: keychainSafeChildEnv(childExtras(...))`, and that helper applies
 * MNEMEX_KEYCHAIN_TEST_GUARD=1 and MNEMEX_DISABLE_KEYCHAIN=1 last, so nothing here can
 * weaken them. Inherited credential env vars are dropped inside the child, before any
 * mnemex module loads (child-runner.ts / cli-preload.ts).
 */
function childExtras(
	home: string,
	declaration: string,
	extra: Record<string, string> = {},
): Record<string, string> {
	return {
		HOME: home,
		TMPDIR: REAL_TMP,
		MNEMEX_BB_HOME: home,
		// The CALLER's declaration, checked by test/helpers/sandbox-guard.ts inside the child.
		[declaration]: home,
		...extra,
	};
}

/**
 * The launchers below are fail-closed: the calling TEST FILE must name the sandbox
 * declaration itself (`sandboxDeclaration: "MNEMEX_TEST_SANDBOX_HOME"`). A helper that
 * supplied it silently would let a future test spawn a config-writing child without
 * ever stating that it does so; the repo's static sweep credits the caller, not us.
 */
function requireDeclaration(declaration: string | undefined): string {
	if (declaration !== "MNEMEX_TEST_SANDBOX_HOME") {
		throw new Error(
			'refusing to spawn: the test must pass sandboxDeclaration: "MNEMEX_TEST_SANDBOX_HOME"',
		);
	}
	return declaration;
}

function seedConfig(home: string, existing: unknown, mode?: number) {
	if (existing === undefined || existing === null) return;
	const dir = join(home, ".mnemex");
	mkdirSync(dir, { recursive: true });
	const p = join(dir, "config.json");
	writeFileSync(
		p,
		typeof existing === "string" ? existing : JSON.stringify(existing, null, 2),
	);
	if (mode !== undefined) chmodSync(p, mode);
}

function readConfigState(home: string): FileState {
	const p = join(home, ".mnemex", "config.json");
	if (!existsSync(p)) return { exists: false };
	const text = readFileSync(p, "utf8");
	let json: Record<string, unknown> | null = null;
	try {
		json = JSON.parse(text);
	} catch {
		json = null;
	}
	return {
		exists: true,
		text,
		json,
		mode: (statSync(p).mode & 0o777).toString(8),
	};
}

export interface ChildResult {
	homedir: string;
	scenario: string;
	before?: FileState;
	after: FileState;
	dir: Record<string, string>;
	calls: FakeKeychainCall[];
	store: Record<string, string>;
	captured: { stdout: string; stderr: string };
	realSpawns: number;
	pendingWarnings: string[];
	report?: unknown;
	thrown?: string;
	fatal?: string;
	stages?: Record<
		string,
		{
			value?: string;
			calls?: number;
			cold?: string;
			coldCalls?: number;
			warm?: string;
			warmCalls?: number;
		}
	>;
	ENV?: Record<string, string>;
	loadCalls?: number;
	loadValue?: string;
	hydratedCalls?: number;
	hydratedValue?: string;
	rawStdout: string;
	rawStderr: string;
	exitCode: number | null;
}

export interface ChildParams {
	existing?: unknown;
	existingMode?: number;
	incoming?: Record<string, unknown>;
	incomingUndefinedFields?: string[];
	fake?: FakeKeychainOptions;
	env?: Record<string, string | null>;
	keepDisabled?: boolean;
	getter?: string;
	envVar?: string;
	field?: string;
	thenSaveHydratedWith?: Record<string, unknown>;
	failWriteOnSave?: boolean;
	/** Must be the literal "MNEMEX_TEST_SANDBOX_HOME", supplied by the test file. */
	sandboxDeclaration: string;
}

export function runChildScenario(
	scenario: string,
	params: ChildParams,
): ChildResult {
	const declaration = requireDeclaration(params.sandboxDeclaration);
	const home = makeHome();
	try {
		const proc = Bun.spawnSync(
			[process.execPath, RUNNER, scenario, JSON.stringify(params)],
			{
				cwd: home,
				env: keychainSafeChildEnv(childExtras(home, declaration)),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				timeout: 60_000,
			},
		);
		const rawStdout = proc.stdout.toString();
		const rawStderr = proc.stderr.toString();
		const line = rawStdout
			.split("\n")
			.reverse()
			.find((l) => l.startsWith("BB_RESULT "));
		if (!line) {
			throw new Error(
				`child produced no BB_RESULT (exit ${proc.exitCode})\nstdout:\n${rawStdout}\nstderr:\n${rawStderr}`,
			);
		}
		const parsed = JSON.parse(line.slice("BB_RESULT ".length));
		return { ...parsed, rawStdout, rawStderr, exitCode: proc.exitCode };
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

export interface CliRun {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	calls: FakeKeychainCall[];
	store: Record<string, string>;
	realSpawns: number;
	before: FileState;
	after: FileState;
	home: string;
}

export interface CliOptions {
	existing?: unknown;
	existingMode?: number;
	fake?: FakeKeychainOptions;
	keepDisabled?: boolean;
	/** Must be the literal "MNEMEX_TEST_SANDBOX_HOME", supplied by the test file. */
	sandboxDeclaration: string;
}

export function runKeychainCli(args: string[], opts: CliOptions): CliRun {
	const declaration = requireDeclaration(opts.sandboxDeclaration);
	const home = makeHome();
	try {
		seedConfig(home, opts.existing, opts.existingMode);
		const before = readConfigState(home);
		const out = join(home, "bb-seam.json");
		const proc = Bun.spawnSync(
			[process.execPath, "--preload", PRELOAD, ENTRY, "keychain", ...args],
			{
				cwd: home,
				env: keychainSafeChildEnv(
					childExtras(home, declaration, {
						MNEMEX_BB_FAKE: JSON.stringify(opts.fake ?? {}),
						MNEMEX_BB_OUT: out,
						...(opts.keepDisabled ? { MNEMEX_BB_KEEP_DISABLED: "1" } : {}),
					}),
				),
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				timeout: 90_000,
			},
		);
		const stdout = proc.stdout.toString();
		const stderr = proc.stderr.toString();
		if (proc.exitCode === 99) {
			throw new Error(`preload refused to run: ${stderr}`);
		}
		let seam: {
			calls: FakeKeychainCall[];
			store: Record<string, string>;
			realSpawns: number;
		} = {
			calls: [],
			store: {},
			realSpawns: -1,
		};
		if (existsSync(out)) {
			seam = JSON.parse(readFileSync(out, "utf8"));
		} else {
			throw new Error(
				`child wrote no seam record (exit ${proc.exitCode})\nstdout:\n${stdout}\nstderr:\n${stderr}`,
			);
		}
		return {
			stdout,
			stderr,
			exitCode: proc.exitCode,
			calls: seam.calls,
			store: seam.store,
			realSpawns: seam.realSpawns,
			before,
			after: readConfigState(home),
			home,
		};
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}

/** Parse the CLI's `key=value` lines. Repeated keys (e.g. `secret`) are collected in order. */
export function kvLines(stdout: string): {
	get(key: string): string | undefined;
	all(key: string): string[];
	secrets(): Record<string, Record<string, string>>;
} {
	const rows: { key: string; value: string }[] = [];
	for (const raw of stdout.split("\n")) {
		const line = raw.trim();
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).split(" ")[0];
		rows.push({ key, value: line.slice(eq + 1) });
	}
	return {
		get: (key) => rows.find((r) => r.key === key)?.value,
		all: (key) => rows.filter((r) => r.key === key).map((r) => r.value),
		secrets: () => {
			const out: Record<string, Record<string, string>> = {};
			for (const raw of stdout.split("\n")) {
				const line = raw.trim();
				if (!line.startsWith("secret ")) continue;
				const fields: Record<string, string> = {};
				for (const tok of line.slice("secret ".length).split(/\s+/)) {
					const i = tok.indexOf("=");
					if (i > 0) fields[tok.slice(0, i)] = tok.slice(i + 1);
				}
				if (fields.id) out[fields.id] = fields;
			}
			return out;
		},
	};
}
