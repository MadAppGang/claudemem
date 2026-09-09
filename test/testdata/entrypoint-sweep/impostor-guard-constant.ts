/**
 * FIXTURE — deliberately unsafe. Never executed. See ./README.md.
 *
 * The sweep accepts a spawn site that spreads `KEYCHAIN_CHILD_GUARD_ENV`, because
 * that constant is the single definition of the two guard variables. This file is
 * why that acceptance is conditional on the IMPORT: the name is declared locally
 * and supplies nothing at all.
 *
 * A name-only rule would read the spread below as guarded and let a child run the
 * production entry point — which enables real keychain access as its first act —
 * against the developer's real login keychain.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

/** An impostor: the blessed name, none of the blessed content. */
const KEYCHAIN_CHILD_GUARD_ENV = {} as Record<string, string>;

const CLI = join(import.meta.dir, "..", "..", "..", "dist", "index.js");

export function runEntryPoint(cwd: string): string {
	const result = spawnSync("bun", [CLI, "index"], {
		cwd,
		encoding: "utf-8",
		env: { ...process.env, ...KEYCHAIN_CHILD_GUARD_ENV },
	});
	return result.stdout ?? "";
}
