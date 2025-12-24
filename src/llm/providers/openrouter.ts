/**
 * OpenRouter LLM Provider
 *
 * Uses OpenRouter's chat completions API to access various models.
 * Reuses patterns from the embeddings OpenRouter client.
 */

import { BaseLLMClient, DEFAULT_LLM_MODELS } from "../client.js";
import { combineAbortSignals } from "../abort.js";
import type { LLMGenerateOptions, LLMMessage, LLMResponse } from "../../types.js";

// ============================================================================
// Types
// ============================================================================

interface OpenRouterOptions {
	/** API key for OpenRouter */
	apiKey?: string;
	/** Model to use */
	model?: string;
	/** Request timeout in ms */
	timeout?: number;
}

interface OpenRouterMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface OpenRouterResponse {
	id: string;
	choices: Array<{
		message: {
			role: "assistant";
			content: string;
		};
		finish_reason: string;
	}>;
	model: string;
	usage?: {
		prompt_tokens: number;
		completion_tokens: number;
		total_tokens: number;
	};
}

interface OpenRouterGenerationResponse {
	data: {
		total_cost: number;
		tokens_prompt: number;
		tokens_completion: number;
	};
}

// ============================================================================
// OpenRouter API Client
// ============================================================================

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

// Rate limit retry settings (longer delays for free models)
const RATE_LIMIT_MAX_RETRIES = 5;
const RATE_LIMIT_BASE_DELAY_MS = 5000; // 5 seconds base delay for rate limits

export class OpenRouterLLMClient extends BaseLLMClient {
	private apiKey: string;

	constructor(options: OpenRouterOptions = {}) {
		super(
			"openrouter",
			options.model || DEFAULT_LLM_MODELS.openrouter,
			options.timeout || 120000
		);

		const apiKey = options.apiKey || process.env.OPENROUTER_API_KEY;
		if (!apiKey) {
			throw new Error(
				"OpenRouter API key required. Set OPENROUTER_API_KEY environment variable or pass apiKey option."
			);
		}
		this.apiKey = apiKey;
	}

	async complete(
		messages: LLMMessage[],
		options?: LLMGenerateOptions
	): Promise<LLMResponse> {
		return this.withRateLimitRetry(async () => {
			// Convert messages to OpenRouter format
			const openRouterMessages = this.convertMessages(messages, options?.systemPrompt);

			// Build request body
			const body = {
				model: options?.model || this.model,
				messages: openRouterMessages,
				max_tokens: options?.maxTokens || 4096,
				...(options?.temperature !== undefined && { temperature: options.temperature }),
			};

			// Make API request
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), this.timeout);
			const signal = combineAbortSignals(controller.signal, options?.abortSignal);

			try {
				const response = await fetch(OPENROUTER_API_URL, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						Authorization: `Bearer ${this.apiKey}`,
						"HTTP-Referer": "https://github.com/claudemem",
						"X-Title": "claudemem",
					},
					body: JSON.stringify(body),
					signal,
				});

				clearTimeout(timeoutId);

				if (!response.ok) {
					const errorBody = await response.text();

					if (response.status === 401) {
						throw new Error("OpenRouter API key is invalid");
					} else if (response.status === 429) {
						// Parse retry-after header if available
						const retryAfter = response.headers.get("retry-after");
						const retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined;
						const error = new Error("OpenRouter rate limit exceeded") as Error & { retryAfterMs?: number };
						error.retryAfterMs = retryAfterMs;
						throw error;
					} else if (response.status === 402) {
						throw new Error("OpenRouter payment required - check your credits");
					}

					throw new Error(`OpenRouter API error (${response.status}): ${errorBody}`);
				}

				const data = (await response.json()) as OpenRouterResponse;

				if (!data.choices || data.choices.length === 0) {
					throw new Error("OpenRouter returned empty response");
				}

				const content = data.choices[0].message.content;
				const finishReason = data.choices[0].finish_reason;

