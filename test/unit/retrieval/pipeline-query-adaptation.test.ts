/**
 * Unit tests for per-query adaptation.
 *
 * Two claims are under test:
 *
 *   A. Fusion weights should depend on the query. A query of rare,
 *      identifier-shaped terms carries strong lexical signal, so exact
 *      backends should gain weight; a query of common words carries none, so
 *      the semantic backend should. The static weight vector cannot express
 *      either, and the tilt must not break tm2c2's convexity.
 *
 *   B. The score floor should depend on query length. Long queries dilute the
 *      embedding, so a floor tuned on short queries discards true matches.
 *
 * Both are OFF by default, so the third thing under test is that OFF is
 * genuinely inert — identical output, and identity-equal inputs where possible.
 */

import { describe, expect, test } from "bun:test";
import {
	DEFAULT_PIPELINE_CONFIG,
	loadPipelineConfig,
	type PipelineConfig,
} from "../../../src/retrieval/pipeline/config.js";
import { rrfMerge, tm2c2Merge } from "../../../src/retrieval/pipeline/merge.js";
import { PipelineOrchestrator } from "../../../src/retrieval/pipeline/orchestrator.js";
import {
	adaptBackendWeights,
	applyScoreFloor,
	effectiveScoreFloor,
	estimateQueryRarity,
	estimateTokenRarity,
	tokenizeQuery,
} from "../../../src/retrieval/pipeline/query-adaptation.js";
import type {
	BackendName,
	BackendResult,
	ISearchBackend,
	MergedResult,
	SearchOptions,
} from "../../../src/retrieval/pipeline/types.js";
import type { QueryRouter } from "../../../src/retrieval/routing/query-router.js";
import type { QueryClassification } from "../../../src/types.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A query whose every token is identifier-shaped (camelCase, snake_case) —
 * maximum rarity, i.e. maximum lexical signal.
 */
const RARE_QUERY = "handleRequest retryPolicy_backoff";

/**
 * A query of nothing but short common English words — zero rarity, i.e. no
 * lexical signal at all.
 */
const COMMON_QUERY = "how do we get the new one";

const DEFAULT_WEIGHTS = DEFAULT_PIPELINE_CONFIG.backendWeights;

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

// ---------------------------------------------------------------------------
// Rarity proxy
// ---------------------------------------------------------------------------

describe("query rarity proxy", () => {
	test("tokenizes around punctuation but keeps identifier shape", () => {
		expect(tokenizeQuery("where is handleRequest() called?")).toEqual([
			"where",
			"is",
			"handleRequest",
			"called",
		]);
		expect(tokenizeQuery("look in src/core/store.ts")).toEqual([
			"look",
			"in",
			"src/core/store.ts",
		]);
		expect(tokenizeQuery("   ")).toEqual([]);
	});

	test("identifier-shaped tokens are maximally rare", () => {
		for (const token of [
			"handleRequest",
			"PipelineOrchestrator",
			"retry_policy",
			"score-floor",
			"src/core/store.ts",
			"sha256",
			"HTTP",
		]) {
			expect(estimateTokenRarity(token)).toBe(1);
		}
	});

	test("short common words carry no rarity", () => {
		for (const token of ["how", "do", "we", "the", "one", "user", "code"]) {
			expect(estimateTokenRarity(token)).toBe(0);
		}
	});

	test("plain word rarity ramps with length", () => {
		expect(estimateTokenRarity("handle")).toBeCloseTo(0.25, 12); // 6 chars
		expect(estimateTokenRarity("streaming")).toBeCloseTo(0.625, 12); // 9 chars
		expect(estimateTokenRarity("authentication")).toBe(1); // 14 chars
	});

	test("query rarity is the token mean; degenerate queries are neutral", () => {
		expect(estimateQueryRarity(RARE_QUERY)).toBe(1);
		expect(estimateQueryRarity(COMMON_QUERY)).toBe(0);
		// Neutral (0.5) so an empty query can never move the weights.
		expect(estimateQueryRarity("")).toBe(0.5);
		expect(estimateQueryRarity("   ?? ")).toBe(0.5);
	});
});

