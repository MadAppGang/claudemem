/**
 * Pipeline Configuration
 *
 * Configuration for the parallel search pipeline backends.
 * Reads MNEMEX_PIPELINE_* environment variables.
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Result fusion method.
 *
 * - `rrf`   — Reciprocal Rank Fusion. Fuses on rank; discards score magnitude.
 * - `tm2c2` — Theoretical min-max normalization + convex combination
 *             (Bruch, Gai & Ingber, TOIS 2023, arXiv:2210.11934). Fuses on
 *             normalized score, preserving each backend's confidence margin.
 */
export type FusionMethod = "rrf" | "tm2c2";

export const FUSION_METHODS: readonly FusionMethod[] = ["rrf", "tm2c2"];

export interface PipelineConfig {
	/** Enable/disable individual backends */
	backends: {
		/** Symbol graph backend (default: true) */
		symbolGraph: boolean;
		/** LSP backend (default: true when LSP is enabled) */
		lsp: boolean;
		/** Tree-sitter structural backend (default: true) */
		treeSitter: boolean;
		/** Semantic/BM25 backend (default: true) */
		semantic: boolean;
		/** Location/glob backend (default: true) */
		location: boolean;
	};

	/** Minimum router confidence to activate non-semantic backends (default: 0.7) */
	routerMinConfidence: number;

	/** Per-backend score weights for RRF tie-breaking */
	backendWeights: {
		/** Slight boost for exact graph match (default: 1.2) */
		symbolGraph: number;
		/** Highest trust — LSP exact match (default: 1.5) */
		lsp: number;
		/** Tree-sitter structural (default: 1.1) */
		treeSitter: number;
		/** Semantic/BM25 (default: 1.0) */
		semantic: number;
		/** Location/glob (default: 0.9) */
		location: number;
	};

	/** Short-circuit on definitive LSP match (default: true) */
	lspShortCircuit: boolean;

	/** Enable LLM reranking within semantic backend (default: false) */
	semanticReranking: boolean;

	/** Enable LLM reranking of final merged results (default: false) */
	mergedReranking: boolean;

	/** Tree-sitter backend settings */
	treeSitterConfig: {
		/** Max files to scan before falling back to semantic pre-filter (default: 2000) */
		maxFilesToScan: number;
	};

	/**
	 * Result fusion method (default: "rrf").
	 *
	 * Stays on "rrf" until an eval proves tm2c2 wins on this corpus.
	 */
	fusionMethod: FusionMethod;

	/** RRF k parameter (default: 60) — used only by the "rrf" fusion path */
	rrfK: number;

	/**
	 * Per-query tilt of `backendWeights` by estimated query-term rarity
	 * (default: disabled).
	 *
	 * Rare/identifier-shaped terms are discriminative → lexical backends gain
	 * weight; common terms carry no lexical signal → semantic gains weight.
	 * Stays off until an eval proves it wins on this corpus.
	 */
	adaptiveWeights: {
		/** Enable the tilt (default: false) */
		enabled: boolean;
		/** Max fractional tilt at a fully rare / fully common query (default: 0.5) */
		strength: number;
	};

	/**
	 * Minimum score for embedding-scored backends, optionally relaxed for long
	 * queries (default: disabled).
	 *
	 * Relative to the backend's own best hit, not an absolute vector distance —
	 * the semantic backend max-normalizes before the pipeline sees a score.
	 */
	scoreFloor: {
		/** Drop embedding-scored hits below this score (default: 0 = disabled) */
		minScore: number;
		/** Relax the floor as the query gets longer (default: false) */
		relaxForLongQueries: boolean;
		/** Token count at/below which no relaxation applies (default: 4) */
		shortQueryTokens: number;
		/** Token count at/above which relaxation is maximal (default: 16) */
		longQueryTokens: number;
		/** Fraction of the floor removed at maximum relaxation (default: 0.5) */
		maxRelaxation: number;
	};

	/**
	 * Query-seeded Personalized PageRank over the symbol graph
	 * (default: disabled).
	 *
	 * Index-time PageRank is global: "important" means important-in-the-repo,
	 * the same answer for every query. Seeding the teleport vector with THIS
	 * query's top hits makes it mean important-relative-to-the-question.
	 *
	 * Gated on intent (see `PPR_INTENTS` in orchestrator.ts) because the win is
	 * asymmetric: HippoRAG 2 (arXiv:2502.14802) reports +13.9 multi-hop
	 * recall@5 and near-zero on single-hop, and GraphRAG-Bench
	 * (arXiv:2506.05690) has basic RAG BEATING graph methods on simple fact
	 * retrieval. Stays off until an eval proves it wins on this corpus.
	 */
	personalizedPageRank: {
		/** Enable the query-time walk (default: false) */
		enabled: boolean;
		/** Max fractional boost at the walk's strongest node (default: 0.5) */
		strength: number;
		/** Max seeds taken from the top of the merged list (default: 10) */
		maxSeeds: number;
		/** Power-iteration cap — a latency bound, not a convergence one (default: 30) */
		iterations: number;
		/** Damping factor — higher than global PageRank's 0.85 (default: 0.95) */
		dampingFactor: number;
		/** L1 convergence threshold for the early exit (default: 1e-6) */
		tolerance: number;
		/** Propagate at most this many hops from a seed (default: 3) */
		maxHops: number;
		/**
		 * Hard cap on the neighborhood the walk visits (default: 1000).
		 *
		 * The binding cost control: per-iteration cost is the neighborhood's
		 * total in-degree, so seeds next to high-fan-in hubs cost far more per
		 * node than seeds in the leaves.
		 */
		maxNodes: number;
		/**
		 * Fuse this many times `limit` candidates before re-weighting, then
		 * truncate (default: 3). Re-weighting a list already cut to `limit` could
		 * only reorder what was returned anyway; the walk needs candidates below
		 * the cut to be able to promote one.
		 */
		candidateMultiplier: number;
	};
}

