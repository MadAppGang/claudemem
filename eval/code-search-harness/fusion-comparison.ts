/**
 * Code Search Harness — Fusion Method Comparison (RRF vs TM2C2)
 *
 * Runs the SAME query set through the real retrieval pipeline twice, changing
 * only `PipelineConfig.fusionMethod`, and reports a PAIRED comparison.
 *
 * Why paired: both conditions see identical queries against an identical index,
 * so per-query deltas carry far more power than a difference of two independent
 * means. With n=135 an unpaired test would throw most of that away. The runner
 * reports per-query deltas, improved/regressed/tied counts, and the Wilcoxon
 * signed-rank test (via `reporter.ts`, which is already paired by queryId).
 *
 * Metric computation is entirely `ablation.ts`'s: this file calls `runCondition`
 * and only aggregates its `perQueryResults`. No metric code is duplicated.
 *
 * Usage:
 *   bun eval/code-search-harness/fusion-comparison.ts \
 *     --data-dir eval/datasets/mnemex-git \
 *     --project . --verbose
 *
 * Outputs (under --output, default eval/code-search-harness/results):
 *   condition_rrf.json      — full per-query results, RRF fusion
 *   condition_tm2c2.json    — full per-query results, TM2C2 fusion
 *   fusion-comparison.json  — paired summary (this file)
 *   fusion-report.md/.json  — reporter.ts markdown + JSON report
 */

import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { wilcoxonSignedRankTest } from "../../src/benchmark-v2/scorers/statistics.js";
import type { FusionMethod } from "../../src/retrieval/pipeline/config.js";
import type {
	AblationCondition,
	ConditionResult,
	PerQueryResult,
} from "./ablation.js";
import { runCondition } from "./ablation.js";
import type { HarnessQuery } from "./loader.js";
import { loadBeirDataset } from "./loader.js";
import {
	createPipelineContext,
	PipelineSearchExecutor,
} from "./pipeline-executor.js";
import { generateReport } from "./reporter.js";

// ============================================================================
// Conditions
// ============================================================================

/**
 * One condition per fusion method. Every other knob is held fixed: no router
 * override, no expander, no reranker — the pipeline's own rule-based router
 * runs identically in both arms, so the ONLY difference is the fusion step.
 */
export const FUSION_CONDITIONS: Record<FusionMethod, AblationCondition> = {
	rrf: {
		name: "rrf",
		description: "Pipeline fusion: RRF (current default)",
		useRouter: false,
		useExpander: false,
		useReranker: false,
		dataset: "custom",
	},
	tm2c2: {
		name: "tm2c2",
		description: "Pipeline fusion: TM2C2 (theoretical min-max + convex)",
		useRouter: false,
		useExpander: false,
		useReranker: false,
		dataset: "custom",
	},
};

// ============================================================================
// Paired analysis types
// ============================================================================

/** Per-query delta between the two fusion arms for one metric */
export interface PairedDelta {
	queryId: string;
	query: string;
	baseline: number;
	candidate: number;
	delta: number;
}

/** Paired summary for a single metric */
export interface PairedMetricSummary {
	metric: string;
	baselineMean: number;
	candidateMean: number;
	delta: number;
	improved: number;
	regressed: number;
	tied: number;
	/** Wilcoxon signed-rank two-tailed p-value (candidate vs baseline) */
	pValue: number;
	/** Effect size r = Z / sqrt(N) */
	effectSize: number;
}

/** Full paired comparison of two conditions */
export interface FusionComparison {
	generatedAt: string;
	projectPath: string;
	dataset: string;
	nQueries: number;
	baseline: string;
	candidate: string;
	activeBackends: string[];
	/** Queries where the arm returned zero results */
	zeroResultQueries: Record<string, number>;
	/**
	 * Queries whose top-k doc list differs between the two arms.
	 *
	 * Fusion can only change anything when two or more backends fire: merging a
	 * single ranked list is order-preserving under both RRF and TM2C2. The
	 * pipeline routes plain semantic intents to the semantic backend alone, so a
	 * low number here means most queries never reached the fusion step at all —
	 * and a near-zero delta is a statement about routing, not about fusion.
	 */
	rankingDiffQueries: number;
	metrics: PairedMetricSummary[];
	latency: Record<string, { mean: number; p50: number; p95: number }>;
	/** Per-query MRR deltas, sorted by |delta| descending */
	topMovers: PairedDelta[];
}

