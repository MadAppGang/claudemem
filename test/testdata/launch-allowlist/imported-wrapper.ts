/**
 * FIXTURE — deliberately unsafe, never executed.
 *
 * Round 7: the WRAPPER half of the "imported wrapper" evasion. Neither this
 * file nor its caller names both a launch API and the entry point, so the
 * argument-shaped detector saw nothing in either. Under the allowlist rule THIS
 * file is the finding: it holds the capability, and it is not allowlisted. A
 * generic "run any command" adapter cannot enter `src/` without a reviewer
 * writing its allowlist justification — and "forwards whatever it is given" is
 * the justification that must be refused (see the README).
 */

import { spawn } from "node:child_process";

export function runCommand(command: string, args: string[]): void {
	spawn(command, args, { stdio: "ignore" });
}
