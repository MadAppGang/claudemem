/**
 * Generator Factory
 *
 * Creates summary generators for different LLM providers.
 */

import { createLLMClient, DEFAULT_LLM_MODELS } from "../../llm/client.js";
import type { LLMProvider } from "../../types.js";
import type { GeneratorInfo, ISummaryGenerator } from "../types.js";
import { SummaryGenerator } from "./base.js";

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a summary generator for the specified provider and model.
 *
 * @param provider - LLM provider (anthropic, openrouter, ollama, local)
 * @param model - Model identifier (defaults to provider's default)
 * @param displayName - Human-readable name (auto-generated if not provided)
 */
export async function createGenerator(
	provider: LLMProvider,
	model?: string,
	displayName?: string
): Promise<ISummaryGenerator> {
	const resolvedModel = model || DEFAULT_LLM_MODELS[provider];
	const resolvedDisplayName = displayName || formatDisplayName(provider, resolvedModel);

	const llmClient = await createLLMClient({
		provider,
		model: resolvedModel,
	});

	const info: GeneratorInfo = {
		provider,
		model: resolvedModel,
		displayName: resolvedDisplayName,
	};

	return new SummaryGenerator(llmClient, info);
}

/**
 * Create multiple generators from a list of configurations.
 */
export async function createGenerators(
	configs: Array<{ provider: LLMProvider; model?: string; displayName?: string }>
): Promise<ISummaryGenerator[]> {
	const generators = await Promise.all(
		configs.map((config) =>
			createGenerator(config.provider, config.model, config.displayName)
		)
	);
	return generators;
}

/**
 * Parse generator specification string into provider and model.
 * Supports formats:
 * - "anthropic" -> anthropic provider, default model
 * - "anthropic/claude-sonnet-4" -> anthropic provider, claude-sonnet-4 model
 * - "openrouter/openai/gpt-4o" -> openrouter provider, openai/gpt-4o model
 * - "ollama/llama3.2" -> local provider, llama3.2 model
 * - "local/llama3.2" -> local provider, llama3.2 model
 * - "lmstudio/model" -> local provider with model
 */
export function parseGeneratorSpec(spec: string): { provider: LLMProvider; model?: string } {
	const parts = spec.split("/");

	// Handle special cases
	if (parts[0] === "ollama" || parts[0] === "lmstudio") {
		// ollama/model or lmstudio/model -> local provider
		return {
			provider: "local",
			model: parts.length > 1 ? parts.slice(1).join("/") : undefined,
		};
	}

	if (parts.length === 1) {
		// Just provider name
		const provider = normalizeProvider(parts[0]);
		return { provider };
	}

	// provider/model format
	const provider = normalizeProvider(parts[0]);
	const model = parts.slice(1).join("/");
	return { provider, model };
}

/**
 * Normalize provider name to LLMProvider type.
 */
function normalizeProvider(name: string): LLMProvider {
	const normalized = name.toLowerCase();
	switch (normalized) {
		case "anthropic":
		case "claude":
			return "anthropic";
		case "openrouter":
		case "or":
			return "openrouter";
		case "ollama":
		case "local":
		case "lmstudio":
			return "local";
		case "claude-code":
			return "claude-code";
		default:
			// Default to openrouter for unknown providers (allows openai/gpt-4o etc.)
			return "openrouter";
	}
}

/**
 * Format a display name for a generator.
 */
function formatDisplayName(provider: LLMProvider, model: string): string {
	const providerNames: Record<LLMProvider, string> = {
		anthropic: "Anthropic",
		openrouter: "OpenRouter",
		local: "Local",
		"claude-code": "Claude Code",
	};

	const providerName = providerNames[provider] || provider;
	const shortModel = model.split("/").pop() || model;

	return `${shortModel} (${providerName})`;
}

// ============================================================================
// Predefined Generator Configurations
// ============================================================================

/** Default generators for quick benchmarking */
export const DEFAULT_GENERATORS: Array<{ provider: LLMProvider; model?: string; displayName?: string }> = [
	{ provider: "anthropic", model: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4" },
];

/** Popular model configurations for comprehensive benchmarking */
export const POPULAR_GENERATORS: Array<{ provider: LLMProvider; model?: string; displayName?: string }> = [
	{ provider: "anthropic", model: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4" },
	{ provider: "anthropic", model: "claude-3-5-haiku-20241022", displayName: "Claude Haiku 3.5" },
	{ provider: "openrouter", model: "openai/gpt-4o", displayName: "GPT-4o" },
	{ provider: "openrouter", model: "openai/gpt-4o-mini", displayName: "GPT-4o Mini" },
	{ provider: "openrouter", model: "google/gemini-pro-1.5", displayName: "Gemini Pro 1.5" },
	{ provider: "openrouter", model: "meta-llama/llama-3.3-70b-instruct", displayName: "Llama 3.3 70B" },
	{ provider: "local", model: "llama3.2", displayName: "Llama 3.2 (Local)" },
];
