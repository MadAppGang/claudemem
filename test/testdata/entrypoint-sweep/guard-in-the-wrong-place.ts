/**
 * FIXTURE — deliberately unsafe. Never executed. See ./README.md.
 *
 * The guard helper is imported and genuinely used — for a DIFFERENT child. The
 * entry-point spawn below still forwards a bare `{ ...process.env }`.
 *
 * Under the old file-level rule ("does the source mention the helper anywhere?")
 * this file passed. The guard has to be at the call that launches the entry
 * point, because that is the child that enables real keychain access in itself.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { keychainSafeChildEnv } from "../../helpers/child-env.js";

const HELPER = join(import.meta.dir, "some-other-child.ts");
const CLI = join(import.meta.dir, "..", "..", "..", "src", "index.ts");

export function runHelper(): string {
	// Correctly guarded — and irrelevant to the spawn below.
	const result = spawnSync("bun", [HELPER], {
		encoding: "utf-8",
		env: keychainSafeChildEnv(),
	});
	return result.stdout ?? "";
}

export function runEntryPoint(cwd: string): string {
	const result = spawnSync("bun", [CLI, "index"], {
		cwd,
		encoding: "utf-8",
		env: { ...process.env },
	});
	return result.stdout ?? "";
}
