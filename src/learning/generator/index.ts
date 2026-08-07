/**
 * Generator Module - Auto-improvement generation from patterns.
 *
 * This module provides:
 * - SkillGenerator: Create skill specs from workflow patterns
 * - SubagentComposer: Create subagent specs from error clusters
 * - PromptOptimizer: Refine prompts from correction patterns
 * - SafetyValidator: Validate improvements before deployment
 *
 * Usage:
 * ```typescript
 * import {
 *   createSkillGenerator,
 *   createSubagentComposer,
 *   createPromptOptimizer,
 *   createSafetyValidator
 * } from "./learning/generator/index.js";
 *
 * // Generate skills from workflows
 * const skillGen = createSkillGenerator();
 * const skills = skillGen.generateFromWorkflows(workflows);
 *
 * // Compose subagents from error clusters
 * const composer = createSubagentComposer();
 * const subagents = composer.composeFromClusters(clusters);
 *
 * // Optimize prompts from corrections
 * const optimizer = createPromptOptimizer();
 * const optimizations = optimizer.optimizeFromCorrections(corrections);
 *
 * // Validate before deployment
 * const validator = createSafetyValidator();
 * for (const improvement of improvements) {
 *   const result = validator.validate(improvement);
 *   if (result.recommendation === "auto_deploy") {
 *     // Safe to deploy automatically
 *   } else if (result.recommendation === "human_review") {
 *     // Queue for human review
 *   } else {
 *     // Reject - log issues
 *     console.log("Rejected:", result.issues);
 *   }
 * }
 * ```
 */

// Prompt Optimizer
export {
	type CorrectionEvidence,
	createPromptOptimizer,
	DEFAULT_OPTIMIZER_CONFIG,
	type PromptOptimization,
	type PromptOptimizationResult,
	PromptOptimizer,
	type PromptOptimizerConfig,
} from "./prompt-optimizer.js";
// Safety Validator
export {
	type BatchValidationResult,
	containsDangerousPatterns,
	createSafetyValidator,
	DEFAULT_SAFETY_CONFIG,
	isImprovementSafe,
	SafetyValidator,
	type SafetyValidatorConfig,
	type ValidationIssue,
	type ValidationResult,
} from "./safety-validator.js";
// Skill Generator
export {
	createSkillGenerator,
	DEFAULT_SKILL_CONFIG,
	type GeneratedSkill,
	type SkillGenerationResult,
	SkillGenerator,
	type SkillGeneratorConfig,
} from "./skill-generator.js";
// Subagent Composer
export {
	createSubagentComposer,
	DEFAULT_COMPOSER_CONFIG,
	type GeneratedSubagent,
	SubagentComposer,
	type SubagentComposerConfig,
	type SubagentCompositionResult,
} from "./subagent-composer.js";
