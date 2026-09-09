/**
 * FIXTURE — deliberately unsafe, never executed.
 *
 * Round 7: the command hidden behind an object property. The argument-shaped
 * detector had to propagate bindings to see it; the allowlist rule does not
 * look at the argument at all.
 */

import { spawn } from "node:child_process";

const commands = { cli: "mnemex" };

export function reindex(cwd: string): void {
	spawn(commands.cli, ["index"], { cwd, detached: true, stdio: "ignore" });
}
