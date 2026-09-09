/**
 * Black-box tests for the keychain ENGINE (src/core/keychain.ts) through its public API and
 * the injectable `KeychainDeps` seam. Written from requirements F1, F4-F7, N1-N5 and rows
 * V1-V7, V10-V12, V15-V16 only — no implementation was read.
 *
 * SAFETY: every test installs the fake seam before any call and asserts at teardown that the
 * real spawn counter never moved.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as kc from "../../src/core/keychain.js";
import {
	argvLeaks,
	createFakeKeychain,
	type FakeKeychain,
	type FakeKeychainOptions,
	toHex,
} from "./helpers/fake-keychain.js";

const SECRET = "kctest-or-BLACKBOX-secret-7f3a9c1e-TAIL1234";
const LABEL = 'mnemex: OPENROUTER_API_KEY (account "openrouter")';
const ALL_ACCOUNTS = [
	"anthropic",
	"cloud",
	"context7",
	"ollama",
	"openrouter",
	"voyage",
];

let fake: FakeKeychain;

function install(opts: FakeKeychainOptions = {}): FakeKeychain {
	fake = createFakeKeychain(opts);
	kc.setKeychainTestDeps(fake.deps);
	kc.invalidateKeychainCache();
	kc.resetKeychainBreaker();
	kc.resetKeychainProcessBudget();
	return fake;
}

/** Run `fn` with stdout/stderr captured; returns what was written. */
function captureStreams(fn: () => void): { stdout: string; stderr: string } {
	const got = { stdout: "", stderr: "" };
	const so = process.stdout.write.bind(process.stdout);
	const se = process.stderr.write.bind(process.stderr);
	const cl = console.log;
	const ce = console.error;
	const cw = console.warn;
	// biome-ignore lint/suspicious/noExplicitAny: stream monkeypatch
	(process.stdout as any).write = (c: unknown) => {
		got.stdout += String(c);
		return true;
	};
	// biome-ignore lint/suspicious/noExplicitAny: stream monkeypatch
	(process.stderr as any).write = (c: unknown) => {
		got.stderr += String(c);
		return true;
	};
	console.log = (...a: unknown[]) => {
		got.stdout += `${a.join(" ")}\n`;
	};
	console.error = (...a: unknown[]) => {
		got.stderr += `${a.join(" ")}\n`;
	};
	console.warn = console.error;
	try {
		fn();
	} finally {
		// biome-ignore lint/suspicious/noExplicitAny: stream restore
		(process.stdout as any).write = so;
		// biome-ignore lint/suspicious/noExplicitAny: stream restore
		(process.stderr as any).write = se;
		console.log = cl;
		console.error = ce;
		console.warn = cw;
	}
	return got;
}

beforeEach(() => {
	install();
});

afterEach(() => {
	kc.setKeychainTestDeps(null);
	// The one property that must hold no matter what any test above did.
	expect(kc.realKeychainSpawnCount()).toBe(0);
});

describe("F4 / V1 — a write never places the secret in argv", () => {
	test("argv is the interactive flag; the command and hex value travel on stdin", () => {
		kc.writeKeychainAccount("openrouter", SECRET, LABEL);

		const writes = fake.writeCalls();
		expect(writes.length).toBeGreaterThanOrEqual(1);
		for (const w of writes) {
			expect(w.args).toContain("-i");
			expect(w.args.join(" ")).not.toContain("add-generic-password");
			expect(w.stdin ?? "").toContain("add-generic-password");
			expect(w.stdin ?? "").toContain(toHex(SECRET));
		}
		expect(argvLeaks(fake.calls, SECRET)).toEqual([]);
		expect(fake.store.get("openrouter")).toBe(SECRET);
	});

	test("the write targets service 'mnemex' and the requested account", () => {
		kc.writeKeychainAccount("voyage", SECRET, LABEL);
		const w = fake.writeCalls()[0];
		expect(w.stdin ?? "").toMatch(/-s\s+"?mnemex"?/);
		expect(w.stdin ?? "").toMatch(/-a\s+"?voyage"?/);
		expect(kc.KEYCHAIN_SERVICE).toBe("mnemex");
	});
});

