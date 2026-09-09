/**
 * FIXTURE (g) — `spawn(parts.join(""))`, the entry point's name never a
 * contiguous literal.
 *
 * CAUGHT BY THE KIND RULE, NOT BY THE ARGUMENT. The graph rule does not read
 * arguments at all: `spawn` is tainted `primitive` by its import, this file is
 * not on `PROCESS_LAUNCH_ALLOWLIST`, so the call is a violation whatever it
 * launches. Had the argument been `"ls"` the verdict would be identical.
 */
import { spawn } from "node:child_process";

export function sneaky(cwd: string): void {
	const parts = ["mne", "mex"];
	spawn(parts.join(""), ["index", "--quiet"], { cwd, detached: true });
}
