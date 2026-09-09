/**
 * `mnemex keychain` — the command itself, not the machinery under it.
 *
 * The group had ZERO tests. Three separate reviewers named consequences of that,
 * and every one is user-visible:
 *
 *  - The N7 last-copy guard — the refusal when deleting the only remaining copy
 *    of a key — was a binding review finding with no executable evidence at all.
 *    Deleting the `if (!hasFileCopy && !force)` block did not fail the suite.
 *  - V23's row claimed "count seam invocations across a full status render"; the
 *    test claiming it called `enumerateStoredSecrets()` and never rendered status.
 *    A status that did an extra per-id read would have passed.
 *  - `--agent` was ignored entirely (CLAUDE.md #14), and a migration that reported
 *    every key as FAILED still exited 0.
 *
 * Everything runs in a CHILD process with `HOME` in a temp directory, for the same
 * reason `global-config-write.test.ts` does, and the child refuses to start unless
 * it can prove it is sandboxed. NOTHING HERE SPAWNS `security`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHILD = join(import.meta.dir, "../../helpers/keychain-cli-child.ts");

let home: string;
let configDir: string;
let configPath: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "mnemex-kc-"));
	configDir = join(home, ".mnemex");
	configPath = join(configDir, "config.json");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

interface ChildResult {
	exitCode?: number;
	error?: string;
	stdout: string;
	stderr: string;
	seamCalls: string[];
	storedAfter: Record<string, string>;
	file: string | null;
	mode: string | null;
}

function runChild(job: Record<string, unknown>): ChildResult {
	const proc = Bun.spawnSync({
		cmd: ["bun", "run", CHILD, JSON.stringify(job)],
		env: {
			...process.env,
			HOME: home,
			MNEMEX_TEST_SANDBOX_HOME: home,
			MNEMEX_KEYCHAIN_TEST_GUARD: "1",
			MNEMEX_DISABLE_KEYCHAIN: "0",
		},
		stdout: "pipe",
		stderr: "pipe",
	});

	const raw = proc.stdout.toString();
	const marker = raw.indexOf("__RESULT__");
	if (marker < 0) {
		throw new Error(
			`child produced no result.\nstdout: ${raw}\nstderr: ${proc.stderr.toString()}`,
		);
	}
	return JSON.parse(raw.slice(marker + "__RESULT__".length));
}

function seed(content: Record<string, unknown>, mode = 0o644): void {
	mkdirSync(configDir, { recursive: true });
	writeFileSync(configPath, JSON.stringify(content, null, 2), "utf-8");
	chmodSync(configPath, mode);
}

/** Every `key=value` line, as a map. Repeated keys keep the last. */
function parseAgentLines(stdout: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const line of stdout.split("\n")) {
		if (!line) continue;
		const eq = line.indexOf("=");
		if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
	}
	return out;
}

// ============================================================================
// rm — the N7 last-copy guard
// ============================================================================

