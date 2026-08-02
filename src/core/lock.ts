/**
 * Index Lock Manager
 *
 * Prevents race conditions when multiple processes try to index the same project.
 * Detects stale locks from dead processes to avoid infinite waits.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Lock file data structure */
interface LockData {
	/** Process ID that holds the lock */
	pid: number;
	/** Timestamp when lock was acquired */
	startTime: number;
	/**
	 * Last heartbeat timestamp (updated periodically by a 1s timer).
	 * Means "the process is alive" — it advances even when indexing is hung,
	 * so it is NOT a reliable progress signal. See `lastProgressAt`.
	 */
	heartbeat: number;
	/**
	 * Last forward-progress timestamp. Advances ONLY when a genuine unit of
	 * indexing work completes (embed batch, addChunks, addCodeUnits), NEVER on
	 * a timer. A hung-but-alive indexer keeps stamping `heartbeat` but stops
	 * advancing this, which is how `isLockStale` detects the LanceDB write hang
	 * and reclaims the lock. Optional for backward compat: locks written by an
	 * older binary lack this field; readers fall back to `heartbeat`.
	 */
	lastProgressAt?: number;
	/**
	 * Short, stable label for WHAT the holder is currently doing
	 * (e.g. "discovering", "embedding", "writing:lance", "enriching",
	 * "finalizing"). Honest reporting only — it does NOT participate in the
	 * stale/hung DECISION (which is driven solely by `lastProgressAt`); it just
	 * lets the report SAY which phase a hung holder is wedged in. Set ONLY by
	 * `setPhase`. Optional for backward compat: locks written by an older binary
	 * lack this field; readers treat its absence as "unknown phase" (undefined).
	 */
	phase?: string;
	/**
	 * Epoch ms when the current `phase` began. Advanced ONLY by `setPhase` — NOT
	 * by the 1s heartbeat timer and NOT by `recordProgress`, so `now - phaseStartedAt`
	 * is an honest "stuck in this phase for N ms" measure. Optional for backward
	 * compat (absent on older locks => undefined, never an error).
	 */
	phaseStartedAt?: number;
	/** Human-readable start time for debugging */
	startedAt: string;
}

/** Lock acquisition result */
export interface LockResult {
	/** Whether we acquired the lock */
	acquired: boolean;
	/** If not acquired, reason why */
	reason?: "already_running" | "timeout" | "error";
	/** If already running, PID of the holder */
	holderPid?: number;
	/** If already running, how long it's been running (ms) */
	runningFor?: number;
}

/** Options for lock acquisition */
export interface LockOptions {
	/** Maximum time to wait for existing lock (ms). Default: 0 (don't wait) */
	waitTimeout?: number;
	/** Interval to check if lock is released (ms). Default: 1000 */
	pollInterval?: number;
	/** Time after which a lock with a stale heartbeat is considered stale (ms). Default: 10000 */
	staleTimeout?: number;
	/**
	 * Time after which a lock that has made no forward progress is considered
	 * hung/stale and is reclaimed, even if its heartbeat is fresh and its pid is
	 * alive (ms). Default: DEFAULT_PROGRESS_TIMEOUT (300000 / 5 min).
	 */
	progressTimeout?: number;
	/** Callback when waiting for another process */
	onWaiting?: (holderPid: number, waitedMs: number) => void;
}

const LOCK_FILENAME = ".indexing.lock";
const DEFAULT_STALE_TIMEOUT = 10000; // 10 seconds without heartbeat = stale
/**
 * Generous window (ms) after which a lock that has made no forward progress is
 * treated as hung and reclaimed — even if the heartbeat is fresh and the pid is
 * alive. Deliberately MUCH larger than DEFAULT_STALE_TIMEOUT: indexing a large
 * repo (embed a batch + LanceDB write) can legitimately take minutes, so this is
 * the upper bound on "one unit of work" before we call the holder hung.
 */
export const DEFAULT_PROGRESS_TIMEOUT = 300000; // 5 minutes without progress = hung
const DEFAULT_POLL_INTERVAL = 1000; // Check every second
const HEARTBEAT_INTERVAL = 1000; // Update heartbeat every 1 second

