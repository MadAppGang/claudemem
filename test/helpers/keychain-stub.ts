/**
 * The ONLY way any test in this repo touches the keychain.
 *
 * HARD CONSTRAINT: no test, and no verification step, may spawn
 * `/usr/bin/security`. Driving a throwaway keychain was tried and abandoned — its
 * password is known only to the tooling, so every macOS authorization dialog it
 * raised was unanswerable, and it re-locked on its idle timer so each spawn raised
 * another. A synthetic keychain also proves little about real behaviour.
 *
 * Four guards enforce it. The FIRST needs no environment variable, no preload and
 * no working directory, which is the property review finding A2 showed the others
 * lacked:
 *   1. `src/core/keychain.ts` DENIES BY DEFAULT. Only `src/index.ts` calls
 *      `enableRealKeychainAccess()`, and no test imports it.
 *   2. The adapter also refuses under MNEMEX_KEYCHAIN_TEST_GUARD=1 OR after
 *      `setKeychainTestDeps` has ever been called in the process
 *      (`testDepsEverInstalled`, never cleared).
 *   3. `MNEMEX_DISABLE_KEYCHAIN` — set to "1" by the preload, flipped to "0" here
 *      only for suites that deliberately exercise policy.
 *   4. The static sweep in `test/unit/core/keychain.test.ts`, over BOTH test roots.
 *
 * This module sets the sentinel AT MODULE SCOPE, not only inside
 * `installKeychainStub()`: `bunfig.toml`'s preload is resolved against the working
 * directory, so importing this helper is the one thing a suite can do that carries
 * the sentinel into its child processes regardless of where `bun` was invoked.
 *
 * The default `run` throws, so an unintended call fails loudly rather than
 * silently returning something plausible.
 *
 * Driving the seam buys MORE coverage than a live keychain could: exit 44, a
 * SIGTERM-shaped timeout, an ACL denial, a round-trip mismatch and a non-darwin
 * platform are each one line here, where staging them against a real keychain
 * ranges from awkward to impossible.
 */

import {
	invalidateKeychainCache,
	type KeychainRunResult,
	resetKeychainBreaker,
	resetKeychainProcessBudget,
	setKeychainTestDeps,
} from "../../src/core/keychain.js";
import {
	invalidateSecretSessionCache,
	resetHardExitReask,
	resetSecretProvenance,
	resetSecretWarnings,
	setKeychainConfigOptOut,
} from "../../src/core/secrets.js";

// MODULE SCOPE, deliberately. See the header: this is the layer that survives a
// `bun test` invoked from a directory where `bunfig.toml` is not found, and it is
// what a child process spawned by such a suite inherits.
process.env.MNEMEX_KEYCHAIN_TEST_GUARD = "1";

export interface StubCall {
	args: string[];
	stdin?: string;
	/** The timeout the engine asked for — what the process-budget clamp is asserted on. */
	timeoutMs?: number;
}

export type RunImpl = (call: StubCall) => KeychainRunResult;

export interface KeychainStub {
	calls: StubCall[];
	/** Every captured `add-generic-password` (they arrive as argv `["-i"]` + stdin). */
	writes(): StubCall[];
	/** Concatenation of every argv token ever passed — for "the secret is not in argv". */
	allArgv(): string[];
	setRun(impl: RunImpl): void;
	setPlatform(platform: string): void;
	reset(): void;
}

export const OK = (stdout = ""): KeychainRunResult => ({
	code: 0,
	stdout,
	stderr: "",
});

/** A miss. Both signals a real `security` gives, so neither is load-bearing alone. */
export const NOT_FOUND = (): KeychainRunResult => ({
	code: 44,
	stdout: "",
	stderr:
		"security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.\n",
});

export const FAILURE = (
	stderr = "security: SecKeychainItemCopyContent: Unknown error",
	code = 1,
): KeychainRunResult => ({ code, stdout: "", stderr });

/** What the adapter produces when a spawn is killed by its timeout. */
export const SIGNAL_KILL = (): KeychainRunResult => ({
	code: -1,
	stdout: "",
	stderr: "security killed by SIGTERM",
});

/** The lock-class failure that trips the circuit breaker. */
export const LOCKED = (): KeychainRunResult => ({
	code: 36,
	stdout: "",
	stderr: "security: SecKeychainUnlock: User interaction is not allowed.",
});

