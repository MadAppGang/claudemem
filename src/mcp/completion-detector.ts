/**
 * Completion Detector
 *
 * Detects when a background reindex has finished by polling for:
 * 1. Lock file absence (indexing.lock removed)
 * 2. index.db mtime is newer than when polling started
 *
 * Used both for event-driven notification (watch) and blocking wait (waitForCompletion).
 */

import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { INDEX_DB_FILE } from "../config.js";

const LOCK_FILENAME = ".indexing.lock";
const MAX_WAIT_MS = 300_000; // 5 minutes

/**
 * Polls for the completion of a background reindex.
 */
export class CompletionDetector {
	private pollTimer: ReturnType<typeof setInterval> | null = null;

	constructor(
		private indexDir: string,
		private pollIntervalMs: number,
	) {}

	/**
	 * Start polling and call onComplete when done.
	 * Automatically stops after MAX_WAIT_MS even if lock persists.
	 */
	watch(onComplete: () => void): void {
		// Stop any existing poll
		this.stop();

		const lockPath = join(this.indexDir, LOCK_FILENAME);
		const dbPath = join(this.indexDir, INDEX_DB_FILE);
		const startMtime = this.getMtime(dbPath);
		const deadline = Date.now() + MAX_WAIT_MS;

		this.pollTimer = setInterval(() => {
			const isComplete = this.checkComplete(lockPath, dbPath, startMtime);
			const timedOut = Date.now() >= deadline;

			if (isComplete || timedOut) {
				this.stop();
				onComplete();
			}
		}, this.pollIntervalMs);

		// Don't keep process alive just for polling
		if (this.pollTimer.unref) {
			this.pollTimer.unref();
		}
	}

	/**
	 * Stop polling.
	 */
	stop(): void {
		if (this.pollTimer !== null) {
			clearInterval(this.pollTimer);
			this.pollTimer = null;
		}
	}

	/**
	 * Block until reindex completes or timeout elapses.
	 * Returns true if completed, false if timed out.
	 */
	async waitForCompletion(timeoutMs = MAX_WAIT_MS): Promise<boolean> {
		const lockPath = join(this.indexDir, LOCK_FILENAME);
		const dbPath = join(this.indexDir, INDEX_DB_FILE);
		const startMtime = this.getMtime(dbPath);
		const deadline = Date.now() + timeoutMs;

		while (Date.now() < deadline) {
			if (this.checkComplete(lockPath, dbPath, startMtime)) {
				return true;
			}
			await sleep(this.pollIntervalMs);
		}

		return false;
	}

	/**
	 * Completion condition: lock absent AND db mtime newer than start.
	 */
	private checkComplete(
		lockPath: string,
		dbPath: string,
		startMtime: number,
	): boolean {
		if (existsSync(lockPath)) {
			return false;
		}
		const currentMtime = this.getMtime(dbPath);
		return currentMtime > startMtime;
	}

	private getMtime(path: string): number {
		try {
			return statSync(path).mtimeMs;
		} catch {
			return 0;
		}
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
