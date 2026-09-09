/**
 * FIXTURE (k), hop 9 of 10 — the NINTH `export *`, one past the bound of 8.
 * The analyzer does not follow this line: it records `reexport-depth` here
 * and fails closed instead.
 */
export * from "./k-reexport-deep-hop10.js";
