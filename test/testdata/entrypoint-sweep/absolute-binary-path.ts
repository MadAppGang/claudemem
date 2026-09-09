/**
 * FIXTURE — deliberately unsafe. Never executed. See ./README.md.
 *
 * The same binary, named ABSOLUTELY. `which mnemex` on the machine where round
 * 4 was verified answers `/Users/jack/.bun/bin/mnemex`, and pasting that answer
 * into a spawn is the obvious "fix" for a bare name — it is the same launch of
 * the same entry point, and a rule that only knows the bare spelling would call
 * it safe.
 *
 * The path is also hoisted into a const, because that is how every previous
 * spelling was smuggled past the detector.
 */

import { spawnSync } from "node:child_process";

const MNEMEX_BIN = "/opt/homebrew/bin/mnemex";

export function status(cwd: string): string {
	const result = spawnSync(MNEMEX_BIN, ["status", "--agent"], {
		cwd,
		encoding: "utf-8",
		env: { ...process.env },
	});
	return result.stdout ?? "";
}
