/**
 * Embeddings Client
 *
 * Multi-provider embedding generation supporting:
 * - OpenRouter (cloud API)
 * - Ollama (local)
 * - Custom endpoints (local HTTP servers)
 */

import {
	OPENROUTER_EMBEDDINGS_URL,
	OPENROUTER_HEADERS,
	getApiKey,
	loadGlobalConfig,
} from "../config.js";
import type { EmbeddingProgressCallback, EmbeddingProvider, EmbeddingResponse, EmbedResult, IEmbeddingsClient } from "../types.js";

// ============================================================================
// Constants
// ============================================================================

/** Maximum texts per batch request (OpenRouter) - smaller = more granular progress */
const MAX_BATCH_SIZE = 20;

/** Maximum retries for failed requests */
const MAX_RETRIES = 3;

/** Base delay for exponential backoff (ms) */
const BASE_RETRY_DELAY = 1000;

/** Default embedding model per provider */
const DEFAULT_MODELS: Record<EmbeddingProvider, string> = {
	openrouter: "qwen/qwen3-embedding-8b",
	ollama: "nomic-embed-text",
	local: "all-minilm-l6-v2",
};

/** Default endpoints */
const DEFAULT_OLLAMA_ENDPOINT = "http://localhost:11434";
const DEFAULT_LOCAL_ENDPOINT = "http://localhost:8000";

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
		/** Cost in USD (OpenRouter provides this directly) */
		cost?: number;
	};
}

interface OllamaEmbeddingResponse {
	embedding: number[];
}

export interface EmbeddingsClientOptions {
	/** Embedding provider */
	provider?: EmbeddingProvider;
	/** Model to use for embeddings */
	model?: string;
	/** API key (for OpenRouter) */
	apiKey?: string;
	/** Endpoint URL (for Ollama/local) */
	endpoint?: string;
	/** Request timeout in ms */
	timeout?: number;
}

// ============================================================================
// Base Client Class
// ============================================================================

abstract class BaseEmbeddingsClient implements IEmbeddingsClient {
	protected model: string;
	protected timeout: number;
	protected dimension?: number;

	constructor(model: string, timeout = 60000) {
		this.model = model;
		this.timeout = timeout;
	}

	getModel(): string {
		return this.model;
	}

	getDimension(): number | undefined {
		return this.dimension;
	}

	abstract embed(texts: string[], onProgress?: EmbeddingProgressCallback): Promise<EmbedResult>;

	async embedOne(text: string): Promise<number[]> {
		const result = await this.embed([text]);
		return result.embeddings[0];
	}

	protected sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}

// ============================================================================
// OpenRouter Client
// ============================================================================

export class OpenRouterEmbeddingsClient extends BaseEmbeddingsClient {
	private apiKey: string;

	constructor(options: EmbeddingsClientOptions = {}) {
		super(
			options.model || DEFAULT_MODELS.openrouter,
			options.timeout,
		);

		const apiKey = options.apiKey || getApiKey();
		if (!apiKey) {
			throw new Error(
				"OpenRouter API key required. Set OPENROUTER_API_KEY environment variable or run 'claudemem init'",
			);
		}
		this.apiKey = apiKey;
	}

	async embed(texts: string[], onProgress?: EmbeddingProgressCallback): Promise<EmbedResult> {
		if (texts.length === 0) return { embeddings: [] };

		// Split into batches
		const batches: string[][] = [];
		for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
			batches.push(texts.slice(i, i + MAX_BATCH_SIZE));
		}

		// Process batches in parallel (up to 3 at a time for good balance)
		const PARALLEL_BATCHES = 3;
		const results: number[][] = new Array(texts.length);
		let resultIndex = 0;
		let completedTexts = 0;
		let totalTokens = 0;
		let totalCost = 0;

