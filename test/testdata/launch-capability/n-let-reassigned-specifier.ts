/**
 * FIXTURE (n) — a `let` specifier REASSIGNED before the import, round 10's
 * second HIGH.
 *
 * Before round 8 `collectStatics` recorded every literal declarator as a const
 * string without looking at the keyword, so `moduleName` resolved to the STALE
 * initial `"./negative-non-launch-api.js"`, the import got that module's
 * (empty) taint, and the launcher call below went unreported. Only `const`
 * declarators are constant now: a `let` falls to rung 4 and FAILS CLOSED —
 * a `dynamic-import` entry in `unresolved` and BOTH kinds on the call.
 */
export async function reindexViaReassignedLet(cwd: string): Promise<void> {
	let moduleName = "./negative-non-launch-api.js";
	moduleName = "../../../src/core/entry-point-launcher.js";
	const { spawnMnemexDetached } = await import(moduleName);
	spawnMnemexDetached(["index", "--quiet"], cwd).unref();
}
