/**
 * FIXTURE — the CALLER half of the "imported wrapper" evasion.
 *
 * This file is expected to come back `launches=false`. That is the honest
 * limit of a file-level rule: the caller holds no launch capability of its own,
 * so it is not where the rule fires. The rule fires on `imported-wrapper.ts`,
 * which cannot exist in `src/` un-allowlisted. The consequence is documented in
 * the README rather than hidden behind a heuristic that would try to trace
 * `"mnemex"` through the wrapper's parameter.
 */

import { runCommand } from "./imported-wrapper.js";

export function reindex(): void {
	runCommand("mnemex", ["index", "--quiet"]);
}
