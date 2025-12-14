/**
 * OpenRouter LLM Provider
 *
 * Uses OpenRouter's chat completions API to access various models.
 * Reuses patterns from the embeddings OpenRouter client.
 */

import { BaseLLMClient, DEFAULT_LLM_MODELS } from "../client.js";
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

// ============================================================================
// OpenRouter API Client
// ============================================================================

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

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
		return this.withRetry(async () => {
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
					signal: controller.signal,
				});

				clearTimeout(timeoutId);

				if (!response.ok) {
					const errorBody = await response.text();

					if (response.status === 401) {
						throw new Error("OpenRouter API key is invalid");
					} else if (response.status === 429) {
						throw new Error("OpenRouter rate limit exceeded");
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

				return {
					content,
					model: data.model,
					usage: data.usage
						? {
								inputTokens: data.usage.prompt_tokens,
								outputTokens: data.usage.completion_tokens,
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
}
