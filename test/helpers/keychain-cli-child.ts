/**
 * Child process for the `mnemex keychain` command tests.
 *
 * Same shape, and the same reasons, as `global-config-child.ts`: `GLOBAL_CONFIG_DIR`
 * is resolved from `homedir()` at import time, so `HOME` must be set before the
 * process starts, and this file REFUSES to run unless it can prove it is inside a
 * temp directory. See that file's header for the incident behind the refusal.
 *
 * It drives `handleKeychainCommand` itself rather than a shared helper, because
 * the findings under test are about the command: its exit status, its `--agent`
 * rendering, its last-copy guard, and how many seam invocations a status render
 * really costs. "The shared machinery is tested" is not coverage of any of those.
 *
 * Usage: bun run test/helpers/keychain-cli-child.ts '<json job>'
 * Prints one JSON line on stdout after `__RESULT__`, on stderr's own stream so the
 * parent can assert on both independently.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { handleKeychainCommand } from "../../src/cli/commands/keychain.js";
import {
	type KeychainRunResult,
	setKeychainTestDeps,
} from "../../src/core/keychain.js";
import { exitUnlessSandboxed } from "./sandbox-guard.js";

// THE HARD PRECONDITION — see `./sandbox-guard.ts`.
exitUnlessSandboxed(homedir(), process.env.MNEMEX_TEST_SANDBOX_HOME, tmpdir());

interface Job {
	/** argv after `mnemex keychain`. */
	args: string[];
	agent?: boolean;
	/** What the fake keychain already holds, account -> value. */
	stored?: Record<string, string>;
	/** Make `dump-keychain` fail — "I could not ask" vs "there is nothing there". */
	enumerationFails?: boolean;
	/** Force every delete to fail. */
	failDeletes?: boolean;
	/** Force every write to fail. */
	failWrites?: boolean;
	platform?: string;
}

const job: Job = JSON.parse(process.argv[2] ?? "{}");
const store = new Map<string, string>(Object.entries(job.stored ?? {}));
const calls: { args: string[]; stdin?: string }[] = [];

const OK = (stdout = ""): KeychainRunResult => ({
	code: 0,
	stdout,
	stderr: "",
});
const NOT_FOUND = (): KeychainRunResult => ({
	code: 44,
	stdout: "",
	stderr: "security: The specified item could not be found in the keychain.",
});
const FAIL = (stderr: string, code = 1): KeychainRunResult => ({
	code,
	stdout: "",
	stderr,
});

setKeychainTestDeps({
	platform: () => job.platform ?? "darwin",
	run: (args, stdin) => {
		calls.push({ args: [...args], stdin });
		const verb = args[0];

		if (verb === "-i") {
			if (job.failWrites) return FAIL("security: ACL denied");
			const account = stdin?.match(/-a "([^"]*)"/)?.[1];
			const hex = stdin?.match(/-X "([^"]*)"/)?.[1];
			if (!account || hex === undefined) return FAIL("security: bad command");
			// Create-only: `-U` absent means an existing item is a duplicate error.
			if (!stdin?.includes(" -U ") && store.has(account)) {
				return FAIL("security: SecKeychainItemCreateFromContent: -25299", 45);
			}
			store.set(account, Buffer.from(hex, "hex").toString("utf8"));
			return OK();
		}

		if (verb === "find-generic-password") {
			const i = args.indexOf("-a");
			const account = args[i + 1];
			const value = account ? store.get(account) : undefined;
			return value === undefined ? NOT_FOUND() : OK(`${value}\n`);
		}

		if (verb === "delete-generic-password") {
			if (job.failDeletes) return FAIL("security: ACL denied");
			const i = args.indexOf("-a");
			const account = args[i + 1];
			if (!account || !store.has(account)) return NOT_FOUND();
			store.delete(account);
			return OK();
		}

		if (verb === "dump-keychain") {
			if (job.enumerationFails) {
				return FAIL("security: dump-keychain: timed out");
			}
			return OK(
				[...store.keys()]
					.map(
						(a) =>
							`class: "genp"\nattributes:\n    "acct"<blob>="${a}"\n    "svce"<blob>="mnemex"\n`,
					)
					.join(""),
			);
		}

		return FAIL(`security: unknown verb ${verb}`);
	},
});

process.env.MNEMEX_DISABLE_KEYCHAIN = "0";

const configDir = join(homedir(), ".mnemex");
const configPath = join(configDir, "config.json");

// Capture the command's own stdout so the parent can assert on it byte for byte
// without the result envelope getting mixed into it.
const stdout: string[] = [];
const stderr: string[] = [];
const realLog = console.log;
const realError = console.error;
console.log = (...parts: unknown[]) => {
	stdout.push(parts.map(String).join(" "));
};
console.error = (...parts: unknown[]) => {
	stderr.push(parts.map(String).join(" "));
};

let exitCode: number | undefined;
let error: string | undefined;
try {
	exitCode = await handleKeychainCommand(job.args, { agent: job.agent });
} catch (e) {
	error = e instanceof Error ? e.message : String(e);
}

console.log = realLog;
console.error = realError;

const out = {
	exitCode,
	error,
	stdout: stdout.join("\n"),
	stderr: stderr.join("\n"),
	seamCalls: calls.map((c) => c.args[0]),
	storedAfter: Object.fromEntries(store),
	file: existsSync(configPath) ? readFileSync(configPath, "utf-8") : null,
	mode: existsSync(configPath)
		? (statSync(configPath).mode & 0o777).toString(8)
		: null,
};

process.stdout.write(`\n__RESULT__${JSON.stringify(out)}\n`);
