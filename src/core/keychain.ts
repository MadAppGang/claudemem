/**
 * macOS Keychain ENGINE.
 *
 * Speaks keychain vocabulary only — service, account, argv, exit codes. It knows
 * nothing about `GlobalConfig`, config fields, mnemex key ids or environment
 * variable names; that is `src/core/secrets.ts`'s job. The arrow that matters:
 * `keychain.ts` never imports the config, and `secrets.ts` never builds argv.
 *
 * Everything that touches the outside world goes through ONE driven port,
 * `KeychainDeps` (hexagonal, at exactly one seam). Production supplies a
 * `Bun.spawnSync` adapter; tests supply a recording stub. The adapter DENIES BY
 * DEFAULT and only spawns after `enableRealKeychainAccess()` — which exactly one
 * file, `src/index.ts`, calls — so an accidental real spawn from a test is
 * impossible rather than merely discouraged, and impossible without depending on
 * the working directory or on an inherited environment variable.
 *
 * "ONE port" is a claim about the whole repository, not about this file. It was
 * FALSE until external review found `src/llm/providers/claude-code.ts` reading
 * Claude Code's OAuth token with its own `execSync` on a relative binary name —
 * the default enrichment provider, outside every veto here. `readGenericPassword`
 * below exists so that caller has somewhere to go; the static sweep in
 * `test/unit/core/keychain.test.ts` now scans `src/` as well as the test roots so
 * a second one cannot appear quietly.
 *
 * ---------------------------------------------------------------------------
 * Measured facts this module is built on (this machine, real keychain, before
 * the no-spawn constraint took effect — NOT re-measurable under it):
 *
 *   find-generic-password -w   hit                 10.5 ms
 *   find-generic-password -w   miss (exit 44)      22.4 ms   ← a miss costs 2.1x a hit
 *   dump-keychain              6 accounts, 1 spawn 11.5 ms   ← does NOT generalise (M5)
 *
 *   Bun.spawnSync honours `timeout` exactly (1000 ms on `sleep 5` -> 1003 ms,
 *   exitCode null, SIGTERM). But a LOCKED keychain blocks EVERY spawn for its
 *   full timeout, so a module that retries per key costs `keys x timeout`. The
 *   timeout is necessary and not sufficient — hence the burst memo, the failure
 *   latch, the circuit breaker and the process budget below.
 *
 *   A value containing a control character reads back from `-w` as bare hex with
 *   NOTHING marking it as hex, and a printable key that happens to be all hex
 *   digits is genuinely ambiguous. Control characters are therefore rejected at
 *   WRITE time, which makes every read unambiguous by construction.
 * ---------------------------------------------------------------------------
 *
 * Rejected alternatives, recorded so they are not re-proposed:
 *
 *  - `execSync`/`execFileSync` with `input`: hangs for the full timeout when the
 *    parent's stdin is in raw mode, which is exactly what the OpenTUI wizard does.
 *  - A native keychain binding: inside a `bun --compile` executable it presents a
 *    different code identity on every rebuild, so macOS raises a fresh
 *    authorization dialog each time. Shelling out to the Apple-signed
 *    `/usr/bin/security` and pinning the ACL to it keeps later reads dialog-free.
 *  - `dump-keychain` first for single reads: a cold miss would get cheaper
 *    (11.5 ms, and it primes all six accounts) but a cold HIT would cost two
 *    spawns. V5 is "cold read costs at most ONE spawn"; the requirement decides it.
 *  - A dual-read on miss (account, then env-var name): same violation of V5, and
 *    pre-migration EVERY getter takes the miss path, so it would double 22.4 ms
 *    permanently to serve a hand-created item. `enumerateKeychainAccounts` surfaces
 *    those items instead, at zero extra spawns.
 *
 * stdout purity (CLAUDE.md #14): this module writes to stdout ZERO times.
 * `security`'s stderr is always piped, never inherited — the most common
 * operation is a miss, which prints one line there, and inheriting would spray it
 * into a terminal shared with the Claude Code TUI (CLAUDE.md #6).
 */

// ============================================================================
// Constants
// ============================================================================

/** Keychain service name — groups all mnemex secrets. Never changed; `git log` confirms. */
export const KEYCHAIN_SERVICE = "mnemex";

/** Absolute: a mutable PATH must not select the binary that handles secrets. */
const SECURITY_BIN = "/usr/bin/security";

/**
 * `security` exit code for "item not found".
 *
 * INHERITED from the reference implementation and confirmed once by hand before
 * the no-spawn constraint took effect. It is deliberately NOT re-verified — the
 * constraint forbids the measurement. The actual guard is `NOT_FOUND_STDERR`
 * below: if this number ever changes, the stderr line still classifies the miss,
 * and a miss misclassified as a FAILURE degrades to a config-file read rather
 * than to a lost key. That is the safe direction.
 */
const EXIT_ITEM_NOT_FOUND = 44;

/** The stderr line a miss prints. Specific enough not to match a lock or ACL error. */
const NOT_FOUND_STDERR = /could not be found/i;

/** A burst window, not a session cache: the user may edit Keychain Access.app mid-run. */
const MEMO_TTL_MS = 3000;

/**
 * Per-spawn timeout for single-item operations. 3 s is 134x the slowest measured
 * operation (22.4 ms). It was 5000; H7 lowered it because the AGGREGATE, not the
 * per-call bound, is what can make a held index lock look stale.
 */
export const SPAWN_TIMEOUT_MS = 3000;

