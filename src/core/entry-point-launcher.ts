/**
 * THE ONE PLACE THAT MAY START A MNEMEX ENTRY POINT.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `src/index.ts:32` calls `enableRealKeychainAccess()`. That single line is what
 * makes "spawn the entry point" a security event rather than a process detail:
 * the child turns the production keychain gate ON inside itself, and no runtime
 * guard in the PARENT can veto that. From there `mnemex index` resolves
 * embedding credentials and reaches `/usr/bin/security` against the developer's
 * real login keychain, raising authorization dialogs whose password only the
 * tooling knows.
 *
 * Three review rounds found three separate launches of that entry point, each
 * invisible to the static sweep as it then stood:
 *
 *   R3a `tests/rg.test.ts`         the path split across `join()` arguments.
 *   R3b `src/mcp/reindexer.ts`     production code launching the installed
 *                                  binary, reached TRANSITIVELY from nine
 *                                  `DebounceReindexer` constructions in
 *                                  `test/integration/mcp-server.test.ts`.
 *   R4  `src/editor/editor.ts`     `spawn("mnemex", …)` — a BARE BINARY NAME.
 *                                  `which mnemex` answers on any developer
 *                                  machine, so it resolved and ran. Nothing in
 *                                  it looks like a path, so every path-shaped
 *                                  rule reported green while `SymbolEditor`
 *                                  launched the real binary on every edit.
 *
 * The instance was never the problem. The class is: a launch spelled in N ways,
 * scattered across N files, is a thing you can only ever find one spelling of.
 * So the spellings are collected HERE, this file is the single exception in the
 * static sweep (`test/unit/core/keychain.test.ts`, "no PRODUCTION file may
 * launch a mnemex entry point outside the launcher"), and every other module
 * receives a launcher from its caller. That is the same shape as
 * `src/core/keychain.ts` being the only file allowed to spawn `security`.
 *
 * TWO INDEPENDENT PROTECTIONS, NOT ONE
 * ------------------------------------
 * 1. INJECTION, for the code a test can reach. `SymbolEditor` and
 *    `DebounceReindexer` take their launcher as a REQUIRED constructor
 *    argument, so a test supplies a recorder and production supplies one of the
 *    functions below. Required, not optional-with-a-default: an optional one
 *    falls back to the real binary at every call site that forgets, which is
 *    the state R3 and R4 were both found in.
 *
 * 2. A RUNTIME REFUSAL, for the code a test cannot reach yet. Every function
 *    below refuses outright when `isGuardedProcess()` — imported from
 *    `src/core/keychain.ts`, THE one guarded-process predicate — says this is a
 *    test process. That predicate is true on EITHER the private test sentinel
 *    `MNEMEX_KEYCHAIN_TEST_GUARD=1` (which `bunfig.toml`'s preload,
 *    `test/helpers/keychain-stub.ts` and `keychainSafeChildEnv()` all set) OR the
 *    irreversible `testDepsEverInstalled` latch that `setKeychainTestDeps()`
 *    trips and nothing clears. The three hook handlers re-exec the entry point
 *    through `process.execPath` and have no injector today; the refusal is what
 *    makes them safe anyway, and it costs production nothing because no
 *    production process sets the sentinel or installs the seam.
 *
 *    ROUND 7 (external review, CRITICAL): this file used to read the sentinel
 *    itself and nothing else. The keychain adapter vetoed on sentinel OR latch;
 *    this file vetoed on sentinel alone; the latch was private to the adapter,
 *    so the two could not agree. A suite run from a cwd where `bunfig.toml` is
 *    not loaded, that installed the seam and then restored it with
 *    `setKeychainTestDeps(null)`, was correctly denied in-process — and then
 *    production code called a launcher here, which saw no sentinel and started
 *    the real entry point. The child has no latch, so it enabled itself and
 *    could reach the login keychain. The parent was safe and spawned a child
 *    that was not (CWE-284/693). The fix is ONE predicate, owned by the module
 *    that owns the latch, and imported here. `src/core/keychain.ts` has no
 *    imports, so this cannot become a cycle.
 *    `test/unit/core/launcher-latch-guard.test.ts` proves it with a child whose
 *    sentinel is GENUINELY absent.
 *
 * The refusal THROWS rather than returning a dead stub. Every caller already
 * treats a failed launch as best-effort (the edit, the reindex and the hook all
 * succeeded; only the follow-up is missing), and a stub would let a test pass
 * while believing it had launched something.
 */

import { spawn, spawnSync } from "node:child_process";
import { guardedProcessReason } from "./keychain.js";

/**
 * The installed binary, named ONCE. Everything else imports this constant, so
 * `grep` for the literal has exactly one production hit and the sweep has
 * exactly one file to exempt.
 */
export const MNEMEX_ENTRY_COMMAND = "mnemex";

/**
 * Named here ONLY for the refusal message. This module no longer reads the
 * variable itself: "is this a test process" is answered by
 * `guardedProcessReason()` in `src/core/keychain.ts`, which owns the second
 * half of that answer (the seam latch) and which this file cannot duplicate.
 * One fact, one predicate, one place it can be wrong.
 */
const TEST_GUARD_ENV = "MNEMEX_KEYCHAIN_TEST_GUARD";

/** The slice of a child process every caller here actually uses. */
export interface EntryPointProcess {
	pid?: number | undefined;
	on(event: "error", listener: (err: Error) => void): void;
	on(event: "exit", listener: (code: number | null) => void): void;
	unref(): void;
}

/** What a synchronous launch returns. Deliberately not a `SpawnSyncReturns`. */
export interface EntryPointSyncResult {
	status: number | null;
	stdout: string | null;
}

