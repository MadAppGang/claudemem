/**
 * Pipeline Orchestrator
 *
 * Routes queries to appropriate backends, fans out in parallel,
 * and merges results using Reciprocal Rank Fusion.
 */

import type { QueryIntent } from "../../types.js";
import type { QueryRouter } from "../routing/query-router.js";
import type { PipelineConfig } from "./config.js";
import {
	applyPersonalizedPageRank,
	type SymbolGraphProvider,
} from "./graph-ppr.js";
import { applyFileBoosts, type FileBoostProvider } from "./learned-boosts.js";
import { rrfMerge, tm2c2Merge } from "./merge.js";
import { adaptBackendWeights, applyScoreFloor } from "./query-adaptation.js";
import type {
	BackendName,
	BackendResult,
	ISearchBackend,
	MergedResult,
	SearchOptions,
} from "./types.js";

// ============================================================================
// Backend → Intent Mapping
// ============================================================================

/** Which backends to activate for each query intent */
const INTENT_BACKENDS: Record<QueryIntent, BackendName[]> = {
	symbol_lookup: ["symbol-graph", "lsp", "semantic"],
	structural: ["symbol-graph", "tree-sitter", "semantic"],
	semantic: ["semantic"],
	similarity: ["semantic"],
	location: ["location", "semantic"],
};

// ============================================================================
// PPR → Intent Routing
// ============================================================================

/**
 * Intents that get query-seeded Personalized PageRank.
 *
 * DELIBERATELY NOT UNIVERSAL. The graph-propagation win is entirely on
 * multi-hop reasoning: HippoRAG 2 (arXiv:2502.14802, ICML 2025) measures +13.9
 * multi-hop recall@5 and essentially nothing on single-hop, and GraphRAG-Bench
 * (arXiv:2506.05690, ICLR 2026) finds basic RAG BEATS graph methods on simple
 * fact retrieval while losing by 10–13 points on complex reasoning. Applying
 * the walk everywhere would buy the multi-hop win at the cost of a real
 * regression on lookups.
 *
 *   - `structural` — "what calls X", "what does Y depend on". Answering these
 *     well means traversing edges, which is exactly what the walk does. IN.
 *   - `semantic` — open-ended "how does X work" questions whose answer is
 *     spread across collaborating symbols rather than sitting in one. IN.
 *   - `symbol_lookup` — the user named the thing. Single-hop fact retrieval;
 *     the answer is the exact match, and diffusing score toward its neighbors
 *     can only push the named symbol down. OUT.
 *   - `location` — a path/glob constraint. There is no reasoning hop to make,
 *     and the graph knows nothing about directory layout. OUT.
 *   - `similarity` — "find code like this" is a nearest-neighbor question in
 *     embedding space; call-graph adjacency is a different relation entirely
 *     (similar code usually does NOT call similar code). OUT.
 */
const PPR_INTENTS: readonly QueryIntent[] = ["structural", "semantic"];

// ============================================================================
// Orchestrator
// ============================================================================

export class PipelineOrchestrator {
	constructor(
		private router: QueryRouter,
		private backends: ISearchBackend[],
		private config: PipelineConfig,
		/**
		 * Optional learned per-file boosts. Absent (or returning null) when the
		 * opt-in learning system is unavailable/inactive — the common case.
		 */
		private boostProvider?: FileBoostProvider,
		/**
		 * Optional symbol graph for query-seeded Personalized PageRank. Absent
		 * (or returning null) when there is no symbol graph to walk — and unused
		 * regardless unless `config.personalizedPageRank.enabled`, which is off
		 * by default.
		 */
		private graphProvider?: SymbolGraphProvider,
	) {}

