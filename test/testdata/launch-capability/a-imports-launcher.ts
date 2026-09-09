/**
 * FIXTURE (a) — a NON-allowlisted file importing the launcher.
 *
 * The exact shape of round 8's HIGH 2: no `node:child_process`, no `Bun.spawn`,
 * nothing the regex sweep knows, and yet a call to it starts the installed
 * `mnemex`. The graph rule taints EVERY export of the launcher module and
 * fires on the call, kind `launcher`.
 */
import { spawnMnemexDetached } from "../../../src/core/entry-point-launcher.js";

export function kickOffReindex(cwd: string): void {
	const child = spawnMnemexDetached(["index", "--quiet"], cwd);
	child.on("error", () => {});
	child.unref();
}
