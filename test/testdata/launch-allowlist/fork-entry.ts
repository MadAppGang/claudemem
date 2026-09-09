/**
 * FIXTURE — deliberately unsafe, never executed.
 *
 * Round 7 (external review): `fork` was absent from the argument-shaped
 * detector's call regex, so this launched the entry point while the sweep
 * reported green. Under the allowlist rule the ARGUMENTS are irrelevant: this
 * file obtains a launch capability (`node:child_process`) and is not on the
 * allowlist, so the import line itself is the finding.
 */

import { fork } from "node:child_process";
import { join } from "node:path";

export function reindex(root: string): void {
	fork(join(root, "dist", "index.js"), ["index", "--quiet"]);
}
