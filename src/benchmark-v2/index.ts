/**
 * Benchmark V2 Module
 *
 * Comprehensive LLM summary evaluation system with:
 * - LLM-as-Judge evaluation
 * - Contrastive matching
 * - Retrieval evaluation (P@K, MRR)
 * - Downstream tasks (code completion, bug localization, function selection)
 *
 * Usage:
 *   import { runBenchmarkV2 } from './benchmark-v2';
 *   const result = await runBenchmarkV2({ projectPath: '.' });
 */

import { randomUUID } from "crypto";
import { join } from "path";
import { existsSync, mkdirSync } from "fs";

// Re-export core types (avoid module conflicts)
export type {
	BenchmarkCodeUnit,
	GeneratedSummary,
	EvaluationResult,
	BenchmarkRun,
	BenchmarkConfig,
	BenchmarkPhase,
	BenchmarkStatus,
	ModelConfig,
	SamplingConfig,
	JudgeEvaluationConfig,
	ContrastiveEvaluationConfig,
	RetrievalEvaluationConfig,
	DownstreamEvaluationConfig,
	AggregatedScore,
	PairwiseResult,
	QueryType,
	GeneratedQuery,
} from "./types.js";

// Re-export errors
export * from "./errors.js";

// Import types for internal use
import type {
	BenchmarkConfig,
	BenchmarkRun,
	BenchmarkPhase,
	ModelConfig,
	SamplingConfig,
	JudgeEvaluationConfig,
	ContrastiveEvaluationConfig,
	RetrievalEvaluationConfig,
	DownstreamEvaluationConfig,
	EvaluationWeights,
} from "./types.js";
import { BenchmarkDatabase } from "./storage/benchmark-db.js";
import { PipelineOrchestrator } from "./pipeline/orchestrator.js";
import { createExtractionPhaseExecutor } from "./extractors/index.js";
import { createGenerationPhaseExecutor } from "./generators/index.js";
import { createJudgePhaseExecutor } from "./evaluators/judge/index.js";
import { createContrastivePhaseExecutor } from "./evaluators/contrastive/index.js";
import { createRetrievalPhaseExecutor } from "./evaluators/retrieval/index.js";
import { createDownstreamPhaseExecutor } from "./evaluators/downstream/index.js";
import { createScoringPhaseExecutor } from "./scorers/index.js";
import { createReportingPhaseExecutor } from "./reporters/index.js";
import type { ILLMClient, IEmbeddingsClient } from "../types.js";
import type { PhaseResult } from "./pipeline/orchestrator.js";

// ============================================================================
// Configuration Defaults
// ============================================================================

export const DEFAULT_SAMPLING_CONFIG: SamplingConfig = {
	strategy: "stratified",
	targetCount: 20,
	maxPerFile: 10,
	minComplexity: 2,
};

export const DEFAULT_JUDGE_CONFIG: JudgeEvaluationConfig = {
	enabled: true,
	judgeModels: ["claude-opus-4-5-20251101"],
	usePairwise: true,
	criteriaWeights: {
		accuracy: 0.25,
		completeness: 0.2,
		semanticRichness: 0.2,
		abstraction: 0.2,
		conciseness: 0.15,
	},
};

export const DEFAULT_CONTRASTIVE_CONFIG: ContrastiveEvaluationConfig = {
	enabled: true,
	method: "both",
	distractorCount: 9, // More distractors = harder task = better model differentiation
};

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalEvaluationConfig = {
	enabled: true,
	kValues: [1, 3, 5, 10],
	queryTypes: ["vague", "wrong_terminology", "specific_behavior"],
};

export const DEFAULT_DOWNSTREAM_CONFIG: DownstreamEvaluationConfig = {
	enabled: true,
	tasks: {
		codeCompletion: true,
		bugLocalization: true,
		functionSelection: true,
	},
};

export const DEFAULT_EVAL_WEIGHTS: EvaluationWeights = {
	judge: 0.35,
	contrastive: 0.2,
	retrieval: 0.4, // Most critical for code search/indexing
	downstream: 0.05, // Less relevant for search use case
};

// ============================================================================
// Configuration Builder
// ============================================================================

export interface BenchmarkOptions {
	/** Project path to analyze */
	projectPath: string;
	/** Run name for identification */
	runName?: string;
	/** Database path (defaults to .claudemem/benchmark-v2.db) */
	dbPath?: string;
	/** Output directory for reports */
	outputDir?: string;
	/** LLM models to test (generator configs) */
	generators?: Array<{
		id: string;
		provider: string;
		model: string;
		displayName?: string;
	}>;
	/** Judge models for LLM-as-Judge */
	judgeModels?: string[];
	/** Sampling configuration */
	sampling?: Partial<SamplingConfig>;
	/** Judge evaluation config */
	judge?: Partial<JudgeEvaluationConfig>;
	/** Contrastive evaluation config */
	contrastive?: Partial<ContrastiveEvaluationConfig>;
	/** Retrieval evaluation config */
	retrieval?: Partial<RetrievalEvaluationConfig>;
	/** Downstream evaluation config */
	downstream?: Partial<DownstreamEvaluationConfig>;
	/** Evaluation weights */
	weights?: Partial<EvaluationWeights>;
	/** Client factories */
	clients?: {
		createLLMClient?: (modelId: string) => ILLMClient;
		createEmbeddingsClient?: () => IEmbeddingsClient;
	};
	/** Progress callback */
	onProgress?: (phase: string, progress: number, total: number, details?: string) => void;
	/** Phase completion callback with detailed failures */
	onPhaseComplete?: (phase: string, result: PhaseResult) => void;
	/** Abort signal for cancellation */
	signal?: AbortSignal;
	/** Resume from existing run */
	resumeRunId?: string;
	/** Verbose logging */
	verbose?: boolean;
}

