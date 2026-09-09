/**
 * The adversary for external review's BYPASS 3: the DEFAULT LLM provider's
 * keychain read.
 *
 * `src/llm/providers/claude-code.ts` used to run
 * `execSync(<relative binary name> + ' find-generic-password -s "Claude Code-credentials" -w')`.
 * Three defects in one line, all of them invisible to the old static sweep because
 * it scanned only `test/` and `tests/`:
 *
 *  1. It never consulted the deny-by-default gate, the sentinel or the latch.
 *  2. It resolved the binary through `PATH` (CWE-426).
 *  3. Its timeout was charged to no budget.
 *
 * This child constructs the provider the way `Indexer.initialize()` and
 * `AutocompleteEngine.complete()` do, with a DECOY binary planted first on `PATH`.
 * The decoy is not `/usr/bin/security` — it is a script in a temp directory that
 * records its own invocation and its argv. If the decoy file appears, something
 * resolved the binary through `PATH`, which is the hijack.
 *
 * The second, independent count is `realKeychainSpawnCount()`, incremented at the
 * port's single `Bun.spawnSync`. Both zero is a measured spawn count of zero at
 * two unrelated points: one covers a relatively-resolved binary, the other covers
 * the pinned absolute one.
 *
 * It previously used `keychainProcessBudgetUsedMs() === 0` for the second count.
 * That is milliseconds, and a refusal is charged 1 ms under load — a proxy that
 * cannot tell "refused" from "spawned". Replaced.
 *
 * Usage: bun run test/helpers/claude-code-token-child.ts
 * Prints one JSON line on stdout after `__RESULT__`.
 */

import {
	keychainProcessBudgetUsedMs,
	realKeychainSpawnCount,
} from "../../src/core/keychain.js";
import { ClaudeCodeLLMClient } from "../../src/llm/providers/claude-code.js";

const spawnsBefore = realKeychainSpawnCount();
const budgetBefore = keychainProcessBudgetUsedMs();

let constructed = false;
let error: string | undefined;
try {
	// The constructor is what reads the token — that is why merely creating the
	// default client was enough to spawn the binary.
	new ClaudeCodeLLMClient();
	constructed = true;
} catch (e) {
	error = e instanceof Error ? e.message : String(e);
}

const out = {
	cwd: process.cwd(),
	guardEnv: process.env.MNEMEX_KEYCHAIN_TEST_GUARD ?? null,
	platform: process.platform,
	pathHead: (process.env.PATH ?? "").split(":")[0],
	constructed,
	error,
	// THE SPAWN COUNT.
	spawnsBefore,
	spawnsAfter: realKeychainSpawnCount(),
	// Milliseconds, for diagnosis only.
	budgetBefore,
	budgetAfter: keychainProcessBudgetUsedMs(),
};

process.stdout.write(`\n__RESULT__${JSON.stringify(out)}\n`);
