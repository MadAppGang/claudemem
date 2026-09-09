/**
 * `mnemex keychain` — the CONTROL SURFACE of the plaintext-to-keychain migration.
 *
 * Not a credential CLI: there is no `keychain set`, no `keychain get` and no
 * arbitrary service names. That remains out of scope. What is in scope is the
 * answer to "did the key move correctly?", because every user upgrading from
 * <= 0.32.0 has all six keys in plaintext `~/.mnemex/config.json` and zero keychain
 * items, and deferring an inspection command is defensible for a feature but not
 * for the only mechanism that makes an otherwise-invisible migration inspectable
 * or reversible.
 *
 * Nothing here runs automatically. Upgrading performs neither `migrate` nor `prune`.
 *
 * This module calls `secrets.ts` only — it never touches keychain mechanics.
 *
 * ---------------------------------------------------------------------------
 * TWO OUTPUT CONTRACTS, and both are load-bearing (CLAUDE.md #14).
 *
 *  - Human mode: prose, headings, the reasoning behind a refusal.
 *  - `--agent` mode: `key=value` lines only, matching `src/output/agent.ts`. Agent
 *    consumers parse stdout line by line; a heading or a blank line is a parse
 *    error, not a cosmetic difference. The command previously ignored `--agent`
 *    entirely.
 *
 * EXIT STATUS is part of the contract too. A migration that reports every key as
 * FAILED, and a prune that reports ABORTED, previously both exited 0 — so
 * automation could not tell a completed migration from a refused one.
 */

import { statSync } from "node:fs";
import {
	ConfigLockUnavailableError,
	GLOBAL_CONFIG_PATH,
	hardenGlobalConfigFileMode,
	isConfigLockHeld,
	loadGlobalConfig,
	removeGlobalConfigFields,
	withConfigLock,
} from "../../config.js";
import { maskSecret } from "../../core/keychain.js";
import {
	deleteStoredSecret,
	enumerateStoredSecrets,
	migrateFileSecrets,
	pruneFileSecrets,
	SECRET_SPECS,
	type SecretId,
	secretsBackendStatus,
} from "../../core/secrets.js";

const USAGE = `
Usage: mnemex keychain <subcommand>

Subcommands:
  status               What is stored where, and whether the backend is usable
  migrate [--dry-run]  Copy plaintext keys from config.json into the Keychain,
                       ONLY where no item exists. Leaves config.json's contents
                       unchanged; tightens its mode to 0600.
  prune                Remove plaintext copies that re-verify against the Keychain.
                       Refuses — by name — for any key that does not.
  rm <id> [--force]    Delete one Keychain item. --force is required when no
                       plaintext copy remains in config.json. Works even when the
                       backend is opted out, so a stale item can always be removed.

Ids: ${SECRET_SPECS.map((s) => s.id).join(", ")}
`;

/**
 * Every flag each subcommand accepts. An empty list means "no flags at all".
 *
 * `--agent` is absent deliberately: `runCli` filters it out of `args` before this
 * handler sees it, so accepting it here would be documenting a token that never
 * arrives.
 */
const ACCEPTED_FLAGS: Record<string, readonly string[]> = {
	status: [],
	migrate: ["--dry-run"],
	prune: [],
	rm: ["--force"],
};

export interface KeychainCommandOptions {
	/** `--agent`: emit `key=value` lines only. Resolved by `runCli`, not here. */
	agent?: boolean;
}

/**
 * Returns the process exit code rather than calling `process.exit` itself.
 *
 * `process.exit` in the middle of a render truncates buffered stdout, which is how
 * an agent consumer ends up parsing half a line. The caller exits after the last
 * write.
 */
