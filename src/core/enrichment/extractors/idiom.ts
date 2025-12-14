/**
 * Idiom Extractor
 *
 * Identifies coding patterns, conventions, and idioms used in the codebase.
 * Extracts: pattern category, example code, rationale, applicability.
 */

import type {
	BaseDocument,
	ExtractionContext,
	Idiom,
	ILLMClient,
} from "../../../types.js";
import {
	buildIdiomPrompt,
	getSystemPrompt,
} from "../../../llm/prompts/enrichment.js";
import { BaseExtractor } from "./base.js";

// ============================================================================
// Types
// ============================================================================

interface IdiomLLMResponse {
	idioms: Array<{
		category: string;
		pattern: string;
		example: string;
		rationale: string;
		appliesTo: string[];
	}>;
}

// ============================================================================
// Idiom Extractor
// ============================================================================

export class IdiomExtractor extends BaseExtractor {
	constructor() {
		super("idiom", ["code_chunk", "file_summary"]);
	}

	async extract(
		context: ExtractionContext,
		llmClient: ILLMClient,
	): Promise<BaseDocument[]> {
		// Skip if too few chunks
		if (context.codeChunks.length < 3) {
			return [];
		}

		try {
			// Build prompt with representative chunks
			const userPrompt = buildIdiomPrompt(context.codeChunks, context.language);

			// Call LLM
			const response = await llmClient.completeJSON<IdiomLLMResponse>(
				[{ role: "user", content: userPrompt }],
				{ systemPrompt: getSystemPrompt("idiom") },
			);

			if (!response.idioms || response.idioms.length === 0) {
				return [];
			}

			// Create documents for each idiom
			const documents: Idiom[] = [];

			for (const idiom of response.idioms) {
				const content = this.buildContent(idiom);
				const id = this.generateId(content, context.filePath, idiom.pattern);

				documents.push({
					id,
					content,
					documentType: "idiom",
					filePath: context.filePath,
					fileHash: context.codeChunks[0]?.fileHash,
					createdAt: new Date().toISOString(),
					enrichedAt: new Date().toISOString(),
					sourceIds: context.codeChunks.map((c) => c.id),
					category: idiom.category,
					language: context.language,
					pattern: idiom.pattern,
					example: idiom.example,
					rationale: idiom.rationale,
					appliesTo: idiom.appliesTo || [],
				});
			}

			return documents;
		} catch (error) {
			console.warn(
				`Failed to extract idioms for ${context.filePath}:`,
				error instanceof Error ? error.message : error,
			);
			return [];
		}
	}

	/**
	 * Build searchable content from the idiom
	 */
	private buildContent(idiom: IdiomLLMResponse["idioms"][0]): string {
		return [
			`Pattern: ${idiom.pattern}`,
			`Category: ${idiom.category}`,
			`\nRationale: ${idiom.rationale}`,
			`\nApplies to: ${idiom.appliesTo.join(", ")}`,
			`\nExample:\n${idiom.example}`,
		].join("\n");
	}
}

// ============================================================================
// Factory Function
// ============================================================================

export function createIdiomExtractor(): IdiomExtractor {
	return new IdiomExtractor();
}