/**
 * Check if a process is still running (cross-platform: Windows, Linux, macOS)
 */
function isProcessRunning(pid: number): boolean {
	try {
		// process.kill with signal 0 checks if process exists
		// Works on Windows, Linux, and macOS in Node.js
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// ESRCH = No such process (Linux/macOS)
		// EPERM = Permission denied (process exists but we can't signal it)
		// On Windows: ESRCH-like error when process doesn't exist
		const err = error as NodeJS.ErrnoException;
		if (err.code === "EPERM") {
			// Process exists but we don't have permission - it's running
			return true;
		}
		return false;
	}
}

/**
 * Read lock file data
 */
function readLockFile(lockPath: string): LockData | null {
	try {
		if (!existsSync(lockPath)) {
			return null;
		}
		const content = readFileSync(lockPath, "utf-8");
		return JSON.parse(content) as LockData;
	} catch {
		return null;
	}
}

/**
 * Write lock file data
 */
function writeLockFile(lockPath: string, data: LockData): void {
	writeFileSync(lockPath, JSON.stringify(data, null, 2));
}

/**
 * Check if a lock is stale, i.e. safe to reclaim. A lock is stale when ANY of:
 *  1. The holder process is dead.
 *  2. (PRIMARY hang signal) It has made no forward progress within
 *     `progressTimeout`. This catches a hung-but-alive indexer (e.g. wedged in a
 *     LanceDB write): its 1s heartbeat keeps stamping, but `lastProgressAt` —
 *     advanced only by real indexing work — stops, so the lock goes stale and is
 *     reclaimed by the next `acquire()`.
 *  3. (SECONDARY, legacy) Its heartbeat is older than `staleTimeout`.
 *
 * Backward compat: locks written by an older binary lack `lastProgressAt`. For
 * the progress check we fall back to `heartbeat` (via `?? heartbeat`) so a
 * pre-upgrade lock is NOT treated as instantly hung.
 */
export function isLockStale(
	lock: LockData,
	staleTimeout: number,
	progressTimeout: number = DEFAULT_PROGRESS_TIMEOUT,
): boolean {
	// Check if process is dead
	if (!isProcessRunning(lock.pid)) {
		return true;
	}

	const now = Date.now();

	// PRIMARY: no forward progress within progressTimeout => hung.
	// `?? heartbeat` keeps pre-upgrade locks (no lastProgressAt) from reading as
	// `now - undefined === NaN` (which would never trip) — they fall back to the
	// heartbeat timestamp instead.
	const progressMarker = lock.lastProgressAt ?? lock.heartbeat;
	if (now - progressMarker > progressTimeout) {
		return true;
	}

	// SECONDARY (legacy): heartbeat is too old.
	if (now - lock.heartbeat > staleTimeout) {
		return true;
	}

	return false;
}

// ============================================================================
// Read-only inspection
// ============================================================================

/**
 * Full read-only snapshot of the index lock. Does NOT mutate or remove the lock.
 *
 * Modeled as a discriminated union on `present` so callers can narrow once
 * (`if (!inspect.present) ... else { use fields }`) and access the holder fields
 * without `number | undefined` noise.
 */
export type LockInspection =
	| { present: false }
	| {
			/** A parseable, complete lock file is present. */
			present: true;
			/** Holder PID from the lock file. */
			pid: number;
			/** Human-readable start time string from the lock. */
			startedAt: string;
			/** Lock acquisition epoch ms. */
			startTime: number;
			/** Last heartbeat epoch ms. */
			heartbeat: number;
			/**
			 * Last forward-progress epoch ms. Falls back to `heartbeat` when the
			 * lock was written by an older binary (no `lastProgressAt` field), so
			 * the value is always a usable timestamp (never undefined / NaN-prone).
			 */
			lastProgressAt: number;
			/** ms since startTime (Date.now() - startTime). */
			elapsedMs: number;
			/** Whether the holder PID is alive (process.kill(pid, 0) liveness probe). */
			pidAlive: boolean;
			/** Whether the heartbeat is within staleTimeout of now. Informational only. */
			isHeartbeatFresh: boolean;
			/**
			 * Whether forward progress is within progressTimeout of now. A live pid
			 * with `isProgressing === false` is the hung-indexer signal. Read-only
			 * mirror of `isLockStale`'s progress check (same `?? heartbeat` fallback).
			 */
			isProgressing: boolean;
			/**
			 * Short label of what the holder was last doing (set by setPhase), or
			 * `undefined` for locks written by an older binary (NO fallback — unlike
			 * lastProgressAt, an unknown phase is reported as unknown, not coerced).
			 */
			phase?: string;
			/** Epoch ms the current phase began (setPhase), or undefined if absent. */
			phaseStartedAt?: number;
			/**
			 * Derived `now - phaseStartedAt` (ms stuck in the current phase). Present
			 * ONLY when `phaseStartedAt` is present; undefined otherwise (no fallback).
			 */
			phaseStuckMs?: number;
	  };

