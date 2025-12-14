/**
 * Judge Factory
 *
 * Creates judge instances for evaluating summary quality.
 */

import { createLLMClient } from "../../llm/client.js";
import type { LLMProvider } from "../../types.js";
import type { IJudge } from "../types.js";
import { LLMJudge } from "./llm-judge.js";
import { ConsensusJudge, type AggregationMethod } from "./consensus-judge.js";
import { BlindJudge } from "./blind-judge.js";

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create an LLM judge for the specified model.
 *
 * @param model - Model identifier (e.g., "claude-sonnet-4", "openai/gpt-4o")
 * @param provider - Optional provider override (auto-detected from model if not specified)
 */
export async function createJudge(
	model: string,
	provider?: LLMProvider
): Promise<IJudge> {
	const resolvedProvider = provider || detectProvider(model);

	const llmClient = await createLLMClient({
		provider: resolvedProvider,
		model: resolvedModel(model, resolvedProvider),
	});

	return new LLMJudge(llmClient);
}

/**
 * Create a consensus judge from multiple models.
 *
 * @param models - Array of model identifiers
 * @param aggregation - Aggregation method (default: "median")
 */
export async function createConsensusJudge(
	models: string[],
	aggregation: AggregationMethod = "median"
): Promise<IJudge> {
	const judges = await Promise.all(
		models.map((model) => createJudge(model))
	);

	return new ConsensusJudge(judges, aggregation);
}

/**
 * Create a blind judge wrapper.
 *
 * @param model - Model identifier for the underlying judge
 */
export async function createBlindJudge(model: string): Promise<IJudge> {
	const innerJudge = await createJudge(model);
	return new BlindJudge(innerJudge);
}

/**
 * Parse judge specification and create appropriate judge.
 * Supports formats:
 * - "claude-sonnet-4" -> Single LLM judge
 * - "claude-sonnet-4,gpt-4o" -> Consensus judge
 * - "blind:claude-sonnet-4" -> Blind judge
 * - "consensus:median:claude-sonnet-4,gpt-4o" -> Consensus with method
 */
export async function parseAndCreateJudge(spec: string): Promise<IJudge> {
	// Check for blind prefix
	if (spec.startsWith("blind:")) {
		const model = spec.slice(6);
		return createBlindJudge(model);
	}

	// Check for consensus prefix
	if (spec.startsWith("consensus:")) {
		const rest = spec.slice(10);
		const parts = rest.split(":");

		if (parts.length === 2) {
			// consensus:method:models
			const method = parts[0] as AggregationMethod;
			const models = parts[1].split(",").map((m) => m.trim());
			return createConsensusJudge(models, method);
		} else {
			// consensus:models (default method)
			const models = parts[0].split(",").map((m) => m.trim());
			return createConsensusJudge(models);
		}
	}

	// Check for comma-separated models (implicit consensus)
	if (spec.includes(",")) {
		const models = spec.split(",").map((m) => m.trim());
		return createConsensusJudge(models);
	}

	// Single model
	return createJudge(spec);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Detect provider from model identifier.
 */
function detectProvider(model: string): LLMProvider {
	const normalized = model.toLowerCase();

	// Check for explicit provider prefix
	if (normalized.startsWith("openai/") || normalized.startsWith("google/") || normalized.startsWith("meta-llama/")) {
		return "openrouter";
	}

	// Check for Anthropic models
	if (normalized.includes("claude")) {
		return "anthropic";
	}

	// Check for OpenAI models via OpenRouter
	if (normalized.includes("gpt") || normalized.includes("o1")) {
		return "openrouter";
	}

	// Check for local models
	if (normalized.includes("llama") || normalized.includes("mistral") || normalized.includes("codellama")) {
		return "local";
	}

	// Default to OpenRouter for unknown models
	return "openrouter";
}

/**
 * Resolve model identifier for provider.
 */
function resolvedModel(model: string, provider: LLMProvider): string {
	// For anthropic, use direct model name
	if (provider === "anthropic") {
		// Strip provider prefix if present
		if (model.startsWith("anthropic/")) {
			return model.slice(10);
		}
		return model;
	}

	// For other providers, keep as-is
	return model;
}

// ============================================================================
// Predefined Judge Configurations
// ============================================================================

/** Default judge model (Claude Sonnet 4) */
export const DEFAULT_JUDGE_MODEL = "claude-sonnet-4-20250514";

/** Popular judge configurations */
export const POPULAR_JUDGES = {
	claudeSonnet: "claude-sonnet-4-20250514",
	claudeHaiku: "claude-3-5-haiku-20241022",
	gpt4o: "openai/gpt-4o",
	gemini: "google/gemini-pro-1.5",
};
