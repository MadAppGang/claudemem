/**
 * Detailed Reporter
 *
 * Produces a comprehensive markdown report with examples,
 * per-test-case breakdowns, and analysis.
 */

import type { BenchmarkResults, GeneratorResults, IReporter, ReportFormat, TestCaseResult } from "../types.js";

// ============================================================================
// Detailed Reporter Implementation
// ============================================================================

export class DetailedReporter implements IReporter {
	async report(results: BenchmarkResults): Promise<string> {
		const lines: string[] = [];

		// Title
		lines.push("# LLM Benchmark Report");
		lines.push("");
		lines.push(`Generated: ${results.metadata.timestamp}`);
		lines.push("");

		// Executive Summary
		lines.push("## Executive Summary");
		lines.push("");
		lines.push(this.formatExecutiveSummary(results));
		lines.push("");

		// Methodology
		lines.push("## Methodology");
		lines.push("");
		lines.push(`- **Project**: ${results.metadata.projectPath}`);
		lines.push(`- **Test Cases**: ${results.metadata.totalTestCases} total`);
		lines.push(`  - File summaries: ${results.metadata.testCaseTypes.file_summary}`);
		lines.push(`  - Symbol summaries: ${results.metadata.testCaseTypes.symbol_summary}`);
		lines.push(`- **Judges**: ${results.metadata.judges.length > 0 ? results.metadata.judges.join(", ") : "None (AST validation only)"}`);
		lines.push("");
		lines.push("### Scoring Weights");
		lines.push("");
		lines.push("| Criterion | Weight | Description |");
		lines.push("|-----------|--------|-------------|");
		lines.push(`| Correctness | ${Math.round(results.metadata.weights.correctness * 100)}% | AST validation - params, exports match |`);
		lines.push(`| Completeness | ${Math.round(results.metadata.weights.completeness * 100)}% | All important elements documented |`);
		lines.push(`| Usefulness | ${Math.round(results.metadata.weights.usefulness * 100)}% | Helps understand the code (LLM judge) |`);
		lines.push(`| Conciseness | ${Math.round(results.metadata.weights.conciseness * 100)}% | Information-dense, no fluff (LLM judge) |`);
		lines.push(`| Speed | ${Math.round(results.metadata.weights.speed * 100)}% | Generation speed (fastest = 100) |`);
		lines.push(`| Cost | ${Math.round(results.metadata.weights.cost * 100)}% | Cost efficiency (cheapest = 100) |`);
		lines.push("");

		// Results Table
		lines.push("## Results");
		lines.push("");
		lines.push(this.formatResultsTable(results));
		lines.push("");

		// Per-Model Analysis
		lines.push("## Per-Model Analysis");
		lines.push("");

		for (const gen of results.generators) {
			lines.push(this.formatModelAnalysis(gen));
			lines.push("");
		}

		// Example Comparisons
		if (results.generators.length > 1) {
			lines.push("## Example Comparisons");
			lines.push("");
			lines.push(this.formatExampleComparisons(results));
		}

		// Recommendations
		lines.push("## Recommendations");
		lines.push("");
		lines.push(this.formatRecommendations(results));

		return lines.join("\n");
	}

	getFormat(): ReportFormat {
		return "detailed";
	}

	/**
	 * Format executive summary.
	 */
	private formatExecutiveSummary(results: BenchmarkResults): string {
		const sorted = [...results.generators].sort(
			(a, b) => b.scores.overall - a.scores.overall
		);
		const best = sorted[0];
		const worst = sorted[sorted.length - 1];

		const lines: string[] = [];
		lines.push(`**Winner**: ${best.info.displayName} with ${best.scores.overall}% overall score`);
		lines.push("");
		lines.push(`Tested ${results.generators.length} models on ${results.metadata.totalTestCases} test cases.`);
		lines.push("");

		if (best.scores.overall - worst.scores.overall > 10) {
			lines.push(`Significant difference between best (${best.scores.overall}%) and worst (${worst.scores.overall}%) performers.`);
		} else {
			lines.push(`Models performed relatively similarly (${worst.scores.overall}%-${best.scores.overall}% range).`);
		}

		return lines.join("\n");
	}

