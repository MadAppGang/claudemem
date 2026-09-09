/**
 * THE `keychain` DISPOSITION MAY ONLY BE SET BY PROOF OBTAINED IN THIS SAVE.
 *
 * Defect D1's fourth variant, found independently by two external models from
 * opposite ends:
 *
 *  - gpt-5.6-sol HIGH 3: historical provenance treated as CURRENT proof. A
 *    process-wide Set of every value ever associated with a field yields a
 *    `"keychain"` outcome after THIS save explicitly failed to prove storage. The
 *    credential is persisted nowhere and the CLI reports success.
 *  - grok-4.6 MEDIUM 1: I5 records an UNPROVEN write as `stored: "keychain"`, so
 *    `saveGlobalConfig`'s merge loop deletes the field without proof — while the
 *    type comment claimed `keychain` means "Proven stored by THIS call — the only
 *    disposition that omits the field."
 *
 * `keychainSourced` is a `Set` PER FIELD and is never cleared except by a proven
 * delete, so "X came out of the keychain at some point in this process" survives
 * the keychain moving on to Y. That is a statement about history. Proof is a
 * statement about now. Conflating them defeated the N1 fix from underneath.
 *
 * THE ASSERTIONS ARE ON FILE BYTES. The old behaviour deleted a live plaintext
 * credential from `config.json` on no evidence at all, which no report-shaped
 * assertion would have caught — and three review passes did not.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHILD = join(import.meta.dir, "../../helpers/global-config-child.ts");

let home: string;
let configDir: string;
let configPath: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "mnemex-disp-"));
	configDir = join(home, ".mnemex");
	configPath = join(configDir, "config.json");
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

interface Outcome {
	id: string;
	field: string;
	stored: string;
	reason?: string;
}

interface ChildResult {
	report: {
		outcomes?: Outcome[];
		storedInKeychain?: string[];
		omittedKeychainSourced?: string[];
		keptInConfigFile?: string[];
		anyFailed?: boolean;
	} | null;
	error?: string;
	file: string | null;
	storedAfter: Record<string, string>;
	/** `verb:account` for every call the operation under test made to the seam. */
	seamCalls: string[];
}

