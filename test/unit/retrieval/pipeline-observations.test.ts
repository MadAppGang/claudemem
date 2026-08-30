/**
 * Unit tests for the unified retrieval path.
 *
 * Covers the three pieces that made the `search` (pipeline) and `search_code`
 * (legacy) tools disagree:
 *   - RRF merge keying (anchor-less observations must not collapse)
 *   - Semantic backend surfacing session_observation results
 *   - Learned per-file boosts (one shared implementation)
 */

import { describe, expect, test } from "bun:test";
import { SemanticBackend } from "../../../src/retrieval/backends/semantic.js";
import { applyFileBoosts } from "../../../src/retrieval/pipeline/learned-boosts.js";
import { rrfMerge } from "../../../src/retrieval/pipeline/merge.js";
import type {
	BackendResult,
	MergedResult,
} from "../../../src/retrieval/pipeline/types.js";
import type {
	CodeChunk,
	QueryClassification,
	SearchResult,
} from "../../../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MERGE_CONFIG = {
	rrfK: 60,
	backendWeights: {
		symbolGraph: 1.2,
		lsp: 1.5,
		treeSitter: 1.1,
		semantic: 1.0,
		location: 0.9,
	},
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

function chunk(overrides: Partial<CodeChunk>): CodeChunk {
	return {
		id: "chunk-1",
		contentHash: "hash",
		content: "content",
		filePath: "src/a.ts",
		startLine: 1,
		endLine: 5,
		language: "typescript",
		chunkType: "function",
		fileHash: "filehash",
		...overrides,
	};
}

function searchResult(overrides: Partial<SearchResult>): SearchResult {
	return {
		chunk: chunk({}),
		score: 0.9,
		vectorScore: 0.9,
		keywordScore: 0.1,
		...overrides,
	};
}

const CLASSIFICATION: QueryClassification = {
	intent: "semantic",
	confidence: 0.9,
	entities: [],
	reasoning: "test",
};

/** Minimal Indexer stand-in for SemanticBackend. */
function fakeIndexer(results: SearchResult[]) {
	return {
		search: async () => results,
		close: async () => {},
	};
}

// ---------------------------------------------------------------------------
// rrfMerge keying
// ---------------------------------------------------------------------------

describe("rrfMerge keying", () => {
	test("anchor-less observations with distinct ids stay distinct", () => {
		const results = [
			backendResult({ id: "obs-1", file: "", startLine: 0, snippet: "first" }),
			backendResult({ id: "obs-2", file: "", startLine: 0, snippet: "second" }),
			backendResult({ id: "obs-3", file: "", startLine: 0, snippet: "third" }),
		];

		const merged = rrfMerge([{ name: "semantic", results }], MERGE_CONFIG, 10);

		expect(merged.length).toBe(3);
		expect(new Set(merged.map((r) => r.id))).toEqual(
			new Set(["obs-1", "obs-2", "obs-3"]),
		);
	});

	test("same id across backends merges into one entry", () => {
		const merged = rrfMerge(
			[
				{
					name: "semantic",
					results: [backendResult({ id: "obs-1", file: "", startLine: 0 })],
				},
				{
					name: "location",
					results: [backendResult({ id: "obs-1", file: "", startLine: 0 })],
				},
			],
			MERGE_CONFIG,
			10,
		);

		expect(merged.length).toBe(1);
		expect(merged[0].backends).toEqual(["semantic", "location"]);
	});

	test("results without id still key on file:startLine (backward compat)", () => {
		const merged = rrfMerge(
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
						}),
						backendResult({
							file: "src/a.ts",
							startLine: 40,
							backend: "symbol-graph",
						}),
					],
				},
			],
			MERGE_CONFIG,
			10,
		);

		expect(merged.length).toBe(2);
		const shared = merged.find((r) => r.startLine === 10) as MergedResult;
		expect(shared.backends).toEqual(["semantic", "symbol-graph"]);
		expect(shared.symbol).toBe("doThing");
	});

	test("carries documentType and observationMetadata across backends", () => {
		const merged = rrfMerge(
			[
				{
					name: "semantic",
					results: [backendResult({ file: "src/a.ts", startLine: 10 })],
				},
				{
					name: "location",
					results: [
						backendResult({
							file: "src/a.ts",
							startLine: 10,
							backend: "location",
							documentType: "session_observation",
							observationMetadata: { affectedFiles: ["src/a.ts"] },
						}),
					],
				},
			],
			MERGE_CONFIG,
			10,
		);

		expect(merged.length).toBe(1);
		expect(merged[0].documentType).toBe("session_observation");
		expect(merged[0].observationMetadata).toEqual({
			affectedFiles: ["src/a.ts"],
		});
	});
});

// ---------------------------------------------------------------------------
// Semantic backend
// ---------------------------------------------------------------------------

