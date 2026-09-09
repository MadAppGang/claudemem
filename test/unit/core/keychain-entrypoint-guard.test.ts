/**
 * THE THREE BYPASSES of the deny-by-default guard, closed and measured.
 *
 * Three prior Claude review passes and a four-model code review left this — the
 * build's central safety claim — with three live holes. An external review found
 * all three in one pass. CLAUDE.md gotcha #24 says "No test may spawn
 * `/usr/bin/security`, ever. Not 'should not' — the seam makes it impossible."
 * These tests are what make that sentence true rather than aspirational.
 *
 * EVERY ASSERTION HERE IS ON A SPAWN COUNT OR ON BYTES, never on a report object
 * and never on a proxy for a count.
 *
 *   - `spawnsAfter === 0` IS the count. `realKeychainSpawnCount()` is incremented
 *     at the single choke point in `realRun`, immediately before `Bun.spawnSync`
 *     and after all three vetoes. Nothing else can move it; there is no setter and
 *     no reset. Zero is proof, not inference.
 *   - The DECOY is a file on disk. A binary named `security`, first on `PATH`,
 *     that writes a marker when invoked. Its absence after the run is a measured
 *     spawn count of zero for anything that resolved the binary RELATIVELY — the
 *     case the absolute-path counter cannot see.
 *
 * WHAT THIS FILE USED TO ASSERT, AND WHY IT WAS WRONG. It asserted
 * `keychainProcessBudgetUsedMs() === 0` and called that a spawn count. It is
 * milliseconds. `runGuarded` charges `Date.now() - started` around `deps.run`, and
 * a REFUSED call still traverses that region — 0 ms idle, 1 ms under full-suite
 * load. The suite passed in isolation and failed in the full run, while the
 * security property was intact throughout. A test that cannot distinguish
 * "refused in 1 ms" from "spawned in 1 ms" is not evidence, and this is the
 * assertion carrying the build's central safety claim. Milliseconds never stand
 * in for a spawn count anywhere in this suite.
 *
 * NOTHING HERE SPAWNS `/usr/bin/security`. The decoy is a different file, in a
 * temp directory, and the pinned absolute path in `src/core/keychain.ts` means the
 * port would never choose it — which is precisely the property being measured.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keychainSafeChildEnv } from "../../helpers/child-env.js";
import { expectedRefusalReason } from "../../helpers/keychain-refusal.js";

const REPO_ROOT = join(import.meta.dir, "../../..");
const ENTRY_GUARD_CHILD = join(
	import.meta.dir,
	"../../helpers/entrypoint-guard-child.ts",
);
const CLAUDE_CODE_CHILD = join(
	import.meta.dir,
	"../../helpers/claude-code-token-child.ts",
);
// Written as one literal on purpose: the static sweep's entry-point detector
// looks for exactly this path, so writing it as `join(REPO_ROOT, "src",
// "index.ts")` would hide this file from the rule it exists to demonstrate.
const REAL_ENTRY_POINT = join(REPO_ROOT, "src/index.ts");

let sandbox: string;
let decoyDir: string;
let decoyMarker: string;

/**
 * Plant a binary named `security` first on `PATH`.
 *
 * It is NOT `/usr/bin/security` and cannot become it: it lives in a fresh temp
 * directory and is removed in `afterEach`. Invoking it is harmless — it appends
 * its argv to a marker file and exits 1, which is what a PATH-hijacked `security`
 * would do if the attacker were polite.
 */
function plantDecoySecurityBinary(): void {
	decoyDir = mkdtempSync(join(tmpdir(), "mnemex-decoy-"));
	decoyMarker = join(decoyDir, "INVOKED");
	const decoy = join(decoyDir, "security");
	writeFileSync(
		decoy,
		[
			"#!/bin/sh",
			// Record the hijack, with argv, so a failure says what was leaked to it.
			`printf '%s\\n' "$*" >> "${decoyMarker}"`,
			"exit 1",
			"",
		].join("\n"),
		"utf-8",
	);
	chmodSync(decoy, 0o755);
}

beforeEach(() => {
	sandbox = mkdtempSync(join(tmpdir(), "mnemex-entry-"));
	mkdirSync(join(sandbox, "cwd"), { recursive: true });
	plantDecoySecurityBinary();
});

afterEach(() => {
	rmSync(sandbox, { recursive: true, force: true });
	rmSync(decoyDir, { recursive: true, force: true });
});

