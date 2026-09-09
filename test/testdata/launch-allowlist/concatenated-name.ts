/**
 * FIXTURE — deliberately unsafe, never executed.
 *
 * Round 7: the binary name never appears as a contiguous literal, so no
 * argument-shaped rule can match it. The allowlist rule fires on the import.
 */

import { spawn } from "node:child_process";

const parts = ["mne", "mex"];

export function reindex(cwd: string): void {
	spawn(parts.join(""), ["index"], { cwd, detached: true, stdio: "ignore" });
}
