/**
 * FIXTURE (f), hop 1 of 2 — `export * from` over hop 2.
 *
 * Also not a finding on its own. Exercises the star re-export path of the
 * export table, which has no names to match and must be followed blind.
 */
export * from "./f-reexport-hop2.js";
