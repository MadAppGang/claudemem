/**
 * OpenRouter Embeddings Client
 *
 * Handles embedding generation through OpenRouter's API,
 * with batching, retry logic, and rate limiting.
 */

import {
	OPENROUTER_EMBEDDINGS_URL,
	OPENROUTER_HEADERS,
	getApiKey,
} from "../config.js";
import type { EmbeddingResponse } from "../types.js";

// ============================================================================
// Constants
// ============================================================================

/** Maximum texts per batch request */
const MAX_BATCH_SIZE = 100;

/** Maximum retries for failed requests */
const MAX_RETRIES = 3;

/** Base delay for exponential backoff (ms) */
const BASE_RETRY_DELAY = 1000;

/** Default embedding model */
const DEFAULT_MODEL = "qwen/qwen3-embedding-8b";

// ============================================================================
// Types
// ============================================================================

interface OpenRouterEmbeddingResponse {
	data: Array<{
		embedding: number[];
		index: number;
	}>;
	model: string;
	usage?: {
		prompt_tokens: number;
		total_tokens: number;
	};
}

interface EmbeddingsClientOptions {
	/** Model to use for embeddings */
	model?: string;
	/** API key (defaults to env/config) */
	apiKey?: string;
	/** Request timeout in ms */
	timeout?: number;
}

// ============================================================================
// Embeddings Client Class
// ============================================================================

export class EmbeddingsClient {
	private model: string;
	private apiKey: string;
	private timeout: number;
	private dimension?: number;

	constructor(options: EmbeddingsClientOptions = {}) {
		this.model = options.model || DEFAULT_MODEL;
		this.timeout = options.timeout || 60000;

		const apiKey = options.apiKey || getApiKey();
		if (!apiKey) {
			throw new Error(
				"OpenRouter API key required. Set OPENROUTER_API_KEY environment variable or configure in ~/.claudemem/config.json",
			);
		}
		this.apiKey = apiKey;
	}

	/**
	 * Get the model being used
	 */
	getModel(): string {
		return this.model;
	}

	/**
	 * Get the embedding dimension (discovered after first request)
	 */
	getDimension(): number | undefined {
		return this.dimension;
	}

	/**
	 * Generate embeddings for a single text
	 */
	async embedOne(text: string): Promise<number[]> {
		const result = await this.embed([text]);
		return result[0];
	}

	/**
	 * Generate embeddings for multiple texts
	 *
	 * Automatically batches requests if input exceeds MAX_BATCH_SIZE
	 */
	async embed(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) {
			return [];
		}

		// Split into batches
		const batches: string[][] = [];
		for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
			batches.push(texts.slice(i, i + MAX_BATCH_SIZE));
		}

		// Process batches
		const results: number[][] = [];
		for (const batch of batches) {
			const batchResults = await this.embedBatch(batch);
			results.push(...batchResults);
		}

		return results;
	}

	/**
	 * Process a single batch of texts
	 */
	private async embedBatch(texts: string[]): Promise<number[][]> {
		let lastError: Error | undefined;

		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			try {
				const response = await this.makeRequest(texts);

				// Store dimension for later reference
				if (response.embeddings.length > 0 && !this.dimension) {
					this.dimension = response.embeddings[0].length;
				}

				return response.embeddings;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));

				// Don't retry on authentication errors
				if (
					lastError.message.includes("401") ||
					lastError.message.includes("403")
				) {
					throw lastError;
				}

				// Exponential backoff
				if (attempt < MAX_RETRIES - 1) {
					const delay = BASE_RETRY_DELAY * Math.pow(2, attempt);
					await this.sleep(delay);
				}
			}
		}

		throw lastError || new Error("Failed to generate embeddings");
	}

	/**
	 * Make a single API request
	 */
	private async makeRequest(texts: string[]): Promise<EmbeddingResponse> {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), this.timeout);

		try {
			const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.apiKey}`,
					"Content-Type": "application/json",
					...OPENROUTER_HEADERS,
				},
				body: JSON.stringify({
					model: this.model,
					input: texts,
				}),
				signal: controller.signal,
			});

			if (!response.ok) {
				const errorText = await response.text();
				throw new Error(
					`OpenRouter API error: ${response.status} - ${errorText}`,
				);
			}

			const data: OpenRouterEmbeddingResponse = await response.json();

			// Sort by index to maintain order
			const sorted = [...data.data].sort((a, b) => a.index - b.index);

			return {
				embeddings: sorted.map((item) => item.embedding),
				model: data.model,
				usage: data.usage
					? {
							promptTokens: data.usage.prompt_tokens,
							totalTokens: data.usage.total_tokens,
						}
					: undefined,
			};
		} finally {
			clearTimeout(timeoutId);
		}
	}

	/**
	 * Sleep for a given duration
	 */
	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an embeddings client with the given options
 */
export function createEmbeddingsClient(
	options?: EmbeddingsClientOptions,
): EmbeddingsClient {
	return new EmbeddingsClient(options);
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Estimate the number of tokens in a text
 *
 * Simple approximation: ~4 characters per token for code
 */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

/**
 * Check if a text is too long for the model's context window
 */
export function isTextTooLong(text: string, maxTokens: number): boolean {
	return estimateTokens(text) > maxTokens;
}

/**
 * Truncate text to fit within token limit
 */
export function truncateToTokenLimit(text: string, maxTokens: number): string {
	const maxChars = maxTokens * 4;
	if (text.length <= maxChars) {
		return text;
	}
	return text.slice(0, maxChars - 3) + "...";
}
