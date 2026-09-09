/**
 * FIXTURE — deliberately unsafe. Never executed. See ./README.md.
 *
 * `npx`/`bunx` DOWNLOAD AND EXECUTE the package. The command position names a
 * runner, not mnemex, and the version suffix (`mnemex@latest`) means even a
 * rule matching the exact string `"mnemex"` would miss it. What runs is still
 * the entry point, still with `enableRealKeychainAccess()` as its first act —
 * and worse than the installed binary, because it may be a DIFFERENT build than
 * the one under test.
 */

import { spawnSync } from "node:child_process";

export function indexViaRunner(cwd: string): number | null {
	const result = spawnSync("npx", ["mnemex@latest", "index", "--quiet"], {
		cwd,
		encoding: "utf-8",
		env: { ...process.env },
	});
	return result.status;
}

export function indexViaBunx(cwd: string): number | null {
	return spawnSync("bunx", ["mnemex", "index"], {
		cwd,
		env: { ...process.env },
	}).status;
}
