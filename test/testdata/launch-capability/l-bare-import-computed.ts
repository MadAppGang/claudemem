/**
 * FIXTURE (l) — a BARE computed dynamic import, round 10's HIGH.
 *
 * The import's namespace is never bound, awaited-into, chained or called: the
 * statement exists only for the loaded module's top-level effects. Before
 * round 8 the analyzer evaluated `import(x)` only when its value flowed
 * somewhere (a binding, a `.then`, a call), so this statement produced no
 * `dynamic-import` entry and no taint — invisible to both enforcement layers.
 * Now every `import()` / `require()` expression is evaluated where it stands:
 * an unresolvable specifier lands in `unresolved`, which the production test
 * asserts EMPTY. It is NOT a violation (nothing is called), and it does not
 * need to be: `unresolved` has no allowlist, so it is the stricter channel.
 */
function getModuleName(): string {
	return process.env.MNEMEX_PLUGIN_MODULE ?? "./negative-non-launch-api.js";
}

export async function loadForSideEffects(): Promise<void> {
	const moduleName = getModuleName();
	await import(moduleName);
}
