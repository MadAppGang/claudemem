/**
 * Black-box tests for the file-backed paths in src/config.ts: saveGlobalConfig,
 * loadGlobalConfig, loadGlobalConfigWithSecrets and the five getters.
 *
 * EVERY scenario runs in a SPAWNED CHILD whose HOME is a fresh temp directory (see
 * helpers/child-runner.ts, which refuses to run unless os.homedir() agrees). The parent
 * asserts on the BYTES the child read back from disk — never on the report alone.
 *
 * Derived from F3, F8, F9, N1, N2, N5 and rows V5, V6, V8, V9, V13, V14, V17, V18, V20,
 * V21, V24, V25.
 */
import { describe, expect, test } from "bun:test";
import { argvLeaks } from "./helpers/fake-keychain.js";
import { runChildScenario } from "./helpers/spawn.js";

/**
 * This file spawns children that call saveGlobalConfig. The sandbox declaration is
 * supplied HERE, by the caller, and forwarded into each child's env, where
 * test/helpers/sandbox-guard.ts refuses to run unless os.homedir() agrees with it.
 */
const SANDBOX_DECLARATION = "MNEMEX_TEST_SANDBOX_HOME";

const OLD = "kctest-or-OLD-plaintext-0001-TAILaaaa";
const NEW = "kctest-or-NEW-incoming-9999-TAILbbbb";
const KC = "kctest-or-FROM-keychain-5555-TAILcccc";

function json(r: {
	after: { json?: Record<string, unknown> | null };
}): Record<string, unknown> {
	expect(r.after.json).not.toBeNull();
	return r.after.json as Record<string, unknown>;
}

function noLeaks(
	r: {
		calls: Parameters<typeof argvLeaks>[0];
		captured: { stdout: string; stderr: string };
		realSpawns: number;
	},
	...secrets: string[]
) {
	expect(r.realSpawns).toBe(0);
	for (const s of secrets) {
		expect(argvLeaks(r.calls, s)).toEqual([]);
		expect(r.captured.stdout).not.toContain(s);
		expect(r.captured.stderr).not.toContain(s);
	}
}

