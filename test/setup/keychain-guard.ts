/**
 * `bun test` preload — one layer of the keychain test guards (architecture D-7 / H3).
 *
 * NOT the primary guard, and the comment that used to say otherwise was wrong in a
 * way that mattered. `bun` resolves `bunfig.toml` against the CURRENT WORKING
 * DIRECTORY and does not walk up, so `cd test && bun test ../x.test.ts` never runs
 * this file. Review finding A2 measured exactly that and reached
 * `/usr/bin/security` from a fresh process.
 *
 * The primary guard is now DENY BY DEFAULT inside the adapter itself
 * (`realAccessEnabled` in `src/core/keychain.ts`, turned on only by
 * `src/index.ts`). It needs no environment, no preload and no cwd. What this file
 * still buys, and why it stays:
 *
 * 1. `MNEMEX_KEYCHAIN_TEST_GUARD=1` is a PRIVATE sentinel that a CHILD PROCESS
 *    inherits — including a child that runs the real `src/index.ts` entry point
 *    and would therefore otherwise enable itself. `enableRealKeychainAccess()` is
 *    a no-op while it is set. It replaces an original `NODE_ENV === "test"` check
 *    that was wrong twice over: `bun test` sets `NODE_ENV="test"` (measured), and
 *    so does many an ordinary shell, and the refusal sits in the READ path, so a
 *    stray `NODE_ENV` would have silently disabled the keychain for real users.
 *    `test/helpers/keychain-stub.ts` sets the same sentinel at module scope, so a
 *    suite that imports the stub carries it even with no preload at all.
 *
 * 2. `MNEMEX_DISABLE_KEYCHAIN` defaults to "1" so that a suite which never thinks
 *    about the keychain never reaches the policy layer. Suites that exercise
 *    policy set it to "0" in `beforeEach` AND install the stub seam.
 *
 * These two ARE written by one writer and do NOT fail independently of each
 * other — that is the finding, stated plainly. They fail independently of the
 * deny-by-default gate and of the `testDepsEverInstalled` latch, which is what
 * makes the set as a whole hold.
 */

process.env.MNEMEX_KEYCHAIN_TEST_GUARD = "1";
process.env.MNEMEX_DISABLE_KEYCHAIN ??= "1";