/**
 * Create a complete benchmark configuration from options
 */
export function createBenchmarkConfig(options: BenchmarkOptions): BenchmarkConfig {
	const {
		projectPath,
		runName = `benchmark-${new Date().toISOString().slice(0, 10)}`,
		generators = [],
		judgeModels = DEFAULT_JUDGE_CONFIG.judgeModels,
		sampling = {},
		judge = {},
		contrastive = {},
		retrieval = {},
		downstream = {},
		weights = {},
	} = options;

	// Convert simple generator format to ModelConfig
	const modelConfigs: ModelConfig[] = generators.map((g) => ({
		id: g.id,
		provider: g.provider as any,
		modelName: g.model,
		displayName: g.displayName || g.id,
		temperature: 0.3,
		maxTokens: 2000,
	}));

	return {
		name: runName,
		projectPath,
		generators: modelConfigs,
		judges: judge.judgeModels || judgeModels,
		sampleSize: sampling.targetCount || DEFAULT_SAMPLING_CONFIG.targetCount,
		samplingStrategy: sampling.strategy || DEFAULT_SAMPLING_CONFIG.strategy,
		codeUnitTypes: ["function", "class", "method"],
		evaluation: {
			judge: {
				enabled: judge.enabled ?? DEFAULT_JUDGE_CONFIG.enabled,
				judgeModels: judge.judgeModels || judgeModels,
				usePairwise: judge.usePairwise ?? DEFAULT_JUDGE_CONFIG.usePairwise,
			},
			contrastive: {
				enabled: contrastive.enabled ?? DEFAULT_CONTRASTIVE_CONFIG.enabled,
				distractorCount: contrastive.distractorCount ?? DEFAULT_CONTRASTIVE_CONFIG.distractorCount,
				method: contrastive.method ?? DEFAULT_CONTRASTIVE_CONFIG.method,
			},
			retrieval: {
				enabled: retrieval.enabled ?? DEFAULT_RETRIEVAL_CONFIG.enabled,
				queriesPerUnit: 3,
				kValues: retrieval.kValues ?? DEFAULT_RETRIEVAL_CONFIG.kValues,
			},
			downstream: {
				enabled: downstream.enabled ?? DEFAULT_DOWNSTREAM_CONFIG.enabled,
				tasks: downstream.tasks ?? DEFAULT_DOWNSTREAM_CONFIG.tasks,
			},
		},
		weights: {
			judgeWeights: { pointwise: 0.4, pairwise: 0.6 },
			contrastiveWeights: { embedding: 0.5, llm: 0.5 },
			retrievalWeights: { precision1: 0.3, precision5: 0.4, mrr: 0.3 },
			downstreamWeights: { completion: 0.4, bugLocalization: 0.3, functionSelection: 0.3 },
			evalWeights: { ...DEFAULT_EVAL_WEIGHTS, ...weights },
		},
		outputFormats: ["json", "markdown", "html"],
		verbose: options.verbose,
	};
}

// ============================================================================
// Main Benchmark Runner
// ============================================================================

export interface BenchmarkResult {
	run: BenchmarkRun;
	outputFiles: {
		json?: string;
		markdown?: string;
		html?: string;
	};
	success: boolean;
	error?: string;
}

/**
 * Run the complete benchmark pipeline
 */
