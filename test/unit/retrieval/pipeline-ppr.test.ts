/**
 * Unit tests for query-seeded Personalized PageRank in the search pipeline.
 *
 * Four claims are under test:
 *
 *   A. OFF is genuinely inert. The default config must produce byte-identical
 *      output to the pre-change pipeline, and must not touch the graph at all.
 *
 *   B. Routing. The gain from graph propagation is entirely on multi-hop
 *      reasoning — HippoRAG 2 measures near-zero on single-hop, and
 *      GraphRAG-Bench has plain RAG BEATING graph methods on simple fact
 *      retrieval. So `symbol_lookup` must not invoke the walk and `structural`
 *      must.
 *
 *   C. Re-weighting. A result the walk reaches near the seeds must be promoted
 *      over one it does not, and a candidate that fusion ranked below the cut
 *      must be able to climb into the returned page.
 *
 *   D. Degenerate inputs (no graph, no resolvable seed, an all-zero walk) fall
 *      back to the fused order without throwing.
 */

import { describe, expect, test } from "bun:test";
import {
	DEFAULT_PIPELINE_CONFIG,
	loadPipelineConfig,
	type PipelineConfig,
} from "../../../src/retrieval/pipeline/config.js";
import {
	applyPersonalizedPageRank,
	type SymbolGraphView,
} from "../../../src/retrieval/pipeline/graph-ppr.js";
import { rrfMerge } from "../../../src/retrieval/pipeline/merge.js";
import { PipelineOrchestrator } from "../../../src/retrieval/pipeline/orchestrator.js";
import type {
	BackendName,
	BackendResult,
	ISearchBackend,
	MergedResult,
	SearchOptions,
} from "../../../src/retrieval/pipeline/types.js";
import type { QueryRouter } from "../../../src/retrieval/routing/query-router.js";
import type { QueryClassification, QueryIntent } from "../../../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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

