/**
 * Per-Query Adaptation
 *
 * Two adjustments that make fusion depend on the query instead of being fixed
 * for every query. Both are pure, allocation-light, and OFF by default
 * (see `PipelineConfig.adaptiveWeights` / `PipelineConfig.scoreFloor`).
 *
 *   1. Weight tilt (`adaptBackendWeights`) — query terms that are RARE are
 *      highly discriminative, so exact/lexical backends (symbol-graph, LSP,
 *      tree-sitter, location) deserve more weight; queries made of COMMON
 *      terms carry little lexical signal, so the semantic backend deserves
 *      more. A fixed weight vector cannot express either.
 *
 *   2. Score floor relaxation (`applyScoreFloor`) — long queries produce
 *      diluted embeddings (averaging many tokens pulls the vector toward the
 *      corpus centroid), so true matches sit further from the query. A floor
 *      tuned on short queries silently discards them.
 *
 * ## Why rarity is estimated from the query, not measured from the corpus
 *
 * The obvious input is IDF, and the codebase does have BM25 — but BM25 is
 * delegated wholesale to LanceDB's native full-text index
 * (`table.fullTextSearch(...)` in `src/core/store.ts`). Document frequencies
 * live inside that index and are never materialized in-process; nothing in the
 * pipeline can read them without adding a per-term index round trip to the hot
 * path. So rarity here is an explicitly-labelled PROXY derived from token
 * SHAPE, not a corpus statistic: identifier-shaped tokens (`camelCase`,
 * `snake_case`, dotted paths, tokens with digits) and long words are rare and
 * discriminative; short lowercase words are not. It is a heuristic and is
 * named like one.
 */

import type { PipelineConfig } from "./config.js";
import type { BackendName, BackendResult } from "./types.js";

// ============================================================================
// Backend classes
// ============================================================================

/**
 * Backends whose score comes from embedding distance.
 *
 * Only these are subject to the score floor: a floor on tree-sitter's or
 * location's score would be a floor on a rank, which has nothing to do with
 * embedding dilution.
 */
const EMBEDDING_SCORED_BACKENDS: readonly BackendName[] = ["semantic"];

// ============================================================================
// Query rarity proxy
// ============================================================================

/** Below this length a non-identifier token is treated as carrying no lexical signal. */
const COMMON_WORD_LENGTH = 4;

/** At or above this length a non-identifier token is treated as fully discriminative. */
const RARE_WORD_LENGTH = 12;

/**
 * Token shapes that only occur in code identifiers, never in prose.
 * Any match makes the token maximally "rare" for weighting purposes.
 */
const IDENTIFIER_SHAPES: readonly RegExp[] = [
	/[a-z][A-Z]/, // camelCase / PascalCase word boundary
	/_/, // snake_case, _private
	/-/, // kebab-case
	/[./:]/, // qualified path, member access, C++/Rust paths
	/\d/, // sha256, v2, utf8
	/^[A-Z]{2,}$/, // SCREAMING acronym
];

function clamp01(value: number): number {
	if (!Number.isFinite(value)) return 0;
	if (value <= 0) return 0;
	if (value >= 1) return 1;
	return value;
}

/**
 * Split a query into candidate terms, stripping surrounding punctuation but
 * keeping intra-token characters that carry identifier shape (`_`, `.`, `/`,
 * `:`, `-`).
 */
export function tokenizeQuery(query: string): string[] {
	const tokens: string[] = [];
	for (const raw of query.split(/\s+/)) {
		const token = raw
			.replace(/^[^A-Za-z0-9_$]+/, "")
			.replace(/[^A-Za-z0-9_$]+$/, "");
		if (token.length > 0) tokens.push(token);
	}
	return tokens;
}

/** Shape-derived rarity of a single token, in [0, 1]. */
export function estimateTokenRarity(token: string): number {
	for (const shape of IDENTIFIER_SHAPES) {
		if (shape.test(token)) return 1;
	}
	return clamp01(
		(token.length - COMMON_WORD_LENGTH) /
			(RARE_WORD_LENGTH - COMMON_WORD_LENGTH),
	);
}

/**
 * Mean shape-derived rarity of a query, in [0, 1].
 *
 * 0.5 is the neutral point (no tilt). An empty query returns exactly 0.5 so a
 * degenerate input can never move the weights.
 */
