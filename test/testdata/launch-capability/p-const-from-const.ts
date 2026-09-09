/**
 * FIXTURE (p) — a TWO-HOP same-file const: `const B = A` where `A` is a const
 * string.
 *
 * Decided, not left ambiguous: the ladder's rung 3 is exactly ONE hop
 * (`const NAME = "literal"`). `B`'s initialiser is an identifier, not a
 * literal, so `B` is not a const string and `import(B)` FAILS CLOSED — a
 * `dynamic-import` entry and both kinds. Resolving the chain would buy
 * nothing in `src/` (no such spelling exists there) and would need ordering
 * and cycle rules of its own; a real caller writes the literal.
 */
const LAUNCHER = "../../../src/core/entry-point-launcher.js";
const ALIAS = LAUNCHER;

export async function reindexViaTwoHopConst(cwd: string): Promise<void> {
	const { spawnMnemexDetached } = await import(ALIAS);
	spawnMnemexDetached(["index", "--quiet"], cwd).unref();
}