				// Check for empty response (common with Gemini content filtering)
				if (!content || content.trim() === "") {
					throw new Error(
						`Empty response from ${body.model} (finish_reason: ${finishReason}). ` +
						`This may be due to content filtering or rate limiting.`
					);
				}

				// Check for truncation - warn but don't fail (useful for debugging)
				if (finishReason === "length") {
					console.warn(`[OpenRouter] Response truncated (hit max_tokens) for model ${body.model}`);
				}

				// Fetch actual cost from OpenRouter's generation endpoint
				// Note: Data may not be immediately available, so we retry with delay
				let cost: number | undefined;
				let inputTokens = data.usage?.prompt_tokens;
				let outputTokens = data.usage?.completion_tokens;

				const fetchGenerationStats = async (retries = 3, delayMs = 300): Promise<void> => {
					for (let attempt = 0; attempt < retries; attempt++) {
						if (attempt > 0) {
							await new Promise(resolve => setTimeout(resolve, delayMs));
						}
						try {
							const genResponse = await fetch(
								`https://openrouter.ai/api/v1/generation?id=${data.id}`,
								{
									headers: {
										Authorization: `Bearer ${this.apiKey}`,
									},
								}
							);

							if (genResponse.ok) {
								const genData = (await genResponse.json()) as OpenRouterGenerationResponse;
								if (genData.data?.total_cost !== undefined) {
									cost = genData.data.total_cost;
									// Use native token counts from generation endpoint (more accurate)
									if (genData.data.tokens_prompt !== undefined) {
										inputTokens = genData.data.tokens_prompt;
									}
									if (genData.data.tokens_completion !== undefined) {
										outputTokens = genData.data.tokens_completion;
									}
									return; // Success, exit retry loop
								}
							}
						} catch {
							// Continue to next retry
						}
					}
				};

				await fetchGenerationStats();

				return {
					content,
					model: data.model,
					usage: inputTokens !== undefined && outputTokens !== undefined
						? {
								inputTokens,
								outputTokens,
								cost,
							}
						: undefined,
				};
			} catch (error) {
				clearTimeout(timeoutId);

				if (error instanceof Error && error.name === "AbortError") {
					throw new Error(`OpenRouter API request timed out after ${this.timeout}ms`);
				}
				throw error;
			}
		});
	}

	/**
	 * Convert messages to OpenRouter format
	 */
	private convertMessages(
		messages: LLMMessage[],
		systemPrompt?: string
	): OpenRouterMessage[] {
		const result: OpenRouterMessage[] = [];

		// Add system prompt if provided
		if (systemPrompt) {
			result.push({ role: "system", content: systemPrompt });
		}

		// Add all messages
		for (const msg of messages) {
			result.push({
				role: msg.role,
				content: msg.content,
			});
		}

		return result;
	}

	/**
	 * Retry with special handling for rate limits.
	 * Uses longer delays and more retries for 429 errors (common with free models).
	 */
	private async withRateLimitRetry<T>(fn: () => Promise<T>): Promise<T> {
		let lastError: Error | undefined;

		for (let attempt = 0; attempt < RATE_LIMIT_MAX_RETRIES; attempt++) {
			try {
				return await fn();
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));

				// Don't retry on auth or payment errors
				if (
					lastError.message.includes("401") ||
					lastError.message.includes("403") ||
					lastError.message.includes("invalid") ||
					lastError.message.includes("payment required")
				) {
					throw lastError;
				}

				// Check if it's a rate limit error
				const isRateLimit = lastError.message.includes("rate limit");

				if (attempt < RATE_LIMIT_MAX_RETRIES - 1) {
					// Use retry-after if available, otherwise exponential backoff
					const retryAfterMs = (error as Error & { retryAfterMs?: number }).retryAfterMs;
					const baseDelay = isRateLimit ? RATE_LIMIT_BASE_DELAY_MS : 1000;
					const delay = retryAfterMs || baseDelay * Math.pow(2, attempt);

					await this.sleep(delay);
				}
			}
		}

		throw lastError || new Error("Failed after retries");
	}
}