/**
 * Enumeration gets more room than a single read so that SLOW is not reported as
 * FAILED. 11.5 ms was measured against a SIX-account keychain and does not
 * generalise to a login keychain holding thousands of certificates, Safari
 * passwords and Wi-Fi entries, all of whose attributes `dump-keychain` prints.
 */
export const ENUMERATE_TIMEOUT_MS = 5000;

/**
 * Total wall time this process may EVER spend inside `deps.run`.
 *
 * The arithmetic, recomputed against the real terms (review finding N4 — the
 * design's own "6 s bound" was broken by its own `ENUMERATE_TIMEOUT_MS = 5000`):
 *
 *   `src/core/lock.ts` — DEFAULT_STALE_TIMEOUT = 10000, HEARTBEAT_INTERVAL = 1000.
 *   `Bun.spawnSync` BLOCKS the event loop, so the 1 s heartbeat `setInterval`
 *   cannot fire while a spawn is outstanding. `isLockStale`'s secondary rule
 *   reclaims a lock whose heartbeat is older than 10 s REGARDLESS of pid liveness,
 *   so a long enough blocked stretch puts two indexers on one LanceDB store.
 *
 *   Worst-case staleness = (time since the last beat when the block began, < 1000)
 *                        + (longest contiguous blocked stretch).
 *
 *   A POST-HOC budget check permits a spawn to BEGIN at 5999 ms consumed; with
 *   ENUMERATE_TIMEOUT_MS it then blocks another 5000, giving 10999 + 1000 = 11999.
 *   That is ABOVE the 10 s threshold the mechanism exists to stay under.
 *
 *   `runGuarded` therefore applies the budget as a PRE-FLIGHT CLAMP:
 *       remaining = BUDGET - used; if (remaining <= 0) -> inert, no spawn
 *       timeout   = min(opTimeout, remaining)
 *   With the clamp the sum of all `deps.run` time is <= 6000 ms by construction,
 *   so worst-case staleness <= 1000 + 6000 = 7000 ms, leaving 3000 ms of margin
 *   below DEFAULT_STALE_TIMEOUT. (The design claimed 4 s of margin; it forgot the
 *   up-to-1 s heartbeat phase offset. 3 s is the true figure.)
 *
 * Do not raise this above ~9000 without re-doing that arithmetic.
 */
export const KEYCHAIN_PROCESS_BUDGET_MS = 6000;

/**
 * PRIVATE sentinel, set only by `test/setup/keychain-guard.ts`, which `bun test`
 * preloads. No production meaning; nothing else in the world sets it.
 *
 * It replaces a `NODE_ENV === "test"` check that was measured to be wrong: `bun
 * test` sets `NODE_ENV="test"` and does NOT set `BUN_TEST`, so the original
 * guard's only live signal was a standard variable an ordinary shell or CI job
 * sets for unrelated reasons — and the refusal lives in the READ path, so it
 * would have silently disabled the keychain for real users.
 */
const TEST_GUARD_ENV = "MNEMEX_KEYCHAIN_TEST_GUARD";

/** Synthetic `code` values. The adapter never invents a real `security` exit code. */
const CODE_SIGNAL_KILL = -1; // spawn killed by a signal (timeout). Recoverable class.
const CODE_NO_SPAWN = -2; // refused before spawning (guard, platform, no Bun).
const CODE_INERT = -3; // breaker tripped or budget exhausted. No spawn attempted.

// ============================================================================
// Types
// ============================================================================

/** Thrown by the WRITE and DELETE paths. Reads return data instead — see below. */
export class KeychainError extends Error {
	readonly exitCode?: number;

	constructor(message: string, exitCode?: number) {
		super(message);
		this.name = "KeychainError";
		this.exitCode = exitCode;
	}
}

/**
 * A `createOnly` write refused because an item already exists.
 *
 * A distinct type because the CALLER's correct response is distinct: migration
 * reports `skippedAlreadyStored` and keeps the plaintext copy, where every other
 * write failure is a genuine failure. Collapsing the two would make "an item
 * appeared between the check and the write" indistinguishable from "the keychain
 * is broken", and only one of those is safe to report as success.
 */
export class KeychainDuplicateItemError extends KeychainError {
	constructor(account: string) {
		super(`an item already exists for account "${account}"`, 45);
		this.name = "KeychainDuplicateItemError";
	}
}

/**
 * A read answer. Three-way on purpose: "I could not ask" must never be the same
 * value as "there is nothing there". Collapsing those is defect D5, and it is what
 * lets an import plan overwrite existing keys while reporting them as new.
 */
export type KeychainRead =
	| { status: "found"; value: string }
	| { status: "absent" }
	| { status: "failed"; error: string; exitCode?: number };

export interface KeychainEnumeration {
	/** Sorted, de-duplicated. EMPTY when `failed` — never read this without checking. */
	accounts: string[];
	failed: boolean;
	error?: string;
}

export interface KeychainRunResult {
	code: number;
	stdout: string;
	stderr: string;
}

/**
 * The one driven port.
 *
 * `timeoutMs` is passed by the caller rather than chosen by the adapter so the
 * process budget can CLAMP it (N4). A stub written as `(args, stdin) => …` still
 * satisfies this type; a stub that wants to assert the clamp reads the third
 * argument.
 */
export interface KeychainDeps {
	platform: () => string;
	run: (
		args: string[],
		stdin?: string,
		timeoutMs?: number,
	) => KeychainRunResult;
}

// ============================================================================
// The port: production adapter, test seam, and the guard layers
// ============================================================================

