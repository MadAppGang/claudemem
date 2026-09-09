/**
 * `~/.mnemex/config.json` as a SECRET STORE — the bytes that reach disk.
 *
 * Covers V17, V18, V20, V21, V22 and V24.
 *
 * Every case runs in a CHILD bun process with `HOME` pointed at a temp directory,
 * because `GLOBAL_CONFIG_DIR` is a module-level const evaluated at import from
 * `homedir()`. Setting `HOME` in a `beforeEach` inside this process would do
 * nothing at all.
 *
 * The child spawns `bun`, never `/usr/bin/security`: it installs the stub seam
 * before touching anything, and inherits MNEMEX_KEYCHAIN_TEST_GUARD=1.
 *
 * These are the rows nothing else covers. Every other test asserts on `jsonSafe`
 * or on argv; an object spread cannot delete a field, so only the file's bytes can
 * prove a stored secret actually left the config.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHILD = join(import.meta.dir, "../../helpers/global-config-child.ts");

let home: string;
let configDir: string;
let configPath: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "mnemex-cfg-"));
	configDir = join(home, ".mnemex");
	configPath = join(configDir, "config.json");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

interface ChildResult {
	report: {
		outcomes?: { id: string; field: string; stored: string; reason?: string }[];
		storedInKeychain?: string[];
		keptInConfigFile?: string[];
		omittedKeychainSourced?: string[];
		anyFailed?: boolean;
		corruptFilePreservedAs?: string;
		pruned?: string[];
		refused?: { id: string; reason: string }[];
		aborted?: boolean;
		abortReason?: string;
	} | null;
	removal: { removed: string[]; skipped: string[] } | null;
	error?: string;
	file: string | null;
	mode: string | null;
	dirMode: string | null;
	corruptFiles: string[];
	tmpFiles: string[];
	storedAfter: Record<string, string>;
}

function runChild(job: Record<string, unknown>): ChildResult {
	const proc = Bun.spawnSync({
		cmd: ["bun", "run", CHILD, JSON.stringify(job)],
		env: {
			...process.env,
			HOME: home, // MUST be set before the child starts — see the file header.
			// The child refuses to run unless `homedir()` agrees with this AND is
			// inside `tmpdir()`. A probe that set HOME at runtime instead of here hit
			// a real user's config file during review; the child now proves it is
			// sandboxed rather than trusting the caller.
			MNEMEX_TEST_SANDBOX_HOME: home,
			MNEMEX_KEYCHAIN_TEST_GUARD: "1",
			MNEMEX_DISABLE_KEYCHAIN: "0",
		},
		stdout: "pipe",
		stderr: "pipe",
	});

	const stdout = proc.stdout.toString();
	const marker = stdout.indexOf("__RESULT__");
	if (marker < 0) {
		throw new Error(
			`child produced no result.\nstdout: ${stdout}\nstderr: ${proc.stderr.toString()}`,
		);
	}
	return JSON.parse(stdout.slice(marker + "__RESULT__".length));
}

function seed(content: string, mode = 0o644): void {
	mkdirSync(configDir, { recursive: true });
	writeFileSync(configPath, content, "utf-8");
	chmodSync(configPath, mode);
}

// ============================================================================
// V17 — a stored secret is ABSENT from the bytes written to disk
// ============================================================================

describe("V17 — a verified keychain write removes the secret from config.json", () => {
	test("an existing plaintext key is NOT restored by the merge", () => {
		// This is the state of every user upgrading from <= 0.32.0.
		seed(
			JSON.stringify(
				{ openrouterApiKey: "kctest-or-OLD", defaultModel: "m" },
				null,
				2,
			),
		);

		const result = runChild({ save: { openrouterApiKey: "kctest-or-NEW" } });

		expect(result.report?.storedInKeychain).toEqual(["openrouter"]);
		expect(result.file).not.toBeNull();

		const written = JSON.parse(result.file ?? "{}");
		// The whole point: `{...existing, ...jsonSafe}` would take `openrouterApiKey`
		// straight back out of `existing`, and the CLI would print "It is NOT in
		// ~/.mnemex/config.json" while it demonstrably was.
		expect(written).not.toHaveProperty("openrouterApiKey");
		expect(result.file).not.toContain("kctest-or-OLD");
		expect(result.file).not.toContain("kctest-or-NEW");
		// Unrelated settings survive.
		expect(written.defaultModel).toBe("m");
		// And the value really is in the keychain.
		expect(result.storedAfter.openrouter).toBe("kctest-or-NEW");
	});

	test("a CONFIRMED clear also leaves no trace in the file", () => {
		seed(JSON.stringify({ voyageApiKey: "kctest-voy-OLD" }, null, 2));
		const result = runChild({
			stored: { voyage: "kctest-voy-OLD" },
			save: { voyageApiKey: "" },
		});

		expect(result.report?.outcomes?.[0]?.stored).toBe("cleared");
		expect(JSON.parse(result.file ?? "{}")).not.toHaveProperty("voyageApiKey");
		expect(result.storedAfter).not.toHaveProperty("voyage");
	});
});

// ============================================================================
// V18 — a FAILED write leaves the INCOMING value, not the stale one
// ============================================================================

describe("V18 — a failed write keeps the incoming value in the file", () => {
	test("existing OLD, incoming NEW, write fails -> the file holds NEW", () => {
		seed(JSON.stringify({ openrouterApiKey: "kctest-or-OLD" }, null, 2));

		const result = runChild({
			failWrites: true,
			save: { openrouterApiKey: "kctest-or-NEW" },
		});

		const written = JSON.parse(result.file ?? "{}");
		// The V17 fix must not overcorrect into deleting a field whose write FAILED
		// — that is the original key-loss defect, pointing the other way.
		expect(written.openrouterApiKey).toBe("kctest-or-NEW");
		expect(result.report?.anyFailed).toBe(true);
		expect(result.report?.keptInConfigFile).toContain("openrouter");
	});

	test("off-darwin the key reaches the file untouched, with no spawn", () => {
		const result = runChild({
			platform: "linux",
			save: {
				openrouterApiKey: "kctest-or-REAL-SECRET",
				defaultModel: "voyage-3.5-lite",
			},
		});

		const written = JSON.parse(result.file ?? "{}");
		expect(written).toEqual({
			openrouterApiKey: "kctest-or-REAL-SECRET",
			defaultModel: "voyage-3.5-lite",
		});
	});
});

// ============================================================================
// V24 — a failed delete KEEPS the field
// ============================================================================

describe("V24 — a failed delete reports clear-failed and keeps the field", () => {
	test("the field survives in the written bytes", () => {
		seed(JSON.stringify({ voyageApiKey: "kctest-voy-OLD" }, null, 2));

		const result = runChild({
			stored: { voyage: "kctest-voy-OLD" },
			failDeletes: true,
			save: { voyageApiKey: "" },
		});

		expect(result.report?.outcomes?.[0]?.stored).toBe("clear-failed");
		// Kept as "" — falsy, so it shadows nothing, but the user is not told a key
		// was cleared while a fully resolvable item survives.
		expect(JSON.parse(result.file ?? "{}")).toHaveProperty("voyageApiKey", "");
		expect(result.storedAfter.voyage).toBe("kctest-voy-OLD");
	});
});

// ============================================================================
// V20 — permissions
// ============================================================================

describe("V20 — a pre-existing 0644 config.json ends at 0600", () => {
	test("mode 644 -> 600 on any save, including one carrying no secret", () => {
		seed(JSON.stringify({ defaultModel: "m" }, null, 2), 0o644);
		expect((statSync(configPath).mode & 0o777).toString(8)).toBe("644");

		// MEASURED: writeFileSync's `mode:` option is IGNORED on an existing file,
		// so only an explicit chmodSync reaches 600 — and the population this
		// control protects is exactly the one `mode:` cannot reach.
		const result = runChild({ save: { llmEndpoint: "http://x/v1" } });

		expect(result.mode).toBe("600");
		// The DIRECTORY is a different matter, and the same measured gotcha applies:
		// mkdirSync's `mode:` is ignored for a directory that already exists. It is
		// deliberately NOT chmod-ed — F9 names the config FILE, an existing
		// ~/.mnemex may hold things a user has arranged, and a 0600 file inside a
		// 0755 directory is already unreadable by anyone else.
		expect(result.dirMode).toBe("755");
	});

	test("a fresh config directory is created at 0700", () => {
		const result = runChild({ save: { defaultModel: "m" } });
		expect(result.dirMode).toBe("700");
		expect(result.mode).toBe("600");
	});

	test("no temp file is left behind", () => {
		seed(JSON.stringify({ defaultModel: "m" }, null, 2));
		const result = runChild({ save: { defaultModel: "n" } });
		expect(result.tmpFiles).toEqual([]);
	});
});

// ============================================================================
// V21 — an unparseable config.json is preserved, never overwritten
// ============================================================================

describe("V21 — a corrupt config.json is preserved, not merged over", () => {
	test("the original bytes are kept as config.json.corrupt-*", () => {
		// A truncated write used to make loadGlobalConfig return defaults, after
		// which the next save wrote defaults over it and permanently discarded every
		// setting AND every plaintext secret.
		const truncated = '{"openrouterApiKey": "kctest-or-OLD", "defaultMod';
		seed(truncated);

		const result = runChild({ save: { defaultModel: "m" } });

		expect(result.corruptFiles).toHaveLength(1);
		const preserved = readFileSync(
			join(configDir, result.corruptFiles[0] ?? ""),
			"utf-8",
		);
		expect(preserved).toBe(truncated);
		expect(result.report?.corruptFilePreservedAs).toContain(".corrupt-");

		// The new file is a clean write of what was actually supplied.
		expect(JSON.parse(result.file ?? "{}")).toEqual({ defaultModel: "m" });
	});

	test("a JSON array is treated as corrupt too", () => {
		seed("[1,2,3]");
		const result = runChild({ save: { defaultModel: "m" } });
		expect(result.corruptFiles).toHaveLength(1);
	});
});

// ============================================================================
// V22 — prune refuses by name, and writes exactly the verified subset
// ============================================================================

describe("V22 — prune refuses any id that does not re-verify", () => {
	test("a mismatching id keeps its plaintext copy and is named", () => {
		seed(
			JSON.stringify(
				{
					openrouterApiKey: "kctest-or-MATCHES",
					voyageApiKey: "kctest-voy-FILE-COPY",
					defaultModel: "m",
				},
				null,
				2,
			),
		);

		const result = runChild({
			prune: true,
			stored: {
				openrouter: "kctest-or-MATCHES",
				voyage: "kctest-voy-DIFFERENT-IN-KEYCHAIN",
			},
		});

		expect(result.report?.pruned).toEqual(["openrouter"]);
		expect(result.report?.refused?.[0]?.id).toBe("voyage");
		// The refusal must name the concrete remedy, not just say "does not
		// re-verify", which sounds like corruption.
		expect(result.report?.refused?.[0]?.reason).toContain("keychain value");

		// A MIXED prune: exactly the verified subset removed, in ONE atomic write.
		const written = JSON.parse(result.file ?? "{}");
		expect(written).not.toHaveProperty("openrouterApiKey");
		expect(written.voyageApiKey).toBe("kctest-voy-FILE-COPY");
		expect(written.defaultModel).toBe("m");
	});

	test("a READ FAILURE aborts the whole prune and writes nothing", () => {
		const original = JSON.stringify(
			{ openrouterApiKey: "kctest-or-A", voyageApiKey: "kctest-voy-B" },
			null,
			2,
		);
		seed(original);

		const result = runChild({ prune: true, failReads: true });

		expect(result.report?.aborted).toBe(true);
		expect(result.report?.pruned).toEqual([]);
		// A keychain that just stopped answering is the worst possible moment to
		// delete the last plaintext copy of a key.
		expect(JSON.parse(result.file ?? "{}")).toEqual({
			openrouterApiKey: "kctest-or-A",
			voyageApiKey: "kctest-voy-B",
		});
	});

	test("an id that is not stored at all is refused, not pruned", () => {
		seed(JSON.stringify({ openrouterApiKey: "kctest-or-A" }, null, 2));
		const result = runChild({ prune: true, stored: {} });

		expect(result.report?.pruned).toEqual([]);
		expect(result.report?.refused?.[0]?.reason).toContain("migrate");
		expect(JSON.parse(result.file ?? "{}").openrouterApiKey).toBe(
			"kctest-or-A",
		);
	});
});

// ============================================================================
// The save path never touches the keychain when it carries no secret
// ============================================================================

describe("a save carrying no secret leaves every item alone", () => {
	test("file-resident plaintext secrets ride along untouched", () => {
		seed(
			JSON.stringify(
				{ openrouterApiKey: "kctest-or-STALE-IN-FILE", defaultModel: "m" },
				null,
				2,
			),
		);

		const result = runChild({
			stored: { openrouter: "kctest-or-NEWER-IN-KEYCHAIN" },
			save: { llmEndpoint: "http://localhost:1234/v1" },
		});

		expect(result.report?.outcomes).toEqual([]);
		// The keychain value the user just set is untouched: nothing offered it the
		// file's stale copy.
		expect(result.storedAfter.openrouter).toBe("kctest-or-NEWER-IN-KEYCHAIN");

		const written = JSON.parse(result.file ?? "{}");
		expect(written.openrouterApiKey).toBe("kctest-or-STALE-IN-FILE");
		expect(written.llmEndpoint).toBe("http://localhost:1234/v1");
	});
});

// ============================================================================
// A1 / I4 — an explicit `undefined` must NOT delete the value on disk
// ============================================================================

/**
 * Reproduced during review:
 *   BEFORE   { "openrouterApiKey": "kctest-or-PLAINTEXT", "defaultModel": "m" }
 *   CALL     saveGlobalConfig({ openrouterApiKey: undefined, defaultModel: "n" })
 *   OUTCOMES []
 *   AFTER    { "defaultModel": "n" }
 *
 * The only copy of a key destroyed, with no keychain operation attempted and
 * nothing in the report to say so — defect D1, the exact failure this feature
 * exists to remove, arriving through the merge. `persistSecrets` skips an
 * `undefined` field and records nothing, `jsonSafe` keeps the key at `undefined`,
 * the spread overwrites the real value, and `JSON.stringify` drops it.
 *
 * The existing test for this case asserted on `stub.calls` and `report.outcomes`
 * and never on the file — the keychain side was fine; the bytes were not. These
 * rows assert on the bytes. They need `saveUndefined` rather than a value because
 * `undefined` cannot cross `JSON.stringify` into the child.
 */
