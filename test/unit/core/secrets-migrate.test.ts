/**
 * The migration control surface, through the injectable seam.
 * NO TEST HERE SPAWNS ANYTHING.
 *
 * Covers V19 and V23, plus the migrate/prune rows the design owns.
 *
 * V19 is one of the CONDITIONAL verdict's binding fixes: `KeychainEnumeration.
 * accounts` is EMPTY when `failed`, so an unguarded migrate reads every id as
 * "not stored", overwrites every live keychain item from the file with `-U`,
 * verifies the round-trip against what it just wrote, and reports success. That is
 * the key-destruction sequence the incoming-only contract exists to prevent,
 * re-entering through the one command that is supposed to be the SAFE path.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	enumerateStoredSecrets,
	migrateFileSecrets,
	persistSecrets,
	pruneFileSecrets,
} from "../../../src/core/secrets.js";
import {
	fakeKeychain,
	installKeychainStub,
	type KeychainStub,
	uninstallKeychainStub,
} from "../../helpers/keychain-stub.js";

let stub: KeychainStub;

beforeEach(() => {
	stub = installKeychainStub();
});

afterEach(() => {
	uninstallKeychainStub();
});

// ============================================================================
// V19 — migrate refuses when the enumeration FAILED
// ============================================================================

describe("V19 — a failed enumeration is NEVER treated as an empty keychain", () => {
	test("zero add-generic-password in any captured argv, and every id reported failed", () => {
		// Live items the file's stale copies must not overwrite.
		const store = new Map<string, string>([
			["openrouter", "kctest-or-LIVE-IN-KEYCHAIN"],
			["voyage", "kctest-voy-LIVE-IN-KEYCHAIN"],
		]);
		stub.setRun(fakeKeychain(store, { enumerationFails: true }));

		const report = migrateFileSecrets({
			openrouterApiKey: "kctest-or-STALE-IN-FILE",
			voyageApiKey: "kctest-voy-STALE-IN-FILE",
		});

		// Nothing written, anywhere.
		expect(stub.writes()).toHaveLength(0);
		for (const call of stub.calls) {
			expect(call.stdin ?? "").not.toContain("add-generic-password");
		}
		expect(store.get("openrouter")).toBe("kctest-or-LIVE-IN-KEYCHAIN");
		expect(store.get("voyage")).toBe("kctest-voy-LIVE-IN-KEYCHAIN");

		// And it says why, per id — not "nothing to do".
		expect(report.copied).toEqual([]);
		expect(report.failed.map((f) => f.id).sort()).toEqual([
			"openrouter",
			"voyage",
		]);
		for (const failure of report.failed) {
			expect(failure.reason).toContain("enumeration failed");
		}
	});

	test("the trigger is realistic: a dump that times out still lets writes through", () => {
		// M5's scenario — a login keychain slow enough to blow the enumeration
		// timeout is still fast enough to serve individual writes, so "it would have
		// failed anyway" is not a defence.
		const store = new Map<string, string>([["openrouter", "LIVE"]]);
		stub.setRun(fakeKeychain(store, { enumerationFails: true }));

		expect(enumerateStoredSecrets().failed).toBe(true);
		const report = migrateFileSecrets({ openrouterApiKey: "STALE" });
		expect(report.copied).toEqual([]);
		expect(store.get("openrouter")).toBe("LIVE");
	});
});

// ============================================================================
// migrate — never overwrites, proves absence per item
// ============================================================================

describe("migrate never overwrites a stored item from the file", () => {
	test("an id already in the dump is skipped", () => {
		const store = new Map<string, string>([["openrouter", "ALREADY-STORED"]]);
		stub.setRun(fakeKeychain(store));

		const report = migrateFileSecrets({
			openrouterApiKey: "kctest-or-FROM-FILE",
			voyageApiKey: "kctest-voy-FROM-FILE",
		});

		expect(report.skippedAlreadyStored).toEqual(["openrouter"]);
		expect(report.copied).toEqual(["voyage"]);
		expect(store.get("openrouter")).toBe("ALREADY-STORED");
		expect(store.get("voyage")).toBe("kctest-voy-FROM-FILE");
	});

	test("absence is proved PER ITEM, not just from the dump", () => {
		// The dump says the item is absent, but a per-id read finds it — a window the
		// dump-only path would drive straight through with `-U`.
		const store = new Map<string, string>();
		stub.setRun((call) => {
			if (call.args[0] === "dump-keychain") {
				return { code: 0, stdout: "", stderr: "" }; // an EMPTY, successful dump
			}
			if (call.args[0] === "find-generic-password") {
				return { code: 0, stdout: "APPEARED-SINCE-THE-DUMP\n", stderr: "" };
			}
			return fakeKeychain(store)(call);
		});

		const report = migrateFileSecrets({ openrouterApiKey: "FROM-FILE" });
		expect(report.skippedAlreadyStored).toEqual(["openrouter"]);
		expect(stub.writes()).toHaveLength(0);
	});

	test("the migrate write is CREATE-ONLY — `-U` is absent from the argv", () => {
		// Guards 1 and 2 are CHECKS, and a check has a window after it. `-U` upserts,
		// so anything that created the item between the per-id read and the write —
		// a second mnemex process, or the user in Keychain Access.app — was silently
		// replaced with the stale plaintext copy and reported as `copied`. Omitting
		// `-U` makes "never overwrite" a property of the operation instead.
		//
		// Asserted on the ARGV (here, the `-i` stdin command line the value rides on),
		// because that is the only place the flag exists.
		const store = new Map<string, string>();
		stub.setRun(fakeKeychain(store));

		migrateFileSecrets({ openrouterApiKey: "kctest-or-FROM-FILE" });

		const writes = stub.writes();
		expect(writes).toHaveLength(1);
		expect(writes[0].stdin).toContain("add-generic-password");
		expect(writes[0].stdin).not.toContain(" -U ");
		expect(store.get("openrouter")).toBe("kctest-or-FROM-FILE");
	});

	test("an ordinary save still upserts — create-only is migrate's rule, not everyone's", () => {
		// `persistSecrets` MUST be able to replace a key the user re-entered.
		const store = new Map<string, string>([["openrouter", "kctest-or-OLD"]]);
		stub.setRun(fakeKeychain(store));

		persistSecrets({ openrouterApiKey: "kctest-or-NEW" });

		const writes = stub.writes();
		expect(writes).toHaveLength(1);
		expect(writes[0].stdin).toContain(" -U ");
		expect(store.get("openrouter")).toBe("kctest-or-NEW");
	});

	test("a duplicate refusal is reported as SKIPPED, never as failed or copied", () => {
		// The window closing on us: the create-only write comes back with the
		// duplicate error. That is the outcome guard 2 exists to produce, arrived at
		// a few microseconds later — not a failure.
		const store = new Map<string, string>();
		stub.setRun((call) => {
			if (call.args[0] === "dump-keychain") {
				return { code: 0, stdout: "", stderr: "" };
			}
			if (call.args[0] === "find-generic-password") {
				return {
					code: 44,
					stdout: "",
					stderr:
						"security: The specified item could not be found in the keychain.",
				};
			}
			if (call.args[0] === "-i") {
				return {
					code: 45,
					stdout: "",
					stderr: "security: SecKeychainItemCreateFromContent: -25299",
				};
			}
			return fakeKeychain(store)(call);
		});

		const report = migrateFileSecrets({
			openrouterApiKey: "kctest-or-FROM-FILE",
		});
		expect(report.skippedAlreadyStored).toEqual(["openrouter"]);
		expect(report.failed).toEqual([]);
		expect(report.copied).toEqual([]);
	});

	test("a per-id read FAILURE is reported, never taken as absence", () => {
		stub.setRun((call) =>
			call.args[0] === "dump-keychain"
				? { code: 0, stdout: "", stderr: "" }
				: {
						code: 1,
						stdout: "",
						stderr: "security: SecKeychainUnlock: -25308",
					},
		);

		const report = migrateFileSecrets({ openrouterApiKey: "FROM-FILE" });
		expect(report.copied).toEqual([]);
		expect(report.failed[0]?.reason).toContain("absent");
		expect(stub.writes()).toHaveLength(0);
	});

	test("--dry-run writes nothing at all", () => {
		const store = new Map<string, string>();
		stub.setRun(fakeKeychain(store));

		const report = migrateFileSecrets(
			{ openrouterApiKey: "kctest-or-x" },
			{ dryRun: true },
		);

		expect(report.dryRun).toBe(true);
		expect(report.copied).toEqual(["openrouter"]);
		expect(stub.writes()).toHaveLength(0);
		expect(store.size).toBe(0);
	});

	test("a file with no plaintext keys costs ZERO spawns", () => {
		stub.setRun(() => {
			throw new Error("the keychain must not be reached");
		});
		const report = migrateFileSecrets({ defaultModel: "m" });
		expect(stub.calls).toHaveLength(0);
		expect(report.copied).toEqual([]);
	});

	test("migrate does not run off-darwin, and says so", () => {
		stub.setPlatform("linux");
		const report = migrateFileSecrets({ openrouterApiKey: "x" });
		expect(stub.calls).toHaveLength(0);
		expect(report.failed[0]?.reason).toContain("linux");
	});
});

// ============================================================================
// V23 — status costs exactly ONE spawn
// ============================================================================

describe("V23 — the inventory costs exactly one spawn", () => {
	test("enumerating every id is a single dump-keychain", () => {
		// `mnemex keychain status` renders from this one call and from the config
		// file; it never reads a value back. A status that is expensive will not be
		// run, and it exists to be run.
		stub.setRun(
			fakeKeychain(
				new Map([
					["openrouter", "a"],
					["voyage", "b"],
					["anthropic", "c"],
					["context7", "d"],
					["cloud", "e"],
					["ollama", "f"],
				]),
			),
		);

		const result = enumerateStoredSecrets();
		expect(result.ids).toHaveLength(6);
		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0]?.args[0]).toBe("dump-keychain");
	});
});

// ============================================================================
// prune — the two refusal classes
// ============================================================================

describe("prune", () => {
	test("costs 1 read per candidate and removes only the verified subset", () => {
		const store = new Map<string, string>([
			["openrouter", "MATCHES"],
			["voyage", "DIFFERS"],
		]);
		stub.setRun(fakeKeychain(store));

		const { report, fieldsToRemove } = pruneFileSecrets({
			openrouterApiKey: "MATCHES",
			voyageApiKey: "FILE-COPY",
		});

		expect(report.pruned).toEqual(["openrouter"]);
		expect(fieldsToRemove).toEqual(["openrouterApiKey"]);
		expect(report.refused[0]?.id).toBe("voyage");
		expect(report.aborted).toBe(false);
	});

	test("a read failure ABORTS everything and removes no field", () => {
		stub.setRun(() => ({
			code: 1,
			stdout: "",
			stderr: "security: SecKeychainUnlock: -25308",
		}));

		const { report, fieldsToRemove } = pruneFileSecrets({
			openrouterApiKey: "a",
			voyageApiKey: "b",
		});

		expect(report.aborted).toBe(true);
		expect(report.pruned).toEqual([]);
		expect(fieldsToRemove).toEqual([]);
		expect(report.refused).toHaveLength(2);
	});

	test("a mismatch names the remedy rather than sounding like corruption", () => {
		stub.setRun(fakeKeychain(new Map([["openrouter", "IN-KEYCHAIN"]])));
		const { report } = pruneFileSecrets({ openrouterApiKey: "IN-FILE" });

		const reason = report.refused[0]?.reason ?? "";
		expect(reason).toContain("keychain value");
		expect(reason).toContain("mnemex init");
	});

	test("prune with nothing to do costs ZERO spawns", () => {
		stub.setRun(() => {
			throw new Error("the keychain must not be reached");
		});
		const { report, fieldsToRemove } = pruneFileSecrets({ defaultModel: "m" });
		expect(stub.calls).toHaveLength(0);
		expect(report.pruned).toEqual([]);
		expect(fieldsToRemove).toEqual([]);
	});
});
