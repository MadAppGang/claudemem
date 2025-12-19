/**
 * Score Aggregator
 *
 * Aggregates raw evaluation results into model-level scores.
 * Handles weighted combinations, normalization, and statistics.
 */

import type {
	EvaluationResult,
	JudgeScores,
	AggregatedScore,
	ModelScore,
	BenchmarkConfig,
	ScoringConfig,
	GeneratedSummary,
	PairwiseResult,
} from "../types.js";
import type { AggregatedRetrievalMetrics } from "../evaluators/retrieval/index.js";
import { aggregateRetrievalResults } from "../evaluators/retrieval/index.js";
import { aggregateTournamentResults } from "../evaluators/judge/pairwise.js";

// ============================================================================
// Types
// ============================================================================

export interface AggregationInput {
	summaries: GeneratedSummary[];
	evaluationResults: EvaluationResult[];
	pairwiseResults: PairwiseResult[];
	kValues: number[];
}

export interface ModelAggregation {
	modelId: string;
	judge: JudgeAggregation;
	contrastive: ContrastiveAggregation;
	retrieval: AggregatedRetrievalMetrics;
	downstream: DownstreamAggregation;
	overall: OverallScore;
}

export interface JudgeAggregation {
	pointwise: {
		accuracy: CriterionStats;
		completeness: CriterionStats;
		semanticRichness: CriterionStats;
		abstraction: CriterionStats;
		conciseness: CriterionStats;
		overall: CriterionStats;
	};
	pairwise: {
		wins: number;
		losses: number;
		ties: number;
		winRate: number;
		btScore: number;
	};
}

export interface ContrastiveAggregation {
	embedding: {
		accuracy: number;
		count: number;
	};
	llm: {
		accuracy: number;
		count: number;
	};
	combined: number;
}

export interface DownstreamAggregation {
	completion: {
		bleuScore: number;
		exactMatch: number;
		count: number;
	};
	bugLocalization: {
		accuracy: number;
		count: number;
	};
	functionSelection: {
		accuracy: number;
		count: number;
	};
	overall: number;
}

export interface CriterionStats {
	mean: number;
	median: number;
	stdDev: number;
	min: number;
	max: number;
	count: number;
}

export interface OverallScore {
	score: number;
	rank: number;
	confidence: number;
}

// ============================================================================
// Score Aggregator
// ============================================================================

export class ScoreAggregator {
	private scoringConfig: ScoringConfig;

	constructor(config: BenchmarkConfig) {
		this.scoringConfig = config.weights;
	}

	/**
	 * Aggregate all evaluation results into model scores
	 */
	aggregate(input: AggregationInput): Map<string, ModelAggregation> {
		const { summaries, evaluationResults, pairwiseResults, kValues } = input;

		// Group by model
		const modelIds = [...new Set(summaries.map((s) => s.modelId))];
		const resultsByModel = new Map<string, EvaluationResult[]>();
		const summariesByModel = new Map<string, GeneratedSummary[]>();

		for (const modelId of modelIds) {
			const modelSummaryIds = new Set(
				summaries.filter((s) => s.modelId === modelId).map((s) => s.id)
			);

			resultsByModel.set(
				modelId,
				evaluationResults.filter((r) => modelSummaryIds.has(r.summaryId))
			);

			summariesByModel.set(
				modelId,
				summaries.filter((s) => s.modelId === modelId)
			);
		}

		// Calculate pairwise tournament scores ONCE with ALL models
		// (must be done before per-model aggregation)
		const tournamentScores = aggregateTournamentResults(pairwiseResults, modelIds);

		// Aggregate each model
		const aggregations = new Map<string, ModelAggregation>();

		for (const modelId of modelIds) {
			const modelResults = resultsByModel.get(modelId) || [];

			aggregations.set(modelId, {
				modelId,
				judge: this.aggregateJudge(modelResults, tournamentScores, modelId),
				contrastive: this.aggregateContrastive(modelResults),
				retrieval: this.aggregateRetrieval(modelResults, kValues),
				downstream: this.aggregateDownstream(modelResults),
				overall: { score: 0, rank: 0, confidence: 0 }, // Calculated after all models
			});
		}

		// Calculate overall scores and rankings
		this.calculateOverallScores(aggregations);

		return aggregations;
	}

