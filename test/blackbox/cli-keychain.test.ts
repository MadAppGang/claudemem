/**
 * Black-box tests for the `mnemex keychain` command group (requirements section 8, F10,
 * rows V19, V22, V23, N2). Each test spawns `src/index.ts` in a sandboxed child with the fake
 * seam installed by `bun --preload` (helpers/cli-preload.ts). The child arrives with
 * MNEMEX_KEYCHAIN_TEST_GUARD=1 and MNEMEX_DISABLE_KEYCHAIN=1; the preload lifts the latter
 * only after the stub is in place.
 *
 * Assertions are on: the recorded seam calls, the fake store's final contents, and the bytes
 * of config.json after the command — plus the command's stdout for naming/refusal.
 */
import { describe, expect, test } from "bun:test";
import { argvLeaks } from "./helpers/fake-keychain.js";
import { kvLines, runKeychainCli } from "./helpers/spawn.js";

/**
 * `prune` rewrites config.json inside the child. The sandbox declaration is supplied HERE,
 * by the caller, and forwarded into each child's env, where test/helpers/sandbox-guard.ts
 * refuses to run unless os.homedir() agrees with it.
 */
const SANDBOX_DECLARATION = "MNEMEX_TEST_SANDBOX_HOME";

const FILE_OR = "kctest-or-FILE-openrouter-1111-TAILqqqq";
const FILE_VOY = "kctest-voy-FILE-voyage-2222-TAILwwww";
const KC_VOY_DIFF = "kctest-voy-KEYCHAIN-voyage-DIFFERENT-3333";

const T = 90_000;

function isWrite(c: { args: string[]; stdin?: string }) {
	return (
		c.args.includes("-i") ||
		c.args.includes("add-generic-password") ||
		/add-generic-password/.test(c.stdin ?? "")
	);
}

describe("mnemex keychain (bare) and status", () => {
	test(
		"bare `keychain` lists the four subcommands and the six ids",
		() => {
			const r = runKeychainCli([], { sandboxDeclaration: SANDBOX_DECLARATION });
			expect(r.stdout).toContain("status");
			expect(r.stdout).toContain("migrate");
			expect(r.stdout).toContain("prune");
			expect(r.stdout).toContain("rm");
			for (const id of [
				"openrouter",
				"voyage",
				"anthropic",
				"context7",
				"cloud",
				"ollama",
			]) {
				expect(r.stdout).toContain(id);
			}
		},
		T,
	);

	test(
		"V23: status costs exactly ONE seam call, reports file/keychain per id, leaks nothing",
		() => {
			const r = runKeychainCli(["status"], {
				sandboxDeclaration: SANDBOX_DECLARATION,
				existing: { openrouterApiKey: FILE_OR, model: "m" },
				existingMode: 0o644,
				fake: { store: { voyage: KC_VOY_DIFF } },
			});
			expect(r.exitCode).toBe(0);
			expect(r.calls.length).toBe(1);
			const kv = kvLines(r.stdout);
			expect(kv.get("backend_enabled")).toBe("true");
			expect(kv.get("config_file_mode")).toBe("0644");
			const s = kv.secrets();
			expect(s.openrouter?.config_file).toBe("true");
			expect(s.openrouter?.keychain).toBe("false");
			expect(s.voyage?.keychain).toBe("true");
			expect(s.voyage?.config_file).toBe("false");
			expect(s.anthropic?.keychain).toBe("false");
			expect(r.stdout).not.toContain(FILE_OR);
			expect(r.stdout).not.toContain(KC_VOY_DIFF);
			expect(r.stderr).not.toContain(FILE_OR);
			// status is read-only: the file is byte-identical and its mode untouched
			expect(r.after.text).toBe(r.before.text);
			expect(r.realSpawns).toBe(0);
		},
		T,
	);

	test(
		"status with the backend opted out: disabled with a reason, zero seam calls, keychain=unknown (not false)",
		() => {
			const r = runKeychainCli(["status"], {
				sandboxDeclaration: SANDBOX_DECLARATION,
				existing: { openrouterApiKey: FILE_OR },
				fake: { store: { openrouter: FILE_OR } },
				keepDisabled: true,
			});
			const kv = kvLines(r.stdout);
			expect(kv.get("backend_enabled")).toBe("false");
			expect(kv.get("backend_reason") ?? "").toContain(
				"MNEMEX_DISABLE_KEYCHAIN",
			);
			expect(r.calls.length).toBe(0);
			expect(kv.secrets().openrouter?.keychain).toBe("unknown");
		},
		T,
	);

	test(
		"status on linux: disabled, zero seam calls",
		() => {
			const r = runKeychainCli(["status"], {
				sandboxDeclaration: SANDBOX_DECLARATION,
				fake: { platform: "linux" },
			});
			expect(kvLines(r.stdout).get("backend_enabled")).toBe("false");
			expect(r.calls.length).toBe(0);
		},
		T,
	);

	test(
		"F6 at the CLI: a failed enumeration is 'unknown', never 'false'",
		() => {
			const r = runKeychainCli(["status"], {
				sandboxDeclaration: SANDBOX_DECLARATION,
				existing: { openrouterApiKey: FILE_OR },
				fake: { failDump: true, failRead: true },
			});
			const kv = kvLines(r.stdout);
			const s = kv.secrets();
			for (const id of Object.keys(s)) {
				expect(s[id].keychain).not.toBe("false");
			}
			expect(kv.get("keychain_readable")).toBe("false");
		},
		T,
	);
});

