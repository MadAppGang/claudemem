/**
 * Black-box tests for the secrets POLICY layer (src/core/secrets.ts) via its public API.
 * Derived from F2, F3, F6, F8, N1, N2, N5 and rows V5, V6, V10-V14, V16, V25.
 *
 * Nothing here touches a file: `resolveSecret` takes a thunk, `persistSecrets` returns
 * `jsonSafe`, and the file-backed paths live in config-file.test.ts (sandboxed children).
 *
 * The bun preload sets MNEMEX_DISABLE_KEYCHAIN=1 in this process. We lift it per test AFTER
 * the fake seam is installed, and restore it in afterEach.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as kc from "../../src/core/keychain.js";
import * as sec from "../../src/core/secrets.js";
import {
	argvLeaks,
	createFakeKeychain,
	type FakeKeychain,
	type FakeKeychainOptions,
} from "./helpers/fake-keychain.js";

const SECRET = "kctest-or-POLICY-secret-2b8d-TAIL5678";
const IDS: sec.SecretId[] = [
	"openrouter",
	"voyage",
	"anthropic",
	"context7",
	"cloud",
	"ollama",
];
const ENV_VARS = [
	"OPENROUTER_API_KEY",
	"VOYAGE_API_KEY",
	"ANTHROPIC_API_KEY",
	"CONTEXT7_API_KEY",
	"OLLAMA_API_KEY",
];

let fake: FakeKeychain;
let warnings: string[] = [];
const savedEnv: Record<string, string | undefined> = {};

function install(opts: FakeKeychainOptions = {}): FakeKeychain {
	fake = createFakeKeychain(opts);
	kc.setKeychainTestDeps(fake.deps);
	kc.invalidateKeychainCache();
	kc.resetKeychainBreaker();
	kc.resetKeychainProcessBudget();
	sec.invalidateSecretSessionCache();
	sec.resetSecretWarnings();
	sec.resetSecretProvenance();
	sec.resetHardExitReask();
	return fake;
}

function invalidateAll() {
	kc.invalidateKeychainCache();
	sec.invalidateSecretSessionCache();
}

beforeEach(() => {
	for (const v of [...ENV_VARS, "MNEMEX_DISABLE_KEYCHAIN"]) {
		savedEnv[v] = process.env[v];
		delete process.env[v];
	}
	warnings = [];
	sec.setSecretWarningSink((m) => warnings.push(m));
	install();
});

afterEach(() => {
	kc.setKeychainTestDeps(null);
	sec.setSecretWarningSink(null);
	for (const [k, v] of Object.entries(savedEnv)) {
		if (v === undefined) delete process.env[k];
		else process.env[k] = v;
	}
	// Belt and braces: the preload's opt-out is back on for anything that runs after us.
	process.env.MNEMEX_DISABLE_KEYCHAIN = "1";
	expect(kc.realKeychainSpawnCount()).toBe(0);
});

describe("F2 — the registry covers every LLM key including OLLAMA_API_KEY", () => {
	test("six ids with their env vars and config fields", () => {
		expect(sec.SECRET_SPECS.map((s) => s.id).sort()).toEqual([...IDS].sort());
		const byId = Object.fromEntries(sec.SECRET_SPECS.map((s) => [s.id, s]));
		expect(byId.openrouter.envVar).toBe("OPENROUTER_API_KEY");
		expect(byId.voyage.envVar).toBe("VOYAGE_API_KEY");
		expect(byId.anthropic.envVar).toBe("ANTHROPIC_API_KEY");
		expect(byId.context7.envVar).toBe("CONTEXT7_API_KEY");
		expect(byId.ollama.envVar).toBe("OLLAMA_API_KEY");
		expect(byId.cloud.envVar).toBeUndefined();
		expect(byId.ollama.configField).toBe("ollamaApiKey");
		expect(sec.secretSpecById("ollama").account.length).toBeGreaterThan(0);
		expect(sec.secretSpecForField("ollamaApiKey")?.id).toBe("ollama");
		expect(sec.secretSpecForField("openrouterApiKey")?.id).toBe("openrouter");
		expect(sec.secretSpecForField("model")).toBeUndefined();
	});

	test("every spec has a distinct keychain account", () => {
		const accounts = sec.SECRET_SPECS.map((s) => s.account);
		expect(new Set(accounts).size).toBe(accounts.length);
	});
});

describe("backend enablement", () => {
	test("enabled on darwin with no opt-out", () => {
		expect(sec.isSecretsBackendEnabled()).toBe(true);
		expect(sec.secretsBackendStatus().enabled).toBe(true);
	});

	test("MNEMEX_DISABLE_KEYCHAIN=1 disables with a reason that names the variable, and spawns nothing", () => {
		process.env.MNEMEX_DISABLE_KEYCHAIN = "1";
		invalidateAll();
		const s = sec.secretsBackendStatus();
		expect(s.enabled).toBe(false);
		expect(s.reason ?? "").toContain("MNEMEX_DISABLE_KEYCHAIN");
		install({ store: { openrouter: SECRET } });
		const r = sec.readSecret("openrouter");
		expect(r.status).not.toBe("found");
		expect(fake.calls.length).toBe(0);
	});

	test("non-darwin disables with a reason and spawns nothing (N5)", () => {
		install({ platform: "linux", store: { openrouter: SECRET } });
		const s = sec.secretsBackendStatus();
		expect(s.enabled).toBe(false);
		expect(typeof s.reason).toBe("string");
		expect(sec.readSecret("openrouter").status).not.toBe("found");
		expect(sec.resolveSecret("openrouter", () => "cfg")).toBe("cfg");
		expect(fake.calls.length).toBe(0);
	});
});

describe("F6 — readSecret distinguishes found / absent / failed", () => {
	test("found", () => {
		install({ store: { openrouter: SECRET } });
		expect(sec.readSecret("openrouter")).toEqual({
			status: "found",
			value: SECRET,
		});
	});
	test("absent (exit 44)", () => {
		expect(sec.readSecret("openrouter")).toEqual({ status: "absent" });
	});
	test("failed (non-44) carries an error string without the secret", () => {
		install({ failRead: true });
		const r = sec.readSecret("openrouter");
		expect(r.status).toBe("failed");
		if (r.status === "failed") expect(r.error.length).toBeGreaterThan(0);
	});
});

describe("F3 / V14 — resolution order env > keychain > config, first NON-EMPTY wins", () => {
	test("env wins, and neither the keychain nor the config thunk is consulted", () => {
		install({ store: { openrouter: "kc-value" } });
		process.env.OPENROUTER_API_KEY = "env-value";
		let thunkCalled = false;
		const v = sec.resolveSecret("openrouter", () => {
			thunkCalled = true;
			return "cfg-value";
		});
		expect(v).toBe("env-value");
		expect(thunkCalled).toBe(false);
		expect(fake.calls.length).toBe(0);
	});

	test("an EMPTY env var does not win", () => {
		install({ store: { openrouter: "kc-value" } });
		process.env.OPENROUTER_API_KEY = "";
		expect(sec.resolveSecret("openrouter", () => "cfg-value")).toBe("kc-value");
	});

	test("keychain wins over config, and the config thunk is not invoked", () => {
		install({ store: { openrouter: "kc-value" } });
		let thunkCalled = false;
		expect(
			sec.resolveSecret("openrouter", () => {
				thunkCalled = true;
				return "cfg-value";
			}),
		).toBe("kc-value");
		expect(thunkCalled).toBe(false);
	});

	test("config is the last resort when env is unset and the keychain has nothing", () => {
		expect(sec.resolveSecret("openrouter", () => "cfg-value")).toBe(
			"cfg-value",
		);
		expect(sec.resolveSecret("voyage")).toBeUndefined();
		expect(sec.resolveSecret("anthropic", () => undefined)).toBeUndefined();
	});

	test("a keychain FAILURE still falls through to config, and no warning leaks the value", () => {
		install({ failRead: "locked" });
		expect(sec.resolveSecret("openrouter", () => SECRET)).toBe(SECRET);
		for (const w of [...warnings, ...sec.getPendingSecretWarnings()]) {
			expect(w).not.toContain(SECRET);
		}
	});

	test("the same order holds for OLLAMA_API_KEY (D7)", () => {
		install({ store: { ollama: "kc-ollama" } });
		process.env.OLLAMA_API_KEY = "env-ollama";
		expect(sec.resolveSecret("ollama", () => "cfg-ollama")).toBe("env-ollama");
		delete process.env.OLLAMA_API_KEY;
		invalidateAll();
		expect(sec.resolveSecret("ollama", () => "cfg-ollama")).toBe("kc-ollama");
		fake.store.clear();
		invalidateAll();
		expect(sec.resolveSecret("ollama", () => "cfg-ollama")).toBe("cfg-ollama");
	});
});

describe("N1 / V5 / V6 — spawn cost of resolution", () => {
	test("cold resolve costs at most one spawn; warm resolve costs zero", () => {
		install({ store: { openrouter: SECRET } });
		expect(sec.resolveSecret("openrouter")).toBe(SECRET);
		const cold = fake.calls.length;
		expect(cold).toBeLessThanOrEqual(1);
		expect(sec.resolveSecret("openrouter")).toBe(SECRET);
		expect(sec.resolveSecret("openrouter")).toBe(SECRET);
		expect(fake.calls.length).toBe(cold);
	});

	test("resolving all six ids cold costs at most one spawn each", () => {
		install({
			store: Object.fromEntries(
				IDS.map((id) => [sec.secretSpecById(id).account, `v-${id}`]),
			),
		});
		for (const id of IDS) expect(sec.resolveSecret(id)).toBe(`v-${id}`);
		expect(fake.calls.length).toBeLessThanOrEqual(IDS.length);
	});

	test("V12: one lock failure, six ids, ONE spawn", () => {
		install({ failRead: "locked" });
		for (const id of IDS)
			expect(sec.resolveSecret(id, () => "cfg")).toBe("cfg");
		expect(fake.calls.length).toBe(1);
	});

	test("resolveSecretBeforeHardExit re-asks exactly once with the cache cleared", () => {
		install({ failRead: "locked" });
		sec.resolveSecret("openrouter");
		const before = fake.calls.length;
		const r = sec.resolveSecretBeforeHardExit("openrouter", () => undefined);
		expect(fake.calls.length).toBe(before + 1);
		expect(r.value).toBeUndefined();
		expect(typeof r.keychainFailure).toBe("string");
	});
});

describe("F5 — enumerateStoredSecrets", () => {
	test("maps every stored account to its id in one spawn and surfaces unknown accounts", () => {
		install({
			store: {
				...Object.fromEntries(
					IDS.map((id) => [sec.secretSpecById(id).account, "x"]),
				),
				"legacy-thing": "y",
			},
			foreignItems: [{ service: "other", account: "foreign" }],
		});
		const e = sec.enumerateStoredSecrets();
		expect(e.failed).toBe(false);
		expect([...e.ids].sort()).toEqual([...IDS].sort());
		expect(e.unknownAccounts).toEqual(["legacy-thing"]);
		expect(fake.calls.length).toBe(1);
	});

	test("a failed enumeration is reported as failed, with no ids", () => {
		install({ failDump: true, store: { openrouter: "x" } });
		const e = sec.enumerateStoredSecrets();
		expect(e.failed).toBe(true);
		expect(e.ids).toEqual([]);
		expect(typeof e.error).toBe("string");
	});
});

describe("persistSecrets — the field leaves jsonSafe IFF the keychain provably holds the value", () => {
	const NEW = "kctest-or-NEW-value-9f9f-TAIL9999";

	function persist(incoming: Record<string, unknown>) {
		return sec.persistSecrets(
			incoming as Partial<import("../../src/types.js").GlobalConfig>,
		);
	}

	function assertInvariant(
		jsonSafe: Record<string, unknown>,
		account: string,
		value: string,
	) {
		const omitted = !("openrouterApiKey" in jsonSafe);
		const held = fake.store.get(account) === value;
		expect({ omitted, held }).toEqual({ omitted: held, held });
	}

	test("verified write: field omitted, disposition keychain, store holds value, argv clean", () => {
		const { jsonSafe, report } = persist({ openrouterApiKey: NEW, model: "m" });
		expect(fake.store.get("openrouter")).toBe(NEW);
		expect("openrouterApiKey" in jsonSafe).toBe(false);
		expect(jsonSafe.model).toBe("m");
		expect(report.storedInKeychain).toContain("openrouter");
		expect(report.anyFailed).toBe(false);
		expect(argvLeaks(fake.calls, NEW)).toEqual([]);
		assertInvariant(jsonSafe as Record<string, unknown>, "openrouter", NEW);
	});

	test("failed write: field kept, disposition config-file with a reason, anyFailed", () => {
		install({ failWrite: true });
		const { jsonSafe, report } = persist({ openrouterApiKey: NEW });
		expect(jsonSafe.openrouterApiKey).toBe(NEW);
		const o = report.outcomes.find((x) => x.id === "openrouter");
		expect(o?.stored).toBe("config-file");
		expect(typeof o?.reason).toBe("string");
		expect(o?.reason ?? "").not.toContain(NEW);
		expect(report.anyFailed).toBe(true);
		expect(report.keptInConfigFile).toContain("openrouter");
		assertInvariant(jsonSafe as Record<string, unknown>, "openrouter", NEW);
	});

	test("V25: exit 0 without round-trip: field kept, disposition is NOT keychain", () => {
		install({ writeExit0ButDrop: true });
		const { jsonSafe, report } = persist({ openrouterApiKey: NEW });
		expect(jsonSafe.openrouterApiKey).toBe(NEW);
		expect(report.outcomes.find((x) => x.id === "openrouter")?.stored).not.toBe(
			"keychain",
		);
		expect(report.storedInKeychain).not.toContain("openrouter");
		assertInvariant(jsonSafe as Record<string, unknown>, "openrouter", NEW);
	});

	test("V9: non-darwin keeps the field and spawns nothing", () => {
		install({ platform: "linux" });
		const { jsonSafe, report } = persist({ openrouterApiKey: NEW });
		expect(jsonSafe.openrouterApiKey).toBe(NEW);
		expect(fake.calls.length).toBe(0);
		expect(report.storedInKeychain).toEqual([]);
	});

	test("opt-out (MNEMEX_DISABLE_KEYCHAIN=1) keeps the field and spawns nothing", () => {
		process.env.MNEMEX_DISABLE_KEYCHAIN = "1";
		invalidateAll();
		const { jsonSafe } = persist({ openrouterApiKey: NEW });
		expect(jsonSafe.openrouterApiKey).toBe(NEW);
		expect(fake.calls.length).toBe(0);
	});

	test("mixed batch: one id verified, one failed — decided per field", () => {
		install({ failWriteAccounts: ["voyage"] });
		const { jsonSafe, report } = persist({
			openrouterApiKey: NEW,
			voyageApiKey: "kctest-voy-VOY-1111",
		});
		expect("openrouterApiKey" in jsonSafe).toBe(false);
		expect(jsonSafe.voyageApiKey).toBe("kctest-voy-VOY-1111");
		expect(report.storedInKeychain).toEqual(["openrouter"]);
		expect(report.keptInConfigFile).toEqual(["voyage"]);
		expect(argvLeaks(fake.calls, "kctest-voy-VOY-1111")).toEqual([]);
	});

	test("empty string clears: delete confirmed -> disposition cleared, item gone", () => {
		install({ store: { openrouter: SECRET } });
		const { report } = persist({ openrouterApiKey: "" });
		expect(fake.store.has("openrouter")).toBe(false);
		expect(report.outcomes.find((x) => x.id === "openrouter")?.stored).toBe(
			"cleared",
		);
		expect(fake.deleteCalls().length).toBeGreaterThanOrEqual(1);
	});

	test("empty string when already absent (exit 44) is still 'cleared'", () => {
		const { report } = persist({ openrouterApiKey: "" });
		expect(report.outcomes.find((x) => x.id === "openrouter")?.stored).toBe(
			"cleared",
		);
	});

	test("V24: a delete that is not confirmed reports clear-failed and KEEPS the field", () => {
		install({ store: { openrouter: SECRET }, failDelete: true });
		const { jsonSafe, report } = persist({ openrouterApiKey: "" });
		expect(report.outcomes.find((x) => x.id === "openrouter")?.stored).toBe(
			"clear-failed",
		);
		expect("openrouterApiKey" in jsonSafe).toBe(true);
		expect(report.anyFailed).toBe(true);
	});

	test("incoming-only: a save with no secret makes ZERO seam calls", () => {
		const { report } = persist({
			model: "x",
			llmEndpoint: "http://localhost:11434",
		});
		expect(fake.calls.length).toBe(0);
		expect(report.outcomes).toEqual([]);
	});

	test("an explicit undefined is UNTOUCHED: no seam call, no outcome", () => {
		const { report } = persist({ openrouterApiKey: undefined });
		expect(fake.calls.length).toBe(0);
		expect(report.outcomes.find((x) => x.id === "openrouter")).toBeUndefined();
	});

	test("N2: no report string ever carries the secret", () => {
		install({ failWrite: true });
		const { report } = persist({
			openrouterApiKey: NEW,
			ollamaApiKey: "oll-SECRET-4444",
		});
		const text = JSON.stringify(report);
		expect(text).not.toContain(NEW);
		expect(text).not.toContain("oll-SECRET-4444");
	});
});

describe("hydrateSecrets — keychain values overlay the file, never the reverse", () => {
	test("keychain value replaces the file value; other fields untouched", () => {
		install({ store: { openrouter: "kc-value" } });
		const h = sec.hydrateSecrets({
			openrouterApiKey: "file-value",
			model: "m",
		});
		expect(h.openrouterApiKey).toBe("kc-value");
		expect(h.model).toBe("m");
		expect(h.voyageApiKey).toBeUndefined();
	});

	test("on keychain failure the file value survives", () => {
		install({ failRead: true });
		const h = sec.hydrateSecrets({ openrouterApiKey: "file-value" });
		expect(h.openrouterApiKey).toBe("file-value");
	});
});

describe("deleteStoredSecret", () => {
	test("deletes the item by id and reports true; argv is clean", () => {
		install({ store: { ollama: SECRET } });
		expect(sec.deleteStoredSecret("ollama")).toBe(true);
		expect(fake.store.has("ollama")).toBe(false);
		expect(argvLeaks(fake.calls, SECRET)).toEqual([]);
	});
	test("absent item reports false", () => {
		expect(sec.deleteStoredSecret("ollama")).toBe(false);
	});
	test("a real failure throws", () => {
		install({ store: { ollama: SECRET }, failDelete: true });
		expect(() => sec.deleteStoredSecret("ollama")).toThrow();
	});
});
