/**
 * Child process for the CREDENTIAL LOCK race tests.
 *
 * WHY A SUBPROCESS. `GLOBAL_CONFIG_DIR` is a module-level `const` evaluated from
 * `homedir()` at import time, and Bun's `os.homedir()` ignores a runtime
 * reassignment of `process.env.HOME`. The only sandbox that works is a child whose
 * `HOME` was in its environment before it started. See `./sandbox-guard.ts`; this
 * file refuses to run unless it can prove it is inside a temp tree.
 *
 * It exists in addition to `global-config-child.ts` because these tests are about
 * the LOCK rather than about a save: they stage an interleaving with
 * `setConfigLockStaleHook`, and they need a critical section that reports whether
 * it ran and whether anyone else was inside it at the same time.
 *
 * Usage: bun run test/helpers/config-lock-child.ts '<json job>'
 * Prints one JSON line on stdout after `__RESULT__`.
 */

import {
	closeSync,
	existsSync,
	openSync,
	readdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
	type ConfigLockStalePhase,
	setConfigLockStaleHook,
	withConfigLock,
} from "../../src/config.js";
import { exitUnlessSandboxed } from "./sandbox-guard.js";

exitUnlessSandboxed(homedir(), process.env.MNEMEX_TEST_SANDBOX_HOME, tmpdir());

interface Job {
	/**
	 * WHEN a RIVAL process finishes its own takeover, relative to the phases of
	 * this process's takeover. The rival removes the stale lock and installs a
	 * live one stamped with its own token — exactly what the other process in the
	 * reported interleaving leaves behind.
	 *
	 * Each phase targets a different layer of the defence:
	 *  - `judged`   — the re-verification under the reclaim claim must see it.
	 *  - `verified` — too late for that, so the detach-and-compare must see it.
	 */
	rivalAt?: "judged" | "verified";
	/** Token the rival stamps into its lock. */
	rivalToken?: string;
	/**
	 * WHEN a THIRD process acquires the momentarily-free name. Only `detached`
	 * makes sense: it is the one instant at which the lock file is not at its
	 * name, and it makes the wrongly-detached lock unrestorable. Unrestorable is
	 * unresolvable, and the only honest outcome is a refusal.
	 */
	intruderAt?: "detached";
	/** Token that third process stamps in. */
	intruderToken?: string;
	/** Hold the critical section this long, for the N-way contention test. */
	holdMs?: number;
	/** Label reported with an overlap, so a failure names the pair. */
	label?: string;
}

const job: Job = JSON.parse(process.argv[2] ?? "{}");
const configDir = join(homedir(), ".mnemex");
const lockPath = join(configDir, "config.lock");
/** Created with `wx` INSIDE the critical section: a second creator proves overlap. */
const csMarkerPath = join(configDir, "critical-section.marker");

const phases: ConfigLockStalePhase[] = [];
let rivalDone = false;
let intruderDone = false;

if (job.rivalAt || job.intruderAt) {
	setConfigLockStaleHook((phase) => {
		phases.push(phase);
		if (phase === job.rivalAt && !rivalDone) {
			rivalDone = true;
			// EXACTLY what the rival would have left behind: the stale lock gone and
			// a fresh, live one of its own in its place.
			try {
				unlinkSync(lockPath);
			} catch {}
			writeFileSync(lockPath, job.rivalToken ?? "rival-token", "utf8");
			return;
		}
		if (phase === job.intruderAt && !intruderDone) {
			intruderDone = true;
			// A third process acquires normally while the name is momentarily free.
			try {
				writeFileSync(lockPath, job.intruderToken ?? "intruder-token", "utf8");
			} catch {}
		}
	});
}

let entered = false;
let overlapped = false;
let error: string | undefined;

try {
	withConfigLock(() => {
		entered = true;
		// THE OVERLAP DETECTOR. `wx` fails if the file exists, so if any other
		// process is inside its critical section right now, this throws.
		let fd: number | null = null;
		try {
			fd = openSync(csMarkerPath, "wx");
			writeFileSync(fd, job.label ?? "anon", "utf8");
		} catch {
			overlapped = true;
		}
		if (job.holdMs) Bun.sleepSync(job.holdMs);
		if (fd !== null) {
			try {
				closeSync(fd);
			} catch {}
			try {
				unlinkSync(csMarkerPath);
			} catch {}
		}
	});
} catch (e) {
	error = e instanceof Error ? e.message : String(e);
}

const out = {
	label: job.label ?? null,
	entered,
	overlapped,
	error,
	phases,
	// THE BYTES at the well-known name. A rival's lock must still be there,
	// character for character, if this process refused.
	lockBytes: existsSync(lockPath) ? readFileSync(lockPath, "utf8") : null,
	// Debris left by an interrupted takeover, so a leak is visible rather than
	// merely absent from the assertions.
	detached: existsSync(configDir)
		? readdirSync(configDir).filter((f) =>
				f.startsWith("config.lock.detached-"),
			)
		: [],
};

process.stdout.write(`\n__RESULT__${JSON.stringify(out)}\n`);
