/**
 * STALE-LOCK RECLAMATION — one owner, or none.
 *
 * THE FINDING (external review round 3, HIGH 3). The credential lock serialised
 * `save`/`migrate`/`prune`/`rm` correctly in the ordinary case, but its recovery
 * from a dead holder was check-then-act:
 *
 *     const st = statSync(CONFIG_LOCK_PATH);
 *     if (Date.now() - st.mtimeMs > CONFIG_LOCK_STALE_MS) {
 *         unlinkSync(CONFIG_LOCK_PATH);   // ← whatever is at that name BY NOW
 *         continue;
 *     }
 *
 * The sequence, all four steps of which are ordinary scheduling:
 *
 *   1. A killed process leaves `config.lock` behind.
 *   2. P and R both fail `openSync(..., "wx")` and both `stat` that same lock.
 *   3. P unlinks it, loops, creates a NEW lock stamped with token P, and enters
 *      its critical section.
 *   4. R acts on the judgement it made in step 2 and unlinks the path — which now
 *      names P's live lock — then creates its own and enters too.
 *
 * Two owners. The release-time token check does not help: it stops P from later
 * deleting R's lock, and does nothing about the two of them running at once. And
 * two owners is precisely CRITICAL 2 restored — `prune` verifying the keychain
 * while an unforced `rm` sees the plaintext copy, after which the credential
 * exists in neither place.
 *
 * THE FIX is to swap first and compare second: `rename` the lock file out of the
 * well-known name (atomic, and nobody else can act on what we moved), THEN read
 * its token, and put it back if it was not the lock we judged. See
 * `detachLockFile` in `src/config.ts`.
 *
 * EVERY ASSERTION HERE IS ON THE BYTES AT `~/.mnemex/config.lock`, on whether the
 * critical section RAN, or on an `wx` collision between two live processes. Never
 * on a report object, never on elapsed milliseconds.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	mkdirSync,
	mkdtempSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHILD = join(import.meta.dir, "../../helpers/config-lock-child.ts");

let home: string;
let configDir: string;
let lockPath: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "mnemex-reclaim-"));
	configDir = join(home, ".mnemex");
	lockPath = join(configDir, "config.lock");
	mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/** A lock left by a process that died: present, stamped, and long past stale. */
function seedStaleLock(token = "dead-holder"): void {
	writeFileSync(lockPath, token, "utf8");
	const old = new Date(Date.now() - 60_000);
	utimesSync(lockPath, old, old);
}

function childEnv(): Record<string, string> {
	return {
		...(process.env as Record<string, string>),
		HOME: home,
		MNEMEX_TEST_SANDBOX_HOME: home,
		// This child never touches the keychain; both guards are set anyway, because
		// "it does not need it" is exactly the reasoning that produced the incident.
		MNEMEX_KEYCHAIN_TEST_GUARD: "1",
		MNEMEX_DISABLE_KEYCHAIN: "1",
	};
}

interface ChildResult {
	label: string | null;
	entered: boolean;
	overlapped: boolean;
	error?: string;
	phases: string[];
	lockBytes: string | null;
	detached: string[];
}