/**
 * Latched the first time a test installs the seam. NEVER cleared, including by
 * `setKeychainTestDeps(null)`: a process that has ever stubbed the keychain does
 * not get to spawn for real afterwards.
 *
 * This is the half of layer 1 that needs no environment variable and no preload,
 * so it catches a suite that installs the seam without `bunfig.toml` — the exact
 * case where a `mock.module` bleed or a forgotten `afterEach` would otherwise
 * reach the developer's real login keychain.
 */
let testDepsEverInstalled = false;

/**
 * DENY BY DEFAULT. The real adapter does not spawn until a production entry point
 * has said, in so many words, that this process is allowed to reach the user's
 * login keychain. `src/index.ts` is the only caller.
 *
 * This inverts the guard that review finding A2 broke. The previous design was
 * allow-by-default plus three refusals, two of which (`MNEMEX_KEYCHAIN_TEST_GUARD`
 * and `MNEMEX_DISABLE_KEYCHAIN`) were written by ONE writer — `bunfig.toml`'s
 * `[test] preload` — which `bun` resolves against the CURRENT WORKING DIRECTORY
 * and does not walk up for. Measured: `cd test && bun test ../x.test.ts` left both
 * unset, and a fresh process has not yet tripped `testDepsEverInstalled`, so the
 * "four layers" collapsed to nothing and the next read reached
 * `/usr/bin/security` against the real login keychain. That is the incident this
 * whole constraint exists to prevent — it put unanswerable macOS authorization
 * dialogs on a user's screen.
 *
 * Under deny-by-default, cwd and preload are no longer load-bearing: a test
 * process, in any directory, with any environment, refuses because nothing in
 * `src/**` outside the entry point turns it on. The environment sentinel and the
 * latch remain as independent VETOES on top (see `realRun`), which is what covers
 * a child process that DOES run the real entry point.
 */
let realAccessEnabled = false;

/**
 * Production opt-in. Called exactly once, from `src/index.ts`, before any command
 * dispatch. Deliberately NOT an environment variable: an env var is inherited by
 * every child, which is precisely the propagation that made the old guard fragile.
 *
 * It is itself vetoed by the test sentinel, so a test that spawns the real binary
 * with the inherited environment still cannot reach the keychain.
 */
export function enableRealKeychainAccess(): void {
	if (process.env[TEST_GUARD_ENV] === "1") return;
	realAccessEnabled = true;
}

/**
 * DISABLE-ONLY test seam. There is deliberately NO exported way to set the gate
 * to `true`.
 *
 * The previous seam was `setRealKeychainAccessEnabledForTests(enabled: boolean)`,
 * and external review found it to be a live bypass in its own right: a fresh
 * process with no sentinel and no installed seam could call it with `true` and the
 * next `readKeychainAccount()` reached the real login keychain. A test seam that
 * can turn the production gate ON is not a seam, it is a second entry point — and
 * one that no static sweep was checking for.
 *
 * Turning the gate OFF is always safe (it can only cause a refusal), so this
 * direction needs no guard and the type makes the other direction unwritable.
 */
export function disableRealKeychainAccessForTests(): void {
	realAccessEnabled = false;
}

/**
 * Why this process counts as a TEST process, or `null` if it does not.
 *
 * THE ONE guarded-process predicate, shared with `src/core/entry-point-launcher.ts`.
 * External review (round 7, CRITICAL) found the two modules disagreeing: this file
 * vetoed on the sentinel OR the `testDepsEverInstalled` latch, while the launcher
 * vetoed on the sentinel alone — and the latch is private to this module, so the
 * launcher could not have consulted it. Sequence: a suite runs from a cwd where
 * `bunfig.toml` is not loaded (sentinel unset), installs the seam (latch set),
 * restores it with `setKeychainTestDeps(null)`, and production code then invokes
 * a launcher. The launcher saw no sentinel and started the real entry point; the
 * child has no latch (it is in-memory), called `enableRealKeychainAccess()`, and
 * reached the login keychain. The parent was safe and spawned a child that was
 * not (CWE-284/693).
 *
 * The fix is structural rather than a second copy of the check: this module owns
 * the latch, so it owns the predicate, and the launcher imports it. This file has
 * NO imports of its own, so `launcher -> keychain` cannot form a cycle.
 *
 * Read at CALL time, never captured at module load.
 */
export function guardedProcessReason(): "sentinel" | "test-seam-latch" | null {
	if (process.env[TEST_GUARD_ENV] === "1") return "sentinel";
	if (testDepsEverInstalled) return "test-seam-latch";
	return null;
}

/** `guardedProcessReason() !== null`. Both vetoes; either one is sufficient. */
export function isGuardedProcess(): boolean {
	return guardedProcessReason() !== null;
}

/**
 * `MNEMEX_KEYCHAIN_FILE` — a user- and CI-facing redirect, NOT our test mechanism.
 *
 * Read at CALL time, never captured at module load. `security` takes an optional
 * TRAILING keychain path per subcommand, so it must sit LAST in every argv (and
 * last on the `-i` stdin command line).
 *
 * Driving a throwaway keychain from inside an interactive session is PROHIBITED,
 * not merely discouraged: it re-locks on its idle timer and raises authorization
 * dialogs whose password only the tooling knows.
 */
function keychainFileArgs(): string[] {
	const file = process.env.MNEMEX_KEYCHAIN_FILE;
	return file ? [file] : [];
}

/** The resolved keychain target. Every cache key embeds it (H6). */
function currentTarget(): string {
	return keychainFileArgs().join("\u0001");
}

