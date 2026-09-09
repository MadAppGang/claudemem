/**
 * Policy behaviour, through the injectable seam. NO TEST HERE SPAWNS ANYTHING.
 *
 * Covers V8, V9, V14, V15, V16 and V25, plus the design's own rows: the three
 * key-destruction sequences the incoming-only contract closes, and the
 * delete-side symmetry that stops the original defect being re-created pointing
 * the other way.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
	invalidateKeychainCache,
	KEYCHAIN_PROCESS_BUDGET_MS,
	setKeychainProcessBudgetUsedMs,
} from "../../../src/core/keychain.js";
import {
	enumerateStoredSecrets,
	hydrateSecrets,
	persistSecrets,
	primeSecrets,
	resolveSecret,
	resolveSecretBeforeHardExit,
	SECRET_SPECS,
	secretSpecForField,
	setKeychainConfigOptOut,
	setKeychainOptOutProvider,
	setSecretWarningSink,
} from "../../../src/core/secrets.js";
import {
	FAILURE,
	fakeKeychain,
	installKeychainStub,
	type KeychainStub,
	NOT_FOUND,
	OK,
	renderDump,
	uninstallKeychainStub,
} from "../../helpers/keychain-stub.js";

let stub: KeychainStub;
const ENV_KEYS = [
	"OPENROUTER_API_KEY",
	"VOYAGE_API_KEY",
	"ANTHROPIC_API_KEY",
	"CONTEXT7_API_KEY",
	"OLLAMA_API_KEY",
] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
	for (const key of ENV_KEYS) {
		savedEnv[key] = process.env[key];
		delete process.env[key];
	}
	stub = installKeychainStub();
	// Warnings are diagnostics, not output under test — buffer them.
	setSecretWarningSink(null);
});

afterEach(() => {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
	uninstallKeychainStub();
});

// ============================================================================
// The registry
// ============================================================================

describe("registry", () => {
	test("covers all six keys, and every label names its account", () => {
		expect(SECRET_SPECS.map((s) => s.id)).toEqual([
			"openrouter",
			"voyage",
			"anthropic",
			"context7",
			"cloud",
			"ollama",
		]);
		for (const spec of SECRET_SPECS) {
			// A label must never be mistakable for a lookup key.
			expect(spec.label).toContain(`account "${spec.account}"`);
		}
	});

	test("cloud has no env var and its label says so", () => {
		const cloud = SECRET_SPECS.find((s) => s.id === "cloud");
		expect(cloud?.envVar).toBeUndefined();
		// The old label advertised MNEMEX_CLOUD_API_KEY, which mnemex reads nowhere.
		expect(cloud?.label).not.toContain("MNEMEX_CLOUD_API_KEY");
		expect(cloud?.label).toContain("no env var");
	});

	test("secretSpecForField maps config fields back to ids", () => {
		expect(secretSpecForField("openrouterApiKey")?.id).toBe("openrouter");
		expect(secretSpecForField("ollamaApiKey")?.id).toBe("ollama");
		expect(secretSpecForField("llmEndpoint")).toBeUndefined();
	});
});

// ============================================================================
// V14 — resolution order
// ============================================================================

describe("V14 — resolution order is env > keychain > config", () => {
	test("env wins over both, at ZERO spawns", () => {
		process.env.OPENROUTER_API_KEY = "from-env";
		stub.setRun(() => OK("from-keychain\n"));

		expect(resolveSecret("openrouter", () => "from-config")).toBe("from-env");
		expect(stub.calls).toHaveLength(0);
	});

	test("keychain wins over config", () => {
		stub.setRun(() => OK("from-keychain\n"));
		expect(resolveSecret("openrouter", () => "from-config")).toBe(
			"from-keychain",
		);
	});

	test("config answers when nothing is stored", () => {
		stub.setRun(() => NOT_FOUND());
		expect(resolveSecret("openrouter", () => "from-config")).toBe(
			"from-config",
		);
	});

	test("an EMPTY env var does not win — truthiness, not nullishness", () => {
		process.env.OPENROUTER_API_KEY = "";
		stub.setRun(() => OK("from-keychain\n"));
		expect(resolveSecret("openrouter", () => "from-config")).toBe(
			"from-keychain",
		);
	});

	test("the config thunk is NOT invoked when the keychain answers", () => {
		stub.setRun(() => OK("from-keychain\n"));
		let called = 0;
		resolveSecret("openrouter", () => {
			called += 1;
			return "from-config";
		});
		expect(called).toBe(0);
	});

	test("a keychain FAILURE falls through to config — and warns exactly once", () => {
		stub.setRun(() => FAILURE("security: SecKeychainUnlock: -25308"));
		const warnings: string[] = [];
		setSecretWarningSink((m) => warnings.push(m));

		expect(resolveSecret("openrouter", () => "from-config")).toBe(
			"from-config",
		);
		expect(resolveSecret("openrouter", () => "from-config")).toBe(
			"from-config",
		);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("openrouter");
		// The diagnostic must never carry key material.
		expect(warnings[0]).not.toContain("from-config");
	});

	test("an ABSENCE is silent — only a failure is worth a diagnostic", () => {
		stub.setRun(() => NOT_FOUND());
		const warnings: string[] = [];
		setSecretWarningSink((m) => warnings.push(m));
		resolveSecret("openrouter", () => "from-config");
		expect(warnings).toHaveLength(0);
	});

	test("cloud starts at the keychain — it has no env var", () => {
		stub.setRun(() => OK("cloud-key\n"));
		expect(resolveSecret("cloud", () => "from-config")).toBe("cloud-key");
		expect(stub.calls[0]?.args).toContain("cloud");
	});
});

// ============================================================================
// V16 — the short account names still resolve
// ============================================================================

describe("V16 — existing short account names resolve, argv unchanged", () => {
	test("each id looks up its short account with -a <short name>", () => {
		const store = new Map<string, string>([
			["openrouter", "v-openrouter"],
			["voyage", "v-voyage"],
			["anthropic", "v-anthropic"],
			["context7", "v-context7"],
			["cloud", "v-cloud"],
		]);
		stub.setRun(fakeKeychain(store));

		for (const account of store.keys()) {
			const spec = SECRET_SPECS.find((s) => s.account === account);
			expect(spec).toBeDefined();
			expect(resolveSecret(spec?.id ?? "openrouter", () => undefined)).toBe(
				store.get(account),
			);
		}

		for (const call of stub.calls) {
			const i = call.args.indexOf("-a");
			expect(store.has(call.args[i + 1] ?? "")).toBe(true);
			// The service name has never been anything but "mnemex".
			expect(call.args).toContain("mnemex");
		}
	});
});

// ============================================================================
// V8 — a failed write keeps the key
// ============================================================================

describe("V8 — a failed keychain write does NOT drop the key", () => {
	test("the field survives in jsonSafe and is reported as kept", () => {
		stub.setRun((call) =>
			call.args[0] === "-i" ? FAILURE("security: ACL denied") : NOT_FOUND(),
		);

		const { jsonSafe, report } = persistSecrets({
			openrouterApiKey: "kctest-or-REAL-SECRET",
			defaultModel: "voyage-3.5-lite",
		});

		expect(jsonSafe.openrouterApiKey).toBe("kctest-or-REAL-SECRET");
		expect(jsonSafe.defaultModel).toBe("voyage-3.5-lite");
		expect(report.keptInConfigFile).toContain("openrouter");
		expect(report.storedInKeychain).toEqual([]);
		expect(report.anyFailed).toBe(true);
	});

	test("the first write failure stops the pass — a locked keychain is not paid per key", () => {
		stub.setRun((call) =>
			call.args[0] === "-i"
				? FAILURE("security: SecKeychainUnlock: -25308")
				: NOT_FOUND(),
		);

		const { jsonSafe, report } = persistSecrets({
			openrouterApiKey: "a",
			voyageApiKey: "b",
			anthropicApiKey: "c",
		});

		// One read + one failed write; nothing further attempted.
		expect(stub.writes()).toHaveLength(1);
		expect(jsonSafe.openrouterApiKey).toBe("a");
		expect(jsonSafe.voyageApiKey).toBe("b");
		expect(jsonSafe.anthropicApiKey).toBe("c");
		expect(report.keptInConfigFile).toEqual([
			"openrouter",
			"voyage",
			"anthropic",
		]);
	});
});

// ============================================================================
// V25 — exit 0 is not proof
// ============================================================================

describe("V25 — a write that does not round-trip leaves the key in the config file", () => {
	test("write exits 0, read-back differs -> field kept, disposition not 'keychain'", () => {
		let writes = 0;
		stub.setRun((call) => {
			if (call.args[0] === "-i") {
				writes += 1;
				return OK(); // exit 0 — but nothing was really stored
			}
			return writes === 0 ? NOT_FOUND() : OK("A-DIFFERENT-VALUE\n");
		});

		const { jsonSafe, report } = persistSecrets({
			openrouterApiKey: "kctest-or-INTENDED",
		});

		expect(jsonSafe.openrouterApiKey).toBe("kctest-or-INTENDED");
		const outcome = report.outcomes.find((o) => o.id === "openrouter");
		expect(outcome?.stored).toBe("config-file");
		expect(outcome?.reason).toContain("round-trip");
		expect(report.storedInKeychain).toEqual([]);
	});
});

// ============================================================================
// V9 — non-darwin keeps keys, with NO spawn attempted
// ============================================================================

describe("V9 — off-darwin the keys survive and nothing is spawned", () => {
	test("the exact input from the original defect evidence survives intact", () => {
		stub.setPlatform("linux");

		const { jsonSafe, report } = persistSecrets({
			openrouterApiKey: "kctest-or-REAL-SECRET",
			defaultModel: "voyage-3.5-lite",
		});

		// The old implementation wrote {"model":"voyage-3.5-lite"} and destroyed the key.
		expect(jsonSafe).toEqual({
			openrouterApiKey: "kctest-or-REAL-SECRET",
			defaultModel: "voyage-3.5-lite",
		});
		expect(stub.calls).toHaveLength(0);
		expect(report.outcomes[0]?.reason).toContain("linux");
	});

	test('"keychain": false in config.json opts out on the FIRST call', () => {
		// The persistent opt-out must be correct before anything has loaded the
		// config — a gate that only became true after some other code happened to
		// call loadGlobalConfig() would consult the keychain on the very first
		// getter, which is exactly the call the user opted out of.
		setKeychainOptOutProvider(() => true);
		try {
			const { jsonSafe, report } = persistSecrets({
				voyageApiKey: "kctest-voy-key",
			});
			expect(jsonSafe.voyageApiKey).toBe("kctest-voy-key");
			expect(stub.calls).toHaveLength(0);
			expect(report.outcomes[0]?.reason).toContain('"keychain": false');
			expect(resolveSecret("voyage", () => "from-config")).toBe("from-config");
			expect(stub.calls).toHaveLength(0);
		} finally {
			setKeychainOptOutProvider(null);
			setKeychainConfigOptOut(false);
		}
	});

	test("MNEMEX_DISABLE_KEYCHAIN=1 is a supported user-facing opt-out", () => {
		process.env.MNEMEX_DISABLE_KEYCHAIN = "1";
		try {
			const { jsonSafe, report } = persistSecrets({
				voyageApiKey: "kctest-voy-key",
			});
			expect(jsonSafe.voyageApiKey).toBe("kctest-voy-key");
			expect(stub.calls).toHaveLength(0);
			expect(report.outcomes[0]?.reason).toContain("MNEMEX_DISABLE_KEYCHAIN");
		} finally {
			process.env.MNEMEX_DISABLE_KEYCHAIN = "0";
		}
	});
});

// ============================================================================
// The incoming-only contract — the three key-destruction sequences
// ============================================================================

describe("persistSecrets takes INCOMING fields only (I2)", () => {
	test("a save carrying no secret NEVER touches the keychain", () => {
		stub.setRun(() => {
			throw new Error("the keychain must not be reached");
		});

		const { jsonSafe, report } = persistSecrets({
			llmEndpoint: "http://localhost:1234/v1",
		});

		expect(stub.calls).toHaveLength(0);
		expect(report.outcomes).toEqual([]);
		expect(jsonSafe.llmEndpoint).toBe("http://localhost:1234/v1");
	});

	test("the stale-overwrite sequence cannot occur", () => {
		// The keychain holds NEW (the user just edited it in Keychain Access.app);
		// config.json still holds OLD. A save of an unrelated field must not offer
		// OLD to the keychain.
		const store = new Map<string, string>([["openrouter", "NEW"]]);
		stub.setRun(fakeKeychain(store));

		persistSecrets({ llmEndpoint: "http://localhost:1234/v1" });

		expect(stub.writes()).toHaveLength(0);
		for (const call of stub.calls) {
			expect(call.stdin ?? "").not.toContain("add-generic-password");
		}
		expect(store.get("openrouter")).toBe("NEW");
	});

	test("a field present but undefined deletes nothing — from the keychain OR from jsonSafe (I4)", () => {
		// The name of this test used to be a claim about the FILE that the test never
		// checked, and the claim was false: `jsonSafe` kept the key at `undefined`,
		// `{...existing, ...jsonSafe}` overwrote the real value with it, and
		// `JSON.stringify` dropped the key — destroying a plaintext-only key with an
		// empty `outcomes` array (review A1).
		//
		// The keychain half is asserted here; the FILE half cannot be, because
		// `undefined` does not survive `JSON.stringify` into the child that owns the
		// on-disk assertions. It lives in
		// `test/unit/config/global-config-write.test.ts`, "A1 — an explicitly
		// undefined secret field is UNTOUCHED, not deleted", which drives it through
		// a job flag instead of a value. What this test CAN now prove is that
		// `jsonSafe` no longer carries the key at all, which is the mechanism.
		const store = new Map<string, string>([["openrouter", "STILL-HERE"]]);
		stub.setRun(fakeKeychain(store));

		const { jsonSafe, report } = persistSecrets({
			openrouterApiKey: undefined,
			defaultModel: "m",
		});
		expect(stub.calls).toHaveLength(0);
		expect(report.outcomes).toEqual([]);
		expect(store.get("openrouter")).toBe("STILL-HERE");
		// The key is GONE from the merge input, so the spread cannot delete it.
		expect(Object.hasOwn(jsonSafe, "openrouterApiKey")).toBe(false);
		expect(jsonSafe.defaultModel).toBe("m");
	});

	test("an unchanged secret costs no write at all", () => {
		const store = new Map<string, string>([["openrouter", "kctest-or-same"]]);
		stub.setRun(fakeKeychain(store));

		const { jsonSafe, report } = persistSecrets({
			openrouterApiKey: "kctest-or-same",
		});

		expect(stub.writes()).toHaveLength(0);
		expect(jsonSafe.openrouterApiKey).toBeUndefined();
		expect(report.storedInKeychain).toEqual(["openrouter"]);
	});

	test("a non-string value is left VERBATIM and never String()-coerced", () => {
		stub.setRun(() => {
			throw new Error("the keychain must not be reached");
		});
		const { jsonSafe, report } = persistSecrets({
			openrouterApiKey: null as unknown as string,
		});
		expect(jsonSafe.openrouterApiKey).toBeNull();
		expect(stub.calls).toHaveLength(0);
		expect(report.outcomes[0]?.reason).toBe("value is not a string");
	});

	test("a control-character value is rejected before any spawn", () => {
		stub.setRun(() => {
			throw new Error("the keychain must not be reached");
		});
		const { jsonSafe, report } = persistSecrets({
			openrouterApiKey: "kctest-or\nbad",
		});
		expect(jsonSafe.openrouterApiKey).toBe("kctest-or\nbad");
		expect(stub.calls).toHaveLength(0);
		expect(report.outcomes[0]?.reason).toContain("control characters");
	});
});

// ============================================================================
// I3 — clear symmetry
// ============================================================================

describe("I3 — a delete is only 'cleared' when it is CONFIRMED", () => {
	test("an explicit '' with a confirmed delete strips the field", () => {
		const store = new Map<string, string>([["openrouter", "old"]]);
		stub.setRun(fakeKeychain(store));

		const { jsonSafe, report } = persistSecrets({ openrouterApiKey: "" });
		expect(jsonSafe.openrouterApiKey).toBeUndefined();
		expect(report.outcomes[0]?.stored).toBe("cleared");
		expect(store.has("openrouter")).toBe(false);
	});

	test("exit 44 on delete IS confirmation — the item is already absent", () => {
		stub.setRun(() => NOT_FOUND());
		const { jsonSafe, report } = persistSecrets({ openrouterApiKey: "" });
		expect(jsonSafe.openrouterApiKey).toBeUndefined();
		expect(report.outcomes[0]?.stored).toBe("cleared");
	});

	test("a FAILED delete reports clear-failed and KEEPS the field", () => {
		stub.setRun(() => FAILURE("security: ACL denied"));
		const { jsonSafe, report } = persistSecrets({ openrouterApiKey: "" });

		expect(jsonSafe.openrouterApiKey).toBe("");
		expect(report.outcomes[0]?.stored).toBe("clear-failed");
		expect(report.outcomes[0]?.reason).toContain("may still resolve");
		expect(report.anyFailed).toBe(true);
		// It must NEVER say "cleared" while a resolvable item may survive.
		expect(report.outcomes.map((o) => o.stored)).not.toContain("cleared");
	});
});

// ============================================================================
// hydrateSecrets — keychain wins
// ============================================================================

describe("hydrateSecrets overlays the keychain OVER the file", () => {
	test("a stored value replaces a stale file value", () => {
		const store = new Map<string, string>([["openrouter", "FROM-KEYCHAIN"]]);
		stub.setRun(fakeKeychain(store));

		const hydrated = hydrateSecrets({
			openrouterApiKey: "STALE-FROM-FILE",
			voyageApiKey: "ONLY-IN-FILE",
		});

		// File-wins here would contradict resolution order, and for a
		// migrated-but-not-pruned user the wizard would show a key mnemex is not using.
		expect(hydrated.openrouterApiKey).toBe("FROM-KEYCHAIN");
		expect(hydrated.voyageApiKey).toBe("ONLY-IN-FILE");
	});

	test("a failed enumeration leaves the file values alone rather than blanking them", () => {
		stub.setRun(fakeKeychain(new Map(), { enumerationFails: true }));
		const hydrated = hydrateSecrets({ openrouterApiKey: "FROM-FILE" });
		expect(hydrated.openrouterApiKey).toBe("FROM-FILE");
	});
});

// ============================================================================
// enumerateStoredSecrets — unknown accounts surfaced, failures not collapsed
// ============================================================================

describe("enumerateStoredSecrets", () => {
	test("hand-created accounts are surfaced, not silently dropped", () => {
		stub.setRun(() => OK(renderDump(["openrouter", "OLLAMA_API_KEY"])));
		const result = enumerateStoredSecrets();
		expect(result.ids).toEqual(["openrouter"]);
		expect(result.unknownAccounts).toEqual(["OLLAMA_API_KEY"]);
		expect(result.failed).toBe(false);
	});

	test("a failure is never rendered as an empty store", () => {
		stub.setRun(fakeKeychain(new Map(), { enumerationFails: true }));
		const result = enumerateStoredSecrets();
		expect(result.failed).toBe(true);
		expect(result.ids).toEqual([]);
		expect(result.error).toBeDefined();
	});
});

// ============================================================================
// Session priming (M10) — empty on failure, never negatively populated
// ============================================================================

describe("primeSecrets", () => {
	test("primes stored ids and then answers at ZERO spawns", () => {
		const store = new Map<string, string>([["openrouter", "primed-value"]]);
		stub.setRun(fakeKeychain(store));

		const result = primeSecrets();
		expect(result.primed).toEqual(["openrouter"]);
		const spawnsAfterPriming = stub.calls.length;

		expect(resolveSecret("openrouter", () => undefined)).toBe("primed-value");
		// A successful dump proves absence for the rest, so they cost nothing either.
		expect(resolveSecret("voyage", () => "from-config")).toBe("from-config");
		expect(stub.calls).toHaveLength(spawnsAfterPriming);
	});

	test("a FAILED priming leaves the cache EMPTY, never negatively populated", () => {
		stub.setRun(fakeKeychain(new Map(), { enumerationFails: true }));
		const result = primeSecrets();
		expect(result.primed).toEqual([]);
		expect(result.failed).toBeDefined();

		// A negatively populated cache would make the server permanently believe
		// nothing is stored, forever. An empty one merely falls through to the normal
		// read path — where the burst latch and the breaker bound the cost — and
		// recovers as soon as the keychain answers again.
		invalidateKeychainCache(); // a later burst
		const before = stub.calls.length;
		stub.setRun(fakeKeychain(new Map([["openrouter", "now-readable"]])));
		expect(resolveSecret("openrouter", () => undefined)).toBe("now-readable");
		expect(stub.calls.length).toBeGreaterThan(before);
	});
});

// ============================================================================
// The one re-ask before a hard exit
// ============================================================================

describe("resolveSecretBeforeHardExit", () => {
	test("clears the cache AND the process budget, then re-resolves once", () => {
		// First read fails and is latched; then the budget is spent.
		stub.setRun(() => FAILURE("security: SecKeychainUnlock: -25308"));
		expect(resolveSecret("openrouter", () => undefined)).toBeUndefined();
		setKeychainProcessBudgetUsedMs(KEYCHAIN_PROCESS_BUDGET_MS);

		// Without clearing the budget the re-ask could not spawn at all, and the one
		// mechanism between a transient failure and process.exit(1) would be a
		// silent no-op.
		stub.setRun(() => OK("recovered-key\n"));
		const result = resolveSecretBeforeHardExit("openrouter", () => undefined);
		expect(result.value).toBe("recovered-key");
		expect(result.keychainFailure).toBeUndefined();
	});

	test("reports the keychain reason when the re-ask also fails", () => {
		stub.setRun(() => FAILURE("security: SecKeychainUnlock: -25308"));
		const result = resolveSecretBeforeHardExit("openrouter", () => undefined);
		expect(result.value).toBeUndefined();
		expect(result.keychainFailure).toContain("-25308");
	});
});

// ============================================================================
// V15 — the policy layer writes to stdout zero times
// ============================================================================

describe("V15 — the policy layer never writes to stdout", () => {
	test("across resolve, persist, hydrate and enumerate, including failures", () => {
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
			() => true,
		);
		const logSpy = spyOn(console, "log").mockImplementation(() => {});
		const errSpy = spyOn(console, "error").mockImplementation(() => {});
		setSecretWarningSink(console.error);

		try {
			stub.setRun(() => FAILURE("security: SecKeychainUnlock: -25308"));
			resolveSecret("openrouter", () => "cfg");
			persistSecrets({ voyageApiKey: "v" });
			hydrateSecrets({ anthropicApiKey: "a" });
			enumerateStoredSecrets();

			expect(stdoutSpy).not.toHaveBeenCalled();
			expect(logSpy).not.toHaveBeenCalled();
			// stderr, through the sink, IS allowed — and is where diagnostics belong.
			expect(errSpy).toHaveBeenCalled();
		} finally {
			stdoutSpy.mockRestore();
			logSpy.mockRestore();
			errSpy.mockRestore();
		}
	});
});
