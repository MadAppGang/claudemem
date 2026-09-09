/**
 * NEGATIVE — an ALLOWLISTED caller using the purpose-specific launcher.
 *
 * Byte-for-byte the same call shape as fixture (a). The only difference is
 * that the test puts THIS path on the launcher-caller allowlist for the
 * fixture run, so the call is a recorded launch and not a violation. This is
 * what proves the allowlist is consulted per FILE and per KIND, rather than
 * the rule firing on the import specifier alone.
 */
import { spawnMnemexAwaited } from "../../../src/core/entry-point-launcher.js";

export function reindexAndWait(cwd: string): void {
	const child = spawnMnemexAwaited(["index"], cwd);
	child.on("error", () => {});
}