describe("saveGlobalConfig — what actually lands on disk", () => {
	test("V17/V20/F7: verified write removes the field from the FILE and tightens 0644 -> 0600", () => {
		const r = runChildScenario("save", {
			sandboxDeclaration: SANDBOX_DECLARATION,
			existing: { openrouterApiKey: OLD, model: "m" },
			existingMode: 0o644,
			incoming: { openrouterApiKey: NEW },
		});
		expect(r.fatal).toBeUndefined();
		expect(r.before?.mode).toBe("644");
		const j = json(r);
		expect("openrouterApiKey" in j).toBe(false);
		expect(r.after.text).not.toContain(OLD);
		expect(r.after.text).not.toContain(NEW);
		expect(j.model).toBe("m");
		expect(r.after.mode).toBe("600");
		expect(r.store.openrouter).toBe(NEW);
		noLeaks(r, OLD, NEW);
	}, 60_000);

	test("V18/V8: failed write leaves the INCOMING value in the file, not the stale one", () => {
		const r = runChildScenario("save", {
			sandboxDeclaration: SANDBOX_DECLARATION,
			existing: { openrouterApiKey: OLD, model: "m" },
			existingMode: 0o644,
			incoming: { openrouterApiKey: NEW },
			fake: { failWrite: true },
		});
		expect(r.fatal).toBeUndefined();
		const j = json(r);
		expect(j.openrouterApiKey).toBe(NEW);
		expect(j.model).toBe("m");
		expect(r.after.mode).toBe("600");
		expect(r.store.openrouter).toBeUndefined();
		noLeaks(r, OLD, NEW);
	}, 60_000);

	test("V25: exit 0 without round-trip keeps the incoming value in the file", () => {
		const r = runChildScenario("save", {
			sandboxDeclaration: SANDBOX_DECLARATION,
			existing: { openrouterApiKey: OLD },
			incoming: { openrouterApiKey: NEW },
			fake: { writeExit0ButDrop: true },
		});
		expect(r.fatal).toBeUndefined();
		expect(json(r).openrouterApiKey).toBe(NEW);
		const rep = r.report as { storedInKeychain: string[] } | undefined;
		expect(rep?.storedInKeychain ?? []).not.toContain("openrouter");
		noLeaks(r, OLD, NEW);
	}, 60_000);

	test("V9/N5: on linux the key is written to the file and the seam is never called", () => {
		const r = runChildScenario("save", {
			sandboxDeclaration: SANDBOX_DECLARATION,
			existing: { model: "m" },
			incoming: { openrouterApiKey: NEW, ollamaApiKey: "oll-1111" },
			fake: { platform: "linux" },
		});
		expect(r.fatal).toBeUndefined();
		const j = json(r);
		expect(j.openrouterApiKey).toBe(NEW);
		expect(j.ollamaApiKey).toBe("oll-1111");
		expect(r.calls.length).toBe(0);
		expect(r.after.mode).toBe("600");
	}, 60_000);

	test("opt-out MNEMEX_DISABLE_KEYCHAIN=1: key stays in the file, zero seam calls", () => {
		const r = runChildScenario("save", {
			sandboxDeclaration: SANDBOX_DECLARATION,
			incoming: { openrouterApiKey: NEW },
			keepDisabled: true,
		});
		expect(r.fatal).toBeUndefined();
		expect(json(r).openrouterApiKey).toBe(NEW);
		expect(r.calls.length).toBe(0);
	}, 60_000);

	test("F9: a freshly CREATED config holding a secret is 0600", () => {
		const r = runChildScenario("save", {
			sandboxDeclaration: SANDBOX_DECLARATION,
			incoming: { openrouterApiKey: NEW },
			fake: { failWrite: true },
		});
		expect(r.fatal).toBeUndefined();
		expect(json(r).openrouterApiKey).toBe(NEW);
		expect(r.after.mode).toBe("600");
	}, 60_000);

	test("clearing with '' deletes the item and removes the field from the file", () => {
		const r = runChildScenario("save", {
			sandboxDeclaration: SANDBOX_DECLARATION,
			existing: { openrouterApiKey: OLD, model: "m" },
			incoming: { openrouterApiKey: "" },
			fake: { store: { openrouter: OLD } },
		});
		expect(r.fatal).toBeUndefined();
		const j = json(r);
		expect("openrouterApiKey" in j).toBe(false);
		expect(j.model).toBe("m");
		expect(r.store.openrouter).toBeUndefined();
		expect(
			r.calls.some(
				(c) =>
					c.args[0] === "delete-generic-password" ||
					/delete-generic-password/.test(c.stdin ?? ""),
			),
		).toBe(true);
		noLeaks(r, OLD);
	}, 60_000);

	test("V24: an unconfirmed delete keeps the field in the file", () => {
		const r = runChildScenario("save", {
			sandboxDeclaration: SANDBOX_DECLARATION,
			existing: { openrouterApiKey: OLD, model: "m" },
			incoming: { openrouterApiKey: "" },
			fake: { store: { openrouter: OLD }, failDelete: true },
		});
		expect(r.fatal).toBeUndefined();
		const j = json(r);
		expect("openrouterApiKey" in j).toBe(true);
		expect(r.store.openrouter).toBe(OLD);
		noLeaks(r, OLD);
	}, 60_000);

	test("C2: a save carrying no secret makes ZERO seam calls and leaves the plaintext key as-is", () => {
		const r = runChildScenario("save", {
			sandboxDeclaration: SANDBOX_DECLARATION,
			existing: { openrouterApiKey: OLD, model: "m" },
			incoming: { model: "changed" },
			fake: { store: { openrouter: KC } },
		});
		expect(r.fatal).toBeUndefined();
		const j = json(r);
		expect(j.openrouterApiKey).toBe(OLD);
		expect(j.model).toBe("changed");
		expect(r.calls.length).toBe(0);
	}, 60_000);

	test("an explicit undefined does not delete an existing plaintext key", () => {
		const r = runChildScenario("save", {
			sandboxDeclaration: SANDBOX_DECLARATION,
			existing: { openrouterApiKey: OLD, model: "m" },
			incoming: { model: "changed" },
			incomingUndefinedFields: ["openrouterApiKey"],
		});
		expect(r.fatal).toBeUndefined();
		const j = json(r);
		expect(j.openrouterApiKey).toBe(OLD);
		expect(j.model).toBe("changed");
		expect(r.calls.length).toBe(0);
	}, 60_000);

	test("V21: an unparseable config.json is preserved as a .corrupt-* sibling, bytes intact", () => {
		const garbage =
			'{"openrouterApiKey":"kctest-or-TRUNCATED-ffff","model":"m"';
		const r = runChildScenario("save", {
			sandboxDeclaration: SANDBOX_DECLARATION,
			existing: garbage,
			incoming: { model: "x" },
		});
		const corrupt = Object.entries(r.dir).find(([name]) =>
			/config\.json\.corrupt/.test(name),
		);
		expect(corrupt).toBeDefined();
		expect(corrupt?.[1]).toBe(garbage);
	}, 60_000);
});