describe("F7 — a write is verified by reading the value back", () => {
	test("a successful write is followed by a read of the same account", () => {
		kc.writeKeychainAccount("openrouter", SECRET, LABEL);
		const writeIdx = fake.calls.findIndex((c) => c.args.includes("-i"));
		const readAfter = fake.calls.findIndex(
			(c, i) =>
				i > writeIdx &&
				c.args[0] === "find-generic-password" &&
				c.args.includes("openrouter"),
		);
		expect(writeIdx).toBeGreaterThanOrEqual(0);
		expect(readAfter).toBeGreaterThan(writeIdx);
	});

	test("exit 0 without a round-trip is a FAILURE, not a success", () => {
		install({ writeExit0ButDrop: true });
		expect(() =>
			kc.writeKeychainAccount("openrouter", SECRET, LABEL),
		).toThrow();
	});

	test("a failed write throws a KeychainError carrying the exit code", () => {
		install({ failWrite: true });
		let err: unknown;
		try {
			kc.writeKeychainAccount("openrouter", SECRET, LABEL);
		} catch (e) {
			err = e;
		}
		expect(err).toBeInstanceOf(kc.KeychainError);
		expect((err as kc.KeychainError).exitCode).toBe(1);
		expect((err as Error).message).not.toContain(SECRET);
	});

	test("overwriting an existing item lands the NEW value (real security answers 45 without -U)", () => {
		install({ store: { openrouter: "OLD-value-0000" } });
		kc.writeKeychainAccount("openrouter", SECRET, LABEL);
		expect(fake.store.get("openrouter")).toBe(SECRET);
		expect(kc.readKeychainAccount("openrouter")).toEqual({
			status: "found",
			value: SECRET,
		});
	});
});

describe("V2 — hostile values round-trip byte-for-byte", () => {
	const values = [
		"a b",
		'he said "hi"',
		"it's",
		"back\\slash",
		"$HOME and `cmd` and ;rm",
		"  padded  ",
		"unicode-héllo-→-日本-🔑",
		"-w",
		"--",
		"-X deadbeef",
		"x".repeat(2000),
	];
	for (const v of values) {
		test(`round-trips ${JSON.stringify(v.slice(0, 24))}${v.length > 24 ? "…" : ""}`, () => {
			install();
			kc.writeKeychainAccount("openrouter", v, LABEL);
			kc.invalidateKeychainCache();
			expect(kc.readKeychainAccount("openrouter")).toEqual({
				status: "found",
				value: v,
			});
			// Position-precise argv check. A WRITE may carry nothing but the interactive
			// flag; the value travels on stdin as hex. A READ may carry only the fixed
			// flags plus the service and account VALUES — so the only non-flag tokens
			// allowed anywhere in a read's argv are "mnemex" and "openrouter". A secret
			// that happens to equal a flag (this list includes "-w") therefore cannot
			// hide in either shape, and a legitimate flag is never mistaken for a leak.
			const READ_FLAGS = new Set(["-s", "-a", "-w"]);
			for (const c of fake.calls) {
				if (c.args.includes("-i")) {
					expect(c.args).toEqual(["-i"]);
					expect(c.stdin ?? "").toContain(toHex(v));
					continue;
				}
				expect(c.args[0]).toBe("find-generic-password");
				const values = c.args.slice(1).filter((t) => !READ_FLAGS.has(t));
				expect(values).toEqual(["mnemex", "openrouter"]);
			}
		});
	}
});