function realRun(
	args: string[],
	stdin?: string,
	timeoutMs: number = SPAWN_TIMEOUT_MS,
): KeychainRunResult {
	// Three independent vetoes, checked before anything else. The FIRST one needs
	// no environment variable, no preload and no working directory (A2).
	if (!realAccessEnabled) {
		return {
			code: CODE_NO_SPAWN,
			stdout: "",
			stderr:
				"refusing to spawn /usr/bin/security: real keychain access was never enabled in this process",
		};
	}
	if (isGuardedProcess()) {
		return {
			code: CODE_NO_SPAWN,
			stdout: "",
			stderr: "refusing to spawn /usr/bin/security from a guarded process",
		};
	}
	if (typeof Bun === "undefined") {
		return { code: CODE_NO_SPAWN, stdout: "", stderr: "Bun runtime required" };
	}

	// THE CHOKE POINT. Past all three vetoes; nothing else in this repository may
	// spawn the binary (enforced by the static sweep in
	// `test/unit/core/keychain.test.ts`, which scans `src/` with this file as its
	// single exception). Counted BEFORE the call, so a throwing spawn still counts.
	realSecuritySpawns++;

	const proc = Bun.spawnSync({
		cmd: [SECURITY_BIN, ...args],
		// stderr is ALWAYS "pipe". Inheriting sprays one "could not be found" line
		// per key per pass into a terminal shared with the Claude Code TUI.
		stdin: stdin === undefined ? "ignore" : Buffer.from(stdin, "utf8"),
		stdout: "pipe",
		stderr: "pipe",
		timeout: timeoutMs,
	});

	const stdout = proc.stdout ? proc.stdout.toString() : "";
	const rawStderr = proc.stderr ? proc.stderr.toString() : "";

	if (proc.exitCode === null) {
		// Never collapse a signal kill to 1: doing that once sent an investigation
		// of a ten-second timeout looking for a usage error.
		const sig = proc.signalCode ?? "SIGTERM";
		return {
			code: CODE_SIGNAL_KILL,
			stdout,
			stderr: rawStderr || `security killed by ${sig}`,
		};
	}
	return { code: proc.exitCode, stdout, stderr: rawStderr };
}

const realDeps: KeychainDeps = {
	platform: () => process.platform,
	run: realRun,
};

let deps: KeychainDeps = realDeps;

/**
 * Install (or restore) the test seam.
 *
 * Clears the memos, the failure latch, the circuit breaker AND the process budget
 * so nothing leaks between tests. Production never calls this — it is the only
 * thing that resets the budget short of process exit.
 */
export function setKeychainTestDeps(next: Partial<KeychainDeps> | null): void {
	if (next === null) {
		deps = realDeps;
	} else {
		testDepsEverInstalled = true;
		deps = {
			platform: next.platform ?? realDeps.platform,
			run: next.run ?? realDeps.run,
		};
	}
	invalidateKeychainCache();
	resetKeychainBreaker();
	resetKeychainProcessBudget();
}

// ============================================================================
// Burst memo, failure latch, circuit breaker, process budget
// ============================================================================

/**
 * H6: every cache key names the keychain it came from. `MNEMEX_KEYCHAIN_FILE` is
 * read at CALL time and is user-settable, so an answer memoised against one
 * keychain must never be served for another — both answers are well-formed, which
 * is what makes that bug invisible.
 */
function memoKey(service: string, account: string | undefined): string {
	return `${currentTarget()}\u0000${service}\u0000${account ?? ""}`;
}

/** Per-account answers. Only ever "found" or "absent" — never a failure. */
const valueMemo = new Map<string, { at: number; value: KeychainRead }>();

/** The whole-store enumeration answer, INCLUDING a failed one. Carries its target. */
let listMemo: {
	at: number;
	target: string;
	value: KeychainEnumeration;
} | null = null;

/**
 * ONE failure for the whole store, for the burst. This is what bounds a locked
 * keychain to 1 spawn instead of `keys x timeout`.
 *
 * Caching a failure is safe here ONLY because the cached value is TYPED as
 * `failed`. The danger is caching a failure as an ABSENCE; the type does not
 * permit it, and every consumer branches on it.
 */
let failureLatch: {
	at: number;
	target: string;
	error: string;
	exitCode?: number;
} | null = null;

/**
 * Tripped by the first timeout- or lock-class failure. Separate flag, separate
 * lifetime: `invalidateKeychainCache()` runs before AND after every mutation and
 * deliberately does NOT clear this, or any memo-based breaker would be defeated
 * on the write path — which is the path where a locked keychain costs the most.
 *
 * Cleared by: a successful `run`, `setKeychainTestDeps()`, and
 * `resetKeychainBreaker()` (used by the one caller about to `process.exit(1)`).
 */
let breaker: { error: string; exitCode?: number } | null = null;

/** Total ms spent inside `deps.run` this process. See KEYCHAIN_PROCESS_BUDGET_MS. */
let budgetUsedMs = 0;

/**
 * HOW MANY TIMES THIS PROCESS HAS SPAWNED `/usr/bin/security`. The real thing.
 *
 * Incremented at the ONE choke point, immediately before `Bun.spawnSync` and
 * AFTER all three vetoes — so it can only ever be moved by an actual spawn.
 *
 * WHY IT EXISTS. The guard tests asserted `keychainProcessBudgetUsedMs() === 0`
 * and called it a spawn count. It is not one. `runGuarded` charges
 * `Date.now() - started` around `deps.run`, and a REFUSED call still traverses
 * that timed region: on an idle machine it is charged 0 ms, and under full-suite
 * load the two `Date.now()` calls straddle a millisecond boundary and it is
 * charged 1. The test duly passed in isolation and failed in the full suite —
 * while the security property was intact the entire time. A proxy that cannot
 * distinguish "refused in 1 ms" from "spawned in 1 ms" is not evidence, and this
 * is the assertion carrying the build's central safety claim. Milliseconds never
 * stand in for a spawn count.
 *
 * MONOTONIC AND UNRESETTABLE, deliberately. `setKeychainTestDeps` clears the
 * memos, the breaker and the budget; it must not be able to clear this. There is
 * no setter and no reset — the only way to move it is to spawn.
 *
 * It counts the ATTEMPT rather than the return, so a spawn that throws is still
 * counted. The number is therefore an upper bound and can never undercount.
 */
