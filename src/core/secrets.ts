/**
 * Secret POLICY — the registry and the facade over `src/core/keychain.ts`.
 *
 * Speaks mnemex vocabulary: ids, config fields, environment variables, labels.
 * It never builds `security` argv, never spawns and never sees an exit code.
 *
 * This is a Facade in the only form TypeScript needs: a module of functions over
 * a messy subsystem. No provider class, no strategy hierarchy, no singleton class
 * — the memo is a module-level `const`. The named family failure, "Facade as a
 * dumping ground", is guarded by one rule: this module exports only what a call
 * site uses today. The engine's lower-level surface (`readKeychainAccount`,
 * `parseDumpAccounts`, `maskSecret`) stays in `keychain.ts` and is imported, never
 * re-exported. A future feature needing raw account access imports the engine.
 *
 * stdout purity (CLAUDE.md #14): nothing here writes to stdout. Diagnostics go
 * through `warnOnce` -> a REPLACEABLE sink, because stderr is not always safe
 * either: both keychain entry points on the wizard path sit inside a live OpenTUI
 * screen, and a `console.error` there corrupts the display (CLAUDE.md #6).
 */

import type { GlobalConfig } from "../types.js";
import {
	deleteKeychainAccount,
	describeUnstorableValue,
	enumerateKeychainAccounts,
	invalidateKeychainCache,
	isKeychainSupported,
	KeychainDuplicateItemError,
	type KeychainRead,
	keychainUnavailableReason,
	readKeychainAccount,
	resetKeychainBreaker,
	resetKeychainProcessBudget,
	writeKeychainAccount,
} from "./keychain.js";

// ============================================================================
// Registry — the single source of truth
// ============================================================================

export type SecretId =
	| "openrouter"
	| "voyage"
	| "anthropic"
	| "context7"
	| "cloud"
	| "ollama";

export interface SecretSpec {
	id: SecretId;
	/**
	 * The keychain ADDRESS. Internal — nothing outside this registry ever types it,
	 * and no user ever sees it except in the label, which names it explicitly.
	 *
	 * KEPT SHORT deliberately, and the choice is permanent. Renaming these to the
	 * env-var names is free TODAY (six values) and costs ~120 lines of dual-read
	 * migration forever after release, so the option is being spent knowingly:
	 * the account is an address, not a name; and "the account is the env var" would
	 * be a lie for `cloud` (no env var) and a half-truth for `ollama` (whose
	 * variable governs generation only). What the rename buys is cosmetic.
	 */
	account: string;
	/** `cloud` has none — resolution starts at the keychain for it. */
	envVar?: string;
	configField: keyof GlobalConfig & string;
	/** Display only, part of no lookup. Every label NAMES its account (M3). */
	label: string;
}

export const SECRET_SPECS: readonly SecretSpec[] = [
	{
		id: "openrouter",
		account: "openrouter",
		envVar: "OPENROUTER_API_KEY",
		configField: "openrouterApiKey",
		label: 'mnemex: OPENROUTER_API_KEY (account "openrouter")',
	},
	{
		id: "voyage",
		account: "voyage",
		envVar: "VOYAGE_API_KEY",
		configField: "voyageApiKey",
		label: 'mnemex: VOYAGE_API_KEY (account "voyage")',
	},
	{
		id: "anthropic",
		account: "anthropic",
		envVar: "ANTHROPIC_API_KEY",
		configField: "anthropicApiKey",
		label: 'mnemex: ANTHROPIC_API_KEY (account "anthropic")',
	},
	{
		id: "context7",
		account: "context7",
		envVar: "CONTEXT7_API_KEY",
		configField: "context7ApiKey",
		label: 'mnemex: CONTEXT7_API_KEY (account "context7")',
	},
	{
		// No env var, and the label no longer pretends otherwise: the old label
		// advertised MNEMEX_CLOUD_API_KEY, which mnemex reads NOWHERE, so a user who
		// exported it got nothing, silently.
		id: "cloud",
		account: "cloud",
		configField: "cloudApiKey",
		label: 'mnemex: cloud API key (account "cloud", no env var)',
	},
	{
		id: "ollama",
		account: "ollama",
		envVar: "OLLAMA_API_KEY",
		configField: "ollamaApiKey",
		label: 'mnemex: OLLAMA_API_KEY (account "ollama")',
	},
];

const SPECS_BY_ID = new Map<SecretId, SecretSpec>(
	SECRET_SPECS.map((s) => [s.id, s]),
);
const SPECS_BY_FIELD = new Map<string, SecretSpec>(
	SECRET_SPECS.map((s) => [s.configField, s]),
);
const SPECS_BY_ACCOUNT = new Map<string, SecretSpec>(
	SECRET_SPECS.map((s) => [s.account, s]),
);

export function secretSpecById(id: SecretId): SecretSpec {
	const spec = SPECS_BY_ID.get(id);
	if (!spec) throw new Error(`unknown secret id: ${id}`);
	return spec;
}

export function secretSpecForField(field: string): SecretSpec | undefined {
	return SPECS_BY_FIELD.get(field);
}

// ============================================================================
// Diagnostics sink (M4)
// ============================================================================

let warningSink: ((message: string) => void) | undefined;
let bufferingWarnings = false;
const pendingWarnings: string[] = [];
const emittedWarnings = new Set<string>();

/**
 * Replace the diagnostics sink. `null` BUFFERS instead of writing — the OpenTUI
 * wizard installs that on mount and drains `getPendingSecretWarnings()` after
 * unmount. Non-TUI entry points leave the default (`console.error`) alone.
 */