function runChild(job: Record<string, unknown>): ChildResult {
	const proc = Bun.spawnSync({
		cmd: ["bun", "run", CHILD, JSON.stringify(job)],
		env: {
			...(process.env as Record<string, string>),
			HOME: home,
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

function seed(obj: Record<string, unknown>): void {
	mkdirSync(configDir, { recursive: true });
	writeFileSync(configPath, JSON.stringify(obj, null, 2), "utf-8");
}

describe("HIGH 3 / MEDIUM 1 — history is not proof", () => {
	test("X stored, then Y stored, then restoring X fails: the file copy SURVIVES", () => {
		// The exact sequence from the review, staged end to end.
		//
		//   1. The process hydrates openrouter=X out of the keychain. Provenance
		//      notes X.
		//   2. The keychain moves on to Y. The process hydrates again. Provenance
		//      now holds BOTH X and Y, forever.
		//   3. The user asks to restore X. The pre-read returns Y, so it proves
		//      nothing about X, and the write then FAILS.
		//   4. OLD: `recordUnproven` saw historical provenance for X and recorded
		//      `stored: "keychain"`. `saveGlobalConfig` deletes on that disposition,
		//      so the UNRELATED plaintext credential already in config.json was
		//      destroyed, and `storedInKeychain` claimed a store that never happened.
		//
		// The plaintext value below is the casualty, and it is what this asserts on.
		seed({
			openrouterApiKey: "kctest-or-LIVE-PLAINTEXT",
			defaultModel: "m",
		});

		const result = runChild({
			hydrateSequence: [
				{ openrouter: "kctest-or-X" },
				{ openrouter: "kctest-or-Y" },
			],
			failWrites: true,
			save: { openrouterApiKey: "kctest-or-X" },
		});

		// THE BYTES — the credential the save never touched is still on disk.
		const written = JSON.parse(String(result.file));
		expect(written.openrouterApiKey).toBe("kctest-or-LIVE-PLAINTEXT");
		expect(String(result.file)).toContain("kctest-or-LIVE-PLAINTEXT");

		// The value the user asked to store is NOT in the file — it came out of the
		// keychain, so writing it back in plaintext would be the C1 leak. Both rules
		// hold at once, which is the point of splitting the disposition.
		expect(String(result.file)).not.toContain("kctest-or-X");

		// The disposition is the new one, and it is NOT reported as stored.
		const outcome = result.report?.outcomes?.find((o) => o.id === "openrouter");
		expect(outcome?.stored).toBe("keychain-sourced-omitted");
		expect(result.report?.storedInKeychain).toEqual([]);
		expect(result.report?.omittedKeychainSourced).toEqual(["openrouter"]);
		// A save that stored nothing is a failed save.
		expect(result.report?.anyFailed).toBe(true);

		// And the keychain genuinely still holds Y — the save changed nothing there.
		expect(result.storedAfter.openrouter).toBe("kctest-or-Y");
	});

	test("a PROVEN store still reports `keychain` and still removes the file copy", () => {
		// The other half. If the fix had simply stopped deleting, the C1 leak and the
		// original stripSecrets defect would both come back. A save that PROVES the
		// keychain holds the value must still take it out of the file.
		seed({ openrouterApiKey: "kctest-or-OLD", defaultModel: "m" });

		const result = runChild({ save: { openrouterApiKey: "kctest-or-PROVEN" } });

		const written = JSON.parse(String(result.file));
		expect(written).not.toHaveProperty("openrouterApiKey");
		expect(String(result.file)).not.toContain("kctest-or-OLD");
		expect(String(result.file)).not.toContain("kctest-or-PROVEN");

		const outcome = result.report?.outcomes?.find((o) => o.id === "openrouter");
		expect(outcome?.stored).toBe("keychain");
		expect(result.report?.storedInKeychain).toEqual(["openrouter"]);
		expect(result.report?.omittedKeychainSourced).toEqual([]);
		expect(result.storedAfter.openrouter).toBe("kctest-or-PROVEN");
	});

	test("a re-verified hydrated value is proof, because the READ happened in this save", () => {
		// The read-before-write path: the pre-read returns the byte-identical value,
		// which IS proof obtained during this save. This must stay `keychain`, or the
		// wizard's re-submission of an unchanged key would start reporting failures.
		seed({ defaultModel: "m" });

		const result = runChild({
			hydrateSequence: [{ openrouter: "kctest-or-SAME" }],
			save: { openrouterApiKey: "kctest-or-SAME" },
		});

		const outcome = result.report?.outcomes?.find((o) => o.id === "openrouter");
		expect(outcome?.stored).toBe("keychain");
		expect(result.report?.storedInKeychain).toEqual(["openrouter"]);
		expect(String(result.file)).not.toContain("kctest-or-SAME");
	});

	test("a WARM MEMO is not proof — the pre-read must reach the keychain itself", () => {
		// THE SAME DEFECT CLASS, ONE LAYER DOWN (external review round 3, HIGH 2).
		// The tests above closed "history is not proof". This closes "a cached
		// answer is not proof", which the same `"keychain"` disposition still
		// accepted through the three-second burst memo:
		//
		//   1. config.json and the keychain both hold openrouter=A.
		//   2. This process reads A. The memo now holds A.
		//   3. Another process runs an UNFORCED `keychain rm openrouter`. It is
		//      allowed to: the plaintext copy still exists, so nothing is lost yet.
		//   4. Inside the TTL, this process saves openrouter=A. Its pre-read is
		//      answered by the memo — the keychain is never consulted.
		//   5. It records `"keychain"`, and `saveGlobalConfig` deletes the field
		//      from the file. A now exists in NEITHER place, with no `--force`
		//      anywhere in the sequence.
		//
		// `poisonMemo` stages exactly steps 2 and 3. The write is then made to fail
		// so that nothing can re-establish the item: any `"keychain"` here would be
		// a claim of proof with no proof behind it.
		seed({ openrouterApiKey: "kctest-or-A", defaultModel: "m" });

		const result = runChild({
			stored: { openrouter: "kctest-or-A" },
			poisonMemo: ["openrouter"],
			failWrites: true,
			save: { openrouterApiKey: "kctest-or-A" },
		});

		// THE SEAM: the save ASKED the keychain, despite a warm memo holding the
		// exact value it was about to record as proof. Under the old code this list
		// contains no read at all for this account.
		expect(result.seamCalls).toContain("find-generic-password:openrouter");

		// THE BYTES: the last remaining copy of the credential is still on disk.
		// This is what the old behaviour destroyed.
		expect(String(result.file)).toContain("kctest-or-A");

		// And it is not claimed as stored, because it is not stored: the keychain
		// item is gone and the write failed.
		const outcome = result.report?.outcomes?.find((o) => o.id === "openrouter");
		expect(outcome?.stored).not.toBe("keychain");
		expect(result.report?.storedInKeychain).toEqual([]);
		expect(result.storedAfter.openrouter).toBeUndefined();
	});

	test("only PROVEN dispositions may delete a field from the written file", () => {
		// The rule stated directly against the source, so a future edit that adds a
		// disposition has to decide, explicitly, whether it authorises deletion.
		const config = readFileSync(
			join(import.meta.dir, "../../../src/config.ts"),
			"utf-8",
		);
		expect(config).toContain(
			'outcome.stored === "keychain" || outcome.stored === "cleared"',
		);
		expect(config).not.toContain(
			'outcome.stored === "keychain-sourced-omitted"',
		);
	});
});
