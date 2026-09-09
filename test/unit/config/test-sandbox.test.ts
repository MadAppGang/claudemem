/**
 * THE OTHER HARD CONSTRAINT: no test, helper or probe may write outside a temp
 * directory.
 *
 * This is not hypothetical hygiene. During the review of this feature a probe
 * called `saveGlobalConfig()` after reassigning `process.env.HOME` at runtime.
 * Bun's `os.homedir()` IGNORES a runtime reassignment — measured: `HOME` said
 * `/var/folders/.../probe-home-TFxBW0` while `homedir()` still said `/Users/jack`
 * — so the write landed on a real user's `~/.mnemex/config.json` and overwrote a
 * field whose previous value is now unknown.
 *
 * `~/.mnemex/config.json` is not redirectable at runtime: `GLOBAL_CONFIG_DIR` is a
 * module-level `const` evaluated from `homedir()` at import. The ONLY way to
 * sandbox it is a child process whose `HOME` was set in its environment before it
 * started. So the property enforced here has two halves:
 *
 *  1. STATIC. Every file under either test root that can reach a global-config
 *     writer must carry `MNEMEX_TEST_SANDBOX_HOME`, the declaration the sandboxed
 *     children check.
 *  2. RUNTIME. Those children actually refuse — proved by running them with the
 *     declaration missing, and with it pointing somewhere that is not a temp
 *     directory, and observing that they exit non-zero having written nothing.
 *
 * Verified, not assumed. That was the instruction.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { assertSandboxedHome } from "../../helpers/sandbox-guard.js";

/**
 * Functions that write to `~/.mnemex/config.json`, directly or through one call.
 * A test file that names any of them is a test file that can damage a real home.
 */
const GLOBAL_CONFIG_WRITERS = [
	"saveGlobalConfig",
	"removeGlobalConfigFields",
	"hardenGlobalConfigFileMode",
	"handleKeychainCommand",
];

/** The declaration a sandboxed child requires and its caller must supply. */
const SANDBOX_DECLARATION = "MNEMEX_TEST_SANDBOX_HOME";

describe("static — anything that can write the global config declares its sandbox", () => {
	test("every such file under test/ and tests/ carries the declaration", async () => {
		const glob = new Bun.Glob("**/*.{ts,tsx,js,jsx,mjs,cjs}");
		const offenders: string[] = [];
		let scanned = 0;

		for (const root of ["test", "tests"]) {
			for await (const file of glob.scan({ cwd: root, absolute: true })) {
				scanned++;
				const source = await Bun.file(file).text();
				const touchesWriter = GLOBAL_CONFIG_WRITERS.some((w) =>
					source.includes(w),
				);
				// This file names the writers in a const array; it performs no writes.
				const isThisFile = file.endsWith("test-sandbox.test.ts");
				if (
					touchesWriter &&
					!isThisFile &&
					!source.includes(SANDBOX_DECLARATION)
				) {
					offenders.push(file);
				}
			}
		}

		expect(offenders).toEqual([]);
		// A sweep that scanned nothing passes vacuously.
		expect(scanned).toBeGreaterThan(50);
	});
});

