/**
 * End-to-End: `mnemex index --model <model>`
 *
 * Both model-mismatch errors tell the user to run `mnemex index --force --model X`.
 * Until this flag was parsed, that command did something else entirely: `--model`
 * was unknown to handleIndex, so the bare model NAME was picked up as the project
 * path, `ensureProjectDir` created `./X/.mnemex`, and the run indexed an empty
 * tree and reported success. The documented escape hatch quietly did nothing.
 *
 * Exercises the built CLI (dist/index.js) — run `bun run build` first.
 */

import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { keychainSafeChildEnv } from "../helpers/child-env.js";

const REPO_ROOT = resolve(import.meta.dir, "../..");
const CLI = join(REPO_ROOT, "dist/index.js");
const SPAWN_TIMEOUT = 60000;

function runCli(args: string[], cwd: string) {
	const result = spawnSync("bun", [CLI, ...args], {
		cwd,
		encoding: "utf-8",
		timeout: SPAWN_TIMEOUT,
		// `keychainSafeChildEnv` rather than `{...process.env}`: this child runs the
		// production entry point, whose first act is to enable real keychain access.
		env: keychainSafeChildEnv({
			// Never queue behind (or hold) the developer's real machine-wide lock.
			MNEMEX_GLOBAL_LOCK_PATH: join(cwd, "global.lock"),
			MNEMEX_DOCS_ENABLED: "false",
		}),
	});
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status,
	};
}

describe("mnemex index --model", () => {
	test("does not mistake the model name for the project path", () => {
		const dir = mkdtempSync(join(tmpdir(), "mnemex-index-model-"));
		try {
			runCli(
				["index", "--force", "--model", "voyage-3.5-lite", "--no-llm"],
				dir,
			);

			// The old behaviour: ./voyage-3.5-lite/.mnemex, created from the flag's
			// value. Whether the run itself succeeds depends on this machine's
			// credentials; that it never invents this directory does not.
			expect(existsSync(join(dir, "voyage-3.5-lite"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("refuses a --model with no value instead of guessing one", () => {
		const dir = mkdtempSync(join(tmpdir(), "mnemex-index-model-"));
		try {
			// Guessing here would rebuild the entire index against whatever the next
			// argument happened to be.
			const { status, stderr } = runCli(["index", "--model"], dir);

			expect(status).toBe(1);
			expect(stderr).toContain("--model");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
