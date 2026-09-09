/**
 * FIXTURE — fires, and the README says why.
 *
 * `spawn("git", ["grep", "mnemex"])` does NOT launch the entry point. Under the
 * old argument-shaped detector it was a false positive (the argv contained the
 * quoted binary name). Under the allowlist rule it is a TRUE positive for a
 * different reason: a launch API in a file that is not on the allowlist. The
 * argument is irrelevant; the remedy is an allowlist entry with a one-line
 * justification, after which only the narrow entry-point check applies to it.
 */

import { spawn } from "node:child_process";

export function findUses(cwd: string): void {
	spawn("git", ["grep", "mnemex"], { cwd, stdio: "pipe" });
}
