/**
 * Evaluators Module
 *
 * Exports all evaluation components:
 * - Judge: LLM-as-Judge (pointwise + pairwise)
 * - Contrastive: Summary-to-code matching
 * - Retrieval: P@K and MRR metrics
 * - Downstream: Code completion, bug localization, function selection
 */

// Base evaluator
export {
	BaseEvaluator,
	getModelFamily,
	isSameModelFamily,
	selectJudges,
} from "./base.js";
// Contrastive evaluators
export {
	createContrastivePhaseExecutor,
	createEmbeddingContrastiveEvaluator,
	createLLMContrastiveEvaluator,
	EmbeddingContrastiveEvaluator,
	LLMContrastiveEvaluator,
	selectDistractors,
} from "./contrastive/index.js";
// Downstream evaluators
export {
	createDownstreamEvaluator,
	createDownstreamPhaseExecutor,
	DownstreamEvaluator,
	generateBugLocalizationTasks,
	generateCompletionTasks,
	generateFunctionSelectionTasks,
} from "./downstream/index.js";

export { createJudgePhaseExecutor } from "./judge/index.js";
export {
	aggregateTournamentResults,
	createPairwiseJudgeEvaluator,
	PairwiseJudgeEvaluator,
} from "./judge/pairwise.js";
// Judge evaluators
export {
	createPointwiseJudgeEvaluator,
	PointwiseJudgeEvaluator,
} from "./judge/pointwise.js";
// Retrieval evaluator
export {
	type AggregatedRetrievalMetrics,
	aggregateRetrievalResults,
	createRetrievalEvaluator,
	createRetrievalPhaseExecutor,
	RetrievalEvaluator,
} from "./retrieval/index.js";
