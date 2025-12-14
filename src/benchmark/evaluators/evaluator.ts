/**
 * Benchmark Evaluator
 *
 * Main orchestrator for the LLM benchmark.
 * Coordinates generators, judges, and scorers to produce benchmark results.
 */

import type { FileSummary, SymbolSummary } from "../../types.js";
import type {
	AggregateScores,
	BenchmarkConfig,
	BenchmarkMetadata,
	BenchmarkPhase,
	BenchmarkResults,
	GenerationResult,
	GeneratorResults,
	IJudge,
	ISummaryGenerator,
	JudgmentResult,
	PerformanceMetrics,
	Rankings,
	TestCase,
	TestCaseResult,
} from "../types.js";
import { DEFAULT_WEIGHTS } from "../types.js";
import { createGenerator, parseGeneratorSpec } from "../generators/index.js";
import { parseAndCreateJudge } from "../judges/index.js";
import { createCompositeScorer, CompositeScorer } from "../scorers/index.js";
import { createTestCaseSelector } from "./test-case-selector.js";

// ============================================================================
// Benchmark Evaluator
// ============================================================================

export class BenchmarkEvaluator {
	private config: BenchmarkConfig;
	private generators: ISummaryGenerator[] = [];
	private judge: IJudge | null = null;
	private testCases: TestCase[] = [];

	constructor(config: BenchmarkConfig) {
		this.config = config;
	}

	/**
	 * Run the complete benchmark.
	 */
	async run(): Promise<BenchmarkResults> {
		const startTime = Date.now();

		// Phase 1: Prepare
		this.reportProgress("preparing", 0, 4, "Initializing generators...");
		await this.initializeGenerators();

		this.reportProgress("preparing", 1, 4, "Initializing judges...");
		await this.initializeJudges();

		this.reportProgress("preparing", 2, 4, "Selecting test cases...");
		await this.selectTestCases();

		this.reportProgress("preparing", 3, 4, "Ready to benchmark");

		// Phase 2: Generate summaries with each model
		const allGenerations = new Map<string, Map<string, GenerationResult<FileSummary | SymbolSummary>>>();

		for (let i = 0; i < this.generators.length; i++) {
			const generator = this.generators[i];
			const generatorId = generator.getInfo().model;

			this.reportProgress(
				"generating",
				i,
				this.generators.length,
				`Running ${generator.getInfo().displayName}...`
			);

			const generations = await this.runGenerator(generator);
			allGenerations.set(generatorId, generations);
		}

		// Phase 3: Judge all generations
		const allJudgments = new Map<string, Map<string, JudgmentResult>>();

		if (this.judge) {
			let totalJudgments = this.generators.length * this.testCases.length;
			let completedJudgments = 0;

			for (const [generatorId, generations] of allGenerations) {
				const judgments = new Map<string, JudgmentResult>();

				for (const [testCaseId, generation] of generations) {
					this.reportProgress(
						"judging",
						completedJudgments,
						totalJudgments,
						`Judging ${generatorId}...`
					);

					const testCase = this.testCases.find((tc) => tc.id === testCaseId)!;
					const judgment = await this.judgeGeneration(generation, testCase);
					judgments.set(testCaseId, judgment);
					completedJudgments++;
				}

				allJudgments.set(generatorId, judgments);
			}
		}

		// Phase 4: Score all results
		this.reportProgress("scoring", 0, this.generators.length, "Calculating scores...");

		const generatorResults: GeneratorResults[] = [];

		// Collect all durations and costs for normalization
		const allDurations: number[] = [];
		const allCosts: number[] = [];

		for (const generations of allGenerations.values()) {
			for (const gen of generations.values()) {
				allDurations.push(gen.durationMs);
				allCosts.push(gen.usage.cost);
			}
		}

		// Create composite scorer with normalization data
		const weights = this.config.weights || DEFAULT_WEIGHTS;
		const compositeScorer = createCompositeScorer(allDurations, allCosts, weights);

		for (let i = 0; i < this.generators.length; i++) {
			const generator = this.generators[i];
			const generatorId = generator.getInfo().model;

			this.reportProgress(
				"scoring",
				i,
				this.generators.length,
				`Scoring ${generator.getInfo().displayName}...`
			);

			const generations = allGenerations.get(generatorId)!;
			const judgments = allJudgments.get(generatorId);

			const result = await this.scoreGenerator(
				generator,
				generations,
				judgments,
				compositeScorer
			);

			generatorResults.push(result);
		}

		// Phase 5: Compile results
		this.reportProgress("reporting", 0, 1, "Compiling results...");

		const rankings = this.calculateRankings(generatorResults);
		const metadata = this.createMetadata(startTime);

		return {
			metadata,
			generators: generatorResults,
			rankings,
		};
	}

