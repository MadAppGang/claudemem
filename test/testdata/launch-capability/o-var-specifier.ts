/**
 * FIXTURE (o) — the `var` form of (n). A `var` is reassignable (and hoisted),
 * so it is never a constant string: FAIL CLOSED, same verdict as (n).
 */
export async function reindexViaVar(cwd: string): Promise<void> {
	// The `var` KEYWORD is the spelling under test (noVar is not enabled here).
	var moduleName = "./negative-non-launch-api.js";
	moduleName = "../../../src/core/entry-point-launcher.js";
	const { spawnMnemexDetached } = await import(moduleName);
	spawnMnemexDetached(["index", "--quiet"], cwd).unref();
}