export async function handleKeychainCommand(
	args: string[],
	options?: KeychainCommandOptions,
): Promise<number> {
	const agent = options?.agent === true;
	const subcommand = args[0];

	if (!subcommand || subcommand === "help" || subcommand === "--help") {
		if (agent) {
			console.log("command=keychain");
			console.log(
				`subcommands=${["status", "migrate", "prune", "rm"].join(",")}`,
			);
			console.log(`ids=${SECRET_SPECS.map((s) => s.id).join(",")}`);
			return 0;
		}
		console.log(USAGE);
		return 0;
	}

	// STRICT FLAGS. An unrecognised dash-argument ABORTS, before the lock and
	// before any keychain access.
	//
	// This is not tidiness. `migrate` decided its mode with
	// `args.includes("--dry-run")`, so a mistyped flag did not fail — it fell
	// through to the DESTRUCTIVE default and ran a real migration. It happened on
	// a real machine within a day of shipping: `keychain migrate --dry-runDD`,
	// recorded in shell history at 09:14:16, created the `voyage` and `context7`
	// items whose keychain `cdat` is the same second. The user believed they had
	// run a preview, and the tool agreed with them right up to the point where it
	// wrote.
	//
	// The general shape: a boolean flag parsed by membership makes every typo of
	// it mean the opposite of what was typed, silently. `--force` has the same
	// parse, and its typo fails safe only by luck of which way the default points.
	const unknownFlag = args
		.slice(1)
		.find((a) => a.startsWith("-") && !ACCEPTED_FLAGS[subcommand]?.includes(a));
	if (unknownFlag !== undefined) {
		const accepted = ACCEPTED_FLAGS[subcommand] ?? [];
		// A typo of an accepted flag is the case that motivated this check, so name
		// it rather than making the user diff two strings by eye.
		const meant = accepted.find(
			(f) => unknownFlag.startsWith(f) || f.startsWith(unknownFlag),
		);
		console.error(
			`error=unknown_flag subcommand=${subcommand} value=${unknownFlag}`,
		);
		if (meant) console.error(`Did you mean ${meant}?`);
		console.error(
			accepted.length > 0
				? `Accepted for '${subcommand}': ${accepted.join(", ")}. Nothing was changed.`
				: `'${subcommand}' takes no flags. Nothing was changed.`,
		);
		return 1;
	}

	switch (subcommand) {
		case "status":
			// The only read-only subcommand, and the only one outside the lock.
			return keychainStatus(agent);
		// ------------------------------------------------------------------
		// EVERY MUTATING SUBCOMMAND RUNS INSIDE THE ONE SHARED CREDENTIAL LOCK.
		//
		// External review supplied a deterministic sequence in which `prune` and an
		// unforced `rm` destroy BOTH copies of a credential, with neither command
		// requiring `--force` (CWE-367):
		//
		//   1. config.json and the keychain both hold openrouter=A.
		//   2. P runs `prune`: reads A from the keychain, marks the field removable,
		//      carries on verifying the next candidate.
		//   3. R runs `rm openrouter`: sees the still-present plaintext A, so the
		//      last-copy guard permits it, and deletes the keychain item.
		//   4. P deletes the line from config.json — its expected-value check passes,
		//      because the FILE did not change. It only ever guarded the file.
		//   5. A exists in neither place. Each command believed the other copy safe.
		//
		// The check-then-act pairs straddle two resources, so no per-resource check
		// can close it; serialising the commands can. `withConfigLock` is re-entrant
		// within a process, so `prune` holding it across `removeGlobalConfigFields`
		// is not a deadlock, and it FAILS CLOSED — an unavailable lock aborts the
		// command with nothing changed.
		// ------------------------------------------------------------------
		case "migrate":
			return withCredentialLock(agent, () =>
				keychainMigrate(args.includes("--dry-run"), agent),
			);
		case "prune":
			return withCredentialLock(agent, () => keychainPrune(agent));
		case "rm":
			return withCredentialLock(agent, () =>
				keychainRm(args[1], args.includes("--force"), agent),
			);
		default:
			// Errors go to stderr in BOTH modes, so an agent parsing stdout sees a
			// clean (empty) result rather than prose it will try to read as data.
			console.error(`error=unknown_subcommand value=${subcommand}`);
			console.error('Run "mnemex keychain help" for usage.');
			return 1;
	}
}

