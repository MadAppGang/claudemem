/**
 * Unit tests for result fusion (rrf vs tm2c2).
 *
 * The headline test is "score margin": TM2C2 (theoretical min-max + convex
 * combination, Bruch/Gai/Ingber TOIS 2023) fuses on normalized SCORE and so
 * keeps a backend's confidence margin, where RRF fuses on RANK and throws it
 * away. Everything else here pins the invariants the rrf path already has so
 * the alternative path cannot quietly regress them.
 */

import { describe, expect, test } from "bun:test";
import {
	DEFAULT_PIPELINE_CONFIG,
	loadPipelineConfig,
} from "../../../src/retrieval/pipeline/config.js";
import { rrfMerge, tm2c2Merge } from "../../../src/retrieval/pipeline/merge.js";
import type { BackendResult } from "../../../src/retrieval/pipeline/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Equal weights, so any ranking difference is attributable to fusion alone. */
const EQUAL_WEIGHTS = {
	rrfK: 60,
	backendWeights: {
		symbolGraph: 1.0,
		lsp: 1.0,
		treeSitter: 1.0,
		semantic: 1.0,
		location: 1.0,
	},
};

/** The real (unequal) default weights. */
const DEFAULT_WEIGHTS = {
	rrfK: DEFAULT_PIPELINE_CONFIG.rrfK,
	backendWeights: DEFAULT_PIPELINE_CONFIG.backendWeights,
};

function backendResult(overrides: Partial<BackendResult>): BackendResult {
	return {
		file: "src/a.ts",
		startLine: 1,
		snippet: "snippet",
		score: 1,
		backend: "semantic",
		...overrides,
	};
}

/** Run both fusion methods against `env` and restore it afterwards. */
function withEnv<T>(key: string, value: string | undefined, fn: () => T): T {
	const previous = process.env[key];
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
	try {
		return fn();
	} finally {
		if (previous === undefined) delete process.env[key];
		else process.env[key] = previous;
	}
}

// ---------------------------------------------------------------------------
// The reason this exists: score margin
// ---------------------------------------------------------------------------

describe("tm2c2 vs rrf: score margin", () => {
	/**
	 * Two backends, mirror-image rank patterns:
	 *   location: doc2 @ rank 0 (0.55), doc1 @ rank 1 (0.50)  ← barely prefers doc2
	 *   semantic: doc1 @ rank 0 (0.95), doc2 @ rank 1 (0.10)  ← overwhelmingly prefers doc1
	 *
	 * RRF sees only the ranks — which are symmetric — and ties them exactly.
	 * TM2C2 sees that `semantic` was confident and `location` was nearly
	 * indifferent, and puts doc1 first.
	 */
	const input = [
		{
			name: "location" as const,
			results: [
				backendResult({
					id: "doc2",
					startLine: 20,
					score: 0.55,
					backend: "location",
				}),
				backendResult({
					id: "doc1",
					startLine: 10,
					score: 0.5,
					backend: "location",
				}),
			],
		},
		{
			name: "semantic" as const,
			results: [
				backendResult({ id: "doc1", startLine: 10, score: 0.95 }),
				backendResult({ id: "doc2", startLine: 20, score: 0.1 }),
			],
		},
	];

	test("rrf ties the two docs and keeps encounter order", () => {
		const merged = rrfMerge(input, EQUAL_WEIGHTS, 10);

		expect(merged.map((r) => r.id)).toEqual(["doc2", "doc1"]);
		// Exactly equal: 1/60 + 1/61 for both.
		expect(merged[0].rrfScore).toBe(merged[1].rrfScore);
		expect(merged[0].rrfScore).toBeCloseTo(1 / 60 + 1 / 61, 12);
	});

	test("tm2c2 ranks by the confidence margin rrf discarded", () => {
		const merged = tm2c2Merge(input, EQUAL_WEIGHTS, 10);

		expect(merged.map((r) => r.id)).toEqual(["doc1", "doc2"]);
		// 0.5*0.50 + 0.5*0.95
		expect(merged[0].rrfScore).toBeCloseTo(0.725, 12);
		// 0.5*0.55 + 0.5*0.10
		expect(merged[1].rrfScore).toBeCloseTo(0.325, 12);
		// A real separation, not a tie.
		expect(merged[0].rrfScore - merged[1].rrfScore).toBeCloseTo(0.4, 12);
	});

	test("the two methods disagree on order for this input", () => {
		const rrf = rrfMerge(input, EQUAL_WEIGHTS, 10).map((r) => r.id);
		const tm2c2 = tm2c2Merge(input, EQUAL_WEIGHTS, 10).map((r) => r.id);

		expect(rrf).not.toEqual(tm2c2);
	});
});

