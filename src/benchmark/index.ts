/**
 * Benchmark Module
 *
 * LLM benchmark system for evaluating summary generation models.
 * Supports multiple providers, hybrid evaluation (AST + LLM), and comprehensive reporting.
 */

// Evaluators
export {
	BenchmarkEvaluator,
	createTestCaseSelector,
	runBenchmark,
	TestCaseSelector,
} from "./evaluators/index.js";
// Generators
export {
	createGenerator,
	createGenerators,
	DEFAULT_GENERATORS,
	POPULAR_GENERATORS,
	parseGeneratorSpec,
	SummaryGenerator,
} from "./generators/index.js";
// Judges
export {
	BlindJudge,
	ConsensusJudge,
	createBlindJudge,
	createConsensusJudge,
	createJudge,
	DEFAULT_JUDGE_MODEL,
	evaluateBlindly,
	LLMJudge,
	POPULAR_JUDGES,
	parseAndCreateJudge,
} from "./judges/index.js";
// Reporters
export {
	CLIReporter,
	createReporter,
	createReporters,
	DetailedReporter,
	JSONReporter,
} from "./reporters/index.js";

// Scorers
export {
	CompletenessScorer,
	CompositeScorer,
	ConcisenessScorer,
	CorrectnessScorer,
	CostScorer,
	createBasicCompositeScorer,
	createCompositeScorer,
	createCostScorer,
	createPerformanceScorer,
	PerformanceScorer,
	QualityScorer,
	UsefulnessScorer,
} from "./scorers/index.js";
// Types
export type {
	AggregateScores,
	ASTGroundTruth,
	// Config types
	BenchmarkConfig,
	BenchmarkMetadata,
	BenchmarkPhase,
	BenchmarkProgressCallback,
	BenchmarkResults,
	GenerationResult,
	// Generator types
	GeneratorInfo,
	GeneratorResults,
	IJudge,
	IReporter,
	IScorer,
	ISummaryGenerator,
	JudgeContext,
	// Judge types
	JudgeInfo,
	JudgmentResult,
	PerformanceMetrics,
	Rankings,
	// Reporter types
	ReportFormat,
	ScoreResult,
	// Scorer types
	ScoringCriterion,
	TestCase,
	// Result types
	TestCaseResult,
	// Test case types
	TestCaseType,
	UsageStats,
} from "./types.js";
export { DEFAULT_WEIGHTS } from "./types.js";
