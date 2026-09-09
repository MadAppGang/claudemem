/**
 * FIXTURE (b) — the Bun global behind an alias.
 *
 * `Bun\s*\.\s*spawn` never appears, so the regex sweep is silent. The graph
 * rule taints `runtime` with the `bun-global` tag at the declaration and
 * resolves `.spawn` on it to the primitive. Kind `primitive`.
 */
const runtime = Bun;

export function listFiles(): void {
	runtime.spawn(["ls", "-la"]);
}
