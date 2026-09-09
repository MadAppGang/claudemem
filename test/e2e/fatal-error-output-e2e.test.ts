/**
 * End-to-End: what an unhandled failure looks like to the user.
 *
 * `runCli` catches the error types it knows and prints one clean line each.
 * Everything else used to reach bun's default handler, which renders four
 * frames of minified `dist/index.js` paths, two "missing sourcemaps" notes and
 * a version banner — for operational failures whose message already says what
 * to do. `src/index.ts` now attaches a shared `fatal` handler to all three
 * entry points: message only, to stderr, exit 1, stack behind MNEMEX_DEBUG.
 *
 * The failure driven here is a corrupt `index.db` (a few bytes of text):
 * offline and instant.
 *
 * THE SPAWN ENVIRONMENT IS BUILT FROM SCRATCH, NOT INHERITED. An earlier
 * version spread `...process.env` and passed on every developer machine while
 * failing in CI: locally the inherited config supplied embedding credentials,
 * so the corrupt database was the first thing to fail; in CI there were none,
 * so `assertValidEmbeddingCredentials()` exited first — status 1, no stack, and
 * an entirely different code path that never reached `fatal`. The shape
 * assertions below all passed on that wrong path; only the message assertion
 * caught it. Both kinds of assertion are therefore kept: the shape is what the
 * fix changes, the message is what proves the right failure was measured.
 *
 * Every input the credential gate reads is pinned here:
 *   - HOME → a scratch directory, so `~/.mnemex/config.json` (which supplies
 *     the provider, and on a dev machine a key) does not exist. Absent config
 *     also means `loadGlobalConfig` never merges keychain secrets, so no
 *     macOS keychain access.
 *   - OPENROUTER_API_KEY → a dummy. The provider defaults to openrouter with
 *     no config, so this passes the gate identically everywhere. It is never
 *     used: nothing gets far enough to embed anything.
 *   - MNEMEX_MODEL → fixed, so `getEmbeddingModel()` cannot consult config.
 *
 * Exercises the built CLI (dist/index.js) — run `bun run build` first.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { KEYCHAIN_CHILD_GUARD_ENV } from "../helpers/child-env.js";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const CLI = join(REPO_ROOT, "dist/index.js");
const SPAWN_TIMEOUT = 60000;

/** A project whose index.db is not a database, plus an empty HOME for the run. */
function makeBrokenProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "mnemex-fatal-"));
	mkdirSync(join(dir, ".mnemex"), { recursive: true });
	mkdirSync(join(dir, "home"), { recursive: true });
	writeFileSync(join(dir, ".mnemex", "index.db"), "not a sqlite database");
	return dir;
}

function runCli(
	args: string[],
	dir: string,
	extraEnv: Record<string, string> = {},
) {
	const result = spawnSync("bun", [CLI, ...args], {
		cwd: dir,
		encoding: "utf-8",
		timeout: SPAWN_TIMEOUT,
		// Built up, never inherited — see the header.
		env: {
			PATH: process.env.PATH ?? "",
			HOME: join(dir, "home"),
			OPENROUTER_API_KEY: "test-key-never-used",
			MNEMEX_MODEL: "test-embedding-model",
			MNEMEX_GLOBAL_LOCK_PATH: join(dir, "global.lock"),
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
	};
}

/** The three things bun's default handler adds, and this handler does not. */
function expectNoRawTrace(stderr: string): void {
	expect(stderr.length).toBeGreaterThan(0);
	expect(stderr).not.toContain("    at ");
	expect(stderr).not.toContain("missing sourcemaps");
	expect(stderr).not.toMatch(/^Bun v/m);
}

describe("an error that escapes runCli", () => {
	test("prints the message alone — no stack, no bun banner — and exits 1", () => {
		const dir = makeBrokenProject();
		try {
			const { stdout, stderr, status } = runCli(
				["search", "greet", "--agent"],
				dir,
			);

			// The message proves the corrupt database is the failure being
			// measured, and not some earlier clean exit.
			expect(stderr).toContain("file is not a database");
			expectNoRawTrace(stderr);
			expect(status).toBe(1);
			// stdout is the JSON-RPC stream in MCP mode and machine-readable in
			// --agent mode: the report must never land there.
			expect(stdout).not.toContain("file is not a database");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("MNEMEX_DEBUG brings the stack back", () => {
		// Demoted, not lost.
		const dir = makeBrokenProject();
		try {
			const { stderr, status } = runCli(["search", "greet", "--agent"], dir, {
				MNEMEX_DEBUG: "1",
			});

			expect(stderr).toContain("file is not a database");
			expect(stderr).toContain("    at ");
			expect(status).toBe(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