function mergedResult(overrides: Partial<MergedResult>): MergedResult {
	return {
		...backendResult({}),
		rrfScore: 1,
		backends: ["semantic"],
		...overrides,
	};
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(vars)) {
		previous.set(key, process.env[key]);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	try {
		return fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

/**
 * A graph stub that records every call.
 *
 * `nodes` maps "file:line" → node id; `walk` maps node id → personalized
 * score. That is enough to exercise every branch without standing up SQLite.
 */
class FakeGraph implements SymbolGraphView {
	readonly seedCalls: Array<Map<string, number>> = [];
	readonly optionCalls: unknown[] = [];

	constructor(
		private nodes: Record<string, string>,
		private walk: Record<string, number> = {},
	) {}

	findSymbolIdAtLocation(filePath: string, line: number): string | null {
		return this.nodes[`${filePath}:${line}`] ?? null;
	}

	computePersonalizedPageRank(
		seeds: ReadonlyMap<string, number>,
		options?: unknown,
	): Map<string, number> {
		this.seedCalls.push(new Map(seeds));
		this.optionCalls.push(options);
		return new Map(Object.entries(this.walk));
	}
}

const PPR_ON: PipelineConfig["personalizedPageRank"] = {
	...DEFAULT_PIPELINE_CONFIG.personalizedPageRank,
	enabled: true,
};

// ---------------------------------------------------------------------------
// A/C/D — the re-weighting step in isolation
// ---------------------------------------------------------------------------

describe("applyPersonalizedPageRank", () => {
	test("seeds the walk from the top-k hits, weighted by fused score", () => {
		const graph = new FakeGraph({
			"src/a.ts:1": "A",
			"src/b.ts:1": "B",
			"src/c.ts:1": "C",
		});

		applyPersonalizedPageRank(
			[
				mergedResult({ id: "a", file: "src/a.ts", rrfScore: 0.9 }),
				mergedResult({ id: "b", file: "src/b.ts", rrfScore: 0.5 }),
				mergedResult({ id: "c", file: "src/c.ts", rrfScore: 0.1 }),
			],
			graph,
			{ ...PPR_ON, maxSeeds: 2 },
		);

		expect(graph.seedCalls).toHaveLength(1);
		// Only the top 2, carrying their fused scores as weights.
		expect([...graph.seedCalls[0]]).toEqual([
			["A", 0.9],
			["B", 0.5],
		]);
	});

	test("passes the configured caps through to the walk", () => {
		const graph = new FakeGraph({ "src/a.ts:1": "A" });
		applyPersonalizedPageRank(
			[mergedResult({ file: "src/a.ts" })],
			graph,
			PPR_ON,
		);

		expect(graph.optionCalls[0]).toEqual({
			iterations: PPR_ON.iterations,
			dampingFactor: PPR_ON.dampingFactor,
			tolerance: PPR_ON.tolerance,
			maxHops: PPR_ON.maxHops,
			maxNodes: PPR_ON.maxNodes,
		});
	});

	test("a seed-adjacent result is promoted over an equally-scored stranger", () => {
		// Two results fusion scored identically. The walk reaches one of them.
		const graph = new FakeGraph(
			{
				"src/seed.ts:1": "SEED",
				"src/near.ts:1": "NEAR",
				"src/far.ts:1": "FAR",
			},
			{ SEED: 0.6, NEAR: 0.4, FAR: 0 },
		);

		const out = applyPersonalizedPageRank(
			[
				mergedResult({ id: "seed", file: "src/seed.ts", rrfScore: 0.9 }),
				mergedResult({ id: "far", file: "src/far.ts", rrfScore: 0.5 }),
				mergedResult({ id: "near", file: "src/near.ts", rrfScore: 0.5 }),
			],
			graph,
			PPR_ON,
		);

		expect(out.map((r) => r.id)).toEqual(["seed", "near", "far"]);
		// near: 0.5 * (1 + 0.5 * 0.4/0.6); far is untouched by the walk.
		expect(out[1].rrfScore).toBeCloseTo(0.5 * (1 + 0.5 * (0.4 / 0.6)), 12);
		expect(out[2].rrfScore).toBe(0.5);
	});

	test("the boost can lift a candidate past one fusion ranked above it", () => {
		const graph = new FakeGraph(
			{ "src/hi.ts:1": "HI", "src/lo.ts:1": "LO" },
			{ HI: 0, LO: 1 },
		);

		const out = applyPersonalizedPageRank(
			[
				mergedResult({ id: "hi", file: "src/hi.ts", rrfScore: 1.0 }),
				mergedResult({ id: "lo", file: "src/lo.ts", rrfScore: 0.8 }),
			],
			graph,
			{ ...PPR_ON, strength: 1 },
		);

		// lo: 0.8 * (1 + 1 * 1) = 1.6 > hi's untouched 1.0
		expect(out.map((r) => r.id)).toEqual(["lo", "hi"]);
		expect(out[0].rrfScore).toBeCloseTo(1.6, 12);
	});

	test("results the walk never reaches keep their fused score exactly", () => {
		const graph = new FakeGraph(
			{ "src/a.ts:1": "A", "src/b.ts:1": "B" },
			{ A: 1 },
		);

		const out = applyPersonalizedPageRank(
			[
				mergedResult({ id: "a", file: "src/a.ts", rrfScore: 0.7 }),
				mergedResult({ id: "b", file: "src/b.ts", rrfScore: 0.6 }),
			],
			graph,
			PPR_ON,
		);

		// Multiplicative and never below 1x: this can promote, never demote.
		expect(out.find((r) => r.id === "b")?.rrfScore).toBe(0.6);
		expect(out.find((r) => r.id === "a")?.rrfScore).toBeCloseTo(0.7 * 1.5, 12);
	});

	test("a definitive match keeps Infinity and stays first", () => {
		const graph = new FakeGraph(
			{ "src/def.ts:1": "DEF", "src/other.ts:1": "OTHER" },
			{ DEF: 0.1, OTHER: 1 },
		);

		const out = applyPersonalizedPageRank(
			[
				mergedResult({
					id: "def",
					file: "src/def.ts",
					rrfScore: Number.POSITIVE_INFINITY,
					isDefinitive: true,
				}),
				mergedResult({ id: "other", file: "src/other.ts", rrfScore: 0.5 }),
			],
			graph,
			{ ...PPR_ON, strength: 1 },
		);

		expect(out[0].id).toBe("def");
		expect(out[0].rrfScore).toBe(Number.POSITIVE_INFINITY);
	});

	test("a definitive match still seeds the walk, at full weight", () => {
		const graph = new FakeGraph({ "src/def.ts:1": "DEF" });
		applyPersonalizedPageRank(
			[
				mergedResult({
					file: "src/def.ts",
					rrfScore: Number.POSITIVE_INFINITY,
					isDefinitive: true,
				}),
			],
			graph,
			PPR_ON,
		);
		expect([...graph.seedCalls[0]]).toEqual([["DEF", 1]]);
	});

	test("returns the input by identity when it cannot help", () => {
		const results = [mergedResult({ id: "a", file: "src/a.ts" })];

		// No graph at all.
		expect(applyPersonalizedPageRank(results, null, PPR_ON)).toBe(results);
		// Zero strength.
		expect(
			applyPersonalizedPageRank(
				results,
				new FakeGraph({ "src/a.ts:1": "A" }, { A: 1 }),
				{ ...PPR_ON, strength: 0 },
			),
		).toBe(results);
		// Nothing resolves to a graph node → no seed.
		expect(applyPersonalizedPageRank(results, new FakeGraph({}), PPR_ON)).toBe(
			results,
		);
		// An all-zero walk carries no information.
		expect(
			applyPersonalizedPageRank(
				results,
				new FakeGraph({ "src/a.ts:1": "A" }, { A: 0 }),
				PPR_ON,
			),
		).toBe(results);
		// Empty input.
		const empty: MergedResult[] = [];
		expect(applyPersonalizedPageRank(empty, new FakeGraph({}), PPR_ON)).toBe(
			empty,
		);
	});

	test("a duplicate node is seeded once, at its best score", () => {
		const graph = new FakeGraph({
			"src/a.ts:1": "A",
			"src/a.ts:2": "A",
			"src/b.ts:1": "B",
		});

		applyPersonalizedPageRank(
			[
				mergedResult({ file: "src/a.ts", startLine: 1, rrfScore: 0.9 }),
				mergedResult({ file: "src/a.ts", startLine: 2, rrfScore: 0.8 }),
				mergedResult({ file: "src/b.ts", startLine: 1, rrfScore: 0.7 }),
			],
			graph,
			PPR_ON,
		);

		expect([...graph.seedCalls[0]]).toEqual([
			["A", 0.9],
			["B", 0.7],
		]);
	});

	test("results with no file anchor are skipped rather than mis-seeded", () => {
		const graph = new FakeGraph({ "src/a.ts:1": "A" }, { A: 1 });
		applyPersonalizedPageRank(
			[
				mergedResult({ id: "obs", file: "", startLine: 0, rrfScore: 0.9 }),
				mergedResult({ id: "a", file: "src/a.ts", rrfScore: 0.5 }),
			],
			graph,
			PPR_ON,
		);
		expect([...graph.seedCalls[0]]).toEqual([["A", 0.5]]);
	});
});

// ---------------------------------------------------------------------------
// B — routing through the orchestrator
// ---------------------------------------------------------------------------

class FakeBackend implements ISearchBackend {
	constructor(
		readonly name: BackendName,
		private results: BackendResult[],
	) {}

	async search(): Promise<BackendResult[]> {
		return this.results;
	}
}

/** Every backend returns hits, so intent only selects which ones are read. */
const FIXTURE_RESULTS: Array<{ name: BackendName; results: BackendResult[] }> =
	[
		{
			name: "symbol-graph",
			results: [
				backendResult({
					id: "sg-1",
					file: "src/sg.ts",
					score: 0.9,
					backend: "symbol-graph",
				}),
			],
		},
		{
			name: "tree-sitter",
			results: [
				backendResult({
					id: "ts-1",
					file: "src/ts.ts",
					score: 0.8,
					backend: "tree-sitter",
				}),
			],
		},
		{
			name: "semantic",
			results: [
				backendResult({ id: "sem-1", file: "src/sem.ts", score: 0.7 }),
				backendResult({ id: "sem-2", file: "src/sem2.ts", score: 0.2 }),
			],
		},
		{
			name: "lsp",
			results: [
				backendResult({
					id: "lsp-1",
					file: "src/lsp.ts",
					score: 0.6,
					backend: "lsp",
				}),
			],
		},
		{
			name: "location",
			results: [
				backendResult({
					id: "loc-1",
					file: "src/loc.ts",
					score: 0.5,
					backend: "location",
				}),
			],
		},
	];

function fakeBackends(): ISearchBackend[] {
	return FIXTURE_RESULTS.map(
		({ name, results }) =>
			new FakeBackend(
				name,
				results.map((r) => ({ ...r })),
			),
	);
}

function routerFor(intent: QueryIntent): QueryRouter {
	const classification: QueryClassification = {
		intent,
		confidence: 0.9,
		extractedEntities: [],
	};
	return {
		route: async () => ({ classification, strategy: {} }),
	} as unknown as QueryRouter;
}

const NODES: Record<string, string> = {
	"src/sg.ts:1": "SG",
	"src/ts.ts:1": "TS",
	"src/sem.ts:1": "SEM",
	"src/sem2.ts:1": "SEM2",
	"src/lsp.ts:1": "LSP",
	"src/loc.ts:1": "LOC",
};

async function searchWith(
	config: PipelineConfig,
	intent: QueryIntent,
	graph: FakeGraph | null,
	options: SearchOptions = {},
): Promise<MergedResult[]> {
	return new PipelineOrchestrator(
		routerFor(intent),
		fakeBackends(),
		config,
		undefined,
		graph ? () => graph : undefined,
	).search("some query", options);
}

const ENABLED: PipelineConfig = {
	...DEFAULT_PIPELINE_CONFIG,
	personalizedPageRank: PPR_ON,
	// LSP short-circuit races backends non-deterministically; irrelevant here.
	lspShortCircuit: false,
};

describe("PPR is routed by query intent", () => {
	test("a structural query invokes the walk", async () => {
		const graph = new FakeGraph(NODES, { SG: 1 });
		await searchWith(ENABLED, "structural", graph);
		expect(graph.seedCalls).toHaveLength(1);
	});

	test("a semantic query invokes the walk", async () => {
		const graph = new FakeGraph(NODES, { SEM: 1 });
		await searchWith(ENABLED, "semantic", graph);
		expect(graph.seedCalls).toHaveLength(1);
	});

	test("a symbol_lookup query does NOT invoke the walk", async () => {
		// Single-hop fact retrieval: the user named the thing, and diffusing
		// score toward its neighbors can only push the named symbol down.
		const graph = new FakeGraph(NODES, { SG: 1 });
		await searchWith(ENABLED, "symbol_lookup", graph);
		expect(graph.seedCalls).toHaveLength(0);
	});

	test("location and similarity queries do NOT invoke the walk", async () => {
		for (const intent of ["location", "similarity"] as const) {
			const graph = new FakeGraph(NODES, { LOC: 1, SEM: 1 });
			await searchWith(ENABLED, intent, graph);
			expect(graph.seedCalls).toHaveLength(0);
		}
	});

	test("no walk runs on any intent while the feature is off", async () => {
		for (const intent of [
			"structural",
			"semantic",
			"symbol_lookup",
			"similarity",
			"location",
		] as const) {
			const graph = new FakeGraph(NODES, { SG: 1, SEM: 1 });
			await searchWith(DEFAULT_PIPELINE_CONFIG, intent, graph);
			expect(graph.seedCalls).toHaveLength(0);
		}
	});

	test("an enabled feature with no graph provider is inert, not a crash", async () => {
		const withGraph = await searchWith(ENABLED, "structural", null);
		const off = await searchWith(DEFAULT_PIPELINE_CONFIG, "structural", null);
		expect(JSON.stringify(withGraph)).toBe(JSON.stringify(off));
	});
});

// ---------------------------------------------------------------------------
// A — OFF is byte-identical through the orchestrator
// ---------------------------------------------------------------------------

describe("PPR off is byte-identical to the pre-change pipeline", () => {
	/** What the orchestrator did before PPR existed: fuse and return. */
	function baseline(intent: QueryIntent, limit: number): MergedResult[] {
		const active = new Set(
			{
				symbol_lookup: ["symbol-graph", "lsp", "semantic"],
				structural: ["symbol-graph", "tree-sitter", "semantic"],
				semantic: ["semantic"],
				similarity: ["semantic"],
				location: ["location", "semantic"],
			}[intent],
		);

		return rrfMerge(
			FIXTURE_RESULTS.filter(({ name }) => active.has(name)).map(
				({ name, results }) => ({
					name,
					results: results.map((r) => ({ ...r })),
				}),
			),
			DEFAULT_PIPELINE_CONFIG,
			limit,
		);
	}

	test("the default config reproduces plain fusion on every intent", async () => {
		for (const intent of [
			"structural",
			"semantic",
			"symbol_lookup",
			"similarity",
			"location",
		] as const) {
			const config: PipelineConfig = {
				...DEFAULT_PIPELINE_CONFIG,
				lspShortCircuit: false,
			};
			const actual = await searchWith(config, intent, new FakeGraph(NODES), {
				limit: 10,
			});
			expect(actual).toEqual(baseline(intent, 10));
		}
	});

	test("an intent PPR does not route to is unaffected even when enabled", async () => {
		const graph = new FakeGraph(NODES, { SG: 1, LSP: 1, SEM: 1 });
		const enabled = await searchWith(ENABLED, "symbol_lookup", graph, {
			limit: 10,
		});
		const off = await searchWith(
			{ ...DEFAULT_PIPELINE_CONFIG, lspShortCircuit: false },
			"symbol_lookup",
			graph,
			{ limit: 10 },
		);
		expect(JSON.stringify(enabled)).toBe(JSON.stringify(off));
	});

	test("the limit is still honored when the deeper candidate pool is fused", async () => {
		const graph = new FakeGraph(NODES, { SG: 1, TS: 0.9, SEM: 0.8, SEM2: 0.7 });
		const out = await searchWith(ENABLED, "structural", graph, { limit: 2 });
		expect(out).toHaveLength(2);
	});

	test("PPR can promote a candidate from below the returned page", async () => {
		// sem-2 is fusion's weakest hit and would not survive limit=2; the walk
		// puts it right on top of the seeds.
		const graph = new FakeGraph(NODES, { SEM2: 1 });
		const config: PipelineConfig = {
			...ENABLED,
			personalizedPageRank: { ...PPR_ON, strength: 1 },
		};

		const withPpr = await searchWith(config, "structural", graph, { limit: 2 });
		const withoutPpr = await searchWith(
			{ ...DEFAULT_PIPELINE_CONFIG, lspShortCircuit: false },
			"structural",
			graph,
			{ limit: 2 },
		);

		expect(withoutPpr.map((r) => r.id)).not.toContain("sem-2");
		expect(withPpr.map((r) => r.id)).toContain("sem-2");
	});
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("PPR config", () => {
	test("defaults to off", () => {
		expect(DEFAULT_PIPELINE_CONFIG.personalizedPageRank.enabled).toBe(false);

		const loaded = withEnv({ MNEMEX_PIPELINE_PPR: undefined }, () =>
			loadPipelineConfig(),
		);
		expect(loaded.personalizedPageRank).toEqual(
			DEFAULT_PIPELINE_CONFIG.personalizedPageRank,
		);
	});

	test("explicit values are honored", () => {
		const loaded = withEnv(
			{
				MNEMEX_PIPELINE_PPR: "true",
				MNEMEX_PIPELINE_PPR_STRENGTH: "0.25",
				MNEMEX_PIPELINE_PPR_SEEDS: "4",
				MNEMEX_PIPELINE_PPR_ITERATIONS: "50",
				MNEMEX_PIPELINE_PPR_DAMPING: "0.8",
				MNEMEX_PIPELINE_PPR_MAX_HOPS: "2",
				MNEMEX_PIPELINE_PPR_MAX_NODES: "500",
				MNEMEX_PIPELINE_PPR_CANDIDATES: "5",
			},
			() => loadPipelineConfig(),
		);

		expect(loaded.personalizedPageRank).toEqual({
			enabled: true,
			strength: 0.25,
			maxSeeds: 4,
			iterations: 50,
			dampingFactor: 0.8,
			tolerance: DEFAULT_PIPELINE_CONFIG.personalizedPageRank.tolerance,
			maxHops: 2,
			maxNodes: 500,
			candidateMultiplier: 5,
		});
	});

	test("bogus values fall back to the default without throwing", () => {
		const d = DEFAULT_PIPELINE_CONFIG.personalizedPageRank;
		for (const bogus of ["banana", "NaN", "0.4.2", "-", ""]) {
			const loaded = withEnv(
				{
					MNEMEX_PIPELINE_PPR_STRENGTH: bogus,
					MNEMEX_PIPELINE_PPR_SEEDS: bogus,
					MNEMEX_PIPELINE_PPR_ITERATIONS: bogus,
					MNEMEX_PIPELINE_PPR_DAMPING: bogus,
					MNEMEX_PIPELINE_PPR_MAX_NODES: bogus,
				},
				() => loadPipelineConfig(),
			).personalizedPageRank;

			expect(loaded.strength).toBe(d.strength);
			expect(loaded.maxSeeds).toBe(d.maxSeeds);
			expect(loaded.iterations).toBe(d.iterations);
			expect(loaded.dampingFactor).toBe(d.dampingFactor);
			expect(loaded.maxNodes).toBe(d.maxNodes);
		}

		expect(
			withEnv({ MNEMEX_PIPELINE_PPR: "yes" }, () => loadPipelineConfig())
				.personalizedPageRank.enabled,
		).toBe(false);
	});

	test("counts that would silently disable the feature revert to the default", () => {
		const d = DEFAULT_PIPELINE_CONFIG.personalizedPageRank;
		const loaded = withEnv(
			{
				MNEMEX_PIPELINE_PPR_SEEDS: "0",
				MNEMEX_PIPELINE_PPR_ITERATIONS: "-5",
				MNEMEX_PIPELINE_PPR_CANDIDATES: "0",
			},
			() => loadPipelineConfig(),
		).personalizedPageRank;

		expect(loaded.maxSeeds).toBe(d.maxSeeds);
		expect(loaded.iterations).toBe(d.iterations);
		expect(loaded.candidateMultiplier).toBe(d.candidateMultiplier);
	});

	test("damping is clamped below 1, where personalization would vanish", () => {
		// d = 1 zeroes the teleport term — which IS the personalization.
		expect(
			withEnv({ MNEMEX_PIPELINE_PPR_DAMPING: "1" }, () => loadPipelineConfig())
				.personalizedPageRank.dampingFactor,
		).toBe(0.99);
		expect(
			withEnv({ MNEMEX_PIPELINE_PPR_DAMPING: "5" }, () => loadPipelineConfig())
				.personalizedPageRank.dampingFactor,
		).toBe(0.99);
		expect(
			withEnv({ MNEMEX_PIPELINE_PPR_DAMPING: "-1" }, () => loadPipelineConfig())
				.personalizedPageRank.dampingFactor,
		).toBe(0);
	});

	test("strength clamps into [0, 1] instead of reverting", () => {
		expect(
			withEnv({ MNEMEX_PIPELINE_PPR_STRENGTH: "3" }, () => loadPipelineConfig())
				.personalizedPageRank.strength,
		).toBe(1);
	});
});
