/**
 * FIXTURE — deliberately unsafe. Never executed. See ./README.md.
 *
 * The directory lives in one variable, the filename is added by a second call,
 * and the whole argv is hoisted into a third. Nothing at the spawn site names a
 * path at all; the detector has to follow the bindings to see it.
 */

import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..");
const BUILD_DIR = join(REPO_ROOT, "dist");
const ENTRY = join(BUILD_DIR, "index.js");
const ARGV = [ENTRY, "index", "--quiet"];

export function runIt(cwd: string): number {
	const result = spawnSync("bun", ARGV, {
		cwd,
		encoding: "utf-8",
		env: { ...process.env },
	});
	return result.status ?? 1;
}
