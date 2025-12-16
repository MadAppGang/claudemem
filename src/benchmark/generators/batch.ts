/**
 * Batch Summary Generator
 *
 * Special generator for Anthropic Batch API that queues all requests
 * and submits them as a single batch for processing.
 *
 * 50% cheaper than regular API, ideal for benchmarks.
 */

import type {
	CodeChunk,
	FileSummary,
	ILLMClient,
	SymbolSummary,
} from "../../types.js";
import type {
	GenerationResult,
	GeneratorInfo,
	ISummaryGenerator,
	UsageStats,
} from "../types.js";
import { AnthropicBatchLLMClient } from "../../llm/providers/anthropic-batch.js";

// ============================================================================
// Types
// ============================================================================

interface QueuedRequest {
	type: "file" | "symbol";
	id: string;
	prompt: string;
	systemPrompt: string;
	startTime: number;
	// For file summaries
	filePath?: string;
	fileContent?: string;
	language?: string;
	codeChunks?: CodeChunk[];
	// For symbol summaries
	chunk?: CodeChunk;
	// Promise resolution
	resolve: (result: GenerationResult<FileSummary | SymbolSummary>) => void;
	reject: (error: Error) => void;
}

// ============================================================================
// Batch Summary Generator
// ============================================================================

export class BatchSummaryGenerator implements ISummaryGenerator {
	private batchClient: AnthropicBatchLLMClient;
	private info: GeneratorInfo;
	private accumulatedUsage: UsageStats;
	private requestQueue: Map<string, QueuedRequest> = new Map();
	private requestCounter = 0;

	/** Flag to identify this as a batch generator */
	readonly isBatch = true;

	constructor(batchClient: AnthropicBatchLLMClient, info: GeneratorInfo) {
		this.batchClient = batchClient;
		this.info = info;
		this.accumulatedUsage = { inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 };
	}

	/**
	 * Queue a file summary request.
	 * Returns a promise that resolves when flushBatch() completes.
	 */
	async generateFileSummary(
		filePath: string,
		fileContent: string,
		language: string,
		codeChunks: CodeChunk[]
	): Promise<GenerationResult<FileSummary>> {
		return new Promise((resolve, reject) => {
			const id = `file_${this.requestCounter++}`;
			const startTime = Date.now();

			// Build prompt using same format as FileSummaryExtractor
			const { systemPrompt, userPrompt } = this.buildFileSummaryPrompt(
				filePath,
				fileContent,
				language,
				codeChunks
			);

			this.requestQueue.set(id, {
				type: "file",
				id,
				prompt: userPrompt,
				systemPrompt,
				startTime,
				filePath,
				fileContent,
				language,
				codeChunks,
				resolve: resolve as (result: GenerationResult<FileSummary | SymbolSummary>) => void,
				reject,
			});
		});
	}

	/**
	 * Queue a symbol summary request.
	 * Returns a promise that resolves when flushBatch() completes.
	 */
	async generateSymbolSummary(
		chunk: CodeChunk,
		fileContent: string,
		language: string
	): Promise<GenerationResult<SymbolSummary>> {
		return new Promise((resolve, reject) => {
			const id = `symbol_${this.requestCounter++}`;
			const startTime = Date.now();

			// Build prompt using same format as SymbolSummaryExtractor
			const { systemPrompt, userPrompt } = this.buildSymbolSummaryPrompt(
				chunk,
				fileContent,
				language
			);

			this.requestQueue.set(id, {
				type: "symbol",
				id,
				prompt: userPrompt,
				systemPrompt,
				startTime,
				chunk,
				resolve: resolve as (result: GenerationResult<FileSummary | SymbolSummary>) => void,
				reject,
			});
		});
	}

	/**
	 * Get the number of queued requests.
	 */
	getQueueSize(): number {
		return this.requestQueue.size;
	}

	/**
	 * Submit all queued requests as a batch and wait for results.
	 * This resolves all the promises returned by generateFileSummary/generateSymbolSummary.
	 */
	async flushBatch(): Promise<void> {
		if (this.requestQueue.size === 0) {
			return;
		}

		// Submit all requests to the batch client
		const requestPromises: Array<Promise<void>> = [];
		const requestMap = new Map<string, QueuedRequest>();

		for (const [id, request] of this.requestQueue) {
			requestMap.set(id, request);

			// Queue the request in the batch client
			const clientPromise = this.batchClient.complete(
				[
					{ role: "user", content: request.prompt }
				],
				{
					systemPrompt: request.systemPrompt,
					maxTokens: 4096,
				}
			).then(response => {
				const durationMs = Date.now() - request.startTime;

				try {
					// Parse the JSON response
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

					const parsed = JSON.parse(content);

					// Build the result
					const result: GenerationResult<FileSummary | SymbolSummary> = {
						result: request.type === "file"
							? this.parseFileSummaryResponse(parsed, request)
							: this.parseSymbolSummaryResponse(parsed, request),
						durationMs,
						usage: {
							inputTokens: response.usage?.inputTokens || 0,
							outputTokens: response.usage?.outputTokens || 0,
							cost: response.usage?.cost || 0,
						},
					};

					// Accumulate usage
					this.accumulateUsage(result.usage);

					request.resolve(result);
				} catch (parseError) {
					request.reject(new Error(
						`Failed to parse response: ${parseError instanceof Error ? parseError.message : String(parseError)}`
					));
				}
			}).catch(error => {
				request.reject(error instanceof Error ? error : new Error(String(error)));
			});

			requestPromises.push(clientPromise as Promise<void>);
		}

		// Flush the batch client (this submits to API and waits for results)
		await this.batchClient.flushBatch();

		// Wait for all promise handlers to complete
		await Promise.allSettled(requestPromises);

		// Clear the queue
		this.requestQueue.clear();
	}