describe("A1 — an explicitly undefined secret field is UNTOUCHED, not deleted", () => {
	test("a plaintext-only key survives a save that passes it as undefined", () => {
		seed(
			JSON.stringify({
				openrouterApiKey: "kctest-or-PLAINTEXT",
				defaultModel: "m",
			}),
		);

		const result = runChild({
			save: { defaultModel: "n" },
			saveUndefined: ["openrouterApiKey"],
		});

		const written = JSON.parse(result.file ?? "{}");
		// THE BYTES. Before the fix this key was gone from the file entirely.
		expect(written.openrouterApiKey).toBe("kctest-or-PLAINTEXT");
		expect(written.defaultModel).toBe("n");
		// No keychain operation was attempted, which is the part that was already
		// true and is why the report could not catch this.
		expect(result.report?.outcomes).toEqual([]);
		expect(result.storedAfter.openrouter).toBeUndefined();
	});

	test("the rule is not secret-specific: an undefined ordinary field survives too", () => {
		// `SetupApp.tsx` writes `globalPart.defaultModel = state.model || undefined`
		// and means "leave it alone". It used to mean "delete it".
		seed(JSON.stringify({ defaultModel: "nomic-embed-text", learning: true }));

		const result = runChild({
			save: { learning: false },
			saveUndefined: ["defaultModel"],
		});

		const written = JSON.parse(result.file ?? "{}");
		expect(written.defaultModel).toBe("nomic-embed-text");
		expect(written.learning).toBe(false);
	});

	test('"" still CLEARS — I3 is unchanged', () => {
		// The one value that deletes. If `undefined` and `""` had been conflated the
		// fix would have broken the documented clear path.
		seed(JSON.stringify({ openrouterApiKey: "kctest-or-OLD" }));

		const result = runChild({
			stored: { openrouter: "kctest-or-OLD" },
			save: { openrouterApiKey: "" },
		});

		const written = JSON.parse(result.file ?? "{}");
		expect(written).not.toHaveProperty("openrouterApiKey");
		expect(result.report?.outcomes?.[0]?.stored).toBe("cleared");
		expect(result.storedAfter.openrouter).toBeUndefined();
	});
});