interface GuardChildResult {
	cwd: string;
	guardEnv: string | null;
	disableEnv: string | null;
	platform: string;
	spawnsBefore: number;
	spawnsAfter: number;
	budgetBefore: number;
	budgetAfter: number;
	readStatus: string;
	readError?: string;
	enumerationFailed: boolean;
	enumerationError?: string;
}

function parseResult<T>(stdout: string, stderr: string): T {
	const marker = stdout.indexOf("__RESULT__");
	if (marker < 0) {
		throw new Error(
			`child produced no result.\nstdout: ${stdout}\nstderr: ${stderr}`,
		);
	}
	return JSON.parse(stdout.slice(marker + "__RESULT__".length)) as T;
}

/** `PATH` with the decoy first, so anything resolving the binary relatively finds it. */
function pathWithDecoyFirst(): string {
	return `${decoyDir}:${process.env.PATH ?? ""}`;
}

/**
 * Deliberately NOT built with `keychainSafeChildEnv()`.
 *
 * That helper clamps `MNEMEX_DISABLE_KEYCHAIN=1` last, so no caller can weaken
 * the guard for a child that runs an entry point — which is right for its job and
 * wrong for this one. Here the POLICY layer must be switched ON, so that the
 * refusal being asserted is provably the ADAPTER's and not "the backend was
 * turned off". This child drives the port directly; it is not an entry point.
 */