	getInfo(): GeneratorInfo {
		return { ...this.info };
	}

	getUsage(): UsageStats {
		return { ...this.accumulatedUsage };
	}

	resetUsage(): void {
		this.accumulatedUsage = { inputTokens: 0, outputTokens: 0, cost: 0, calls: 0 };
		this.requestQueue.clear();
		this.requestCounter = 0;
	}

	private accumulateUsage(usage: { inputTokens: number; outputTokens: number; cost: number }): void {
		this.accumulatedUsage.inputTokens += usage.inputTokens;
		this.accumulatedUsage.outputTokens += usage.outputTokens;
		this.accumulatedUsage.cost += usage.cost;
		this.accumulatedUsage.calls += 1;
	}

	// ============================================================================
	// Prompt Building (matching extractors)
	// ============================================================================

	private buildFileSummaryPrompt(
		filePath: string,
		fileContent: string,
		language: string,
		codeChunks: CodeChunk[]
	): { systemPrompt: string; userPrompt: string } {
		const systemPrompt = `You are a code documentation expert. Analyze the provided source file and generate a comprehensive summary.

Output JSON with this structure:
{
  "summary": "2-3 sentence overview of the file's purpose",
  "responsibilities": ["list", "of", "key", "responsibilities"],
  "exports": ["list", "of", "exported", "symbols"],
  "dependencies": ["list", "of", "imported", "modules"],
  "patterns": ["design", "patterns", "used"],
  "complexity": "low|medium|high"
}

Be concise but comprehensive. Focus on what a developer needs to understand to work with this code.`;

		const chunkSummary = codeChunks
			.filter(c => c.name && (c.chunkType === "function" || c.chunkType === "class" || c.chunkType === "method"))
			.slice(0, 20)
			.map(c => `- ${c.chunkType}: ${c.name}${c.signature ? ` - ${c.signature}` : ""}`)
			.join("\n");

		const userPrompt = `Analyze this ${language} file: ${filePath}

Key symbols found:
${chunkSummary || "(no symbols extracted)"}

File content:
\`\`\`${language}
${fileContent.slice(0, 8000)}
\`\`\`

Generate a JSON summary following the schema in your instructions.`;

		return { systemPrompt, userPrompt };
	}

	private buildSymbolSummaryPrompt(
		chunk: CodeChunk,
		fileContent: string,
		language: string
	): { systemPrompt: string; userPrompt: string } {
		const systemPrompt = `You are a code documentation expert. Analyze the provided code symbol and generate a detailed summary.

Output JSON with this structure:
{
  "summary": "1-2 sentence description of what this symbol does",
  "parameters": [{"name": "paramName", "description": "what it's for"}],
  "returnDescription": "what the function returns (if applicable)",
  "sideEffects": ["list", "of", "side", "effects"],
  "usageContext": "when/why to use this symbol",
  "complexity": "low|medium|high"
}

Be precise and helpful. Focus on what a developer needs to understand to use this code correctly.`;

		const userPrompt = `Analyze this ${language} ${chunk.chunkType}: ${chunk.name}

${chunk.signature ? `Signature: ${chunk.signature}` : ""}

Code:
\`\`\`${language}
${chunk.content.slice(0, 4000)}
\`\`\`

Generate a JSON summary following the schema in your instructions.`;

		return { systemPrompt, userPrompt };
	}

	// ============================================================================
	// Response Parsing
	// ============================================================================

	private parseFileSummaryResponse(parsed: Record<string, unknown>, request: QueuedRequest): FileSummary {
		return {
			type: "file-summary",
			filePath: request.filePath!,
			summary: String(parsed.summary || ""),
			responsibilities: Array.isArray(parsed.responsibilities) ? parsed.responsibilities : [],
			exports: Array.isArray(parsed.exports) ? parsed.exports : [],
			dependencies: Array.isArray(parsed.dependencies) ? parsed.dependencies : [],
			patterns: Array.isArray(parsed.patterns) ? parsed.patterns : [],
			complexity: (parsed.complexity as "low" | "medium" | "high") || "medium",
		};
	}

	private parseSymbolSummaryResponse(parsed: Record<string, unknown>, request: QueuedRequest): SymbolSummary {
		return {
			type: "symbol-summary",
			symbolName: request.chunk!.name || "unknown",
			symbolType: request.chunk!.chunkType,
			filePath: request.chunk!.filePath,
			summary: String(parsed.summary || ""),
			parameters: Array.isArray(parsed.parameters) ? parsed.parameters : [],
			returnDescription: parsed.returnDescription ? String(parsed.returnDescription) : undefined,
			sideEffects: Array.isArray(parsed.sideEffects) ? parsed.sideEffects : [],
			usageContext: parsed.usageContext ? String(parsed.usageContext) : undefined,
			complexity: (parsed.complexity as "low" | "medium" | "high") || "medium",
		};
	}
}

/**
 * Check if a generator is a batch generator.
 */
export function isBatchGenerator(generator: ISummaryGenerator): generator is BatchSummaryGenerator {
	return "isBatch" in generator && (generator as BatchSummaryGenerator).isBatch === true;
}