describe("V3 — control characters are rejected at WRITE time, before any spawn", () => {
	const bad = [
		"a\nb",
		"a\rb",
		"a\tb",
		"a\x00b",
		"a\x1b[31mb",
		"\n",
		"trailing\n",
		"\x07bell",
	];
	for (const v of bad) {
		test(`rejects ${JSON.stringify(v)} without invoking the seam`, () => {
			expect(() => kc.writeKeychainAccount("openrouter", v, LABEL)).toThrow();
			expect(fake.calls.length).toBe(0);
			expect(kc.describeUnstorableValue(v)).not.toBeNull();
		});
	}

	test("describeUnstorableValue accepts ordinary and merely-awkward values", () => {
		for (const v of ["plain", "with space", 'q"uote', "uni-→", "$dollar"]) {
			expect(kc.describeUnstorableValue(v)).toBeNull();
		}
	});
});

describe("V4 — exactly one trailing newline is stripped, never trim()", () => {
	const cases: [string, string][] = [
		[" key \n", " key "],
		["v\n\n", "v\n"],
		["v", "v"],
		["\tkey\n", "\tkey"],
	];
	for (const [raw, want] of cases) {
		test(`stdout ${JSON.stringify(raw)} reads as ${JSON.stringify(want)}`, () => {
			kc.setKeychainTestDeps({
				platform: () => "darwin",
				run: () => ({ code: 0, stdout: raw, stderr: "" }),
			});
			kc.invalidateKeychainCache();
			expect(kc.readKeychainAccount("openrouter")).toEqual({
				status: "found",
				value: want,
			});
		});
	}
});

describe("F6 / V10 / V11 — failure is distinguishable from absence", () => {
	test("exit 44 is ABSENT: {present:false, failed:false} and status 'absent'", () => {
		expect(kc.lookupKeychainAccount("openrouter")).toEqual({
			present: false,
			failed: false,
		});
		kc.invalidateKeychainCache();
		expect(kc.readKeychainAccount("openrouter")).toEqual({ status: "absent" });
	});

	test("a non-44 error is FAILED, never reported as merely absent", () => {
		install({ failRead: true });
		const look = kc.lookupKeychainAccount("openrouter");
		expect(look.failed).toBe(true);
		kc.invalidateKeychainCache();
		kc.resetKeychainBreaker();
		const read = kc.readKeychainAccount("openrouter");
		expect(read.status).toBe("failed");
		if (read.status === "failed") {
			expect(read.error.length).toBeGreaterThan(0);
			expect(read.exitCode).toBe(1);
		}
	});

	test("a locked keychain (user interaction not allowed) is FAILED", () => {
		install({ failRead: "locked" });
		const read = kc.readKeychainAccount("openrouter");
		expect(read.status).toBe("failed");
		expect(kc.lookupKeychainAccount("voyage").failed).toBe(true);
	});

	test("a failed enumeration says so and returns no accounts", () => {
		install({ failDump: true, store: { openrouter: "x" } });
		const e = kc.enumerateKeychainAccounts();
		expect(e.failed).toBe(true);
		expect(e.accounts).toEqual([]);
		expect(typeof e.error).toBe("string");
	});
});

describe("F5 / V7 — enumeration answers for every key in ONE spawn", () => {
	test("one dump-keychain call lists all mnemex accounts, sorted, ignoring other services", () => {
		install({
			store: Object.fromEntries(ALL_ACCOUNTS.map((a) => [a, `v-${a}`])),
			foreignItems: [
				{ service: "com.example.other", account: "foreign-only" },
				{ service: "mnemex-lookalike", account: "openrouter" },
			],
		});
		const e = kc.enumerateKeychainAccounts();
		expect(e.failed).toBe(false);
		expect(e.accounts).toEqual(ALL_ACCOUNTS);
		expect(e.accounts).not.toContain("foreign-only");
		expect(fake.calls.length).toBe(1);
		expect(fake.calls[0].args[0]).toBe("dump-keychain");
		expect(fake.calls[0].args).not.toContain("-d");
	});

	test("parseDumpAccounts extracts only service-mnemex accounts from a raw dump", () => {
		install({
			store: { openrouter: "a", ollama: "b" },
			foreignItems: [{ service: "other", account: "not-ours" }],
		});
		const dump = fake.deps.run(["dump-keychain"]).stdout;
		expect(kc.parseDumpAccounts(dump).sort()).toEqual(["ollama", "openrouter"]);
		expect(kc.parseDumpAccounts("")).toEqual([]);
	});
});

