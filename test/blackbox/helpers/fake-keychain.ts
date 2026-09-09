/**
 * Black-box fake for the `/usr/bin/security` seam.
 *
 * Mimics the OBSERVED protocol documented in blackbox-constraints.md and nothing else:
 *   - lookup miss  : exit 44, stderr contains "could not be found"
 *   - lookup hit   : exit 0, stdout = value + exactly one "\n"
 *   - enumeration  : `dump-keychain`, exit 0, text dump with "svce"/"acct" blob lines
 *   - write        : argv ["-i"], command on STDIN, secret as hex after -X
 *   - delete       : `delete-generic-password ... -s mnemex -a <account>`; 0 ok, 44 absent
 *
 * It is an in-memory store keyed by account under service "mnemex". Every call is
 * recorded as `(args, stdin)` — that record is the assertion surface.
 */
import type {
	KeychainDeps,
	KeychainRunResult,
} from "../../../src/core/keychain.js";

export interface FakeKeychainCall {
	args: string[];
	stdin?: string;
}

export interface FakeKeychainOptions {
	/** What `platform()` reports. Default "darwin". */
	platform?: string;
	/** Initial items under service "mnemex": account -> value. */
	store?: Record<string, string>;
	/** Items under OTHER services that appear in the dump (must be ignored by mnemex). */
	foreignItems?: { service: string; account: string }[];
	/** `find-generic-password` fails with a non-44 exit. "locked" uses the real lock message. */
	failRead?: boolean | "locked";
	/** `-i add-generic-password` exits 1 and stores nothing. */
	failWrite?: boolean;
	/** Same, but only for these accounts. */
	failWriteAccounts?: string[];
	/** `-i add-generic-password` exits 0 but the store is NOT updated (silent drop). */
	writeExit0ButDrop?: boolean;
	/** `delete-generic-password` exits 1 (not 44) and removes nothing. */
	failDelete?: boolean;
	/** `dump-keychain` exits 1. */
	failDump?: boolean;
}

export interface FakeKeychain {
	deps: KeychainDeps;
	calls: FakeKeychainCall[];
	store: Map<string, string>;
	options: FakeKeychainOptions;
	/** Calls whose argv or stdin carry a write command. */
	writeCalls(): FakeKeychainCall[];
	readCalls(): FakeKeychainCall[];
	deleteCalls(): FakeKeychainCall[];
	dumpCalls(): FakeKeychainCall[];
	snapshot(): { calls: FakeKeychainCall[]; store: Record<string, string> };
}

const NOT_FOUND: KeychainRunResult = {
	code: 44,
	stdout: "",
	stderr:
		"security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
};

const LOCKED: KeychainRunResult = {
	code: 36,
	stdout: "",
	stderr:
		"security: SecKeychainFindGenericPassword: User interaction is not allowed.",
};

const GENERIC_FAILURE: KeychainRunResult = {
	code: 1,
	stdout: "",
	stderr:
		"security: SecKeychainSearchCopyNext: An unexpected failure occurred.",
};

function flagValue(tokens: string[], flag: string): string | undefined {
	const i = tokens.indexOf(flag);
	return i >= 0 ? tokens[i + 1] : undefined;
}

/** Pull `-a <account>` out of a security command line (quoted or bare). */
function accountFromCommand(cmd: string): string | undefined {
	const m = cmd.match(/(?:^|\s)-a\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+))/);
	if (!m) return undefined;
	return m[1] ?? m[2] ?? m[3];
}

function hexFromCommand(cmd: string): string | undefined {
	const m = cmd.match(/(?:^|\s)-X\s+"?([0-9A-Fa-f]*)"?(?=\s|$)/);
	return m ? m[1] : undefined;
}

