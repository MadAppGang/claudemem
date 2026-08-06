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

// Engine
export { createRefinementEngine, RefinementEngine } from "./engine.js";
export type { RetrievalStrategyOptions } from "./strategies/index.js";
// Strategies
export {
	BaseRefinementStrategy,
	cosineSimilarity,
	createRetrievalStrategy,
	RetrievalRefinementStrategy,
	rankBySimilarity,
} from "./strategies/index.js";
// Types
export type {
	IRefinementStrategy,
	IterativeRefinementConfig,
	IterativeRefinementResults,
	QualityTestResult,
	RefinementAttempt,
	RefinementContext,
	RefinementOptions,
	RefinementResult,
} from "./types.js";
export { calculateRefinementScore, DEFAULT_ITERATIVE_CONFIG } from "./types.js";