let realSecuritySpawns = 0;

/** Lock-class stderr: the keychain is locked or the ACL prompt was refused. */
const STALL_CLASS_STDERR =
	/interaction is not allowed|user interaction|is locked|locked keychain|-25308|-25307/i;

function isStallClass(res: KeychainRunResult): boolean {
	return res.code === CODE_SIGNAL_KILL || STALL_CLASS_STDERR.test(res.stderr);
}

export function invalidateKeychainCache(): void {
	valueMemo.clear();
	listMemo = null;
	failureLatch = null;
}

/** Deliberately NOT part of `invalidateKeychainCache()` — see `breaker`. */
export function resetKeychainBreaker(): void {
	breaker = null;
}

/**
 * Nothing but process exit clears the budget in production. Exported for the test
 * seam and for `resolveSecretBeforeHardExit` (N8): a re-ask that cannot spawn
 * because the budget is spent is a silent no-op, which is worse than not offering
 * the remedy at all.
 */
export function resetKeychainProcessBudget(): void {
	budgetUsedMs = 0;
}

/**
 * Test/diagnostic accessor for the TIME budget.
 *
 * This is MILLISECONDS. It is not a spawn count and must never be asserted on as
 * one: a refusal is charged the near-zero — occasionally 1 ms — cost of passing
 * through `runGuarded`'s timed region without spawning. Use
 * `realKeychainSpawnCount()` for "did this process spawn the binary".
 */
export function keychainProcessBudgetUsedMs(): number {
	return budgetUsedMs;
}

/**
 * THE spawn count: how many times this process has invoked `/usr/bin/security`.
 *
 * Zero is proof of no spawn, with no inference in between. Monotonic, with no
 * setter and no reset, so no test seam can launder it.
 */
export function realKeychainSpawnCount(): number {
	return realSecuritySpawns;
}

/**
 * TEST SEAM ONLY. In production the budget accrues from real `deps.run` wall time
 * and nothing but process exit (or the pre-hard-exit re-ask) clears it. Tests use
 * this to reach the exhaustion boundary without sleeping for six real seconds —
 * asserting the CLAMP rather than merely the eventual inertness is the point.
 */
export function setKeychainProcessBudgetUsedMs(ms: number): void {
	budgetUsedMs = ms;
}

/**
 * The ONLY path to `deps.run`. Applies the breaker and the pre-flight budget clamp.
 */
function runGuarded(
	args: string[],
	stdin: string | undefined,
	opTimeoutMs: number,
): KeychainRunResult {
	if (breaker) {
		return {
			code: CODE_INERT,
			stdout: "",
			stderr: `keychain circuit breaker open: ${breaker.error}`,
		};
	}

	// N4: a PRE-FLIGHT clamp, not a post-hoc trip. A post-hoc check would let a
	// spawn BEGIN at 5999 ms consumed and then block for its full timeout.
	const remaining = KEYCHAIN_PROCESS_BUDGET_MS - budgetUsedMs;
	if (remaining <= 0) {
		return {
			code: CODE_INERT,
			stdout: "",
			stderr: `keychain time budget for this process is exhausted (${KEYCHAIN_PROCESS_BUDGET_MS} ms)`,
		};
	}
	const timeout = Math.min(opTimeoutMs, remaining);

	const started = Date.now();
	let res: KeychainRunResult;
	try {
		res = deps.run(args, stdin, timeout);
	} finally {
		budgetUsedMs += Date.now() - started;
	}

	if (res.code === 0 || isNotFound(res)) {
		// Evidence the store is reachable again.
		breaker = null;
	} else if (isStallClass(res)) {
		breaker = { error: res.stderr || "keychain stalled", exitCode: res.code };
	}
	return res;
}

function isNotFound(res: KeychainRunResult): boolean {
	return (
		res.code === EXIT_ITEM_NOT_FOUND || NOT_FOUND_STDERR.test(res.stderr ?? "")
	);
}

/**
 * The create-only refusal: an item with this service+account already exists.
 *
 * Classified from BOTH signals for the same reason `isNotFound` is: the exit code
 * (45) is inherited rather than re-measured — the no-spawn constraint forbids
 * measuring it — and `errSecDuplicateItem` (-25299) is what the stderr line
 * carries. A duplicate misclassified as a generic failure degrades to "migration
 * refused, plaintext copy retained", which is the safe direction.
 */
function isDuplicateItem(res: KeychainRunResult): boolean {
	return res.code === 45 || /duplicate|-25299/i.test(res.stderr ?? "");
}

/** A failure worth latching for the burst. Signal kills and no-spawn results are not (H5). */
function isLatchable(res: KeychainRunResult): boolean {
	return res.code > 0;
}

function failureFrom(res: KeychainRunResult): KeychainRead {
	return {
		status: "failed",
		error: res.stderr?.trim() || `security exited ${res.code}`,
		exitCode: res.code,
	};
}

// ============================================================================
// Platform / availability
// ============================================================================