/**
 * Take the shared credential lock, or refuse the whole subcommand.
 *
 * "Refuse" and not "warn": the sequences this lock closes end in a destroyed
 * credential, so proceeding unlocked is strictly worse than not running.
 */
/**
 * Turns "CALLED ONLY FROM INSIDE `withCredentialLock`" from a comment into a
 * checked fact. A future refactor that adds a call site outside the lock fails
 * loudly here instead of silently re-opening the cross-resource race.
 */
function assertCredentialLockHeld(command: string): void {
	if (!isConfigLockHeld()) {
		throw new Error(
			`internal error: 'keychain ${command}' ran without the credential lock. ` +
				"It mutates config.json and the keychain, and the two must not be " +
				"observed separately by another process.",
		);
	}
}

function withCredentialLock(agent: boolean, fn: () => number): number {
	try {
		return withConfigLock(fn);
	} catch (error) {
		if (!(error instanceof ConfigLockUnavailableError)) throw error;
		if (agent) {
			console.error("error=lock_unavailable");
			console.error(`reason=${error.message}`);
			return 1;
		}
		console.error(`\n  REFUSED — ${error.message}\n`);
		return 1;
	}
}

// ============================================================================
// status — ONE spawn
// ============================================================================

/**
 * Exactly one `security` spawn: a single `dump-keychain`.
 *
 * It deliberately does NOT read any value back. `maskSecret` is applied to the
 * CONFIG-FILE copies, which cost no spawn at all. A status command that is
 * expensive will not be run, and this one exists to be run.
 *
 * An enumeration FAILURE renders every keychain-side answer as `unknown`, never as
 * `not configured`. "I could not ask" and "there is nothing there" are the same
 * collapse as defect D5, one layer up in the UI.
 */
function keychainStatus(agent: boolean): number {
	const backend = secretsBackendStatus();
	const file = loadGlobalConfig() as unknown as Record<string, unknown>;

	const enumeration = backend.enabled
		? enumerateStoredSecrets()
		: {
				ids: [] as SecretId[],
				unknownAccounts: [] as string[],
				failed: true,
				error: backend.reason,
			};

	const rows = SECRET_SPECS.map((spec) => {
		const fileValue = file[spec.configField];
		const inFile = typeof fileValue === "string" && fileValue.length > 0;
		return {
			id: spec.id,
			/** `null` means UNKNOWN — the keychain could not be asked. */
			inKeychain: enumeration.failed ? null : enumeration.ids.includes(spec.id),
			inFile,
			masked: inFile ? maskSecret(fileValue as string) : undefined,
		};
	});

	const migratable = rows.filter((r) => r.inFile && r.inKeychain === false);

	if (agent) {
		console.log(`backend_enabled=${backend.enabled}`);
		if (backend.reason) console.log(`backend_reason=${backend.reason}`);
		console.log(`config_file=${GLOBAL_CONFIG_PATH}`);
		console.log(`config_file_mode=${describeModeOctal()}`);
		console.log(`keychain_readable=${!enumeration.failed}`);
		if (enumeration.failed && enumeration.error) {
			console.log(`keychain_error=${enumeration.error}`);
		}
		for (const row of rows) {
			// `keychain=unknown` is a distinct third value on purpose.
			const keychainState =
				row.inKeychain === null ? "unknown" : String(row.inKeychain);
			console.log(
				`secret id=${row.id} keychain=${keychainState} config_file=${row.inFile}${
					row.masked ? ` masked=${row.masked}` : ""
				}`,
			);
		}
		for (const account of enumeration.unknownAccounts) {
			console.log(`unclaimed_account=${account}`);
		}
		console.log(`migratable=${migratable.length}`);
		return 0;
	}

	console.log("\nmnemex keychain status\n");
	console.log(
		`  Backend: ${backend.enabled ? 'enabled (macOS Keychain, service "mnemex")' : `disabled — ${backend.reason}`}`,
	);
	console.log(`  Config file: ${GLOBAL_CONFIG_PATH} (${describeMode()})\n`);

	if (enumeration.failed) {
		// NEVER rendered as "no keys stored" — the type does not permit that
		// confusion and neither does this output.
		console.log(`  Keychain could not be read: ${enumeration.error}`);
		console.log("  (this is NOT the same as 'nothing is stored')\n");
	}

	for (const row of rows) {
		const where = [
			row.inKeychain === null
				? "keychain: unknown"
				: row.inKeychain
					? "keychain"
					: null,
			row.inFile ? `config.json ${row.masked}` : null,
		].filter(Boolean);

		console.log(
			`  ${row.id.padEnd(11)} ${where.length ? where.join(" + ") : "not configured"}`,
		);
	}

	if (enumeration.unknownAccounts.length > 0) {
		console.log('\n  Stored under service "mnemex" but NOT read by mnemex:');
		for (const account of enumeration.unknownAccounts) {
			console.log(`    account "${account}"`);
		}
		console.log(
			"  (mnemex looks up the short account names above; a hand-created item",
		);
		console.log("   named after an environment variable will not resolve)");
	}

	if (migratable.length > 0) {
		console.log(
			`\n  ${migratable.length} plaintext key(s) in config.json are not in the Keychain.`,
		);
		console.log(
			"  `mnemex keychain migrate` copies them (config.json is left as is).",
		);
	}
	console.log("");
	return 0;
}

