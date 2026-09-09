/**
 * FIXTURE — deliberately unsafe. Never executed. See ./README.md.
 *
 * THE ROUND-4 FINDING, as a file.
 *
 * `src/editor/editor.ts:262` was exactly this: `spawn("mnemex", ["index", …])`.
 * A BARE BINARY NAME resolved through `PATH`. There is no path in it, no
 * `dist/`, no `index.js`, no `join()` — so every path-shaped rule the sweep had
 * after round 3 reported green while `SymbolEditor`, which two e2e suites and
 * `test/helpers/test-workspace.ts` construct, launched the production entry
 * point on every single edit. `which mnemex` answers on any machine with mnemex
 * installed, so the spawn SUCCEEDED, and the child's first act is
 * `enableRealKeychainAccess()` (`src/index.ts:32`).
 */

import { spawn } from "node:child_process";

export function triggerReindex(filePath: string, cwd: string): void {
	const child = spawn("mnemex", ["index", "--quiet", "--files", filePath], {
		cwd,
		stdio: "ignore",
		detached: true,
	});
	child.on("error", () => {});
	child.unref();
}