describe("resolution through the real getters (F3 / V14 / V5 / V6 / V13)", () => {
	const cases: {
		getter: string;
		envVar: string;
		account: string;
		field: string;
	}[] = [
		{
			getter: "openrouter",
			envVar: "OPENROUTER_API_KEY",
			account: "openrouter",
			field: "openrouterApiKey",
		},
		{
			getter: "voyage",
			envVar: "VOYAGE_API_KEY",
			account: "voyage",
			field: "voyageApiKey",
		},
		{
			getter: "anthropic",
			envVar: "ANTHROPIC_API_KEY",
			account: "anthropic",
			field: "anthropicApiKey",
		},
		{
			getter: "context7",
			envVar: "CONTEXT7_API_KEY",
			account: "context7",
			field: "context7ApiKey",
		},
		{
			getter: "ollama",
			envVar: "OLLAMA_API_KEY",
			account: "ollama",
			field: "ollamaApiKey",
		},
	];

	for (const c of cases) {
		test(`${c.getter}: env > keychain > config; empty env loses; cold <= 1 spawn, warm = 0`, () => {
			const r = runChildScenario("resolve", {
				sandboxDeclaration: SANDBOX_DECLARATION,
				getter: c.getter,
				envVar: c.envVar,
				existing: { [c.field]: "cfg-value" },
				fake: { store: { [c.account]: "kc-value" } },
				env: { [c.envVar]: "env-value" },
			});
			expect(r.fatal).toBeUndefined();
			const s = r.stages ?? {};
			expect(s.envSet?.value).toBe("env-value");
			expect(s.envEmpty?.value).toBe("kc-value");
			expect(s.keychain?.cold).toBe("kc-value");
			expect(s.keychain?.coldCalls).toBeLessThanOrEqual(1);
			expect(s.keychain?.warm).toBe("kc-value");
			expect(s.keychain?.warmCalls).toBe(0);
			expect(s.file?.value).toBe("cfg-value");
			expect(r.realSpawns).toBe(0);
		}, 60_000);
	}

	test("ENV exposes OLLAMA_API_KEY", () => {
		const r = runChildScenario("resolve", {
			sandboxDeclaration: SANDBOX_DECLARATION,
			getter: "ollama",
			envVar: "OLLAMA_API_KEY",
			existing: {},
			env: { OLLAMA_API_KEY: "x" },
		});
		expect(r.ENV?.OLLAMA_API_KEY).toBe("OLLAMA_API_KEY");
	}, 60_000);
});

describe("loadGlobalConfig vs loadGlobalConfigWithSecrets", () => {
	test("loadGlobalConfig is spawn-free and returns the file value; WithSecrets overlays the keychain", () => {
		const r = runChildScenario("load", {
			sandboxDeclaration: SANDBOX_DECLARATION,
			field: "openrouterApiKey",
			existing: { openrouterApiKey: OLD },
			fake: { store: { openrouter: KC } },
		});
		expect(r.fatal).toBeUndefined();
		expect(r.loadCalls).toBe(0);
		expect(r.loadValue).toBe(OLD);
		expect(r.hydratedValue).toBe(KC);
	}, 60_000);

	test("a keychain-sourced value is NEVER written to the file, even when the save cannot re-verify it", () => {
		const r = runChildScenario("load", {
			sandboxDeclaration: SANDBOX_DECLARATION,
			field: "openrouterApiKey",
			existing: { model: "m" },
			fake: { store: { openrouter: KC } },
			thenSaveHydratedWith: { model: "changed" },
			failWriteOnSave: true,
		});
		expect(r.fatal).toBeUndefined();
		expect(r.hydratedValue).toBe(KC);
		expect(r.after.text ?? "").not.toContain(KC);
		expect(json(r).model).toBe("changed");
		noLeaks(r, KC);
	}, 60_000);

	test("…and when the file already had a plaintext copy, that copy is not replaced by the keychain value", () => {
		const r = runChildScenario("load", {
			sandboxDeclaration: SANDBOX_DECLARATION,
			field: "openrouterApiKey",
			existing: { openrouterApiKey: OLD, model: "m" },
			fake: { store: { openrouter: KC } },
			thenSaveHydratedWith: { model: "changed" },
			failWriteOnSave: true,
		});
		expect(r.fatal).toBeUndefined();
		expect(r.after.text ?? "").not.toContain(KC);
		expect(json(r).model).toBe("changed");
	}, 60_000);
});
