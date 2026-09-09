/**
 * FIXTURE (k), hop 10 of 10 — renames a launcher export. The analyzer never
 * reads this line during resolution (the chain was cut at hop 9), which is
 * exactly why the bound must fail closed rather than open.
 */
export { spawnMnemexDetached as launch } from "../../../src/core/entry-point-launcher.js";
