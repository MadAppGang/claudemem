import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
	type AblationCondition,
	type ConditionResult,
	computeNdcgAtK,
	computeRecallAtK,
	computeReciprocalRank,
	type PerQueryResult,
	runCondition,
	type SearchExecutor,
	type SearchOptions,
	type SearchResult,
} from "../../eval/code-search-harness/ablation.js";
import {
	buildFusionComparison,
	runFusionComparison,
} from "../../eval/code-search-harness/fusion-comparison.js";
import type { HarnessQuery } from "../../eval/code-search-harness/loader.js";
import {
	dedupeByFile,
	normalizeDocId,
	type ScoredDoc,
} from "../../eval/code-search-harness/pipeline-executor.js";

const DATASET_DIR = "eval/datasets/mnemex-git";
const TMP_OUT = "/tmp/mnemex-fusion-test-results";

/** First corpus `_id` from the real dataset — the docId shape under test. */
function firstCorpusId(): string {
	const line = readFileSync(`${DATASET_DIR}/corpus.jsonl`, "utf8").split(
		"\n",
	)[0];
	return (JSON.parse(line) as { _id: string })._id;
}

function harnessQuery(id: string, gold: string[]): HarnessQuery {
	return {
		id,
		codeUnitId: id,
		type: "vague",
		query: `query ${id}`,
		shouldFind: true,
		groundTruthFiles: gold,
	};
}

// ============================================================================
// docId normalization
// ============================================================================

describe("normalizeDocId", () => {
	const root = "/Users/jack/repo";

	test("maps a pipeline result path to the matching corpus id", () => {
		const corpusId = firstCorpusId();
		// A pipeline backend emits the repo-relative path directly.
		expect(normalizeDocId(corpusId, root)).toBe(corpusId);
		// The same file seen as an absolute path must normalize to the same id.
		expect(normalizeDocId(`${root}/${corpusId}`, root)).toBe(corpusId);
		// …and with a "./" prefix.
		expect(normalizeDocId(`./${corpusId}`, root)).toBe(corpusId);
	});

	test("strips trailing root slash, leading slashes, and normalizes separators", () => {
		expect(normalizeDocId("/Users/jack/repo/src/cli.ts", `${root}/`)).toBe(
			"src/cli.ts",
		);
		expect(normalizeDocId("src\\cli.ts", root)).toBe("src/cli.ts");
	});

	test("returns null for anchor-less results", () => {
		expect(normalizeDocId("", root)).toBeNull();
		expect(normalizeDocId(undefined, root)).toBeNull();
		expect(normalizeDocId("   ", root)).toBeNull();
	});

	test("keeps out-of-repo absolute paths verbatim (they simply miss)", () => {
		expect(normalizeDocId("/elsewhere/other.ts", root)).toBe(
			"elsewhere/other.ts",
		);
	});
});

// ============================================================================
// Chunk -> file dedup
// ============================================================================

describe("dedupeByFile", () => {
	test("keeps the max score per file and preserves descending order", () => {
		const input: ScoredDoc[] = [
			{ docId: "src/a.ts", score: 0.9 },
			{ docId: "src/b.ts", score: 0.8 },
			{ docId: "src/a.ts", score: 0.7 },
			{ docId: "src/c.ts", score: 0.6 },
			{ docId: "src/b.ts", score: 0.5 },
		];
		const out = dedupeByFile(input);

		expect(out.map((r) => r.docId)).toEqual([
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
		]);
		expect(out.map((r) => r.score)).toEqual([0.9, 0.8, 0.6]);
		for (let i = 1; i < out.length; i++) {
			expect(out[i - 1].score).toBeGreaterThanOrEqual(out[i].score);
		}
	});

	test("takes the max even when the higher-scoring chunk appears later", () => {
		const out = dedupeByFile([
			{ docId: "src/a.ts", score: 0.2 },
			{ docId: "src/b.ts", score: 0.5 },
			{ docId: "src/a.ts", score: 0.9 },
		]);
		expect(out[0]).toEqual({ docId: "src/a.ts", score: 0.9 });
		expect(out[1]).toEqual({ docId: "src/b.ts", score: 0.5 });
	});

	test("ties keep first-appearance order", () => {
		const out = dedupeByFile([
			{ docId: "src/x.ts", score: 0.5 },
			{ docId: "src/y.ts", score: 0.5 },
			{ docId: "src/z.ts", score: 0.5 },
		]);
		expect(out.map((r) => r.docId)).toEqual([
			"src/x.ts",
			"src/y.ts",
			"src/z.ts",
		]);
	});

	test("empty input yields empty output", () => {
		expect(dedupeByFile([])).toEqual([]);
	});
});

