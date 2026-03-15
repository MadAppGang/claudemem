/**
 * Semantic Backend
 *
 * Wraps the existing Indexer.search() (vector + BM25 hybrid) call.
 * Activated for: semantic, similarity, location
 */

import type { QueryClassification } from "../../types.js";
import type { Indexer } from "../../core/indexer.js";
import type { ISearchBackend, BackendResult, SearchOptions } from "../pipeline/types.js";

export class SemanticBackend implements ISearchBackend {
	readonly name = "semantic" as const;

	constructor(private createIndexer: () => Indexer) {}

	async search(
		query: string,
		_intent: QueryClassification,
		options: SearchOptions,
		signal: AbortSignal,
	): Promise<BackendResult[]> {
		if (signal.aborted) return [];

		const limit = options.limit ?? 10;
		const indexer = this.createIndexer();

		try {
			const searchResults = await indexer.search(query, {
				limit,
				useCase: "search",
			});

			if (signal.aborted) return [];

			// Filter by filePattern if provided
			const filtered = options.filePattern
				? searchResults.filter((r) => {
						const pat = options.filePattern!
							.replace(/\*\*/g, ".*")
							.replace(/\*/g, "[^/]*");
						return new RegExp(pat).test(r.chunk.filePath);
					})
				: searchResults;

			if (filtered.length === 0) return [];

			// Normalize scores to [0, 1] by dividing by max score
			const maxScore = Math.max(...filtered.map((r) => r.score));
			const normalizer = maxScore > 0 ? maxScore : 1;

			return filtered.map((r) => {
				if (r.documentType === "session_observation") {
					return {
						file: "",
						startLine: 0,
						snippet: r.chunk.content.slice(0, 800),
						score: r.score / normalizer,
						backend: this.name as const,
					};
				}
				return {
					file: r.chunk.filePath,
					startLine: r.chunk.startLine,
					endLine: r.chunk.endLine,
					symbol: r.chunk.name ?? undefined,
					snippet: r.chunk.content.slice(0, 800),
					score: r.score / normalizer,
					backend: this.name as const,
				};
			}).filter((r) => r.file !== "");
		} finally {
			await indexer.close().catch(() => {});
		}
	}
}