export function setSecretWarningSink(
	sink: ((message: string) => void) | null,
): void {
	if (sink === null) {
		bufferingWarnings = true;
		warningSink = undefined;
	} else {
		bufferingWarnings = false;
		warningSink = sink;
	}
}

/** Returns and CLEARS the buffered warnings. */
export function getPendingSecretWarnings(): string[] {
	return pendingWarnings.splice(0, pendingWarnings.length);
}

/** Test seam, and the way to restore the default sink. */
export function resetSecretWarnings(): void {
	emittedWarnings.clear();
	pendingWarnings.length = 0;
	bufferingWarnings = false;
	warningSink = undefined;
}

/**
 * One line per distinct message, per process. A locked keychain hit by six keys
 * produces ONE line — and under the failure latch it produces one SPAWN too.
 * Messages carry an id and `security`'s stderr, never key material.
 */
function warnOnce(message: string): void {
	if (emittedWarnings.has(message)) return;
	emittedWarnings.add(message);
	if (bufferingWarnings) {
		pendingWarnings.push(message);
		return;
	}
	(warningSink ?? console.error)(message);
}

// ============================================================================
// Enable gate
// ============================================================================

/**
 * `GlobalConfig.keychain === false` — the persistent form of the opt-out.
 *
 * Read through a PROVIDER registered by `src/config.ts` at module load, rather
 * than by importing `loadGlobalConfig` here. Two reasons, and the first is a bug
 * this shape prevents: the gate must be correct on the FIRST getter call in a
 * process, before anything has loaded the config, and a getter that called
 * `loadGlobalConfig()` to decide whether to consult the keychain would consult the
 * config file on the keychain-HIT path, which the whole design exists to avoid.
 * The second is layering: the dependency stays one-way, config -> secrets, so
 * there is no import cycle.
 *
 * The answer is cached for the process and refreshed by every `loadGlobalConfig`
 * and `saveGlobalConfig`.
 */
let optOutProvider: (() => boolean) | null = null;
let optOutCache: boolean | null = null;

/** Called once by `src/config.ts` at module load. Invoked lazily, at most once. */
export function setKeychainOptOutProvider(
	provider: (() => boolean) | null,
): void {
	optOutProvider = provider;
	optOutCache = null;
}

/** Called by `src/config.ts` whenever it has just read or written the file. */
export function setKeychainConfigOptOut(optedOut: boolean): void {
	optOutCache = optedOut;
}

function isConfigOptedOut(): boolean {
	if (optOutCache !== null) return optOutCache;
	try {
		optOutCache = optOutProvider ? optOutProvider() : false;
	} catch {
		optOutCache = false; // an unreadable config is not an opt-out
	}
	return optOutCache;
}

/**
 * `MNEMEX_DISABLE_KEYCHAIN` is USER-FACING (M9), not a test mechanism — a user
 * with a locked or ACL-hostile keychain needs a supported way to turn the backend
 * off. `GlobalConfig.keychain: false` is the persistent form of the same switch.
 */
export function isSecretsBackendEnabled(): boolean {
	if (process.env.MNEMEX_DISABLE_KEYCHAIN === "1") return false;
	if (isConfigOptedOut()) return false;
	return isKeychainSupported();
}

function backendDisabledReason(): string {
	if (process.env.MNEMEX_DISABLE_KEYCHAIN === "1") {
		return "keychain disabled (MNEMEX_DISABLE_KEYCHAIN=1)";
	}
	if (isConfigOptedOut()) {
		return 'keychain disabled ("keychain": false in config.json)';
	}
	return keychainUnavailableReason() ?? "keychain unavailable";
}

/** For `mnemex keychain status`. */
export function secretsBackendStatus(): { enabled: boolean; reason?: string } {
	return isSecretsBackendEnabled()
		? { enabled: true }
		: { enabled: false, reason: backendDisabledReason() };
}

// ============================================================================
// Session cache (M10) — long-lived processes only
// ============================================================================

/**
 * Populated ONLY by `primeSecrets()`, which only the MCP server calls. `null`
 * means "proven absent by a SUCCESSFUL enumeration".
 *
 * When priming FAILS the cache is left EMPTY and `sessionCacheActive` stays
 * false — never negatively populated. A negatively populated cache would make the
 * server permanently believe nothing is stored; an empty one merely falls through
 * to the normal read path, where the circuit breaker suppresses the follow-on
 * spawns anyway. That is the whole reason the breaker is a separate mechanism
 * from the burst memo.
 *
 * The trade, stated: a user who edits the keychain in Keychain Access.app while an
 * MCP server is running is not picked up until the server restarts. That is the
 * 3 s burst window's whole purpose, given up for the ONE process where a
 * per-request `Bun.spawnSync` is indefensible. The CLI, the wizard and the indexer
 * keep the burst window.
 */
const sessionCache = new Map<SecretId, string | null>();
let sessionCacheActive = false;

export function invalidateSecretSessionCache(): void {
	sessionCache.clear();
	sessionCacheActive = false;
}

// ============================================================================
// Keychain provenance (C1) — which values in a config object CAME FROM the keychain
// ============================================================================

