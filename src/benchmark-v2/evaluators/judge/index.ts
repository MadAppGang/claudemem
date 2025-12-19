/**
 * Judge Evaluators Module
 *
 * LLM-as-Judge evaluation for summary quality.
 */

export {
	PointwiseJudgeEvaluator,
	createPointwiseJudgeEvaluator,
} from "./pointwise.js";

export {
	PairwiseJudgeEvaluator,
	createPairwiseJudgeEvaluator,
	aggregateTournamentResults,
} from "./pairwise.js";

// ============================================================================
// Phase Executor
// ============================================================================

import { randomUUID } from "crypto";
import type { ILLMClient } from "../../../types.js";
import type { PhaseContext, PhaseResult } from "../../pipeline/orchestrator.js";
import { selectJudges } from "../base.js";
import { createPointwiseJudgeEvaluator } from "./pointwise.js";
import { createPairwiseJudgeEvaluator, aggregateTournamentResults } from "./pairwise.js";
import type { EvaluationResult, PairwiseResult, JudgeResults } from "../../types.js";

/**
 * Create the judge evaluation phase executor
 */
export function createJudgePhaseExecutor(
	judgeClients: Map<string, ILLMClient>
): (context: PhaseContext) => Promise<PhaseResult> {
	return async (context: PhaseContext): Promise<PhaseResult> => {
		const { db, run, config, stateMachine } = context;
		const evalConfig = config.evaluation.judge;

		if (!evalConfig.enabled) {
			return { success: true, itemsProcessed: 0 };
		}

		try {
			// Get summaries and code units
			const summaries = db.getSummaries(run.id);
			const codeUnits = db.getCodeUnits(run.id);
			const codeUnitMap = new Map(codeUnits.map((u) => [u.id, u]));

			// Calculate total work per judge
			const summariesPerJudge = summaries.length;
			const totalPairwise = evalConfig.usePairwise
				? (config.generators.length * (config.generators.length - 1) / 2) *
				  codeUnits.length *
				  evalConfig.judgeModels.length
				: 0;
			const totalItems = summariesPerJudge * evalConfig.judgeModels.length + totalPairwise;

			stateMachine.startPhase("evaluation:judge", totalItems);

			const concurrency = 30; // Process 30 summaries concurrently per judge
			const DEFAULT_TIMEOUT_MS = 60_000; // 60 second timeout per request
			const CC_TIMEOUT_MS = 180_000; // 180 seconds for Claude Code (subprocess overhead + Opus thinking)

			// Get timeout based on provider (cc/ models need more time)
			const getTimeoutForModel = (modelId: string): number => {
				return modelId.startsWith("cc/") ? CC_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
			};

			// Timeout wrapper
			const withTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
				return Promise.race([
					promise,
					new Promise<T>((_, reject) =>
						setTimeout(() => reject(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs)
					),
				]);
			};

			// Track failures for reporting (don't print during progress bar)
			const failures: Array<{ model: string; count: number; error: string }> = [];

			// Pointwise evaluation - process all judges in parallel
			const judgePromises = evalConfig.judgeModels.map(async (judgeModelId) => {
				const client = judgeClients.get(judgeModelId);
				if (!client) return { judgeModelId, completed: 0, failures: 0, lastError: "" };

				const evaluator = createPointwiseJudgeEvaluator(client, judgeModelId);

				// Track progress for this judge
				let judgeCompleted = 0;
				let judgeFailures = 0;
				let lastError = "";
				const inProgress = new Set<string>();

				const processSummary = async (summary: typeof summaries[0]): Promise<void> => {
					const codeUnit = codeUnitMap.get(summary.codeUnitId);
					if (!codeUnit) return;

					// Check if model can judge (not same family)
					const eligible = selectJudges(summary.modelId, [judgeModelId], 1);
					if (eligible.length === 0) return;

					inProgress.add(summary.id);

					// Report progress with inProgress count
					stateMachine.updateProgress(
						"evaluation:judge",
						judgeCompleted,
						summary.id,
						`${judgeModelId}: ${judgeCompleted}/${summariesPerJudge}/${inProgress.size}`
					);

					try {
						const result = await withTimeout(
							evaluator.evaluate(summary, codeUnit, {}),
							getTimeoutForModel(judgeModelId)
						);
						db.insertEvaluationResult(run.id, result);
					} catch (error) {
						// Track error silently (don't print during progress bar)
						judgeFailures++;
						lastError = String(error);
					}

					inProgress.delete(summary.id);
					judgeCompleted++;

					// Report completion
					stateMachine.updateProgress(
						"evaluation:judge",
						judgeCompleted,
						summary.id,
						`${judgeModelId}: ${judgeCompleted}/${summariesPerJudge}/${inProgress.size}`
					);
				};

				// Initial progress
				stateMachine.updateProgress(
					"evaluation:judge",
					0,
					undefined,
					`${judgeModelId}: 0/${summariesPerJudge}/0`
				);

				// Process in concurrent batches with allSettled (don't block on failures)
				for (let i = 0; i < summaries.length; i += concurrency) {
					const batch = summaries.slice(i, i + concurrency);
					await Promise.allSettled(batch.map(processSummary));
				}

				return { judgeModelId, completed: judgeCompleted, failures: judgeFailures, lastError };
			});

			const judgeResults = await Promise.all(judgePromises);
			let completed = judgeResults.reduce((sum, r) => sum + r.completed, 0);

			// Collect pointwise failures for reporting
			for (const r of judgeResults) {
				if (r.failures > 0) {
					failures.push({ model: r.judgeModelId, count: r.failures, error: r.lastError });
				}
			}

			// Pairwise evaluation - run judges in parallel
			if (evalConfig.usePairwise) {
				const allPairwiseResults: PairwiseResult[] = [];

				// Hard cap: max 600 comparisons per judge (300 pairs × 2 orderings)
				// This prevents excessive API calls when there's a lot of data
				const MAX_COMPARISONS_PER_JUDGE = 600;
				const MAX_PAIRS_PER_JUDGE = MAX_COMPARISONS_PER_JUDGE / 2; // Each pair = 2 comparisons (A vs B, B vs A)

				// Calculate total possible comparisons
				const numModels = config.generators.length;
				const pairsPerUnit = (numModels * (numModels - 1)) / 2;
				const comparisonsPerUnit = pairsPerUnit * 2; // Both orderings
				const totalPossibleComparisons = comparisonsPerUnit * codeUnits.length;

				// Build all possible (codeUnit, modelPair) combinations grouped by model pair
				// This allows us to sample evenly across model pairs
				type ModelPair = { modelA: string; modelB: string };
				type ComparisonTask = { codeUnit: typeof codeUnits[0]; summaries: typeof summaries };
				const comparisonsByPair = new Map<string, { pair: ModelPair; tasks: ComparisonTask[] }>();

				// Get unique model pairs
				const modelIds = config.generators.map(g => g.id);
				for (let i = 0; i < modelIds.length; i++) {
					for (let j = i + 1; j < modelIds.length; j++) {
						const pairKey = `${modelIds[i]}::${modelIds[j]}`;
						comparisonsByPair.set(pairKey, {
							pair: { modelA: modelIds[i], modelB: modelIds[j] },
							tasks: []
						});
					}
				}

				// Populate tasks for each model pair
				for (const codeUnit of codeUnits) {
					const unitSummaries = summaries.filter((s) => s.codeUnitId === codeUnit.id);
					if (unitSummaries.length < 2) continue;

					// For each model pair, if both models have summaries for this unit, add a task
					for (const [pairKey, pairData] of comparisonsByPair) {
						const summaryA = unitSummaries.find(s => s.modelId === pairData.pair.modelA);
						const summaryB = unitSummaries.find(s => s.modelId === pairData.pair.modelB);
						if (summaryA && summaryB) {
							pairData.tasks.push({ codeUnit, summaries: [summaryA, summaryB] });
						}
					}
				}

				// Sample evenly across model pairs if we exceed the cap
				const numPairs = comparisonsByPair.size;
				const tasksPerPair = Math.ceil(MAX_PAIRS_PER_JUDGE / numPairs);

				// Collect sampled tasks
				const sampledTasks: ComparisonTask[] = [];
				for (const [_, pairData] of comparisonsByPair) {
					const tasks = pairData.tasks;
					if (tasks.length <= tasksPerPair) {
						// Use all tasks for this pair
						sampledTasks.push(...tasks);
					} else {
						// Sample evenly from this pair's tasks
						const step = tasks.length / tasksPerPair;
						for (let i = 0; i < tasksPerPair; i++) {
							const idx = Math.floor(i * step);
							sampledTasks.push(tasks[idx]);
						}
					}
				}

				// Calculate actual total comparisons after sampling
				const totalComparisons = Math.min(sampledTasks.length * 2, MAX_COMPARISONS_PER_JUDGE);

				const pairwisePromises = evalConfig.judgeModels.map(async (judgeModelId) => {
					const client = judgeClients.get(judgeModelId);
					if (!client) return { results: [] as PairwiseResult[], failures: 0, lastError: "" };

					const evaluator = createPairwiseJudgeEvaluator(client, judgeModelId);
					const results: PairwiseResult[] = [];
					let pairwiseFailures = 0;
					let lastError = "";

					let totalCompleted = 0;

					// Process sampled tasks
					for (const task of sampledTasks) {
						try {
							const pairResults = await evaluator.comparePairs(
								task.codeUnit,
								task.summaries,
								(compCompleted, compTotal, compInProgress) => {
									// Report progress at comparison level
									stateMachine.updateProgress(
										"evaluation:judge",
										totalCompleted + compCompleted,
										task.codeUnit.id,
										`pairwise:${judgeModelId}: ${totalCompleted + compCompleted}/${totalComparisons}/${compInProgress}`
									);
								}
							);
							results.push(...pairResults);
							totalCompleted += 2; // Each task = 2 comparisons (both orderings)
						} catch (error) {
							// Track error silently (don't print during progress bar)
							pairwiseFailures++;
							lastError = String(error);
							totalCompleted += 2; // Still advance progress
						}
					}

					return { results, failures: pairwiseFailures, lastError };
				});

				const pairwiseResultArrays = await Promise.all(pairwisePromises);
				for (let i = 0; i < pairwiseResultArrays.length; i++) {
					const { results, failures: pairFailures, lastError } = pairwiseResultArrays[i];
					allPairwiseResults.push(...results);
					if (pairFailures > 0) {
						const judgeId = evalConfig.judgeModels[i];
						failures.push({ model: `${judgeId} (pairwise)`, count: pairFailures, error: lastError });
					}
				}
				completed += allPairwiseResults.length;

				// Save pairwise results
				db.insertPairwiseResults(run.id, allPairwiseResults);

				// Aggregate tournament scores
				const tournamentScores = aggregateTournamentResults(
					allPairwiseResults,
					config.generators.map((g) => g.id)
				);

				// Update summaries with pairwise scores
				for (const [modelId, score] of tournamentScores) {
					const modelSummaries = summaries.filter((s) => s.modelId === modelId);
					for (const summary of modelSummaries) {
						const existingResults = db.getEvaluationResults(run.id, "judge");
						const existingResult = existingResults.find((r) => r.summaryId === summary.id);

						if (existingResult?.judgeResults) {
							existingResult.judgeResults.pairwiseWins = score.wins;
							existingResult.judgeResults.pairwiseLosses = score.losses;
							existingResult.judgeResults.pairwiseTies = score.ties;
						}
					}
				}
			}

			return {
				success: true,
				itemsProcessed: completed,
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
