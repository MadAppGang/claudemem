/**
 * FIXTURE (f) — the caller at the end of a TWO-HOP re-export chain.
 *
 * This file never names the launcher module, `spawnMnemexDetached`, or
 * `child_process`. `launch` arrives through `export *` (hop 1) over a renaming
 * `export { x as launch } from` (hop 2). The graph rule resolves the chain,
 * bounded and cycle-safe, and fires HERE, kind `launcher`.
 */
import { launch } from "./f-reexport-hop1.js";

export function reindexInBackground(cwd: string): void {
	launch(["index", "--quiet"], cwd).unref();
}
