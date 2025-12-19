/**
 * Markdown Reporter
 *
 * Outputs benchmark results as a Markdown document.
 * Designed for GitHub READMEs and documentation.
 */

import { writeFileSync } from "fs";
import type {
	BenchmarkRun,
	BenchmarkConfig,
	AggregatedScore,
} from "../types.js";
import type { ModelAggregation } from "../scorers/aggregator.js";
import type { CorrelationMatrix, InterRaterAgreement } from "../scorers/statistics.js";

// ============================================================================
// Markdown Reporter
// ============================================================================

export interface MarkdownReporterOptions {
	includeDetailedMetrics?: boolean;
	includeCorrelationMatrix?: boolean;
	includeCharts?: boolean; // Mermaid diagrams
}

export class MarkdownReporter {
	private options: MarkdownReporterOptions;

	constructor(options: MarkdownReporterOptions = {}) {
		this.options = {
			includeDetailedMetrics: options.includeDetailedMetrics ?? true,
			includeCorrelationMatrix: options.includeCorrelationMatrix ?? true,
			includeCharts: options.includeCharts ?? true,
		};
	}

	/**
	 * Generate Markdown report
	 */
	generate(input: {
		run: BenchmarkRun;
		config: BenchmarkConfig;
		aggregations: Map<string, ModelAggregation>;
		scores: AggregatedScore[];
		correlationMatrix?: CorrelationMatrix;
		interRaterAgreement?: InterRaterAgreement;
	}): string {
		const {
			run,
			config,
			aggregations,
			scores,
			correlationMatrix,
			interRaterAgreement,
		} = input;

		const sections: string[] = [];

		// Header
		sections.push(this.generateHeader(run));

		// Executive Summary
		sections.push(this.generateExecutiveSummary(run, scores, aggregations));

		// Rankings Table
		sections.push(this.generateRankingsTable(scores));

		// Bar Chart (Mermaid)
		if (this.options.includeCharts) {
			sections.push(this.generateBarChart(scores));
		}

		// Detailed Metrics
		if (this.options.includeDetailedMetrics) {
			sections.push(this.generateDetailedMetrics(aggregations, scores));
		}

		// Correlation Matrix
		if (this.options.includeCorrelationMatrix && correlationMatrix) {
			sections.push(this.generateCorrelationMatrix(correlationMatrix));
		}

		// Inter-Rater Agreement
		if (interRaterAgreement) {
			sections.push(this.generateInterRaterAgreement(interRaterAgreement));
		}

		// Methodology
		sections.push(this.generateMethodology(config));

		// Footer
		sections.push(this.generateFooter(run));

		return sections.join("\n\n");
	}

	/**
	 * Write report to file
	 */
	writeToFile(report: string, filePath: string): void {
		writeFileSync(filePath, report, "utf-8");
	}

	// ============================================================================
	// Section Generators
	// ============================================================================

	private generateHeader(run: BenchmarkRun): string {
		return `# LLM Summary Benchmark Report

**Run:** ${run.name}
**Date:** ${new Date(run.startedAt).toLocaleDateString()}
**Status:** ${run.status}`;
	}

	private generateExecutiveSummary(
		run: BenchmarkRun,
		scores: AggregatedScore[],
		aggregations: Map<string, ModelAggregation>
	): string {
		const topModel = scores.length > 0 ? scores[0] : null;

		// Calculate totals
		let totalEvaluations = 0;
		for (const agg of aggregations.values()) {
			totalEvaluations +=
				agg.judge.pointwise.overall.count +
				agg.contrastive.embedding.count +
				agg.contrastive.llm.count;
		}

		return `## Executive Summary

| Metric | Value |
|--------|-------|
| Models Evaluated | ${scores.length} |
| Code Units | ${run.codebaseInfo?.sampledCodeUnits || "N/A"} |
| Total Evaluations | ${totalEvaluations} |
| **Top Model** | **${topModel?.modelId || "N/A"}** |
| Top Score | ${topModel ? (topModel.overallScore * 100).toFixed(1) + "%" : "N/A"} |`;
	}

	private generateRankingsTable(scores: AggregatedScore[]): string {
		const rows = scores.map((score) => {
			const medal = score.rank === 1 ? "🥇" : score.rank === 2 ? "🥈" : score.rank === 3 ? "🥉" : "";
			return `| ${medal} ${score.rank} | ${score.modelId} | ${(score.overallScore * 100).toFixed(1)}% | ${(score.judgeScore / 5 * 100).toFixed(1)}% | ${(score.contrastiveAccuracy * 100).toFixed(1)}% | ${(score.retrievalMRR * 100).toFixed(1)}% | ${(score.downstreamScore * 100).toFixed(1)}% |`;
		});

		return `## Rankings

| Rank | Model | Overall | Judge | Contrastive | Retrieval | Downstream |
|------|-------|---------|-------|-------------|-----------|------------|
${rows.join("\n")}`;
	}

	private generateBarChart(scores: AggregatedScore[]): string {
		const bars = scores
			.slice(0, 10) // Top 10
			.map(
				(score) =>
					`    "${score.modelId.slice(-20)}" : ${Math.round(score.overallScore * 100)}`
			);

		return `## Overall Scores

\`\`\`mermaid
xychart-beta
    title "Model Performance Comparison"
    x-axis [${scores.slice(0, 10).map((s) => `"${s.modelId.slice(-15)}"`).join(", ")}]
    y-axis "Score (%)" 0 --> 100
    bar [${scores.slice(0, 10).map((s) => Math.round(s.overallScore * 100)).join(", ")}]
\`\`\``;
	}

