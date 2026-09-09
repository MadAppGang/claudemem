/**
 * FIXTURE (j) — a COMPUTED dynamic-import specifier, round 9's HIGH.
 *
 * The specifier is assembled at runtime (a template with a substitution and a
 * concatenation), so no static analysis can say which module loads. Before
 * round 7 this file passed every rule: the sweep saw no primitive, and the
 * graph returned empty taint for an unresolvable `import(x)` WITHOUT recording
 * it as unresolved. The rule now FAILS CLOSED: an unresolvable specifier is
 * recorded in `unresolved` as `dynamic-import` AND the namespace is tainted
 * with BOTH kinds, so the call below fires as `primitive` and `launcher`.
 */
const dir = "../../../src/core";
const stem = ["entry-point", "launcher"].join("-");

export async function reindexViaComputedImport(cwd: string): Promise<void> {
	const { spawnMnemexDetached } = await import(`${dir}/${stem}.js`);
	spawnMnemexDetached(["index", "--quiet"], cwd).unref();
}

export function reindexViaConcatenatedRequire(cwd: string): void {
	// biome-ignore lint/style/useTemplate: the CONCATENATION is the spelling under test
	const mod = require(dir + "/" + stem + ".js");
	mod.spawnMnemexDetached(["index"], cwd);
}