/**
 * Values this process read OUT of the keychain and copied INTO a config object,
 * keyed by config field.
 *
 * WHY. `loadGlobalConfigWithSecrets()` overlays keychain values onto the config it
 * returns (N6 — keychain wins, so the wizard shows the key mnemex actually uses).
 * That object is then edited and handed back to `saveGlobalConfig`. `persistSecrets`
 * inspects only INCOMING fields and cannot tell a value the user typed from one it
 * handed the caller a moment ago, so when the keychain write could not be PROVEN —
 * a locked keychain, a tripped breaker, an exhausted budget, an earlier field's
 * failure stopping the pass, the backend opted out mid-process — the value was
 * recorded `config-file` and written to `~/.mnemex/config.json` IN PLAINTEXT.
 *
 * Observed on a real `~/.mnemex/config.json`, which gained live `voyageApiKey` and
 * `context7ApiKey` values in the clear. It is the same class as A1 and N1: a secret
 * reaches disk because the decision is scoped to incoming fields while the object
 * carries more than that.
 *
 * A Set per field, not a single value: a process may hydrate twice (the wizard
 * re-run), and a value from the earlier hydration is still a value that came out of
 * the keychain rather than out of a user's paste buffer.
 *
 * Holding secret values in a module map adds no exposure — `sessionCache` above
 * already does, and the caller is holding the same strings in its config object.
 */
const keychainSourced = new Map<string, Set<string>>();

function noteKeychainSourced(field: string, value: string): void {
	let values = keychainSourced.get(field);
	if (!values) {
		values = new Set<string>();
		keychainSourced.set(field, values);
	}
	values.add(value);
}

/** True when this exact value was read out of the keychain by this process. */
function isKeychainSourced(field: string, value: string): boolean {
	return keychainSourced.get(field)?.has(value) === true;
}

/**
 * Forget a field's provenance. Called when the item is DELETED: a value we just
 * cleared is no longer evidence that the keychain holds it, and continuing to
 * treat it as such would omit it from the file with nothing behind it.
 */
function forgetKeychainSourced(field: string): void {
	keychainSourced.delete(field);
}

/** Test seam. Provenance is process-scoped and must not bleed between suites. */
export function resetSecretProvenance(): void {
	keychainSourced.clear();
}

/**
 * Resolve every id once, at a long-lived process's composition root.
 * Costs one `dump-keychain` plus one read per STORED id.
 */
export function primeSecrets(): { primed: SecretId[]; failed?: string } {
	invalidateSecretSessionCache();
	if (!isSecretsBackendEnabled()) return { primed: [] };

	const enumeration = enumerateStoredSecrets();
	if (enumeration.failed) {
		// M10 residue: leave the cache EMPTY. See the comment on `sessionCache`.
		warnOnce(
			`[mnemex] macOS Keychain could not be enumerated at startup: ${enumeration.error}`,
		);
		return { primed: [], failed: enumeration.error };
	}

	const primed: SecretId[] = [];
	for (const spec of SECRET_SPECS) {
		// LOW (a). Absence is proved PER ID, never inferred from the dump.
		//
		// `security dump-keychain` with no keychain argument dumps the DEFAULT
		// keychain, while `find-generic-password` searches the user's whole SEARCH
		// LIST. They are not the same scope. An item in a second keychain — a shared
		// team one, a synced one — is missing from the dump, and writing
		// `sessionCache.set(id, null)` on that basis made a key that resolves
		// perfectly well permanently invisible for the life of an MCP server.
		//
		// The successful dump above stays as the liveness gate (M10): if the keychain
		// cannot be enumerated we claim no cache at all. It is no longer treated as
		// proof of anything about an individual item.
		//
		// The invalidate is the same load-bearing line `migrateFileSecrets` needs:
		// without it the fresh list memo answers "absent" for free and the per-id
		// read becomes a restatement of the dump at zero spawns.
		invalidateKeychainCache();
		const read = readKeychainAccount(spec.account);
		if (read.status === "found") {
			sessionCache.set(spec.id, read.value);
			noteKeychainSourced(spec.configField, read.value);
			primed.push(spec.id);
		} else if (read.status === "absent") {
			sessionCache.set(spec.id, null);
		}
		// A failed read leaves the id OUT of the cache: unknown, not absent.
	}
	sessionCacheActive = true;
	return { primed };
}

// ============================================================================
// Read / resolve
// ============================================================================

export function readSecret(id: SecretId): KeychainRead {
	const spec = secretSpecById(id);
	if (!isSecretsBackendEnabled()) {
		return { status: "failed", error: backendDisabledReason() };
	}
	return readKeychainAccount(spec.account);
}

/**
 * THE single expression of F3: env -> keychain -> the caller's config fallback.
 *
 * The fallback is a THUNK, twice over on purpose: it preserves today's
 * short-circuit (the config file is not read when env or the keychain answers),
 * and it makes the resolution order hermetically testable without a real
 * `~/.mnemex/config.json`.
 *
 * Truthiness (`||`, not `??`) is preserved deliberately: an empty env var must not
 * win, which is today's behaviour.
 *
 * `failed` and `absent` BOTH fall through to the config file here, and this is the
 * one place that collapse is correct — the config file is a valid answer either
 * way, and throwing would abort an index run over a diagnostic. Three things still
 * must not collapse: the cache entry (a failure is retried after the burst), the
 * diagnostic (a failure warns once on stderr, an absence is silent), and the
 * decision to exit — see `resolveSecretBeforeHardExit`.
 */
export function resolveSecret(
	id: SecretId,
	configFallback?: () => string | undefined,
): string | undefined {
	const spec = secretSpecById(id);

	if (spec.envVar) {
		const fromEnv = process.env[spec.envVar];
		if (fromEnv) return fromEnv;
	}

	if (isSecretsBackendEnabled()) {
		if (sessionCacheActive && sessionCache.has(id)) {
			const cached = sessionCache.get(id);
			if (cached) return cached;
		} else {
			const read = readKeychainAccount(spec.account);
			if (read.status === "found" && read.value) return read.value;
			if (read.status === "failed") {
				warnOnce(
					`[mnemex] macOS Keychain unavailable for '${id}': ${read.error}. ` +
						"Falling back to ~/.mnemex/config.json. Set MNEMEX_DISABLE_KEYCHAIN=1 to skip the keychain.",
				);
			}
		}
	}

	return configFallback?.();
}

