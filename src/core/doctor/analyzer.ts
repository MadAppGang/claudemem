/**
 * Main doctor analyzer
 *
 * Orchestrates diagnosis of context files
 */

import type { ContextFile, ContextFileDiagnosis } from "./types.js";
import type { FileTracker } from "../tracker.js";
import {
	analyzeTokenCount,
	analyzeSpecificity,
	analyzeInstructionDensity,
	analyzeDuplication,
	analyzeStaleness,
	analyzeSkillsBenchCompliance,
} from "./criteria.js";
import { aggregateScore } from "./scorer.js";

/**
 * Analyze a single context file
 */
export function analyzeContextFile(
	file: ContextFile,
	tracker: FileTracker | null,
	projectPath: string,
): ContextFileDiagnosis {
	const criteria = [
		analyzeTokenCount(file),
		analyzeSpecificity(file),
		analyzeInstructionDensity(file),
		analyzeDuplication(file, projectPath),
		analyzeStaleness(file, tracker),
		analyzeSkillsBenchCompliance(file),
	];

	const overallScore = aggregateScore(criteria);

	// Calculate cost overhead
	// Assuming average query uses 500 tokens, and typical budget is 4000 tokens per query
	const tokensPerQuery = file.tokenEstimate;
	const budgetPercent = (tokensPerQuery / 4000) * 100;

	const diagnosis: ContextFileDiagnosis = {
		file,
		overallScore,
		criteria,
		costOverhead: {
			tokensPerQuery,
			budgetPercent,
		},
	};

	return diagnosis;
}

/**
 * Analyze multiple context files and generate top recommendations
 */
export function aggregateDiagnoses(
	diagnoses: ContextFileDiagnosis[],
): string[] {
	const recommendations: Map<string, number> = new Map();

	// Collect all recommendations with frequency
	for (const diagnosis of diagnoses) {
		for (const criterion of diagnosis.criteria) {
			for (const rec of criterion.recommendations) {
				const current = recommendations.get(rec) || 0;
				recommendations.set(rec, current + 1);
			}
		}
	}

	// Sort by frequency and return top 5
	return Array.from(recommendations.entries())
		.sort((a, b) => b[1] - a[1])
		.slice(0, 5)
		.map(([rec]) => rec);
}