		for (let i = 0; i < batches.length; i += PARALLEL_BATCHES) {
			const batchGroup = batches.slice(i, i + PARALLEL_BATCHES);
			const inProgressCount = batchGroup.reduce((sum, b) => sum + b.length, 0);

			// Report "starting to process" with in-progress count (for animation)
			if (onProgress) {
				onProgress(completedTexts, texts.length, inProgressCount);
			}

			const batchPromises = batchGroup.map((batch) => this.embedBatch(batch));
			const batchResults = await Promise.all(batchPromises);

			for (const batchResult of batchResults) {
				for (const embedding of batchResult.embeddings) {
					results[resultIndex++] = embedding;
				}
				completedTexts += batchResult.embeddings.length;
				if (batchResult.totalTokens) totalTokens += batchResult.totalTokens;
				if (batchResult.cost) totalCost += batchResult.cost;
			}
		}

		// Final progress report (all complete)
		if (onProgress) {
			onProgress(completedTexts, texts.length, 0);
		}

		return {
			embeddings: results,
			totalTokens: totalTokens > 0 ? totalTokens : undefined,
			cost: totalCost > 0 ? totalCost : undefined,
		};
	}

	private async embedBatch(texts: string[]): Promise<EmbedResult> {
		let lastError: Error | undefined;

		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			try {
				const response = await this.makeRequest(texts);

				if (response.embeddings.length > 0 && !this.dimension) {
					this.dimension = response.embeddings[0].length;
				}

				return {
					embeddings: response.embeddings,
					totalTokens: response.usage?.totalTokens,
					cost: response.usage?.cost,
				};
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));

				// Don't retry on authentication errors
				if (lastError.message.includes("401") || lastError.message.includes("403")) {
					throw lastError;
				}

				if (attempt < MAX_RETRIES - 1) {
					const delay = BASE_RETRY_DELAY * Math.pow(2, attempt);
					await this.sleep(delay);
				}
			}
		}

		throw lastError || new Error("Failed to generate embeddings");
	}

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
				throw new Error(`OpenRouter API error: ${response.status} - ${errorText}`);
			}

			const data: OpenRouterEmbeddingResponse = await response.json();
			const sorted = [...data.data].sort((a, b) => a.index - b.index);

			return {
				embeddings: sorted.map((item) => item.embedding),
				model: data.model,
				usage: data.usage
					? {
							promptTokens: data.usage.prompt_tokens,
							totalTokens: data.usage.total_tokens,
							cost: data.usage.cost,
						}
					: undefined,
			};
		} finally {
			clearTimeout(timeoutId);
		}
	}
}

// ============================================================================
// Ollama Client
// ============================================================================

export class OllamaEmbeddingsClient extends BaseEmbeddingsClient {
	private endpoint: string;

	constructor(options: EmbeddingsClientOptions = {}) {
		super(
			options.model || DEFAULT_MODELS.ollama,
			options.timeout,
		);
		this.endpoint = options.endpoint || DEFAULT_OLLAMA_ENDPOINT;
	}

	async embed(texts: string[], onProgress?: EmbeddingProgressCallback): Promise<EmbedResult> {
		if (texts.length === 0) return { embeddings: [] };

		// Ollama processes one text at a time
		const results: number[][] = [];
		for (let i = 0; i < texts.length; i++) {
			// Report "starting to process" (1 item at a time)
			if (onProgress) {
				onProgress(i, texts.length, 1);
			}

			const embedding = await this.embedSingle(texts[i]);
			results.push(embedding);

			// Store dimension on first result
			if (!this.dimension && embedding.length > 0) {
				this.dimension = embedding.length;
			}
		}

		// Final progress report
		if (onProgress) {
			onProgress(texts.length, texts.length, 0);
		}

		// Ollama doesn't report cost (local model)
		return { embeddings: results };
	}

