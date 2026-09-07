/**
 * End-to-End (black box): the theme flag, the debug gate, and stdout purity
 * on the non-interactive paths (FR1.1, FR3, FR4, FR6, §4.5).
 *
 * Complements `theme-env-precedence-e2e.test.ts`. Same harness rules:
 *   - `dist/index.js` is executed DIRECTLY (its shebang disables bun's own
 *     `.env` auto-load); never `spawnSync("bun", [CLI])`.
 *   - The spawn env is built from scratch: no TERM_THEME, MNEMEX_THEME,
 *     COLORFGBG or NO_COLOR can leak in from the developer's shell.
 *   - Fresh temp cwd per test; skipped on win32 (no shebangs).
 *
 * What is observed:
 *   - `--theme=blue` exits 1 with the message on stderr and an empty stdout,
 *     in both output modes.
 *   - `--theme=light` silences the debug diagnostic (the flag answered).
 *   - Without MNEMEX_DEBUG nothing about theme is printed at all.
 *   - `.env` cannot supply MNEMEX_THEME either.
 *   - `mnemex rg` stdout is ripgrep's bytes: no OSC 11 query, no DA1.
 *   - `--agent status` and `--help` never emit the probe bytes on a pipe.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const CLI = join(REPO_ROOT, "dist/index.js");
const SPAWN_TIMEOUT = 60000;

const OSC11_QUERY = "\x1b]11;?";
const OSC11_PREFIX = "\x1b]11";
const DA1_QUERY = "\x1b[c";
const THEME_DIAGNOSTIC = /theme (defaulted|not detected)/;

const skip = process.platform === "win32";

function makeProject(dotenv = "TERM_THEME=light\n"): string {
	const dir = mkdtempSync(join(tmpdir(), "mnemex-theme-cli-"));
	mkdirSync(join(dir, "home"), { recursive: true });
	writeFileSync(join(dir, ".env"), dotenv);
	writeFileSync(join(dir, "haystack.txt"), "one\nneedle here\nthree\n");
	return dir;
}

interface RunOptions {
	debug?: boolean;
	extraEnv?: Record<string, string>;
}

/** Executes dist/index.js directly — through its shebang — never via `bun`. */
function runCliDirect(args: string[], dir: string, opts: RunOptions = {}) {
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "",
		HOME: join(dir, "home"),
		OPENROUTER_API_KEY: "test-key-never-used",
		MNEMEX_MODEL: "test-embedding-model",
		MNEMEX_GLOBAL_LOCK_PATH: join(dir, "global.lock"),
		MNEMEX_DOCS_ENABLED: "false",
		TERM: "xterm-256color",
		...(opts.debug === false ? {} : { MNEMEX_DEBUG: "1" }),
		...opts.extraEnv,
	};
	const result = spawnSync(CLI, args, {
		cwd: dir,
		encoding: "utf-8",
		timeout: SPAWN_TIMEOUT,
		stdio: "pipe",
		env,
	});
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status,
		error: result.error,
	};
}

