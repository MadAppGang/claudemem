/**
 * Child process for the `~/.mnemex/config.json` write tests.
 *
 * WHY A SUBPROCESS. `GLOBAL_CONFIG_DIR` is a module-level `const` evaluated at
 * import time from `homedir()`, so `HOME` must be set BEFORE the child bun process
 * starts. Setting it in a `beforeEach` inside the same process does nothing —
 * MEASURED: Bun's `os.homedir()` ignores a runtime reassignment of
 * `process.env.HOME` and keeps returning the real one. That is the trap, and it is
 * easy to walk into while writing the very test that proves the file behaviour. A
 * reviewer's probe walked into it during this build and overwrote fields in a real
 * user's `~/.mnemex/config.json`.
 *
 * So this file refuses to run unless it can PROVE it is sandboxed — see
 * `assertSandboxed()` below. It exits non-zero without importing anything that
 * could write, rather than trusting the caller to have set `HOME` correctly.
 *
 * It is NOT a keychain escape hatch either. The parent passes
 * `MNEMEX_KEYCHAIN_TEST_GUARD=1`, this child installs the stub seam before it
 * touches anything (tripping the `testDepsEverInstalled` latch), and
 * `src/core/keychain.ts` denies real access by default in any process that has not
 * called `enableRealKeychainAccess()` — which only `src/index.ts` does.
 *
 * Usage: bun run test/helpers/global-config-child.ts '<json job>'
 * Prints one JSON line on stdout: { report, file, mode, corruptFiles }.
 */

import {
	existsSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	loadGlobalConfig,
	loadGlobalConfigWithSecrets,
	removeGlobalConfigFields,
	saveGlobalConfig,
} from "../../src/config.js";
import {
	invalidateKeychainCache,
	type KeychainRunResult,
	readKeychainAccount,
	setKeychainTestDeps,
} from "../../src/core/keychain.js";
import {
	invalidateSecretSessionCache,
	pruneFileSecrets,
} from "../../src/core/secrets.js";
import { exitUnlessSandboxed } from "./sandbox-guard.js";

// THE HARD PRECONDITION, before anything in this module body runs: this process
// must be provably writing inside a temp directory. See `./sandbox-guard.ts` for
// the three conditions and the incident behind each of them.
exitUnlessSandboxed(homedir(), process.env.MNEMEX_TEST_SANDBOX_HOME, tmpdir());

interface Job {
	/** What the fake keychain already holds, account -> value. */
	stored?: Record<string, string>;
	/** Force every write to fail (exit 1). */
	failWrites?: boolean;
	/** Make a write exit 0 but read back a different value. */
	writeDoesNotRoundTrip?: boolean;
	/** Force every delete to fail. */
	failDeletes?: boolean;
	/** Force every read to fail — used for the prune abort. */
	failReads?: boolean;
	platform?: string;
	/** The partial config to save. */
	save?: Record<string, unknown>;
	/**
	 * Fields to set to an explicit `undefined` on the save payload.
	 *
	 * `undefined` cannot cross `JSON.stringify`, so the A1 case — "an explicitly
	 * undefined field must not delete the value on disk" — is unreachable through
	 * `save` alone. That is exactly why the one file that asserts on bytes could not
	 * cover it before.
	 */
	saveUndefined?: string[];
	/**
	 * Save `loadGlobalConfigWithSecrets()` merged with `save`, rather than `save`
	 * alone. The C1 sequence: keychain values are hydrated INTO the config object,
	 * the caller edits one unrelated field, and the whole object goes back to
	 * `saveGlobalConfig`.
	 */
	hydrateFirst?: boolean;
	/** Run `saveGlobalConfig` twice — the C2 accumulation check. */
	saveTwice?: boolean;
	/** Run a prune instead of a save. */
	prune?: boolean;
	/**
	 * Change the file's plaintext copy to this value AFTER `pruneFileSecrets` has
	 * verified it and BEFORE `removeGlobalConfigFields` runs. Stages the prune race.
	 */
	mutateFileBeforeRemove?: Record<string, unknown>;
	/**
	 * Successive keychain states to HYDRATE from before the save, in order.
	 *
	 * Stages the historical-provenance sequence: `keychainSourced` is a Set PER
	 * FIELD, so a process that hydrated `openrouter=X` and later `openrouter=Y`
	 * carries BOTH as "came out of the keychain", forever. External review's HIGH 3
	 * turned that into a `"keychain"` disposition — i.e. proof — for a value the
	 * save had just failed to store, over a keychain that demonstrably held
	 * something else. The last entry is the keychain's final state.
	 */
	hydrateSequence?: Record<string, string>[];
	/**
	 * Accounts to READ (warming the three-second burst memo) and then DELETE from
	 * the fake keychain, without invalidating that memo.
	 *
	 * Stages external review's HIGH 2: the memo now answers "found X" for an item
	 * another process has removed. A save whose pre-read is served from it records
	 * `"keychain"` — proof — and `saveGlobalConfig` then deletes the plaintext
	 * copy, leaving the credential nowhere.
	 */
	poisonMemo?: string[];
}