// ---------------------------------------------------------------------------
// Convexity
// ---------------------------------------------------------------------------

describe("tm2c2 convex combination", () => {
	test("weights renormalize to sum 1 when a backend returns nothing", () => {
		const merged = tm2c2Merge(
			[
				{ name: "semantic", results: [] },
				{
					name: "symbol-graph",
					results: [
						backendResult({
							id: "doc1",
							score: 0.8,
							backend: "symbol-graph",
						}),
					],
				},
			],
			DEFAULT_WEIGHTS,
			10,
		);

		expect(merged.length).toBe(1);
		// The lone surviving backend owns the whole weight mass → its normalized
		// score passes through untouched.
		expect(merged[0].rrfScore).toBeCloseTo(0.8, 12);
		// NOT scaled down by the absent backend's share (1.2 / (1.2 + 1.0)).
		expect(merged[0].rrfScore).not.toBeCloseTo(0.8 * (1.2 / 2.2), 6);
	});

	test("unequal weights are renormalized across the active backends", () => {
		// symbol-graph 1.2 + semantic 1.0 = 2.2 → 0.545454… / 0.454545…
		const merged = tm2c2Merge(
			[
				{
					name: "symbol-graph",
					results: [
						backendResult({ id: "doc1", score: 1, backend: "symbol-graph" }),
					],
				},
				{
					name: "semantic",
					results: [backendResult({ id: "doc1", score: 0 })],
				},
			],
			DEFAULT_WEIGHTS,
			10,
		);

		expect(merged[0].rrfScore).toBeCloseTo(1.2 / 2.2, 12);
	});

	test("fused scores stay within [0, 1]", () => {
		const merged = tm2c2Merge(
			[
				{
					name: "symbol-graph",
					results: [
						backendResult({ id: "doc1", score: 1, backend: "symbol-graph" }),
					],
				},
				{
					name: "lsp",
					results: [backendResult({ id: "doc1", score: 1, backend: "lsp" })],
				},
				{
					name: "semantic",
					results: [backendResult({ id: "doc1", score: 1 })],
				},
			],
			DEFAULT_WEIGHTS,
			10,
		);

		expect(merged[0].rrfScore).toBeCloseTo(1, 12);
	});

	test("a single-result list does NOT normalize to 1.0", () => {
		// Observed min-max ((s - min) / (max - min)) would make any lone result
		// a perfect 1.0 (or NaN). Theoretical bounds keep the actual score.
		const merged = tm2c2Merge(
			[
				{
					name: "semantic",
					results: [backendResult({ id: "doc1", score: 0.42 })],
				},
			],
			DEFAULT_WEIGHTS,
			10,
		);

		expect(merged.length).toBe(1);
		expect(merged[0].rrfScore).toBeCloseTo(0.42, 12);
		expect(merged[0].rrfScore).not.toBe(1);
		expect(Number.isNaN(merged[0].rrfScore)).toBe(false);
	});

	test("the worst hit of a list is not flattened to 0", () => {
		const merged = tm2c2Merge(
			[
				{
					name: "semantic",
					results: [
						backendResult({ id: "doc1", score: 0.9 }),
						backendResult({ id: "doc2", score: 0.7 }),
					],
				},
			],
			DEFAULT_WEIGHTS,
			10,
		);

		expect(merged.map((r) => r.id)).toEqual(["doc1", "doc2"]);
		expect(merged[1].rrfScore).toBeCloseTo(0.7, 12);
	});

	test("out-of-contract scores are clamped, not propagated", () => {
		const merged = tm2c2Merge(
			[
				{
					name: "semantic",
					results: [
						backendResult({ id: "hi", score: 4.2 }),
						backendResult({ id: "lo", score: -3 }),
						backendResult({ id: "nan", score: Number.NaN }),
					],
				},
			],
			DEFAULT_WEIGHTS,
			10,
		);

		const byId = new Map(merged.map((r) => [r.id, r.rrfScore]));
		expect(byId.get("hi")).toBeCloseTo(1, 12);
		expect(byId.get("lo")).toBe(0);
		expect(byId.get("nan")).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Invariants shared with the rrf path
// ---------------------------------------------------------------------------

describe("tm2c2 preserves rrf-path invariants", () => {
	test("isDefinitive still forces first place", () => {
		const merged = tm2c2Merge(
			[
				{
					name: "semantic",
					results: [backendResult({ id: "hot", score: 0.99 })],
				},
				{
					name: "lsp",
					results: [
						backendResult({
							id: "def",
							score: 0.01,
							backend: "lsp",
							isDefinitive: true,
						}),
					],
				},
			],
			DEFAULT_WEIGHTS,
			10,
		);

		expect(merged[0].id).toBe("def");
		expect(merged[0].rrfScore).toBe(Number.POSITIVE_INFINITY);
		expect(merged[1].id).toBe("hot");
	});

	test("anchor-less observations with distinct ids stay distinct", () => {
		const results = [
			backendResult({ id: "obs-1", file: "", startLine: 0, score: 0.9 }),
			backendResult({ id: "obs-2", file: "", startLine: 0, score: 0.8 }),
			backendResult({ id: "obs-3", file: "", startLine: 0, score: 0.7 }),
		];

		const merged = tm2c2Merge(
			[{ name: "semantic", results }],
			DEFAULT_WEIGHTS,
			10,
		);

		expect(merged.length).toBe(3);
		expect(merged.map((r) => r.id)).toEqual(["obs-1", "obs-2", "obs-3"]);
	});

	test("results without id still key on file:startLine", () => {
		const merged = tm2c2Merge(
			[
				{
					name: "semantic",
					results: [backendResult({ file: "src/a.ts", startLine: 10 })],
				},
				{
					name: "symbol-graph",
					results: [
						backendResult({
							file: "src/a.ts",
							startLine: 10,
							backend: "symbol-graph",
							symbol: "doThing",
							endLine: 22,
							documentType: "session_observation",
							observationMetadata: { affectedFiles: ["src/a.ts"] },
						}),
						backendResult({
							file: "src/a.ts",
							startLine: 40,
							backend: "symbol-graph",
						}),
					],
				},
			],
			DEFAULT_WEIGHTS,
			10,
		);

		expect(merged.length).toBe(2);
		const shared = merged.find((r) => r.startLine === 10);
		expect(shared?.backends).toEqual(["semantic", "symbol-graph"]);
		// Optional-field carry-forward from the later backend
		expect(shared?.symbol).toBe("doThing");
		expect(shared?.endLine).toBe(22);
		expect(shared?.documentType).toBe("session_observation");
		expect(shared?.observationMetadata).toEqual({
			affectedFiles: ["src/a.ts"],
		});
	});

	test("respects the limit", () => {
		const results = Array.from({ length: 10 }, (_, i) =>
			backendResult({ id: `doc-${i}`, score: 1 - i / 10 }),
		);

		expect(
			tm2c2Merge([{ name: "semantic", results }], DEFAULT_WEIGHTS, 3).map(
				(r) => r.id,
			),
		).toEqual(["doc-0", "doc-1", "doc-2"]);
	});

	test("empty input yields an empty list", () => {
		expect(tm2c2Merge([], DEFAULT_WEIGHTS, 10)).toEqual([]);
		expect(
			tm2c2Merge([{ name: "semantic", results: [] }], DEFAULT_WEIGHTS, 10),
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("fusionMethod config", () => {
	test("the default is rrf", () => {
		expect(DEFAULT_PIPELINE_CONFIG.fusionMethod).toBe("rrf");
		expect(
			withEnv("MNEMEX_PIPELINE_FUSION", undefined, () => loadPipelineConfig())
				.fusionMethod,
		).toBe("rrf");
	});

	test("an explicit value is honored", () => {
		expect(
			withEnv("MNEMEX_PIPELINE_FUSION", "tm2c2", () => loadPipelineConfig())
				.fusionMethod,
		).toBe("tm2c2");
		expect(
			withEnv("MNEMEX_PIPELINE_FUSION", " TM2C2 ", () => loadPipelineConfig())
				.fusionMethod,
		).toBe("tm2c2");
		expect(
			withEnv("MNEMEX_PIPELINE_FUSION", "rrf", () => loadPipelineConfig())
				.fusionMethod,
		).toBe("rrf");
	});

	test("a bogus value falls back to the default instead of throwing", () => {
		for (const bogus of ["tmc22", "banana", "0", "true"]) {
			expect(
				withEnv("MNEMEX_PIPELINE_FUSION", bogus, () => loadPipelineConfig())
					.fusionMethod,
			).toBe("rrf");
		}
		expect(
			withEnv("MNEMEX_PIPELINE_FUSION", "", () => loadPipelineConfig())
				.fusionMethod,
		).toBe("rrf");
	});

	test("rrfK is untouched by the fusion setting", () => {
		expect(
			withEnv("MNEMEX_PIPELINE_FUSION", "tm2c2", () => loadPipelineConfig())
				.rrfK,
		).toBe(60);
	});
});