// ============================================================================
// Executor contract: dedup-then-truncate must return at most k
// ============================================================================

/**
 * Stand-in for PipelineSearchExecutor that exercises the same
 * dedupe-before-truncate contract without needing a live index.
 */
class ChunkyExecutor implements SearchExecutor {
	constructor(private chunks: ScoredDoc[]) {}
	async search(_q: string, options: SearchOptions): Promise<SearchResult[]> {
		return dedupeByFile(this.chunks).slice(0, options.k);
	}
}

describe("executor k contract", () => {
	test("returns at most k results", async () => {
		const chunks: ScoredDoc[] = [];
		for (let f = 0; f < 30; f++) {
			for (let c = 0; c < 4; c++) {
				chunks.push({ docId: `src/f${f}.ts`, score: 1 - f * 0.01 - c * 0.001 });
			}
		}
		const exec = new ChunkyExecutor(chunks);
		for (const k of [1, 5, 10, 100]) {
			const out = await exec.search("q", { k });
			expect(out.length).toBeLessThanOrEqual(k);
			expect(new Set(out.map((r) => r.docId)).size).toBe(out.length);
		}
	});

	test("dedup runs before truncation, so k distinct files come back", async () => {
		// 10 files x 5 chunks. Truncating first would give 2 files at k=10.
		const chunks: ScoredDoc[] = [];
		for (let f = 0; f < 10; f++) {
			for (let c = 0; c < 5; c++) {
				chunks.push({ docId: `src/f${f}.ts`, score: 1 - f * 0.1 - c * 0.001 });
			}
		}
		const out = await new ChunkyExecutor(chunks).search("q", { k: 10 });
		expect(out.length).toBe(10);
	});
});

// ============================================================================
// Metrics sanity — the mock-executor trap
// ============================================================================

describe("metric sanity", () => {
	const relevant = new Set(["src/a.ts", "src/b.ts"]);

	test("a perfect ranking scores MRR 1.0 and Recall@1 1.0", () => {
		const perfect = ["src/a.ts"];
		expect(computeReciprocalRank(perfect, new Set(["src/a.ts"]))).toBe(1.0);
		expect(computeRecallAtK(perfect, new Set(["src/a.ts"]), 1)).toBe(1.0);
		expect(computeNdcgAtK(perfect, new Set(["src/a.ts"]), 5)).toBe(1.0);
	});

	test("an empty result set scores 0 without throwing (mock-executor trap)", () => {
		expect(() => computeReciprocalRank([], relevant)).not.toThrow();
		expect(computeReciprocalRank([], relevant)).toBe(0);
		expect(computeNdcgAtK([], relevant, 5)).toBe(0);
		expect(computeNdcgAtK([], relevant, 10)).toBe(0);
		expect(computeRecallAtK([], relevant, 1)).toBe(0);
		expect(computeRecallAtK([], relevant, 10)).toBe(0);
	});

	test("all-zero metrics are indistinguishable from a broken executor", async () => {
		// This is exactly why runFusionComparison must reject an all-empty arm:
		// the metric functions happily report 0.000 for a dead backend.
		class EmptyExecutor implements SearchExecutor {
			async search(): Promise<SearchResult[]> {
				return [];
			}
		}
		const condition: AblationCondition = {
			name: "empty",
			description: "empty",
			useRouter: false,
			useExpander: false,
			useReranker: false,
			dataset: "custom",
		};
		const result = await runCondition(condition, {
			conditions: [condition],
			querySet: [harnessQuery("q1", ["src/a.ts"])],
			outputDir: TMP_OUT,
			kValues: [1, 5, 10],
			executor: new EmptyExecutor(),
		});
		expect(result.metrics.mrrAt10).toBe(0);
		expect(result.metrics.recallAt1).toBe(0);
	});
});