function configFileMode(): number | undefined {
	try {
		return statSync(GLOBAL_CONFIG_PATH).mode & 0o777;
	} catch {
		return undefined;
	}
}

function describeMode(): string {
	const mode = configFileMode();
	return mode === undefined ? "does not exist" : `mode 0${mode.toString(8)}`;
}

function describeModeOctal(): string {
	const mode = configFileMode();
	return mode === undefined ? "absent" : `0${mode.toString(8)}`;
}

// ============================================================================
// migrate
// ============================================================================

function keychainMigrate(dryRun: boolean, agent: boolean): number {
	assertCredentialLockHeld("migrate");
	const file = loadGlobalConfig();
	const report = migrateFileSecrets(file, { dryRun });

	// The plaintext copies STAY, deliberately. What must not stay is 0644 on a file
	// full of them for the whole validation interval this two-step migration asks
	// the user to sit in. Contents untouched; mode only.
	const hardened = dryRun ? true : hardenGlobalConfigFileMode();

	const failed = report.failed.length > 0;
	// A migration that could not confirm the plaintext it is leaving behind is
	// protected has not finished the job it advertised.
	const exitCode = failed || !hardened ? 1 : 0;

	if (agent) {
		console.log(`dry_run=${dryRun}`);
		for (const id of report.copied) console.log(`copied=${id}`);
		for (const id of report.skippedAlreadyStored) console.log(`skipped=${id}`);
		for (const { id, reason } of report.failed) {
			console.log(`failed id=${id} reason=${reason}`);
		}
		console.log(`copied_count=${report.copied.length}`);
		console.log(`skipped_count=${report.skippedAlreadyStored.length}`);
		console.log(`failed_count=${report.failed.length}`);
		console.log(`config_file_mode=${describeModeOctal()}`);
		console.log(`config_file_hardened=${hardened}`);
		console.log(`exit_code=${exitCode}`);
		return exitCode;
	}

	console.log(
		`\nmnemex keychain migrate${dryRun ? " (dry run — nothing was written)" : ""}\n`,
	);

	if (
		report.copied.length === 0 &&
		report.skippedAlreadyStored.length === 0 &&
		report.failed.length === 0
	) {
		console.log(
			"  No plaintext keys in ~/.mnemex/config.json. Nothing to do.\n",
		);
		return exitCode;
	}

	for (const id of report.copied) {
		console.log(`  ${dryRun ? "would copy" : "copied"}: ${id}`);
	}
	for (const id of report.skippedAlreadyStored) {
		console.log(
			`  skipped: ${id} — an item already exists (never overwritten)`,
		);
	}
	for (const { id, reason } of report.failed) {
		console.log(`  FAILED:  ${id} — ${reason}`);
	}

	if (!dryRun && !hardened) {
		console.error(
			`\n  WARNING: could not confirm ${GLOBAL_CONFIG_PATH} is mode 0600.`,
		);
		console.error(
			"  The plaintext copies it still holds may be readable by other users.",
		);
	}

	if (!dryRun && report.copied.length > 0) {
		console.log(
			"\n  The plaintext copies are STILL IN ~/.mnemex/config.json. That is deliberate:",
		);
		console.log(
			"  copy-verify-then-SEPARATELY-delete is the only shape in which an interrupted",
		);
		console.log("  or regretted migration cannot lose a key.");
		console.log(
			`  The file has been tightened to mode 0600; its contents are unchanged.`,
		);
		console.log(
			"  Use mnemex normally, confirm it works, then run `mnemex keychain prune`.",
		);
	}
	console.log("");
	return exitCode;
}