	/**
	 * Convert aggregations to final scores for storage
	 */
	toAggregatedScores(
		aggregations: Map<string, ModelAggregation>
	): AggregatedScore[] {
		const scores: AggregatedScore[] = [];

		for (const [modelId, agg] of aggregations) {
			scores.push({
				modelId,
				judgeScore: agg.judge.pointwise.overall.mean,
				contrastiveAccuracy: agg.contrastive.combined,
				retrievalMRR: agg.retrieval.mrr,
				retrievalPrecision: agg.retrieval.precision,
				downstreamScore: agg.downstream.overall,
				overallScore: agg.overall.score,
				rank: agg.overall.rank,
			});
		}

		return scores.sort((a, b) => a.rank - b.rank);
	}

	// ============================================================================
	// Private Aggregation Methods
	// ============================================================================

	private aggregateJudge(
		results: EvaluationResult[],
		tournamentScores: Map<string, { wins: number; losses: number; ties: number; winRate: number; btScore: number }>,
		modelId: string
	): JudgeAggregation {
		const judgeResults = results.filter(
			(r) => r.evaluationType === "judge" && r.judgeResults
		);

		// Aggregate pointwise scores
		const accuracyScores = judgeResults.map((r) => r.judgeResults!.scores.accuracy);
		const completenessScores = judgeResults.map(
			(r) => r.judgeResults!.scores.completeness
		);
		const semanticRichnessScores = judgeResults.map(
			(r) => r.judgeResults!.scores.semanticRichness
		);
		const abstractionScores = judgeResults.map(
			(r) => r.judgeResults!.scores.abstraction
		);
		const concisenessScores = judgeResults.map(
			(r) => r.judgeResults!.scores.conciseness
		);
		const overallScores = judgeResults.map((r) => r.judgeResults!.weightedAverage);

		// Get pairwise score for this model (already calculated with all models)
		const modelScore = tournamentScores.get(modelId) || {
			wins: 0,
			losses: 0,
			ties: 0,
			winRate: 0,
			btScore: 0,
		};

		return {
			pointwise: {
				accuracy: this.calculateStats(accuracyScores),
				completeness: this.calculateStats(completenessScores),
				semanticRichness: this.calculateStats(semanticRichnessScores),
				abstraction: this.calculateStats(abstractionScores),
				conciseness: this.calculateStats(concisenessScores),
				overall: this.calculateStats(overallScores),
			},
			pairwise: modelScore,
		};
	}

	private aggregateContrastive(results: EvaluationResult[]): ContrastiveAggregation {
		const contrastiveResults = results.filter(
			(r) => r.evaluationType === "contrastive" && r.contrastiveResults
		);

		const embeddingResults = contrastiveResults.filter(
			(r) => r.contrastiveResults!.method === "embedding"
		);
		const llmResults = contrastiveResults.filter(
			(r) => r.contrastiveResults!.method === "llm"
		);

		const embeddingCorrect = embeddingResults.filter(
			(r) => r.contrastiveResults!.correct
		).length;
		const llmCorrect = llmResults.filter(
			(r) => r.contrastiveResults!.correct
		).length;

		const embeddingAccuracy =
			embeddingResults.length > 0 ? embeddingCorrect / embeddingResults.length : 0;
		const llmAccuracy =
			llmResults.length > 0 ? llmCorrect / llmResults.length : 0;

		// Calculate mean confidence gap for embedding results
		// Higher gap = more distinguishing summaries = better quality
		const avgConfidenceGap = embeddingResults.length > 0
			? embeddingResults.reduce((sum, r) => sum + (r.contrastiveResults!.confidenceGap || 0), 0) / embeddingResults.length
			: 0;

		// Score = accuracy * 0.6 + normalized confidence gap * 0.4
		// This differentiates models even when all get 100% accuracy
		// Confidence gap typically ranges 0-0.3, so multiply by 3 to normalize to ~0-1
		const normalizedGap = Math.min(avgConfidenceGap * 3, 1);
		const embeddingScore = embeddingAccuracy * 0.6 + normalizedGap * 0.4;

		// Combined score: weighted average if both present
		let combined = 0;
		if (embeddingResults.length > 0 && llmResults.length > 0) {
			combined = (embeddingScore + llmAccuracy) / 2;
		} else if (embeddingResults.length > 0) {
			combined = embeddingScore;
		} else if (llmResults.length > 0) {
			combined = llmAccuracy;
		}

		return {
			embedding: { accuracy: embeddingScore, count: embeddingResults.length },
			llm: { accuracy: llmAccuracy, count: llmResults.length },
			combined,
		};
	}

	private aggregateRetrieval(
		results: EvaluationResult[],
		kValues: number[]
	): AggregatedRetrievalMetrics {
		const retrievalResults = results
			.filter((r) => r.evaluationType === "retrieval" && r.retrievalResults)
			.map((r) => r.retrievalResults!);

		return aggregateRetrievalResults(retrievalResults, kValues);
	}

