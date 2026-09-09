/**
 * FIXTURE (f), hop 2 of 2 — renames a launcher export on the way out.
 *
 * Holds no binding and calls nothing, so it is NOT itself a finding. It is one
 * link of the chain `f-reexport-caller.ts` -> `f-reexport-hop1.ts` -> here ->
 * the launcher.
 */
export { spawnMnemexDetached as launch } from "../../../src/core/entry-point-launcher.js";