export function estimateQueryRarity(query: string): number {
	const tokens = tokenizeQuery(query);
	if (tokens.length === 0) return 0.5;

	let total = 0;
	for (const token of tokens) total += estimateTokenRarity(token);
	return total / tokens.length;
}

// ============================================================================
// Part A — per-query weight tilt
// ============================================================================

/**
 * Tilt the configured backend weights by the query's estimated term rarity.
 *
 * `tilt = strength * (2 * rarity - 1)` — zero at the neutral rarity 0.5, and
 * bounded by ±strength. Lexical backends are scaled by `1 + tilt`, the
 * semantic backend by `1 - tilt`, so a rare/identifier-shaped query moves mass
 * toward exact matching and a query of common words moves it toward semantics.
 *
 * CONVEXITY: this returns raw (unnormalized) weights, exactly like
 * `PipelineConfig.backendWeights`. `tm2c2Merge` renormalizes them to sum to 1
 * across the backends that actually returned results, so the convex-combination
 * invariant is unchanged by tilting — only the ratios move.
 *
 * @param weights  Static configured weights (not mutated)
 * @param query    Raw user query
 * @param strength Max fractional tilt; clamped to [0, 1]. 0 is a no-op.
 */
export function adaptBackendWeights(
	weights: PipelineConfig["backendWeights"],
	query: string,
	strength: number,
): PipelineConfig["backendWeights"] {
	const clamped = clamp01(strength);
	if (clamped === 0) return weights;

	const tilt = clamped * (2 * estimateQueryRarity(query) - 1);
	// Never negative: a negative weight would flip the sign of a backend's
	// contribution rather than merely discounting it.
	const lexical = Math.max(0, 1 + tilt);
	const semantic = Math.max(0, 1 - tilt);

	return {
		symbolGraph: weights.symbolGraph * lexical,
		lsp: weights.lsp * lexical,
		treeSitter: weights.treeSitter * lexical,
		semantic: weights.semantic * semantic,
		location: weights.location * lexical,
	};
}

// ============================================================================
// Part B — query-length-relaxed score floor
// ============================================================================

/**
 * The floor actually applied to this query.
 *
 * Linear ramp on token count: no relaxation at or below `shortQueryTokens`,
 * full `maxRelaxation` at or above `longQueryTokens`.
 *
 * Returns `minScore` unchanged when relaxation is off or the ramp bounds are
 * degenerate in a way that makes interpolation meaningless.
 */
export function effectiveScoreFloor(
	query: string,
	config: PipelineConfig["scoreFloor"],
): number {
	if (!config.relaxForLongQueries) return config.minScore;

	const tokenCount = tokenizeQuery(query).length;
	const span = config.longQueryTokens - config.shortQueryTokens;
	const ramp =
		span > 0
			? clamp01((tokenCount - config.shortQueryTokens) / span)
			: tokenCount > config.shortQueryTokens
				? 1
				: 0;

	return config.minScore * (1 - clamp01(config.maxRelaxation) * ramp);
}

/**
 * Drop embedding-scored results below the (possibly relaxed) floor.
 *
 * NOTE ON WHAT THIS FLOOR IS: there is no absolute vector-distance cutoff
 * anywhere in this codebase — LanceDB search is top-k only, and the semantic
 * backend max-normalizes its scores against its own best hit. So the strongest
 * cutoff expressible at the pipeline layer is relative-to-best-hit, and that is
 * what `minScore` means here.
 *
 * DEFAULT IS A NO-OP: with `minScore <= 0` the input array is returned by
 * identity, so nothing downstream can observe a difference.
 */
export function applyScoreFloor(
	backendResults: Array<{ name: BackendName; results: BackendResult[] }>,
	query: string,
	config: PipelineConfig["scoreFloor"],
): Array<{ name: BackendName; results: BackendResult[] }> {
	if (!(config.minScore > 0)) return backendResults;

	const floor = effectiveScoreFloor(query, config);
	if (!(floor > 0)) return backendResults;

	return backendResults.map(({ name, results }) =>
		EMBEDDING_SCORED_BACKENDS.includes(name)
			? { name, results: results.filter((r) => r.score >= floor) }
			: { name, results },
	);
}