	private aggregateDownstream(results: EvaluationResult[]): DownstreamAggregation {
		const downstreamResults = results.filter(
			(r) => r.evaluationType === "downstream" && r.downstreamResults
		);

		// Completion tasks
		const completionResults = downstreamResults.filter(
			(r) => r.downstreamResults!.taskType === "completion"
		);
		const completionBleu =
			completionResults.length > 0
				? completionResults.reduce((sum, r) => sum + (r.downstreamResults!.bleuScore || 0), 0) /
				  completionResults.length
				: 0;
		const completionExact =
			completionResults.length > 0
				? completionResults.filter((r) => r.downstreamResults!.success).length /
				  completionResults.length
				: 0;

		// Bug localization
		const bugResults = downstreamResults.filter(
			(r) => r.downstreamResults!.taskType === "bug_localization"
		);
		const bugAccuracy =
			bugResults.length > 0
				? bugResults.filter((r) => r.downstreamResults!.success).length / bugResults.length
				: 0;

		// Function selection
		const funcResults = downstreamResults.filter(
			(r) => r.downstreamResults!.taskType === "function_selection"
		);
		const funcAccuracy =
			funcResults.length > 0
				? funcResults.filter((r) => r.downstreamResults!.success).length / funcResults.length
				: 0;

		// Overall downstream score
		const overall =
			(completionBleu + completionExact + bugAccuracy + funcAccuracy) / 4;

		return {
			completion: {
				bleuScore: completionBleu,
				exactMatch: completionExact,
				count: completionResults.length,
			},
			bugLocalization: {
				accuracy: bugAccuracy,
				count: bugResults.length,
			},
			functionSelection: {
				accuracy: funcAccuracy,
				count: funcResults.length,
			},
			overall,
		};
	}

	private calculateOverallScores(aggregations: Map<string, ModelAggregation>): void {
		const weights = this.scoringConfig.evalWeights;

		// Calculate weighted overall score for each model
		for (const [modelId, agg] of aggregations) {
			const judgeScore = agg.judge.pointwise.overall.mean / 5; // Normalize to 0-1
			const contrastiveScore = agg.contrastive.combined;
			// Use win rate if available (cross-model competition), else fall back to MRR
			const retrievalScore = agg.retrieval.winRate > 0 ? agg.retrieval.winRate : agg.retrieval.mrr;
			const downstreamScore = agg.downstream.overall;

			agg.overall.score =
				weights.judge * judgeScore +
				weights.contrastive * contrastiveScore +
				weights.retrieval * retrievalScore +
				weights.downstream * downstreamScore;

			// Confidence based on sample sizes
			const sampleSizes = [
				agg.judge.pointwise.overall.count,
				agg.contrastive.embedding.count + agg.contrastive.llm.count,
				agg.downstream.completion.count +
					agg.downstream.bugLocalization.count +
					agg.downstream.functionSelection.count,
			];
			const avgSamples = sampleSizes.reduce((a, b) => a + b, 0) / sampleSizes.length;
			agg.overall.confidence = Math.min(1, avgSamples / 100); // Cap at 100 samples
		}

		// Calculate rankings
		const sorted = [...aggregations.entries()].sort(
			(a, b) => b[1].overall.score - a[1].overall.score
		);

		sorted.forEach(([modelId, _], index) => {
			aggregations.get(modelId)!.overall.rank = index + 1;
		});
	}

	private calculateStats(values: number[]): CriterionStats {
		if (values.length === 0) {
			return { mean: 0, median: 0, stdDev: 0, min: 0, max: 0, count: 0 };
		}

		const sorted = [...values].sort((a, b) => a - b);
		const mean = values.reduce((a, b) => a + b, 0) / values.length;
		const median =
			values.length % 2 === 0
				? (sorted[values.length / 2 - 1] + sorted[values.length / 2]) / 2
				: sorted[Math.floor(values.length / 2)];

		const squaredDiffs = values.map((v) => Math.pow(v - mean, 2));
		const variance = squaredDiffs.reduce((a, b) => a + b, 0) / values.length;
		const stdDev = Math.sqrt(variance);

		return {
			mean,
			median,
			stdDev,
			min: sorted[0],
			max: sorted[sorted.length - 1],
			count: values.length,
		};
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createScoreAggregator(config: BenchmarkConfig): ScoreAggregator {
	return new ScoreAggregator(config);
}