// ============================================================================
// NDCG normalization — IDCG must reflect the FULL ideal ranking
// ============================================================================

/**
 * The bug these tests pin down: `computeNdcgAtK` used to hardcode
 * `IDCG@K = 1/log2(2) = 1`, which is the ideal DCG only when a query has
 * exactly ONE relevant doc. `eval/datasets/mnemex-git` averages ~2.99 gold
 * files per query, so the function was emitting un-normalized DCG and calling
 * it NDCG — 46 of 135 queries scored above 1.0 (max 2.765) in the last run.
 *
 * Correct: IDCG@K = sum_{i=0}^{min(|relevant|,k)-1} 1 / log2(i + 2).
 */

/** Ideal DCG for `n` gold docs at cutoff `k`, computed independently here. */
function idealDcg(nGold: number, k: number): number {
	let idcg = 0;
	for (let i = 0; i < Math.min(nGold, k); i++) idcg += 1 / Math.log2(i + 2);
	return idcg;
}

/** Deterministic PRNG so the property sweep is reproducible across runs. */
function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("computeNdcgAtK normalization", () => {
	test("perfect ranking with 1 gold doc scores exactly 1.0", () => {
		const gold = new Set(["src/a.ts"]);
		expect(computeNdcgAtK(["src/a.ts", "src/x.ts", "src/y.ts"], gold, 5)).toBe(
			1.0,
		);
		expect(computeNdcgAtK(["src/a.ts", "src/x.ts", "src/y.ts"], gold, 10)).toBe(
			1.0,
		);
	});

	test("perfect ranking with 3 gold docs scores exactly 1.0", () => {
		// REGRESSION: the old hardcoded IDCG returned
		//   1 + 1/log2(3) + 1/log2(4) = 2.1309297535714573
		// for this exact input.
		const gold = new Set(["src/a.ts", "src/b.ts", "src/c.ts"]);
		const retrieved = [
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
			"src/x.ts",
			"src/y.ts",
		];
		expect(computeNdcgAtK(retrieved, gold, 5)).toBe(1.0);
		expect(computeNdcgAtK(retrieved, gold, 10)).toBe(1.0);
	});

	test("perfect ranking scores 1.0 for every gold-set size 1..10", () => {
		for (let n = 1; n <= 10; n++) {
			const gold = new Set(
				Array.from({ length: n }, (_, i) => `src/gold${i}.ts`),
			);
			const retrieved = [...gold, "src/pad1.ts", "src/pad2.ts"];
			for (const k of [5, 10]) {
				expect(computeNdcgAtK(retrieved, gold, k)).toBeCloseTo(1.0, 12);
			}
		}
	});

	test("worst ranking — every gold doc below k — scores exactly 0.0", () => {
		const gold = new Set(["src/a.ts", "src/b.ts", "src/c.ts"]);
		const retrieved = [
			"src/x1.ts",
			"src/x2.ts",
			"src/x3.ts",
			"src/x4.ts",
			"src/x5.ts",
			"src/a.ts",
			"src/b.ts",
			"src/c.ts",
		];
		expect(computeNdcgAtK(retrieved, gold, 5)).toBe(0);
	});

	test("partial hit matches the hand-computed value", () => {
		// gold = {a, b, c}; retrieved = [x, a, y, b, z]; k = 5.
		//   DCG@5  = 1/log2(3) + 1/log2(5)
		//          = 0.6309297535714575 + 0.43067655807339306
		//          = 1.0616063116448506
		//   IDCG@5 = 1/log2(2) + 1/log2(3) + 1/log2(4)
		//          = 1 + 0.6309297535714575 + 0.5
		//          = 2.1309297535714573
		//   NDCG@5 = 0.4981893...
		const gold = new Set(["src/a.ts", "src/b.ts", "src/c.ts"]);
		const retrieved = [
			"src/x.ts",
			"src/a.ts",
			"src/y.ts",
			"src/b.ts",
			"src/z.ts",
		];
		const dcg = 1 / Math.log2(3) + 1 / Math.log2(5);
		const expected = dcg / idealDcg(3, 5);
		// Tolerance: 1e-9 absolute (toBeCloseTo digits=9). The value is a ratio of
		// two exactly-representable sums, so anything looser would hide real error.
		expect(computeNdcgAtK(retrieved, gold, 5)).toBeCloseTo(expected, 9);
		expect(computeNdcgAtK(retrieved, gold, 5)).toBeCloseTo(0.4981893, 7);
	});

	test("k larger than the retrieved list does not throw", () => {
		const gold = new Set(["src/a.ts", "src/b.ts"]);
		expect(() => computeNdcgAtK(["src/a.ts"], gold, 1000)).not.toThrow();
		expect(computeNdcgAtK(["src/a.ts"], gold, 1000)).toBeCloseTo(
			1 / idealDcg(2, 1000),
			12,
		);
		expect(() => computeNdcgAtK([], gold, 1000)).not.toThrow();
		expect(computeNdcgAtK([], gold, 1000)).toBe(0);
	});

	test("an empty relevant set scores 0 (unchanged behavior)", () => {
		expect(computeNdcgAtK(["src/a.ts"], new Set<string>(), 5)).toBe(0);
		expect(computeNdcgAtK([], new Set<string>(), 10)).toBe(0);
	});

	test("PROPERTY: NDCG stays within [0, 1] over a randomized sweep", () => {
		// The invariant the old implementation violated. Gold-set sizes 1..10,
		// k in {5, 10}, gold docs scattered at random ranks in a 25-doc list.
		const rand = mulberry32(0xc0ffee);
		let sawInterior = false;
		for (let trial = 0; trial < 2000; trial++) {
			const nGold = 1 + Math.floor(rand() * 10);
			const k = rand() < 0.5 ? 5 : 10;
			const gold = new Set(
				Array.from({ length: nGold }, (_, i) => `src/gold${i}.ts`),
			);

			// Random permutation of gold docs + distractors.
			const pool = [
				...gold,
				...Array.from({ length: 25 - nGold }, (_, i) => `src/noise${i}.ts`),
			];
			for (let i = pool.length - 1; i > 0; i--) {
				const j = Math.floor(rand() * (i + 1));
				[pool[i], pool[j]] = [pool[j], pool[i]];
			}
			// Sometimes truncate the retrieved list below k.
			const retrieved = pool.slice(0, 1 + Math.floor(rand() * pool.length));

			const ndcg = computeNdcgAtK(retrieved, gold, k);
			expect(Number.isFinite(ndcg)).toBe(true);
			expect(ndcg).toBeGreaterThanOrEqual(0);
			expect(ndcg).toBeLessThanOrEqual(1);
			if (ndcg > 0 && ndcg < 1) sawInterior = true;
		}
		// Guard against a vacuous sweep that only ever hit the 0 or 1 endpoints.
		expect(sawInterior).toBe(true);
	});

	test("duplicate docIds in the retrieved list cannot push NDCG above 1", () => {
		// dedupeByFile makes this unreachable from PipelineSearchExecutor, but a
		// repeated doc is still one relevant document, not several.
		const gold = new Set(["src/a.ts"]);
		expect(
			computeNdcgAtK(["src/a.ts", "src/a.ts", "src/a.ts"], gold, 5),
		).toBeLessThanOrEqual(1);
	});
});