describe("mnemex keychain migrate", () => {
	const seeded = {
		openrouterApiKey: FILE_OR,
		voyageApiKey: FILE_VOY,
		model: "m",
	};

	test(
		"--dry-run writes nothing to the keychain and leaves the file byte-identical",
		() => {
			const r = runKeychainCli(["migrate", "--dry-run"], {
				sandboxDeclaration: SANDBOX_DECLARATION,
				existing: seeded,
				fake: { store: { voyage: KC_VOY_DIFF } },
			});
			expect(r.calls.filter(isWrite)).toEqual([]);
			expect(r.store).toEqual({ voyage: KC_VOY_DIFF });
			expect(r.after.text).toBe(r.before.text);
			expect(r.stdout).not.toContain(FILE_OR);
		},
		T,
	);

	test(
		"copies only ids with NO existing item, verifies the round-trip, never overwrites, retains the file copy",
		() => {
			const r = runKeychainCli(["migrate"], {
				sandboxDeclaration: SANDBOX_DECLARATION,
				existing: seeded,
				fake: { store: { voyage: KC_VOY_DIFF } },
			});
			expect(r.exitCode).toBe(0);
			expect(r.store.openrouter).toBe(FILE_OR);
			expect(r.store.voyage).toBe(KC_VOY_DIFF);
			expect(argvLeaks(r.calls, FILE_OR)).toEqual([]);
			expect(argvLeaks(r.calls, FILE_VOY)).toEqual([]);
			// round-trip verification: a read of openrouter after its write
			const wi = r.calls.findIndex(isWrite);
			expect(wi).toBeGreaterThanOrEqual(0);
			expect(
				r.calls.findIndex(
					(c, i) =>
						i > wi &&
						c.args[0] === "find-generic-password" &&
						c.args.includes("openrouter"),
				),
			).toBeGreaterThan(wi);
			// file copy deliberately retained
			expect(r.after.json?.openrouterApiKey).toBe(FILE_OR);
			expect(r.after.json?.voyageApiKey).toBe(FILE_VOY);
			expect(r.after.json?.model).toBe("m");
			expect(r.stdout.toLowerCase()).toContain("voyage");
			expect(r.stdout).not.toContain(FILE_OR);
			expect(r.stdout).not.toContain(FILE_VOY);
		},
		T,
	);

	test(
		"V19: refuses entirely when enumeration FAILED — no write, file unchanged, non-zero exit",
		() => {
			const r = runKeychainCli(["migrate"], {
				sandboxDeclaration: SANDBOX_DECLARATION,
				existing: seeded,
				fake: { store: { voyage: KC_VOY_DIFF }, failDump: true },
			});
			expect(r.calls.filter(isWrite)).toEqual([]);
			expect(r.store).toEqual({ voyage: KC_VOY_DIFF });
			expect(r.after.text).toBe(r.before.text);
			expect(r.exitCode).not.toBe(0);
		},
		T,
	);

	test(
		"a write that fails leaves the file copy in place and reports the id",
		() => {
			const r = runKeychainCli(["migrate"], {
				sandboxDeclaration: SANDBOX_DECLARATION,
				existing: seeded,
				fake: { failWrite: true },
			});
			expect(r.store).toEqual({});
			expect(r.after.json?.openrouterApiKey).toBe(FILE_OR);
			expect(r.after.json?.voyageApiKey).toBe(FILE_VOY);
			expect(r.stdout.toLowerCase()).toContain("openrouter");
			expect(r.stdout).not.toContain(FILE_OR);
		},
		T,
	);
});

