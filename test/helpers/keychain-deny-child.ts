/**
 * A fresh process that tries to reach the real macOS Keychain, so the parent can
 * assert that it CANNOT.
 *
 * This is the adversary for review finding A2. It is deliberately spawned:
 *  - from a working directory where `bunfig.toml` is NOT found, so `[test] preload`
 *    never runs and `MNEMEX_KEYCHAIN_TEST_GUARD` is unset;
 *  - with `MNEMEX_DISABLE_KEYCHAIN=0`, so the policy opt-out does not save us;
 *  - without ever calling `installKeychainStub()`, so `testDepsEverInstalled` is
 *    false.
 *
 * Under the guard set this replaces, all four "independent" layers were absent in
 * exactly this configuration and the next read spawned `/usr/bin/security` against
 * the developer's real login keychain. The only thing standing here now is
 * deny-by-default inside the adapter, which is the point.
 *
 * It reports what it OBSERVED rather than asserting, so the parent can prove the
 * preconditions really were absent — a test that silently kept the sentinel would
 * pass for the wrong reason.
 *
 * Usage: bun run test/helpers/keychain-deny-child.ts
 * Prints one JSON line on stdout after `__RESULT__`.
 */

import { readKeychainAccount } from "../../src/core/keychain.js";
import { isSecretsBackendEnabled } from "../../src/core/secrets.js";

const read = readKeychainAccount("openrouter");

const out = {
	cwd: process.cwd(),
	// Proof the preconditions were genuinely absent in this process.
	guardEnv: process.env.MNEMEX_KEYCHAIN_TEST_GUARD ?? null,
	disableEnv: process.env.MNEMEX_DISABLE_KEYCHAIN ?? null,
	platform: process.platform,
	backendEnabled: isSecretsBackendEnabled(),
	status: read.status,
	error: read.status === "failed" ? read.error : undefined,
};

process.stdout.write(`\n__RESULT__${JSON.stringify(out)}\n`);
