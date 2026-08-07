/**
 * Deployment Module - A/B testing, metrics, and rollback.
 *
 * This module provides:
 * - ABTestManager: Controlled rollout with statistical significance testing
 * - MetricsTracker: Time-series metrics and trend analysis
 * - RollbackManager: Revert improvements on regression
 *
 * Usage:
 * ```typescript
 * import {
 *   createABTestManager,
 *   createMetricsTracker,
 *   createRollbackManager
 * } from "./learning/deployment/index.js";
 *
 * // Set up A/B testing
 * const abTest = createABTestManager({ trafficPercent: 10 });
 * const experiment = abTest.createExperiment(improvement);
 * abTest.startExperiment(experiment.experimentId);
 *
 * // Track metrics
 * const metrics = createMetricsTracker();
 * metrics.recordSession(corrections, errors, autonomous, duration);
 *
 * // Handle rollbacks
 * const rollback = createRollbackManager();
 * const candidate = rollback.evaluateForRollback(improvement, currentMetrics, anomalies);
 * if (candidate.recommendation === "rollback") {
 *   rollback.initiateRollback(improvement, candidate.reason, "Regression detected");
 * }
 * ```
 */

// A/B Testing
export {
	type ABTestConfig,
	ABTestManager,
	createABTestManager,
	DEFAULT_AB_CONFIG,
	type Experiment,
	type ExperimentDecision,
	type ExperimentMetrics,
	type ExperimentStatus,
	type StatisticalResult,
} from "./ab-testing.js";

// Metrics Tracker
export {
	createMetricsTracker,
	DEFAULT_METRICS_CONFIG,
	type ImprovementMetrics,
	type MetricAnomaly,
	type MetricDataPoint,
	type MetricSeries,
	type MetricsSnapshot,
	MetricsTracker,
	type MetricsTrackerConfig,
	type TrendAnalysis,
} from "./metrics-tracker.js";

// Rollback Manager
export {
	createRollbackManager,
	DEFAULT_ROLLBACK_CONFIG,
	type RollbackCandidate,
	type RollbackEvent,
	RollbackManager,
	type RollbackManagerConfig,
	type RollbackMetrics,
	type RollbackReason,
	type RollbackStatus,
} from "./rollback.js";
