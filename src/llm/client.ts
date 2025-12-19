/**
 * LLM Client
 *
 * Multi-provider LLM client for enrichment operations.
 * Supports: Claude Code CLI, Anthropic API, OpenRouter, Local (Ollama/LM Studio)
 */

import {
	getAnthropicApiKey,
	getApiKey,
	getLLMSpec,
	loadGlobalConfig,
} from "../config.js";
import type {
	ILLMClient,
	LLMGenerateOptions,
	LLMMessage,
	LLMProvider,
	LLMResponse,
} from "../types.js";

// ============================================================================
// Re-exports
// ============================================================================

export type { ILLMClient, LLMGenerateOptions, LLMMessage, LLMProvider, LLMResponse };

// ============================================================================
// Constants
// ============================================================================

/** Default models per provider */
export const DEFAULT_LLM_MODELS: Record<LLMProvider, string> = {
	"claude-code": "sonnet", // Short name - provider resolves to full API model ID
	anthropic: "claude-sonnet-4-5",
	"anthropic-batch": "claude-sonnet-4-5",
	openrouter: "anthropic/claude-sonnet-4",
	local: "llama3.2",
};

/** Maximum retries for failed requests */
const MAX_RETRIES = 3;

/** Base delay for exponential backoff (ms) */
const BASE_RETRY_DELAY = 1000;

// ============================================================================
// Base Client Class
// ============================================================================

/** Cloud LLM providers (use network API calls) */
const CLOUD_LLM_PROVIDERS: Set<LLMProvider> = new Set(["anthropic", "anthropic-batch", "openrouter"]);

export abstract class BaseLLMClient implements ILLMClient {
	protected provider: LLMProvider;
	protected model: string;
	protected timeout: number;
	private accumulatedUsage = { inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 };

	constructor(provider: LLMProvider, model: string, timeout = 120000) {
		this.provider = provider;
		this.model = model;
		this.timeout = timeout;
	}

	getProvider(): LLMProvider {
		return this.provider;
	}

	getModel(): string {
		return this.model;
	}

	isCloud(): boolean {
		return CLOUD_LLM_PROVIDERS.has(this.provider);
	}

	getAccumulatedUsage() {
		return { ...this.accumulatedUsage };
	}

	resetAccumulatedUsage(): void {
		this.accumulatedUsage = { inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 };
	}

	protected accumulateUsage(usage?: { inputTokens: number; outputTokens: number; cost?: number }): void {
		if (usage) {
			this.accumulatedUsage.inputTokens += usage.inputTokens;
			this.accumulatedUsage.outputTokens += usage.outputTokens;
			this.accumulatedUsage.cost += usage.cost || 0;
		}
		this.accumulatedUsage.calls++;
	}

	abstract complete(
		messages: LLMMessage[],
		options?: LLMGenerateOptions
	): Promise<LLMResponse>;

	async completeJSON<T>(
		messages: LLMMessage[],
		options?: LLMGenerateOptions
	): Promise<T> {
		// Add JSON instruction to system prompt
		const jsonOptions: LLMGenerateOptions = {
			...options,
			systemPrompt: `${options?.systemPrompt || ""}\n\nYou must respond with valid JSON only. No markdown, no explanation, just the JSON object.`.trim(),
		};

		const response = await this.complete(messages, jsonOptions);

		// Track usage
		this.accumulateUsage(response.usage);

		// Try to parse JSON from response
		try {
			// Handle potential markdown code blocks
			let content = response.content.trim();
			if (content.startsWith("```json")) {
				content = content.slice(7);
			} else if (content.startsWith("```")) {
				content = content.slice(3);
			}
			if (content.endsWith("```")) {
				content = content.slice(0, -3);
			}
			content = content.trim();

			return JSON.parse(content) as T;
		} catch (error) {
			throw new Error(
				`Failed to parse LLM response as JSON: ${error instanceof Error ? error.message : String(error)}\nResponse: ${response.content.slice(0, 500)}`
			);
		}
	}