describe("rm — the last-copy guard (N7)", () => {
	test("refuses, exits 1 and leaves the item when no plaintext copy remains", () => {
		// The state after a completed migrate + prune: the Keychain item is the ONLY
		// copy. This is the whole point of the feature, so deleting it by accident
		// must be impossible.
		seed({ defaultModel: "m" });

		const result = runChild({
			args: ["rm", "openrouter"],
			stored: { openrouter: "kctest-or-ONLY-COPY" },
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("error=last_copy");
		// THE ITEM SURVIVES — the assertion the refusal exists for.
		expect(result.storedAfter.openrouter).toBe("kctest-or-ONLY-COPY");
		// And nothing was even attempted at the seam.
		expect(result.seamCalls).not.toContain("delete-generic-password");
	});

	test("--force deletes it", () => {
		seed({ defaultModel: "m" });

		const result = runChild({
			args: ["rm", "openrouter", "--force"],
			stored: { openrouter: "kctest-or-ONLY-COPY" },
		});

		expect(result.exitCode).toBe(0);
		expect(result.storedAfter.openrouter).toBeUndefined();
	});

	test("no --force needed when a plaintext copy remains", () => {
		seed({ openrouterApiKey: "kctest-or-STILL-IN-FILE" });

		const result = runChild({
			args: ["rm", "openrouter"],
			stored: { openrouter: "kctest-or-STILL-IN-FILE" },
		});

		expect(result.exitCode).toBe(0);
		expect(result.storedAfter.openrouter).toBeUndefined();
	});

	test("an unknown id exits 1 and touches nothing", () => {
		seed({ defaultModel: "m" });
		const result = runChild({
			args: ["rm", "nope"],
			stored: { openrouter: "kctest-or-x" },
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("error=unknown_id");
		expect(result.seamCalls).toEqual([]);
	});

	test("a failed delete exits 1 and says the item may still resolve", () => {
		seed({ openrouterApiKey: "kctest-or-x" });
		const result = runChild({
			args: ["rm", "openrouter"],
			stored: { openrouter: "kctest-or-x" },
			failDeletes: true,
		});
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("error=delete_failed");
		expect(result.storedAfter.openrouter).toBe("kctest-or-x");
	});
});

// ============================================================================
// status — cost, masking, and the unknown/absent distinction
// ============================================================================

describe("status", () => {
	test("costs EXACTLY one seam invocation, and it is the dump", () => {
		// V23's row, actually exercised through the render this time. A status
		// command that is expensive will not be run, and this one exists to be run.
		seed({ openrouterApiKey: "kctest-or-abcdefghijkl", defaultModel: "m" });

		const result = runChild({
			args: ["status"],
			stored: {
				openrouter: "kctest-or-abcdefghijkl",
				voyage: "kctest-voy-xyz",
			},
		});

		expect(result.seamCalls).toEqual(["dump-keychain"]);
	});

	test("no unmasked secret reaches stdout", () => {
		const secret = "kctest-or-SUPER-SECRET-abcdefgh";
		seed({ openrouterApiKey: secret });

		const result = runChild({
			args: ["status"],
			stored: { openrouter: secret },
		});

		expect(result.stdout).not.toContain(secret);
		expect(result.stderr).not.toContain(secret);
		// The mask reveals the last four characters and nothing more.
		expect(result.stdout).toContain("efgh");
		expect(result.stdout).not.toContain("SUPER-SECRET");
	});

	test("a failed enumeration renders UNKNOWN, never `not configured`", () => {
		// "I could not ask" and "there is nothing there" must not collapse — the
		// same distinction the three-way `KeychainRead` exists for, one layer up.
		seed({ defaultModel: "m" });

		const result = runChild({
			args: ["status"],
			stored: { openrouter: "kctest-or-x" },
			enumerationFails: true,
		});

		expect(result.stdout).toContain("Keychain could not be read");
		expect(result.stdout).toContain("keychain: unknown");
		expect(result.stdout).not.toContain("not configured");
	});

	test("--agent emits key=value lines only", () => {
		seed({ openrouterApiKey: "kctest-or-abcdefghijkl" });

		const result = runChild({
			args: ["status"],
			agent: true,
			stored: { voyage: "kctest-voy-xyz" },
		});

		// CLAUDE.md #14: every non-empty stdout line must parse as key=value or as a
		// `prefix k=v k=v` record. No headings, no prose, no blank-line padding.
		for (const line of result.stdout.split("\n")) {
			expect(line).toMatch(/^[a-z_]+[= ]/);
		}
		const fields = parseAgentLines(result.stdout);
		expect(fields.backend_enabled).toBe("true");
		expect(fields.keychain_readable).toBe("true");
		expect(result.stdout).toContain(
			"secret id=openrouter keychain=false config_file=true",
		);
		expect(result.stdout).toContain(
			"secret id=voyage keychain=true config_file=false",
		);
		expect(fields.migratable).toBe("1");
	});

	test("--agent reports keychain=unknown when the dump fails", () => {
		seed({ openrouterApiKey: "kctest-or-x" });

		const result = runChild({
			args: ["status"],
			agent: true,
			enumerationFails: true,
		});

		expect(parseAgentLines(result.stdout).keychain_readable).toBe("false");
		expect(result.stdout).toContain("keychain=unknown");
		expect(result.stdout).not.toContain("keychain=false");
	});
});

// ============================================================================
// migrate — mode hardening and exit status
// ============================================================================

describe("migrate", () => {
	test("tightens the 0644 file to 0600 WITHOUT changing its contents", () => {
		// The verified starting state for every user upgrading from <= 0.32.0. The
		// plaintext copies stay on purpose; leaving them world-readable for the whole
		// validation interval was not on purpose (CWE-732).
		const before = { openrouterApiKey: "kctest-or-x", defaultModel: "m" };
		seed(before, 0o644);

		const result = runChild({ args: ["migrate"] });

		expect(result.exitCode).toBe(0);
		expect(result.mode).toBe("600");
		expect(JSON.parse(result.file ?? "{}")).toEqual(before);
		expect(result.storedAfter.openrouter).toBe("kctest-or-x");
	});

	test("a dry run writes nothing and does not touch the mode", () => {
		seed({ openrouterApiKey: "kctest-or-x" }, 0o644);

		const result = runChild({ args: ["migrate", "--dry-run"] });

		expect(result.exitCode).toBe(0);
		expect(result.mode).toBe("644");
		expect(result.storedAfter.openrouter).toBeUndefined();
	});

	test("a failed migration exits 1 rather than 0", () => {
		seed({ openrouterApiKey: "kctest-or-x" }, 0o644);

		const result = runChild({ args: ["migrate"], failWrites: true });

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toContain("FAILED");
		// The plaintext copy is untouched, so nothing was lost.
		expect(JSON.parse(result.file ?? "{}").openrouterApiKey).toBe(
			"kctest-or-x",
		);
	});

	test("an existing item is SKIPPED, never overwritten, via a create-only write", () => {
		// The write omits `-U`, so `security` refuses to replace rather than the code
		// deciding not to. The fake returns exit 45 for that case.
		seed({ openrouterApiKey: "kctest-or-STALE-IN-FILE" }, 0o644);

		const result = runChild({
			args: ["migrate"],
			stored: { openrouter: "kctest-or-LIVE-IN-KEYCHAIN" },
		});

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("skipped: openrouter");
		expect(result.storedAfter.openrouter).toBe("kctest-or-LIVE-IN-KEYCHAIN");
	});

	test("--agent emits key=value lines and the exit code", () => {
		seed({ openrouterApiKey: "kctest-or-x" }, 0o644);

		const result = runChild({ args: ["migrate"], agent: true });

		for (const line of result.stdout.split("\n")) {
			expect(line).toMatch(/^[a-z_]+[= ]/);
		}
		const fields = parseAgentLines(result.stdout);
		expect(fields.copied).toBe("openrouter");
		expect(fields.failed_count).toBe("0");
		expect(fields.config_file_mode).toBe("0600");
		expect(fields.config_file_hardened).toBe("true");
		expect(fields.exit_code).toBe("0");
	});
});

// ============================================================================
// prune — exit status
// ============================================================================

describe("prune", () => {
	test("an abort exits 1 and removes nothing", () => {
		seed({ openrouterApiKey: "kctest-or-x" });

		const result = runChild({
			args: ["prune"],
			enumerationFails: true,
			platform: "linux", // backend disabled -> the abort path, with no spawns
		});

		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.file ?? "{}").openrouterApiKey).toBe(
			"kctest-or-x",
		);
	});

	test("a verified key is pruned and exits 0", () => {
		seed({ openrouterApiKey: "kctest-or-x" });

		const result = runChild({
			args: ["prune"],
			stored: { openrouter: "kctest-or-x" },
		});

		expect(result.exitCode).toBe(0);
		expect(JSON.parse(result.file ?? "{}")).not.toHaveProperty(
			"openrouterApiKey",
		);
		expect(result.storedAfter.openrouter).toBe("kctest-or-x");
	});

	test("a refusal exits 1 and leaves that key alone", () => {
		seed({ openrouterApiKey: "kctest-or-IN-FILE" });

		const result = runChild({
			args: ["prune"],
			stored: { openrouter: "kctest-or-DIFFERENT-IN-KEYCHAIN" },
		});

		expect(result.exitCode).toBe(1);
		expect(JSON.parse(result.file ?? "{}").openrouterApiKey).toBe(
			"kctest-or-IN-FILE",
		);
	});

	test("--agent emits key=value lines", () => {
		seed({ openrouterApiKey: "kctest-or-x" });

		const result = runChild({
			args: ["prune"],
			agent: true,
			stored: { openrouter: "kctest-or-x" },
		});

		for (const line of result.stdout.split("\n")) {
			expect(line).toMatch(/^[a-z_]+[= ]/);
		}
		const fields = parseAgentLines(result.stdout);
		expect(fields.pruned).toBe("openrouter");
		expect(fields.pruned_count).toBe("1");
		expect(fields.exit_code).toBe("0");
	});
});

// ============================================================================
// dispatch
// ============================================================================

describe("dispatch", () => {
	test("an unknown subcommand exits 1 and writes NOTHING to stdout", () => {
		// An agent parsing stdout must see an empty result, not prose it will try to
		// read as data.
		seed({ defaultModel: "m" });

		const result = runChild({ args: ["frobnicate"], agent: true });

		expect(result.exitCode).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("error=unknown_subcommand");
	});

	test("help exits 0 and is machine-readable under --agent", () => {
		seed({ defaultModel: "m" });

		const result = runChild({ args: ["help"], agent: true });

		expect(result.exitCode).toBe(0);
		for (const line of result.stdout.split("\n")) {
			expect(line).toMatch(/^[a-z_]+=/);
		}
	});
});

// ============================================================================
// Strict flags — the `--dry-runDD` incident
// ============================================================================

describe("strict flags (a typo must not become the destructive default)", () => {
	// THE INCIDENT, reproduced. On a real machine, one day after this feature
	// shipped, `keychain migrate --dry-runDD` was typed. `args.includes("--dry-run")`
	// was false, so the command did not fail — it ran a REAL migration and wrote two
	// items. Shell history and the keychain `cdat` agree to the second.
	//
	// The assertion that matters is not the exit code. It is that NOTHING was
	// written: a boolean flag parsed by membership turns every typo of it into the
	// opposite of what was typed, and here the opposite was "write to the keychain".
	test("migrate --dry-runDD refuses and writes NOTHING", () => {
		seed({ voyageApiKey: "kctest-voy-VOYAGE", context7ApiKey: "ctx-SEVEN" });

		const result = runChild({ args: ["migrate", "--dry-runDD"], stored: {} });

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("error=unknown_flag");
		expect(result.stderr).toContain("subcommand=migrate");
		expect(result.stderr).toContain("Did you mean --dry-run?");
		// The property. Not "reported a dry run" — nothing reached the keychain.
		expect(result.storedAfter).toEqual({});
		expect(result.seamCalls).toEqual([]);
		// And stdout carries no result an agent could misread as a completed run.
		expect(result.stdout).toBe("");
	});

	test("the refusal happens BEFORE the credential lock", () => {
		// A refusal that took the lock first would let a typo block a concurrent
		// save. Nothing at the seam is the evidence: the lock is taken outside the
		// subcommand, and every subcommand under it touches the seam.
		seed({ voyageApiKey: "kctest-voy-VOYAGE" });

		const result = runChild({ args: ["migrate", "--dyr-run"], stored: {} });

		expect(result.exitCode).toBe(1);
		expect(result.seamCalls).toEqual([]);
	});

	test("migrate --dry-run still previews", () => {
		// The over-rejection guard. A strict check that rejects the CORRECT flag
		// would pass every assertion above and break the command.
		seed({ voyageApiKey: "kctest-voy-VOYAGE" });

		const result = runChild({
			args: ["migrate", "--dry-run"],
			stored: {},
			agent: true,
		});

		expect(result.exitCode).toBe(0);
		expect(parseAgentLines(result.stdout).dry_run).toBe("true");
		expect(result.storedAfter).toEqual({});
	});

	test("migrate with no flags still writes", () => {
		seed({ voyageApiKey: "kctest-voy-VOYAGE" });

		const result = runChild({ args: ["migrate"], stored: {}, agent: true });

		expect(result.exitCode).toBe(0);
		expect(result.storedAfter.voyage).toBe("kctest-voy-VOYAGE");
	});

	test("prune takes no flags, and says so", () => {
		seed({ voyageApiKey: "kctest-voy-VOYAGE" });

		const result = runChild({
			args: ["prune", "--dry-run"],
			stored: { voyage: "kctest-voy-VOYAGE" },
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("error=unknown_flag");
		expect(result.stderr).toContain("takes no flags");
		// The plaintext copy survives — a prune that ran here would have removed it.
		expect(JSON.parse(result.file ?? "{}").voyageApiKey).toBe(
			"kctest-voy-VOYAGE",
		);
	});

	test("a typo of --force does not delete", () => {
		// `--force`'s typo fails safe by luck: the default points at refusing. It is
		// pinned anyway, because the next flag's default may not.
		seed({ defaultModel: "m" });

		const result = runChild({
			args: ["rm", "openrouter", "--forc"],
			stored: { openrouter: "kctest-or-ONLY-COPY" },
		});

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("error=unknown_flag");
		expect(result.storedAfter.openrouter).toBe("kctest-or-ONLY-COPY");
	});

	test("status takes no flags", () => {
		seed({ defaultModel: "m" });

		const result = runChild({ args: ["status", "--verbose"], stored: {} });

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("error=unknown_flag");
	});

	test("an id is a positional, not a flag — `rm openrouter` still works", () => {
		seed({ openrouterApiKey: "kctest-or-IN-FILE" });

		const result = runChild({
			args: ["rm", "openrouter"],
			stored: { openrouter: "kctest-or-IN-FILE" },
		});

		expect(result.exitCode).toBe(0);
		expect(result.storedAfter.openrouter).toBeUndefined();
	});
});