let hardExitReaskUsed = false;

/**
 * Re-resolve ONCE, with the cache, the breaker AND the process budget cleared, for
 * the one caller that is about to `process.exit(1)`.
 *
 * The budget clearing is not optional (N8): if the budget is spent, the re-ask
 * cannot spawn, and the single mechanism standing between a transient keychain
 * failure and a hard exit would do nothing while appearing to have run.
 *
 * The 22 ms is paid only on the path that was about to abort, and the worst case
 * adds one timeout to a process that was exiting anyway.
 */
export function resolveSecretBeforeHardExit(
	id: SecretId,
	configFallback?: () => string | undefined,
): { value: string | undefined; keychainFailure?: string } {
	const spec = secretSpecById(id);

	if (spec.envVar) {
		const fromEnv = process.env[spec.envVar];
		if (fromEnv) return { value: fromEnv };
	}

	let keychainFailure: string | undefined;
	if (isSecretsBackendEnabled() && !hardExitReaskUsed) {
		hardExitReaskUsed = true;
		invalidateKeychainCache();
		resetKeychainBreaker();
		resetKeychainProcessBudget();
		invalidateSecretSessionCache();

		const read = readKeychainAccount(spec.account);
		if (read.status === "found" && read.value) return { value: read.value };
		if (read.status === "failed") keychainFailure = read.error;
	}

	return { value: configFallback?.(), keychainFailure };
}

/** Test seam for the once-per-process re-ask. */
export function resetHardExitReask(): void {
	hardExitReaskUsed = false;
}

/**
 * One `dump-keychain` answers for every id (F5).
 *
 * `unknownAccounts` carries items stored under `svce = mnemex` that no spec claims
 * — surfaced by `mnemex keychain status`, not silently dropped. That is precisely
 * the state a user reaches by hand-creating an item named `OLLAMA_API_KEY` from
 * the label. Zero extra spawns: the dump already contains them.
 */
export function enumerateStoredSecrets(): {
	ids: SecretId[];
	unknownAccounts: string[];
	failed: boolean;
	error?: string;
} {
	if (!isSecretsBackendEnabled()) {
		return {
			ids: [],
			unknownAccounts: [],
			failed: true,
			error: backendDisabledReason(),
		};
	}

	const enumeration = enumerateKeychainAccounts();
	if (enumeration.failed) {
		return {
			ids: [],
			unknownAccounts: [],
			failed: true,
			error: enumeration.error,
		};
	}

	const ids: SecretId[] = [];
	const unknownAccounts: string[] = [];
	for (const account of enumeration.accounts) {
		const spec = SPECS_BY_ACCOUNT.get(account);
		if (spec) ids.push(spec.id);
		else unknownAccounts.push(account);
	}
	return { ids, unknownAccounts, failed: false };
}

// ============================================================================
// Persist
// ============================================================================

export type SecretDisposition =
	/**
	 * PROVEN STORED BY THIS CALL — a verified write, or a read during this save
	 * that returned byte-identical bytes. The only disposition, with `cleared`,
	 * that authorises `saveGlobalConfig` to DELETE the field from the merged file.
	 *
	 * This comment used to say exactly that while `recordUnproven` set it from
	 * process-wide provenance — "some value ever associated with this field came
	 * out of the keychain at some point" — after the current save had explicitly
	 * FAILED to prove anything. Two external reviewers found it from opposite
	 * ends. The credential was then persisted nowhere and the CLI reported
	 * success. `keychain-sourced-omitted` below now carries that case, and it does
	 * not authorise deletion, which makes this sentence true.
	 */
	| "keychain"
	/**
	 * WRITTEN NOWHERE BY THIS CALL, AND DELIBERATELY NOT COPIED INTO THE FILE.
	 *
	 * The I5 case: this exact value came OUT of the keychain in this process
	 * (`hydrateSecrets`/`primeSecrets` noted it), and this save could not prove the
	 * keychain still holds it — a locked keychain, a tripped breaker, an earlier
	 * field's failure stopping the pass. Writing it to `config.json` would put a
	 * secret the user had already moved into the Keychain back into plaintext, so
	 * it is omitted from `jsonSafe`.
	 *
	 * What it must NOT do, and this is the whole reason it is a separate value:
	 *  - it is NOT in `storedInKeychain`, because this call proved nothing;
	 *  - it does NOT delete the field from the merged file, so whatever
	 *    `config.json` already held is left exactly as it was.
	 * Omitting from `jsonSafe` prevents a NEW plaintext copy. Deleting from
	 * `merged` would destroy an EXISTING one on no evidence at all.
	 */
	| "keychain-sourced-omitted"
	/** Stays in the file, with a reason. */
	| "config-file"
	/** Delete CONFIRMED — exit 0, or exit 44 meaning already absent. */
	| "cleared"
	/** Delete attempted, NOT confirmed. The item may still resolve (H4/I3). */
	| "clear-failed";

export interface SecretPersistOutcome {
	id: SecretId;
	field: string;
	stored: SecretDisposition;
	/**
	 * Set whenever there is something to explain, and NEVER key material.
	 *
	 * Always set on `keychain-sourced-omitted`, which needs it: that outcome means
	 * "this save proved nothing and wrote the value nowhere", and the reason names
	 * which failure produced it.
	 */
	reason?: string;
}