const job: Job = JSON.parse(process.argv[2] ?? "{}");
const store = new Map<string, string>(Object.entries(job.stored ?? {}));

const OK = (stdout = ""): KeychainRunResult => ({
	code: 0,
	stdout,
	stderr: "",
});
const NOT_FOUND = (): KeychainRunResult => ({
	code: 44,
	stdout: "",
	stderr: "security: The specified item could not be found in the keychain.",
});
const FAIL = (stderr: string): KeychainRunResult => ({
	code: 1,
	stdout: "",
	stderr,
});

let lastWritten: string | undefined;

/**
 * Every call that reached the seam, as `verb:account`.
 *
 * Cleared immediately before the operation under test, so the reported list is
 * exactly what THAT operation asked the keychain. It is the only way to tell a
 * read that happened from a read that was served out of the three-second burst
 * memo, and telling those apart is the whole of external review's HIGH 2.
 */
const seamCalls: string[] = [];

setKeychainTestDeps({
	platform: () => job.platform ?? "darwin",
	run: (args, stdin) => {
		const verb = args[0];
		const accountAt = args.indexOf("-a");
		seamCalls.push(
			accountAt < 0 ? String(verb) : `${verb}:${args[accountAt + 1]}`,
		);

		if (verb === "-i") {
			if (job.failWrites) return FAIL("security: ACL denied");
			const account = stdin?.match(/-a "([^"]*)"/)?.[1];
			const hex = stdin?.match(/-X "([^"]*)"/)?.[1];
			if (!account || hex === undefined) return FAIL("security: bad command");
			lastWritten = Buffer.from(hex, "hex").toString("utf8");
			if (!job.writeDoesNotRoundTrip) store.set(account, lastWritten);
			return OK();
		}

		if (verb === "find-generic-password") {
			if (job.failReads) return FAIL("security: SecKeychainUnlock: -25308");
			const i = args.indexOf("-a");
			const account = args[i + 1];
			if (job.writeDoesNotRoundTrip && lastWritten !== undefined) {
				return OK("A-COMPLETELY-DIFFERENT-VALUE\n");
			}
			const value = account ? store.get(account) : undefined;
			return value === undefined ? NOT_FOUND() : OK(`${value}\n`);
		}

		if (verb === "delete-generic-password") {
			if (job.failDeletes) return FAIL("security: ACL denied");
			const i = args.indexOf("-a");
			const account = args[i + 1];
			if (!account || !store.has(account)) return NOT_FOUND();
			store.delete(account);
			return OK();
		}

		if (verb === "dump-keychain") {
			if (job.failReads) return FAIL("security: dump-keychain: timed out");
			return OK(
				[...store.keys()]
					.map(
						(a) =>
							`class: "genp"\nattributes:\n    "acct"<blob>="${a}"\n    "svce"<blob>="mnemex"\n`,
					)
					.join(""),
			);
		}

		return FAIL(`security: unknown verb ${verb}`);
	},
});

