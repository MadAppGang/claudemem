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
 * The failure used here is a corrupt `index.db` (a few bytes of text): offline,
 * instant, and reproducible on any machine — no provider, no network.
 *
 * Exercises the built CLI (dist/index.js) — run `bun run build` first.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const CLI = join(REPO_ROOT, "dist/index.js");
const SPAWN_TIMEOUT = 60000;

/** A project whose index.db is not a database. */
function makeBrokenProject(): string {
	const dir = mkdtempSync(join(tmpdir(), "mnemex-fatal-"));
	mkdirSync(join(dir, ".mnemex"), { recursive: true });
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
		env: {
			...process.env,
			MNEMEX_GLOBAL_LOCK_PATH: join(dir, "global.lock"),
			MNEMEX_DOCS_ENABLED: "false",
			MNEMEX_DEBUG: "",
			...extraEnv,
		},
	});
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status,
	};
}

describe("an error that escapes runCli", () => {
	test("prints the message alone — no stack, no bun banner — and exits 1", () => {
		const dir = makeBrokenProject();
		try {
			const { stdout, stderr, status } = runCli(
				["search", "greet", "--agent"],
				dir,
			);

			expect(status).toBe(1);
			expect(stderr).toContain("file is not a database");
			// The three things bun's default handler adds, and the reason this
			// handler exists.
			expect(stderr).not.toContain("    at ");
			expect(stderr).not.toContain("missing sourcemaps");
			expect(stderr).not.toMatch(/^Bun v/m);
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

			expect(status).toBe(1);
			expect(stderr).toContain("file is not a database");
			expect(stderr).toContain("    at ");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