// ============================================================================
// Defaults
// ============================================================================

export const DEFAULT_PIPELINE_CONFIG: PipelineConfig = {
	backends: {
		symbolGraph: true,
		lsp: true,
		treeSitter: true,
		semantic: true,
		location: true,
	},
	routerMinConfidence: 0.7,
	backendWeights: {
		symbolGraph: 1.2,
		lsp: 1.5,
		treeSitter: 1.1,
		semantic: 1.0,
		location: 0.9,
	},
	lspShortCircuit: true,
	semanticReranking: false,
	mergedReranking: false,
	treeSitterConfig: {
		maxFilesToScan: 2000,
	},
	fusionMethod: "rrf",
	rrfK: 60,
	adaptiveWeights: {
		enabled: false,
		strength: 0.5,
	},
	scoreFloor: {
		minScore: 0,
		relaxForLongQueries: false,
		shortQueryTokens: 4,
		longQueryTokens: 16,
		maxRelaxation: 0.5,
	},
	personalizedPageRank: {
		enabled: false,
		strength: 0.5,
		maxSeeds: 10,
		iterations: 30,
		dampingFactor: 0.95,
		tolerance: 1e-6,
		maxHops: 3,
		maxNodes: 1000,
		candidateMultiplier: 3,
	},
};

// ============================================================================
// Loader
// ============================================================================

/**
 * Load pipeline config from MNEMEX_PIPELINE_* env vars, falling back to defaults.
 */
export function loadPipelineConfig(): PipelineConfig {
	const d = DEFAULT_PIPELINE_CONFIG;

	return {
		backends: {
			symbolGraph: parseBool(
				process.env.MNEMEX_PIPELINE_SYMBOL_GRAPH,
				d.backends.symbolGraph,
			),
			lsp: parseBool(process.env.MNEMEX_PIPELINE_LSP, d.backends.lsp),
			treeSitter: parseBool(
				process.env.MNEMEX_PIPELINE_TREE_SITTER,
				d.backends.treeSitter,
			),
			semantic: parseBool(
				process.env.MNEMEX_PIPELINE_SEMANTIC,
				d.backends.semantic,
			),
			location: parseBool(
				process.env.MNEMEX_PIPELINE_LOCATION,
				d.backends.location,
			),
		},
		routerMinConfidence: parseFloatEnv(
			process.env.MNEMEX_PIPELINE_ROUTER_CONFIDENCE,
			d.routerMinConfidence,
		),
		backendWeights: {
			symbolGraph: d.backendWeights.symbolGraph,
			lsp: d.backendWeights.lsp,
			treeSitter: d.backendWeights.treeSitter,
			semantic: d.backendWeights.semantic,
			location: d.backendWeights.location,
		},
		lspShortCircuit: parseBool(
			process.env.MNEMEX_PIPELINE_LSP_SHORT_CIRCUIT,
			d.lspShortCircuit,
		),
		semanticReranking: parseBool(
			process.env.MNEMEX_PIPELINE_SEMANTIC_RERANKING,
			d.semanticReranking,
		),
		mergedReranking: parseBool(
			process.env.MNEMEX_PIPELINE_MERGED_RERANKING,
			d.mergedReranking,
		),
		treeSitterConfig: {
			maxFilesToScan: parseIntEnv(
				process.env.MNEMEX_PIPELINE_TS_MAX_FILES,
				d.treeSitterConfig.maxFilesToScan,
			),
		},
		fusionMethod: parseFusionMethod(
			process.env.MNEMEX_PIPELINE_FUSION,
			d.fusionMethod,
		),
		rrfK: parseIntEnv(process.env.MNEMEX_PIPELINE_RRF_K, d.rrfK),
		adaptiveWeights: {
			enabled: parseBool(
				process.env.MNEMEX_PIPELINE_ADAPTIVE_WEIGHTS,
				d.adaptiveWeights.enabled,
			),
			strength: parseUnitFloatEnv(
				process.env.MNEMEX_PIPELINE_ADAPTIVE_STRENGTH,
				d.adaptiveWeights.strength,
			),
		},
		scoreFloor: {
			minScore: parseUnitFloatEnv(
				process.env.MNEMEX_PIPELINE_SCORE_FLOOR,
				d.scoreFloor.minScore,
			),
			relaxForLongQueries: parseBool(
				process.env.MNEMEX_PIPELINE_SCORE_FLOOR_RELAX,
				d.scoreFloor.relaxForLongQueries,
			),
			shortQueryTokens: d.scoreFloor.shortQueryTokens,
			longQueryTokens: d.scoreFloor.longQueryTokens,
			maxRelaxation: parseUnitFloatEnv(
				process.env.MNEMEX_PIPELINE_SCORE_FLOOR_MAX_RELAX,
				d.scoreFloor.maxRelaxation,
			),
		},
		personalizedPageRank: {
			enabled: parseBool(
				process.env.MNEMEX_PIPELINE_PPR,
				d.personalizedPageRank.enabled,
			),
			strength: parseUnitFloatEnv(
				process.env.MNEMEX_PIPELINE_PPR_STRENGTH,
				d.personalizedPageRank.strength,
			),
			maxSeeds: parsePositiveIntEnv(
				process.env.MNEMEX_PIPELINE_PPR_SEEDS,
				d.personalizedPageRank.maxSeeds,
			),
			iterations: parsePositiveIntEnv(
				process.env.MNEMEX_PIPELINE_PPR_ITERATIONS,
				d.personalizedPageRank.iterations,
			),
			dampingFactor: parseDampingEnv(
				process.env.MNEMEX_PIPELINE_PPR_DAMPING,
				d.personalizedPageRank.dampingFactor,
			),
			tolerance: d.personalizedPageRank.tolerance,
			maxHops: parsePositiveIntEnv(
				process.env.MNEMEX_PIPELINE_PPR_MAX_HOPS,
				d.personalizedPageRank.maxHops,
			),
			maxNodes: parsePositiveIntEnv(
				process.env.MNEMEX_PIPELINE_PPR_MAX_NODES,
				d.personalizedPageRank.maxNodes,
			),
			candidateMultiplier: parsePositiveIntEnv(
				process.env.MNEMEX_PIPELINE_PPR_CANDIDATES,
				d.personalizedPageRank.candidateMultiplier,
			),
		},
	};
}

