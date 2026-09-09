/**
 * ROUND 7 CRITICAL — the launcher and the keychain adapter must agree on what a
 * test process is, and the proof is a child in which they used to disagree.
 *
 * `src/core/keychain.ts` refused on the env sentinel OR the irreversible
 * `testDepsEverInstalled` latch. `src/core/entry-point-launcher.ts` refused on
 * the sentinel ONLY, and the latch was not exported, so it could not have done
 * otherwise. A suite run from a cwd where `bunfig.toml` is not loaded (sentinel
 * unset) that installed the seam (latch set) and restored it with
 * `setKeychainTestDeps(null)` was therefore denied in-process — correctly — and
 * then any production call into a launcher started the real entry point. The
 * child has no latch, calls `enableRealKeychainAccess()`, and can reach the
 * login keychain. Safe parent, unsafe child (CWE-284/693).
 *
 * The fix is one shared predicate, `guardedProcessReason()` in the keychain
 * module, which the launcher imports. This file proves it the only way such a
 * property can be proved: a child with the sentinel GENUINELY ABSENT, driven
 * through every exported launcher, asserting on two real counters.
 *
 * WHY THIS CHILD IS BUILT DIFFERENTLY FROM EVERY OTHER TEST CHILD. The shared
 * helper `keychainSafeChildEnv()` ALWAYS adds the sentinel — that is its job,
 * and it is the right default. This test needs the opposite, once, on purpose:
 * with the sentinel present the latch is never the deciding veto and the test
 * proves nothing about it. So the env is built by hand, the sentinel deleted,
 * and the fact recorded by the child (`guardEnvAtStart === null`).
 *
 * DEFENCE IN DEPTH, because this child is the exact shape that reaches the real
 * keychain if the fix regresses:
 *   - `MNEMEX_DISABLE_KEYCHAIN=1` — the USER-FACING opt-out, a different
 *     variable from the test sentinel, so a launched child's policy layer
 *     refuses before the adapter is consulted.
 *   - `PATH` = one EMPTY temp directory, so a bare `mnemex` cannot resolve. The
 *     child is started through `process.execPath`, which is absolute.
 *   - `HOME` = a temp directory, so nothing real can be read or written.
 *   - The child carries its own recursion breaker for the two self-re-exec
 *     launchers, whose `process.argv[1]` is the child script itself.
 *
 * RED BEFORE GREEN. With `refuseIfGuarded` reverted to the env-only check, this
 * file fails on `launchesAfter` (one launch per exported launcher — 5 when this
 * was recorded, 4 since round 6 — with every outcome `threw: false`),
 * NOT on the keychain counter — the launches went to an empty PATH and to the
 * child script's own recursion breaker, which is precisely why the defences
 * above exist. Recorded in the session's implementation log.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHILD = join(import.meta.dir, "../../helpers/launcher-latch-child.ts");

interface Outcome {
	threw: boolean;
	name?: string;
	reason?: string;
	message?: string;
}

interface LatchChildResult {
	cwd: string;
	guardEnvAtStart: string | null;
	disableEnv: string | null;
	pathEnv: string | null;
	home: string | null;
	reasonBeforeSeam: string | null;
	reasonWithSeam: string | null;
	reasonAfterRestore: string | null;
	launchesBefore: number;
	launchesAfter: number;
	spawnsBefore: number;
	spawnsAfter: number;
	exportedFunctions: string[];
	invoked: string[];
	outcomes: Record<string, Outcome>;
}

/** Exports of the launcher module that are functions but do not launch. */
const NON_LAUNCHER_FUNCTION_EXPORTS = [
	"entryPointLaunchCount",
	"EntryPointLaunchRefusedError", // a class; `typeof` is "function"
];

let sandbox: string;
let emptyPathDir: string;

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "mnemex-latch-"));
	mkdirSync(join(sandbox, "cwd"), { recursive: true });
	mkdirSync(join(sandbox, "home"), { recursive: true });
	emptyPathDir = join(sandbox, "empty-path");
	mkdirSync(emptyPathDir, { recursive: true });
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
});

/**
 * DELIBERATELY NOT `keychainSafeChildEnv()` — see the header. The sentinel is
 * removed; everything else is hardened.
 */
function latchOnlyChildEnv(): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	// The one thing this test exists to leave out.
	delete env.MNEMEX_KEYCHAIN_TEST_GUARD;
	// Never let a redirect variable point a launched child anywhere real.
	delete env.MNEMEX_KEYCHAIN_FILE;
	// Defence in depth — the user-facing opt-out, not the test sentinel.
	env.MNEMEX_DISABLE_KEYCHAIN = "1";
	env.PATH = emptyPathDir;
	env.HOME = join(sandbox, "home");
	return env;
}

