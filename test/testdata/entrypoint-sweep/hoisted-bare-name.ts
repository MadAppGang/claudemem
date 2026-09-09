/**
 * FIXTURE — deliberately unsafe. Never executed. See ./README.md.
 *
 * The bare name behind TWO levels of indirection: a const holding `"mnemex"`,
 * and an argv array holding that const. Hoisting is how the detector was
 * defeated in rounds 2 and 3; the round-4 spelling gets the same treatment here
 * so the fix does not have to be rediscovered a fourth time.
 *
 * This is also the shape `src/mcp/reindexer.ts` would have if its launcher were
 * NOT injected — `REINDEX_COMMAND = "mnemex"` used directly at a spawn.
 */

import { spawn } from "node:child_process";

const REINDEX_COMMAND = "mnemex";
const REINDEX_ARGV = [REINDEX_COMMAND, "index", "--quiet", "--if-idle"];

export function backgroundReindex(cwd: string): void {
	const child = spawn(REINDEX_ARGV[0] as string, REINDEX_ARGV.slice(1), {
		cwd,
		detached: true,
		stdio: "ignore",
	});
	child.unref();
}
