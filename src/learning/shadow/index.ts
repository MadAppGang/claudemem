/**
 * Shadow Agent Module - Predict and detect deviations.
 *
 * This module provides:
 * - ShadowPredictor: N-gram model predicting next tool
 * - DeviationDetector: Warns when actual differs from expected
 *
 * The "shadow" agent runs alongside the main agent, building
 * expectations without interfering with execution.
 *
 * Usage:
 * ```typescript
 * import {
 *   createShadowPredictor,
 *   createDeviationDetector
 * } from "./learning/shadow/index.js";
 *
 * // Create predictor and train on history
 * const predictor = createShadowPredictor();
 * predictor.train(historicalToolEvents);
 *
 * // Create deviation detector
 * const detector = createDeviationDetector(predictor);
 *
 * // On each tool use
 * function onToolUse(toolName: string) {
 *   const analysis = detector.analyze(toolName);
 *
 *   if (analysis.isDeviation) {
 *     console.log("Deviation:", analysis.deviation);
 *   }
 *
 *   if (analysis.alert) {
 *     console.warn("Alert:", analysis.alert.message);
 *   }
 * }
 * ```
 */

// Deviation Detector
export {
	createDeviationDetector,
	DEFAULT_DEVIATION_CONFIG,
	type Deviation,
	type DeviationAlert,
	type DeviationAnalysis,
	DeviationDetector,
	type DeviationDetectorConfig,
	type DeviationSeverity,
	type DeviationStatistics,
	type DeviationType,
} from "./deviation-detector.js";
// Shadow Predictor
export {
	createShadowPredictor,
	DEFAULT_SHADOW_CONFIG,
	type NGramModel,
	type PredictionResult,
	ShadowPredictor,
	type ShadowPredictorConfig,
	type ToolPrediction,
} from "./shadow-predictor.js";