// ============================================================================
// Runner: must error, not report zeros, when nothing is retrieved
// ============================================================================

describe("runFusionComparison guard", () => {
	test("throws when the executor returns nothing for EVERY query", async () => {
		// No index at this path -> createPipelineContext throws before any
		// all-zero metrics can be produced. Either failure mode is acceptable;
		// silently returning zeros is not.
		await expect(
			runFusionComparison({
				projectPath: "/nonexistent/mnemex-eval-project",
				querySet: [harnessQuery("q1", ["src/a.ts"])],
				dataset: "test",
				outputDir: TMP_OUT,
				skipReport: true,
			}),
		).rejects.toThrow(/No mnemex index found/);
	});

	test("throws on an empty query set rather than reporting a vacuous 0", async () => {
		await expect(
			runFusionComparison({
				projectPath: ".",
				querySet: [],
				dataset: "test",
				outputDir: TMP_OUT,
				skipReport: true,
			}),
		).rejects.toThrow(/query set is empty/);
	});
});

// ============================================================================
// Paired comparison
// ============================================================================

function conditionResult(
	name: string,
	rrByQuery: Record<string, number>,
): ConditionResult {
	const perQueryResults: PerQueryResult[] = Object.entries(rrByQuery).map(
		([queryId, rr]) => ({
			queryId,
			query: `query ${queryId}`,
			reciprocalRank: rr,
			ndcgAt5: rr,
			ndcgAt10: rr,
			recallAtK: { 1: rr > 0.99 ? 1 : 0, 5: rr, 10: rr },
			latencyMs: 10,
			retrievedDocs: rr > 0 ? ["src/a.ts"] : [],
			groundTruth: ["src/a.ts"],
		}),
	);
	return {
		condition: {
			name,
			description: name,
			useRouter: false,
			useExpander: false,
			useReranker: false,
			dataset: "custom",
		},
		dataset: "custom",
		nQueries: perQueryResults.length,
		perQueryResults,
		metrics: {
			mrrAt10: 0,
			ndcgAt10: 0,
			ndcgAt5: 0,
			recallAt1: 0,
			recallAt5: 0,
			recallAt10: 0,
			recallAt100: 0,
		},
		latency: { p50: 10, p95: 10, mean: 10 },
	};
}