export interface SecretPersistReport {
	outcomes: SecretPersistOutcome[];
	/** PROVEN by this save. Never populated from provenance. */
	storedInKeychain: SecretId[];
	keptInConfigFile: SecretId[];
	/**
	 * Unproven, and kept out of the file because the value came from the keychain.
	 * Reported separately so no consumer can read it as a successful store.
	 */
	omittedKeychainSourced: SecretId[];
	anyFailed: boolean;
	/** Set by `saveGlobalConfig` when it had to preserve an unparseable file (H2). */
	corruptFilePreservedAs?: string;
}

/**
 * INCOMING FIELDS ONLY.
 *
 * Three invariants, and they are checked against the three failure sequences the
 * review supplied:
 *
 *  I1 — STRIP. A secret field is omitted from the object written to `config.json`
 *       IF AND ONLY IF this save (a) received that field in `incoming`, and (b)
 *       proved, during this save, that the keychain holds THAT EXACT VALUE.
 *       "Proved" means a verified write, or a read that returned a byte-identical
 *       value. Omission is a CONSEQUENCE of proof, never a step.
 *
 *       I1 is completed by `saveGlobalConfig`, not here: this function can only
 *       omit a field from `jsonSafe`, and `{...existing, ...jsonSafe}` RESTORES it
 *       from `existing`. The deletion over the MERGED object is the other half —
 *       see the loop over `report.outcomes` in `src/config.ts`.
 *
 *  I2 — NO BLIND WRITES. A keychain add/delete is issued ONLY for a registry field
 *       present in `incoming`. A value that came from `config.json` is never
 *       written to the keychain here. This restores exactly today's
 *       `routeSecretsToKeychain(config)` contract and is what kills the
 *       stale-overwrite sequence: a save of `{llmEndpoint}` performs no read, no
 *       write, no delete and NO SPAWN, so a value the user just edited in Keychain
 *       Access.app cannot be clobbered by the file's stale copy.
 *
 *  I3 — CLEAR SYMMETRY. A field is omitted as `cleared` IFF a delete was CONFIRMED
 *       during this save. An unconfirmed delete reports `clear-failed`, KEEPS the
 *       field, and never says `cleared`. Without I3, D1 is re-created pointing the
 *       other way: the user is told the key was cleared while a fully resolvable
 *       item survives.
 *
 *  I4 — `undefined` IS UNTOUCHED. An explicitly-`undefined` field removes nothing,
 *       from the keychain OR from the file. `""` is the only value that clears, and
 *       it clears through I3. See the deletion pass at the top of the body: without
 *       it, `{...existing, ...jsonSafe}` plus `JSON.stringify` deleted the field
 *       from disk silently and outside the report entirely (review A1).
 *
 *  I5 — A KEYCHAIN-SOURCED VALUE NEVER REACHES THE FILE. When this save cannot
 *       prove the keychain holds a value, it normally keeps that value in
 *       `config.json` — which is right for something the user just typed and wrong
 *       for something `hydrateSecrets` handed the caller out of the keychain five
 *       minutes ago. `recordUnproven` distinguishes the two by provenance
 *       (review C1).
 *
 *       I5 reports `keychain-sourced-omitted`, NOT `keychain`. It used to report
 *       `keychain`, which made I1 not an "iff": the merge loop in
 *       `saveGlobalConfig` deletes on that disposition, so an unproven write
 *       deleted the field — including an EXISTING plaintext copy holding a
 *       different value — and `storedInKeychain` claimed a store that never
 *       happened. Omitting from `jsonSafe` is what I5 needs; deleting from
 *       `merged` is not, and only proof may do that.
 *
 * Stops at the first write failure in a pass: a locked keychain blocks each spawn
 * for its full timeout, so six writes would cost `6 x timeout`.
 */