	/**
	 * Format results table in markdown.
	 */
	private formatResultsTable(results: BenchmarkResults): string {
		const lines: string[] = [];

		lines.push("| Model | Overall | Correct | Complete | Useful | Concise | Speed | Cost | Avg Time | Total Cost |");
		lines.push("|-------|---------|---------|----------|--------|---------|-------|------|----------|------------|");

		for (const gen of results.generators) {
			const s = gen.scores;
			const m = gen.metrics;
			lines.push(
				`| ${gen.info.displayName} | **${s.overall}%** | ${s.correctness}% | ${s.completeness}% | ${s.usefulness}% | ${s.conciseness}% | ${s.speed}% | ${s.cost}% | ${this.formatDuration(m.avgDurationMs)} | ${this.formatCost(m.totalCost)} |`
			);
		}

		return lines.join("\n");
	}

	/**
	 * Format per-model analysis.
	 */
	private formatModelAnalysis(gen: GeneratorResults): string {
		const lines: string[] = [];

		lines.push(`### ${gen.info.displayName}`);
		lines.push("");
		lines.push(`**Provider**: ${gen.info.provider}`);
		lines.push(`**Model**: ${gen.info.model}`);
		lines.push("");

		// Scores
		lines.push("#### Scores");
		lines.push("");
		const s = gen.scores;
		lines.push(`- Overall: **${s.overall}%**`);
		lines.push(`- Correctness: ${s.correctness}% (AST validation)`);
		lines.push(`- Completeness: ${s.completeness}% (field coverage)`);
		lines.push(`- Usefulness: ${s.usefulness}% (LLM judge)`);
		lines.push(`- Conciseness: ${s.conciseness}% (LLM judge)`);
		lines.push(`- Speed: ${s.speed}% (normalized)`);
		lines.push(`- Cost: ${s.cost}% (normalized)`);
		lines.push("");

		// Metrics
		lines.push("#### Performance");
		lines.push("");
		const m = gen.metrics;
		lines.push(`- Average generation time: ${this.formatDuration(m.avgDurationMs)}`);
		lines.push(`- Total cost: ${this.formatCost(m.totalCost)}`);
		lines.push(`- Total tokens: ${m.totalTokens.toLocaleString()}`);
		lines.push(`- Success rate: ${Math.round(m.successRate * 100)}% (${m.failures} failures)`);
		lines.push("");

		// Score distribution
		const distribution = this.getScoreDistribution(gen.testCaseResults);
		lines.push("#### Score Distribution");
		lines.push("");
		lines.push("| Range | Count | % |");
		lines.push("|-------|-------|---|");
		for (const [range, count] of Object.entries(distribution)) {
			const pct = Math.round((count / gen.testCaseResults.length) * 100);
			lines.push(`| ${range} | ${count} | ${pct}% |`);
		}

		return lines.join("\n");
	}

	/**
	 * Format example comparisons between models.
	 */
	private formatExampleComparisons(results: BenchmarkResults): string {
		const lines: string[] = [];

		// Find a test case where models differ significantly
		const firstGen = results.generators[0];
		const secondGen = results.generators[1];

		if (!firstGen || !secondGen) {
			return "Not enough models for comparison.";
		}

		// Find most different test case
		let maxDiff = 0;
		let diffTestCaseId = "";

		for (const tcr of firstGen.testCaseResults) {
			const otherTcr = secondGen.testCaseResults.find(
				(t) => t.testCase.id === tcr.testCase.id
			);
			if (otherTcr) {
				const diff = Math.abs(tcr.overallScore - otherTcr.overallScore);
				if (diff > maxDiff) {
					maxDiff = diff;
					diffTestCaseId = tcr.testCase.id;
				}
			}
		}

		if (!diffTestCaseId) {
			return "No significant differences found between models.";
		}

		const tcr1 = firstGen.testCaseResults.find((t) => t.testCase.id === diffTestCaseId)!;
		const tcr2 = secondGen.testCaseResults.find((t) => t.testCase.id === diffTestCaseId)!;

		lines.push(`### Comparison: ${tcr1.testCase.type === "file_summary" ? "File" : "Symbol"} Summary`);
		lines.push("");
		lines.push(`**Test Case**: ${tcr1.testCase.filePath}`);
		lines.push(`**Score Difference**: ${maxDiff} points`);
		lines.push("");

		lines.push(`#### ${firstGen.info.displayName} (Score: ${tcr1.overallScore}%)`);
		lines.push("");
		lines.push("```");
		lines.push(this.formatSummary(tcr1.generation.result));
		lines.push("```");
		lines.push("");

		lines.push(`#### ${secondGen.info.displayName} (Score: ${tcr2.overallScore}%)`);
		lines.push("");
		lines.push("```");
		lines.push(this.formatSummary(tcr2.generation.result));
		lines.push("```");

		return lines.join("\n");
	}