function withProject<T>(fn: (dir: string) => T, dotenv?: string): T {
	const dir = makeProject(dotenv);
	try {
		return fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe.skipIf(skip)("theme CLI (black box)", () => {
	test("precondition: dist/index.js exists (run `bun run build`)", () => {
		expect(existsSync(CLI)).toBe(true);
	});

	test("E2E-05: --theme=light answers, so no diagnostic is printed even with MNEMEX_DEBUG", () => {
		withProject((dir) => {
			const { status, stderr, stdout, error } = runCliDirect(
				["--theme=light", "--help"],
				dir,
			);

			expect(error).toBeUndefined();
			expect(status).toBe(0);
			expect(stderr).not.toMatch(THEME_DIAGNOSTIC);
			expect(stdout.length).toBeGreaterThan(0);
		});
	});

	test("E2E-05b: --theme light (two tokens) is equivalent and does not swallow the command", () => {
		withProject((dir) => {
			const { status, stderr, stdout } = runCliDirect(
				["--theme", "light", "--help"],
				dir,
			);

			expect(status).toBe(0);
			expect(stderr).not.toMatch(THEME_DIAGNOSTIC);
			expect(stdout.length).toBeGreaterThan(0);
		});
	});

	test("E2E-04: without MNEMEX_DEBUG the default path prints nothing about theme", () => {
		withProject((dir) => {
			const { status, stderr } = runCliDirect(["--help"], dir, {
				debug: false,
			});

			expect(status).toBe(0);
			expect(stderr).not.toMatch(THEME_DIAGNOSTIC);
			expect(stderr).not.toMatch(/theme/i);
		});
	});

	test("E2E-03: a .env file cannot supply MNEMEX_THEME either", () => {
		withProject((dir) => {
			const { status, stderr } = runCliDirect(["--help"], dir);

			expect(status).toBe(0);
			expect(stderr).toContain("theme defaulted to dark");
		}, "MNEMEX_THEME=light\nTERM_THEME=light\n");
	});

	test("E2E-02b: MNEMEX_THEME=light in the real env answers and is silent", () => {
		withProject((dir) => {
			const { status, stderr } = runCliDirect(["--help"], dir, {
				extraEnv: { MNEMEX_THEME: "light" },
			});

			expect(status).toBe(0);
			expect(stderr).not.toMatch(THEME_DIAGNOSTIC);
		});
	});

	test("E2E-01b: help output is identical whether the theme defaulted or was given", () => {
		withProject((dir) => {
			const defaulted = runCliDirect(["--help"], dir);
			const flagged = runCliDirect(["--theme=light", "--help"], dir);

			expect(defaulted.status).toBe(0);
			expect(flagged.status).toBe(0);
			expect(flagged.stdout).toBe(defaulted.stdout);
		});
	});

	test("E2E-06: --theme=blue exits 1, names the accepted values on stderr, prints nothing on stdout", () => {
		withProject((dir) => {
			const { status, stderr, stdout } = runCliDirect(
				["--theme=blue", "--help"],
				dir,
			);

			expect(status).toBe(1);
			expect(stderr).toContain("--theme");
			expect(stderr).toContain("light");
			expect(stderr).toContain("dark");
			expect(stderr).toContain("blue");
			expect(stdout).toBe("");
		});
	});

	test("E2E-06b: a bare trailing --theme also exits 1", () => {
		withProject((dir) => {
			const { status, stderr, stdout } = runCliDirect(
				["--help", "--theme"],
				dir,
			);

			expect(status).toBe(1);
			expect(stderr).toContain("--theme");
			expect(stdout).toBe("");
		});
	});

	test("E2E-07: --agent --theme=blue exits 1 with an `error=` line on stderr and an empty stdout", () => {
		withProject((dir) => {
			const { status, stderr, stdout } = runCliDirect(
				["--agent", "--theme=blue", "--help"],
				dir,
			);

			expect(status).toBe(1);
			expect(stderr).toContain("error=");
			expect(stderr).toContain("--theme");
			expect(stdout).toBe("");
		});
	});

	test("E2E-08: `mnemex rg` stdout carries only ripgrep's bytes (no OSC 11, no DA1)", () => {
		withProject((dir) => {
			const { status, stdout, stderr } = runCliDirect(
				["rg", "needle", "."],
				dir,
			);

			expect(status).toBe(0);
			expect(stdout).toContain("needle");
			expect(stdout).not.toContain(OSC11_PREFIX);
			expect(stdout).not.toContain(DA1_QUERY);
			expect(stderr).not.toContain(OSC11_PREFIX);
		});
	});

	test("E2E-08b: `mnemex rg` without MNEMEX_DEBUG writes nothing about theme to stderr", () => {
		withProject((dir) => {
			const { status, stdout, stderr } = runCliDirect(
				["rg", "needle", "."],
				dir,
				{ debug: false },
			);

			expect(status).toBe(0);
			expect(stdout).toContain("needle");
			expect(stdout).not.toContain(OSC11_PREFIX);
			expect(stderr).not.toMatch(/theme/i);
		});
	});

	test("E2E-09: `--agent status` never emits the probe bytes on either stream", () => {
		withProject((dir) => {
			const { stdout, stderr } = runCliDirect(["--agent", "status"], dir);

			expect(stdout).not.toContain(OSC11_QUERY);
			expect(stdout).not.toContain(OSC11_PREFIX);
			expect(stdout).not.toContain(DA1_QUERY);
			expect(stderr).not.toContain(OSC11_QUERY);
		});
	});

	test("E2E-09b: `--help` on a pipe never emits the probe bytes", () => {
		withProject((dir) => {
			const { status, stdout, stderr } = runCliDirect(["--help"], dir);

			expect(status).toBe(0);
			expect(stdout).not.toContain(OSC11_QUERY);
			expect(stdout).not.toContain(DA1_QUERY);
			expect(stderr).not.toContain(OSC11_QUERY);
			expect(stderr).not.toContain(DA1_QUERY);
		});
	});
});