// ============================================================================
// C1 — a secret that came FROM the keychain is never written to the file
// ============================================================================

/**
 * Observed on a real `~/.mnemex/config.json`, which gained live `voyageApiKey`
 * and `context7ApiKey` values in the clear.
 *
 * `loadGlobalConfigWithSecrets()` overlays keychain values onto the config object
 * it returns. The caller edits something unrelated and hands the whole object
 * back. `persistSecrets` cannot tell those values from ones the user typed, so
 * when the keychain write could not be proven it recorded `config-file` and wrote
 * them to disk — putting a secret back into plaintext that the user had already
 * moved into the Keychain.
 */
describe("C1 — hydrated keychain values do not pass through the save into the file", () => {
	test("an unprovable write does NOT flush a hydrated value into config.json", () => {
		// The precise sequence. `persistSecrets` stops at the first write failure in
		// a pass — a locked keychain blocks each spawn for its full timeout, so six
		// writes would cost six timeouts. Every LATER field is then recorded without
		// any keychain operation at all. `openrouter` is first in `SECRET_SPECS`, so
		// a fresh key that fails to store poisons the pass for `voyage` and
		// `context7`, whose values came out of the keychain during hydration.
		//
		// Before the fix those two were written to `config.json` in plaintext.
		seed(JSON.stringify({ defaultModel: "m" }));

		const result = runChild({
			stored: {
				voyage: "kctest-voy-FROM-KEYCHAIN",
				context7: "ctx-FROM-KEYCHAIN",
			},
			hydrateFirst: true,
			failWrites: true,
			save: { defaultModel: "n", openrouterApiKey: "kctest-or-TYPED-BY-USER" },
		});

		// THE BYTES.
		expect(result.file).not.toContain("kctest-voy-FROM-KEYCHAIN");
		expect(result.file).not.toContain("ctx-FROM-KEYCHAIN");
		const written = JSON.parse(result.file ?? "{}");
		expect(written).not.toHaveProperty("voyageApiKey");
		expect(written).not.toHaveProperty("context7ApiKey");
		expect(written.defaultModel).toBe("n");

		// The items are still in the keychain, so nothing was lost.
		expect(result.storedAfter.voyage).toBe("kctest-voy-FROM-KEYCHAIN");
		expect(result.storedAfter.context7).toBe("ctx-FROM-KEYCHAIN");

		// The report says why, rather than silently claiming a clean write.
		//
		// AND IT DOES NOT SAY "keychain". That disposition means "proven stored by
		// THIS call" and is the one that authorises deletion from the file; this
		// save proved nothing. Two external reviewers found the overload from
		// opposite ends — see `keychain-disposition-proof.test.ts` for the file-byte
		// consequence it used to have.
		const voyage = result.report?.outcomes?.find((o) => o.id === "voyage");
		expect(voyage?.stored).toBe("keychain-sourced-omitted");
		expect(voyage?.reason).toContain("read FROM the Keychain");
		expect(voyage?.reason).toContain("did NOT verify");
		expect(result.report?.storedInKeychain).not.toContain("voyage");
		expect(result.report?.omittedKeychainSourced).toContain("voyage");

		// And the key the USER typed in the same save is still kept, because it has
		// nowhere else to live. The two rules are decided per field, not per save.
		expect(written.openrouterApiKey).toBe("kctest-or-TYPED-BY-USER");
	});

	test("a value the USER typed is still kept in the file when the write fails", () => {
		// The other half of the rule, and the one that must not regress: a failed
		// write for a fresh value must NOT delete it. That is D1.
		seed(JSON.stringify({ defaultModel: "m" }));

		const result = runChild({
			failWrites: true,
			save: { openrouterApiKey: "kctest-or-TYPED-BY-USER" },
		});

		const written = JSON.parse(result.file ?? "{}");
		expect(written.openrouterApiKey).toBe("kctest-or-TYPED-BY-USER");
		expect(
			result.report?.outcomes?.find((o) => o.id === "openrouter")?.stored,
		).toBe("config-file");
	});

	test("a hydrated value that is re-verified is omitted, as before", () => {
		// The happy path still works through the read-before-write proof rather than
		// through provenance, and must stay clean.
		seed(JSON.stringify({ defaultModel: "m" }));

		const result = runChild({
			stored: { voyage: "kctest-voy-FROM-KEYCHAIN" },
			hydrateFirst: true,
			save: { defaultModel: "n" },
		});

		expect(result.file).not.toContain("kctest-voy-FROM-KEYCHAIN");
		expect(result.storedAfter.voyage).toBe("kctest-voy-FROM-KEYCHAIN");
	});
});

