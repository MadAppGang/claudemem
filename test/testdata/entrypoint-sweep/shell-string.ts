/**
 * FIXTURE — deliberately unsafe. Never executed. See ./README.md.
 *
 * The entry point inside a SHELL STRING. The command and its arguments share one
 * literal, so the quote does not close after the binary name and a rule looking
 * for the exact token `"mnemex"` sees nothing. Two forms: `execSync` on a shell
 * string, and Bun's `$` tag, which has no call parentheses for a call-site rule
 * to find at all.
 *
 * `src/llm/providers/claude-code.ts` shipped the `execSync`-on-a-shell-string
 * shape for the `security` binary and it took an external review to find it, so
 * the shape is known to survive this repository's sweeps.
 */

import { execSync } from "node:child_process";
import { $ } from "bun";

export function indexViaShell(cwd: string): string {
	return execSync("mnemex index --quiet", {
		cwd,
		encoding: "utf-8",
		env: { ...process.env },
	});
}

export async function statusViaBunShell(): Promise<string> {
	const { stdout } = await $`mnemex status --agent`.quiet();
	return stdout.toString();
}