export function persistSecrets<T extends Partial<GlobalConfig>>(
	incoming: T,
): { jsonSafe: T; report: SecretPersistReport } {
	const jsonSafe = { ...incoming } as T;
	const mutable = jsonSafe as Record<string, unknown>;

	// ------------------------------------------------------------------
	// I4 — AN EXPLICIT `undefined` MEANS UNTOUCHED, NOT DELETE (review A1).
	//
	// `saveGlobalConfig` writes `{...existing, ...jsonSafe}`, and a key whose value
	// is `undefined` OVERWRITES the real value from `existing` — after which
	// `JSON.stringify` drops the key entirely. So `saveGlobalConfig({ openrouterApiKey:
	// undefined })` turned `{"openrouterApiKey":"sk-or-PLAINTEXT","defaultModel":"m"}`
	// into `{"defaultModel":"n"}` with `outcomes: []`: the only copy of a key
	// destroyed, no keychain operation attempted, and nothing in the report to say
	// so. That is defect D1 — the key-destruction bug this whole feature exists to
	// remove — arriving through the merge, on the one path whose comment below
	// promises it cannot.
	//
	// Deleting the key here, BEFORE the loop and for every field rather than only
	// the secrets, is what makes that comment true. The only way to remove a field
	// is now the explicit one: `""` clears a secret (I3), and
	// `removeGlobalConfigFields` removes anything else. `SetupApp.tsx`'s
	// `x = state.y || undefined` idiom means "leave it alone", which is what a
	// caller writing it plainly intends, and is now what it does.
	// ------------------------------------------------------------------
	for (const key of Object.keys(mutable)) {
		if (mutable[key] === undefined) delete mutable[key];
	}

	const outcomes: SecretPersistOutcome[] = [];
	let stopReason: string | null = null;

	const record = (
		spec: SecretSpec,
		stored: SecretDisposition,
		reason?: string,
	) => {
		outcomes.push({ id: spec.id, field: spec.configField, stored, reason });
	};

	/**
	 * Record a field this save could NOT prove is in the keychain.
	 *
	 * C1. Normally that means "keep the incoming value in config.json", which is
	 * correct and is what stops a failed write from losing a key. But if this exact
	 * value came OUT of the keychain during this process, writing it to the file
	 * would put a secret back into plaintext that the user had already moved into
	 * the Keychain — a leak, not a rescue. The keychain holds it; the file must
	 * not. The reason string says which of the two happened.
	 */
	const recordUnproven = (spec: SecretSpec, raw: string, reason: string) => {
		if (isKeychainSourced(spec.configField, raw)) {
			delete mutable[spec.configField];
			// NOT "keychain". This save proved nothing; provenance only says the
			// value passed through the keychain at some earlier point in this
			// process, which is a reason not to write plaintext and is NOT a licence
			// to delete the copy already on disk.
			record(
				spec,
				"keychain-sourced-omitted",
				`${reason} — this value was read FROM the Keychain in this session, so it is not written to config.json. ` +
					"This save did NOT verify that the Keychain still holds it.",
			);
			return;
		}
		record(spec, "config-file", reason);
	};

	for (const spec of SECRET_SPECS) {
		if (!(spec.configField in incoming)) continue; // I2
		const raw = (incoming as Record<string, unknown>)[spec.configField];
		// Untouched; NO item is deleted, and I4 above has already removed the key
		// from `jsonSafe` so the merge cannot delete it from the file either.
		if (raw === undefined) continue;

		// L4: a non-string is UNSTORABLE. Storing "null" in the keychain and then
		// serving it as an API key is strictly worse than leaving the corrupt value
		// where it is and saying so. Never `String()`-coerced. Not routed through
		// `recordUnproven`: a non-string cannot be a value we read from the keychain.
		if (typeof raw !== "string") {
			record(spec, "config-file", "value is not a string");
			continue;
		}

		if (!isSecretsBackendEnabled()) {
			// N5: no spawn is ATTEMPTED off-darwin or when opted out.
			recordUnproven(spec, raw, backendDisabledReason());
			continue;
		}

		if (stopReason) {
			recordUnproven(spec, raw, stopReason);
			continue;
		}

		if (raw === "") {
			// An explicit "" is a CLEAR. A field merely missing from `incoming` is
			// not — that is what stops the wizard wiping a key it failed to read.
			try {
				deleteKeychainAccount(spec.account);
				delete mutable[spec.configField];
				// The item is gone; nothing it ever held is proof any more (C1).
				forgetKeychainSourced(spec.configField);
				record(spec, "cleared");
			} catch (error) {
				const reason = errorMessage(error);
				record(
					spec,
					"clear-failed",
					`${reason} — the stored item may still resolve`,
				);
				warnOnce(
					`[mnemex] could not clear keychain item for '${spec.id}': ${reason}`,
				);
			}
			continue;
		}

		const unstorable = describeUnstorableValue(raw);
		if (unstorable) {
			// Not routed through `recordUnproven` either: a value the keychain
			// accepted cannot be one the keychain refuses.
			record(spec, "config-file", unstorable);
			continue;
		}

		// READ BEFORE WRITE (M2/M6). If the stored value is byte-identical there is
		// nothing to write and I1(b) is satisfied by the read. This removes the write
		// amplification AND closes the wizard's re-submission path: a value the
		// wizard hydrated FROM the keychain is recognised as already stored and never
		// needs a write that could fail into plaintext.
		//
		// If the read itself FAILS the write is still attempted — the write may be
		// the very act that prompts the user to unlock.
		//
		// `fresh` IS THE PROOF (external review round 3, HIGH 2). This read is not
		// an optimisation, it is the evidence that authorises deleting the
		// plaintext copy from `config.json` two frames down. Served from the
		// three-second burst memo it proved only that the keychain held this value
		// at some point in the last three seconds — during which another process's
		// unforced `keychain rm` could have removed it, leaving the credential
		// nowhere. Same defect class as the `keychainSourced` provenance bug this
		// file already carries a `keychain-sourced-omitted` disposition for: a
		// claim of proof satisfied by evidence the claiming call did not obtain.
		const pre = readKeychainAccount(spec.account, { fresh: true });
		if (pre.status === "found" && pre.value === raw) {
			delete mutable[spec.configField];
			noteKeychainSourced(spec.configField, raw);
			record(spec, "keychain");
			continue;
		}

		try {
			writeKeychainAccount(spec.account, raw, spec.label);
			delete mutable[spec.configField];
			// The write was verified by a byte-identical read-back, so this value is
			// now provably in the keychain (C1).
			noteKeychainSourced(spec.configField, raw);
			record(spec, "keychain");
		} catch (error) {
			const reason = errorMessage(error);
			const sourcedFromKeychain = isKeychainSourced(spec.configField, raw);
			recordUnproven(spec, raw, reason);
			stopReason = reason;
			warnOnce(
				`[mnemex] could not store '${spec.id}' in the macOS Keychain: ${reason}. ` +
					(sourcedFromKeychain
						? "The value came from the Keychain and is NOT copied into ~/.mnemex/config.json."
						: "It stays in ~/.mnemex/config.json (mode 0600)."),
			);
		}
	}

	const report: SecretPersistReport = {
		outcomes,
		storedInKeychain: outcomes
			.filter((o) => o.stored === "keychain")
			.map((o) => o.id),
		keptInConfigFile: outcomes
			.filter((o) => o.stored === "config-file" || o.stored === "clear-failed")
			.map((o) => o.id),
		omittedKeychainSourced: outcomes
			.filter((o) => o.stored === "keychain-sourced-omitted")
			.map((o) => o.id),
		// An omission on no proof IS a failure of this save, even though nothing was
		// lost: the value the caller handed us is not stored anywhere new.
		anyFailed: outcomes.some(
			(o) =>
				o.stored === "config-file" ||
				o.stored === "clear-failed" ||
				o.stored === "keychain-sourced-omitted",
		),
	};
	return { jsonSafe, report };
}