/**
 * Inspect the index lock WITHOUT mutating or removing it (distinct from acquire(),
 * whose stale-lock cleanup is intentionally left unchanged). Strictly read-only:
 * no unlink, no write, and only a `process.kill(pid, 0)` liveness probe — never a
 * real signal.
 *
 * @param indexDir      ABSOLUTE path to the index directory (e.g. config.indexDir).
 *                      The lock file is resolved as join(indexDir, ".indexing.lock").
 *                      This is the SOLE signature — no (projectPath, indexDir) form —
 *                      because config.indexDir is already absolute and is the only
 *                      thing the caller has; taking it directly avoids a path.join
 *                      double-join bug under MNEMEX_INDEX_DIR.
 * @param staleTimeout  Window (ms) for the informational isHeartbeatFresh flag.
 *                      Default DEFAULT_STALE_TIMEOUT (10000); the sole caller
 *                      (index-state.ts) passes HEARTBEAT_FRESH_TIMEOUT (30000).
 * @param progressTimeout Window (ms) for the isProgressing flag. Default
 *                      DEFAULT_PROGRESS_TIMEOUT (300000 / 5 min) — matches the
 *                      hang window used by acquire()'s reclaim path.
 */
export function inspectLock(
	indexDir: string,
	staleTimeout: number = DEFAULT_STALE_TIMEOUT,
	progressTimeout: number = DEFAULT_PROGRESS_TIMEOUT,
): LockInspection {
	const lockPath = join(indexDir, LOCK_FILENAME);
	const lock = readLockFile(lockPath);

	// readLockFile returns null for an absent file OR corrupt/partial JSON.
	// Additionally guard against well-formed JSON missing the required numeric
	// fields (e.g. `{}`), which would otherwise produce a process.kill(undefined,0)
	// TypeError or NaN elapsed/heartbeat values. Treat all of these as "no lock"
	// so the classification decision tree is total.
	if (
		!lock ||
		typeof lock.pid !== "number" ||
		typeof lock.startTime !== "number" ||
		typeof lock.heartbeat !== "number"
	) {
		return { present: false };
	}

	const now = Date.now();
	// Same `?? heartbeat` fallback as isLockStale: a pre-upgrade lock without
	// lastProgressAt reads its heartbeat instead of NaN.
	const lastProgressAt = lock.lastProgressAt ?? lock.heartbeat;
	// Phase fields are reported as-is with NO fallback: a lock written by an older
	// binary (or before the first setPhase) simply has no phase. phaseStuckMs is
	// derived only when phaseStartedAt is present.
	const phaseStartedAt =
		typeof lock.phaseStartedAt === "number" ? lock.phaseStartedAt : undefined;
	return {
		present: true,
		pid: lock.pid,
		startedAt: lock.startedAt,
		startTime: lock.startTime,
		heartbeat: lock.heartbeat,
		lastProgressAt,
		elapsedMs: now - lock.startTime,
		pidAlive: isProcessRunning(lock.pid),
		isHeartbeatFresh: now - lock.heartbeat <= staleTimeout,
		isProgressing: now - lastProgressAt <= progressTimeout,
		phase: typeof lock.phase === "string" ? lock.phase : undefined,
		phaseStartedAt,
		phaseStuckMs:
			phaseStartedAt !== undefined ? now - phaseStartedAt : undefined,
	};
}