function escapeDump(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function itemBlock(
	service: string,
	account: string,
	label: string,
	cls = "genp",
): string {
	return [
		'keychain: "/Users/nobody/Library/Keychains/login.keychain-db"',
		"version: 512",
		`class: "${cls}"`,
		"attributes:",
		`    0x00000007 <blob>="${escapeDump(label)}"`,
		"    0x00000008 <blob>=<NULL>",
		`    "acct"<blob>="${escapeDump(account)}"`,
		'    "cdat"<timedate>=0x32303236303930313030303030305A00  "20260901000000Z\\000"',
		'    "crtr"<uint32>=<NULL>',
		'    "cusi"<sint32>=<NULL>',
		'    "desc"<blob>=<NULL>',
		'    "gena"<blob>=<NULL>',
		'    "icmt"<blob>=<NULL>',
		'    "invi"<sint32>=<NULL>',
		'    "mdat"<timedate>=0x32303236303930313030303030305A00  "20260901000000Z\\000"',
		'    "nega"<sint32>=<NULL>',
		'    "prot"<blob>=<NULL>',
		'    "scrp"<sint32>=<NULL>',
		`    "svce"<blob>="${escapeDump(service)}"`,
		'    "type"<uint32>=<NULL>',
		"",
	].join("\n");
}

export function createFakeKeychain(
	options: FakeKeychainOptions = {},
): FakeKeychain {
	const calls: FakeKeychainCall[] = [];
	const store = new Map<string, string>(Object.entries(options.store ?? {}));

	const run = (args: string[], stdin?: string): KeychainRunResult => {
		calls.push({ args: [...args], stdin });
		const cmd = args[0];

		if (cmd === "find-generic-password") {
			if (options.failRead === "locked") return LOCKED;
			if (options.failRead) return GENERIC_FAILURE;
			const account = flagValue(args, "-a");
			if (account === undefined || !store.has(account)) return NOT_FOUND;
			return { code: 0, stdout: `${store.get(account)}\n`, stderr: "" };
		}

		if (cmd === "delete-generic-password") {
			if (options.failDelete) return GENERIC_FAILURE;
			const account = flagValue(args, "-a");
			if (account === undefined || !store.has(account)) return NOT_FOUND;
			store.delete(account);
			return { code: 0, stdout: "", stderr: "" };
		}

		if (cmd === "dump-keychain") {
			if (options.failDump) return GENERIC_FAILURE;
			let dump = "";
			// A foreign, non-generic item first so parsers must skip it.
			dump += itemBlock(
				"com.example.other",
				"openrouter",
				"Other app: openrouter",
				"inet",
			);
			for (const f of options.foreignItems ?? []) {
				dump += itemBlock(f.service, f.account, `${f.service}: ${f.account}`);
			}
			for (const account of store.keys()) {
				dump += itemBlock(
					"mnemex",
					account,
					`mnemex: ${account.toUpperCase()}`,
				);
			}
			return { code: 0, stdout: dump, stderr: "" };
		}

		// Interactive mode: the command arrives on stdin.
		if (
			cmd === "-i" ||
			(stdin && /add-generic-password|delete-generic-password/.test(stdin))
		) {
			const text = stdin ?? "";
			if (/add-generic-password/.test(text)) {
				const target = accountFromCommand(text);
				if (
					options.failWrite ||
					(target !== undefined && options.failWriteAccounts?.includes(target))
				) {
					return {
						code: 1,
						stdout: "",
						stderr:
							"security: SecKeychainItemCreateFromContent: A write failure occurred.",
					};
				}
				const account = accountFromCommand(text);
				const hex = hexFromCommand(text);
				if (account === undefined || hex === undefined) {
					return {
						code: 1,
						stdout: "",
						stderr: "security: unable to parse add command",
					};
				}
				const update = /(?:^|\s)-U(?=\s|$)/.test(text);
				if (store.has(account) && !update) {
					return {
						code: 45,
						stdout: "",
						stderr:
							"security: SecKeychainItemCreateFromContent: The specified item already exists in the keychain.",
					};
				}
				if (!options.writeExit0ButDrop) {
					store.set(account, Buffer.from(hex, "hex").toString("utf8"));
				}
				return { code: 0, stdout: "", stderr: "" };
			}
			if (/delete-generic-password/.test(text)) {
				if (options.failDelete) return GENERIC_FAILURE;
				const account = accountFromCommand(text);
				if (account === undefined || !store.has(account)) return NOT_FOUND;
				store.delete(account);
				return { code: 0, stdout: "", stderr: "" };
			}
			return {
				code: 1,
				stdout: "",
				stderr: "security: unknown interactive command",
			};
		}

		return {
			code: 1,
			stdout: "",
			stderr: `security: unknown command ${String(cmd)}`,
		};
	};

	const isWrite = (c: FakeKeychainCall) =>
		c.args[0] === "-i" ||
		c.args.includes("add-generic-password") ||
		/add-generic-password/.test(c.stdin ?? "");

	return {
		deps: { platform: () => options.platform ?? "darwin", run },
		calls,
		store,
		options,
		writeCalls: () => calls.filter(isWrite),
		readCalls: () => calls.filter((c) => c.args[0] === "find-generic-password"),
		deleteCalls: () =>
			calls.filter(
				(c) =>
					c.args[0] === "delete-generic-password" ||
					/delete-generic-password/.test(c.stdin ?? ""),
			),
		dumpCalls: () => calls.filter((c) => c.args[0] === "dump-keychain"),
		snapshot: () => ({
			calls: calls.map((c) => ({ args: [...c.args], stdin: c.stdin })),
			store: Object.fromEntries(store),
		}),
	};
}

export function toHex(value: string): string {
	return Buffer.from(value, "utf8").toString("hex");
}

/** True if any argv element of any call contains `needle` (raw or hex-encoded). */
export function argvLeaks(calls: FakeKeychainCall[], secret: string): string[] {
	const hex = toHex(secret);
	const leaks: string[] = [];
	for (const c of calls) {
		for (const a of c.args) {
			if (a.includes(secret) || a.toLowerCase().includes(hex.toLowerCase()))
				leaks.push(a);
		}
	}
	return leaks;
}
