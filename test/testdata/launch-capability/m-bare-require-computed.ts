/**
 * FIXTURE (m) — the `require` twin of (l): a BARE computed `require(x)` whose
 * result is discarded. Same verdict: one `dynamic-import` entry in
 * `unresolved`, no violation, nothing acquired.
 */
const candidates = ["./negative-non-launch-api.js", "./a-imports-launcher.js"];

export function preloadForSideEffects(index: number): void {
	const moduleName = candidates[index] ?? candidates[0];
	require(moduleName);
}
