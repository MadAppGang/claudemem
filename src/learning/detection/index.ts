/**
 * Detection Module - Implicit feedback signal detection.
 *
 * This module provides:
 * - CorrectionScorer: Multi-signal correction detection from user messages
 * - CodeChangeTracker: "Correction Gap" analysis from code modifications
 *
 * Usage:
 * ```typescript
 * import { createCorrectionScorer, createCodeChangeTracker } from "./learning/detection/index.js";
 *
 * // Score potential corrections
 * const scorer = createCorrectionScorer();
 * const result = scorer.score({
 *   userMessage: "No, that's wrong. It should use async/await",
 *   previousTool: "Edit",
 *   previousToolFailed: false,
 * });
 * if (scorer.isCorrection(result.correctionScore)) {
 *   console.log("Correction detected:", result.signals);
 * }
 *
 * // Track code changes
 * const tracker = createCodeChangeTracker(store);
 * tracker.trackAgentEdit({ sessionId, filePath, contentHash, linesAdded: 10, linesRemoved: 0 });
 * const { correction } = tracker.trackUserEdit({ sessionId, filePath, contentHash, linesAdded: 5, linesRemoved: 8 });
 * if (correction) {
 *   console.log("Correction Gap detected:", correction.correctionType);
 * }
 * ```
 */

// Code Change Tracker
export {
	CodeChangeTracker,
	type CodeChangeTrackerConfig,
	type CorrectionGapResult,
	type CorrectionGapStats,
	createCodeChangeTracker,
	DEFAULT_TRACKER_CONFIG,
	hashContent,
	type TrackedEdit,
} from "./code-change-tracker.js";
// Correction Scorer
export {
	CorrectionScorer,
	type CorrectionScorerConfig,
	createCorrectionScorer,
	DEFAULT_CORRECTION_WEIGHTS,
	DEFAULT_SCORER_CONFIG,
	LEXICAL_CORRECTION_KEYWORDS,
	type ScoringContext,
	STRONG_CORRECTION_KEYWORDS,
} from "./correction-scorer.js";
