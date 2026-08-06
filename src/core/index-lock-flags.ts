/**
 * Parsing for the lock-related flags of `mnemex index`.
 *
 * Kept as a tiny, PURE (no-I/O) module so it can be unit-tested without importing
 * the large CLI module. Maps raw argv flags onto the structured lock options the
 * Indexer understands.
 */

import type { LockOptions } from "./lock.js";

export interface IndexLockFlags {
	/** `--wait` / `-w`: wait for the PER-PROJECT lock instead of failing fast. */
	wait: boolean;
	/**
	 * `--if-idle`: request try-acquire-bail on the MACHINE-GLOBAL lock. Used by the
	 * MCP background reindexer (`mnemex index --quiet --if-idle`) so background
	 * reindexes don't pile up as idle waiters when a machine-wide index is already
	 * running — they exit cleanly and the next debounce trigger retries.
	 */
	ifIdle: boolean;
	/**
	 * Options for the MACHINE-GLOBAL lock, or `undefined` to let the Indexer apply
	 * its default (WAIT). `--if-idle` maps to `{ waitTimeout: 0 }` (bail immediately
	 * if another indexer holds the global lock).
	 */
	globalLockOptions: LockOptions | undefined;
}

/**
 * Parse the lock-related flags of `mnemex index`. Pure — no filesystem or process
 * access. The Indexer default for the global lock is WAIT, so we only produce
 * explicit global options for the bail case (`--if-idle`).
 */
export function parseIndexLockFlags(args: string[]): IndexLockFlags {
	const wait = args.includes("--wait") || args.includes("-w");
	const ifIdle = args.includes("--if-idle");
	return {
		wait,
		ifIdle,
		globalLockOptions: ifIdle ? { waitTimeout: 0 } : undefined,
	};
}