// ============================================================================
// C2 — `excludePatterns` must not grow by 102 entries on every save
// ============================================================================

/**
 * `loadGlobalConfig` prepends all 102 `DEFAULT_EXCLUDE_PATTERNS`; `saveGlobalConfig`
 * wrote the concatenation back; the next load prepended them again. Measured on a
 * real config file: 408 entries, 102 unique, 306 duplicates.
 */
describe("C2 — excludePatterns is stable across saves", () => {
	test("saving twice does not change the count", () => {
		seed(JSON.stringify({ excludePatterns: ["**/my-vendor/**"] }));

		const result = runChild({ save: { learning: true }, saveTwice: true });

		const written = JSON.parse(result.file ?? "{}");
		expect(written.excludePatterns).toEqual(["**/my-vendor/**"]);
	});

	test("an already-polluted file is healed, and the user's own patterns survive", () => {
		// Four accumulated rounds, plus two user patterns buried in them.
		const polluted = [
			"**/node_modules/**",
			"**/my-vendor/**",
			"**/node_modules/**",
			"**/dist/**",
			"**/my-other/**",
			"**/node_modules/**",
		];
		seed(JSON.stringify({ excludePatterns: polluted }));

		const result = runChild({ save: { learning: true } });

		const written = JSON.parse(result.file ?? "{}");
		// Defaults removed (they are re-added at load), duplicates collapsed, order
		// and content of the user's own additions preserved.
		expect(written.excludePatterns).toEqual([
			"**/my-vendor/**",
			"**/my-other/**",
		]);
	});

	test("removing the defaults from the file changes no effective behaviour", () => {
		// The load-side contract: a caller reading the config still sees every
		// default, so nothing that was excluded stops being excluded.
		seed(JSON.stringify({ excludePatterns: ["**/my-vendor/**"] }));
		runChild({ save: { learning: true } });

		const onDisk = JSON.parse(readFileSync(configPath, "utf-8"));
		expect(onDisk.excludePatterns).not.toContain("**/node_modules/**");

		// A second child reads it back through `loadGlobalConfig` and saves that,
		// which is the round trip that used to accumulate.
		const result = runChild({ saveTwice: true });
		const written = JSON.parse(result.file ?? "{}");
		expect(written.excludePatterns).toEqual(["**/my-vendor/**"]);
	});
});

