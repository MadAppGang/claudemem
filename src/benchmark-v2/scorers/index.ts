/**
 * Scorers Module
 *
 * Aggregates, normalizes, and analyzes benchmark evaluation results.
 */

export {
	ScoreAggregator,
	createScoreAggregator,
	type AggregationInput,
	type ModelAggregation,
	type JudgeAggregation,
	type ContrastiveAggregation,
	type DownstreamAggregation,
	type CriterionStats,
	type OverallScore,
} from "./aggregator.js";

export {
	ScoreNormalizer,
	createScoreNormalizer,
	calculateConfidenceInterval,
	calculateEffectSize,
	type NormalizationMethod,
	type NormalizationOptions,
	type NormalizedScores,
} from "./normalizer.js";

export {
	calculateStatistics,
	pearsonCorrelation,
	spearmanCorrelation,
	calculateCorrelationMatrix,
	pairedTTest,
	calculateKappa,
	analyzeInterRaterAgreement,
	analyzeRankingStability,
	type StatisticalSummary,
	type CorrelationMatrix,
	type SignificanceTest,
	type RankingStability,
	type InterRaterAgreement,
} from "./statistics.js";

// ============================================================================
// Phase Executor
// ============================================================================

import type { PhaseContext, PhaseResult } from "../pipeline/orchestrator.js";
import type { NormalizedScores } from "../types.js";
import { createScoreAggregator } from "./aggregator.js";

/**
 * Create the scoring phase executor
 */
export function createScoringPhaseExecutor(): (
	context: PhaseContext
) => Promise<PhaseResult> {
	return async (context: PhaseContext): Promise<PhaseResult> => {
		const { db, run, config, stateMachine } = context;

		try {
			stateMachine.startPhase("aggregation", 1);

			// Get all data
			const summaries = db.getSummaries(run.id);
			const evaluationResults = db.getEvaluationResults(run.id);
			const pairwiseResults = db.getPairwiseResults(run.id);

			// Aggregate scores
			const aggregator = createScoreAggregator(config);
			const aggregations = aggregator.aggregate({
				summaries,
				evaluationResults,
				pairwiseResults,
				kValues: config.evaluation.retrieval.kValues,
			});

			// Save normalized scores to database
			for (const [modelId, agg] of aggregations) {
				const normalizedScores: NormalizedScores = {
					modelId,
					judge: {
						pointwise: agg.judge.pointwise.overall.mean / 5,
						pairwise: agg.judge.pairwise.btScore,
						combined: (agg.judge.pointwise.overall.mean / 5 + agg.judge.pairwise.btScore) / 2,
					},
					contrastive: {
						embedding: agg.contrastive.embedding.accuracy,
						llm: agg.contrastive.llm.accuracy,
						combined: agg.contrastive.combined,
					},
					retrieval: {
						precision1: agg.retrieval.precision[1] || 0,
						precision5: agg.retrieval.precision[5] || 0,
						mrr: agg.retrieval.mrr,
						winRate: agg.retrieval.winRate,
						// Use win rate as primary metric (cross-model competition)
						// Falls back to MRR if win rate not available (single model run)
						combined: agg.retrieval.winRate > 0 ? agg.retrieval.winRate : agg.retrieval.mrr,
					},
					downstream: {
						completion: agg.downstream.completion.bleuScore,
						bugLocalization: agg.downstream.bugLocalization.accuracy,
						functionSelection: agg.downstream.functionSelection.accuracy,
						combined: agg.downstream.overall,
					},
					overall: agg.overall.score,
					// Operational metrics (don't affect quality ranking)
					iterative: agg.iterative ? {
						avgRounds: agg.iterative.avgRounds,
						successRate: agg.iterative.successRate,
						avgRefinementScore: agg.iterative.avgRefinementScore,
					} : undefined,
					self: agg.self ? {
						overall: agg.self.overall,
						retrieval: agg.self.retrieval.accuracy,
						functionSelection: agg.self.functionSelection.accuracy,
					} : undefined,
				};
				db.saveAggregatedScores(run.id, modelId, normalizedScores);
			}

			stateMachine.updateProgress("aggregation", 1, "complete", "Scoring complete");

			return {
				success: true,
				itemsProcessed: aggregations.size,
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return {
				success: false,
				itemsProcessed: 0,
				error: message,
			};
		}
	};
}