describe("runtime — the sandboxed children refuse when they cannot prove isolation", () => {
	const CHILDREN = [
		join(import.meta.dir, "../../helpers/global-config-child.ts"),
		join(import.meta.dir, "../../helpers/keychain-cli-child.ts"),
	];

	/** Run a child with a deliberately broken sandbox and report what happened. */
	function runBroken(
		child: string,
		env: Record<string, string | undefined>,
	): { exitCode: number; stderr: string } {
		const merged: Record<string, string> = {};
		for (const [k, v] of Object.entries(process.env)) {
			if (v !== undefined) merged[k] = v;
		}
		for (const [k, v] of Object.entries(env)) {
			if (v === undefined) delete merged[k];
			else merged[k] = v;
		}
		const proc = Bun.spawnSync({
			cmd: ["bun", "run", child, JSON.stringify({ args: ["status"] })],
			env: merged,
			stdout: "pipe",
			stderr: "pipe",
		});
		return { exitCode: proc.exitCode ?? -1, stderr: proc.stderr.toString() };
	}

	for (const child of CHILDREN) {
		const name = child.split("/").pop();

		test(`${name} refuses with no declaration at all`, () => {
			const result = runBroken(child, {
				MNEMEX_TEST_SANDBOX_HOME: undefined,
			});
			expect(result.exitCode).toBe(2);
			expect(result.stderr).toContain("refusing to run");
		});

		test(`${name} refuses when HOME was not set in its environment`, () => {
			// The exact shape of the incident: the caller declares a temp home but the
			// child's `homedir()` still resolves to the real one, because `HOME` was
			// reassigned at runtime in the PARENT rather than passed to the child.
			const sandbox = mkdtempSync(join(tmpdir(), "mnemex-sandbox-check-"));
			try {
				const result = runBroken(child, {
					MNEMEX_TEST_SANDBOX_HOME: sandbox,
					// HOME deliberately left pointing at the real home.
					HOME: homedir(),
				});
				expect(result.exitCode).toBe(2);
				expect(result.stderr).toContain("refusing to run");
				// Nothing was created under the declared sandbox either.
				expect(existsSync(join(sandbox, ".mnemex"))).toBe(false);
			} finally {
				rmSync(sandbox, { recursive: true, force: true });
			}
		});

		test(`${name} runs normally once it IS sandboxed`, () => {
			// The other direction: the guard must not be so strict that it refuses the
			// legitimate case, or it would be silently disabled by the next person to
			// hit it.
			const sandbox = mkdtempSync(join(tmpdir(), "mnemex-sandbox-ok-"));
			try {
				const result = runBroken(child, {
					MNEMEX_TEST_SANDBOX_HOME: sandbox,
					HOME: sandbox,
				});
				expect(result.exitCode).toBe(0);
				expect(result.stderr).not.toContain("refusing to run");
			} finally {
				rmSync(sandbox, { recursive: true, force: true });
			}
		});
	}
});

/**
 * The "is it a temp directory" clause, exercised directly.
 *
 * NOT through a spawned child, deliberately. `bun run` creates
 * `$HOME/Library/Caches/bun` before any of our code executes, so a test that ran a
 * child with `HOME` pointing outside the temp tree would litter whatever directory
 * it named — including a real home, which is how this suite would recreate the
 * very damage it exists to prevent. (Observed while writing it.) The predicate is
 * a pure function precisely so it can be tested with arbitrary paths and zero
 * filesystem effect.
 */
describe("the sandbox predicate itself", () => {
	const TEMP = tmpdir();
	const SANDBOX = join(TEMP, "mnemex-pure-check");

	test("accepts a home inside tmpdir that matches the declaration", () => {
		expect(() => assertSandboxedHome(SANDBOX, SANDBOX, TEMP)).not.toThrow();
	});

	test("rejects a missing declaration", () => {
		expect(() => assertSandboxedHome(SANDBOX, undefined, TEMP)).toThrow(
			/MNEMEX_TEST_SANDBOX_HOME is not set/,
		);
	});

	test("rejects the incident: declaration is a temp path, homedir() is not", () => {
		// `HOME` reassigned in the parent instead of passed to the child.
		expect(() => assertSandboxedHome(homedir(), SANDBOX, TEMP)).toThrow(
			/ignores a runtime reassignment/,
		);
	});

	test("rejects a real home even when the declaration AGREES with it", () => {
		// Agreement is not enough. This is the clause that stops someone "fixing" a
		// refusal by declaring whatever `homedir()` happens to be.
		expect(() => assertSandboxedHome(homedir(), homedir(), TEMP)).toThrow(
			/not inside/,
		);
	});

	test("rejects a sibling of tmpdir that merely shares a prefix", () => {
		// `/tmp/foo-evil` must not count as inside `/tmp/foo`.
		const parent = join(TEMP, "prefix");
		expect(() =>
			assertSandboxedHome(`${parent}-evil`, `${parent}-evil`, parent),
		).toThrow(/not inside/);
	});
});
