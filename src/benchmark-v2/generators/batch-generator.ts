/**
 * Batch Summary Generator
 *
 * Generates summaries for multiple code units across multiple models.
 * Handles rate limiting, retries, and parallel execution.
 */

import type { ILLMClient, LLMProvider } from "../../types.js";
import { RateLimitError, isRateLimitError, isRecoverable } from "../errors.js";
import type {
	BenchmarkCodeUnit,
	GeneratedSummary,
	ModelConfig,
} from "../types.js";
import { SummaryGenerator, createSummaryGenerator } from "./summary-generator.js";
import type { PhaseContext, PhaseResult } from "../pipeline/orchestrator.js";

// ============================================================================
// Types
// ============================================================================

export interface BatchGenerationOptions {
	/** Models to generate summaries for */
	models: ModelConfig[];
	/** LLM clients by model ID */
	clients: Map<string, ILLMClient>;
	/** Delay between requests in ms (for rate limiting) */
	delayBetweenRequests?: number;
	/** Maximum retries per request */
	maxRetries?: number;
	/** Run models in parallel (for cloud providers) */
	parallelModels?: boolean;
	/** Concurrency for code unit generation per model (default: 5) */
	concurrency?: number;
	/** Progress callback with inProgress, failures count, and last error for animated progress bars */
	onProgress?: (model: string, completed: number, total: number, inProgress: number, failures: number, lastError?: string) => void;
}

export interface BatchGenerationResult {
	/** Generated summaries by model ID */
	summaries: Map<string, GeneratedSummary[]>;
	/** Failed generations */
	failures: Array<{
		modelId: string;
		codeUnitId: string;
		error: string;
	}>;
	/** Total cost across all models */
	totalCost: number;
	/** Total tokens used */
	totalTokens: number;
}

// ============================================================================
// Batch Generator Class
// ============================================================================

export class BatchGenerator {
	private options: BatchGenerationOptions;
	private generators: Map<string, SummaryGenerator>;

	constructor(options: BatchGenerationOptions) {
		this.options = {
			delayBetweenRequests: 100,
			maxRetries: 3,
			parallelModels: true,
			concurrency: 20,
			...options,
		};

		// Create generators for each model
		this.generators = new Map();
		for (const model of options.models) {
			const client = options.clients.get(model.id);
			if (client) {
				this.generators.set(
					model.id,
					createSummaryGenerator({
						llmClient: client,
						modelConfig: model,
					})
				);
			}
		}
	}

	/**
	 * Generate summaries for all code units across all models
	 */
	async generate(
		codeUnits: BenchmarkCodeUnit[]
	): Promise<BatchGenerationResult> {
		const result: BatchGenerationResult = {
			summaries: new Map(),
			failures: [],
			totalCost: 0,
			totalTokens: 0,
		};

		// Initialize result maps
		for (const model of this.options.models) {
			result.summaries.set(model.id, []);
		}

		// Separate cloud and local models
		// Local models (LM Studio, Ollama) share hardware and must run sequentially
		const cloudModels: Array<[string, SummaryGenerator]> = [];
		const localModels: Array<[string, SummaryGenerator]> = [];

		for (const [modelId, generator] of this.generators) {
			const client = this.options.clients.get(modelId);
			if (client?.isCloud()) {
				cloudModels.push([modelId, generator]);
			} else {
				localModels.push([modelId, generator]);
			}
		}

		// Helper to collect model result
		const collectResult = (modelResult: {
			modelId: string;
			summaries: GeneratedSummary[];
			failures: Array<{ modelId: string; codeUnitId: string; error: string }>;
			cost: number;
			tokens: number;
		}) => {
			result.summaries.set(modelResult.modelId, modelResult.summaries);
			result.failures.push(...modelResult.failures);
			result.totalCost += modelResult.cost;
			result.totalTokens += modelResult.tokens;
		};

		// Run cloud models in parallel (they have separate API endpoints)
		if (this.options.parallelModels && cloudModels.length > 1) {
			const cloudResults = await Promise.all(
				cloudModels.map(([modelId, generator]) =>
					this.generateForModel(modelId, generator, codeUnits)
				)
			);
			for (const modelResult of cloudResults) {
				collectResult(modelResult);
			}
		} else {
			// Run cloud models sequentially if parallelModels is false
			for (const [modelId, generator] of cloudModels) {
				const modelResult = await this.generateForModel(modelId, generator, codeUnits);
				collectResult(modelResult);
			}
		}

		// Always run local models sequentially (they share hardware - GPU/CPU)
		for (const [modelId, generator] of localModels) {
			const modelResult = await this.generateForModel(
				modelId,
				generator,
				codeUnits,
				1 // Force concurrency=1 for local models
			);
			collectResult(modelResult);
		}

		return result;
	}

