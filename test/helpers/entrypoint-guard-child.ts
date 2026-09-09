/**
 * The adversary for external review's CRITICAL 1: a child that does exactly what
 * the PRODUCTION COMPOSITION ROOT does, then tries to reach the keychain.
 *
 * `src/index.ts:32` calls `enableRealKeychainAccess()` before any dispatch, so a
 * test that spawns `dist/index.js` or `src/index.ts` turns the deny-by-default
 * gate ON inside the child. Deny-by-default cannot cover that shape — by
 * construction, the composition root is the thing that lifts it. The residual
 * veto is the private sentinel, and this child exists to prove the veto holds when
 * the sentinel is supplied EXPLICITLY at the spawn site rather than inherited from
 * a cwd-sensitive preload.
 *
 * IT REPORTS THE REAL SPAWN COUNT, not a status string and not a proxy for one.
 * `realKeychainSpawnCount()` is incremented at the single choke point in
 * `realRun`, immediately before `Bun.spawnSync` and after all three vetoes, so
 * only an actual spawn can move it.
 *
 * It replaces `keychainProcessBudgetUsedMs() === 0`, which was WRONG as a spawn
 * count and was caught being wrong: a refused call still passes through
 * `runGuarded`'s timed region and is charged `Date.now() - started`, which is 0
 * on an idle machine and 1 under full-suite load. That made this suite pass in
 * isolation and fail in the full run while the security property was intact.
 * `budgetUsedMs` is still reported below, but as what it is — milliseconds.
 *
 * NOTHING HERE SPAWNS `security`. That is the assertion.
 *
 * Usage: bun run test/helpers/entrypoint-guard-child.ts
 * Prints one JSON line on stdout after `__RESULT__`.
 */

import {
	enableRealKeychainAccess,
	enumerateKeychainAccounts,
	keychainProcessBudgetUsedMs,
	readKeychainAccount,
	realKeychainSpawnCount,
} from "../../src/core/keychain.js";

// EXACTLY what src/index.ts does, in the same position: first, unconditionally.
enableRealKeychainAccess();

const spawnsBefore = realKeychainSpawnCount();
const budgetBefore = keychainProcessBudgetUsedMs();

// Both read shapes, because they take different paths to `runGuarded`.
const read = readKeychainAccount("openrouter");
const enumeration = enumerateKeychainAccounts();

const out = {
	cwd: process.cwd(),
	// Proof of what the child actually saw, so the parent cannot pass for the
	// wrong reason by having quietly kept some other guard.
	guardEnv: process.env.MNEMEX_KEYCHAIN_TEST_GUARD ?? null,
	disableEnv: process.env.MNEMEX_DISABLE_KEYCHAIN ?? null,
	platform: process.platform,
	// THE SPAWN COUNT. Incremented only at `realRun`'s `Bun.spawnSync`, past every
	// veto. Nothing else can move it and nothing can reset it.
	spawnsBefore,
	spawnsAfter: realKeychainSpawnCount(),
	// Milliseconds, reported for diagnosis only. NEVER assert a spawn count on it.
	budgetBefore,
	budgetAfter: keychainProcessBudgetUsedMs(),
	readStatus: read.status,
	readError: read.status === "failed" ? read.error : undefined,
	enumerationFailed: enumeration.failed,
	enumerationError: enumeration.error,
};

process.stdout.write(`\n__RESULT__${JSON.stringify(out)}\n`);
