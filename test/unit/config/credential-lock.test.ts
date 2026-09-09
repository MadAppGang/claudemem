/**
 * THE CREDENTIAL LOCK — fail closed, and shared across all four mutating commands.
 *
 * Two external-review findings, one mechanism:
 *
 *  CRITICAL 2 (CWE-367). `keychain prune` and an unforced `keychain rm` between
 *  them delete BOTH copies of a credential, deterministically:
 *      1. config.json and the keychain both hold openrouter=A.
 *      2. P (`prune`) reads A from the keychain, marks the field removable, and
 *         carries on verifying the next candidate.
 *      3. R (`rm openrouter`) sees the still-present plaintext A, so its last-copy
 *         guard permits the delete, and deletes the keychain item.
 *      4. P removes the line from config.json. Its expected-value check passes —
 *         it only ever guarded the FILE, and the file did not change.
 *      5. A exists nowhere. Neither command needed `--force`.
 *
 *  HIGH 4. `acquireConfigLock()` returned null after 2 s and `saveGlobalConfig()`
 *  did the read-modify-write anyway. A lock that proceeds when it cannot be taken
 *  is not a lock.
 *
 * EVERY ASSERTION IS ON FILE BYTES, on the fake keychain's contents, or on an
 * exit code — never on a report object. Reports are what the previous four
 * defects of this class hid behind.
 *
 * The lock is staged DETERMINISTICALLY rather than by racing two children: the
 * lock is a file, so a file with a fresh mtime at `~/.mnemex/config.lock` IS a
 * held lock. That removes the timing flake without weakening the property, and it
 * is the same state a live holder leaves.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONFIG_CHILD = join(
	import.meta.dir,
	"../../helpers/global-config-child.ts",
);
const CLI_CHILD = join(import.meta.dir, "../../helpers/keychain-cli-child.ts");

let home: string;
let configDir: string;
let configPath: string;
let lockPath: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "mnemex-lock-"));
	configDir = join(home, ".mnemex");
	configPath = join(configDir, "config.json");
	lockPath = join(configDir, "config.lock");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function seed(content: string): void {
	mkdirSync(configDir, { recursive: true });
	writeFileSync(configPath, content, "utf-8");
}

/** Exactly what a live holder leaves behind: the file, with a fresh mtime. */
function holdLock(): void {
	mkdirSync(configDir, { recursive: true });
	writeFileSync(lockPath, "another-process.holder.token", "utf-8");
}

function childEnv(): Record<string, string> {
	return {
		...(process.env as Record<string, string>),
		HOME: home,
		MNEMEX_TEST_SANDBOX_HOME: home,
		MNEMEX_KEYCHAIN_TEST_GUARD: "1",
		MNEMEX_DISABLE_KEYCHAIN: "0",
	};
}