	private generateDetailedMetrics(
		aggregations: Map<string, ModelAggregation>,
		scores: AggregatedScore[]
	): string {
		const sections: string[] = ["## Detailed Metrics"];

		// Helper to safely format stats (handles null/undefined/NaN)
		const fmt = (val: number | null | undefined): string => {
			if (val === null || val === undefined || isNaN(val)) return "N/A";
			return val.toFixed(2);
		};

		for (const score of scores.slice(0, 5)) {
			const agg = aggregations.get(score.modelId);
			if (!agg) continue;

			const pw = agg.judge.pointwise;
			sections.push(`### ${score.modelId}

**Judge Scores (1-5 scale):**
| Criterion | Mean | Std Dev | Min | Max |
|-----------|------|---------|-----|-----|
| Accuracy | ${fmt(pw.accuracy.mean)} | ${fmt(pw.accuracy.stdDev)} | ${fmt(pw.accuracy.min)} | ${fmt(pw.accuracy.max)} |
| Completeness | ${fmt(pw.completeness.mean)} | ${fmt(pw.completeness.stdDev)} | ${fmt(pw.completeness.min)} | ${fmt(pw.completeness.max)} |
| Semantic Richness | ${fmt(pw.semanticRichness.mean)} | ${fmt(pw.semanticRichness.stdDev)} | ${fmt(pw.semanticRichness.min)} | ${fmt(pw.semanticRichness.max)} |
| Abstraction | ${fmt(pw.abstraction.mean)} | ${fmt(pw.abstraction.stdDev)} | ${fmt(pw.abstraction.min)} | ${fmt(pw.abstraction.max)} |
| Conciseness | ${fmt(pw.conciseness.mean)} | ${fmt(pw.conciseness.stdDev)} | ${fmt(pw.conciseness.min)} | ${fmt(pw.conciseness.max)} |

**Pairwise Tournament:**
- Wins: ${agg.judge.pairwise.wins}
- Losses: ${agg.judge.pairwise.losses}
- Ties: ${agg.judge.pairwise.ties}
- Win Rate: ${(agg.judge.pairwise.winRate * 100).toFixed(1)}%

**Retrieval Performance:**
${Object.entries(agg.retrieval.precision)
	.map(([k, v]) => `- P@${k}: ${(v * 100).toFixed(1)}%`)
	.join("\n")}
- MRR: ${(agg.retrieval.mrr * 100).toFixed(1)}%`);
		}

		return sections.join("\n\n");
	}

	private generateCorrelationMatrix(matrix: CorrelationMatrix): string {
		const header = `| | ${matrix.metrics.join(" | ")} |`;
		const separator = `|---|${matrix.metrics.map(() => "---").join("|")}|`;
		const rows = matrix.metrics.map((metric, i) => {
			const values = matrix.values[i].map((v) => v.toFixed(2));
			return `| ${metric} | ${values.join(" | ")} |`;
		});

		return `## Evaluation Method Correlation

${header}
${separator}
${rows.join("\n")}

*Higher correlations indicate that evaluation methods tend to agree on model rankings.*`;
	}

	private generateInterRaterAgreement(agreement: InterRaterAgreement): string {
		return `## Inter-Rater Agreement

| Metric | Value |
|--------|-------|
| Judge Models | ${agreement.judgeModels.join(", ")} |
| Cohen's Kappa | ${agreement.kappa.toFixed(3)} |
| Raw Agreement | ${(agreement.agreement * 100).toFixed(1)}% |
| Interpretation | ${agreement.interpretation} |`;
	}

	private generateMethodology(config: BenchmarkConfig): string {
		const weights = config.weights?.evalWeights || { judge: 0.35, contrastive: 0.2, retrieval: 0.4, downstream: 0.05 };

		return `## Methodology

### Evaluation Methods

1. **LLM-as-Judge** (${(weights.judge * 100).toFixed(0)}% weight)
   - 5-point scale across 5 criteria
   - Judge models: ${config.evaluation.judge.judgeModels?.join(", ") || config.judges?.join(", ") || "N/A"}

2. **Contrastive Matching** (${(weights.contrastive * 100).toFixed(0)}% weight)
   - Method: ${config.evaluation.contrastive.method || "both"}
   - Distractors: ${config.evaluation.contrastive.distractorCount || 9}

3. **Retrieval Evaluation** (${(weights.retrieval * 100).toFixed(0)}% weight)
   - Metrics: P@K (K=${config.evaluation.retrieval.kValues?.join(", ") || "1, 3, 5, 10"}), MRR

4. **Downstream Tasks** (${(weights.downstream * 100).toFixed(0)}% weight)
   - Code completion
   - Bug localization
   - Function selection

### Sampling

- Strategy: ${config.samplingStrategy || "stratified"}
- Target: ${config.sampleSize || 100} code units`;
	}

	private generateFooter(run: BenchmarkRun): string {
		const duration = run.completedAt
			? Math.round(
					(new Date(run.completedAt).getTime() - new Date(run.startedAt).getTime()) / 1000 / 60
			  )
			: "N/A";

		return `---

*Generated by claudemem benchmark v2.0.0*
*Run ID: ${run.id}*
*Duration: ${duration} minutes*`;
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createMarkdownReporter(
	options?: MarkdownReporterOptions
): MarkdownReporter {
	return new MarkdownReporter(options);
}