export async function runBenchmarkV2(
	options: BenchmarkOptions
): Promise<BenchmarkResult> {
	const {
		projectPath,
		dbPath = join(projectPath, ".claudemem", "benchmark-v2.db"),
		outputDir = join(projectPath, ".claudemem", "benchmark-reports"),
		clients = {},
		onProgress,
		onPhaseComplete,
		signal,
		resumeRunId,
		verbose = false,
	} = options;

	// Ensure directories exist
	const dbDir = join(projectPath, ".claudemem");
	if (!existsSync(dbDir)) {
		mkdirSync(dbDir, { recursive: true });
	}

	// Create configuration
	const config = createBenchmarkConfig(options);

	// Initialize database
	const db = new BenchmarkDatabase(dbPath);

	// Create or resume run
	let run: BenchmarkRun;
	if (resumeRunId) {
		const existingRun = db.getRun(resumeRunId);
		if (!existingRun) {
			throw new Error(`Run ${resumeRunId} not found`);
		}
		run = existingRun;
		if (verbose) {
			console.log(`Resuming run ${run.id} from status ${run.status}`);
		}
	} else {
		// Create new run using the database method
		run = db.createRun(config);
		if (verbose) {
			console.log(`Created new run ${run.id}`);
		}
	}

	// Build client maps
	const llmClients = new Map<string, ILLMClient>();
	const judgeClients = new Map<string, ILLMClient>();

	if (clients.createLLMClient) {
		// Create clients for generators
		// Pass generator.id to preserve provider info (e.g., "openrouter/openai/gpt-4")
		for (const generator of config.generators) {
			try {
				llmClients.set(generator.id, clients.createLLMClient(generator.id));
			} catch (error) {
				if (verbose) {
					console.warn(`Failed to create LLM client for ${generator.id}: ${error}`);
				}
			}
		}

		// Create clients for judges
		for (const judgeModel of config.judges) {
			try {
				judgeClients.set(judgeModel, clients.createLLMClient(judgeModel));
			} catch (error) {
				if (verbose) {
					console.warn(`Failed to create judge client for ${judgeModel}: ${error}`);
				}
			}
		}
	}

	const embeddingsClient = clients.createEmbeddingsClient?.();

	// Create phase executors
	const extractionExecutor = createExtractionPhaseExecutor(projectPath);
	const generationExecutor = createGenerationPhaseExecutor(llmClients);
	const judgeExecutor = createJudgePhaseExecutor(judgeClients);

	// Get first available client for shared evaluators
	const firstJudgeClient = judgeClients.size > 0
		? judgeClients.values().next().value
		: undefined;

	// Only create evaluators if we have the required clients
	// Update config to disable evaluations we can't run
	const contrastiveExecutor = embeddingsClient
		? createContrastivePhaseExecutor(firstJudgeClient, embeddingsClient)
		: undefined;
	const retrievalExecutor = embeddingsClient
		? createRetrievalPhaseExecutor(embeddingsClient, firstJudgeClient)
		: undefined;
	const downstreamExecutor = firstJudgeClient
		? createDownstreamPhaseExecutor(firstJudgeClient)
		: undefined;

	// Disable evaluations we can't run (no clients)
	if (!embeddingsClient) {
		config.evaluation.contrastive.enabled = false;
		config.evaluation.retrieval.enabled = false;
		console.log("  Note: Contrastive and retrieval evaluation disabled (no embeddings client)");
	}
	if (!firstJudgeClient) {
		config.evaluation.downstream.enabled = false;
		console.log("  Note: Downstream evaluation disabled (no judge client)");
	}
	const scoringExecutor = createScoringPhaseExecutor();
	const reportingExecutor = createReportingPhaseExecutor(outputDir);

	// Build phase map
	type PhaseExecutor = (context: any) => Promise<PhaseResult>;
	const phases = new Map<string, PhaseExecutor>();
	phases.set("extraction", extractionExecutor);
	phases.set("generation", generationExecutor);
	phases.set("evaluation:judge", judgeExecutor);
	if (contrastiveExecutor) phases.set("evaluation:contrastive", contrastiveExecutor);
	if (retrievalExecutor) phases.set("evaluation:retrieval", retrievalExecutor);
	if (downstreamExecutor) phases.set("evaluation:downstream", downstreamExecutor);
	phases.set("aggregation", scoringExecutor);
	phases.set("reporting", reportingExecutor);

	// Create orchestrator
	const orchestrator = new PipelineOrchestrator(
		db,
		run,
		{
			onProgress: (phase: BenchmarkPhase, progress: number, total: number, details?: string) => {
				onProgress?.(phase, progress, total, details);
				if (verbose) {
					console.log(`[${phase}] ${progress}/${total} ${details || ""}`);
				}
			},
			onPhaseComplete: (phase: BenchmarkPhase, result: PhaseResult) => {
				// Forward phase completion to caller (with failures if any)
				onPhaseComplete?.(phase, result);
			},
			abortSignal: signal,
		}
	);

	// Register phase executors
	phases.forEach((executor, phaseName) => {
		orchestrator.registerExecutor(phaseName as BenchmarkPhase, executor);
	});

	// Run the pipeline
	try {
		await orchestrator.run();

		// Get final run state
		const finalRun = db.getRun(run.id)!;

		return {
			run: finalRun,
			outputFiles: {
				json: join(outputDir, `${run.id}.json`),
				markdown: join(outputDir, `${run.id}.md`),
				html: join(outputDir, `${run.id}.html`),
			},
			success: true,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);

		// Update run status
		db.updateRunStatus(run.id, "failed");

		return {
			run: db.getRun(run.id)!,
			outputFiles: {},
			success: false,
			error: message,
		};
	}
}

// ============================================================================
// CLI Handler
// ============================================================================

import {
	c,
	printLogo,
	printBenchmarkHeader,
	createBenchmarkProgress,
	createSimpleProgress,
	renderTable,
	renderSummary,
	renderInfo,
	renderSuccess,
	renderError,
	formatPercent,
	formatDuration,
	truncate,
	getHighlight,
	type TableColumn,
	type CellValue,
} from "../ui/index.js";

/**
 * CLI command handler for benchmark-llm-v2
 */