	async testConnection(): Promise<boolean> {
		try {
			await this.complete([{ role: "user", content: "Say 'ok'" }], {
				maxTokens: 10,
			});
			return true;
		} catch {
			return false;
		}
	}

	protected sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	protected async withRetry<T>(
		fn: () => Promise<T>,
		maxRetries = MAX_RETRIES
	): Promise<T> {
		let lastError: Error | undefined;

		for (let attempt = 0; attempt < maxRetries; attempt++) {
			try {
				return await fn();
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));

				// Don't retry on auth errors
				if (
					lastError.message.includes("401") ||
					lastError.message.includes("403") ||
					lastError.message.includes("invalid_api_key")
				) {
					throw lastError;
				}

				if (attempt < maxRetries - 1) {
					const delay = BASE_RETRY_DELAY * Math.pow(2, attempt);
					await this.sleep(delay);
				}
			}
		}

		throw lastError || new Error("Failed after retries");
	}
}

// ============================================================================
// Client Options
// ============================================================================

export interface LLMClientOptions {
	/** LLM provider to use */
	provider?: LLMProvider;
	/** Model to use (overrides default) */
	model?: string;
	/** API key (for Anthropic/OpenRouter) */
	apiKey?: string;
	/** Endpoint URL (for local providers) */
	endpoint?: string;
	/** Request timeout in ms */
	timeout?: number;
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an LLM client based on provider
 *
 * Auto-detects provider from unified LLM spec (CLAUDEMEM_LLM env or config).
 * Supports specs like "a/sonnet", "or/openai/gpt-4o", "cc/sonnet".
 */
export async function createLLMClient(
	options?: LLMClientOptions,
	projectPath?: string
): Promise<ILLMClient> {
	const config = loadGlobalConfig();

	// Use options if provided, otherwise get from unified spec
	let provider = options?.provider;
	let model = options?.model;
	let endpoint = options?.endpoint;

	if (!provider || !model) {
		const spec = getLLMSpec(projectPath);
		provider = provider || spec.provider;
		model = model || spec.model || DEFAULT_LLM_MODELS[provider];
		endpoint = endpoint || spec.endpoint;
	}

	switch (provider) {
		case "claude-code": {
			const { ClaudeCodeLLMClient } = await import("./providers/claude-code.js");
			return new ClaudeCodeLLMClient({
				model,
				timeout: options?.timeout,
			});
		}

		case "anthropic": {
			const { AnthropicLLMClient } = await import("./providers/anthropic.js");
			return new AnthropicLLMClient({
				model,
				apiKey: options?.apiKey || getAnthropicApiKey(),
				timeout: options?.timeout,
			});
		}

		case "anthropic-batch": {
			const { AnthropicBatchLLMClient } = await import("./providers/anthropic-batch.js");
			return new AnthropicBatchLLMClient({
				model,
				apiKey: options?.apiKey || getAnthropicApiKey(),
			});
		}

		case "openrouter": {
			const { OpenRouterLLMClient } = await import("./providers/openrouter.js");
			return new OpenRouterLLMClient({
				model,
				apiKey: options?.apiKey || getApiKey(),
				timeout: options?.timeout,
			});
		}

		case "local": {
			const { LocalLLMClient } = await import("./providers/local.js");
			return new LocalLLMClient({
				model,
				endpoint: endpoint || config.llmEndpoint,
				timeout: options?.timeout,
			});
		}

		default:
			throw new Error(`Unknown LLM provider: ${provider}`);
	}
}

/**
 * Test connection to an LLM provider
 */
export async function testLLMConnection(
	provider: LLMProvider,
	options?: Omit<LLMClientOptions, "provider">
): Promise<{ ok: boolean; error?: string }> {
	try {
		const client = await createLLMClient({ ...options, provider });
		const ok = await client.testConnection();
		return { ok };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
