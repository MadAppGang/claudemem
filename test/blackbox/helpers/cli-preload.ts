/**
 * `bun --preload` module for black-box CLI tests.
 *
 * Runs BEFORE `src/index.ts` inside a spawned child whose HOME is a temp dir. It installs the
 * fake keychain on the public seam so `mnemex keychain ...` never reaches `/usr/bin/security`,
 * and writes the recorded calls + final store to MNEMEX_BB_OUT on exit.
 *
 * Safety, in order:
 *   1. refuse unless HOME is a temp sandbox that os.homedir() agrees with
 *   2. set the MNEMEX_KEYCHAIN_TEST_GUARD sentinel BEFORE any mnemex module loads
 *   3. install the stub deps
 */
import { realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { exitUnlessSandboxed } from "../../helpers/sandbox-guard.js";

// The repo's blessed precondition for anything that can write ~/.mnemex/config.json.
exitUnlessSandboxed(homedir(), process.env.MNEMEX_TEST_SANDBOX_HOME, tmpdir());

const expectedHome = process.env.MNEMEX_BB_HOME;
const actualHome = homedir();
const tmpReal = realpathSync(tmpdir());
if (
	!expectedHome ||
	actualHome !== expectedHome ||
	!realpathSync(actualHome).startsWith(tmpReal) ||
	!actualHome.includes("mnemex-bb-")
) {
	process.stderr.write(
		`BB PRELOAD REFUSED: homedir()=${actualHome} expected=${expectedHome} tmp=${tmpReal}\n`,
	);
	process.exit(99);
}

process.env.MNEMEX_KEYCHAIN_TEST_GUARD = "1";
// The blessed child env inherits the parent's shell; drop any real credentials before
// src/index.ts loads.
for (const k of [
	"OPENROUTER_API_KEY",
	"VOYAGE_API_KEY",
	"ANTHROPIC_API_KEY",
	"CONTEXT7_API_KEY",
	"OLLAMA_API_KEY",
	"MNEMEX_KEYCHAIN_FILE",
]) {
	delete process.env[k];
}

const { createFakeKeychain } = await import("./fake-keychain.js");
const kc = await import("../../../src/core/keychain.js");

const options = JSON.parse(process.env.MNEMEX_BB_FAKE ?? "{}");
const fake = createFakeKeychain(options);
kc.setKeychainTestDeps(fake.deps);
// The child always ARRIVES with MNEMEX_DISABLE_KEYCHAIN=1. Only now that the stub is installed
// (and the sentinel is set) do we lift it, and only when the test wants the stubbed path.
if (process.env.MNEMEX_BB_KEEP_DISABLED !== "1") {
	delete process.env.MNEMEX_DISABLE_KEYCHAIN;
}

const outPath = process.env.MNEMEX_BB_OUT;
const flush = () => {
	if (!outPath) return;
	try {
		writeFileSync(
			outPath,
			JSON.stringify({
				...fake.snapshot(),
				realSpawns: kc.realKeychainSpawnCount(),
			}),
		);
	} catch {
		// nothing we can do at exit
	}
};
process.on("exit", flush);
process.on("beforeExit", flush);
