/**
 * E2E Validation System
 *
 * Core infrastructure for testing continuous learning improvements
 * using synthetic agents and A/B experiments.
 *
 * @module learning/validation
 */

// ============================================================================
// Types
// ============================================================================

export type {
	AgentConfig,
	AgentError,
	// Agent response types
	AgentResponse,
	AggregateResults,
	ComponentStyle,
	// Correction types
	CorrectionPoint,
	CorrectionStyle,
	CorrectionTrigger,
	CriteriaResult,
	ExecutionResult,
	ExecutionStatus,
	// Execution types
	ExecutionTask,
	ExperimentDecision,
	ExperimentDecisionAction,
	ExperimentGroup,
	ExperimentResults,
	// Experiment types
	ExperimentStatus,
	// User persona types
	ExpertiseLevel,
	MetricComparison,
	PackageManager,
	PowerAnalysisConfig,
	// Knowledge base types
	ProgrammingLanguage,
	RecordedCorrection,
	RecordedSession,
	RunConfig,
	// Scenario types
	ScenarioCategory,
	ScenarioDifficulty,
	ScenarioKnowledgeBase,
	ScenarioResults,
	SessionMetrics,
	// Session types
	SessionOutcome,
	// Statistical types
	StatisticalComparison,
	StatisticalConfig,
	// Success criteria types
	SuccessCriterion,
	TierConfig,
	TokenUsage,
	ToolCall,
	ToolEvent,
	UserPersona,
	UserResponse,
	ValidationExperiment,
	ValidationScenario,
	// Validation tier types
	ValidationTier,
	Verbosity,
} from "./types.js";

export {
	DEFAULT_KNOWLEDGE_BASE,
	DEFAULT_STATISTICAL_CONFIG,
	VALIDATION_TIERS,
} from "./types.js";

// ============================================================================
// Agent Driver
// ============================================================================

export type {
	AgentDriver,
	CreateDriverOptions,
	DriverStats,
	DriverType,
	HttpDriverConfig,
	LocalDriverConfig,
	MockResponse,
	ToolExecutionResult,
} from "./agent-driver.js";

export {
	createAgentDriver,
	HttpAgentDriver,
	LocalAgentDriver,
	MockAgentDriver,
} from "./agent-driver.js";

// ============================================================================
// Session Recorder
// ============================================================================

export type {
	SessionRecorderOptions,
	SessionSnapshot,
} from "./session-recorder.js";

export {
	CriteriaEvaluator,
	SessionRecorder,
} from "./session-recorder.js";

// ============================================================================
// Validation Store
// ============================================================================

export type { SummaryStats } from "./validation-store.js";

export {
	createValidationStore,
	ValidationStore,
} from "./validation-store.js";

// ============================================================================
// Environment Manager
// ============================================================================

export type {
	EnvironmentConfig,
	EnvironmentInfo,
	EnvironmentManager,
	EnvironmentType,
	SnapshotInfo,
} from "./environment-manager.js";

export {
	createEnvironmentManager,
	DockerEnvironmentManager,
	EnvironmentPool,
	GitEnvironmentManager,
	MockEnvironmentManager,
	TempEnvironmentManager,
} from "./environment-manager.js";

// ============================================================================
// Scenario Library
// ============================================================================

export {
	createScenarioLibrary,
	KNOWLEDGE_BASES,
	PERSONAS,
	ScenarioBuilder,
	ScenarioLibrary,
	scenario,
} from "./scenario-library.js";

// ============================================================================
// Synthetic Agent
// ============================================================================

export type {
	CorrectionResult,
	QueryAnswer,
	SyntheticResponse,
} from "./synthetic-agent.js";

export {
	CorrectionInjector,
	createSyntheticAgent,
	QueryHandler,
	SyntheticAgent,
} from "./synthetic-agent.js";

// ============================================================================
// Statistics Engine
// ============================================================================

export type { EffectSizeInterpretation } from "./statistics-engine.js";

export {
	createStatisticsEngine,
	StatisticsEngine,
} from "./statistics-engine.js";

// ============================================================================
// Experiment Engine
// ============================================================================

export type {
	DriverFactory,
	ExecutorConfig,
	ExperimentConfig,
	ExperimentEngineOptions,
} from "./experiment-engine.js";

export {
	createExperimentEngine,
	DecisionEngine,
	ExperimentEngine,
	ParallelExecutor,
} from "./experiment-engine.js";
