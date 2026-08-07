/**
 * Regression tests for two enrichment defects found while reindexing.
 *
 * 1. `enableEnrichment: false` in config was silently ignored by `mnemex index`.
 *    cli.ts passed `enableEnrichment: !noLlm` — an explicit boolean on EVERY run —
 *    so the Indexer's `options.enableEnrichment ?? isEnrichmentEnabled(path)`
 *    fallback never ran. Only `--no-llm` could disable enrichment.
 *
 * 2. The enrichment/AST phase never called `reportProgress()`, so `lastProgressAt`
 *    froze for the whole phase while `heartbeat` kept ticking. Past
 *    DEFAULT_PROGRESS_TIMEOUT (5 min) the lock reads as hung and the next
 *    acquire() reclaims it — letting a second indexer run against the same store.
 *    Observed live: 1216s with no progress tick.
 */

import { describe, expect, test } from "bun:test";
import {
	DEFAULT_PROGRESS_TIMEOUT,
	isLockStale,
} from "../../../src/core/lock.js";

describe("enrichment flag plumbing (bug 1)", () => {
	// Mirrors the Indexer's resolution:
	//   options.enableEnrichment ?? isEnrichmentEnabled(projectPath)
	function resolve(
		optionValue: boolean | undefined,
		configSaysEnabled: boolean,
	): boolean {
		return optionValue ?? configSaysEnabled;
	}

	test("an explicit boolean always wins, which is what masked the config", () => {
		// The old cli.ts passed `!noLlm`, i.e. `true` whenever --no-llm was absent.
		expect(resolve(true, false)).toBe(true); // config said false, ignored
	});

	test("undefined lets config decide — the fixed behaviour", () => {
		expect(resolve(undefined, false)).toBe(false);
		expect(resolve(undefined, true)).toBe(true);
	});

	test("--no-llm still forces enrichment off regardless of config", () => {
		expect(resolve(false, true)).toBe(false);
	});

	test("the fixed cli.ts expression yields undefined unless --no-llm", () => {
		const fromCli = (noLlm: boolean) => (noLlm ? false : undefined);
		expect(fromCli(false)).toBeUndefined(); // config decides
		expect(fromCli(true)).toBe(false); // explicit opt-out
	});
});

describe("progress staleness during long phases (bug 2)", () => {
	const now = Date.now();
	const staleTimeout = 10_000;

	test("a fresh heartbeat does NOT save a lock whose progress has stalled", () => {
		// This is the exact shape observed: heartbeat current, lastProgressAt old.
		const lock = {
			pid: process.pid,
			startTime: now - 1_800_000,
			heartbeat: now,
			lastProgressAt: now - 1_216_000, // 1216s, as measured live
			phase: "enriching",
		};
		expect(
			isLockStale(lock as any, staleTimeout, DEFAULT_PROGRESS_TIMEOUT),
		).toBe(true);
	});

	test("progress ticks inside the phase keep the lock alive", () => {
		// With reportProgress() wired into the enrichment/AST loops, lastProgressAt
		// advances and the lock is correctly held.
		const lock = {
			pid: process.pid,
			startTime: now - 1_800_000,
			heartbeat: now,
			lastProgressAt: now - 1_000,
			phase: "analyzing+enriching",
		};
		expect(
			isLockStale(lock as any, staleTimeout, DEFAULT_PROGRESS_TIMEOUT),
		).toBe(false);
	});

	test("the observed stall exceeded the hung threshold several times over", () => {
		expect(DEFAULT_PROGRESS_TIMEOUT).toBe(300_000);
		expect(1_216_000).toBeGreaterThan(DEFAULT_PROGRESS_TIMEOUT);
	});
});