/**
 * Overlay keychain values OVER file values (N6).
 *
 * File-wins would contradict F3 and `resolveSecret`, and for a migrated-but-not-
 * pruned user — the intended intermediate state — the wizard would prefill a stale
 * file value while every getter returned the keychain value.
 */
export function hydrateSecrets<T extends Partial<GlobalConfig>>(config: T): T {
	const out = { ...config } as T;
	if (!isSecretsBackendEnabled()) return out;

	const enumeration = enumerateStoredSecrets();
	if (enumeration.failed) {
		warnOnce(
			`[mnemex] macOS Keychain could not be enumerated: ${enumeration.error}`,
		);
		return out;
	}

	const mutable = out as Record<string, unknown>;
	for (const id of enumeration.ids) {
		const spec = secretSpecById(id);
		const read = readKeychainAccount(spec.account);
		if (read.status === "found" && read.value) {
			mutable[spec.configField] = read.value;
			// C1. Remember that THIS value came out of the keychain, so a later save
			// of this object cannot flush it back into the file as plaintext.
			noteKeychainSourced(spec.configField, read.value);
		}
	}
	return out;
}

/** Caller: `mnemex keychain rm`. */
export function deleteStoredSecret(id: SecretId): boolean {
	const spec = secretSpecById(id);
	const deleted = deleteKeychainAccount(spec.account);
	// The item is gone: its value is no longer proof that the keychain holds it.
	forgetKeychainSourced(spec.configField);
	return deleted;
}

// ============================================================================
// Migration control surface (C3, F10) — explicit, user-initiated, never automatic
// ============================================================================

export interface SecretMigrationReport {
	/** Verified round-trip. The file copy is DELIBERATELY retained — `prune` removes it. */
	copied: SecretId[];
	/** An item already exists. NEVER overwritten from the file (I2). */
	skippedAlreadyStored: SecretId[];
	failed: { id: SecretId; reason: string }[];
	dryRun: boolean;
}

export interface SecretPruneReport {
	/** Re-verified present and byte-identical, then removed from the file. */
	pruned: SecretId[];
	refused: { id: SecretId; reason: string }[];
	/** True when a read FAILURE aborted the whole prune and nothing was written. */
	aborted: boolean;
	abortReason?: string;
}

/**
 * Copy file-resident plaintext keys into the keychain, ONLY where no item exists.
 *
 * TWO guards, and the first one is load-bearing (review finding N2):
 *
 *  1. If the enumeration FAILED, migrate refuses ENTIRELY. `KeychainEnumeration.
 *     accounts` is empty when `failed`, so an unguarded migrate reads every id as
 *     "not stored", overwrites every live keychain item from the file with `-U`,
 *     verifies the round-trip against what it just wrote, and reports success —
 *     the exact key-destruction sequence I2 exists to prevent, re-entering through
 *     the one command that is supposed to be the safe path. A failed enumeration
 *     means "I do not know what is stored", and migrating on that basis is what I2
 *     forbids for `persistSecrets`. It is NEVER treated as an empty store. The
 *     trigger is concrete, not hypothetical: a login keychain slow enough to blow
 *     ENUMERATE_TIMEOUT_MS is still fast enough to serve individual writes.
 *
 *  2. Each copy does a per-id read IMMEDIATELY before its write and proceeds only
 *     on `absent`. The dump is an optimisation; absence is proved per item.
 *
 *  3. The write itself is CREATE-ONLY (`-U` omitted), so "never overwrite" is a
 *     property of the operation rather than the conclusion of a check that
 *     something else could invalidate in between. A duplicate is reported as
 *     `skippedAlreadyStored`, never as a failure and never as a copy.
 *
 * `config.json` is not modified here at all.
 */
export function migrateFileSecrets(
	fileConfig: Partial<GlobalConfig>,
	opts?: { dryRun?: boolean },
): SecretMigrationReport {
	const dryRun = opts?.dryRun === true;
	const report: SecretMigrationReport = {
		copied: [],
		skippedAlreadyStored: [],
		failed: [],
		dryRun,
	};

	const candidates = SECRET_SPECS.filter((spec) => {
		const v = (fileConfig as Record<string, unknown>)[spec.configField];
		return typeof v === "string" && v.length > 0;
	});
	if (candidates.length === 0) return report;

	if (!isSecretsBackendEnabled()) {
		for (const spec of candidates) {
			report.failed.push({ id: spec.id, reason: backendDisabledReason() });
		}
		return report;
	}

	const enumeration = enumerateStoredSecrets();
	if (enumeration.failed) {
		// GUARD 1 — see the doc comment. Write nothing, say why, for every id.
		for (const spec of candidates) {
			report.failed.push({
				id: spec.id,
				reason: `keychain enumeration failed (${enumeration.error}); refusing to migrate — a failed enumeration is not an empty keychain`,
			});
		}
		return report;
	}

	for (const spec of candidates) {
		const value = (fileConfig as Record<string, unknown>)[
			spec.configField
		] as string;

		if (enumeration.ids.includes(spec.id)) {
			report.skippedAlreadyStored.push(spec.id);
			continue;
		}

		// GUARD 2 — prove absence PER ITEM, with a real read.
		// The invalidate is load-bearing: a fresh enumeration can answer "absent"
		// for free from the list memo, which would make this guard vacuous exactly
		// when it matters. The dump is an optimisation; absence is proved per item.
		invalidateKeychainCache();
		const pre = readKeychainAccount(spec.account);
		if (pre.status === "found") {
			report.skippedAlreadyStored.push(spec.id);
			continue;
		}
		if (pre.status === "failed") {
			report.failed.push({
				id: spec.id,
				reason: `could not confirm the item is absent: ${pre.error}`,
			});
			continue;
		}

		const unstorable = describeUnstorableValue(value);
		if (unstorable) {
			report.failed.push({ id: spec.id, reason: unstorable });
			continue;
		}

		if (dryRun) {
			report.copied.push(spec.id);
			continue;
		}

		try {
			// GUARD 3 — CREATE-ONLY. Guards 1 and 2 are checks; this is a property of
			// the operation. Without it, `writeKeychainAccount`'s `-U` upsert made
			// "never overwrite" a check-then-act pair, and anything that created the
			// item between the read above and this line — a second mnemex process, or
			// the user in Keychain Access.app — was silently replaced with the stale
			// plaintext copy and reported as `copied`.
			writeKeychainAccount(spec.account, value, spec.label, {
				createOnly: true,
			});
			report.copied.push(spec.id);
		} catch (error) {
			if (error instanceof KeychainDuplicateItemError) {
				// It appeared underneath us. That is the outcome guard 2 exists to
				// produce, arrived at a few microseconds later.
				report.skippedAlreadyStored.push(spec.id);
				continue;
			}
			report.failed.push({ id: spec.id, reason: errorMessage(error) });
		}
	}

	return report;
}