process.env.MNEMEX_DISABLE_KEYCHAIN = "0";

const configDir = join(homedir(), ".mnemex");
const configPath = join(configDir, "config.json");

let report: unknown = null;
let error: string | undefined;
let removal: unknown = null;

/** Build the payload, re-introducing the `undefined`s that JSON cannot carry. */
function buildSavePayload(): Record<string, unknown> {
	const base = job.hydrateFirst
		? (loadGlobalConfigWithSecrets() as unknown as Record<string, unknown>)
		: {};
	const payload: Record<string, unknown> = { ...base, ...(job.save ?? {}) };
	for (const field of job.saveUndefined ?? []) {
		payload[field] = undefined;
	}
	return payload;
}

// Stage historical provenance BEFORE anything else: each hydration notes the
// values it read, and they are never forgotten short of a proven delete.
for (const state of job.hydrateSequence ?? []) {
	store.clear();
	for (const [account, value] of Object.entries(state))
		store.set(account, value);
	invalidateKeychainCache();
	invalidateSecretSessionCache();
	loadGlobalConfigWithSecrets();
}
invalidateKeychainCache();
invalidateSecretSessionCache();

// POISON THE BURST MEMO, then take the item away — the HIGH 2 sequence.
//
// This is a normal process doing normal things: it read the credential (any
// getter, any hydration), which memoises the answer for three seconds. Inside
// that window another process runs an unforced `keychain rm`, which is ALLOWED
// because the plaintext copy still exists. The memo now holds a value the
// keychain does not.
//
// Deliberately NOT followed by `invalidateKeychainCache()`: a save that then
// treats its own pre-read as proof is treating that stale memo as proof, and the
// proof authorises deleting the last remaining copy from `config.json`.
for (const account of job.poisonMemo ?? []) {
	readKeychainAccount(account);
	store.delete(account);
}

seamCalls.length = 0;

try {
	if (job.prune) {
		const {
			report: pruneReport,
			fieldsToRemove,
			verifiedValues,
		} = pruneFileSecrets(loadGlobalConfig());
		if (job.mutateFileBeforeRemove) {
			// Stage the check/use window: another process saves a DIFFERENT plaintext
			// value between the verification and the deletion.
			const current = JSON.parse(readFileSync(configPath, "utf-8"));
			writeFileSync(
				configPath,
				JSON.stringify({ ...current, ...job.mutateFileBeforeRemove }, null, 2),
				"utf-8",
			);
		}
		removal = removeGlobalConfigFields(fieldsToRemove, verifiedValues);
		report = pruneReport;
	} else {
		report = saveGlobalConfig(buildSavePayload());
		if (job.saveTwice) {
			report = saveGlobalConfig(
				// The second save re-reads through `loadGlobalConfig`, which is what a
				// real caller does and what re-introduces the 102 defaults.
				loadGlobalConfig() as unknown as Record<string, unknown>,
			);
		}
	}
} catch (e) {
	error = e instanceof Error ? e.message : String(e);
}

const out = {
	report,
	removal,
	error,
	// The BYTES that reached disk — the only assertion that can catch a merge that
	// restores a secret the keychain already holds.
	file: existsSync(configPath) ? readFileSync(configPath, "utf-8") : null,
	mode: existsSync(configPath)
		? (statSync(configPath).mode & 0o777).toString(8)
		: null,
	dirMode: existsSync(configDir)
		? (statSync(configDir).mode & 0o777).toString(8)
		: null,
	corruptFiles: existsSync(configDir)
		? readdirSync(configDir).filter((f) => f.includes(".corrupt-"))
		: [],
	tmpFiles: existsSync(configDir)
		? readdirSync(configDir).filter((f) => f.includes(".tmp."))
		: [],
	storedAfter: Object.fromEntries(store),
	// What the operation under test actually asked the keychain — the difference
	// between a read that happened and a memo that answered.
	seamCalls,
};

process.stdout.write(`\n__RESULT__${JSON.stringify(out)}\n`);