// ============================================================================
// IIndexLock Interface
// ============================================================================

/**
 * Interface for index lock implementations.
 * Allows swapping in alternative lock backends.
 */
export interface IIndexLock {
	acquire(options?: LockOptions): Promise<LockResult>;
	release(): void;
	/**
	 * Stamp forward progress on the lock. Call AFTER each genuine unit of
	 * indexing work completes (embed batch / addChunks / addCodeUnits). Advances
	 * `lastProgressAt`, which is the signal `isLockStale` uses to detect a hung
	 * holder. No-op if this process does not own the lock.
	 */
	recordProgress(): void;
	/**
	 * Record WHICH phase the holder has entered (e.g. "writing:lance"). Updates
	 * `phase` and resets `phaseStartedAt` to now. Honest-reporting only: it does
	 * NOT advance `lastProgressAt`, so it does NOT affect the hung DECISION — it
	 * only lets the report attribute a hang to a phase. No-op if this process does
	 * not own the lock.
	 */
	setPhase(phase: string): void;
	isLocked(
		staleTimeout?: number,
		progressTimeout?: number,
	): {
		locked: boolean;
		holderPid?: number;
		runningFor?: number;
	};
	forceRelease(): boolean;
}

/**
 * Index Lock Manager
 *
 * Usage:
 * ```typescript
 * const lock = new IndexLock(projectPath);
 *
 * const result = await lock.acquire({ waitTimeout: 30000 });
 * if (!result.acquired) {
 *   console.log(`Another process (PID ${result.holderPid}) is indexing`);
 *   return;
 * }
 *
 * try {
 *   // Do indexing work...
 * } finally {
 *   lock.release();
 * }
 * ```
 */
export class IndexLock implements IIndexLock {
	private lockPath: string;
	private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
	private acquired = false;

	constructor(projectPath: string, indexDir = ".mnemex") {
		this.lockPath = join(projectPath, indexDir, LOCK_FILENAME);
	}

	/**
	 * Try to acquire the lock
	 *
	 * @param options Lock options
	 * @returns Result indicating if lock was acquired
	 */
	async acquire(options: LockOptions = {}): Promise<LockResult> {
		const {
			waitTimeout = 0,
			pollInterval = DEFAULT_POLL_INTERVAL,
			staleTimeout = DEFAULT_STALE_TIMEOUT,
			progressTimeout = DEFAULT_PROGRESS_TIMEOUT,
			onWaiting,
		} = options;

		const startWait = Date.now();

		while (true) {
			// Check for existing lock
			const existingLock = readLockFile(this.lockPath);

			if (existingLock) {
				// Check if it's stale (dead process, hung holder, or no heartbeat).
				// Passing progressTimeout here is what makes a hung-but-alive holder
				// reclaimable instead of blocking every other process forever.
				if (isLockStale(existingLock, staleTimeout, progressTimeout)) {
					// Clean up stale lock and continue to acquire
					try {
						unlinkSync(this.lockPath);
					} catch {
						// Ignore - another process may have cleaned it up
					}
				} else {
					// Lock is held by an active process
					const waitedMs = Date.now() - startWait;

					if (waitTimeout > 0 && waitedMs < waitTimeout) {
						// Wait and retry
						if (onWaiting) {
							onWaiting(existingLock.pid, waitedMs);
						}
						await this.sleep(pollInterval);
						continue;
					}

					// Timeout or no wait requested
					return {
						acquired: false,
						reason: waitTimeout > 0 ? "timeout" : "already_running",
						holderPid: existingLock.pid,
						runningFor: Date.now() - existingLock.startTime,
					};
				}
			}

			// Try to acquire lock
			const now = Date.now();
			const lockData: LockData = {
				pid: process.pid,
				startTime: now,
				heartbeat: now,
				lastProgressAt: now,
				startedAt: new Date(now).toISOString(),
			};

			try {
				writeLockFile(this.lockPath, lockData);

				// Verify we got the lock (another process might have won the race)
				const verifyLock = readLockFile(this.lockPath);
				if (verifyLock?.pid !== process.pid) {
					// Lost the race, retry
					continue;
				}

				// Successfully acquired
				this.acquired = true;
				this.startHeartbeat();

				return { acquired: true };
			} catch (error) {
				return {
					acquired: false,
					reason: "error",
				};
			}
		}
	}

