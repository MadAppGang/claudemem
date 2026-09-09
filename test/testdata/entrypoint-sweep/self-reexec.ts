/**
 * FIXTURE — deliberately unsafe. Never executed. See ./README.md.
 *
 * The entry point under a name that contains neither "mnemex" nor "index":
 * `process.execPath` plus `process.argv[1]`. In production `process.argv[1]` IS
 * `dist/index.js`, so this re-executes the very build that is running.
 *
 * Three hook handlers in `src/hooks/handlers/` used this spelling. No test
 * reaches them today, which is exactly why it is here — the shape has to be
 * rejected before someone writes the test that reaches it, not after.
 */

import { spawn, spawnSync } from "node:child_process";

export function askSelf(args: string[], cwd: string): string | null {
	const result = spawnSync(process.execPath, [process.argv[1], ...args], {
		cwd,
		encoding: "utf-8",
		timeout: 10000,
	});
	return result.stdout ?? null;
}

export function reindexInBackground(cwd: string): void {
	const child = spawn(process.execPath, [process.argv[1], "index", "--quiet"], {
		cwd,
		detached: true,
		stdio: "ignore",
	});
	child.unref();
}
