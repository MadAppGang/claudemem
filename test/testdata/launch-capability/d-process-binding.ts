/**
 * FIXTURE (d) — `process["binding"]`.
 *
 * The regex sweep matches `process.binding(` only. Reaching under the runtime
 * for `spawn_sync` through element access is the same capability. The graph
 * rule resolves the key against the `process-global` tag. Kind `primitive`.
 */
export function rawSpawnSync(): unknown {
	const proc = process as unknown as Record<string, (n: string) => unknown>;
	// biome-ignore lint/complexity/useLiteralKeys: the fixture IS the computed spelling
	const binding = proc["binding"];
	return binding("spawn_sync");
}
