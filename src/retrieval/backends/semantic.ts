/**
 * Semantic Backend
 *
 * Wraps the existing Indexer.search() (vector + BM25 hybrid) call.
 * Activated for: semantic, similarity, location
 */

import type { Indexer } from "../../core/indexer.js";
import type { QueryClassification } from "../../types.js";
import type {
	BackendName,
	BackendResult,
	ISearchBackend,
	SearchOptions,
} from "../pipeline/types.js";

export class SemanticBackend implements ISearchBackend {
	readonly name: BackendName = "semantic";

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
		const backendName = this.name;

		try {
			const searchResults = await indexer.search(query, {
				limit,
				useCase: "search",
			});

			if (signal.aborted) return [];

			// Filter by filePattern if provided
			const filePattern = options.filePattern;
			const filtered = filePattern
				? searchResults.filter((r) => {
						const pat = filePattern
							.replace(/\*\*/g, ".*")
							.replace(/\*/g, "[^/]*");
						return new RegExp(pat).test(r.chunk.filePath);
					})
				: searchResults;

			if (filtered.length === 0) return [];

			// Normalize scores to [0, 1] by dividing by max score
			const maxScore = Math.max(...filtered.map((r) => r.score));
			const normalizer = maxScore > 0 ? maxScore : 1;

			// Observations are returned like any other result. `id` is the
			// chunk digest: merge uses it only for results with no usable code
			// anchor (observations, stored with startLine 0) — anchored results
			// key on file:startLine so they fuse with the other backends.
			return filtered.map((r): BackendResult => {
				return {
					id: r.chunk.id,
					file: r.chunk.filePath,
					startLine: r.chunk.startLine,
					endLine: r.chunk.endLine,
					symbol: r.chunk.name ?? undefined,
					snippet: r.chunk.content.slice(0, 800),
					score: r.score / normalizer,
					backend: backendName,
					documentType: r.documentType,
					observationMetadata: r.observationMetadata,
				};
			});
		} finally {
			await indexer.close().catch(() => {});
		}
	}
}
