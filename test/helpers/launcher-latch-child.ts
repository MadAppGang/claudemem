/**
 * The adversary for external review round 7's CRITICAL: a process in which the
 * keychain adapter is guarded by the LATCH ALONE, that then asks every exported
 * launcher to start the real entry point.
 *
 * THE SEQUENCE THIS REPRODUCES
 *   1. The test sentinel `MNEMEX_KEYCHAIN_TEST_GUARD` is GENUINELY ABSENT — the
 *      parent deletes it from this child's env on purpose, standing in for a
 *      suite run from a cwd where `bunfig.toml` is not loaded.
 *   2. `setKeychainTestDeps(...)` installs the seam, tripping the irreversible
 *      `testDepsEverInstalled` latch. In-process keychain access is now denied.
 *   3. `setKeychainTestDeps(null)` restores the real adapter.
 *   4. Production code invokes a launcher.
 *
 * Before the fix, step 4 launched: the launcher read only the sentinel, and the
 * latch lives in `src/core/keychain.ts` where the launcher could not see it. The
 * child of that launch has no latch, calls `enableRealKeychainAccess()`, and can
 * reach the login keychain. Since the fix, both modules consult ONE predicate
 * (`guardedProcessReason()`), so step 4 throws `EntryPointLaunchRefusedError`
 * with `reason === "test-seam-latch"`.
 *
 * IT REPORTS TWO REAL COUNTS, not a status string and not milliseconds:
 * `entryPointLaunchCount()` (incremented immediately before the launcher's
 * `spawn`, after the veto) and `realKeychainSpawnCount()` (the same contract at
 * the keychain's `Bun.spawnSync`). Zero after the run is proof.
 *
 * DEFENCE IN DEPTH, because this child is the exact shape that reaches the real
 * keychain if the fix is wrong. The parent gives it `MNEMEX_DISABLE_KEYCHAIN=1`
 * (the user-facing opt-out — a DIFFERENT variable from the test sentinel), a
 * `PATH` naming only an empty temp dir so a bare `mnemex` cannot resolve, and a
 * temp `HOME`. This file adds a recursion breaker: `spawnSelfDetached` and
 * `runSelfSync` re-exec `process.argv[1]`, which here is THIS script, so a
 * failed veto would otherwise fork-bomb.
 *
 * NOTHING HERE MAY SPAWN ANYTHING. That is the assertion.
 *
 * Usage: bun run test/helpers/launcher-latch-child.ts
 * Prints one JSON line on stdout after `__RESULT__`.
 */

import * as launcher from "../../src/core/entry-point-launcher.js";
import {
	guardedProcessReason,
	realKeychainSpawnCount,
	setKeychainTestDeps,
} from "../../src/core/keychain.js";

// RECURSION BREAKER. If the veto fails, the two "self" launchers re-exec this
// very file. Exit before doing anything so a red run is one extra process, not
// an exponential number of them. Set before any launcher runs, so every child
// inherits it (node's `spawn` defaults `env` to `process.env`).
const DEPTH_ENV = "MNEMEX_LAUNCHER_LATCH_CHILD_DEPTH";
if (process.env[DEPTH_ENV] === "1") process.exit(0);
process.env[DEPTH_ENV] = "1";

const guardEnvAtStart = process.env.MNEMEX_KEYCHAIN_TEST_GUARD ?? null;
const reasonBeforeSeam = guardedProcessReason();

// Step 2: install the seam. The stub refuses loudly if anything reaches it.
setKeychainTestDeps({
	run: () => ({ code: 1, stdout: "", stderr: "latch-child stub" }),
});
const reasonWithSeam = guardedProcessReason();

// Step 3: restore the real adapter. The latch must survive this.
setKeychainTestDeps(null);
const reasonAfterRestore = guardedProcessReason();

const launchesBefore = launcher.entryPointLaunchCount();
const spawnsBefore = realKeychainSpawnCount();

const cwd = process.cwd();
const args = ["--version"];

/**
 * EVERY exported launcher, by name, with the arguments its signature wants.
 * The parent asserts this map covers every function export of the module (minus
 * the known non-launchers), so a launcher added later cannot be silently missing
 * from the adversary.
 */
const invocations: Record<string, () => unknown> = {
	spawnMnemexDetached: () => launcher.spawnMnemexDetached(args, cwd),
	spawnMnemexAwaited: () => launcher.spawnMnemexAwaited(args, cwd),
	spawnSelfDetached: () => launcher.spawnSelfDetached(args, cwd),
	runSelfSync: () => launcher.runSelfSync(args, cwd, 2000),
};

const outcomes: Record<
	string,
	{ threw: boolean; name?: string; reason?: string; message?: string }
> = {};

for (const [name, invoke] of Object.entries(invocations)) {
	try {
		const result = invoke() as
			| { on?: (event: string, cb: (e: Error) => void) => void }
			| undefined;
		// A launch that DID happen with an empty PATH reports ENOENT asynchronously
		// on the child object. Swallow it so the process lives long enough to
		// print the (now failing) counts rather than dying on an unhandled 'error'.
		if (result && typeof result.on === "function") {
			result.on("error", () => {});
		}
		outcomes[name] = { threw: false };
	} catch (error) {
		const e = error as Error & { reason?: string };
		outcomes[name] = {
			threw: true,
			name: e.name,
			reason: e.reason,
			message: e.message,
		};
	}
}

const exportedFunctions = Object.entries(launcher)
	.filter(([, value]) => typeof value === "function")
	.map(([name]) => name)
	.sort();

const out = {
	cwd,
	// Proof the sentinel really was absent — otherwise this passes for the wrong
	// reason, which is how the launcher's own guard passed for four rounds.
	guardEnvAtStart,
	disableEnv: process.env.MNEMEX_DISABLE_KEYCHAIN ?? null,
	pathEnv: process.env.PATH ?? null,
	home: process.env.HOME ?? null,
	reasonBeforeSeam,
	reasonWithSeam,
	reasonAfterRestore,
	// THE COUNTS.
	launchesBefore,
	launchesAfter: launcher.entryPointLaunchCount(),
	spawnsBefore,
	spawnsAfter: realKeychainSpawnCount(),
	exportedFunctions,
	invoked: Object.keys(invocations).sort(),
	outcomes,
};

process.stdout.write(`\n__RESULT__${JSON.stringify(out)}\n`);
