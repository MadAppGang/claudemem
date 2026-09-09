/**
 * FIXTURE (k) — the caller at the end of a re-export chain ONE HOP PAST the
 * bound (`REEXPORT_DEPTH_LIMIT` = 8 `export *` hops).
 *
 * `k-reexport-deep-hop1.ts` .. `hop9.ts` each `export *` from the next (nine
 * star hops); hop 10 re-exports the real launcher. The analyzer follows eight,
 * refuses the ninth, records `reexport-depth` in `unresolved` at hop 9, and
 * FAILS CLOSED: `launch` carries both kinds, so the call below fires as
 * `primitive` AND `launcher`. Before round 7 this chain returned empty taint
 * and nothing was recorded. (Fixture `f` is the two-hop chain that resolves;
 * eight hops resolve too — the test builds that chain in a temp dir.)
 */
import { launch } from "./k-reexport-deep-hop1.js";

export function reindexPastTheBound(cwd: string): void {
	launch(["index", "--quiet"], cwd).unref();
}