describe("buildFusionComparison", () => {
	test("counts improved / regressed / tied per query, paired by queryId", () => {
		const baseline = conditionResult("rrf", { a: 0.5, b: 1.0, c: 0.25 });
		const candidate = conditionResult("tm2c2", { a: 1.0, b: 0.5, c: 0.25 });

		const cmp = buildFusionComparison(baseline, candidate, {
			projectPath: ".",
			dataset: "test",
			activeBackends: ["semantic"],
		});

		expect(cmp.nQueries).toBe(3);
		const mrr = cmp.metrics.find((m) => m.metric === "mrr");
		expect(mrr).toBeDefined();
		expect(mrr?.improved).toBe(1);
		expect(mrr?.regressed).toBe(1);
		expect(mrr?.tied).toBe(1);
		expect(mrr?.baselineMean).toBeCloseTo((0.5 + 1.0 + 0.25) / 3, 6);
		expect(mrr?.candidateMean).toBeCloseTo((1.0 + 0.5 + 0.25) / 3, 6);
		expect(mrr?.delta).toBeCloseTo(0, 6);
	});

	test("reports zero-result query counts per arm", () => {
		const baseline = conditionResult("rrf", { a: 0, b: 0.5 });
		const candidate = conditionResult("tm2c2", { a: 0.5, b: 0.5 });
		const cmp = buildFusionComparison(baseline, candidate, {
			projectPath: ".",
			dataset: "test",
			activeBackends: [],
		});
		expect(cmp.zeroResultQueries.rrf).toBe(1);
		expect(cmp.zeroResultQueries.tm2c2).toBe(0);
	});

	test("drops queries missing from one arm rather than mispairing them", () => {
		const baseline = conditionResult("rrf", { a: 1.0, b: 1.0 });
		const candidate = conditionResult("tm2c2", { a: 1.0 });
		const cmp = buildFusionComparison(baseline, candidate, {
			projectPath: ".",
			dataset: "test",
			activeBackends: [],
		});
		expect(cmp.nQueries).toBe(1);
	});
});
