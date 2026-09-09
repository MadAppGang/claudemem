/**
 * NEGATIVE — a non-launch API whose ARGUMENTS mention `mnemex` everywhere.
 *
 * `path.join`, `readFileSync`, a `Map` named `spawn`, an object method named
 * `exec`, and a `$`-suffixed identifier. None of these bindings derives from a
 * launch capability, so the graph rule is silent no matter what the strings
 * say. This is the over-match the old argument-shaped detector used to have.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const spawn = new Map<string, string>();
const cache$ = { exec: (sql: string) => sql.length };

export function describeBinary(root: string): number {
	const bin = join(root, "node_modules", ".bin", "mnemex");
	const text = readFileSync(bin, "utf-8");
	spawn.set("mnemex", text);
	return cache$.exec("select 'mnemex index --quiet'");
}
