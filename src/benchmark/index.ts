/**
 * Benchmark Module
 *
 * LLM benchmark system for evaluating summary generation models.
 * Supports multiple providers, hybrid evaluation (AST + LLM), and comprehensive reporting.
 */

// Types
export type {
	// Generator types
	GeneratorInfo,
	GenerationResult,
	UsageStats,
	ISummaryGenerator,
	// Judge types
	JudgeInfo,
	JudgeContext,
	JudgmentResult,
	IJudge,
	// Scorer types
	ScoringCriterion,
	ScoreResult,
	IScorer,
	// Test case types
	TestCaseType,
	ASTGroundTruth,
	TestCase,
	// Result types
	TestCaseResult,
	AggregateScores,
	PerformanceMetrics,
	GeneratorResults,
	Rankings,
	BenchmarkMetadata,
	BenchmarkResults,
	// Reporter types
	ReportFormat,
	IReporter,
	// Config types
	BenchmarkConfig,
	BenchmarkProgressCallback,
	BenchmarkPhase,
} from "./types.js";

export { DEFAULT_WEIGHTS } from "./types.js";

// Generators
export {
	SummaryGenerator,
	createGenerator,
	createGenerators,
	parseGeneratorSpec,
	DEFAULT_GENERATORS,
	POPULAR_GENERATORS,
} from "./generators/index.js";

// Judges
export {
	LLMJudge,
	ConsensusJudge,
	BlindJudge,
	evaluateBlindly,
	createJudge,
	createConsensusJudge,
	createBlindJudge,
	parseAndCreateJudge,
	DEFAULT_JUDGE_MODEL,
	POPULAR_JUDGES,
} from "./judges/index.js";

// Scorers
export {
	CorrectnessScorer,
	CompletenessScorer,
	UsefulnessScorer,
	ConcisenessScorer,
	QualityScorer,
	PerformanceScorer,
	CostScorer,
	CompositeScorer,
	createCompositeScorer,
	createBasicCompositeScorer,
	createPerformanceScorer,
	createCostScorer,
} from "./scorers/index.js";

// Evaluators
export {
	TestCaseSelector,
	createTestCaseSelector,
	BenchmarkEvaluator,
	runBenchmark,
} from "./evaluators/index.js";

// Reporters
export {
	CLIReporter,
	JSONReporter,
	DetailedReporter,
	createReporter,
	createReporters,
} from "./reporters/index.js";
