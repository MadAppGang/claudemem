/**
 * FIXTURE — deliberately unsafe. Never executed. See ./README.md.
 *
 * The path is built by string interpolation at the call site, with no binding to
 * follow and no `join()` to key on.
 */

import { spawnSync } from "node:child_process";

const ROOT = import.meta.dir;

export function runIt(cwd: string): string {
	const result = spawnSync("bun", [`${ROOT}/dist/index.js`, "status"], {
		cwd,
		encoding: "utf-8",
		env: { ...process.env },
	});
	return result.stdout ?? "";
}