// ============================================================================
// The prune check/use window
// ============================================================================

describe("prune deletes only what it verified", () => {
	test("a value that changed between verification and removal is left alone", () => {
		seed(JSON.stringify({ openrouterApiKey: "kctest-or-VERIFIED" }));

		const result = runChild({
			prune: true,
			stored: { openrouter: "kctest-or-VERIFIED" },
			// Another save installs a DIFFERENT plaintext value in the window — most
			// plausibly one whose own keychain write failed, which is exactly the
			// value that must not be deleted unverified.
			mutateFileBeforeRemove: {
				openrouterApiKey: "kctest-or-NEWER-UNVERIFIED",
			},
		});

		const written = JSON.parse(result.file ?? "{}");
		expect(written.openrouterApiKey).toBe("kctest-or-NEWER-UNVERIFIED");
		expect(result.removal?.skipped).toEqual(["openrouterApiKey"]);
		expect(result.removal?.removed).toEqual([]);
	});

	test("an unchanged verified value is still pruned", () => {
		seed(JSON.stringify({ openrouterApiKey: "kctest-or-VERIFIED" }));

		const result = runChild({
			prune: true,
			stored: { openrouter: "kctest-or-VERIFIED" },
		});

		const written = JSON.parse(result.file ?? "{}");
		expect(written).not.toHaveProperty("openrouterApiKey");
		expect(result.removal?.removed).toEqual(["openrouterApiKey"]);
		expect(result.storedAfter.openrouter).toBe("kctest-or-VERIFIED");
	});
});

