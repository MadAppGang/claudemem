/**
 * FIXTURE — deliberately unsafe. Never executed. See ./README.md.
 *
 * The exact shape `tests/rg.test.ts` carried through three review rounds: the
 * entry-point path split across `join()` arguments, so no contiguous
 * `src/index.ts` appears anywhere in the file, and `{ ...process.env }` as the
 * child environment.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

const CLI_PATH = join(import.meta.dir, "..", "src", "index.ts");

export function runIt(args: string[], cwd: string): string {
	const result = spawnSync("bun", [CLI_PATH, "rg", ...args], {
		cwd,
		encoding: "utf-8",
		env: { ...process.env, NO_COLOR: "1" },
	});
	return result.stdout ?? "";
}