function runChild(
	child: string,
	job: Record<string, unknown>,
): Record<string, unknown> {
	const proc = Bun.spawnSync({
		cmd: ["bun", "run", child, JSON.stringify(job)],
		env: childEnv(),
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = proc.stdout.toString();
	const marker = stdout.indexOf("__RESULT__");
	if (marker < 0) {
		throw new Error(
			`child produced no result.\nstdout: ${stdout}\nstderr: ${proc.stderr.toString()}`,
		);
	}
	return JSON.parse(stdout.slice(marker + "__RESULT__".length));
}

// ============================================================================
// HIGH 4 — saveGlobalConfig fails CLOSED
// ============================================================================

describe("HIGH 4 — a save that cannot take the lock changes nothing", () => {
	test("the config file is byte-identical after a refused save", () => {
		const before = JSON.stringify(
			{ defaultModel: "m", learning: false },
			null,
			2,
		);
		seed(before);
		holdLock();

		const result = runChild(CONFIG_CHILD, {
			save: { openrouterApiKey: "kctest-or-NEW", defaultModel: "n" },
		});

		// It REFUSED, by the named error, rather than proceeding unlocked.
		expect(String(result.error)).toContain("credential lock");
		expect(result.report).toBeNull();

		// THE BYTES. Not "the field is unchanged" — the whole file, byte for byte.
		expect(readFileSync(configPath, "utf-8")).toBe(before);
	});

	test("the same save SUCCEEDS once the lock is released — the refusal is the lock", () => {
		// Without this, the test above passes for a process that simply cannot write.
		seed(JSON.stringify({ defaultModel: "m" }, null, 2));

		const result = runChild(CONFIG_CHILD, {
			save: { openrouterApiKey: "kctest-or-NEW", defaultModel: "n" },
		});

		expect(result.error).toBeUndefined();
		const written = JSON.parse(String(result.file));
		expect(written.defaultModel).toBe("n");
		// Stored, so it is not in the file — proof the whole save really ran.
		expect(written).not.toHaveProperty("openrouterApiKey");
		expect((result.storedAfter as Record<string, string>).openrouter).toBe(
			"kctest-or-NEW",
		);
	});

	test("a STALE lock is reclaimed, so a crashed holder cannot wedge the CLI", () => {
		seed(JSON.stringify({ defaultModel: "m" }, null, 2));
		mkdirSync(configDir, { recursive: true });
		writeFileSync(lockPath, "dead-holder", "utf-8");
		// Older than CONFIG_LOCK_STALE_MS (10 s).
		const old = new Date(Date.now() - 60_000);
		utimesSync(lockPath, old, old);

		const result = runChild(CONFIG_CHILD, { save: { defaultModel: "n" } });

		expect(result.error).toBeUndefined();
		expect(JSON.parse(String(result.file)).defaultModel).toBe("n");
	});
});

// ============================================================================
// CRITICAL 2 — prune and rm are serialised by ONE shared lock
// ============================================================================

describe("CRITICAL 2 — prune and rm cannot interleave", () => {
	test("`rm` refuses while the credential lock is held, and the item survives", () => {
		// The lock stands in for a `prune` in flight: under the fix, prune holds it
		// from its raw file read through the file replacement, which is exactly the
		// window in which rm's file check used to see a plaintext copy that prune
		// was in the act of deleting.
		seed(JSON.stringify({ openrouterApiKey: "kctest-or-A" }, null, 2));
		holdLock();

		const result = runChild(CLI_CHILD, {
			args: ["rm", "openrouter"],
			agent: true,
			stored: { openrouter: "kctest-or-A" },
		});

		expect(result.exitCode).toBe(1);
		expect(String(result.stderr)).toContain("error=lock_unavailable");

		// THE KEYCHAIN: the item is still there. This is the copy step 3 of the
		// sequence used to destroy.
		expect((result.storedAfter as Record<string, string>).openrouter).toBe(
			"kctest-or-A",
		);
		// THE BYTES: the file copy is untouched too.
		expect(readFileSync(configPath, "utf-8")).toContain("kctest-or-A");
	});

	test("`prune` refuses while the lock is held, and the plaintext copy survives", () => {
		// The mirror image: an `rm` in flight must stop a `prune` from deleting the
		// line whose keychain counterpart is being removed.
		const before = JSON.stringify({ openrouterApiKey: "kctest-or-A" }, null, 2);
		seed(before);
		holdLock();

		const result = runChild(CLI_CHILD, {
			args: ["prune"],
			agent: true,
			stored: { openrouter: "kctest-or-A" },
		});

		expect(result.exitCode).toBe(1);
		expect(String(result.stderr)).toContain("error=lock_unavailable");
		// THE BYTES: nothing was written.
		expect(readFileSync(configPath, "utf-8")).toBe(before);
	});

	test("`migrate` refuses while the lock is held, and writes nothing to either side", () => {
		const before = JSON.stringify({ openrouterApiKey: "kctest-or-A" }, null, 2);
		seed(before);
		holdLock();

		const result = runChild(CLI_CHILD, {
			args: ["migrate"],
			agent: true,
			stored: {},
		});

		expect(result.exitCode).toBe(1);
		expect(String(result.stderr)).toContain("error=lock_unavailable");
		expect(readFileSync(configPath, "utf-8")).toBe(before);
		expect(result.storedAfter).toEqual({});
		// SPAWN COUNT: it refused BEFORE reaching the keychain at all.
		expect(result.seamCalls).toEqual([]);
	});

	test("`status` still works while the lock is held — it mutates nothing", () => {
		// The lock must not turn a read-only inspection command into a failure; a
		// user whose CLI is wedged cannot find out what is stored.
		seed(JSON.stringify({ openrouterApiKey: "kctest-or-A" }, null, 2));
		holdLock();

		const result = runChild(CLI_CHILD, {
			args: ["status"],
			agent: true,
			stored: { openrouter: "kctest-or-A" },
		});

		expect(result.exitCode).toBe(0);
		expect(String(result.stdout)).toContain(
			"secret id=openrouter keychain=true",
		);
	});

	test("prune's own nested lock is re-entrant — the unlocked case still prunes", () => {
		// `prune` holds the lock and then calls `removeGlobalConfigFields`, which
		// takes the same lock. A non-re-entrant lock would deadlock for the whole
		// acquisition budget and then, under the OLD fail-open rule, proceed anyway —
		// which is how the hole stayed open. This proves the nesting works.
		seed(JSON.stringify({ openrouterApiKey: "kctest-or-A" }, null, 2));

		const result = runChild(CLI_CHILD, {
			args: ["prune"],
			agent: true,
			stored: { openrouter: "kctest-or-A" },
		});

		expect(result.exitCode).toBe(0);
		// THE BYTES: the plaintext copy is gone, the keychain item remains.
		expect(JSON.parse(String(result.file))).not.toHaveProperty(
			"openrouterApiKey",
		);
		expect((result.storedAfter as Record<string, string>).openrouter).toBe(
			"kctest-or-A",
		);
		// And the lock file was released, not leaked.
		expect(existsSync(lockPath)).toBe(false);
	});
});