export function isKeychainSupported(): boolean {
	return deps.platform() === "darwin" && typeof Bun !== "undefined";
}

/** Kept for `src/cli.ts`'s dynamic import — same signature, now through the seam. */
export function isKeychainAvailable(): boolean {
	return isKeychainSupported();
}

export function keychainUnavailableReason(): string | null {
	const platform = deps.platform();
	if (platform !== "darwin") return `keychain unavailable on ${platform}`;
	if (typeof Bun === "undefined") return "Bun runtime required";
	return null;
}

// ============================================================================
// Value rules
// ============================================================================

/**
 * Returns a human reason why `value` cannot be stored, or null.
 *
 * Runs BEFORE any seam call — V3 asserts the stub was never invoked. Rejecting
 * control characters is necessary, not defensive: `-w` prints bare hex for such a
 * value with nothing marking it as hex.
 */
export function describeUnstorableValue(value: string): string | null {
	if (typeof value !== "string") return "value is not a string";
	if (value.length === 0) return "value is empty";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
	if (/[\u0000-\u001F\u007F]/.test(value)) {
		return "value contains control characters (it would read back as ambiguous hex)";
	}
	return null;
}

/**
 * Strip EXACTLY one trailing newline, never `.trim()`.
 *
 * `trim` also eats whitespace that may be part of the secret, producing a 401
 * nobody can explain. This is the read-back rule and it is the OPPOSITE of the
 * rule for fresh user input, which IS trimmed at the prompt/wizard boundary
 * because that is about this write, not about stored data.
 */
function stripOneTrailingNewline(raw: string): string {
	return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
}

/** "••••1234". Never reveals more than 4 characters, and nothing at all when short. */
export function maskSecret(value: string): string {
	if (typeof value !== "string" || value.length === 0) return "••••";
	if (value.length <= 8) return "••••";
	return `••••${value.slice(-4)}`;
}

/** Accounts are addresses in argv. The registry in secrets.ts owns which ones exist. */
const ACCOUNT_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * Services are addresses in argv too, and a foreign one ("Claude Code-credentials")
 * carries a space, so it cannot reuse `ACCOUNT_SHAPE`. Printable ASCII only: the
 * value never reaches a shell, but a control character in argv is still a way to
 * make a log line lie about what was asked for.
 */
const SERVICE_SHAPE = /^[\u0020-\u007E]{1,255}$/;

function assertValidAccount(account: string): void {
	if (!ACCOUNT_SHAPE.test(account)) {
		throw new KeychainError(`invalid keychain account name: ${account}`);
	}
}

function toHex(value: string): string {
	return Buffer.from(value, "utf8").toString("hex");
}

// ============================================================================
// Read
// ============================================================================

/**
 * `fresh` — DO NOT ANSWER FROM THE BURST MEMO. Ask the keychain, now.
 *
 * THE FINDING (external review round 3, HIGH 2). `persistSecrets` reads before it
 * writes, and treats a byte-identical `found` as PROOF that the keychain holds
 * the value — proof that then authorises deleting the plaintext copy from
 * `config.json`. But that read could be served by the three-second memo, so the
 * "proof" was an answer obtained up to three seconds earlier, possibly before
 * another process removed the item:
 *
 *   1. Both `config.json` and the keychain hold `openrouter=X`.
 *   2. Process A reads X. The memo now holds X.
 *   3. Process B runs an unforced `keychain rm openrouter`. It is allowed to,
 *      because the plaintext copy still exists, and deletes the keychain item.
 *   4. Within the TTL, A saves `openrouter=X`. The pre-read is a memo hit, so A
 *      never asks the keychain anything.
 *   5. A records `"keychain"` and `saveGlobalConfig` deletes the field from the
 *      file. X now exists in neither place, and neither command used `--force`.
 *
 * This was the fourth appearance of one defect class: a claim of proof satisfied
 * by evidence that was not obtained by the call making the claim. The memo is
 * right for the five getters — it exists so a burst of reads costs one spawn —
 * and wrong for the one read whose whole job is to be current.
 *
 * A stale FAILURE cannot fabricate a proof (nothing downstream treats `failed` as
 * evidence), so the failure latch and the breaker still apply: they bound a
 * locked keychain to one spawn, which is the property that keeps a wedged machine
 * usable.
 */
export interface KeychainReadOptions {
	fresh?: boolean;
}

export function readKeychainAccount(
	account: string,
	options?: KeychainReadOptions,
): KeychainRead {
	// Reads return data, they do not throw (see the module header), so a bad
	// account name is a `failed` read rather than an exception — the five getters
	// that call this all want to fall through to their config fallback.
	if (!ACCOUNT_SHAPE.test(account)) {
		return { status: "failed", error: `invalid keychain account: ${account}` };
	}
	return readGenericPassword(KEYCHAIN_SERVICE, account, options);
}

/**
 * Read ANY generic password, by service, through this same port.
 *
 * WHY THIS IS PUBLIC. `src/llm/providers/claude-code.ts` — the DEFAULT enrichment
 * provider — read Claude Code's own OAuth token with
 * `execSync(<bare binary name> + ' find-generic-password -s "Claude Code-credentials" -w')`.
 * External review scored that as a live bypass of everything this file exists to
 * guarantee, and it was right on three counts:
 *
 *  1. It never consulted `realAccessEnabled`, the test sentinel or the latch, so
 *     "no process spawns the binary until the entry point opts in" was FALSE in
 *     every process that constructed the default LLM client — including a test.
 *  2. It named the binary RELATIVELY, resolved through a mutable `PATH`
 *     (CWE-426). A planted binary earlier on `PATH` received `-w` and printed the
 *     user's Claude Code OAuth token to a pipe this repo then parsed.
 *     `SECURITY_BIN` is absolute precisely so that cannot happen.
 *  3. Its own 5000 ms timeout was charged to nothing, so the process budget
 *     underpinning the 7000 ms stale-lock arithmetic did not account for it.
 *
 * Routing it here fixes all three at once and costs the caller nothing but a
 * different return type. This is NOT a general credential API: it reads, it never
 * writes, and `secrets.ts` still owns every mnemex-side policy decision.
 */