// ============================================================================
// Metric extraction
// ============================================================================

/** Metric accessors over `PerQueryResult` — no metric is recomputed here. */
const METRIC_ACCESSORS: Array<{
	name: string;
	get: (r: PerQueryResult) => number;
}> = [
	{ name: "mrr", get: (r) => r.reciprocalRank },
	{ name: "ndcg_at_5", get: (r) => r.ndcgAt5 },
	{ name: "ndcg_at_10", get: (r) => r.ndcgAt10 },
	{ name: "recall_at_1", get: (r) => r.recallAtK[1] ?? 0 },
	{ name: "recall_at_5", get: (r) => r.recallAtK[5] ?? 0 },
	{ name: "recall_at_10", get: (r) => r.recallAtK[10] ?? 0 },
];

const EPSILON = 1e-9;

function mean(values: number[]): number {
	return values.length > 0
		? values.reduce((a, b) => a + b, 0) / values.length
		: 0;
}

/**
 * Build the paired comparison between two condition results.
 *
 * Queries are aligned by `queryId`; a query missing from either arm is dropped
 * (it cannot be paired). Ties use an epsilon so float noise is not reported as
 * a win.
 */
export function buildFusionComparison(
	baseline: ConditionResult,
	candidate: ConditionResult,
	meta: {
		projectPath: string;
		dataset: string;
		activeBackends: string[];
	},
): FusionComparison {
	const baselineById = new Map(
		baseline.perQueryResults.map((r) => [r.queryId, r]),
	);
	const pairs: Array<{ b: PerQueryResult; c: PerQueryResult }> = [];
	for (const c of candidate.perQueryResults) {
		const b = baselineById.get(c.queryId);
		if (b) pairs.push({ b, c });
	}

	const metrics: PairedMetricSummary[] = METRIC_ACCESSORS.map(
		({ name, get }) => {
			const bVals = pairs.map((p) => get(p.b));
			const cVals = pairs.map((p) => get(p.c));

			let improved = 0;
			let regressed = 0;
			let tied = 0;
			for (let i = 0; i < pairs.length; i++) {
				const d = cVals[i] - bVals[i];
				if (d > EPSILON) improved++;
				else if (d < -EPSILON) regressed++;
				else tied++;
			}

			const { pValue, effectSize } = wilcoxonSignedRankTest(cVals, bVals);

			return {
				metric: name,
				baselineMean: mean(bVals),
				candidateMean: mean(cVals),
				delta: mean(cVals) - mean(bVals),
				improved,
				regressed,
				tied,
				pValue,
				effectSize,
			};
		},
	);

	const topMovers: PairedDelta[] = pairs
		.map(({ b, c }) => ({
			queryId: c.queryId,
			query: c.query,
			baseline: b.reciprocalRank,
			candidate: c.reciprocalRank,
			delta: c.reciprocalRank - b.reciprocalRank,
		}))
		.filter((d) => Math.abs(d.delta) > EPSILON)
		.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
		.slice(0, 20);

	const countZero = (r: ConditionResult) =>
		r.perQueryResults.filter((q) => q.retrievedDocs.length === 0).length;

	const rankingDiffQueries = pairs.filter(
		({ b, c }) =>
			b.retrievedDocs.length !== c.retrievedDocs.length ||
			b.retrievedDocs.some((d, i) => d !== c.retrievedDocs[i]),
	).length;

	return {
		generatedAt: new Date().toISOString(),
		projectPath: meta.projectPath,
		dataset: meta.dataset,
		nQueries: pairs.length,
		baseline: baseline.condition.name,
		candidate: candidate.condition.name,
		activeBackends: meta.activeBackends,
		zeroResultQueries: {
			[baseline.condition.name]: countZero(baseline),
			[candidate.condition.name]: countZero(candidate),
		},
		rankingDiffQueries,
		metrics,
		latency: {
			[baseline.condition.name]: baseline.latency,
			[candidate.condition.name]: candidate.latency,
		},
		topMovers,
	};
}

// ============================================================================
// Markdown rendering
// ============================================================================