// ============================================================================
// LOW (e) — a tmp file left by a dead process is swept, not accumulated
// ============================================================================

describe("stale config.json.tmp.* files are removed on the next save", () => {
	test("a leftover tmp holding secrets does not survive a save", () => {
		seed(JSON.stringify({ defaultModel: "m" }));
		// What a SIGKILL between `writeFileSync(tmp)` and `renameSync` leaves.
		mkdirSync(configDir, { recursive: true });
		const orphan = join(configDir, "config.json.tmp.999999");
		writeFileSync(
			orphan,
			JSON.stringify({ openrouterApiKey: "kctest-or-ORPHANED" }),
			{
				encoding: "utf-8",
				mode: 0o600,
			},
		);
		// AGE IT. The sweep now decides staleness by mtime rather than by "a
		// different pid is in the filename", because on Unix unlinking a LIVE
		// writer's open tmp file succeeds silently — the old rule could destroy
		// another process's in-flight save and report nothing. A tmp from a dead
		// process is old; one from a live writer is not.
		const old = new Date(Date.now() - 60_000);
		utimesSync(orphan, old, old);

		const result = runChild({ save: { learning: true } });

		expect(result.tmpFiles).toEqual([]);
		expect(existsSync(orphan)).toBe(false);
	});

	test("a FRESH tmp from another live writer is left alone", () => {
		// The other half, and the reason the rule changed. mtime is now, so this
		// file belongs to a process that may be between its write and its rename.
		seed(JSON.stringify({ defaultModel: "m" }));
		mkdirSync(configDir, { recursive: true });
		const live = join(configDir, "config.json.tmp.888888");
		writeFileSync(
			live,
			JSON.stringify({ openrouterApiKey: "kctest-or-INFLIGHT" }),
			{
				encoding: "utf-8",
				mode: 0o600,
			},
		);

		runChild({ save: { learning: true } });

		// THE BYTES: untouched, contents intact.
		expect(existsSync(live)).toBe(true);
		expect(readFileSync(live, "utf-8")).toContain("kctest-or-INFLIGHT");
	});
});

// ============================================================================
// Sanity: the child really did not spawn `security`
// ============================================================================

describe("the child process never reaches a real keychain", () => {
	test("the guard sentinel is set and the seam is installed", () => {
		// If either guard were missing, the fake store would not be the thing
		// answering, and `storedAfter` could not reflect the write.
		const result = runChild({ save: { anthropicApiKey: "kctest-ant-x" } });
		expect(result.storedAfter.anthropic).toBe("kctest-ant-x");
		expect(existsSync(configPath)).toBe(true);
	});
});
