/**
 * End-to-End: a `.env` file cannot supply the terminal theme (FR3 / AC 8).
 *
 * Two layers keep `.env` out of the theme resolver, and this test is the only
 * thing that exercises the first one:
 *
 *   1. The shebang in `src/index.ts` — `#!/usr/bin/env -S bun --env-file=/dev/null`
 *      — stops bun's OWN `.env` auto-load, which runs before any user module.
 *   2. `captureStartupEnv()` runs before `dotenv.config()`, so dotenv (the
 *      only remaining `.env` loader) cannot reach the snapshot.
 *
 * Layer 2 is pinned by a unit test. Layer 1 can only be observed by executing
 * `dist/index.js` DIRECTLY as a program, so the kernel runs the shebang.
 * `spawnSync("bun", [CLI])` — the style every other e2e in this directory
 * uses — bypasses the shebang and would see bun's auto-load leak the `.env`
 * value in; do not mix the two spawn styles unknowingly. Skipped on win32,
 * which has no shebangs (and is not a release target).
 *
 * The observable is the `MNEMEX_DEBUG` diagnostic: `detectThemeAtStartup`
 * prints "theme defaulted to dark" to stderr only when NO source answered.
 * With `.env` = `TERM_THEME=light` in the cwd and no `TERM_THEME` in the real
 * env, that line appearing proves the file did not leak through either layer.
 *
 * THE SPAWN ENVIRONMENT IS BUILT FROM SCRATCH, NOT INHERITED (see
 * fatal-error-output-e2e.test.ts for why): the developer's shell may export
 * TERM_THEME or COLORFGBG, either of which would answer and silence the line.
 *
 * Exercises the built CLI (dist/index.js) — run `bun run build` first.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { KEYCHAIN_CHILD_GUARD_ENV } from "../helpers/child-env.js";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const CLI = join(REPO_ROOT, "dist/index.js");
const SPAWN_TIMEOUT = 60000;
const EXPECTED_SHEBANG = "#!/usr/bin/env -S bun --env-file=/dev/null";

const skip = process.platform === "win32";

/** A cwd whose .env claims a light theme, plus an empty HOME for the run. */
function makeProjectWithDotEnv(): string {
	const dir = mkdtempSync(join(tmpdir(), "mnemex-theme-env-"));
	mkdirSync(join(dir, "home"), { recursive: true });
	writeFileSync(join(dir, ".env"), "TERM_THEME=light\n");
	return dir;
}

/** Executes dist/index.js directly — through its shebang — never via `bun`. */
function runCliDirect(
	args: string[],
	dir: string,
	extraEnv: Record<string, string> = {},
) {
	const result = spawnSync(CLI, args, {
		cwd: dir,
		encoding: "utf-8",
		timeout: SPAWN_TIMEOUT,
		stdio: "pipe",
		// Built up, never inherited — see the header. PATH is what lets
		// /usr/bin/env find bun. No TERM_THEME, MNEMEX_THEME or COLORFGBG.
		env: {
			PATH: process.env.PATH ?? "",
			HOME: join(dir, "home"),
			MNEMEX_DEBUG: "1",
			MNEMEX_DOCS_ENABLED: "false",
			...extraEnv,
			// LAST, so no caller can weaken it. This child runs the production entry
			// point, which enables real keychain access as its first act; the built-up
			// env means it inherits no sentinel from the test runner.
			...KEYCHAIN_CHILD_GUARD_ENV,
		},
	});
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status,
		error: result.error,
	};
}

describe.skipIf(skip)(
	"theme resolution reads the real environment only",
	() => {
		test("precondition: dist/index.js exists and carries the --env-file=/dev/null shebang", () => {
			expect(existsSync(CLI)).toBe(true);
			const firstLine = readFileSync(CLI, "utf-8").split("\n")[0];
			// If this fails the shebang regressed: see architecture §2.1 — without
			// --env-file=/dev/null bun auto-loads cwd .env before any user code, and
			// TERM_THEME from a file becomes indistinguishable from a real export.
			expect(firstLine).toContain("--env-file=/dev/null");
			expect(firstLine).toBe(EXPECTED_SHEBANG);
		});

		test("a. .env TERM_THEME=light does not reach the resolver: theme defaults to dark", () => {
			const dir = makeProjectWithDotEnv();
			try {
				const { stderr, stdout, status, error } = runCliDirect(["--help"], dir);

				expect(error).toBeUndefined();
				expect(status).toBe(0);
				expect(stderr).toContain("theme defaulted to dark");
				// stderr only: stdout is protocol in --agent/MCP mode.
				expect(stdout).not.toContain("theme defaulted");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		test("b. control: TERM_THEME=light in the real env answers, so the line is absent", () => {
			const dir = makeProjectWithDotEnv();
			try {
				const { stderr, status } = runCliDirect(["--help"], dir, {
					TERM_THEME: "light",
				});

				expect(status).toBe(0);
				expect(stderr).not.toContain("theme defaulted");
				expect(stderr).not.toContain("theme not detected");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});

		test("c. --theme=blue exits 1 with the error on stderr", () => {
			const dir = makeProjectWithDotEnv();
			try {
				const { stderr, stdout, status } = runCliDirect(
					["--theme=blue", "--help"],
					dir,
				);

				expect(status).toBe(1);
				expect(stderr).toContain("--theme expects light or dark, got 'blue'");
				expect(stdout).not.toContain("--theme expects");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	},
);