export function readGenericPassword(
	service: string,
	account?: string,
	options?: KeychainReadOptions,
): KeychainRead {
	if (!SERVICE_SHAPE.test(service)) {
		return { status: "failed", error: `invalid keychain service: ${service}` };
	}

	const unavailable = keychainUnavailableReason();
	if (unavailable) return { status: "failed", error: unavailable };

	const key = memoKey(service, account);
	const now = Date.now();

	// Both shortcuts below are CACHED ANSWERS, and a caller asking for `fresh`
	// is asking for an answer this call obtained. See `KeychainReadOptions`.
	const memo = options?.fresh ? undefined : valueMemo.get(key);
	if (memo && now - memo.at < MEMO_TTL_MS) return memo.value;

	// A fresh enumeration can answer "absent" for free — but ONLY for the mnemex
	// service, because `parseDumpAccounts` filters on `svce = "mnemex"` and knows
	// nothing about any other service's items.
	if (
		!options?.fresh &&
		service === KEYCHAIN_SERVICE &&
		account !== undefined &&
		listMemo &&
		listMemo.target === currentTarget() &&
		now - listMemo.at < MEMO_TTL_MS &&
		!listMemo.value.failed &&
		!listMemo.value.accounts.includes(account)
	) {
		const absent: KeychainRead = { status: "absent" };
		valueMemo.set(key, { at: now, value: absent });
		return absent;
	}

	if (
		failureLatch &&
		failureLatch.target === currentTarget() &&
		now - failureLatch.at < MEMO_TTL_MS
	) {
		return {
			status: "failed",
			error: failureLatch.error,
			exitCode: failureLatch.exitCode,
		};
	}

	const res = runGuarded(
		[
			"find-generic-password",
			"-s",
			service,
			...(account === undefined ? [] : ["-a", account]),
			"-w",
			...keychainFileArgs(),
		],
		undefined,
		SPAWN_TIMEOUT_MS,
	);

	if (res.code === 0) {
		const value = stripOneTrailingNewline(res.stdout);
		const found: KeychainRead = { status: "found", value };
		valueMemo.set(key, { at: Date.now(), value: found });
		return found;
	}
	if (isNotFound(res)) {
		const absent: KeychainRead = { status: "absent" };
		valueMemo.set(key, { at: Date.now(), value: absent });
		return absent;
	}

	// H5: a signal kill is NOT cached. The sequence that makes caching wrong:
	// first-ever read on a machine whose ACL prompt has not been answered ->
	// security blocks on the dialog -> the timeout SIGTERMs it while the dialog is
	// still on screen -> the user clicks Allow one second later, too late, because
	// the answer was already cached. The breaker still stops repeated stalls; that
	// is a different mechanism with a different lifetime.
	if (isLatchable(res)) {
		failureLatch = {
			at: Date.now(),
			target: currentTarget(),
			error: res.stderr?.trim() || `security exited ${res.code}`,
			exitCode: res.code,
		};
	}
	return failureFrom(res);
}

/** `{present, failed}` — the shape that makes D5 unrepresentable at this boundary. */
export function lookupKeychainAccount(account: string): {
	present: boolean;
	failed: boolean;
} {
	const read = readKeychainAccount(account);
	return {
		present: read.status === "found",
		failed: read.status === "failed",
	};
}

// ============================================================================
// Enumerate
// ============================================================================

/**
 * One `dump-keychain` answers "which accounts exist?" for every key (F5).
 *
 * No `-d`: attributes only, so it never triggers a per-item access dialog.
 * Off the hot path by construction — the getters read directly.
 */
export function enumerateKeychainAccounts(): KeychainEnumeration {
	const unavailable = keychainUnavailableReason();
	if (unavailable) return { accounts: [], failed: true, error: unavailable };

	const now = Date.now();
	const target = currentTarget();

	if (
		listMemo &&
		listMemo.target === target &&
		now - listMemo.at < MEMO_TTL_MS
	) {
		return listMemo.value;
	}
	if (
		failureLatch &&
		failureLatch.target === target &&
		now - failureLatch.at < MEMO_TTL_MS
	) {
		return { accounts: [], failed: true, error: failureLatch.error };
	}

	const res = runGuarded(
		["dump-keychain", ...keychainFileArgs()],
		undefined,
		ENUMERATE_TIMEOUT_MS,
	);

	if (res.code === 0) {
		const value: KeychainEnumeration = {
			accounts: parseDumpAccounts(res.stdout),
			failed: false,
		};
		listMemo = { at: Date.now(), target, value };
		return value;
	}

	const error = res.stderr?.trim() || `security exited ${res.code}`;
	const value: KeychainEnumeration = { accounts: [], failed: true, error };
	listMemo = { at: Date.now(), target, value };
	if (isLatchable(res)) {
		failureLatch = { at: Date.now(), target, error, exitCode: res.code };
	}
	return value;
}