/** Render the paired comparison as a markdown table block. */
export function renderFusionMarkdown(cmp: FusionComparison): string {
	const f = (n: number, d = 4) => n.toFixed(d);
	const lines: string[] = [];

	lines.push("# Fusion Comparison — RRF vs TM2C2\n");
	lines.push(`**Generated**: ${cmp.generatedAt}  `);
	lines.push(`**Dataset**: ${cmp.dataset}  `);
	lines.push(`**Project**: ${cmp.projectPath}  `);
	lines.push(`**Paired queries**: ${cmp.nQueries}  `);
	lines.push(`**Active backends**: ${cmp.activeBackends.join(", ")}\n`);

	lines.push("## Paired metrics\n");
	lines.push(
		`| Metric | ${cmp.baseline} | ${cmp.candidate} | Delta | Improved | Regressed | Tied | p | r |`,
	);
	lines.push(
		"|--------|------|------|-------|----------|-----------|------|---|---|",
	);
	for (const m of cmp.metrics) {
		const sign = m.delta >= 0 ? "+" : "";
		lines.push(
			`| ${m.metric} | ${f(m.baselineMean)} | ${f(m.candidateMean)} | ${sign}${f(m.delta)} | ${m.improved} | ${m.regressed} | ${m.tied} | ${f(m.pValue)} | ${f(m.effectSize, 3)} |`,
		);
	}
	lines.push("");

	lines.push("## Latency (ms)\n");
	lines.push("| Condition | Mean | P50 | P95 |");
	lines.push("|-----------|------|-----|-----|");
	for (const [name, l] of Object.entries(cmp.latency)) {
		lines.push(
			`| ${name} | ${l.mean.toFixed(1)} | ${l.p50.toFixed(1)} | ${l.p95.toFixed(1)} |`,
		);
	}
	lines.push("");

	lines.push("## Zero-result queries\n");
	for (const [name, count] of Object.entries(cmp.zeroResultQueries)) {
		lines.push(`- ${name}: ${count} / ${cmp.nQueries}`);
	}
	lines.push("");

	lines.push("## Fusion reach\n");
	lines.push(
		`- Queries whose ranking differs between arms: **${cmp.rankingDiffQueries} / ${cmp.nQueries}**`,
	);
	lines.push(
		"- The remainder were routed to a single backend, where RRF and TM2C2 are",
	);
	lines.push("  order-identical by construction.\n");

	if (cmp.topMovers.length > 0) {
		lines.push("## Top per-query MRR movers\n");
		lines.push("| Query ID | Delta | Query |");
		lines.push("|----------|-------|-------|");
		for (const d of cmp.topMovers) {
			const sign = d.delta >= 0 ? "+" : "";
			const q = d.query.replace(/\|/g, "\\|").slice(0, 80);
			lines.push(`| ${d.queryId} | ${sign}${f(d.delta, 3)} | ${q} |`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

// ============================================================================
// Runner
// ============================================================================

export interface RunFusionComparisonOptions {
	projectPath: string;
	querySet: HarnessQuery[];
	dataset: string;
	outputDir: string;
	kValues?: number[];
	verbose?: boolean;
	/** Skip writing report files (used by tests) */
	skipReport?: boolean;
}

export interface RunFusionComparisonResult {
	comparison: FusionComparison;
	results: ConditionResult[];
}

/**
 * Run both fusion arms over the query set and produce the paired comparison.
 *
 * Fails loudly (throws) when an arm returns zero results for EVERY query. That
 * is the mock-executor failure mode this harness exists to eliminate: all-zero
 * metrics are not a baseline, they are a broken run.
 */
export async function runFusionComparison(
	options: RunFusionComparisonOptions,
): Promise<RunFusionComparisonResult> {
	const {
		projectPath,
		querySet,
		dataset,
		outputDir,
		kValues = [1, 5, 10, 100],
		verbose = false,
	} = options;

	if (querySet.length === 0) {
		throw new Error(
			"Fusion comparison aborted: query set is empty. Check --data-dir.",
		);
	}

	const ctx = await createPipelineContext({ projectPath });
	if (verbose) {
		console.log(`Active backends: ${ctx.activeBackends.join(", ")}`);
		console.log(`Base config fusion: ${ctx.baseConfig.fusionMethod}`);
	}

	const results: ConditionResult[] = [];
	try {
		for (const method of ["rrf", "tm2c2"] as const) {
			const executor = new PipelineSearchExecutor(ctx, {
				fusionMethod: method,
			});
			if (verbose) console.log(`\n=== fusion=${method} ===`);
			const result = await runCondition(FUSION_CONDITIONS[method], {
				conditions: [FUSION_CONDITIONS[method]],
				querySet,
				outputDir,
				kValues,
				verbose,
				executor,
			});

			const nonEmpty = result.perQueryResults.filter(
				(r) => r.retrievedDocs.length > 0,
			).length;
			if (nonEmpty === 0) {
				throw new Error(
					`Fusion arm "${method}" returned ZERO results for all ${result.nQueries} queries. ` +
						"This is the mock-executor failure mode — refusing to report all-zero " +
						"metrics as a result. Check that the index at " +
						`${projectPath} is built (sqlite documents table non-empty), that no ` +
						"indexing lock is held, and that the embedding provider is reachable.",
				);
			}
			if (verbose) {
				console.log(`  non-empty result sets: ${nonEmpty}/${result.nQueries}`);
			}

			results.push(result);
		}
	} finally {
		await ctx.close();
	}

	const [rrfResult, tm2c2Result] = results;
	const comparison = buildFusionComparison(rrfResult, tm2c2Result, {
		projectPath,
		dataset,
		activeBackends: ctx.activeBackends,
	});

	if (!options.skipReport) {
		await mkdir(outputDir, { recursive: true });
		await writeFile(
			`${outputDir}/fusion-comparison.json`,
			JSON.stringify(comparison, null, 2),
			"utf8",
		);
		await writeFile(
			`${outputDir}/fusion-comparison.md`,
			renderFusionMarkdown(comparison),
			"utf8",
		);
		// Reuse the existing reporter for the Wilcoxon-on-MRR view, baselined
		// on the current default (rrf).
		await generateReport(results, `${outputDir}/fusion-report.md`, "rrf");
	}

	return { comparison, results };
}

// ============================================================================
// CLI entry point
// ============================================================================

if (import.meta.main) {
	const { values: args } = parseArgs({
		args: process.argv.slice(2),
		options: {
			"data-dir": { type: "string", default: "eval/datasets/mnemex-git" },
			project: { type: "string", default: "." },
			output: {
				type: "string",
				default: "eval/code-search-harness/results",
			},
			limit: { type: "string" },
			verbose: { type: "boolean", default: false },
			help: { type: "boolean", default: false },
		},
	});

	if (args.help) {
		console.log(`Usage: bun eval/code-search-harness/fusion-comparison.ts [options]

Compares PipelineConfig.fusionMethod "rrf" vs "tm2c2" on a BEIR dataset,
holding everything else fixed, and reports a PAIRED per-query analysis.

Options:
  --data-dir  BEIR dataset directory (default: eval/datasets/mnemex-git)
  --project   Repository root that was indexed (default: .)
  --output    Output directory (default: eval/code-search-harness/results)
  --limit     Evaluate only the first N queries (smoke tests)
  --verbose   Print per-query progress
  --help      Show this help message
`);
		process.exit(0);
	}

	const dataDir = args["data-dir"] as string;
	const projectPath = resolve(args.project as string);
	const outputDir = args.output as string;
	const verbose = Boolean(args.verbose);

	const dataset = await loadBeirDataset(dataDir);
	let querySet = dataset.queries;
	if (args.limit) {
		const n = Number.parseInt(args.limit as string, 10);
		if (Number.isFinite(n) && n > 0) querySet = querySet.slice(0, n);
	}

	console.log(`Loaded ${querySet.length} queries from ${dataDir}`);
	console.log(`Project: ${projectPath}`);

	const { comparison } = await runFusionComparison({
		projectPath,
		querySet,
		dataset: dataDir,
		outputDir,
		verbose,
	});

	console.log(`\n${renderFusionMarkdown(comparison)}`);
	console.log(`Written to ${outputDir}/fusion-comparison.{json,md}`);
	console.log(`Report:    ${outputDir}/fusion-report.md`);
}
