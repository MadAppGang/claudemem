/**
 * Analysis Module - Pattern mining and error clustering.
 *
 * This module provides:
 * - PatternMiner: FP-Growth and PrefixSpan for frequent pattern discovery
 * - ErrorClusterer: Hierarchical clustering of similar errors
 * - WorkflowDetector: Identifies automatable tool sequences
 *
 * Usage:
 * ```typescript
 * import {
 *   createPatternMiner,
 *   createErrorClusterer,
 *   createWorkflowDetector
 * } from "./learning/analysis/index.js";
 *
 * // Mine patterns from tool events
 * const miner = createPatternMiner();
 * const patterns = miner.minePatterns(events, sessionIds);
 * console.log("Error patterns:", patterns.errorPatterns);
 * console.log("Workflow patterns:", patterns.workflowPatterns);
 *
 * // Cluster errors
 * const clusterer = createErrorClusterer();
 * const clusters = clusterer.cluster(events);
 * console.log("Top error clusters:", clusterer.getTopClusters(clusters));
 *
 * // Detect workflows
 * const detector = createWorkflowDetector();
 * const workflows = detector.detect(events);
 * console.log("Automatable workflows:", workflows.topAutomatable);
 * console.log("Skill suggestions:", detector.suggestSkills(workflows));
 * ```
 */

// Error Clusterer
export {
	type ClusteringResult,
	createErrorClusterer,
	DEFAULT_CLUSTER_CONFIG,
	type ErrorCluster,
	type ErrorClusterConfig,
	ErrorClusterer,
	type ErrorInstance,
} from "./error-clusterer.js";
// Pattern Miner
export {
	type AssociationRule,
	createPatternMiner,
	DEFAULT_MINER_CONFIG,
	type FrequentItemset,
	type MinedPatterns,
	PatternMiner,
	type PatternMinerConfig,
	type SequentialPattern,
} from "./pattern-miner.js";

// Workflow Detector
export {
	createWorkflowDetector,
	DEFAULT_WORKFLOW_CONFIG,
	type Workflow,
	type WorkflowAnalysis,
	WorkflowDetector,
	type WorkflowDetectorConfig,
} from "./workflow-detector.js";