	/**
	 * Release the lock
	 */
	release(): void {
		this.stopHeartbeat();

		if (!this.acquired) {
			return;
		}

		try {
			// Only delete if we own the lock
			const lock = readLockFile(this.lockPath);
			if (lock?.pid === process.pid) {
				unlinkSync(this.lockPath);
			}
		} catch {
			// Ignore errors during cleanup
		}

		this.acquired = false;
	}

	/**
	 * Check if another process is currently indexing
	 */
	isLocked(
		staleTimeout = DEFAULT_STALE_TIMEOUT,
		progressTimeout = DEFAULT_PROGRESS_TIMEOUT,
	): {
		locked: boolean;
		holderPid?: number;
		runningFor?: number;
	} {
		const lock = readLockFile(this.lockPath);

		if (!lock) {
			return { locked: false };
		}

		// A hung holder (fresh heartbeat, no progress) reads as NOT locked so
		// callers don't block behind it.
		if (isLockStale(lock, staleTimeout, progressTimeout)) {
			return { locked: false };
		}

		return {
			locked: true,
			holderPid: lock.pid,
			runningFor: Date.now() - lock.startTime,
		};
	}

	/**
	 * Force release a stale lock (use with caution)
	 */
	forceRelease(): boolean {
		try {
			if (existsSync(this.lockPath)) {
				unlinkSync(this.lockPath);
				return true;
			}
			return false;
		} catch {
			return false;
		}
	}

	/**
	 * Stamp forward progress on the lock. Call AFTER each genuine unit of
	 * indexing work completes (embed batch / addChunks / addCodeUnits) — never on
	 * a timer or in a tight loop. Advances `lastProgressAt`, the signal that lets
	 * a hung holder be detected and reclaimed. No-op if this process does not own
	 * the lock. Mirrors startHeartbeat()'s safe read-check-write try/catch.
	 */
	recordProgress(): void {
		try {
			const lock = readLockFile(this.lockPath);
			if (lock?.pid === process.pid) {
				lock.lastProgressAt = Date.now();
				writeLockFile(this.lockPath, lock);
			}
		} catch {
			// Ignore progress-recording errors
		}
	}

	/**
	 * Record the current indexing phase on the lock. Call at phase transitions
	 * (discover → embed → write → enrich → finalize). Sets `phase` and resets
	 * `phaseStartedAt = now`, the ONLY writer of both fields — the 1s heartbeat
	 * and recordProgress deliberately leave them untouched so `now - phaseStartedAt`
	 * stays an honest "stuck in this phase" measure. Does NOT advance
	 * `lastProgressAt` (phase is reporting, not the hung signal). No-op if this
	 * process does not own the lock. Mirrors recordProgress()'s safe
	 * read-check-own-pid-write try/catch.
	 */
	setPhase(phase: string): void {
		try {
			const lock = readLockFile(this.lockPath);
			if (lock?.pid === process.pid) {
				lock.phase = phase;
				lock.phaseStartedAt = Date.now();
				writeLockFile(this.lockPath, lock);
			}
		} catch {
			// Ignore phase-recording errors
		}
	}

	private startHeartbeat(): void {
		this.heartbeatInterval = setInterval(() => {
			try {
				const lock = readLockFile(this.lockPath);
				if (lock?.pid === process.pid) {
					lock.heartbeat = Date.now();
					writeLockFile(this.lockPath, lock);
				}
			} catch {
				// Ignore heartbeat errors
			}
		}, HEARTBEAT_INTERVAL);

		// Don't keep process alive just for heartbeat
		if (this.heartbeatInterval.unref) {
			this.heartbeatInterval.unref();
		}
	}

	private stopHeartbeat(): void {
		if (this.heartbeatInterval) {
			clearInterval(this.heartbeatInterval);
			this.heartbeatInterval = null;
		}
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

/**
 * Create an index lock for a project
 */
export function createIndexLock(
	projectPath: string,
	indexDir?: string,
): IIndexLock {
	return new IndexLock(projectPath, indexDir);
}