	/**
	 * Generate summaries for a single model with concurrent processing
	 * @param concurrencyOverride - Override concurrency (e.g., 1 for local models)
	 */
	private async generateForModel(
		modelId: string,
		generator: SummaryGenerator,
		codeUnits: BenchmarkCodeUnit[],
		concurrencyOverride?: number
	): Promise<{
		modelId: string;
		summaries: GeneratedSummary[];
		failures: Array<{ modelId: string; codeUnitId: string; error: string }>;
		cost: number;
		tokens: number;
	}> {
		const summaries: GeneratedSummary[] = [];
		const failures: Array<{ modelId: string; codeUnitId: string; error: string }> = [];
		const concurrency = concurrencyOverride ?? this.options.concurrency ?? 5;

		// Track in-progress items for animated progress
		let completed = 0;
		let failureCount = 0;
		let lastErrorMsg: string | undefined;
		const inProgress = new Set<string>();

		// Process a single code unit with retries
		const processCodeUnit = async (codeUnit: BenchmarkCodeUnit): Promise<void> => {
			inProgress.add(codeUnit.id);

			// Report progress with inProgress count
			if (this.options.onProgress) {
				this.options.onProgress(modelId, completed, codeUnits.length, inProgress.size, failureCount, lastErrorMsg);
			}

			let lastError: Error | null = null;
			for (let attempt = 0; attempt < (this.options.maxRetries ?? 3); attempt++) {
				try {
					const summary = await generator.generateSummary(codeUnit);
					summaries.push(summary);
					lastError = null;
					break;
				} catch (error) {
					lastError = error instanceof Error ? error : new Error(String(error));

					// Handle rate limits with exponential backoff
					if (isRateLimitError(error)) {
						const backoff = (error as RateLimitError).retryAfterMs ??
							Math.pow(2, attempt) * 1000;
						await this.delay(backoff);
						continue;
					}

					// For other recoverable errors, retry with delay
					if (isRecoverable(error)) {
						await this.delay(Math.pow(2, attempt) * 500);
						continue;
					}

					// Non-recoverable error, don't retry
					break;
				}
			}

			// Record failure if all retries exhausted
			if (lastError) {
				failures.push({
					modelId,
					codeUnitId: codeUnit.id,
					error: lastError.message,
				});
				failureCount++;
				lastErrorMsg = lastError.message;
			}

			inProgress.delete(codeUnit.id);
			completed++;

			// Report progress after completion (with failure info if any)
			if (this.options.onProgress) {
				this.options.onProgress(modelId, completed, codeUnits.length, inProgress.size, failureCount, lastErrorMsg);
			}
		};

		// Initial progress report
		if (this.options.onProgress) {
			this.options.onProgress(modelId, 0, codeUnits.length, 0, 0);
		}

		// Process code units in concurrent batches
		for (let i = 0; i < codeUnits.length; i += concurrency) {
			const batch = codeUnits.slice(i, i + concurrency);
			await Promise.all(batch.map(processCodeUnit));

			// Rate limiting delay between batches
			if (this.options.delayBetweenRequests && i + concurrency < codeUnits.length) {
				await this.delay(this.options.delayBetweenRequests);
			}
		}

		const usage = generator.getUsageStats();
		return {
			modelId,
			summaries,
			failures,
			cost: usage.cost,
			tokens: usage.inputTokens + usage.outputTokens,
		};
	}

	/**
	 * Get a generator by model ID
	 */
	getGenerator(modelId: string): SummaryGenerator | undefined {
		return this.generators.get(modelId);
	}

	private delay(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createBatchGenerator(
	options: BatchGenerationOptions
): BatchGenerator {
	return new BatchGenerator(options);
}

// ============================================================================
// Phase Executor
// ============================================================================

/**
 * Create the generation phase executor
 */
export function createGenerationPhaseExecutor(
	clients: Map<string, ILLMClient>
): (context: PhaseContext) => Promise<PhaseResult> {
	return async (context: PhaseContext): Promise<PhaseResult> => {
		const { db, run, config, stateMachine } = context;

		try {
			// Get code units from database
			const codeUnits = db.getCodeUnits(run.id);
			const totalItems = codeUnits.length * config.generators.length;

			// Start the phase
			stateMachine.startPhase("generation", totalItems);

			// Check for resume point
			const resumePoint = stateMachine.getResumePoint("generation");
			let startIndex = 0;
			if (resumePoint?.lastProcessedId) {
				// Find where we left off
				const existingSummaries = db.getSummaries(run.id);
				startIndex = existingSummaries.length;
			}

			// Create batch generator with concurrent code unit processing
			const batchGenerator = createBatchGenerator({
				models: config.generators,
				clients,
				parallelModels: true,
				concurrency: 20, // Process 20 code units in parallel per model
				onProgress: (model, completed, total, inProgress, failures, lastError) => {
					const overallCompleted = startIndex + completed;
					// Encode progress info for CLI to parse: model: completed/total/inProgress/failures|error
					const errorPart = failures > 0 && lastError ? `|${lastError}` : "";
					stateMachine.updateProgress(
						"generation",
						overallCompleted,
						`${model}:${completed}`,
						`${model}: ${completed}/${total}/${inProgress}/${failures}${errorPart}`
					);
				},
			});

			// Generate summaries
			const result = await batchGenerator.generate(codeUnits);

			// Persist summaries to database
			for (const [modelId, summaries] of result.summaries) {
				db.insertSummaries(run.id, summaries);
			}

			// Calculate success count
			let totalSummaries = 0;
			for (const summaries of result.summaries.values()) {
				totalSummaries += summaries.length;
			}

			// Group failures by model for detailed reporting
			const failuresByModel = new Map<string, { count: number; errors: string[] }>();
			for (const f of result.failures) {
				if (!failuresByModel.has(f.modelId)) {
					failuresByModel.set(f.modelId, { count: 0, errors: [] });
				}
				const modelFailures = failuresByModel.get(f.modelId)!;
				modelFailures.count++;
				if (!modelFailures.errors.includes(f.error)) {
					modelFailures.errors.push(f.error);
				}
			}

			// Convert to array for PhaseResult
			const failures = Array.from(failuresByModel.entries()).map(([model, data]) => ({
				model,
				count: data.count,
				error: data.errors.join("; "),
			}));

			// Continue with partial results - don't fail the whole benchmark
			// Only fail if we have zero summaries
			return {
				success: totalSummaries > 0,
				itemsProcessed: totalSummaries,
				error: result.failures.length > 0 && totalSummaries === 0
					? `All ${result.failures.length} summaries failed to generate`
					: undefined,
				failures: failures.length > 0 ? failures : undefined,
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