// ---------------------------------------------------------------------------
// Part A — weight tilt
// ---------------------------------------------------------------------------

describe("adaptBackendWeights", () => {
	test("a rare/identifier query shifts weight toward lexical backends", () => {
		const weights = adaptBackendWeights(DEFAULT_WEIGHTS, RARE_QUERY, 0.5);

		// tilt = +0.5 → lexical x1.5, semantic x0.5
		expect(weights.symbolGraph).toBeCloseTo(1.8, 12);
		expect(weights.lsp).toBeCloseTo(2.25, 12);
		expect(weights.treeSitter).toBeCloseTo(1.65, 12);
		expect(weights.semantic).toBeCloseTo(0.5, 12);
		expect(weights.location).toBeCloseTo(1.35, 12);
	});

	test("a common-word query shifts weight toward the semantic backend", () => {
		const weights = adaptBackendWeights(DEFAULT_WEIGHTS, COMMON_QUERY, 0.5);

		// tilt = -0.5 → lexical x0.5, semantic x1.5
		expect(weights.symbolGraph).toBeCloseTo(0.6, 12);
		expect(weights.lsp).toBeCloseTo(0.75, 12);
		expect(weights.treeSitter).toBeCloseTo(0.55, 12);
		expect(weights.semantic).toBeCloseTo(1.5, 12);
		expect(weights.location).toBeCloseTo(0.45, 12);
	});

	test("the two queries move symbol-graph and semantic in opposite directions", () => {
		const rare = adaptBackendWeights(DEFAULT_WEIGHTS, RARE_QUERY, 0.5);
		const common = adaptBackendWeights(DEFAULT_WEIGHTS, COMMON_QUERY, 0.5);

		expect(rare.symbolGraph).toBeGreaterThan(DEFAULT_WEIGHTS.symbolGraph);
		expect(common.symbolGraph).toBeLessThan(DEFAULT_WEIGHTS.symbolGraph);
		expect(rare.semantic).toBeLessThan(DEFAULT_WEIGHTS.semantic);
		expect(common.semantic).toBeGreaterThan(DEFAULT_WEIGHTS.semantic);

		// Static weights give both queries the same symbol-graph share (54.5%);
		// the tilt makes them 78.3% vs 28.6%.
		expect(rare.symbolGraph / (rare.symbolGraph + rare.semantic)).toBeCloseTo(
			1.8 / 2.3,
			12,
		);
		expect(
			common.symbolGraph / (common.symbolGraph + common.semantic),
		).toBeCloseTo(0.6 / 2.1, 12);
	});

	test("a neutral-rarity query leaves the weights unchanged", () => {
		// "handle" (6 chars → 0.25) + "userRequest" (identifier → 1) → mean 0.625,
		// so pick a pair that averages exactly 0.5: 0-rarity + 1-rarity.
		const weights = adaptBackendWeights(DEFAULT_WEIGHTS, "the getUser", 0.5);
		expect(estimateQueryRarity("the getUser")).toBe(0.5);
		expect(weights).toEqual(DEFAULT_WEIGHTS);
	});

	test("strength 0 is an identity no-op", () => {
		expect(adaptBackendWeights(DEFAULT_WEIGHTS, RARE_QUERY, 0)).toBe(
			DEFAULT_WEIGHTS,
		);
	});

	test("strength is clamped and never produces a negative weight", () => {
		// strength 5 clamps to 1 → tilt ±1 → the losing side hits exactly 0.
		const rare = adaptBackendWeights(DEFAULT_WEIGHTS, RARE_QUERY, 5);
		expect(rare.semantic).toBe(0);
		expect(rare.symbolGraph).toBeCloseTo(2.4, 12);

		const common = adaptBackendWeights(DEFAULT_WEIGHTS, COMMON_QUERY, 5);
		expect(common.symbolGraph).toBe(0);
		expect(common.semantic).toBeCloseTo(2.0, 12);

		for (const weight of Object.values(common)) {
			expect(weight).toBeGreaterThanOrEqual(0);
		}
	});

	test("the input weights object is not mutated", () => {
		const input = { ...DEFAULT_WEIGHTS };
		adaptBackendWeights(input, RARE_QUERY, 0.5);
		expect(input).toEqual(DEFAULT_WEIGHTS);
	});
});