describe("N1 / V5 / V6 — burst memo", () => {
	test("a repeat read inside the burst costs zero spawns; invalidation costs one more", () => {
		install({ store: { openrouter: SECRET } });
		expect(kc.readKeychainAccount("openrouter")).toEqual({
			status: "found",
			value: SECRET,
		});
		const afterCold = fake.calls.length;
		expect(afterCold).toBeLessThanOrEqual(1);
		kc.readKeychainAccount("openrouter");
		kc.lookupKeychainAccount("openrouter");
		expect(fake.calls.length).toBe(afterCold);
		kc.invalidateKeychainCache();
		kc.readKeychainAccount("openrouter");
		expect(fake.calls.length).toBe(afterCold + 1);
	});

	test("the memo does not conflate accounts", () => {
		install({ store: { openrouter: "A-1111", voyage: "B-2222" } });
		expect(kc.readKeychainAccount("openrouter")).toEqual({
			status: "found",
			value: "A-1111",
		});
		expect(kc.readKeychainAccount("voyage")).toEqual({
			status: "found",
			value: "B-2222",
		});
		expect(kc.readKeychainAccount("anthropic")).toEqual({ status: "absent" });
	});
});

describe("V12 — a lock failure is not retried per key within a burst", () => {
	test("six lookups after one lock failure cost ONE spawn total", () => {
		install({ failRead: "locked" });
		for (const a of ALL_ACCOUNTS) {
			expect(kc.lookupKeychainAccount(a).failed).toBe(true);
		}
		expect(fake.calls.length).toBe(1);
	});

	test("six reads after one lock failure cost ONE spawn total", () => {
		install({ failRead: "locked" });
		for (const a of ALL_ACCOUNTS) {
			expect(kc.readKeychainAccount(a).status).toBe("failed");
		}
		expect(fake.calls.length).toBe(1);
	});

	test("a failed enumeration followed by five per-key lookups still costs ONE spawn", () => {
		install({ failDump: true, failRead: true });
		expect(kc.enumerateKeychainAccounts().failed).toBe(true);
		for (const a of ALL_ACCOUNTS.slice(0, 5)) kc.lookupKeychainAccount(a);
		expect(fake.calls.length).toBe(1);
	});
});

describe("V16 / A1 — short account names resolve", () => {
	test("items under the six short accounts are found", () => {
		install({
			store: Object.fromEntries(ALL_ACCOUNTS.map((a) => [a, `val-${a}`])),
		});
		for (const a of ALL_ACCOUNTS) {
			expect(kc.readKeychainAccount(a)).toEqual({
				status: "found",
				value: `val-${a}`,
			});
			expect(kc.lookupKeychainAccount(a)).toEqual({
				present: true,
				failed: false,
			});
		}
	});
});

describe("N5 — non-darwin platforms never spawn", () => {
	for (const platform of ["linux", "win32"]) {
		test(`${platform}: unsupported, with a reason, and no seam call for any operation`, () => {
			install({ platform, store: { openrouter: "should-not-be-reachable" } });
			expect(kc.isKeychainSupported()).toBe(false);
			expect(kc.isKeychainAvailable()).toBe(false);
			expect(typeof kc.keychainUnavailableReason()).toBe("string");

			expect(kc.readKeychainAccount("openrouter").status).not.toBe("found");
			expect(kc.lookupKeychainAccount("openrouter").present).toBe(false);
			expect(kc.enumerateKeychainAccounts().accounts).toEqual([]);
			expect(() =>
				kc.writeKeychainAccount("openrouter", SECRET, LABEL),
			).toThrow();
			try {
				kc.deleteKeychainAccount("openrouter");
			} catch {
				// throwing is acceptable; spawning is not
			}
			expect(fake.calls.length).toBe(0);
		});
	}

	test("darwin: supported with no unavailable reason", () => {
		expect(kc.isKeychainSupported()).toBe(true);
		expect(kc.isKeychainAvailable()).toBe(true);
		expect(kc.keychainUnavailableReason()).toBeNull();
	});
});