/**
 * Decide which plaintext copies may be removed from `config.json`.
 *
 * Returns the fields to remove; the CALLER performs ONE atomic write, so a mixed
 * prune writes exactly the verified subset in a single write and a crash mid-loop
 * changes nothing.
 *
 * Two refusal classes, deliberately split (N5):
 *
 *  - A READ FAILURE aborts the ENTIRE prune and writes nothing. If the keychain
 *    becomes unreadable partway through, the ids already verified would otherwise
 *    have their last file copy deleted on a machine whose keychain just stopped
 *    answering. Not a loss — the items exist — but it is the worst possible moment
 *    to delete the last file copy, and it is avoidable.
 *  - A MISMATCH refuses only that id and proceeds with the others, naming the
 *    concrete remedy. Two legitimate sequences produce one: an interrupted save,
 *    and a user who re-entered a DIFFERENT key. Those users are otherwise told
 *    their key "does not re-verify", which sounds like corruption, and the
 *    plaintext copy stays forever with nothing said about what to do.
 */
export function pruneFileSecrets(fileConfig: Partial<GlobalConfig>): {
	report: SecretPruneReport;
	fieldsToRemove: string[];
	/**
	 * The exact file value each removable field was VERIFIED against.
	 *
	 * Handed to `removeGlobalConfigFields` so the deletion is conditional on the
	 * file still holding what this function proved. Between the read here and the
	 * write there, another save can install a DIFFERENT plaintext value — most
	 * plausibly one whose keychain write failed, which is exactly the value that
	 * must not be deleted unverified.
	 */
	verifiedValues: Record<string, string>;
} {
	const report: SecretPruneReport = { pruned: [], refused: [], aborted: false };
	const fieldsToRemove: string[] = [];
	const verifiedValues: Record<string, string> = {};

	const candidates = SECRET_SPECS.filter((spec) => {
		const v = (fileConfig as Record<string, unknown>)[spec.configField];
		return typeof v === "string" && v.length > 0;
	});
	if (candidates.length === 0)
		return { report, fieldsToRemove, verifiedValues };

	if (!isSecretsBackendEnabled()) {
		report.aborted = true;
		report.abortReason = backendDisabledReason();
		for (const spec of candidates) {
			report.refused.push({ id: spec.id, reason: backendDisabledReason() });
		}
		return { report, fieldsToRemove: [], verifiedValues: {} };
	}

	for (const spec of candidates) {
		const fileValue = (fileConfig as Record<string, unknown>)[
			spec.configField
		] as string;
		// Re-verification is the last thing standing between the user and the
		// deletion of their only plaintext copy, so it gets a FRESH read rather than
		// one the burst memo may have answered from up to MEMO_TTL_MS ago. The same
		// invalidation `migrateFileSecrets` needs, for the same reason: a proof that
		// can be served from a cache is not a proof of the current state.
		invalidateKeychainCache();
		const read = readKeychainAccount(spec.account);

		if (read.status === "failed") {
			report.aborted = true;
			report.abortReason = read.error;
			report.pruned = [];
			report.refused = candidates.map((s) => ({
				id: s.id,
				reason: `keychain read failed (${read.error}); the whole prune was abandoned and config.json was not written`,
			}));
			return { report, fieldsToRemove: [], verifiedValues: {} };
		}
		if (read.status === "absent") {
			report.refused.push({
				id: spec.id,
				reason:
					"not stored in the keychain — run `mnemex keychain migrate` first",
			});
			continue;
		}
		if (read.value !== fileValue) {
			report.refused.push({
				id: spec.id,
				reason:
					"the keychain value differs from the config.json copy. The keychain value is the one mnemex uses. " +
					"Remove the line from ~/.mnemex/config.json by hand, or re-enter the key through `mnemex init`",
			});
			continue;
		}
		report.pruned.push(spec.id);
		fieldsToRemove.push(spec.configField);
		verifiedValues[spec.configField] = fileValue;
	}

	return { report, fieldsToRemove, verifiedValues };
}

// ============================================================================
// Internal helpers
// ============================================================================

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
