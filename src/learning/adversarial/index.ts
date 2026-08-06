/**
 * Adversarial Safety Module - Red Team / Blue Team testing for improvements.
 *
 * This module provides:
 * - RedTeam: Attack generated improvements to find vulnerabilities
 * - BlueTeam: Defend and validate improvements
 * - SafetyScorer: Compute final safety score for auto-deploy gating
 *
 * Workflow:
 * 1. RedTeam attacks the improvement with edge cases, injections, etc.
 * 2. BlueTeam applies mitigations and validates safety
 * 3. SafetyScorer combines scores to make deployment decision
 *
 * Usage:
 * ```typescript
 * import {
 *   createRedTeam,
 *   createBlueTeam,
 *   createSafetyScorer
 * } from "./learning/adversarial/index.js";
 *
 * const redTeam = createRedTeam({ intensity: 0.8 });
 * const blueTeam = createBlueTeam({ autoMitigate: true });
 * const scorer = createSafetyScorer();
 *
 * // Attack the improvement
 * const redReport = redTeam.attackImprovement(improvement);
 *
 * // Defend and validate
 * const blueReport = blueTeam.validateImprovement(improvement, redReport);
 *
 * // Get final score and decision
 * const result = scorer.score(improvement, redReport, blueReport, {
 *   patternConfidence: 0.85
 * });
 *
 * if (result.decision === 'auto_deploy') {
 *   // Safe to deploy automatically
 * } else if (result.decision === 'human_review') {
 *   // Queue for human approval
 * } else {
 *   // Reject improvement
 * }
 * ```
 */

// Blue Team - Defend and validate
export {
	BlueTeam,
	type BlueTeamConfig,
	createBlueTeam,
	DEFAULT_BLUE_CONFIG,
	type DefenseReport,
	type Mitigation,
	type MitigationApplication,
	type MitigationType,
	type ValidationResult,
	type ValidationRule,
} from "./blue-team.js";
// Red Team - Attack generated improvements
export {
	type Attack,
	type AttackOutcome,
	type AttackPayload,
	type AttackResult,
	type AttackType,
	createRedTeam,
	DEFAULT_RED_CONFIG,
	RedTeam,
	type RedTeamConfig,
	type RedTeamReport,
} from "./red-team.js";

// Safety Scorer - Final deployment decision
export {
	createSafetyScorer,
	DEFAULT_SCORER_CONFIG,
	type DeploymentDecision,
	type HistoricalData,
	type SafetyFactor,
	type SafetyScoreResult,
	SafetyScorer,
	type SafetyScorerConfig,
	type ScoringContext,
} from "./safety-scorer.js";