	async search(
		query: string,
		options: SearchOptions = {},
	): Promise<MergedResult[]> {
		const limit = options.limit ?? 10;

		// 1. Route query to classify intent
		const { classification } = await this.router.route(query);

		// 2. Select backends based on intent + config
		const intentBackendNames = INTENT_BACKENDS[classification.intent] ?? [
			"semantic",
		];

		// Only activate backends that are both in the intent set and enabled in config
		const selectedBackends = this.backends.filter((b) => {
			if (!intentBackendNames.includes(b.name)) return false;
			return this.isBackendEnabled(b.name);
		});

		if (selectedBackends.length === 0) return [];

		// 3. Create abort controller for short-circuit
		const controller = new AbortController();
		const { signal } = controller;

		// 4. LSP short-circuit logic
		const lspBackend = selectedBackends.find((b) => b.name === "lsp");
		const otherBackends = selectedBackends.filter((b) => b.name !== "lsp");

		const settled: Array<{ name: BackendName; results: BackendResult[] }> = [];

		if (
			lspBackend &&
			this.config.lspShortCircuit &&
			otherBackends.length > 0 &&
			classification.confidence >= this.config.routerMinConfidence
		) {
			// Race: LSP vs. all others
			const lspPromise = lspBackend
				.search(query, classification, options, signal)
				.then((results) => ({ name: lspBackend.name as BackendName, results }))
				.catch(() => ({
					name: lspBackend.name as BackendName,
					results: [] as BackendResult[],
				}));

			const othersPromise = Promise.allSettled(
				otherBackends.map((b) =>
					b.search(query, classification, options, signal).then((results) => ({
						name: b.name,
						results,
					})),
				),
			);

			// Use a manual race: if LSP resolves with definitive first, abort others
			let lspResolved = false;
			let othersResolved = false;
			let lspResult: { name: BackendName; results: BackendResult[] } | null =
				null;
			let othersResult: typeof othersPromise extends Promise<infer T>
				? T
				: never = [] as never;

			await Promise.race([
				lspPromise.then((r) => {
					lspResolved = true;
					lspResult = r;
					const hasDefinitive = r.results.some((res) => res.isDefinitive);
					if (hasDefinitive) {
						controller.abort();
					}
				}),
				othersPromise.then((r) => {
					othersResolved = true;
					othersResult = r;
				}),
			]);

			// Wait for both to complete (one may have finished via race already)
			if (!lspResolved) {
				lspResult = await lspPromise;
			}
			if (!othersResolved) {
				othersResult = await othersPromise;
			}

			// Collect all results
			if (lspResult) {
				settled.push(lspResult);
			}

			for (const settledItem of othersResult) {
				if (settledItem.status === "fulfilled") {
					settled.push(settledItem.value);
				}
				// Rejected backends are silently dropped
			}
		} else {
			// No LSP short-circuit: run all backends in parallel
			const allResults = await Promise.allSettled(
				selectedBackends.map((b) =>
					b.search(query, classification, options, signal).then((results) => ({
						name: b.name as BackendName,
						results,
					})),
				),
			);

			for (const item of allResults) {
				if (item.status === "fulfilled") {
					settled.push(item.value);
				}
			}
		}

		// Abort any still-running backends (no-op if already done)
		controller.abort();

		// 5. Fuse backend result lists (rrf by default, tm2c2 when configured)
		if (settled.length === 0) return [];

		// Per-query adaptation. Both halves are no-ops under the default config:
		// `applyScoreFloor` returns its input by identity when minScore is 0, and
		// the weights are left static unless adaptiveWeights.enabled.
		const floored = applyScoreFloor(settled, query, this.config.scoreFloor);
		const fusionConfig = this.config.adaptiveWeights.enabled
			? {
					...this.config,
					backendWeights: adaptBackendWeights(
						this.config.backendWeights,
						query,
						this.config.adaptiveWeights.strength,
					),
				}
			: this.config;

		// Query-seeded Personalized PageRank, if enabled AND this intent is one
		// the graph walk actually helps (see PPR_INTENTS). When it runs, fuse a
		// deeper candidate list so the walk has something below the cut to
		// promote; when it does not, `limit` is used exactly as before.
		const pprConfig = this.config.personalizedPageRank;
		const usePpr =
			pprConfig.enabled &&
			PPR_INTENTS.includes(classification.intent) &&
			this.graphProvider !== undefined;
		const mergeLimit = usePpr ? limit * pprConfig.candidateMultiplier : limit;

		let merged =
			fusionConfig.fusionMethod === "tm2c2"
				? tm2c2Merge(floored, fusionConfig, mergeLimit)
				: rrfMerge(floored, fusionConfig, mergeLimit);

		if (usePpr) {
			merged = applyPersonalizedPageRank(
				merged,
				this.graphProvider?.() ?? null,
				pprConfig,
			).slice(0, limit);
		}

		// 6. Apply learned per-file boosts (same semantics as search_code).
		// No-op when learning is off, which is the default.
		merged = applyFileBoosts(
			merged,
			this.boostProvider?.() ?? null,
			(r) => r.file,
			(r) => r.rrfScore,
			(r, rrfScore) => ({ ...r, rrfScore }),
		);

		// 7. Apply file pattern filter on final merged results (in case some backends didn't)
		if (options.filePattern) {
			const pat = options.filePattern
				.replace(/\*\*/g, ".*")
				.replace(/\*/g, "[^/]*");
			const regex = new RegExp(pat, "i");
			return merged.filter((r) => !r.file || regex.test(r.file));
		}

		return merged;
	}

	private isBackendEnabled(name: BackendName): boolean {
		switch (name) {
			case "symbol-graph":
				return this.config.backends.symbolGraph;
			case "lsp":
				return this.config.backends.lsp;
			case "tree-sitter":
				return this.config.backends.treeSitter;
			case "semantic":
				return this.config.backends.semantic;
			case "location":
				return this.config.backends.location;
			default:
				return false;
		}
	}
}