describe("delete semantics", () => {
	test("deletes an existing item via delete-generic-password -s mnemex -a <account>", () => {
		install({ store: { openrouter: SECRET } });
		expect(kc.deleteKeychainAccount("openrouter")).toBe(true);
		expect(fake.store.has("openrouter")).toBe(false);
		const d = fake.deleteCalls()[0];
		expect(d.args[0]).toBe("delete-generic-password");
		expect(d.args.slice(1)).toEqual(
			expect.arrayContaining(["-s", "mnemex", "-a", "openrouter"]),
		);
		expect(argvLeaks(fake.calls, SECRET)).toEqual([]);
	});

	test("deleting an absent item (exit 44) returns false without throwing", () => {
		expect(kc.deleteKeychainAccount("openrouter")).toBe(false);
	});

	test("a real delete failure throws", () => {
		install({ store: { openrouter: SECRET }, failDelete: true });
		expect(() => kc.deleteKeychainAccount("openrouter")).toThrow(
			kc.KeychainError,
		);
		expect(fake.store.get("openrouter")).toBe(SECRET);
	});
});

describe("N2 — maskSecret reveals at most a 4-character tail", () => {
	test("shows the last 4 characters and nothing else of the secret", () => {
		const m = kc.maskSecret(SECRET);
		expect(m).toContain("1234");
		expect(m).not.toContain("L1234");
		expect(m).not.toContain("kctest-or");
		for (let i = 0; i + 5 <= SECRET.length; i++) {
			expect(m).not.toContain(SECRET.slice(i, i + 5));
		}
	});

	test("does not throw on empty input", () => {
		expect(() => kc.maskSecret("")).not.toThrow();
	});
});

describe("N2 / V15 — nothing reaches stdout, and stderr never carries the secret", () => {
	test("across every operation including failures", () => {
		const got = captureStreams(() => {
			install({ store: { voyage: SECRET } });
			kc.writeKeychainAccount("openrouter", SECRET, LABEL);
			kc.readKeychainAccount("openrouter");
			kc.readKeychainAccount("missing");
			kc.enumerateKeychainAccounts();
			kc.deleteKeychainAccount("openrouter");
			kc.deleteKeychainAccount("openrouter");

			install({ failWrite: true });
			try {
				kc.writeKeychainAccount("openrouter", SECRET, LABEL);
			} catch {}
			install({ failRead: "locked" });
			kc.readKeychainAccount("openrouter");
			kc.lookupKeychainAccount("openrouter");
			install({ failDump: true });
			kc.enumerateKeychainAccounts();
			install({ failDelete: true, store: { openrouter: SECRET } });
			try {
				kc.deleteKeychainAccount("openrouter");
			} catch {}
			install({ platform: "linux" });
			try {
				kc.writeKeychainAccount("openrouter", SECRET, LABEL);
			} catch {}
		});
		expect(got.stdout).toBe("");
		expect(got.stderr).not.toContain(SECRET);
		expect(got.stderr).not.toContain(toHex(SECRET));
	});
});

describe("hard spawn timeout is declared and bounded", () => {
	test("timeouts exist, are positive, and fit within the per-process budget", () => {
		expect(kc.SPAWN_TIMEOUT_MS).toBeGreaterThan(0);
		expect(kc.ENUMERATE_TIMEOUT_MS).toBeGreaterThan(0);
		expect(kc.KEYCHAIN_PROCESS_BUDGET_MS).toBeGreaterThanOrEqual(
			kc.SPAWN_TIMEOUT_MS,
		);
		// A locked keychain must not be able to hold the process past the index-lock staleness rule.
		expect(kc.KEYCHAIN_PROCESS_BUDGET_MS).toBeLessThan(10_000);
	});
});