export function installKeychainStub(init?: {
	platform?: string;
	run?: RunImpl;
}): KeychainStub {
	const calls: StubCall[] = [];
	let platform = init?.platform ?? "darwin";
	let runImpl: RunImpl =
		init?.run ??
		((call) => {
			throw new Error(`unexpected keychain call: ${call.args.join(" ")}`);
		});

	const stub: KeychainStub = {
		calls,
		writes: () =>
			calls.filter((c) => c.stdin?.includes("add-generic-password")),
		allArgv: () => calls.flatMap((c) => c.args),
		setRun: (impl) => {
			runImpl = impl;
		},
		setPlatform: (p) => {
			platform = p;
			// The engine reads `platform()` through the port, so re-install is not
			// needed — the closure below reads the mutable local.
		},
		reset: () => {
			calls.length = 0;
		},
	};

	setKeychainTestDeps({
		platform: () => platform,
		run: (args, stdin, timeoutMs) => {
			const call: StubCall = { args: [...args], stdin, timeoutMs };
			calls.push(call);
			return runImpl(call);
		},
	});

	// Policy suites deliberately exercise the backend; layer 1 still stands.
	process.env.MNEMEX_DISABLE_KEYCHAIN = "0";
	resetKeychainState();
	return stub;
}

/** Restore the real adapter and the preload's defaults. Always call in `afterEach`. */
export function uninstallKeychainStub(): void {
	setKeychainTestDeps(null);
	process.env.MNEMEX_DISABLE_KEYCHAIN = "1";
	resetKeychainState();
}

function resetKeychainState(): void {
	invalidateKeychainCache();
	resetKeychainBreaker();
	resetKeychainProcessBudget();
	invalidateSecretSessionCache();
	resetSecretProvenance();
	resetSecretWarnings();
	resetHardExitReask();
	setKeychainConfigOptOut(false);
}

// ============================================================================
// A fake keychain — an in-memory store behind the same argv protocol
// ============================================================================

export interface FakeKeychainOptions {
	/** Force a specific result for matching argv, e.g. to fail one operation. */
	override?: (call: StubCall) => KeychainRunResult | undefined;
	/** Make `dump-keychain` fail — the trigger for the migrate guard. */
	enumerationFails?: boolean;
}

/**
 * Backs the stub with a Map, honouring the real argv/stdin protocol:
 * the secret arrives as `-X <hex>` on the `-i` stdin command line and NEVER in
 * argv, so a test that reads a value back has proved the encoding round-trips.
 */
export function fakeKeychain(
	store: Map<string, string>,
	options?: FakeKeychainOptions,
): RunImpl {
	return (call) => {
		const forced = options?.override?.(call);
		if (forced) return forced;

		const [verb] = call.args;

		if (verb === "find-generic-password") {
			const account = accountFromArgs(call.args);
			const value = account === undefined ? undefined : store.get(account);
			// A real `-w` read appends a newline; the engine strips exactly one.
			return value === undefined ? NOT_FOUND() : OK(`${value}\n`);
		}

		if (verb === "delete-generic-password") {
			const account = accountFromArgs(call.args);
			if (account === undefined || !store.has(account)) return NOT_FOUND();
			store.delete(account);
			return OK();
		}

		if (verb === "dump-keychain") {
			if (options?.enumerationFails) {
				return FAILURE("security: dump-keychain: timed out", 1);
			}
			return OK(renderDump([...store.keys()]));
		}

		if (verb === "-i") {
			const stdin = call.stdin ?? "";
			const account = stdin.match(/-a "([^"]*)"/)?.[1];
			const hex = stdin.match(/-X "([^"]*)"/)?.[1];
			if (!account || hex === undefined) {
				return FAILURE("security: invalid command", 1);
			}
			store.set(account, Buffer.from(hex, "hex").toString("utf8"));
			return OK();
		}

		return FAILURE(`security: unknown verb ${verb}`, 1);
	};
}

function accountFromArgs(args: string[]): string | undefined {
	const i = args.indexOf("-a");
	return i >= 0 ? args[i + 1] : undefined;
}

/**
 * `dump-keychain` output, in the shape a real one has. The parser is fixtured
 * against a captured real block in `keychain.test.ts`; this renderer exists so the
 * behavioural tests do not depend on hand-written dumps everywhere.
 */
export function renderDump(accounts: string[], service = "mnemex"): string {
	const header = `keychain: "/Users/test/Library/Keychains/login.keychain-db"\n`;
	return (
		header +
		accounts
			.map(
				(account) => `class: "genp"
attributes:
    0x00000007 <blob>="mnemex: ${account}"
    0x00000008 <blob>=<NULL>
    "acct"<blob>="${account}"
    "cdat"<timedate>=0x32303236303930313030303030305A00
    "desc"<blob>="application password"
    "svce"<blob>="${service}"
    "type"<uint32>=<NULL>
`,
			)
			.join("")
	);
}
