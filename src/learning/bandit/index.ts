/**
 * Bandit Module - Adaptive tool selection via Thompson Sampling.
 *
 * This module provides:
 * - ToolBandit: Multi-armed bandit for exploration vs exploitation
 * - ContextEncoder: Extract task context for contextual bandits
 *
 * Usage:
 * ```typescript
 * import {
 *   createToolBandit,
 *   createContextEncoder
 * } from "./learning/bandit/index.js";
 *
 * const bandit = createToolBandit();
 * const encoder = createContextEncoder();
 *
 * // Get recommendation with context
 * function recommendTool(
 *   availableTools: string[],
 *   currentFile: string,
 *   recentTools: string[]
 * ) {
 *   const context = encoder.encode({
 *     currentFile,
 *     recentTools
 *   });
 *
 *   const recommendation = bandit.recommend(
 *     availableTools,
 *     context.features
 *   );
 *
 *   return recommendation;
 * }
 *
 * // Update with outcome
 * function recordOutcome(tool: string, success: boolean, context: string[]) {
 *   bandit.update(tool, success, context);
 * }
 * ```
 */

// Context Encoder
export {
	ContextEncoder,
	type ContextEncoderConfig,
	type ContextFeature,
	createContextEncoder,
	DEFAULT_ENCODER_CONFIG,
	type EncodedContext,
	type TaskContext,
} from "./context-encoder.js";
// Tool Bandit
export {
	type BanditRecommendation,
	type BanditStatistics,
	type ContextualArm,
	createToolBandit,
	DEFAULT_BANDIT_CONFIG,
	type ToolArm,
	ToolBandit,
	type ToolBanditConfig,
} from "./tool-bandit.js";