function runChild(job: Record<string, unknown>): ChildResult {
	const proc = Bun.spawnSync({
		cmd: ["bun", "run", CHILD, JSON.stringify(job)],
		env: childEnv(),
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
	return JSON.parse(stdout.slice(marker + "__RESULT__".length)) as ChildResult;
}

describe("HIGH 3 — a stale lock cannot be reclaimed by two processes at once", () => {
	test("a rival that reclaimed first keeps its lock, and this process does NOT enter", () => {
		// THE REPORTED INTERLEAVING, staged deterministically at the exact instant
		// it happens: the hook fires when this process has judged the lock stale,
		// and does what the rival would have done — takes over and installs a live
		// lock of its own. Under the old code the next statement was
		// `unlinkSync(path)`, which deleted that live lock and let this process in
		// alongside the rival.
		seedStaleLock();

		const result = runChild({ rivalAt: "judged", rivalToken: "RIVAL-P" });

		// IT DID NOT RUN. Two owners means both critical sections ran.
		expect(result.entered).toBe(false);
		expect(String(result.error)).toContain("credential lock");

		// THE BYTES: the rival's lock is still there, untouched. This is the
		// assertion the old implementation fails — it deleted this file.
		expect(result.lockBytes).toBe("RIVAL-P");

		// It really did take the stale-takeover path, and stopped at the
		// re-verification: the lock it judged is no longer the lock that is there,
		// so it never even detached one.
		expect(result.phases).toEqual(["judged"]);
		expect(result.detached).toEqual([]);
	});

	test("a rival that lands AFTER re-verification is caught by the detach comparison", () => {
		// One layer down. Here the rival takes over between this process's
		// re-verification and its rename, so the identity check cannot see it and
		// the lock actually gets detached. The comparison is made on the file we
		// moved — token RIVAL-P, not the "dead-holder" we judged — so we put it
		// back rather than delete it.
		seedStaleLock();

		const result = runChild({ rivalAt: "verified", rivalToken: "RIVAL-P" });

		expect(result.entered).toBe(false);
		expect(String(result.error)).toContain("credential lock");
		expect(result.lockBytes).toBe("RIVAL-P");
		expect(result.phases).toEqual(["judged", "verified", "detached"]);
		// Restored, not leaked: the rival's lock is back at its name and nothing
		// is left in the detached-file namespace.
		expect(result.detached).toEqual([]);
	});

	test("when the detached lock cannot be put back, it REFUSES rather than guess", () => {
		// The residual case, and the reason "refuse" is a supported outcome: this
		// process detached a lock it had no right to, and before it could restore
		// it a third process acquired the momentarily-free name. There is now no
		// truthful move — restoring would clobber the third process's lock,
		// proceeding would make us a second owner.
		seedStaleLock();

		const result = runChild({
			rivalAt: "verified",
			rivalToken: "RIVAL-P",
			intruderAt: "detached",
			intruderToken: "INTRUDER-Q",
		});

		expect(result.entered).toBe(false);
		expect(String(result.error)).toContain("credential lock");
		// The intruder's lock is intact — we did not overwrite it to make room.
		expect(result.lockBytes).toBe("INTRUDER-Q");
		// And the lock we could not restore is kept as a file rather than deleted.
		// Losing it silently is how a lock protocol loses an owner.
		expect(result.detached.length).toBe(1);
	});

	test("with no rival, a stale lock IS reclaimed — the refusal above is the race, not paralysis", () => {
		// Without this, both tests above pass for an implementation that simply
		// never reclaims anything, which would wedge every credential command after
		// any crash.
		seedStaleLock();

		const result = runChild({ holdMs: 1 });

		expect(result.entered).toBe(true);
		expect(result.error).toBeUndefined();
		// Released, not leaked, and no debris from the takeover.
		expect(result.lockBytes).toBeNull();
		expect(result.detached).toEqual([]);
	});

	test("eight processes racing for ONE stale lock never overlap in the critical section", () => {
		// The deterministic tests above stage the interleaving that was reported.
		// This one does not stage anything: eight real processes start together,
		// all of them find the same stale lock, and each creates
		// `critical-section.marker` with `wx` on the way in. `wx` fails if the file
		// exists, so an overlap is reported by the OS rather than inferred.
		//
		// It cannot fail falsely — a pass means no overlap was observed, a failure
		// means one provably happened.
		seedStaleLock();

		const jobs = Array.from({ length: 8 }, (_, i) => ({
			label: `p${i}`,
			holdMs: 40,
		}));
		const procs = jobs.map((job) =>
			Bun.spawn({
				cmd: ["bun", "run", CHILD, JSON.stringify(job)],
				env: childEnv(),
				stdout: "pipe",
				stderr: "pipe",
			}),
		);

		const results: ChildResult[] = [];
		for (const proc of procs) {
			proc.exited;
		}
		return (async () => {
			for (const proc of procs) {
				await proc.exited;
				const stdout = await new Response(proc.stdout).text();
				const marker = stdout.indexOf("__RESULT__");
				expect(marker).toBeGreaterThanOrEqual(0);
				results.push(
					JSON.parse(stdout.slice(marker + "__RESULT__".length)) as ChildResult,
				);
			}

			const overlaps = results.filter((r) => r.overlapped).map((r) => r.label);
			expect(overlaps).toEqual([]);

			// At least one got in, or "no overlap" is trivially true.
			expect(results.filter((r) => r.entered).length).toBeGreaterThan(0);

			// Whoever refused did so with the named error, not a generic I/O failure.
			for (const r of results) {
				if (!r.entered) expect(String(r.error)).toContain("credential lock");
			}

			// The lock and its takeover debris are gone once everyone has finished.
			expect(results[results.length - 1]?.detached).toEqual([]);
		})();
	}, 30_000);
});