	/**
	 * Initialize generators from config.
	 */
	private async initializeGenerators(): Promise<void> {
		this.generators = [];

		for (const genInfo of this.config.generators) {
			const generator = await createGenerator(
				genInfo.provider,
				genInfo.model,
				genInfo.displayName
			);
			this.generators.push(generator);
		}
	}

	/**
	 * Initialize judges from config.
	 */
	private async initializeJudges(): Promise<void> {
		if (this.config.judges.length === 0) {
			this.judge = null;
			return;
		}

		if (this.config.judges.length === 1) {
			this.judge = await parseAndCreateJudge(this.config.judges[0]);
		} else {
			// Multiple judges = consensus
			const judgeSpec = `consensus:median:${this.config.judges.join(",")}`;
			this.judge = await parseAndCreateJudge(judgeSpec);
		}
	}

	/**
	 * Select test cases from the project.
	 */
	private async selectTestCases(): Promise<void> {
		const selector = createTestCaseSelector(this.config.projectPath);
		this.testCases = await selector.selectTestCases({
			maxTestCases: this.config.testCaseCount,
			types: this.config.testCaseTypes,
			diverseSizes: true,
		});

		if (this.testCases.length === 0) {
			throw new Error("No test cases selected. Check that the project is indexed.");
		}
	}

	/**
	 * Run a generator on all test cases.
	 */
	private async runGenerator(
		generator: ISummaryGenerator
	): Promise<Map<string, GenerationResult<FileSummary | SymbolSummary>>> {
		const results = new Map<string, GenerationResult<FileSummary | SymbolSummary>>();
		generator.resetUsage();

		for (const testCase of this.testCases) {
			try {
				let result: GenerationResult<FileSummary | SymbolSummary>;

				if (testCase.type === "file_summary") {
					result = await generator.generateFileSummary(
						testCase.filePath,
						testCase.fileContent,
						testCase.language,
						testCase.codeChunks || []
					);
				} else {
					result = await generator.generateSymbolSummary(
						testCase.codeChunk!,
						testCase.fileContent,
						testCase.language
					);
				}

				results.set(testCase.id, result);
			} catch (error) {
				// Create a failed result
				console.warn(
					`Generation failed for ${testCase.id}: ${
						error instanceof Error ? error.message : error
					}`
				);
			}
		}

		return results;
	}

	/**
	 * Judge a single generation.
	 */
	private async judgeGeneration(
		generation: GenerationResult<FileSummary | SymbolSummary>,
		testCase: TestCase
	): Promise<JudgmentResult> {
		if (!this.judge) {
			return {
				usefulness: 50,
				conciseness: 50,
				clarity: 50,
				qualityScore: 50,
				judgedBy: "no judge",
				durationMs: 0,
			};
		}

		return this.judge.judge(generation.result, {
			filePath: testCase.filePath,
			fileContent: testCase.fileContent,
			language: testCase.language,
			codeChunk: testCase.codeChunk,
		});
	}