function runLatchChild(): LatchChildResult {
	const proc = Bun.spawnSync({
		// Absolute — PATH inside the child is empty, and this is the same bun.
		cmd: [process.execPath, "run", CHILD],
		cwd: join(sandbox, "cwd"),
		env: latchOnlyChildEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = proc.stdout.toString();
	const stderr = proc.stderr.toString();
	const marker = stdout.indexOf("__RESULT__");
	if (marker < 0) {
		throw new Error(
			`latch child produced no result.\nstdout: ${stdout}\nstderr: ${stderr}`,
		);
	}
	return JSON.parse(
		stdout.slice(marker + "__RESULT__".length),
	) as LatchChildResult;
}

describe("ROUND 7 — the launcher honours the keychain seam latch, not only the sentinel", () => {
	test("with the sentinel ABSENT, a process that ever installed the seam launches NOTHING", () => {
		const result = runLatchChild();

		// PRECONDITIONS, so this cannot pass for the wrong reason.
		// The sentinel was genuinely absent in the child.
		expect(result.guardEnvAtStart).toBeNull();
		// A fresh process with no sentinel is NOT guarded — so whatever refuses
		// below, it is not some other guard that was quietly kept.
		expect(result.reasonBeforeSeam).toBeNull();
		// The defences were in place: the user-facing opt-out, an empty PATH, a
		// temp HOME, a temp cwd.
		expect(result.disableEnv).toBe("1");
		expect(result.pathEnv).toBe(emptyPathDir);
		expect(result.home).toBe(join(sandbox, "home"));
		// `realpathSync`: macOS spells the temp root `/var` and `/private/var`.
		expect(realpathSync(result.cwd)).toBe(realpathSync(join(sandbox, "cwd")));

		// THE LATCH. Set by installing the seam, and it survives `null`.
		expect(result.reasonWithSeam).toBe("test-seam-latch");
		expect(result.reasonAfterRestore).toBe("test-seam-latch");

		// COVERAGE: every function export of the launcher module was invoked,
		// minus the two that do not launch. A launcher added later fails here
		// until the adversary knows about it.
		const launchers = result.exportedFunctions.filter(
			(name) => !NON_LAUNCHER_FUNCTION_EXPORTS.includes(name),
		);
		// Four since round 6 removed the generic command-taking launcher.
		expect(launchers.length).toBeGreaterThanOrEqual(4);
		expect(result.invoked).toEqual(launchers);

		// THE COUNTS. Both zero before, both zero after. These are real counters
		// incremented immediately before the respective process API and after the
		// veto; nothing resets them.
		expect(result.launchesBefore).toBe(0);
		expect(result.launchesAfter).toBe(0);
		expect(result.spawnsBefore).toBe(0);
		expect(result.spawnsAfter).toBe(0);

		// And every launcher refused for the RIGHT reason — the latch, by name.
		for (const name of launchers) {
			const outcome = result.outcomes[name];
			expect(outcome?.threw).toBe(true);
			expect(outcome?.name).toBe("EntryPointLaunchRefusedError");
			expect(outcome?.reason).toBe("test-seam-latch");
		}
	});

	test("the predicate is shared: the launcher does not read the sentinel on its own", async () => {
		// Structural half of the same rule. If the launcher grows a second,
		// private reading of the sentinel, the two modules can drift again; the
		// only permitted mention of the variable name in the launcher is the one
		// that builds the refusal message.
		const source = await Bun.file(
			join(import.meta.dir, "../../../src/core/entry-point-launcher.ts"),
		).text();
		expect(source).toContain(
			'import { guardedProcessReason } from "./keychain.js"',
		);
		expect(source).not.toMatch(/process\.env\[\s*TEST_GUARD_ENV\s*\]/);
		expect(source).not.toMatch(/process\.env\.MNEMEX_KEYCHAIN_TEST_GUARD/);

		// And the keychain module, which owns the latch, exports the predicate in
		// both spellings. It has no imports of its own, so the launcher importing
		// it is a straight edge, not a cycle.
		const keychain = await import("../../../src/core/keychain.js");
		expect(typeof keychain.isGuardedProcess).toBe("function");
		expect(typeof keychain.guardedProcessReason).toBe("function");
		const keychainSource = await Bun.file(
			join(import.meta.dir, "../../../src/core/keychain.ts"),
		).text();
		expect(keychainSource).not.toMatch(/^import\s/m);

		// In THIS process the preload's sentinel is set, so the predicate says so.
		expect(keychain.guardedProcessReason()).toBe("sentinel");
	});
});