// ============================================================================
// prune
// ============================================================================

/**
 * CALLED ONLY FROM INSIDE `withCredentialLock`.
 *
 * The lock must span the file read, the keychain re-verification AND the file
 * replacement — the window the cross-resource race lives in is exactly between
 * the first and the last of those. `removeGlobalConfigFields` takes the same
 * (re-entrant) lock, so the whole span is one critical section.
 */
function keychainPrune(agent: boolean): number {
	assertCredentialLockHeld("prune");
	const file = loadGlobalConfig();
	const { report, fieldsToRemove, verifiedValues } = pruneFileSecrets(file);

	if (report.aborted) {
		if (agent) {
			console.log("aborted=true");
			console.log(`abort_reason=${report.abortReason}`);
			console.log("pruned_count=0");
			console.log("exit_code=1");
			return 1;
		}
		console.log("\nmnemex keychain prune\n");
		console.log(`  ABORTED — ${report.abortReason}`);
		console.log("  Nothing was removed from ~/.mnemex/config.json.");
		console.log(
			"  A keychain that just stopped answering is the worst possible moment to",
		);
		console.log("  delete the last plaintext copy of a key.\n");
		return 1;
	}

	if (report.pruned.length === 0 && report.refused.length === 0) {
		if (agent) {
			console.log("aborted=false");
			console.log("pruned_count=0");
			console.log("refused_count=0");
			console.log("exit_code=0");
			return 0;
		}
		console.log("\nmnemex keychain prune\n");
		console.log(
			"  No plaintext keys in ~/.mnemex/config.json. Nothing to do.\n",
		);
		return 0;
	}

	// ONE atomic write for the whole verified subset, conditional on each field
	// still holding the value that was verified.
	const removal = removeGlobalConfigFields(fieldsToRemove, verifiedValues);

	// A field that changed under us was NOT pruned, whatever the report said a
	// moment ago. Correct the report before it is rendered.
	if (removal.skipped.length > 0) {
		const skippedIds = new Set(
			SECRET_SPECS.filter((s) => removal.skipped.includes(s.configField)).map(
				(s) => s.id,
			),
		);
		report.pruned = report.pruned.filter((id) => !skippedIds.has(id));
		for (const id of skippedIds) {
			report.refused.push({
				id,
				reason:
					"the config.json value changed between verification and removal; it was left in place",
			});
		}
	}

	const exitCode = report.refused.length > 0 ? 1 : 0;

	if (agent) {
		console.log("aborted=false");
		for (const id of report.pruned) console.log(`pruned=${id}`);
		for (const { id, reason } of report.refused) {
			console.log(`refused id=${id} reason=${reason}`);
		}
		console.log(`pruned_count=${report.pruned.length}`);
		console.log(`refused_count=${report.refused.length}`);
		console.log(`exit_code=${exitCode}`);
		return exitCode;
	}

	console.log("\nmnemex keychain prune\n");
	for (const id of report.pruned) {
		console.log(
			`  pruned:  ${id} — removed from config.json, kept in the Keychain`,
		);
	}
	for (const { id, reason } of report.refused) {
		console.log(`  REFUSED: ${id} — ${reason}`);
	}

	if (report.pruned.length > 0) {
		console.log(
			"\n  Those keys now live ONLY in the macOS Keychain. A downgrade to <= 0.32.0",
		);
		console.log(
			"  reads only config.json and will not find them. The items are not destroyed:",
		);
		console.log("  they stay visible in Keychain Access.app and readable with");
		console.log("    security find-generic-password -s mnemex -a <account> -w");
	}
	console.log("");
	return exitCode;
}

