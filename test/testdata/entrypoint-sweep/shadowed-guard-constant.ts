/**
 * FIXTURE — deliberately unsafe. Never executed. See ./README.md.
 *
 * The second way to satisfy a file-wide "does it import the blessed constant?"
 * check while the spawn site sets nothing: import it for real at the top, then
 * SHADOW it with a local of the same name at the site that launches the entry
 * point.
 *
 * The impostor fixture next door covers the no-import case. This one covers the
 * import-plus-shadow case, which the import check alone cannot see — which is why
 * a re-declaration anywhere in the file is disqualifying on its own.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { KEYCHAIN_CHILD_GUARD_ENV } from "../../helpers/child-env.js";

const CLI = join(import.meta.dir, "..", "..", "..", "dist", "index.js");

/** Genuinely guarded, and irrelevant to the spawn below. */
export function runSafeChild(cwd: string): string {
	const result = spawnSync("bun", [join(import.meta.dir, "helper.ts")], {
		cwd,
		encoding: "utf-8",
		env: { ...process.env, ...KEYCHAIN_CHILD_GUARD_ENV },
	});
	return result.stdout ?? "";
}

export function runEntryPoint(cwd: string): string {
	// The shadow. Same name, no content, and it is what the spread below resolves.
	const KEYCHAIN_CHILD_GUARD_ENV = {} as Record<string, string>;
	const result = spawnSync("bun", [CLI, "index"], {
		cwd,
		encoding: "utf-8",
		env: { ...process.env, ...KEYCHAIN_CHILD_GUARD_ENV },
	});
	return result.stdout ?? "";
}
