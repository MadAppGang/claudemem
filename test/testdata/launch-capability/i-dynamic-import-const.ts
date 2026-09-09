/**
 * FIXTURE (i) — a dynamic import whose specifier is a SAME-FILE const string.
 *
 * `import(LAUNCHER)` is not a literal, but the analyzer climbs the same ladder
 * it uses for computed member keys (literal -> substitution-free template ->
 * same-file `const NAME = "literal"`), so this RESOLVES to the real launcher
 * module and fires as a plain `launcher` call — not through the fail-closed
 * `dynamic-import` path, and with nothing in `unresolved`.
 */
const LAUNCHER = "../../../src/core/entry-point-launcher.js";

export async function reindexViaConstImport(cwd: string): Promise<void> {
	const { spawnMnemexDetached } = await import(LAUNCHER);
	spawnMnemexDetached(["index", "--quiet"], cwd).unref();
}