/**
 * How a caller starts a detached background entry point.
 *
 * `SymbolEditor` takes one of these. Production passes `spawnMnemexDetached`;
 * `test/helpers/test-workspace.ts` passes a recorder that starts nothing.
 */
export type DetachedEntryPointLauncher = (
	args: string[],
	cwd: string,
) => EntryPointProcess;

/** How a caller starts an entry point it intends to WAIT for. */
export type AwaitedEntryPointLauncher = (
	args: string[],
	cwd: string,
) => EntryPointProcess;

/** Thrown instead of launching, when this is a guarded (test) process. */
export class EntryPointLaunchRefusedError extends Error {
	/** Which veto fired, so a test can prove it was the one it set up. */
	readonly reason: "sentinel" | "test-seam-latch";

	constructor(what: string, reason: "sentinel" | "test-seam-latch") {
		const because =
			reason === "sentinel"
				? `${TEST_GUARD_ENV}=1`
				: "the keychain test seam was installed in this process";
		super(
			`refusing to launch the mnemex entry point (${what}) from a guarded ` +
				`process: ${because}. A test must inject its own launcher ` +
				`rather than starting the installed binary.`,
		);
		this.name = "EntryPointLaunchRefusedError";
		this.reason = reason;
	}
}

/**
 * Real launches, counted.
 *
 * Monotonic, incremented at the choke points below immediately before the call
 * and after the veto, with no setter and no reset — the same contract as
 * `realSecuritySpawns` in `src/core/keychain.ts`, and for the same reason: a
 * test asserting "nothing was launched" needs a COUNT, not an elapsed time and
 * not a report object.
 */
let entryPointLaunches = 0;

/** The count of real entry-point launches made by this process. */
export function entryPointLaunchCount(): number {
	return entryPointLaunches;
}

/**
 * THE VETO. Every exported launcher passes through here first.
 *
 * Delegates to the keychain module's predicate rather than reading the sentinel
 * itself, so that the two modules can never again disagree about what a test
 * process is (see the header). Read at call time, not captured at load.
 */
function refuseIfGuarded(what: string): void {
	const reason = guardedProcessReason();
	if (reason !== null) {
		throw new EntryPointLaunchRefusedError(what, reason);
	}
}

/**
 * The installed `mnemex` binary, detached and silent — background reindexing.
 *
 * `mnemex` is resolved through `PATH`. That is intentional for the installed
 * CLI and is precisely why it must live behind this veto: on a developer
 * machine it always resolves.
 */
export function spawnMnemexDetached(
	args: string[],
	cwd: string,
): EntryPointProcess {
	refuseIfGuarded(`${MNEMEX_ENTRY_COMMAND} ${args.join(" ")}`);
	entryPointLaunches++;
	return spawn(MNEMEX_ENTRY_COMMAND, args, {
		cwd,
		detached: true,
		stdio: "ignore",
	});
}

/**
 * The installed `mnemex` binary, attached, for a caller that waits on 'exit'.
 *
 * Kept separate from the detached form rather than taking a boolean: the two
 * have different lifetimes and different failure handling, and a flag that
 * changes which one you get is the shape that hides bugs.
 */
export function spawnMnemexAwaited(
	args: string[],
	cwd: string,
): EntryPointProcess {
	refuseIfGuarded(`${MNEMEX_ENTRY_COMMAND} ${args.join(" ")}`);
	entryPointLaunches++;
	return spawn(MNEMEX_ENTRY_COMMAND, args, { cwd, stdio: "ignore" });
}

/**
 * Re-execute THIS process's own script — `process.execPath` plus
 * `process.argv[1]`.
 *
 * In production `process.argv[1]` IS `dist/index.js`, so this is the entry
 * point wearing a name that contains neither "mnemex" nor "index". The hook
 * handlers use it because a hook runs from an arbitrary cwd where `mnemex` may
 * not be on `PATH`, and re-execing the running script is the only reliable way
 * back to the same build.
 */
export function spawnSelfDetached(
	args: string[],
	cwd: string,
): EntryPointProcess {
	refuseIfGuarded(`self ${args.join(" ")}`);
	entryPointLaunches++;
	return spawn(process.execPath, [process.argv[1] ?? "", ...args], {
		cwd,
		detached: true,
		stdio: "ignore",
	});
}

/**
 * Re-execute this process's own script and WAIT, capturing stdout.
 *
 * Used by the hook handlers to ask the CLI a question mid-hook. Returns
 * `{ status: null, stdout: null }` on any failure so callers keep their
 * existing best-effort behaviour.
 */
export function runSelfSync(
	args: string[],
	cwd: string | undefined,
	timeoutMs: number,
): EntryPointSyncResult {
	refuseIfGuarded(`self ${args.join(" ")}`);
	entryPointLaunches++;
	const result = spawnSync(process.execPath, [process.argv[1] ?? "", ...args], {
		cwd,
		encoding: "utf-8",
		timeout: timeoutMs,
	});
	return { status: result.status, stdout: result.stdout ?? null };
}

// There is deliberately NO generic `(command, args, cwd)` launcher here. Round 6
// removed `launchEntryPointDetached`: its only caller (`src/mcp/reindexer.ts`)
// passed a bare `"mnemex"` into it, which meant a second production file NAMED
// the entry point and the allowlist justification ("the launcher is the only
// file that may name or start a mnemex entry point") was wider than what the
// tree enforced. Every export above decides for itself WHAT it launches; a
// caller may only choose the arguments and the cwd. The launch-capability graph
// (`test/unit/core/launch-capability-graph.test.ts`) enumerates who may call
// them.
