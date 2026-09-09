/**
 * THE precondition every test child that can write `~/.mnemex/config.json` checks
 * before it does anything.
 *
 * WHY THIS EXISTS. `GLOBAL_CONFIG_DIR` is a module-level `const` evaluated from
 * `homedir()` at import time, so it cannot be redirected at runtime — and Bun's
 * `os.homedir()` IGNORES a reassignment of `process.env.HOME`. Measured during the
 * review of this feature: `HOME` said `/var/folders/.../probe-home-TFxBW0` while
 * `homedir()` still said `/Users/jack`, and a probe that trusted `HOME` wrote to a
 * real user's config file. The only sandbox that works is a CHILD PROCESS whose
 * `HOME` was in its environment before it started.
 *
 * The predicate is a pure function, separate from the children that call it, for
 * one specific reason: it can then be tested against arbitrary paths WITHOUT
 * spawning a process whose `HOME` points outside the temp tree. That matters
 * because `bun run` itself creates `$HOME/Library/Caches/bun` — a test that
 * checked the "not a temp directory" clause end-to-end would litter whatever
 * directory it named, including a real home.
 */

import { realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";

/**
 * `realpath`, falling back to the deepest ancestor that exists.
 *
 * Both halves matter. On macOS `tmpdir()` is `/var/folders/...`, a symlink to
 * `/private/var/folders/...`, so comparing unresolved paths says a temp directory
 * is not inside tmpdir. And a path that does not exist yet cannot be `realpath`'d
 * at all, so resolving only the whole path would leave one side under `/var` and
 * the other under `/private/var` — which is exactly how a correct sandbox gets
 * rejected and someone decides the guard is broken and removes it.
 */
function resolve(path: string): string {
	const segments: string[] = [];
	let current = path;
	for (;;) {
		try {
			const real = realpathSync(current);
			return segments.length === 0 ? real : join(real, ...segments.reverse());
		} catch {
			const parent = dirname(current);
			if (parent === current) return path; // reached the root; nothing resolved
			segments.push(current.slice(parent.length + 1));
			current = parent;
		}
	}
}

export function isInside(child: string, parent: string): boolean {
	const c = resolve(child);
	const p = resolve(parent);
	return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/**
 * Throws unless this process is provably writing inside a temp directory.
 *
 * Three conditions, and each one is a distinct real failure:
 *
 *  1. The caller DECLARED a sandbox. Forgetting the declaration must be a refusal,
 *     not a default.
 *  2. The declaration agrees with `homedir()`. This is the one that catches the
 *     incident: a caller that set `HOME` in the parent instead of the child's env
 *     declares a temp path while `homedir()` still resolves to the real home.
 *  3. `homedir()` is inside `tmpdir()`. Agreement is not enough — a caller could
 *     agree on a real directory.
 *
 * @param homeDir   what `os.homedir()` returns — the value `src/config.ts` uses
 * @param declared  `process.env.MNEMEX_TEST_SANDBOX_HOME`
 * @param tempDir   what `os.tmpdir()` returns
 */
export function assertSandboxedHome(
	homeDir: string,
	declared: string | undefined,
	tempDir: string,
): void {
	if (!declared) {
		throw new Error(
			"refusing to run: MNEMEX_TEST_SANDBOX_HOME is not set. This helper writes to " +
				"~/.mnemex/config.json and must only ever be spawned with HOME pointed at a temp directory.",
		);
	}
	if (resolve(homeDir) !== resolve(declared)) {
		throw new Error(
			`refusing to run: homedir() is ${resolve(homeDir)} but MNEMEX_TEST_SANDBOX_HOME is ${declared}. ` +
				"HOME must be set in the CHILD's env before the process starts — Bun's homedir() " +
				"ignores a runtime reassignment.",
		);
	}
	if (!isInside(homeDir, tempDir)) {
		throw new Error(
			`refusing to run: homedir() is ${resolve(homeDir)}, which is not inside ${resolve(tempDir)}.`,
		);
	}
}

/** Call at the top of a child helper. Exits 2 rather than throwing into a job. */
export function exitUnlessSandboxed(
	homeDir: string,
	declared: string | undefined,
	tempDir: string,
): void {
	try {
		assertSandboxedHome(homeDir, declared, tempDir);
	} catch (error) {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exit(2);
	}
}