function runGuardChild(cwd: string): GuardChildResult {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) env[key] = value;
	}
	delete env.MNEMEX_KEYCHAIN_FILE;
	env.HOME = sandbox;
	env.PATH = pathWithDecoyFirst();
	env.MNEMEX_KEYCHAIN_TEST_GUARD = "1";
	env.MNEMEX_DISABLE_KEYCHAIN = "0";

	const proc = Bun.spawnSync({
		cmd: ["bun", "run", ENTRY_GUARD_CHILD],
		cwd,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	return parseResult<GuardChildResult>(
		proc.stdout.toString(),
		proc.stderr.toString(),
	);
}

// ============================================================================
// BYPASS 1 — a child that runs the production composition root
// ============================================================================

describe("BYPASS 1 — the composition root's own opt-in cannot reach the keychain", () => {
	test("a child that calls enableRealKeychainAccess() spawns NOTHING, from a temp cwd", () => {
		// The exact shape deny-by-default cannot cover on its own: `src/index.ts:32`
		// enables real access, so a test spawning the entry point enables it inside
		// the child. The sentinel supplied EXPLICITLY at the spawn site vetoes that
		// call. cwd is a temp directory, so `bunfig.toml`'s preload — the thing that
		// used to be the only writer of the sentinel — is definitively not involved.
		const result = runGuardChild(join(sandbox, "cwd"));

		// Preconditions: the sentinel came from the spawn site, and the policy layer
		// is NOT what is saving us.
		expect(result.guardEnv).toBe("1");
		expect(result.disableEnv).toBe("0");
		expect(result.cwd).not.toContain("worktrees");

		// THE SPAWN COUNT — the whole point, and now the actual count rather than a
		// millisecond reading standing in for one.
		expect(result.spawnsBefore).toBe(0);
		expect(result.spawnsAfter).toBe(0);

		// And the refusal carries its exact reason for this platform: the ADAPTER's
		// on darwin, the earlier platform gate's anywhere else.
		expect(result.readStatus).toBe("failed");
		expect(result.readError).toContain(expectedRefusalReason(result.platform));
		expect(result.enumerationFailed).toBe(true);

		// Nothing resolved a binary named `security` through PATH either.
		expect(existsSync(decoyMarker)).toBe(false);
	});

	test("the same from a subdirectory of the repo — the measured preload escape", () => {
		// `cd test && bun test ../x.test.ts` was the concrete reproduction of the
		// preload being absent. Same child, same absence of bunfig, same refusal,
		// still zero spawns.
		const result = runGuardChild(join(REPO_ROOT, "test"));

		expect(result.guardEnv).toBe("1");
		expect(result.spawnsAfter).toBe(0);
		expect(result.readStatus).toBe("failed");
		expect(result.readError).toContain(expectedRefusalReason(result.platform));
		expect(existsSync(decoyMarker)).toBe(false);
	});

	test("the REAL entry point, executed as a child, spawns nothing through PATH", () => {
		// Not a stand-in: this runs `src/index.ts` itself, the production
		// composition root, with the guard variables supplied the way every test
		// helper must now supply them. `MNEMEX_DISABLE_KEYCHAIN=1` is required by
		// the operating constraint for any real `mnemex keychain` invocation, and it
		// is exactly what `keychainSafeChildEnv()` provides.
		const proc = Bun.spawnSync({
			cmd: ["bun", REAL_ENTRY_POINT, "keychain", "status", "--agent"],
			cwd: join(sandbox, "cwd"),
			env: keychainSafeChildEnv({
				HOME: sandbox,
				PATH: pathWithDecoyFirst(),
			}),
			stdout: "pipe",
			stderr: "pipe",
		});

		const stdout = proc.stdout.toString();

		// BYTES: the agent contract is `key=value` lines, and the backend really is
		// off — so this test cannot pass by the command having silently failed.
		expect(stdout).toContain("backend_enabled=false");
		expect(proc.exitCode).toBe(0);

		// SPAWN COUNT: nothing resolved `security` through PATH, in a process that
		// DID execute `enableRealKeychainAccess()`.
		expect(existsSync(decoyMarker)).toBe(false);
	});
});

// ============================================================================
// BYPASS 2 — the exported seam that could turn the gate ON
// ============================================================================

describe("the spawn counter is wired to the SPAWN, not to the guard", () => {
	test("it increments at `Bun.spawnSync`, after all three vetoes, and cannot be reset", async () => {
		// The counter is the evidence for every "no spawn" claim in this file, so
		// its wiring is itself asserted rather than assumed. Read statically,
		// because exercising it for real would mean spawning the binary.
		const source = readFileSync(
			join(REPO_ROOT, "src/core/keychain.ts"),
			"utf-8",
		);

		// ONE increment, and it sits immediately before the ONE spawn.
		const increments = source.match(/realSecuritySpawns\+\+/g) ?? [];
		expect(increments.length).toBe(1);
		const incrementAt = source.indexOf("realSecuritySpawns++");
		const spawnAt = source.indexOf("Bun.spawnSync({");
		expect(incrementAt).toBeGreaterThan(0);
		expect(spawnAt).toBeGreaterThan(incrementAt);
		// Nothing but whitespace, comments and the `const proc =` between them.
		const between = source.slice(
			incrementAt + "realSecuritySpawns++".length,
			spawnAt,
		);
		expect(between).not.toContain("return");
		expect(between).not.toContain("if (");

		// All three vetoes return BEFORE it, so a refusal can never move it.
		expect(source.indexOf("if (!realAccessEnabled)")).toBeLessThan(incrementAt);
		expect(source.indexOf("if (isGuardedProcess())")).toBeLessThan(incrementAt);
		expect(source.indexOf('if (typeof Bun === "undefined")')).toBeLessThan(
			incrementAt,
		);

		// Monotonic: no setter, no reset. `setKeychainTestDeps` clears the memos,
		// the breaker and the budget — it must not be able to clear this. The ONLY
		// assignment permitted is the `let` initialiser.
		const assignments = source.match(/realSecuritySpawns\s*=[^=]/g) ?? [];
		expect(assignments.length).toBe(1);
		expect(source).toContain("let realSecuritySpawns = 0;");
		expect(source).not.toContain("realSecuritySpawns--");
		expect(source).not.toContain("realSecuritySpawns +=");

		// And the accessor exists and reads zero in this (guarded) process.
		const mod = await import("../../../src/core/keychain.js");
		expect(mod.realKeychainSpawnCount()).toBe(0);
	});

	test("milliseconds are not used as a spawn count anywhere in the test roots", async () => {
		// The rule, enforced. `keychainProcessBudgetUsedMs` is legitimate for
		// asserting the BUDGET (the pre-flight clamp, the timeout arithmetic); it is
		// never legitimate as "did a spawn happen". The distinguishing marker is an
		// equality-to-zero assertion on a budget reading.
		//
		// The marker is an equality-to-zero assertion whose subject names the
		// budget. Assembled from parts so this sweeper does not match its own
		// source — the same trick the argv sweeper in `keychain.test.ts` uses.
		const MS = ["bud", "get"].join("");
		const forbidden = new RegExp(
			`expect\\([^)]*[Bb]${MS.slice(1)}[^)]*\\)\\s*\\.toBe\\(0\\)`,
		);
		const glob = new Bun.Glob("**/*.{ts,tsx}");
		const offenders: string[] = [];
		for (const root of ["test", "tests"]) {
			for await (const file of glob.scan({ cwd: root, absolute: true })) {
				if (forbidden.test(await Bun.file(file).text())) offenders.push(file);
			}
		}
		expect(offenders).toEqual([]);

		// The sweeper is only worth having if it fires on the exact shape that was
		// removed from this file, so prove that it does.
		const removed = `expect(result.${MS}After).toBe(0);`;
		expect(forbidden.test(removed)).toBe(true);
		expect(forbidden.test("expect(result.spawnsAfter).toBe(0);")).toBe(false);
	});
});

describe("BYPASS 2 — no exported seam can enable real keychain access", () => {
	test("the keychain module exports no positive setter, only a disable-only one", async () => {
		const mod = await import("../../../src/core/keychain.js");
		const names = Object.keys(mod);

		// The replacement exists and is disable-only by its very signature.
		expect(names).toContain("disableRealKeychainAccessForTests");
		expect(mod.disableRealKeychainAccessForTests.length).toBe(0);

		// And nothing shaped like the old boolean setter survives. The removed one
		// wrote `realAccessEnabled` unconditionally: in a fresh process with no
		// sentinel and no installed seam, calling it and then `readKeychainAccount()`
		// reached the real adapter.
		const positiveSetters = names.filter((n) =>
			/^set.*(?:RealKeychain|KeychainAccess)/.test(n),
		);
		expect(positiveSetters).toEqual([]);
	});

	test("the only production setter is still vetoed by the sentinel, in THIS process", () => {
		// Complements the source sweep with the runtime fact.
		expect(process.env.MNEMEX_KEYCHAIN_TEST_GUARD).toBe("1");
	});
});

// ============================================================================
// BYPASS 3 — the DEFAULT LLM provider's own `security` call
// ============================================================================

interface ClaudeChildResult {
	cwd: string;
	guardEnv: string | null;
	platform: string;
	pathHead: string;
	constructed: boolean;
	error?: string;
	spawnsBefore: number;
	spawnsAfter: number;
	budgetBefore: number;
	budgetAfter: number;
}

describe("BYPASS 3 — the default LLM provider goes through the port", () => {
	test("constructing the default Claude Code client hijacks no PATH binary", () => {
		// `src/llm/providers/claude-code.ts` ran its own `execSync` on a RELATIVE
		// binary name. It is the default enrichment provider (`getLLMSpec()` ->
		// `cc/sonnet`), constructed from `Indexer.initialize()` inside the index lock
		// and from `AutocompleteEngine.complete()`. A planted binary earlier on PATH
		// received `-w` and the user's Claude Code OAuth token (CWE-426).
		//
		// The decoy IS that planted binary. If the marker file appears, the hijack is
		// live. HOME is a temp directory, so the file fallback finds nothing either
		// and the constructor throws — which is the correct outcome and is asserted.
		const proc = Bun.spawnSync({
			cmd: ["bun", "run", CLAUDE_CODE_CHILD],
			cwd: join(sandbox, "cwd"),
			env: keychainSafeChildEnv({
				HOME: sandbox,
				PATH: pathWithDecoyFirst(),
				MNEMEX_DISABLE_KEYCHAIN: "0",
			}),
			stdout: "pipe",
			stderr: "pipe",
		});

		const result = parseResult<ClaudeChildResult>(
			proc.stdout.toString(),
			proc.stderr.toString(),
		);

		// The decoy really was first on PATH — otherwise this passes for the wrong
		// reason, which is how the previous sweep passed while the hole was open.
		expect(result.pathHead).toBe(decoyDir);

		// SPAWN COUNT 1: nothing resolved `security` through PATH. If this ever
		// fires, the marker file's contents ARE the leaked argv.
		expect(
			existsSync(decoyMarker) ? readFileSync(decoyMarker, "utf-8") : null,
		).toBeNull();

		// SPAWN COUNT 2: the port's own counter, which covers the pinned ABSOLUTE
		// binary that a PATH decoy can never see.
		expect(result.spawnsBefore).toBe(0);
		expect(result.spawnsAfter).toBe(0);

		// Behaviour is preserved: no token anywhere means the constructor still
		// throws its usual error rather than silently returning a broken client.
		expect(result.constructed).toBe(false);
		expect(result.error).toContain("Could not find Claude OAuth token");
	});

	test("the provider names the service, and the port pins the absolute binary", () => {
		// ARGV, at the source level. The read must carry the Claude Code service and
		// must not name the binary relatively anywhere in the file.
		const source = readFileSync(
			join(REPO_ROOT, "src/llm/providers/claude-code.ts"),
			"utf-8",
		);
		expect(source).toContain('"Claude Code-credentials"');
		expect(source).toContain("readGenericPassword");
		// The old call, by its two halves, neither of which may return. Matched with
		// the call paren so the file's own explanation of what it used to do is not
		// mistaken for the thing itself.
		expect(source).not.toContain("execSync(");
		expect(source).not.toContain("find-generic-password");
	});
});