describe("mnemex keychain prune", () => {
	const seeded = {
		openrouterApiKey: FILE_OR,
		voyageApiKey: FILE_VOY,
		model: "m",
	};

	test(
		"V22: removes only ids that re-verify byte-identical; refuses and NAMES the one that differs",
		() => {
			const r = runKeychainCli(["prune"], {
				sandboxDeclaration: SANDBOX_DECLARATION,
				existing: seeded,
				existingMode: 0o644,
				fake: { store: { openrouter: FILE_OR, voyage: KC_VOY_DIFF } },
			});
			const j = r.after.json ?? {};
			expect("openrouterApiKey" in j).toBe(false);
			expect(j.voyageApiKey).toBe(FILE_VOY);
			expect(j.model).toBe("m");
			expect(r.after.mode).toBe("600");
			expect(r.stdout.toLowerCase()).toContain("voyage");
			expect(r.calls.filter(isWrite)).toEqual([]);
			expect(r.stdout).not.toContain(FILE_VOY);
			expect(r.stdout).not.toContain(FILE_OR);
			expect(r.store).toEqual({ openrouter: FILE_OR, voyage: KC_VOY_DIFF });
		},
		T,
	);

	test(
		"prune with a failing read removes NOTHING",
		() => {
			const r = runKeychainCli(["prune"], {
				sandboxDeclaration: SANDBOX_DECLARATION,
				existing: seeded,
				fake: {
					store: { openrouter: FILE_OR, voyage: FILE_VOY },
					failRead: true,
				},
			});
			expect(r.after.json?.openrouterApiKey).toBe(FILE_OR);
			expect(r.after.json?.voyageApiKey).toBe(FILE_VOY);
		},
		T,
	);

	test(
		"prune decides per id by READ-BACK, not by enumeration: with enumeration failing, a byte-identical id is pruned, a differing id survives and is named",
		() => {
			const r = runKeychainCli(["prune"], {
				sandboxDeclaration: SANDBOX_DECLARATION,
				existing: seeded,
				fake: {
					store: { openrouter: FILE_OR, voyage: KC_VOY_DIFF },
					failDump: true,
				},
			});
			const j = r.after.json ?? {};
			// openrouter re-verified byte-identical -> pruned; and that verification was a
			// per-id read, present in the seam record.
			expect("openrouterApiKey" in j).toBe(false);
			expect(
				r.calls.some(
					(c) =>
						c.args[0] === "find-generic-password" &&
						c.args.includes("openrouter"),
				),
			).toBe(true);
			// voyage did not re-verify -> its plaintext copy survives and it is named.
			expect(j.voyageApiKey).toBe(FILE_VOY);
			expect(r.stdout.toLowerCase()).toContain("voyage");
			// A failed enumeration alone removed nothing that was not verified per id.
			expect(j.model).toBe("m");
			expect(r.calls.filter(isWrite)).toEqual([]);
			expect(r.store).toEqual({ openrouter: FILE_OR, voyage: KC_VOY_DIFF });
			expect(r.stdout).not.toContain(FILE_OR);
			expect(r.stdout).not.toContain(FILE_VOY);
		},
		T,
	);

	test(
		"prune never deletes the last copy: an id absent from the keychain stays in the file",
		() => {
			const r = runKeychainCli(["prune"], {
				sandboxDeclaration: SANDBOX_DECLARATION,
				existing: seeded,
				fake: { store: {} },
			});
			expect(r.after.json?.openrouterApiKey).toBe(FILE_OR);
			expect(r.after.json?.voyageApiKey).toBe(FILE_VOY);
		},
		T,
	);
});

describe("mnemex keychain rm <id>", () => {
	test(
		"deletes exactly one item by its internal account; the file is not the target",
		() => {
			const r = runKeychainCli(["rm", "openrouter"], {
				sandboxDeclaration: SANDBOX_DECLARATION,
				existing: { openrouterApiKey: FILE_OR, model: "m" },
				fake: { store: { openrouter: FILE_OR, voyage: FILE_VOY } },
			});
			expect(r.exitCode).toBe(0);
			expect(r.store).toEqual({ voyage: FILE_VOY });
			const d = r.calls.find(
				(c) =>
					c.args[0] === "delete-generic-password" ||
					/delete-generic-password/.test(c.stdin ?? ""),
			);
			expect(d).toBeDefined();
			expect(d?.args.join(" ") + (d?.stdin ?? "")).toContain("openrouter");
			expect(argvLeaks(r.calls, FILE_OR)).toEqual([]);
			expect(r.after.json?.model).toBe("m");
			expect(r.stdout).not.toContain(FILE_OR);
		},
		T,
	);

	test(
		"rejects an unknown id without touching the keychain",
		() => {
			const r = runKeychainCli(["rm", "not-a-real-id"], {
				sandboxDeclaration: SANDBOX_DECLARATION,
				fake: { store: { openrouter: FILE_OR } },
			});
			expect(r.exitCode).not.toBe(0);
			expect(
				r.calls.filter(
					(c) =>
						c.args[0] === "delete-generic-password" ||
						/delete-generic-password/.test(c.stdin ?? ""),
				),
			).toEqual([]);
			expect(r.store).toEqual({ openrouter: FILE_OR });
		},
		T,
	);

	test(
		"a delete that is not confirmed does not claim success",
		() => {
			const r = runKeychainCli(["rm", "openrouter"], {
				sandboxDeclaration: SANDBOX_DECLARATION,
				existing: { openrouterApiKey: FILE_OR },
				fake: { store: { openrouter: FILE_OR }, failDelete: true },
			});
			expect(r.exitCode).not.toBe(0);
			expect(r.store).toEqual({ openrouter: FILE_OR });
		},
		T,
	);
});