// ============================================================================
// rm
// ============================================================================

/**
 * CALLED ONLY FROM INSIDE `withCredentialLock`.
 *
 * The last-copy guard reads `config.json` and then deletes a keychain item. Those
 * two steps used to straddle a `prune` running in another process, which is the
 * cross-resource TOCTOU: rm's file read saw a plaintext copy that prune was in
 * the act of deleting. Holding the lock across both makes rm's read of the file
 * and its delete of the item indivisible with respect to prune.
 */
function keychainRm(
	id: string | undefined,
	force: boolean,
	agent: boolean,
): number {
	assertCredentialLockHeld("rm");
	if (!id) {
		console.error("error=missing_id");
		console.error("Usage: mnemex keychain rm <id> [--force]");
		console.error(`Ids: ${SECRET_SPECS.map((s) => s.id).join(", ")}`);
		return 1;
	}
	const spec = SECRET_SPECS.find((s) => s.id === id);
	if (!spec) {
		console.error(`error=unknown_id value=${id}`);
		console.error(`Ids: ${SECRET_SPECS.map((s) => s.id).join(", ")}`);
		return 1;
	}

	// LAST-COPY GUARD. Deliberate deletion is legitimate; unwitting deletion of the
	// only remaining copy is not, in a feature whose first stated purpose is that a
	// key is never lost. After migrate + prune the item IS the only copy. One extra
	// file read, no extra spawn.
	const file = loadGlobalConfig() as unknown as Record<string, unknown>;
	const fileValue = file[spec.configField];
	const hasFileCopy = typeof fileValue === "string" && fileValue.length > 0;

	if (!hasFileCopy && !force) {
		console.error(`error=last_copy id=${id}`);
		console.error(
			`Refusing: no plaintext copy of '${id}' remains in ~/.mnemex/config.json,`,
		);
		console.error(
			"so the Keychain item is the only copy. Re-run with --force to delete it.",
		);
		return 1;
	}

	// Deliberately NOT gated on `isSecretsBackendEnabled()`: a user who opted out
	// still needs a way to remove a stale item, and this is an explicit, destructive,
	// user-initiated command rather than part of the resolution path.
	try {
		const deleted = deleteStoredSecret(spec.id);
		if (agent) {
			console.log(`removed id=${id} existed=${deleted}`);
			console.log(`config_file_copy=${hasFileCopy}`);
			console.log("exit_code=0");
			return 0;
		}
		console.log(
			deleted
				? `\n✅ Deleted the Keychain item for '${id}'.`
				: `\n✅ No Keychain item for '${id}' existed (already absent).`,
		);
		if (hasFileCopy) {
			console.log(
				`   A plaintext copy remains in ~/.mnemex/config.json; mnemex will use it.\n`,
			);
		} else {
			console.log("");
		}
		return 0;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		console.error(`error=delete_failed id=${id} reason=${reason}`);
		console.error("The item may still resolve. Nothing else was changed.");
		return 1;
	}
}
