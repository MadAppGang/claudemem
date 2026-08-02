/**
 * Unit tests for the LanceDB write watchdog (`withTimeout`) in store.ts.
 *
 * The LanceDB 0.13.0 write path (table.add / createTable) can deadlock forever
 * (all tokio threads park in Condvar::wait, 0% CPU). `withTimeout` races the
 * write against a timer so a hung write THROWS instead of parking — which frees
 * the JS process to release its index lock and fail loudly.
 *
 * IMPORTANT: `withTimeout` cannot CANCEL the native call (LanceDB has no
 * AbortSignal); it only stops AWAITING it. These tests verify the await-side
 * behaviour: fast promises resolve through it; a never-resolving promise rejects
 * with LanceWriteTimeoutError after the (tiny, test-only) timeout.
 */

import { describe, expect, test } from "bun:test";
import {
	LANCEDB_WRITE_TIMEOUT_MS,
	LanceWriteTimeoutError,
	withTimeout,
} from "../../../src/core/store.js";

describe("LANCEDB_WRITE_TIMEOUT_MS", () => {
	test("is a generous 60s default", () => {
		expect(LANCEDB_WRITE_TIMEOUT_MS).toBe(60000);
	});
});

describe("withTimeout", () => {
	test("resolves with the value of a fast-settling promise", async () => {
		const fast = Promise.resolve(42);
		await expect(withTimeout(fast, 1000, "fast")).resolves.toBe(42);
	});

	test("resolves a promise that settles just before the timeout", async () => {
		const p = new Promise<string>((resolve) =>
			setTimeout(() => resolve("done"), 10),
		);
		await expect(withTimeout(p, 1000, "soon")).resolves.toBe("done");
	});

	test("throws LanceWriteTimeoutError on a promise that never resolves", async () => {
		// A never-resolving promise stands in for the hung native LanceDB write.
		// withTimeout must reject after `ms` even though `p` stays pending forever
		// (it cannot be cancelled — that is the documented limitation).
		const never = new Promise<void>(() => {});
		await expect(withTimeout(never, 50, "addChunks:table.add")).rejects.toThrow(
			LanceWriteTimeoutError,
		);
	});

	test("the thrown error carries the label and timeout ms", async () => {
		const never = new Promise<void>(() => {});
		try {
			await withTimeout(never, 50, "addCodeUnits:createTable");
			throw new Error("expected withTimeout to throw");
		} catch (err) {
			expect(err).toBeInstanceOf(LanceWriteTimeoutError);
			const e = err as LanceWriteTimeoutError;
			expect(e.label).toBe("addCodeUnits:createTable");
			expect(e.timeoutMs).toBe(50);
			expect(e.message).toContain("addCodeUnits:createTable");
			expect(e.message).toContain("50ms");
		}
	});

	test("propagates a rejection from the wrapped promise (not a timeout)", async () => {
		const boom = Promise.reject(new Error("native add failed"));
		await expect(withTimeout(boom, 1000, "rejecting")).rejects.toThrow(
			"native add failed",
		);
	});
});
