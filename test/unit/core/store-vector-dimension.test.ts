/**
 * Regression tests for the zero-dimension vector guard in store.ts.
 *
 * LanceDB infers the table schema from the first written batch. A batch whose
 * vectors are empty arrays produces a `vector` column typed
 * `FixedSizeList[0]<Float32>`, which is permanently unqueryable: the table
 * opens and countRows() works, but every read touching `vector` fails.
 * Observed on a real 28,653-row index — LanceDB 0.33 raises
 * `LanceError(Schema): dimension must be a positive integer`, and 0.13 panics
 * in Rust with "attempt to divide by zero".
 *
 * The schema is immutable after creation, so the only recovery is a full
 * reindex. These tests pin the fail-fast behaviour that prevents it.
 */

import { describe, expect, test } from "bun:test";
import {
	assertVectorDimension,
	ZeroDimensionVectorError,
} from "../../../src/core/store.js";

describe("assertVectorDimension", () => {
	test("passes through a normal embedding dimension", () => {
		expect(assertVectorDimension(768, "addChunks")).toBe(768);
		expect(assertVectorDimension(1536, "addChunks")).toBe(1536);
	});

	test("passes through a dimension of 1", () => {
		expect(assertVectorDimension(1, "addChunks")).toBe(1);
	});

	test("rejects dimension 0 — the corruption case", () => {
		expect(() => assertVectorDimension(0, "addChunks")).toThrow(
			ZeroDimensionVectorError,
		);
	});

	test("rejects negative and non-finite dimensions", () => {
		expect(() => assertVectorDimension(-1, "addChunks")).toThrow(
			ZeroDimensionVectorError,
		);
		expect(() => assertVectorDimension(Number.NaN, "addChunks")).toThrow(
			ZeroDimensionVectorError,
		);
	});

	test("names the offending write path so the failure is actionable", () => {
		expect(() => assertVectorDimension(0, "addCodeUnits")).toThrow(
			/addCodeUnits/,
		);
	});

	test("error explains the likely cause and the required action", () => {
		let caught: Error | undefined;
		try {
			assertVectorDimension(0, "addDocuments");
		} catch (err) {
			caught = err as Error;
		}
		expect(caught).toBeInstanceOf(ZeroDimensionVectorError);
		expect(caught?.name).toBe("ZeroDimensionVectorError");
		expect(caught?.message).toContain("embedding provider");
		expect(caught?.message).toContain("reindex");
	});

	test("an empty vector array yields dimension 0 and is rejected", () => {
		// Mirrors the real call: assertVectorDimension(data[0].vector.length, ...)
		const batch = [{ vector: [] as number[] }];
		expect(() =>
			assertVectorDimension(batch[0].vector.length, "addChunks"),
		).toThrow(ZeroDimensionVectorError);
	});
});