export async function runBenchmarkCLI(args: string[]): Promise<void> {
	// Parse CLI arguments
	const getFlag = (name: string): string | undefined => {
		const idx = args.findIndex((a) => a.startsWith(`--${name}=`));
		if (idx !== -1) return args[idx].split("=")[1];
		const idxSpace = args.findIndex((a) => a === `--${name}`);
		if (idxSpace !== -1 && args[idxSpace + 1] && !args[idxSpace + 1].startsWith("-")) {
			return args[idxSpace + 1];
		}
		return undefined;
	};

	const generatorsStr = getFlag("generators") || "anthropic";
	const judgesStr = getFlag("judges");
	const casesStr = getFlag("cases") || "20";
	const resumeRunId = getFlag("resume");
	const verbose = args.includes("--verbose") || args.includes("-v");
	const projectPath = process.cwd();

	// Print logo and header
	printLogo();
	printBenchmarkHeader("🔬", "LLM SUMMARY BENCHMARK");

	// Parse generators
	// Format: "anthropic" or "openrouter/openai/gpt-4" (provider/model)
	const generatorSpecs = generatorsStr.split(",").map((s) => s.trim());
	const generators = generatorSpecs.map((spec) => {
		if (spec.startsWith("openrouter/")) {
			// OpenRouter format: openrouter/provider/model
			const model = spec.slice("openrouter/".length); // "openai/gpt-4"
			return {
				id: spec,
				provider: "openrouter",
				model,
				displayName: spec,
			};
		} else if (spec.includes("/")) {
			// Generic provider/model format
			const slashIdx = spec.indexOf("/");
			return {
				id: spec,
				provider: spec.slice(0, slashIdx),
				model: spec.slice(slashIdx + 1),
				displayName: spec,
			};
		} else {
			// Just provider name (e.g., "anthropic")
			return {
				id: spec,
				provider: spec,
				model: spec,
				displayName: spec,
			};
		}
	});

	// Parse judges
	const judgeModels = judgesStr
		? judgesStr.split(",").map((s) => s.trim())
		: ["claude-opus-4-5-20251101"];

	// Parse case count
	const targetCount = casesStr.toLowerCase() === "all" ? 1000 : parseInt(casesStr, 10);

	renderInfo(`Generators: ${generatorSpecs.join(", ")}`);
	renderInfo(`Judges: ${judgeModels.join(", ")}`);
	renderInfo(`Target code units: ${targetCount}`);
	if (resumeRunId) {
		renderInfo(`Resuming run: ${resumeRunId}`);
	}
	console.log();

	// Progress tracking with animated progress bars
	let currentPhase = "";
	const phaseStartTimes = new Map<string, number>();
	let activeMultiProgress: ReturnType<typeof createBenchmarkProgress> | null = null;
	let activeSimpleProgress: ReturnType<typeof createSimpleProgress> | null = null;
	let inPairwiseMode = false; // Track if we've switched to pairwise judging
	const potentiallySkippedPhases = new Set<string>(); // Track phases that started with 0 items
	const phasesWithWork = new Set<string>(); // Track phases that had actual work
	const phaseFailures = new Map<string, Array<{ model: string; count: number; error: string }>>(); // Track failures per phase
	const phaseSkipReasons = new Map<string, string>(); // Track skip reasons per phase

	// Helper to stop current progress bars
	const stopActiveProgress = () => {
		if (activeMultiProgress) {
			activeMultiProgress.stop();
			activeMultiProgress = null;
		}
		if (activeSimpleProgress) {
			activeSimpleProgress.finish();
			activeSimpleProgress = null;
		}
		inPairwiseMode = false;
	};

	// Phase display names for progress bars
	const phaseLabels: Record<string, string> = {
		extraction: "extracting",
		generation: "generating",
		"evaluation:judge": "judging",
		"evaluation:contrastive": "contrastive",
		"evaluation:retrieval": "retrieval",
		"evaluation:downstream": "downstream",
		aggregation: "aggregating",
		reporting: "reporting",
	};

	const onProgress = (phase: string, progress: number, total: number, details?: string) => {
		// Handle phase transitions
		if (phase !== currentPhase) {
			// Stop previous phase's progress bar
			stopActiveProgress();

			// Complete previous phase with timing
			if (currentPhase) {
				// Print detailed failures if any
				const failures = phaseFailures.get(currentPhase);
				if (failures && failures.length > 0) {
					console.log(`${c.yellow}  Failures:${c.reset}`);
					for (const f of failures) {
						console.log(`${c.red}    ${f.model}: ${f.count} failed${c.reset}`);
						// Show full error, wrapped if long
						const errorLines = f.error.split(/[;\n]/).filter(s => s.trim());
						for (const line of errorLines.slice(0, 3)) { // Max 3 error lines per model
							console.log(`${c.dim}      ${line.trim()}${c.reset}`);
						}
						if (errorLines.length > 3) {
							console.log(`${c.dim}      ... and ${errorLines.length - 3} more errors${c.reset}`);
						}
					}
				}
			}

			// Start new phase
			currentPhase = phase;
			phaseStartTimes.set(phase, Date.now());

			// Track phases that start with 0 items (might be skipped, or might update later)
			if (total === 0 && !details) {
				potentiallySkippedPhases.add(phase);
				return; // Don't create progress bar yet - wait for updates
			}

			// Phase has work
			phasesWithWork.add(phase);

			// Create progress bars for phases
			if (phase === "generation") {
				// Multi-item progress bar for generation (one per model)
				activeMultiProgress = createBenchmarkProgress(generatorSpecs);
				activeMultiProgress.start();
			} else if (phase === "evaluation:judge") {
				// Multi-item progress bar for judge (one per judge model)
				activeMultiProgress = createBenchmarkProgress(judgeModels);
				activeMultiProgress.start();
			} else {
				// Simple single-line progress bar for other phases
				activeSimpleProgress = createSimpleProgress(phaseLabels[phase] || phase, total);
				activeSimpleProgress.update(0);
			}
		}

		// Handle late start: phase started with 0 items but now has real work
		if (potentiallySkippedPhases.has(phase) && total > 0 && !activeSimpleProgress && !activeMultiProgress) {
			phasesWithWork.add(phase);
			activeSimpleProgress = createSimpleProgress(phaseLabels[phase] || phase, total);
			activeSimpleProgress.update(progress);
		}

		// Update progress for multi-item phases
		if (activeMultiProgress && details) {
			// Parse details: "model: completed/total/inProgress/failures|error" or "pairwise:model: completed/total/inProgress"
			const isPairwise = details.startsWith("pairwise:");
			// New format with failures: model: 5/6/0/1|error message
			// Old format without failures: model: 5/6/0
			const matchWithFailures = details.match(/^(?:pairwise:)?(.+?):\s*(\d+)\/(\d+)\/(\d+)\/(\d+)(?:\|(.*))?$/);
			const matchOld = details.match(/^(?:pairwise:)?(.+?):\s*(\d+)\/(\d+)\/(\d+)$/);
			const match = matchWithFailures || matchOld;

			if (match) {
				const [, model, completed, modelTotal, inProgressStr, failuresStr, errorMsg] = match;
				const completedNum = parseInt(completed, 10);
				const totalNum = parseInt(modelTotal, 10);
				const inProgressNum = parseInt(inProgressStr, 10);
				const failuresNum = failuresStr ? parseInt(failuresStr, 10) : 0;

				// When pairwise starts, stop pointwise progress bar and create new one for pairwise
				if (isPairwise && !inPairwiseMode) {
					inPairwiseMode = true;
					// Stop the pointwise progress bar (keeps "✓ done" visible)
					if (activeMultiProgress) {
						activeMultiProgress.stop();
					}
					// Create new progress bar for pairwise
					activeMultiProgress = createBenchmarkProgress(judgeModels);
					activeMultiProgress.start();
				}

				const phaseLabel = isPairwise ? "pairwise" :
					phase === "generation" ? "generating" : "judging";
				activeMultiProgress.update(model, completedNum, totalNum, inProgressNum, phaseLabel, failuresNum);

				// Mark as done when complete
				if (completedNum >= totalNum && inProgressNum === 0) {
					if (failuresNum > 0 && failuresNum === totalNum && errorMsg) {
						// All failed - show error
						activeMultiProgress.setError(model, errorMsg);
					} else if (failuresNum > 0) {
						// Partial failures - finish with warning (shown in status)
						activeMultiProgress.finish(model);
					} else {
						activeMultiProgress.finish(model);
					}
				}
			}
		}

		// Update progress for simple progress bar phases
		if (activeSimpleProgress) {
			activeSimpleProgress.update(progress);
		}
	};

	// Import LLM resolver and embeddings client factories
	const { LLMResolver } = await import("../llm/resolver.js");
	const { createEmbeddingsClient } = await import("../core/embeddings.js");

	// Create LLM client using unified resolver
	// Supports: anthropic, openrouter/model, or/model, lmstudio/model, ollama/model, x-ai/grok, etc.
	const createClientForModel = async (modelSpec: string): Promise<ILLMClient> => {
		return LLMResolver.createClient(modelSpec);
	};

	try {
		const result = await runBenchmarkV2({
			projectPath,
			generators,
			judgeModels,
			sampling: { targetCount },
			onProgress,
			onPhaseComplete: (phase, result) => {
				// Store failures for display when phase transitions
				if (result.failures && result.failures.length > 0) {
					phaseFailures.set(phase, result.failures);
				}
				// Store skip reason if phase was skipped
				if (result.skipReason) {
					phaseSkipReasons.set(phase, result.skipReason);
				}
			},
			resumeRunId,
			verbose,
			clients: {
				createLLMClient: (modelId: string) => {
					// This is sync wrapper - actual creation happens lazily
					let clientPromise: Promise<ILLMClient> | null = null;
					const getClient = async () => {
						if (!clientPromise) {
							clientPromise = createClientForModel(modelId);
						}
						return clientPromise;
					};
					// Check if this is a local model (lmstudio/, ollama/, etc.)
					const isLocalModel = LLMResolver.isLocalProvider(modelId);
					// Return a proxy that delegates to the async client
					return {
						getProvider: () => LLMResolver.parseSpec(modelId).provider,
						getModel: () => modelId,
						isCloud: () => !isLocalModel,
						getAccumulatedUsage: () => ({ inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 }),
						resetAccumulatedUsage: () => {},
						complete: async (messages: any, options?: any) => {
							const client = await getClient();
							return client.complete(messages, options);
						},
						completeJSON: async (messages: any, options?: any) => {
							const client = await getClient();
							return client.completeJSON(messages, options);
						},
						testConnection: async () => {
							const client = await getClient();
							return client.testConnection();
						},
					} as ILLMClient;
				},
				createEmbeddingsClient: () => {
					// Create embeddings client for contrastive and retrieval evaluations
					return createEmbeddingsClient();
				},
			},
		});

		// Complete the last phase
		stopActiveProgress();

		if (result.success) {
			console.log();

			// Get scores and evaluation results from database for console display
			const dbPath = join(projectPath, ".claudemem", "benchmark-v2.db");
			const { BenchmarkDatabase } = await import("./storage/benchmark-db.js");
			const db = new BenchmarkDatabase(dbPath);
			const scores = db.getAggregatedScores(result.run.id);
			const evalResults = db.getEvaluationResults(result.run.id, "judge");
			const summaries = db.getSummaries(result.run.id);

			// Helper functions
			const truncateName = (s: string, max = 24) => {
				const short = s.split("/").pop() || s;
				return short.length > max ? short.slice(0, max - 1) + "…" : short;
			};
			const fmtPct = (v: number) => isNaN(v) ? "N/A" : `${(v * 100).toFixed(0)}%`;
			const fmtLatency = (ms: number) => {
				if (isNaN(ms) || ms === 0) return "N/A";
				if (ms < 1000) return `${ms.toFixed(0)}ms`;
				return `${(ms / 1000).toFixed(1)}s`;
			};
			const fmtCost = (cost: number) => {
				if (isNaN(cost) || cost === 0) return "N/A";
				if (cost < 0.01) return `$${(cost * 100).toFixed(2)}¢`;
				if (cost < 1) return `$${cost.toFixed(3)}`;
				return `$${cost.toFixed(2)}`;
			};
			// Round to display precision for comparison (avoids floating-point issues)
			const round = (v: number) => Math.round(v * 1000) / 1000;
			const highlight = (val: string, isMax: boolean, isMin: boolean, shouldHL: boolean) => {
				if (!shouldHL) return val;
				if (isMax) return `${c.green}${val}${c.reset}`;
				if (isMin) return `${c.red}${val}${c.reset}`;
				return val;
			};
			// For latency, lower is better (invert highlighting)
			const highlightLatency = (val: string, isMin: boolean, isMax: boolean, shouldHL: boolean) => {
				if (!shouldHL) return val;
				if (isMin) return `${c.green}${val}${c.reset}`;  // Lower latency = good
				if (isMax) return `${c.red}${val}${c.reset}`;    // Higher latency = bad
				return val;
			};

			// Calculate average latency and total cost per model
			const latencyByModel = new Map<string, number>();
			const costByModel = new Map<string, number>();
			let totalBenchmarkCost = 0;

			for (const modelId of scores.keys()) {
				const modelSummaries = summaries.filter(s => s.modelId === modelId);
				if (modelSummaries.length > 0) {
					const totalLatency = modelSummaries.reduce(
						(sum, s) => sum + (s.generationMetadata?.latencyMs || 0),
						0
					);
					latencyByModel.set(modelId, totalLatency / modelSummaries.length);

					const totalCost = modelSummaries.reduce(
						(sum, s) => sum + (s.generationMetadata?.cost || 0),
						0
					);
					costByModel.set(modelId, totalCost);
					totalBenchmarkCost += totalCost;
				}
			}

			if (scores.size > 0) {
				// Convert to array and sort by overall score
				const scoreArray = Array.from(scores.entries())
					.map(([modelId, s]) => ({ modelId, ...s }))
					.sort((a, b) => b.overall - a.overall);
				const shouldHighlight = scoreArray.length > 1;

				// ═══════════════════════════════════════════════════════════════════
				// OVERALL RESULTS TABLE
				// ═══════════════════════════════════════════════════════════════════
				console.log(`${c.orange}${c.bold}╔════════════════════════════════════════════════════════════════════════════════════════════╗${c.reset}`);
				console.log(`${c.orange}${c.bold}║${c.reset}                            ${c.bold}OVERALL BENCHMARK RESULTS${c.reset}                                   ${c.orange}${c.bold}║${c.reset}`);
				console.log(`${c.orange}${c.bold}╚════════════════════════════════════════════════════════════════════════════════════════════╝${c.reset}`);
				console.log();
				console.log(`${c.dim}Weighted combination of all evaluation methods. Higher is better.${c.reset}`);
				console.log();

				// Calculate min/max for each column (rounded for floating-point comparison)
				const latencyValues = scoreArray.map(s => latencyByModel.get(s.modelId) || 0).filter(v => v > 0);
				const costValues = scoreArray.map(s => costByModel.get(s.modelId) || 0).filter(v => v > 0);
				const stats = {
					judge: { max: round(Math.max(...scoreArray.map(s => s.judge.combined))), min: round(Math.min(...scoreArray.map(s => s.judge.combined))) },
					contr: { max: round(Math.max(...scoreArray.map(s => s.contrastive.combined))), min: round(Math.min(...scoreArray.map(s => s.contrastive.combined))) },
					retr: { max: round(Math.max(...scoreArray.map(s => s.retrieval.combined))), min: round(Math.min(...scoreArray.map(s => s.retrieval.combined))) },
					down: { max: round(Math.max(...scoreArray.map(s => s.downstream.combined))), min: round(Math.min(...scoreArray.map(s => s.downstream.combined))) },
					overall: { max: round(Math.max(...scoreArray.map(s => s.overall))), min: round(Math.min(...scoreArray.map(s => s.overall))) },
					latency: latencyValues.length > 0
						? { max: round(Math.max(...latencyValues)), min: round(Math.min(...latencyValues)) }
						: { max: 0, min: 0 },
					cost: costValues.length > 0
						? { max: round(Math.max(...costValues)), min: round(Math.min(...costValues)) }
						: { max: 0, min: 0 },
				};

				console.log(`  ${"Model".padEnd(26)} ${"Judge".padEnd(8)} ${"Contr.".padEnd(8)} ${"Retr.".padEnd(8)} ${"Down.".padEnd(8)} ${"Overall".padEnd(8)} ${"Latency".padEnd(8)} ${"Cost".padEnd(8)}`);
				console.log(`  ${"─".repeat(26)} ${"─".repeat(7)} ${"─".repeat(7)} ${"─".repeat(7)} ${"─".repeat(7)} ${"─".repeat(7)} ${"─".repeat(7)} ${"─".repeat(7)}`);

				for (const s of scoreArray) {
					const name = truncateName(s.modelId).padEnd(26);
					const judge = highlight(fmtPct(s.judge.combined).padEnd(8), round(s.judge.combined) === stats.judge.max, round(s.judge.combined) === stats.judge.min && stats.judge.min !== stats.judge.max, shouldHighlight);
					const contr = highlight(fmtPct(s.contrastive.combined).padEnd(8), round(s.contrastive.combined) === stats.contr.max, round(s.contrastive.combined) === stats.contr.min && stats.contr.min !== stats.contr.max, shouldHighlight);
					const retr = highlight(fmtPct(s.retrieval.combined).padEnd(8), round(s.retrieval.combined) === stats.retr.max, round(s.retrieval.combined) === stats.retr.min && stats.retr.min !== stats.retr.max, shouldHighlight);
					const down = highlight(fmtPct(s.downstream.combined).padEnd(8), round(s.downstream.combined) === stats.down.max, round(s.downstream.combined) === stats.down.min && stats.down.min !== stats.down.max, shouldHighlight);
					const overall = highlight(fmtPct(s.overall).padEnd(8), round(s.overall) === stats.overall.max, round(s.overall) === stats.overall.min && stats.overall.min !== stats.overall.max, shouldHighlight);
					const modelLatency = latencyByModel.get(s.modelId) || 0;
					const latency = highlightLatency(fmtLatency(modelLatency).padEnd(8), round(modelLatency) === stats.latency.min && stats.latency.min !== stats.latency.max, round(modelLatency) === stats.latency.max && stats.latency.min !== stats.latency.max, shouldHighlight);
					const modelCost = costByModel.get(s.modelId) || 0;
					const cost = highlightLatency(fmtCost(modelCost).padEnd(8), round(modelCost) === stats.cost.min && stats.cost.min !== stats.cost.max, round(modelCost) === stats.cost.max && stats.cost.min !== stats.cost.max, shouldHighlight);
					console.log(`  ${name} ${judge} ${contr} ${retr} ${down} ${overall} ${latency} ${cost}`);
				}

				// Column explanations
				console.log();
				console.log(`${c.dim}Columns:${c.reset}`);
				console.log(`${c.dim}  • Judge:   LLM-as-Judge quality score (accuracy, completeness, abstraction)${c.reset}`);
				console.log(`${c.dim}  • Contr.:  Contrastive matching (can summary find its code among distractors?)${c.reset}`);
				console.log(`${c.dim}  • Retr.:   Retrieval quality (P@K, MRR - search performance)${c.reset}`);
				console.log(`${c.dim}  • Down.:   Downstream tasks (code completion, bug localization)${c.reset}`);
				console.log(`${c.dim}  • Overall: Weighted combination (Judge 40%, others 20% each)${c.reset}`);
				console.log(`${c.dim}  • Latency: Avg time to generate summaries (lower is better, green=fastest)${c.reset}`);
				console.log(`${c.dim}  • Cost:    Total generation cost per model (lower is better, green=cheapest)${c.reset}`);

				// Total benchmark cost
				if (totalBenchmarkCost > 0) {
					console.log();
					console.log(`${c.bold}Total Benchmark Cost: ${c.cyan}${fmtCost(totalBenchmarkCost)}${c.reset}`);
				}

				// ═══════════════════════════════════════════════════════════════════
				// DETAILED JUDGE SCORES TABLE
				// ═══════════════════════════════════════════════════════════════════
				console.log();
				console.log(`${c.cyan}${c.bold}┌──────────────────────────────────────────────────────────────────────────┐${c.reset}`);
				console.log(`${c.cyan}${c.bold}│${c.reset}                      ${c.bold}JUDGE EVALUATION DETAILS${c.reset}                          ${c.cyan}${c.bold}│${c.reset}`);
				console.log(`${c.cyan}${c.bold}└──────────────────────────────────────────────────────────────────────────┘${c.reset}`);
				console.log();
				console.log(`${c.dim}LLM judges rate summary quality on 5 criteria (1-5 scale, shown as %).${c.reset}`);
				console.log();

				// Calculate per-criteria stats
				const criteriaStats = {
					accuracy: { max: Math.max(...scoreArray.map(s => s.judge.pointwise)), min: Math.min(...scoreArray.map(s => s.judge.pointwise)) },
					pairwise: { max: Math.max(...scoreArray.map(s => s.judge.pairwise)), min: Math.min(...scoreArray.map(s => s.judge.pairwise)) },
				};

				console.log(`  ${"Model".padEnd(26)} ${"Pointwise".padEnd(10)} ${"Pairwise".padEnd(10)} ${"Combined".padEnd(10)}`);
				console.log(`  ${"─".repeat(26)} ${"─".repeat(9)} ${"─".repeat(9)} ${"─".repeat(9)}`);

				for (const s of scoreArray) {
					const name = truncateName(s.modelId).padEnd(26);
					const pointwise = highlight(fmtPct(s.judge.pointwise).padEnd(10), s.judge.pointwise === criteriaStats.accuracy.max, s.judge.pointwise === criteriaStats.accuracy.min && criteriaStats.accuracy.min !== criteriaStats.accuracy.max, shouldHighlight);
					const pairwise = highlight(fmtPct(s.judge.pairwise).padEnd(10), s.judge.pairwise === criteriaStats.pairwise.max, s.judge.pairwise === criteriaStats.pairwise.min && criteriaStats.pairwise.min !== criteriaStats.pairwise.max, shouldHighlight);
					const combined = highlight(fmtPct(s.judge.combined).padEnd(10), s.judge.combined === stats.judge.max, s.judge.combined === stats.judge.min && stats.judge.min !== stats.judge.max, shouldHighlight);
					console.log(`  ${name} ${pointwise} ${pairwise} ${combined}`);
				}

				console.log();
				console.log(`${c.dim}Scoring methods:${c.reset}`);
				console.log(`${c.dim}  • Pointwise: Each summary rated independently (accuracy, completeness, conciseness)${c.reset}`);
				console.log(`${c.dim}  • Pairwise:  Head-to-head comparison (which summary better describes the code?)${c.reset}`);
				console.log(`${c.dim}  • Combined:  Weighted mix of pointwise (40%) and pairwise (60%)${c.reset}`);

				// ═══════════════════════════════════════════════════════════════════
				// PER-JUDGE BREAKDOWN (if multiple judges)
				// ═══════════════════════════════════════════════════════════════════
				if (judgeModels.length > 1 && evalResults.length > 0) {
					console.log();
					console.log(`${c.yellow}${c.bold}┌──────────────────────────────────────────────────────────────────────────┐${c.reset}`);
					console.log(`${c.yellow}${c.bold}│${c.reset}                        ${c.bold}PER-JUDGE BREAKDOWN${c.reset}                            ${c.yellow}${c.bold}│${c.reset}`);
					console.log(`${c.yellow}${c.bold}└──────────────────────────────────────────────────────────────────────────┘${c.reset}`);
					console.log();
					console.log(`${c.dim}How each judge model scored the generators (shows judge agreement/bias).${c.reset}`);
					console.log();

					// Group results by judge
					const byJudge = new Map<string, Map<string, number[]>>();
					for (const judgeId of judgeModels) {
						byJudge.set(judgeId, new Map());
					}

					for (const evalResult of evalResults) {
						if (!evalResult.judgeResults) continue;
						const judgeId = evalResult.judgeResults.judgeModelId;
						const summary = summaries.find(s => s.id === evalResult.summaryId);
						if (!summary) continue;

						const judgeMap = byJudge.get(judgeId);
						if (!judgeMap) continue;

						if (!judgeMap.has(summary.modelId)) {
							judgeMap.set(summary.modelId, []);
						}
						judgeMap.get(summary.modelId)!.push(evalResult.judgeResults.weightedAverage);
					}

					// Display per-judge table
					const generatorIds = generatorSpecs;
					const judgeHeader = `  ${"Generator".padEnd(26)} ${judgeModels.map(j => truncateName(j, 12).padEnd(14)).join("")}`;
					console.log(judgeHeader);
					console.log(`  ${"─".repeat(26)} ${judgeModels.map(() => "─".repeat(13)).join(" ")}`);

					// Calculate per-judge stats for highlighting
					const judgeStats = new Map<string, { max: number; min: number }>();
					for (const judgeId of judgeModels) {
						const judgeMap = byJudge.get(judgeId)!;
						const avgs = Array.from(judgeMap.values()).map(scores => scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length / 5 : 0);
						judgeStats.set(judgeId, { max: Math.max(...avgs), min: Math.min(...avgs) });
					}

					for (const genId of generatorIds) {
						const genName = truncateName(genId).padEnd(26);
						const judgeScores = judgeModels.map(judgeId => {
							const judgeMap = byJudge.get(judgeId)!;
							const scores = judgeMap.get(genId) || [];
							const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length / 5 : 0;
							const stats = judgeStats.get(judgeId)!;
							return highlight(fmtPct(avg).padEnd(14), avg === stats.max, avg === stats.min && stats.min !== stats.max, shouldHighlight);
						}).join("");
						console.log(`  ${genName} ${judgeScores}`);
					}

					console.log();
					console.log(`${c.dim}Note: Similar scores across judges = reliable. Large differences = potential bias.${c.reset}`);
				}

				// ═══════════════════════════════════════════════════════════════════
				// SUMMARY
				// ═══════════════════════════════════════════════════════════════════
				console.log();
				console.log(`${c.green}${c.bold}┌──────────────────────────────────────────────────────────────────────────┐${c.reset}`);
				console.log(`${c.green}${c.bold}│${c.reset}                            ${c.bold}SUMMARY${c.reset}                                     ${c.green}${c.bold}│${c.reset}`);
				console.log(`${c.green}${c.bold}└──────────────────────────────────────────────────────────────────────────┘${c.reset}`);
				console.log();

				const best = scoreArray[0];
				const worst = scoreArray[scoreArray.length - 1];
				console.log(`  ${c.green}🏆 Best Overall:${c.reset}  ${truncateName(best.modelId, 30)} ${c.bold}(${fmtPct(best.overall)})${c.reset}`);
				if (shouldHighlight) {
					console.log(`  ${c.red}📉 Worst Overall:${c.reset} ${truncateName(worst.modelId, 30)} (${fmtPct(worst.overall)})`);
				}

				// Find best in each category
				const bestJudge = scoreArray.reduce((a, b) => a.judge.combined > b.judge.combined ? a : b);
				const bestContr = scoreArray.reduce((a, b) => a.contrastive.combined > b.contrastive.combined ? a : b);
				const bestRetr = scoreArray.reduce((a, b) => a.retrieval.combined > b.retrieval.combined ? a : b);
				const bestDown = scoreArray.reduce((a, b) => a.downstream.combined > b.downstream.combined ? a : b);

				console.log();
				console.log(`  ${c.cyan}Category leaders:${c.reset}`);
				console.log(`    📋 Judge Quality:    ${truncateName(bestJudge.modelId, 25)} (${fmtPct(bestJudge.judge.combined)})`);
				console.log(`    🎯 Contrastive:      ${truncateName(bestContr.modelId, 25)} (${fmtPct(bestContr.contrastive.combined)})`);
				console.log(`    🔍 Retrieval:        ${truncateName(bestRetr.modelId, 25)} (${fmtPct(bestRetr.retrieval.combined)})`);
				console.log(`    ⚡ Downstream Tasks: ${truncateName(bestDown.modelId, 25)} (${fmtPct(bestDown.downstream.combined)})`);
			}

			console.log();
			renderSuccess("Benchmark complete!");
			console.log();
			renderInfo("Reports:");
			if (result.outputFiles.json) {
				console.log(`  ${c.cyan}JSON:${c.reset}     ${result.outputFiles.json}`);
			}
			if (result.outputFiles.markdown) {
				console.log(`  ${c.cyan}Markdown:${c.reset} ${result.outputFiles.markdown}`);
			}
			if (result.outputFiles.html) {
				console.log(`  ${c.cyan}HTML:${c.reset}     ${result.outputFiles.html}`);
			}
			console.log();
		} else {
			console.log();
			renderError("Benchmark failed");
			console.error(`${c.dim}${result.error}${c.reset}\n`);
			process.exit(1);
		}
	} catch (error) {
		console.log();
		renderError("Benchmark error");
		console.error(`${c.dim}${error instanceof Error ? error.message : error}${c.reset}\n`);
		process.exit(1);
	}
}
