/**
 * CLI Table Reporter
 *
 * Formats benchmark results as a pretty CLI table.
 * Similar to the existing embedding benchmark output.
 */

import type { BenchmarkResults, GeneratorResults, IReporter, ReportFormat } from "../types.js";

// ============================================================================
// Colors
// ============================================================================

const c = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",
	green: "\x1b[38;5;78m",
	yellow: "\x1b[33m",
	red: "\x1b[31m",
	cyan: "\x1b[36m",
	orange: "\x1b[38;5;209m",
};

// ============================================================================
// CLI Reporter Implementation
// ============================================================================

export class CLIReporter implements IReporter {
	private useColors: boolean;

	constructor(useColors = true) {
		this.useColors = useColors;
	}

	async report(results: BenchmarkResults): Promise<string> {
		const lines: string[] = [];

		// Header
		lines.push("");
		lines.push(this.color(`${c.orange}${c.bold}🏁 LLM BENCHMARK RESULTS${c.reset}`));
		lines.push("");

		// Metadata
		lines.push(this.color(`${c.dim}Project: ${results.metadata.projectPath}${c.reset}`));
		lines.push(this.color(`${c.dim}Test cases: ${results.metadata.totalTestCases} (${results.metadata.testCaseTypes.file_summary} files, ${results.metadata.testCaseTypes.symbol_summary} symbols)${c.reset}`));
		lines.push(this.color(`${c.dim}Judges: ${results.metadata.judges.length > 0 ? results.metadata.judges.join(", ") : "none"}${c.reset}`));
		lines.push("");

		// Results table
		lines.push(this.formatResultsTable(results));

		// Rankings
		lines.push("");
		lines.push(this.color(`${c.bold}Rankings:${c.reset}`));
		lines.push(this.color(`  ${c.cyan}Overall:${c.reset} ${this.formatRanking(results.rankings.byOverallScore)}`));
		lines.push(this.color(`  ${c.cyan}Correctness:${c.reset} ${this.formatRanking(results.rankings.byCorrectness)}`));
		lines.push(this.color(`  ${c.cyan}Speed:${c.reset} ${this.formatRanking(results.rankings.bySpeed)}`));
		lines.push(this.color(`  ${c.cyan}Cost:${c.reset} ${this.formatRanking(results.rankings.byCost)}`));

		// Weights legend
		lines.push("");
		lines.push(this.formatWeightsLegend(results.metadata.weights));

		return lines.join("\n");
	}

	getFormat(): ReportFormat {
		return "cli";
	}

	/**
	 * Format the main results table.
	 */
	private formatResultsTable(results: BenchmarkResults): string {
		const lines: string[] = [];

		// Header row
		const headers = ["Model", "Overall", "Correct", "Complete", "Useful", "Concise", "Speed", "Cost", "Time", "$$"];
		const widths = [28, 7, 7, 8, 6, 7, 5, 4, 8, 10];

		const headerRow = headers.map((h, i) => h.padEnd(widths[i])).join(" ");
		lines.push(this.color(`  ${c.bold}${headerRow}${c.reset}`));
		lines.push("  " + "─".repeat(headerRow.length));

		// Find best/worst for highlighting
		const overall = results.generators.map((g) => g.scores.overall);
		const maxOverall = Math.max(...overall);
		const minOverall = Math.min(...overall);

		// Data rows
		for (const gen of results.generators) {
			const row = this.formatGeneratorRow(gen, widths, maxOverall, minOverall);
			lines.push("  " + row);
		}

		return lines.join("\n");
	}

	/**
	 * Format a single generator row.
	 */
	private formatGeneratorRow(
		gen: GeneratorResults,
		widths: number[],
		maxOverall: number,
		minOverall: number
	): string {
		const scores = gen.scores;
		const metrics = gen.metrics;

		// Truncate model name
		const modelName = this.truncate(gen.info.displayName, widths[0] - 2);

		// Format scores with color coding
		const formatScore = (score: number, isBest = false, isWorst = false) => {
			const str = `${score}%`;
			if (isBest && this.useColors) return `${c.green}${str}${c.reset}`;
			if (isWorst && score < 50 && this.useColors) return `${c.red}${str}${c.reset}`;
			return str;
		};

		const overallBest = scores.overall === maxOverall;
		const overallWorst = scores.overall === minOverall && maxOverall !== minOverall;

		const values = [
			modelName,
			formatScore(scores.overall, overallBest, overallWorst),
			`${scores.correctness}%`,
			`${scores.completeness}%`,
			`${scores.usefulness}%`,
			`${scores.conciseness}%`,
			`${scores.speed}%`,
			`${scores.cost}%`,
			this.formatDuration(metrics.avgDurationMs),
			this.formatCost(metrics.totalCost),
		];

		return values.map((v, i) => {
			// Strip ANSI codes for padding calculation
			const stripped = v.replace(/\x1b\[[0-9;]*m/g, "");
			const padding = widths[i] - stripped.length;
			return v + " ".repeat(Math.max(0, padding));
		}).join(" ");
	}

	/**
	 * Format ranking list.
	 */
	private formatRanking(ranking: string[]): string {
		return ranking.map((model, i) => {
			const prefix = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `${i + 1}.`;
			const shortModel = this.truncate(model.split("/").pop() || model, 15);
			return `${prefix} ${shortModel}`;
		}).join("  ");
	}

	/**
	 * Format weights legend.
	 */
	private formatWeightsLegend(weights: Record<string, number>): string {
		const parts = Object.entries(weights)
			.map(([k, v]) => `${k}: ${Math.round(v * 100)}%`)
			.join(", ");
		return this.color(`${c.dim}Weights: ${parts}${c.reset}`);
	}

	/**
	 * Format duration in human-readable form.
	 */
	private formatDuration(ms: number): string {
		if (ms < 1000) return `${Math.round(ms)}ms`;
		return `${(ms / 1000).toFixed(1)}s`;
	}

	/**
	 * Format cost in USD.
	 */
	private formatCost(cost: number): string {
		if (cost === 0) return this.color(`${c.green}FREE${c.reset}`);
		if (cost < 0.01) return `$${cost.toFixed(4)}`;
		return `$${cost.toFixed(3)}`;
	}

	/**
	 * Truncate string with ellipsis.
	 */
	private truncate(str: string, maxLen: number): string {
		if (str.length <= maxLen) return str;
		return str.slice(0, maxLen - 1) + "…";
	}

	/**
	 * Apply colors if enabled.
	 */
	private color(str: string): string {
		if (!this.useColors) {
			return str.replace(/\x1b\[[0-9;]*m/g, "");
		}
		return str;
	}
}