describe("SemanticBackend observations", () => {
	test("returns session_observation results with type + metadata", async () => {
		const observation = searchResult({
			chunk: chunk({
				id: "obs-1",
				filePath: "src/store.ts",
				startLine: 12,
				endLine: 12,
			}),
			score: 0.5,
			documentType: "session_observation",
			observationMetadata: { affectedFiles: ["src/store.ts"] },
		});
		const code = searchResult({
			chunk: chunk({ id: "code-1", filePath: "src/store.ts", startLine: 40 }),
			score: 1,
		});

		const backend = new SemanticBackend(
			() => fakeIndexer([code, observation]) as never,
		);
		const results = await backend.search(
			"how is the store written",
			CLASSIFICATION,
			{ limit: 10 },
			new AbortController().signal,
		);

		expect(results.length).toBe(2);
		const obs = results.find((r) => r.id === "obs-1");
		expect(obs).toBeDefined();
		expect(obs?.documentType).toBe("session_observation");
		expect(obs?.observationMetadata).toEqual({
			affectedFiles: ["src/store.ts"],
		});
		expect(obs?.file).toBe("src/store.ts");
		expect(obs?.startLine).toBe(12);
	});

	test("keeps anchor-less observations (empty filePath)", async () => {
		const observation = searchResult({
			chunk: chunk({ id: "obs-2", filePath: "", startLine: 0, endLine: 0 }),
			documentType: "session_observation",
			observationMetadata: {},
		});

		const backend = new SemanticBackend(
			() => fakeIndexer([observation]) as never,
		);
		const results = await backend.search(
			"anything",
			CLASSIFICATION,
			{ limit: 10 },
			new AbortController().signal,
		);

		expect(results.length).toBe(1);
		expect(results[0].id).toBe("obs-2");
		expect(results[0].file).toBe("");
	});

	test("sets id on plain code results too (merge key)", async () => {
		const backend = new SemanticBackend(
			() =>
				fakeIndexer([
					searchResult({ chunk: chunk({ id: "code-9" }) }),
				]) as never,
		);
		const results = await backend.search(
			"anything",
			CLASSIFICATION,
			{ limit: 10 },
			new AbortController().signal,
		);

		expect(results[0].id).toBe("code-9");
	});
});

// ---------------------------------------------------------------------------
// Learned boosts
// ---------------------------------------------------------------------------

describe("applyFileBoosts", () => {
	type Item = { file: string; score: number };
	const getFile = (i: Item) => i.file;
	const getScore = (i: Item) => i.score;
	const withScore = (i: Item, score: number) => ({ ...i, score });

	test("applies multipliers and re-sorts descending", () => {
		const items: Item[] = [
			{ file: "src/a.ts", score: 1.0 },
			{ file: "src/b.ts", score: 0.8 },
			{ file: "src/c.ts", score: 0.5 },
		];
		const boosts = new Map([
			["src/c.ts", 3.0],
			["src/a.ts", 0.5],
		]);

		const out = applyFileBoosts(items, boosts, getFile, getScore, withScore);

		expect(out.map((i) => i.file)).toEqual([
			"src/c.ts",
			"src/b.ts",
			"src/a.ts",
		]);
		expect(out[0].score).toBeCloseTo(1.5, 10);
		expect(out[1].score).toBeCloseTo(0.8, 10); // unlisted → 1.0
		expect(out[2].score).toBeCloseTo(0.5, 10);
		// Input is not mutated
		expect(items[0].score).toBe(1.0);
	});

	test("null or empty boost map is a no-op", () => {
		const items: Item[] = [
			{ file: "src/a.ts", score: 0.2 },
			{ file: "src/b.ts", score: 0.9 },
		];

		expect(applyFileBoosts(items, null, getFile, getScore, withScore)).toBe(
			items,
		);
		expect(
			applyFileBoosts(items, new Map(), getFile, getScore, withScore),
		).toBe(items);
		expect(
			applyFileBoosts(items, undefined, getFile, getScore, withScore),
		).toBe(items);
	});

	test("leaves Infinity (definitive) scores untouched and on top", () => {
		const items: Item[] = [
			{ file: "src/def.ts", score: Number.POSITIVE_INFINITY },
			{ file: "src/hot.ts", score: 0.1 },
		];
		const boosts = new Map([
			["src/def.ts", 0.5],
			["src/hot.ts", 2],
		]);

		const out = applyFileBoosts(items, boosts, getFile, getScore, withScore);

		expect(out[0].file).toBe("src/def.ts");
		expect(out[0].score).toBe(Number.POSITIVE_INFINITY);
		// "Untouched" literally: the definitive entry is passed through as-is
		expect(out[0]).toBe(items[0]);
		expect(out[1].score).toBeCloseTo(0.2, 10);
	});

	test("a demoting boost cannot turn a definitive score into NaN", () => {
		const items: Item[] = [
			{ file: "src/def.ts", score: Number.POSITIVE_INFINITY },
			{ file: "src/other.ts", score: 0.4 },
		];

		const out = applyFileBoosts(
			items,
			new Map([["src/def.ts", 0]]),
			getFile,
			getScore,
			withScore,
		);

		expect(Number.isNaN(out[0].score)).toBe(false);
		expect(out[0].file).toBe("src/def.ts");
		expect(out[0].score).toBe(Number.POSITIVE_INFINITY);
	});

	test("multiple Infinity scores keep a stable relative order", () => {
		const items: Item[] = [
			{ file: "src/x.ts", score: Number.POSITIVE_INFINITY },
			{ file: "src/y.ts", score: Number.POSITIVE_INFINITY },
			{ file: "src/z.ts", score: 0.1 },
		];
		const out = applyFileBoosts(
			items,
			new Map([["src/z.ts", 2]]),
			getFile,
			getScore,
			withScore,
		);

		expect(out.map((i) => i.file)).toEqual([
			"src/x.ts",
			"src/y.ts",
			"src/z.ts",
		]);
	});
});