// ============================================================================
// Helpers
// ============================================================================

function parseBool(value: string | undefined, defaultValue: boolean): boolean {
	if (value === undefined || value === "") return defaultValue;
	return value === "true" || value === "1";
}

function parseFloatEnv(
	value: string | undefined,
	defaultValue: number,
): number {
	if (value === undefined || value === "") return defaultValue;
	const parsed = Number.parseFloat(value);
	return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parse a fraction in [0, 1], falling back to the default on anything
 * unparseable and clamping anything out of range.
 *
 * Out-of-range must clamp rather than fall back: `MNEMEX_PIPELINE_SCORE_FLOOR=2`
 * is an operator asking for "drop everything", and silently restoring the
 * default (0 = keep everything) would be the opposite of what they typed.
 */
function parseUnitFloatEnv(
	value: string | undefined,
	defaultValue: number,
): number {
	if (value === undefined || value === "") return defaultValue;
	// Number(), not parseFloat(): parseFloat("0.4.2") is 0.4, and a fraction
	// that silently keeps the prefix of a typo is worse than one that reverts.
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return defaultValue;
	return Math.min(1, Math.max(0, parsed));
}

/**
 * Parse the fusion method, falling back to the default on anything
 * unrecognized (a typo must not throw or silently change ranking behavior).
 */
function parseFusionMethod(
	value: string | undefined,
	defaultValue: FusionMethod,
): FusionMethod {
	if (value === undefined || value === "") return defaultValue;
	const normalized = value.trim().toLowerCase() as FusionMethod;
	return FUSION_METHODS.includes(normalized) ? normalized : defaultValue;
}

function parseIntEnv(value: string | undefined, defaultValue: number): number {
	if (value === undefined || value === "") return defaultValue;
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? defaultValue : parsed;
}

/**
 * Parse a count that must be >= 1, reverting to the default otherwise.
 *
 * Unlike `parseUnitFloatEnv`'s clamping, 0 and negatives are NOT a meaningful
 * operator request here — `maxSeeds: 0` or `iterations: 0` silently disables a
 * feature the operator just asked for, which is worse than ignoring the typo.
 */
function parsePositiveIntEnv(
	value: string | undefined,
	defaultValue: number,
): number {
	if (value === undefined || value === "") return defaultValue;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 1) return defaultValue;
	return parsed;
}

/**
 * Parse a damping factor into [0, MAX_DAMPING].
 *
 * 1.0 is excluded: it zeroes the teleport term, which is precisely the
 * personalization — a "personalized" walk with d = 1 is not personalized at
 * all, it converges to the graph's dominant eigenvector.
 */
const MAX_DAMPING = 0.99;

function parseDampingEnv(
	value: string | undefined,
	defaultValue: number,
): number {
	if (value === undefined || value === "") return defaultValue;
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return defaultValue;
	return Math.min(MAX_DAMPING, Math.max(0, parsed));
}
