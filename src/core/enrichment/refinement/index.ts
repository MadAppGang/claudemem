/**
 * Refinement Module
 *
 * Iterative refinement of code summaries based on quality testing.
 * Used by both benchmark evaluation and production indexing.
 *
 * @example
 * ```typescript
 * import {
 *   createRefinementEngine,
 *   createRetrievalStrategy,
 *   type RefinementContext,
 * } from './refinement';
 *
 * const strategy = createRetrievalStrategy({ embeddingsClient, targetRank: 3 });
 * const engine = createRefinementEngine();
 *
 * const result = await engine.refine(initialSummary, context, {
 *   maxRounds: 3,
 *   strategy,
 *   llmClient,
 * });
 *
 * console.log(`Refined in ${result.rounds} rounds, score: ${result.metrics.refinementScore}`);
 * ```
 */

// Types
export type {
	QualityTestResult,
	RefinementContext,
	RefinementResult,
	RefinementAttempt,
	RefinementOptions,
	IRefinementStrategy,
	IterativeRefinementConfig,
	IterativeRefinementResults,
} from "./types.js";

export { calculateRefinementScore, DEFAULT_ITERATIVE_CONFIG } from "./types.js";

// Engine
export { RefinementEngine, createRefinementEngine } from "./engine.js";

// Strategies
export {
	BaseRefinementStrategy,
	RetrievalRefinementStrategy,
	createRetrievalStrategy,
	cosineSimilarity,
	rankBySimilarity,
} from "./strategies/index.js";

export type { RetrievalStrategyOptions } from "./strategies/index.js";