	private async embedSingle(text: string): Promise<number[]> {
		let lastError: Error | undefined;

		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), this.timeout);

				try {
					const response = await fetch(`${this.endpoint}/api/embeddings`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							model: this.model,
							prompt: text,
						}),
						signal: controller.signal,
					});

					if (!response.ok) {
						const errorText = await response.text();
						throw new Error(`Ollama API error: ${response.status} - ${errorText}`);
					}

					const data: OllamaEmbeddingResponse = await response.json();
					return data.embedding;
				} finally {
					clearTimeout(timeoutId);
				}
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));

				// Check if Ollama is not running
				if (lastError.message.includes("ECONNREFUSED")) {
					throw new Error(
						`Cannot connect to Ollama at ${this.endpoint}. Is Ollama running? Try: ollama serve`,
					);
				}

				if (attempt < MAX_RETRIES - 1) {
					const delay = BASE_RETRY_DELAY * Math.pow(2, attempt);
					await this.sleep(delay);
				}
			}
		}

		throw lastError || new Error("Failed to generate embeddings");
	}
}

// ============================================================================
// Local/Custom Endpoint Client
// ============================================================================

export class LocalEmbeddingsClient extends BaseEmbeddingsClient {
	private endpoint: string;

	constructor(options: EmbeddingsClientOptions = {}) {
		super(
			options.model || DEFAULT_MODELS.local,
			options.timeout,
		);
		this.endpoint = options.endpoint || DEFAULT_LOCAL_ENDPOINT;
	}

	async embed(texts: string[], onProgress?: EmbeddingProgressCallback): Promise<EmbedResult> {
		if (texts.length === 0) return { embeddings: [] };

		// Report "starting to process" (all texts at once)
		if (onProgress) {
			onProgress(0, texts.length, texts.length);
		}

		let lastError: Error | undefined;

		for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), this.timeout);

				try {
					// OpenAI-compatible format
					const response = await fetch(`${this.endpoint}/embeddings`, {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							model: this.model,
							input: texts,
						}),
						signal: controller.signal,
					});

					if (!response.ok) {
						const errorText = await response.text();
						throw new Error(`Local API error: ${response.status} - ${errorText}`);
					}

					const data: OpenRouterEmbeddingResponse = await response.json();
					const sorted = [...data.data].sort((a, b) => a.index - b.index);
					const embeddings = sorted.map((item) => item.embedding);

					if (embeddings.length > 0 && !this.dimension) {
						this.dimension = embeddings[0].length;
					}

					// Report completion
					if (onProgress) {
						onProgress(texts.length, texts.length, 0);
					}

					// Local server doesn't report cost
					return { embeddings };
				} finally {
					clearTimeout(timeoutId);
				}
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));

				if (lastError.message.includes("ECONNREFUSED")) {
					throw new Error(
						`Cannot connect to local embedding server at ${this.endpoint}. Is it running?`,
					);
				}

				if (attempt < MAX_RETRIES - 1) {
					const delay = BASE_RETRY_DELAY * Math.pow(2, attempt);
					await this.sleep(delay);
				}
			}
		}

		throw lastError || new Error("Failed to generate embeddings");
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an embeddings client based on provider
 */
export function createEmbeddingsClient(
	options?: EmbeddingsClientOptions,
): IEmbeddingsClient {
	// Determine provider from options or config
	const config = loadGlobalConfig();
	const provider = options?.provider || config.embeddingProvider || "openrouter";

	switch (provider) {
		case "ollama":
			return new OllamaEmbeddingsClient({
				...options,
				endpoint: options?.endpoint || config.ollamaEndpoint,
			});

		case "local":
			return new LocalEmbeddingsClient({
				...options,
				endpoint: options?.endpoint || config.localEndpoint,
			});

		case "openrouter":
		default:
			return new OpenRouterEmbeddingsClient(options);
	}
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Estimate the number of tokens in a text
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

/**
 * Test connection to an embedding provider
 */
export async function testProviderConnection(
	provider: EmbeddingProvider,
	endpoint?: string,
): Promise<{ ok: boolean; error?: string }> {
	try {
		const client = createEmbeddingsClient({
			provider,
			endpoint,
		});
		await client.embedOne("test");
		return { ok: true };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
