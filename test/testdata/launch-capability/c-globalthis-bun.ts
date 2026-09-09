/**
 * FIXTURE (c) — `globalThis["Bun"].spawn`.
 *
 * Element access with a string-literal key. The regex sweep has no rule for
 * `globalThis`; the graph rule resolves the key, lands on `bun-global`, and
 * then on the primitive. Kind `primitive`.
 */
export function listFiles(): void {
	// biome-ignore lint/complexity/useLiteralKeys: the fixture IS the computed spelling
	globalThis["Bun"].spawn(["ls", "-la"]);
}