/**
 * Parse `dump-keychain` output into the accounts stored under service "mnemex".
 *
 * Keeps EVERY account it finds under `svce = "mnemex"`, including ones no spec
 * claims. Dropping them made mnemex report a key as "not stored" while Keychain
 * Access showed an item with that exact name, and the next real write produced two
 * items with the same display name, one of them dead.
 *
 * Exported for tests: it is fixtured against a captured REAL dump block, which is
 * what keeps the un-remeasurable format honest.
 */
export function parseDumpAccounts(dump: string): string[] {
	const accounts = new Set<string>();
	// Each item starts at a `class: "…"` line. Split on it, keep the bodies.
	const blocks = dump.split(/^class:\s*/m).slice(1);
	for (const block of blocks) {
		if (!block.startsWith('"genp"')) continue;
		const svce = block.match(/"svce"<blob>="([^"]*)"/);
		if (!svce || svce[1] !== KEYCHAIN_SERVICE) continue;
		const acct = block.match(/"acct"<blob>="([^"]*)"/);
		if (acct?.[1]) accounts.add(acct[1]);
	}
	return Array.from(accounts).sort();
}

// ============================================================================
// Write
// ============================================================================

/**
 * Store `value` and PROVE it landed (F7).
 *
 * Throws `KeychainError` on any failure, including a write that exits 0 but does
 * not round-trip. Reads return data and writes throw, deliberately: reads have
 * five call sites that all want to fall through, and making them throw would put
 * `try/catch` in five getters where one missed `catch` aborts an index run. Writes
 * have exactly one caller, which must handle failure explicitly — a thrown error
 * makes forgetting impossible. The DISCARDED BOOLEAN of the old
 * `setKeychainSecret` is defect D1 itself.
 *
 * The verification read lives HERE rather than in the caller so it cannot be
 * skipped. Cost: a changed secret is 3 spawns (read-first, write, verify).
 */
export function writeKeychainAccount(
	account: string,
	value: string,
	label: string,
	options?: {
		/**
		 * Omit `-U`, so `security` REFUSES to replace an existing item instead of
		 * upserting it. `migrateFileSecrets` uses this: its "never overwrite" promise
		 * was previously a check-then-act pair (read reports absent, then an
		 * unconditional `-U` write), and anything that created the item in the window
		 * between them — a second mnemex process, or Keychain Access.app — was
		 * silently replaced with the stale plaintext copy and reported as `copied`.
		 * Create-only turns that promise into a property of the operation.
		 */
		createOnly?: boolean;
	},
): void {
	assertValidAccount(account);

	// Validation precedes EVERY seam call (V3).
	const unstorable = describeUnstorableValue(value);
	if (unstorable) {
		throw new KeychainError(`cannot store value for ${account}: ${unstorable}`);
	}

	const unavailable = keychainUnavailableReason();
	if (unavailable) throw new KeychainError(unavailable);

	invalidateKeychainCache();

	// The secret goes in NEITHER argv NOR a shell string: argv is exactly ["-i"]
	// and the value rides as `-X <hex>` on the stdin command line. `-T
	// /usr/bin/security` pins the ACL to the same Apple-signed binary every read
	// uses, which keeps later reads dialog-free. `-U` upserts; without it a second
	// write fails with -25299. The keychain path, when set, must be LAST.
	const stdin = `${[
		"add-generic-password",
		"-s",
		q(KEYCHAIN_SERVICE),
		"-a",
		q(account),
		"-l",
		q(label),
		"-D",
		q("application password"),
		"-j",
		q("Stored by mnemex"),
		"-X",
		q(toHex(value)),
		...(options?.createOnly ? [] : ["-U"]),
		"-T",
		q(SECURITY_BIN),
		...keychainFileArgs().map(q),
	].join(" ")}\n`;

	const res = runGuarded(["-i"], stdin, SPAWN_TIMEOUT_MS);
	if (res.code !== 0) {
		if (options?.createOnly && isDuplicateItem(res)) {
			throw new KeychainDuplicateItemError(account);
		}
		throw new KeychainError(
			res.stderr?.trim() || `security exited ${res.code}`,
			res.code,
		);
	}

	invalidateKeychainCache();

	const verify = readKeychainAccount(account);
	if (verify.status === "found" && verify.value === value) return;
	if (verify.status === "failed") {
		throw new KeychainError(
			`write could not be verified: ${verify.error}`,
			verify.exitCode,
		);
	}
	// Exit 0 is not proof; the read-back is.
	throw new KeychainError(`value written to ${account} did not round-trip`);
}

/** Quote a token for the `-i` command line. The VALUE is hex, so this never sees a secret. */
function q(token: string): string {
	return `"${token.replace(/(["\\$`])/g, "\\$1")}"`;
}

// ============================================================================
// Delete
// ============================================================================

/**
 * Returns true when an item was deleted, false when there was nothing to delete
 * (exit 44). BOTH are confirmations for invariant I3. Throws on a real failure —
 * a delete whose success is unproven must never be reported as "cleared", or D1
 * is simply re-created pointing the other way.
 */
export function deleteKeychainAccount(account: string): boolean {
	assertValidAccount(account);

	const unavailable = keychainUnavailableReason();
	if (unavailable) throw new KeychainError(unavailable);

	invalidateKeychainCache();
	const res = runGuarded(
		[
			"delete-generic-password",
			"-s",
			KEYCHAIN_SERVICE,
			"-a",
			account,
			...keychainFileArgs(),
		],
		undefined,
		SPAWN_TIMEOUT_MS,
	);
	invalidateKeychainCache();

	if (res.code === 0) return true;
	if (isNotFound(res)) return false;
	throw new KeychainError(
		res.stderr?.trim() || `security exited ${res.code}`,
		res.code,
	);
}