	/**
	 * Format recommendations based on results.
	 */
	private formatRecommendations(results: BenchmarkResults): string {
		const lines: string[] = [];
		const sorted = [...results.generators].sort(
			(a, b) => b.scores.overall - a.scores.overall
		);

		const best = sorted[0];
		const cheapest = sorted.reduce((a, b) =>
			a.metrics.totalCost < b.metrics.totalCost ? a : b
		);
		const fastest = sorted.reduce((a, b) =>
			a.metrics.avgDurationMs < b.metrics.avgDurationMs ? a : b
		);

		lines.push(`### Best Overall: ${best.info.displayName}`);
		lines.push("");
		lines.push(`With ${best.scores.overall}% overall score, this model provides the best balance of quality and performance.`);
		lines.push("");

		if (cheapest !== best) {
			lines.push(`### Best Value: ${cheapest.info.displayName}`);
			lines.push("");
			lines.push(
				`At ${this.formatCost(cheapest.metrics.totalCost)} total cost with ${cheapest.scores.overall}% score, this is the most cost-effective option.`
			);
			lines.push("");
		}

		if (fastest !== best && fastest !== cheapest) {
			lines.push(`### Fastest: ${fastest.info.displayName}`);
			lines.push("");
			lines.push(
				`With ${this.formatDuration(fastest.metrics.avgDurationMs)} average generation time, this is best for time-sensitive workloads.`
			);
			lines.push("");
		}

		// Use case recommendations
		lines.push("### Use Case Recommendations");
		lines.push("");
		lines.push(`- **Production (quality focus)**: ${best.info.displayName}`);
		lines.push(`- **Development (cost focus)**: ${cheapest.info.displayName}`);
		lines.push(`- **CI/CD (speed focus)**: ${fastest.info.displayName}`);

		return lines.join("\n");
	}

	/**
	 * Get score distribution buckets.
	 */
	private getScoreDistribution(results: TestCaseResult[]): Record<string, number> {
		const buckets: Record<string, number> = {
			"90-100": 0,
			"80-89": 0,
			"70-79": 0,
			"60-69": 0,
			"50-59": 0,
			"0-49": 0,
		};

		for (const r of results) {
			const score = r.overallScore;
			if (score >= 90) buckets["90-100"]++;
			else if (score >= 80) buckets["80-89"]++;
			else if (score >= 70) buckets["70-79"]++;
			else if (score >= 60) buckets["60-69"]++;
			else if (score >= 50) buckets["50-59"]++;
			else buckets["0-49"]++;
		}

		return buckets;
	}

	/**
	 * Format a summary for display.
	 */
	private formatSummary(summary: any): string {
		if ("symbolName" in summary) {
			return `Symbol: ${summary.symbolName}\nSummary: ${summary.summary}\nParameters: ${summary.parameters?.map((p: any) => p.name).join(", ") || "none"}`;
		}
		return `File Summary: ${summary.summary}\nExports: ${summary.exports?.join(", ") || "none"}`;
	}

	/**
	 * Format duration.
	 */
	private formatDuration(ms: number): string {
		if (ms < 1000) return `${Math.round(ms)}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	/**
	 * Format cost.
	 */
	private formatCost(cost: number): string {
		if (cost === 0) return "FREE";
		if (cost < 0.01) return `$${cost.toFixed(4)}`;
		return `$${cost.toFixed(3)}`;
	}
}
