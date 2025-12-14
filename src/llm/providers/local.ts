/**
 * Local LLM Provider
 *
 * Uses OpenAI-compatible API endpoints for local models.
 * Supports Ollama, LM Studio, and other local inference servers.
 */

import { BaseLLMClient, DEFAULT_LLM_MODELS } from "../client.js";
import type { LLMGenerateOptions, LLMMessage, LLMResponse } from "../../types.js";

// ============================================================================
// Types
// ============================================================================

interface LocalOptions {
	/** Endpoint URL (default: http://localhost:11434/v1 for Ollama) */
	endpoint?: string;
	/** Model to use */
	model?: string;
	/** Request timeout in ms */
	timeout?: number;
}

interface OpenAIMessage {
	role: "system" | "user" | "assistant";
	content: string;
}

interface OpenAIResponse {
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
// Local LLM Client (OpenAI-compatible)
// ============================================================================

const DEFAULT_ENDPOINT = "http://localhost:11434/v1";

export class LocalLLMClient extends BaseLLMClient {
	private endpoint: string;

	constructor(options: LocalOptions = {}) {
		super(
			"local",
			options.model || DEFAULT_LLM_MODELS.local,
			options.timeout || 300000 // Longer timeout for local models
		);

		this.endpoint = options.endpoint || DEFAULT_ENDPOINT;

		// Ensure endpoint ends without slash
		if (this.endpoint.endsWith("/")) {
			this.endpoint = this.endpoint.slice(0, -1);
		}
	}

	async complete(
		messages: LLMMessage[],
		options?: LLMGenerateOptions
	): Promise<LLMResponse> {
		return this.withRetry(async () => {
			// Convert messages to OpenAI format
			const openAIMessages = this.convertMessages(messages, options?.systemPrompt);

			// Build request body
			const body = {
				model: options?.model || this.model,
				messages: openAIMessages,
				...(options?.maxTokens && { max_tokens: options.maxTokens }),
				...(options?.temperature !== undefined && { temperature: options.temperature }),
				stream: false,
			};

			// Make API request
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), this.timeout);

			try {
				const url = `${this.endpoint}/chat/completions`;
				const response = await fetch(url, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
					signal: controller.signal,
				});

				clearTimeout(timeoutId);

				if (!response.ok) {
					const errorBody = await response.text();

					if (response.status === 404) {
						throw new Error(
							`Local model "${this.model}" not found. Make sure it's available on your local server.`
						);
					}

					throw new Error(`Local LLM API error (${response.status}): ${errorBody}`);
				}

				const data = (await response.json()) as OpenAIResponse;

				if (!data.choices || data.choices.length === 0) {
					throw new Error("Local LLM returned empty response");
				}

				const content = data.choices[0].message.content;

				return {
					content,
					model: data.model || this.model,
					usage: data.usage
						? {
								inputTokens: data.usage.prompt_tokens,
								outputTokens: data.usage.completion_tokens,
							}
						: undefined,
				};
			} catch (error) {
				clearTimeout(timeoutId);

				if (error instanceof Error) {
					if (error.name === "AbortError") {
						throw new Error(`Local LLM request timed out after ${this.timeout}ms`);
					}
					// Connection refused - server not running
					if (error.message.includes("ECONNREFUSED")) {
						throw new Error(
							`Cannot connect to local LLM at ${this.endpoint}. ` +
								"Make sure Ollama or LM Studio is running."
						);
					}
				}
				throw error;
			}
		});
	}

	/**
	 * Test if local server is available
	 */
	async testConnection(): Promise<boolean> {
		try {
			// Try a minimal completion
			const response = await this.complete(
				[{ role: "user", content: "Say 'ok'" }],
				{ maxTokens: 10 }
			);
			return response.content.length > 0;
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("ECONNREFUSED")) {
				console.warn(`Local LLM server not running at ${this.endpoint}`);
			} else if (msg.includes("not found")) {
				console.warn(`Local model "${this.model}" not available`);
			}
			return false;
		}
	}

	/**
	 * Convert messages to OpenAI format
	 */
	private convertMessages(
		messages: LLMMessage[],
		systemPrompt?: string
	): OpenAIMessage[] {
		const result: OpenAIMessage[] = [];

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
