/**
 * NEGATIVE — BARE dynamic imports whose specifiers are LITERALS.
 *
 * The counterpart of (l)/(m): the analyzer now evaluates every `import()` /
 * `require()` where it stands, so a literal one must RESOLVE silently — not
 * be recorded as unresolved merely because its value is discarded. The module
 * named carries no capability, so nothing is acquired and nothing fires.
 */
export async function preloadHarmless(): Promise<void> {
	await import("./negative-non-launch-api.js");
	require("./negative-non-launch-api.js");
	await import(`./negative-non-launch-api.js`);
}