// ---------------------------------------------------------------------------
// Part A — convexity is preserved
// ---------------------------------------------------------------------------

describe("tilted weights keep tm2c2 convex", () => {
	/** Give every backend one distinct doc at score 1, so each doc's fused
	 * score IS that backend's renormalized weight and the sum must be 1. */
	function sharesFor(
		query: string,
		active: BackendName[],
	): { total: number; byBackend: Map<BackendName, number> } {
		const weights = adaptBackendWeights(DEFAULT_WEIGHTS, query, 0.5);
		const input = active.map((name) => ({
			name,
			results: [backendResult({ id: name, score: 1, backend: name })],
		}));
		const merged = tm2c2Merge(input, { backendWeights: weights }, 100);
		const byBackend = new Map<BackendName, number>(
			merged.map((r) => [r.id as BackendName, r.rrfScore]),
		);
		return {
			total: merged.reduce((sum, r) => sum + r.rrfScore, 0),
			byBackend,
		};
	}

	test("weights sum to 1 across all five backends, for either query", () => {
		const all: BackendName[] = [
			"symbol-graph",
			"lsp",
			"tree-sitter",
			"semantic",
			"location",
		];
		expect(sharesFor(RARE_QUERY, all).total).toBeCloseTo(1, 12);
		expect(sharesFor(COMMON_QUERY, all).total).toBeCloseTo(1, 12);
	});

	test("weights still sum to 1 when a backend returns nothing", () => {
		const weights = adaptBackendWeights(DEFAULT_WEIGHTS, RARE_QUERY, 0.5);
		const merged = tm2c2Merge(
			[
				{ name: "lsp", results: [] },
				{ name: "location", results: [] },
				{
					name: "symbol-graph",
					results: [
						backendResult({ id: "sg", score: 1, backend: "symbol-graph" }),
					],
				},
				{ name: "semantic", results: [backendResult({ id: "sem", score: 1 })] },
			],
			{ backendWeights: weights },
			100,
		);

		expect(merged.reduce((sum, r) => sum + r.rrfScore, 0)).toBeCloseTo(1, 12);
		// The absent backends ate no weight mass: shares are 1.8/2.3 and 0.5/2.3.
		const byId = new Map(merged.map((r) => [r.id, r.rrfScore]));
		expect(byId.get("sg")).toBeCloseTo(1.8 / 2.3, 12);
		expect(byId.get("sem")).toBeCloseTo(0.5 / 2.3, 12);
	});

	test("the tilt moves the shares, and fused scores stay in [0, 1]", () => {
		const active: BackendName[] = ["symbol-graph", "semantic"];
		const rare = sharesFor(RARE_QUERY, active);
		const common = sharesFor(COMMON_QUERY, active);

		expect(rare.byBackend.get("symbol-graph")).toBeCloseTo(1.8 / 2.3, 12);
		expect(common.byBackend.get("symbol-graph")).toBeCloseTo(0.6 / 2.1, 12);
		// Static weights would have given both exactly 1.2 / 2.2.
		expect(rare.byBackend.get("symbol-graph")).not.toBeCloseTo(1.2 / 2.2, 3);
		expect(common.byBackend.get("symbol-graph")).not.toBeCloseTo(1.2 / 2.2, 3);

		for (const share of [...rare.byBackend.values()]) {
			expect(share).toBeGreaterThanOrEqual(0);
			expect(share).toBeLessThanOrEqual(1);
		}
	});

	test("an all-zero tilted weight vector still yields a convex combination", () => {
		// strength 1 on a common query zeroes every lexical weight; if only
		// lexical backends return results, tm2c2's uniform fallback must keep the
		// combination convex rather than dividing by zero.
		const weights = adaptBackendWeights(DEFAULT_WEIGHTS, COMMON_QUERY, 1);
		const merged = tm2c2Merge(
			[
				{
					name: "symbol-graph",
					results: [
						backendResult({ id: "sg", score: 1, backend: "symbol-graph" }),
					],
				},
				{
					name: "tree-sitter",
					results: [
						backendResult({ id: "ts", score: 1, backend: "tree-sitter" }),
					],
				},
			],
			{ backendWeights: weights },
			100,
		);

		expect(merged.reduce((sum, r) => sum + r.rrfScore, 0)).toBeCloseTo(1, 12);
		expect(merged.every((r) => Number.isFinite(r.rrfScore))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Part B — query-length-relaxed score floor
// ---------------------------------------------------------------------------

const FLOOR: PipelineConfig["scoreFloor"] = {
	minScore: 0.5,
	relaxForLongQueries: true,
	shortQueryTokens: 4,
	longQueryTokens: 16,
	maxRelaxation: 0.5,
};

/** 17 tokens — past the ramp's upper bound (16), so maximally relaxed. */
const LONG_QUERY =
	"how does the retry logic decide when to give up and surface an error to the caller";

/** 2 tokens — at/below the ramp's lower bound, so not relaxed at all. */
const SHORT_QUERY = "retry logic";

describe("effectiveScoreFloor", () => {
	test("short queries get the full floor", () => {
		expect(tokenizeQuery(SHORT_QUERY).length).toBe(2);
		expect(effectiveScoreFloor(SHORT_QUERY, FLOOR)).toBeCloseTo(0.5, 12);
		// Exactly at the lower bound is still unrelaxed.
		expect(effectiveScoreFloor("a b c d", FLOOR)).toBeCloseTo(0.5, 12);
	});

	test("long queries get the maximally relaxed floor", () => {
		expect(tokenizeQuery(LONG_QUERY).length).toBe(17);
		expect(effectiveScoreFloor(LONG_QUERY, FLOOR)).toBeCloseTo(0.25, 12);
		// Exactly at the upper bound is already maximally relaxed.
		expect(
			effectiveScoreFloor("a b c d e f g h i j k l m n o p", FLOOR),
		).toBeCloseTo(0.25, 12);
	});

	test("mid-length queries interpolate linearly", () => {
		// 10 tokens → ramp (10-4)/12 = 0.5 → floor 0.5 * (1 - 0.25) = 0.375
		const midQuery = "a b c d e f g h i j";
		expect(tokenizeQuery(midQuery).length).toBe(10);
		expect(effectiveScoreFloor(midQuery, FLOOR)).toBeCloseTo(0.375, 12);
	});

	test("relaxation off leaves the floor flat at every length", () => {
		const flat = { ...FLOOR, relaxForLongQueries: false };
		expect(effectiveScoreFloor(SHORT_QUERY, flat)).toBe(0.5);
		expect(effectiveScoreFloor(LONG_QUERY, flat)).toBe(0.5);
	});

	test("degenerate ramp bounds do not produce NaN", () => {
		const degenerate = { ...FLOOR, shortQueryTokens: 8, longQueryTokens: 8 };
		expect(effectiveScoreFloor(SHORT_QUERY, degenerate)).toBeCloseTo(0.5, 12);
		expect(effectiveScoreFloor(LONG_QUERY, degenerate)).toBeCloseTo(0.25, 12);
	});
});

describe("applyScoreFloor", () => {
	const semanticHits = [
		backendResult({ id: "strong", score: 0.9 }),
		backendResult({ id: "diluted", score: 0.3 }),
	];

	test("the long-query relaxation admits a hit the short-query floor drops", () => {
		const input = [{ name: "semantic" as const, results: semanticHits }];

		const short = applyScoreFloor(input, SHORT_QUERY, FLOOR);
		expect(short[0].results.map((r) => r.id)).toEqual(["strong"]);

		const long = applyScoreFloor(input, LONG_QUERY, FLOOR);
		expect(long[0].results.map((r) => r.id)).toEqual(["strong", "diluted"]);
	});

	test("short queries are unaffected by turning relaxation on", () => {
		const input = [{ name: "semantic" as const, results: semanticHits }];
		const flat = { ...FLOOR, relaxForLongQueries: false };

		expect(
			applyScoreFloor(input, SHORT_QUERY, FLOOR)[0].results.map((r) => r.id),
		).toEqual(
			applyScoreFloor(input, SHORT_QUERY, flat)[0].results.map((r) => r.id),
		);
	});

	test("only embedding-scored backends are floored", () => {
		// tree-sitter/location scores are rank-derived; a floor on them would be
		// a floor on a rank, which has nothing to do with embedding dilution.
		const input = [
			{
				name: "location" as const,
				results: [
					backendResult({ id: "loc", score: 0.05, backend: "location" }),
				],
			},
			{
				name: "tree-sitter" as const,
				results: [
					backendResult({ id: "ts", score: 0.01, backend: "tree-sitter" }),
				],
			},
			{ name: "semantic" as const, results: semanticHits },
		];

		const out = applyScoreFloor(input, SHORT_QUERY, FLOOR);
		expect(out[0].results.map((r) => r.id)).toEqual(["loc"]);
		expect(out[1].results.map((r) => r.id)).toEqual(["ts"]);
		expect(out[2].results.map((r) => r.id)).toEqual(["strong"]);
	});

	test("minScore 0 (the default) returns the input by identity", () => {
		const input = [{ name: "semantic" as const, results: semanticHits }];
		expect(
			applyScoreFloor(input, LONG_QUERY, DEFAULT_PIPELINE_CONFIG.scoreFloor),
		).toBe(input);
		expect(applyScoreFloor(input, SHORT_QUERY, { ...FLOOR, minScore: 0 })).toBe(
			input,
		);
	});

	test("a floor of 1 keeps only a perfect hit", () => {
		const input = [
			{
				name: "semantic" as const,
				results: [...semanticHits, backendResult({ id: "perfect", score: 1 })],
			},
		];
		const out = applyScoreFloor(input, SHORT_QUERY, {
			...FLOOR,
			minScore: 1,
			relaxForLongQueries: false,
		});
		expect(out[0].results.map((r) => r.id)).toEqual(["perfect"]);
	});
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

describe("adaptation config", () => {
	test("both features default to off", () => {
		expect(DEFAULT_PIPELINE_CONFIG.adaptiveWeights.enabled).toBe(false);
		expect(DEFAULT_PIPELINE_CONFIG.scoreFloor.minScore).toBe(0);
		expect(DEFAULT_PIPELINE_CONFIG.scoreFloor.relaxForLongQueries).toBe(false);

		const loaded = withEnv(
			{
				MNEMEX_PIPELINE_ADAPTIVE_WEIGHTS: undefined,
				MNEMEX_PIPELINE_ADAPTIVE_STRENGTH: undefined,
				MNEMEX_PIPELINE_SCORE_FLOOR: undefined,
				MNEMEX_PIPELINE_SCORE_FLOOR_RELAX: undefined,
				MNEMEX_PIPELINE_SCORE_FLOOR_MAX_RELAX: undefined,
			},
			() => loadPipelineConfig(),
		);
		expect(loaded.adaptiveWeights).toEqual({ enabled: false, strength: 0.5 });
		expect(loaded.scoreFloor).toEqual(DEFAULT_PIPELINE_CONFIG.scoreFloor);
	});

	test("explicit values are honored", () => {
		const loaded = withEnv(
			{
				MNEMEX_PIPELINE_ADAPTIVE_WEIGHTS: "true",
				MNEMEX_PIPELINE_ADAPTIVE_STRENGTH: "0.25",
				MNEMEX_PIPELINE_SCORE_FLOOR: "0.4",
				MNEMEX_PIPELINE_SCORE_FLOOR_RELAX: "1",
				MNEMEX_PIPELINE_SCORE_FLOOR_MAX_RELAX: "0.75",
			},
			() => loadPipelineConfig(),
		);

		expect(loaded.adaptiveWeights).toEqual({ enabled: true, strength: 0.25 });
		expect(loaded.scoreFloor.minScore).toBe(0.4);
		expect(loaded.scoreFloor.relaxForLongQueries).toBe(true);
		expect(loaded.scoreFloor.maxRelaxation).toBe(0.75);
	});

	test("bogus values fall back to the default without throwing", () => {
		for (const bogus of ["banana", "NaN", "0.4.2", "-"]) {
			const loaded = withEnv(
				{
					MNEMEX_PIPELINE_ADAPTIVE_STRENGTH: bogus,
					MNEMEX_PIPELINE_SCORE_FLOOR: bogus,
					MNEMEX_PIPELINE_SCORE_FLOOR_MAX_RELAX: bogus,
				},
				() => loadPipelineConfig(),
			);
			expect(loaded.adaptiveWeights.strength).toBe(0.5);
			expect(loaded.scoreFloor.minScore).toBe(0);
			expect(loaded.scoreFloor.maxRelaxation).toBe(0.5);
		}

		// A bogus boolean is falsey, i.e. still off.
		expect(
			withEnv({ MNEMEX_PIPELINE_ADAPTIVE_WEIGHTS: "yes" }, () =>
				loadPipelineConfig(),
			).adaptiveWeights.enabled,
		).toBe(false);
	});

	test("out-of-range fractions clamp instead of reverting to the default", () => {
		// "drop everything" is a legitimate operator request; silently restoring
		// 0 (keep everything) would be the opposite of what they typed.
		const loaded = withEnv(
			{
				MNEMEX_PIPELINE_SCORE_FLOOR: "2",
				MNEMEX_PIPELINE_ADAPTIVE_STRENGTH: "-1",
			},
			() => loadPipelineConfig(),
		);
		expect(loaded.scoreFloor.minScore).toBe(1);
		expect(loaded.adaptiveWeights.strength).toBe(0);
	});

	test("Infinity is treated as unparseable, not as a clamp target", () => {
		expect(
			withEnv({ MNEMEX_PIPELINE_SCORE_FLOOR: "Infinity" }, () =>
				loadPipelineConfig(),
			).scoreFloor.minScore,
		).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// OFF is inert, end to end through the orchestrator
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

const CLASSIFICATION: QueryClassification = {
	intent: "structural",
	confidence: 0.9,
	extractedEntities: [],
};

const FAKE_ROUTER = {
	route: async () => ({ classification: CLASSIFICATION, strategy: {} }),
} as unknown as QueryRouter;

/** The exact lists the fake backends return, in orchestrator fan-out order. */
const FIXTURE_RESULTS: Array<{ name: BackendName; results: BackendResult[] }> =
	[
		{
			name: "symbol-graph",
			results: [
				backendResult({ id: "sg-1", score: 0.9, backend: "symbol-graph" }),
				backendResult({ id: "shared", score: 0.4, backend: "symbol-graph" }),
			],
		},
		{
			name: "tree-sitter",
			results: [
				backendResult({ id: "ts-1", score: 0.8, backend: "tree-sitter" }),
			],
		},
		{
			name: "semantic",
			results: [
				backendResult({ id: "shared", score: 0.7 }),
				backendResult({ id: "sem-weak", score: 0.2 }),
			],
		},
	];

function fakeBackends(): ISearchBackend[] {
	// Fresh copies: merge mutates the MergedResult objects it builds.
	return FIXTURE_RESULTS.map(
		({ name, results }) =>
			new FakeBackend(
				name,
				results.map((r) => ({ ...r })),
			),
	);
}

async function searchWith(
	config: PipelineConfig,
	query: string,
	options: SearchOptions = {},
): Promise<MergedResult[]> {
	return new PipelineOrchestrator(FAKE_ROUTER, fakeBackends(), config).search(
		query,
		options,
	);
}

describe("default config is byte-identical to pre-change behavior", () => {
	/** What the orchestrator did before adaptation existed: fuse the backend
	 * lists directly with the static config — no floor, no tilt. */
	function baseline(limit: number): MergedResult[] {
		return rrfMerge(
			FIXTURE_RESULTS.map(({ name, results }) => ({
				name,
				results: results.map((r) => ({ ...r })),
			})),
			DEFAULT_PIPELINE_CONFIG,
			limit,
		);
	}

	test("rrf output matches the unadapted fusion exactly", async () => {
		for (const query of [SHORT_QUERY, LONG_QUERY, RARE_QUERY, COMMON_QUERY]) {
			const actual = await searchWith(DEFAULT_PIPELINE_CONFIG, query, {
				limit: 10,
			});
			expect(actual).toEqual(baseline(10));
		}
	});

	test("query length and query shape do not change the default output", async () => {
		const short = await searchWith(DEFAULT_PIPELINE_CONFIG, SHORT_QUERY, {
			limit: 10,
		});
		const long = await searchWith(DEFAULT_PIPELINE_CONFIG, LONG_QUERY, {
			limit: 10,
		});
		const rare = await searchWith(DEFAULT_PIPELINE_CONFIG, RARE_QUERY, {
			limit: 10,
		});

		expect(JSON.stringify(long)).toBe(JSON.stringify(short));
		expect(JSON.stringify(rare)).toBe(JSON.stringify(short));
	});

	test("tm2c2 under the default config is also unaffected by the query", async () => {
		const config: PipelineConfig = {
			...DEFAULT_PIPELINE_CONFIG,
			fusionMethod: "tm2c2",
		};
		const rare = await searchWith(config, RARE_QUERY, { limit: 10 });
		const common = await searchWith(config, COMMON_QUERY, { limit: 10 });
		expect(JSON.stringify(rare)).toBe(JSON.stringify(common));
	});
});

describe("enabled adaptation changes orchestrator output", () => {
	test("the tilt reorders results a static weight vector ties", async () => {
		const tilted: PipelineConfig = {
			...DEFAULT_PIPELINE_CONFIG,
			fusionMethod: "tm2c2",
			adaptiveWeights: { enabled: true, strength: 0.9 },
		};

		const rare = await searchWith(tilted, RARE_QUERY, { limit: 10 });
		const common = await searchWith(tilted, COMMON_QUERY, { limit: 10 });

		// Same documents, different fused scores — the query moved the weights.
		expect(new Set(rare.map((r) => r.id))).toEqual(
			new Set(common.map((r) => r.id)),
		);
		expect(JSON.stringify(rare)).not.toBe(JSON.stringify(common));

		// The lexical-only hit outranks the semantic-only hit on a rare query
		// and loses to it on a common one.
		const rank = (list: MergedResult[], id: string) =>
			list.findIndex((r) => r.id === id);
		expect(rank(rare, "sg-1")).toBeLessThan(rank(rare, "sem-weak"));
		expect(rank(common, "sg-1")).toBeGreaterThan(rank(common, "sem-weak"));
	});

	test("the floor drops a weak semantic hit, and relaxation restores it on a long query", async () => {
		const floored: PipelineConfig = {
			...DEFAULT_PIPELINE_CONFIG,
			scoreFloor: { ...FLOOR, minScore: 0.3 },
		};

		const short = await searchWith(floored, SHORT_QUERY, { limit: 10 });
		expect(short.map((r) => r.id)).not.toContain("sem-weak");

		const long = await searchWith(floored, LONG_QUERY, { limit: 10 });
		expect(long.map((r) => r.id)).toContain("sem-weak");

		// The lexical backends are untouched at both lengths.
		expect(short.map((r) => r.id)).toContain("ts-1");
		expect(long.map((r) => r.id)).toContain("ts-1");
	});
});
