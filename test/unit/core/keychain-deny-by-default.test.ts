/**
 * A2 — the hard constraint must hold from a FRESH PROCESS, in ANY directory.
 *
 * HARD CONSTRAINT (architecture D-7 / H3): no test, helper or probe may spawn
 * `/usr/bin/security`. Enforcing it mattered for a concrete reason — an earlier
 * attempt to drive a throwaway keychain put macOS authorization dialogs on a
 * user's screen whose password only the tooling knew, one per spawn, on an idle
 * re-lock timer.
 *
 * The previous guard set was allow-by-default plus three refusals. Two of the
 * three (`MNEMEX_KEYCHAIN_TEST_GUARD` and `MNEMEX_DISABLE_KEYCHAIN`) had ONE
 * writer, `bunfig.toml`'s `[test] preload`, which `bun` resolves against the
 * current working directory and does not walk up for. Two reviewers independently
 * measured a path to `/usr/bin/security` from a fresh process started elsewhere.
 *
 * These tests drive that exact adversary. The child runs with cwd set OUTSIDE the
 * repository root, with the sentinel deleted from its environment and
 * `MNEMEX_DISABLE_KEYCHAIN=0`, and never installs the stub. It must still refuse.
 *
 * NOTHING HERE SPAWNS `security` — that is the assertion.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	disableRealKeychainAccessForTests,
	enableRealKeychainAccess,
	readKeychainAccount,
} from "../../../src/core/keychain.js";
import { expectedRefusalReason } from "../../helpers/keychain-refusal.js";

const CHILD = join(import.meta.dir, "../../helpers/keychain-deny-child.ts");
const REPO_ROOT = join(import.meta.dir, "../../..");

interface ChildResult {
	cwd: string;
	guardEnv: string | null;
	disableEnv: string | null;
	platform: string;
	backendEnabled: boolean;
	status: string;
	error?: string;
}

/**
 * Run the adversary with the guard environment stripped.
 *
 * `cwd` defaults to a fresh temp directory, which is the case `bunfig.toml`
 * cannot reach. The child is invoked with an ABSOLUTE path so the cwd change does
 * not simply break module resolution and pass for the wrong reason.
 */
function runUnguardedChild(cwd: string): ChildResult {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	// The adversary: no sentinel, and the policy opt-out explicitly OFF.
	delete env.MNEMEX_KEYCHAIN_TEST_GUARD;
	delete env.MNEMEX_KEYCHAIN_FILE;
	env.MNEMEX_DISABLE_KEYCHAIN = "0";

	const proc = Bun.spawnSync({
		cmd: ["bun", "run", CHILD],
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});

	const stdout = proc.stdout.toString();
	const marker = stdout.indexOf("__RESULT__");
	if (marker < 0) {
		throw new Error(
			`child produced no result.\nstdout: ${stdout}\nstderr: ${proc.stderr.toString()}`,
		);
	}
	return JSON.parse(stdout.slice(marker + "__RESULT__".length));
}

describe("A2 — deny by default, independent of cwd and environment", () => {
	test("a fresh process in a temp cwd refuses, with every old guard absent", () => {
		const cwd = mkdtempSync(join(tmpdir(), "mnemex-nobunfig-"));
		try {
			const result = runUnguardedChild(cwd);

			// The preconditions really were absent — otherwise this test would pass
			// for the wrong reason, which is exactly what the old sweep did.
			expect(result.guardEnv).toBeNull();
			expect(result.disableEnv).toBe("0");
			expect(result.cwd).not.toContain("mnemex/.claude/worktrees");

			// And on darwin the POLICY layer is genuinely enabled — the refusal below
			// comes from the adapter, not from the backend being switched off.
			if (result.platform === "darwin") {
				expect(result.backendEnabled).toBe(true);
			}

			// The refusal itself, by its exact reason for this platform.
			expect(result.status).toBe("failed");
			expect(result.error).toContain(expectedRefusalReason(result.platform));
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});

	test("the same holds from a subdirectory of the repo — the measured escape", () => {
		// `cd test && bun test ../x.test.ts` was the concrete reproduction: bunfig
		// is not found one level down, so the sentinel and the policy default are
		// both lost. Same file, same absence, still refused.
		const result = runUnguardedChild(join(REPO_ROOT, "test"));

		expect(result.guardEnv).toBeNull();
		expect(result.status).toBe("failed");
		expect(result.error).toContain(expectedRefusalReason(result.platform));
	});

	test("`enableRealKeychainAccess()` is a no-op while the sentinel is set", () => {
		// The residual case deny-by-default alone does not cover: a test that spawns
		// the REAL entry point, which calls this function. The inherited sentinel
		// vetoes it. This suite runs under the preload, so the sentinel is set here.
		expect(process.env.MNEMEX_KEYCHAIN_TEST_GUARD).toBe("1");

		disableRealKeychainAccessForTests();
		enableRealKeychainAccess();

		const read = readKeychainAccount("openrouter");
		expect(read.status).toBe("failed");
		if (read.status === "failed") {
			// Still refused: the opt-in did not take effect. On darwin that is the
			// deny-by-default reason; off darwin the platform gate answers first.
			expect(read.error).toContain(expectedRefusalReason(process.platform));
		}
	});
});