	/**
	 * Score a generator's results.
	 */
	private async scoreGenerator(
		generator: ISummaryGenerator,
		generations: Map<string, GenerationResult<FileSummary | SymbolSummary>>,
		judgments: Map<string, JudgmentResult> | undefined,
		compositeScorer: CompositeScorer
	): Promise<GeneratorResults> {
		const testCaseResults: TestCaseResult[] = [];
		let totalDuration = 0;
		let totalCost = 0;
		let totalTokens = 0;
		let failures = 0;

		for (const testCase of this.testCases) {
			const generation = generations.get(testCase.id);
			const judgment = judgments?.get(testCase.id);

			if (!generation) {
				failures++;
				continue;
			}

			// Score this test case
			const { overall, components } = await compositeScorer.scoreDetailed(
				testCase,
				generation,
				judgment
			);

			testCaseResults.push({
				testCase,
				generation,
				judgment,
				scores: components,
				overallScore: overall,
			});

			totalDuration += generation.durationMs;
			totalCost += generation.usage.cost;
			totalTokens += generation.usage.inputTokens + generation.usage.outputTokens;
		}

		// Calculate aggregate scores
		const scores = this.calculateAggregateScores(testCaseResults);

		// Calculate metrics
		const metrics: PerformanceMetrics = {
			avgDurationMs: testCaseResults.length > 0
				? totalDuration / testCaseResults.length
				: 0,
			totalCost,
			totalTokens,
			successRate: testCaseResults.length / this.testCases.length,
			failures,
		};

		return {
			info: generator.getInfo(),
			scores,
			metrics,
			testCaseResults,
		};
	}

	/**
	 * Calculate aggregate scores from test case results.
	 */
	private calculateAggregateScores(results: TestCaseResult[]): AggregateScores {
		if (results.length === 0) {
			return {
				overall: 0,
				correctness: 0,
				completeness: 0,
				usefulness: 0,
				conciseness: 0,
				speed: 0,
				cost: 0,
			};
		}

		const avg = (values: number[]) =>
			values.length > 0
				? Math.round(values.reduce((a, b) => a + b, 0) / values.length)
				: 0;

		const getScoresByCriterion = (criterion: string): number[] =>
			results
				.flatMap((r) => r.scores)
				.filter((s) => s.criterion === criterion)
				.map((s) => s.score);

		return {
			overall: avg(results.map((r) => r.overallScore)),
			correctness: avg(getScoresByCriterion("correctness")),
			completeness: avg(getScoresByCriterion("completeness")),
			usefulness: avg(getScoresByCriterion("usefulness")),
			conciseness: avg(getScoresByCriterion("conciseness")),
			speed: avg(getScoresByCriterion("speed")),
			cost: avg(getScoresByCriterion("cost")),
		};
	}

	/**
	 * Calculate rankings from generator results.
	 */
	private calculateRankings(results: GeneratorResults[]): Rankings {
		const sortBy = (key: keyof AggregateScores) =>
			[...results]
				.sort((a, b) => b.scores[key] - a.scores[key])
				.map((r) => r.info.model);

		return {
			byOverallScore: sortBy("overall"),
			byCorrectness: sortBy("correctness"),
			bySpeed: sortBy("speed"),
			byCost: sortBy("cost"),
		};
	}

	/**
	 * Create benchmark metadata.
	 */
	private createMetadata(startTime: number): BenchmarkMetadata {
		const typeCounts: Record<string, number> = {
			file_summary: 0,
			symbol_summary: 0,
		};

		for (const tc of this.testCases) {
			typeCounts[tc.type]++;
		}

		return {
			projectPath: this.config.projectPath,
			timestamp: new Date().toISOString(),
			totalTestCases: this.testCases.length,
			testCaseTypes: typeCounts as Record<"file_summary" | "symbol_summary", number>,
			judges: this.config.judges,
			weights: this.config.weights || DEFAULT_WEIGHTS,
		};
	}

	/**
	 * Report progress via callback.
	 */
	private reportProgress(
		phase: BenchmarkPhase,
		completed: number,
		total: number,
		details?: string
	): void {
		this.config.onProgress?.(phase, completed, total, details);
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create and run a benchmark.
 */
export async function runBenchmark(config: BenchmarkConfig): Promise<BenchmarkResults> {
	const evaluator = new BenchmarkEvaluator(config);
	return evaluator.run();
}
