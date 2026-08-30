/**
 * Query-Seeded Personalized PageRank
 *
 * Global PageRank answers "what is important in this repo?" and gives the same
 * answer to every query. Personalized PageRank answers "what is important
 * GIVEN THIS QUESTION" by replacing the uniform teleport vector with one
 * concentrated on the query's own top hits: restart mass returns to the seeds,
 * so score accumulates on the seeds' graph neighborhood instead of on the
 * repo's global hubs. A symbol that is central to the question but peripheral
 * to the codebase stops being ranked as peripheral.
 *
 * Evidence: HippoRAG 2 (arXiv:2502.14802, ICML 2025) reports +13.9 multi-hop
 * recall@5 from exactly this construction — and NEAR-ZERO gain on single-hop.
 * That asymmetry is why this is routed by intent (see `PPR_INTENTS` in
 * orchestrator.ts) rather than applied to every query, and why it is OFF until
 * an eval on this corpus says otherwise.
 *
 * Dependency-free by design: the symbol graph is injected behind the narrow
 * {@link SymbolGraphView} interface so the pipeline core never imports
 * src/core/reference-graph. `ReferenceGraphManager` satisfies it structurally.
 */

import type { PipelineConfig } from "./config.js";
import type { MergedResult } from "./types.js";

// ============================================================================
// Injected graph
// ============================================================================

/**
 * The two graph operations the pipeline needs: map a retrieval hit's location
 * to a graph node, and run a seeded walk.
 */
export interface SymbolGraphView {
	findSymbolIdAtLocation(
		filePath: string,
		line: number,
		symbolName?: string,
	): string | null;

	computePersonalizedPageRank(
		seeds: ReadonlyMap<string, number>,
		options?: {
			iterations?: number;
			dampingFactor?: number;
			tolerance?: number;
			maxHops?: number;
			maxNodes?: number;
		},
	): Map<string, number>;
}

/**
 * Supplies the symbol graph, or null when it is unavailable (no index, graph
 * not built). Mirrors `FileBoostProvider`: the pipeline never constructs it.
 */
export type SymbolGraphProvider = () => SymbolGraphView | null;

// ============================================================================
// Re-weighting
// ============================================================================

/**
 * Weight used for a seed whose fused score is not finite.
 *
 * `finalize()` in merge.ts forces `rrfScore = +Infinity` for definitive LSP
 * matches. Infinity cannot be normalized, and a definitive match is the single
 * most trustworthy anchor the pipeline has, so it seeds at full weight.
 */
const DEFINITIVE_SEED_WEIGHT = 1;

/**
 * Re-weight merged results by a personalized walk seeded on the top hits.
 *
 * Multiplicative, exactly like `applyFileBoosts`: `score * (1 + strength * p̂)`
 * where `p̂` is the result's personalized score scaled against the strongest
 * one in this run. A result the walk never reaches keeps its fused score
 * unchanged, so this can only PROMOTE graph-adjacent results, never demote a
 * hit below where lexical/semantic evidence already put it.
 *
 * INERT WHEN IT CANNOT HELP: a null graph, an empty result list, no resolvable
 * seed, or an all-zero walk all return the input array by identity.
 *
 * @param results Merged results, already sorted descending (not mutated)
 * @param graph   Symbol graph, or null when unavailable
 * @param config  `PipelineConfig.personalizedPageRank`
 */
export function applyPersonalizedPageRank(
	results: MergedResult[],
	graph: SymbolGraphView | null,
	config: PipelineConfig["personalizedPageRank"],
): MergedResult[] {
	if (!graph || results.length === 0) return results;
	if (!(config.strength > 0)) return results;

	// Resolve every candidate once: the same map answers "which nodes seed the
	// walk" and "which node does this result correspond to when re-weighting".
	const nodeIds: Array<string | null> = results.map((r) =>
		r.file ? graph.findSymbolIdAtLocation(r.file, r.startLine, r.symbol) : null,
	);

	// Seeds: the top-k hits, weighted by fused score. `results` arrives sorted,
	// so the first maxSeeds resolvable entries ARE the top-k.
	const seeds = new Map<string, number>();
	for (let i = 0; i < results.length && seeds.size < config.maxSeeds; i++) {
		const id = nodeIds[i];
		if (!id || seeds.has(id)) continue;

		const score = results[i].rrfScore;
		const weight = Number.isFinite(score) ? score : DEFINITIVE_SEED_WEIGHT;
		if (!(weight > 0)) continue;

		seeds.set(id, weight);
	}

	if (seeds.size === 0) return results;

	const ppr = graph.computePersonalizedPageRank(seeds, {
		iterations: config.iterations,
		dampingFactor: config.dampingFactor,
		tolerance: config.tolerance,
		maxHops: config.maxHops,
		maxNodes: config.maxNodes,
	});

	// Scale against the strongest score REACHED BY THIS WALK, not against the
	// graph's global maximum: the boost has to mean "closest to the question",
	// and the absolute magnitude of a personalized score depends on how much of
	// the neighborhood the walk covered.
	let maxScore = 0;
	for (const id of nodeIds) {
		if (!id) continue;
		const score = ppr.get(id) ?? 0;
		if (score > maxScore) maxScore = score;
	}
	if (!(maxScore > 0)) return results;

	const boosted = results.map((result, i) => {
		// Leave Infinity (isDefinitive) untouched — a boost must never be able to
		// reorder a definitive match. Belt and braces: the `relative <= 0` return
		// below already keeps the multiplier strictly above 1, so `Infinity * m`
		// stays Infinity and no test can distinguish this guard's presence. It
		// stays because it states the invariant at the point it matters, and
		// because the day the multiplier is allowed to reach 0, `Infinity * 0`
		// is NaN and the sort comparator becomes inconsistent.
		if (!Number.isFinite(result.rrfScore)) return result;

		const id = nodeIds[i];
		if (!id) return result;

		const relative = (ppr.get(id) ?? 0) / maxScore;
		if (relative <= 0) return result;

		return {
			...result,
			rrfScore: result.rrfScore * (1 + config.strength * relative),
		};
	});

	// Equality check first: Infinity - Infinity is NaN, which makes the
	// comparator inconsistent and the sort order implementation-defined.
	boosted.sort((a, b) => {
		if (a.rrfScore === b.rrfScore) return 0;
		return b.rrfScore - a.rrfScore;
	});

	return boosted;
}
