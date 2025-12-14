/**
 * Enriched Retriever
 *
 * Multi-type retrieval orchestrator for enriched RAG.
 * Provides use-case optimized search with configurable weights.
 */

import type {
	DocumentType,
	EnrichedSearchOptions,
	EnrichedSearchResult,
	IEmbeddingsClient,
	SearchUseCase,
} from "../types.js";
import type { VectorStore } from "../core/store.js";

// ============================================================================
// Default Weights
// ============================================================================

/**
 * Default weights per document type for each use case.
 * These can be overridden via project config or at search time.
 */
export const DEFAULT_TYPE_WEIGHTS: Record<SearchUseCase, Partial<Record<DocumentType, number>>> = {
	// FIM completion: prioritize code and examples
	fim: {
		code_chunk: 0.5,
		usage_example: 0.25,
		idiom: 0.15,
		symbol_summary: 0.1,
	},
	// Human search: balanced across summaries and code
	search: {
		file_summary: 0.25,
		symbol_summary: 0.25,
		code_chunk: 0.2,
		idiom: 0.15,
		usage_example: 0.1,
		anti_pattern: 0.05,
	},
	// Agent navigation: prioritize understanding structure
	navigation: {
		symbol_summary: 0.35,
		file_summary: 0.3,
		code_chunk: 0.2,
		idiom: 0.1,
		project_doc: 0.05,
	},
};

// ============================================================================
// Retriever Options
// ============================================================================

export interface RetrieverOptions {
	/** Maximum results to return */
	limit?: number;
	/** Use case preset (affects type weights) */
	useCase?: SearchUseCase;
	/** Custom type weights (overrides use case) */
	typeWeights?: Partial<Record<DocumentType, number>>;
	/** Filter by document types */
	documentTypes?: DocumentType[];
	/** Filter by file path pattern */
	pathPattern?: string;
	/** Filter by language */
	language?: string;
	/** Include code chunks in results (default: true) */
	includeCodeChunks?: boolean;
}

// ============================================================================
// Enriched Retriever Class
// ============================================================================

export class EnrichedRetriever {
	private store: VectorStore;
	private embeddings: IEmbeddingsClient;
	private defaultUseCase: SearchUseCase;

	constructor(
		store: VectorStore,
		embeddings: IEmbeddingsClient,
		defaultUseCase: SearchUseCase = "search",
	) {
		this.store = store;
		this.embeddings = embeddings;
		this.defaultUseCase = defaultUseCase;
	}

	/**
	 * Search for relevant documents
	 */
	async search(
		query: string,
		options: RetrieverOptions = {},
	): Promise<EnrichedSearchResult[]> {
		const {
			limit = 10,
			useCase = this.defaultUseCase,
			typeWeights,
			documentTypes,
			pathPattern,
			language,
			includeCodeChunks = true,
		} = options;

		// Generate query embedding
		const queryVector = await this.embeddings.embedOne(query);

		// Build search options
		const searchOptions: EnrichedSearchOptions = {
			limit,
			useCase,
			documentTypes,
			pathPattern,
			language,
			includeCodeChunks,
		};

		// Apply custom weights if provided
		if (typeWeights) {
			searchOptions.typeWeights = typeWeights;
		}

		// Execute search
		return this.store.searchDocuments(query, queryVector, searchOptions);
	}

	/**
	 * Search optimized for FIM completion
	 */
	async searchForFIM(
		query: string,
		options: Omit<RetrieverOptions, "useCase"> = {},
	): Promise<EnrichedSearchResult[]> {
		return this.search(query, { ...options, useCase: "fim" });
	}

	/**
	 * Search optimized for human queries
	 */
	async searchForHuman(
		query: string,
		options: Omit<RetrieverOptions, "useCase"> = {},
	): Promise<EnrichedSearchResult[]> {
		return this.search(query, { ...options, useCase: "search" });
	}

	/**
	 * Search optimized for agent navigation
	 */
	async searchForNavigation(
		query: string,
		options: Omit<RetrieverOptions, "useCase"> = {},
	): Promise<EnrichedSearchResult[]> {
		return this.search(query, { ...options, useCase: "navigation" });
	}

	/**
	 * Get type weights for a use case
	 */
	getTypeWeights(useCase: SearchUseCase): Partial<Record<DocumentType, number>> {
		return DEFAULT_TYPE_WEIGHTS[useCase] || DEFAULT_TYPE_WEIGHTS.search;
	}

	/**
	 * Get documents by file path
	 */
	async getDocumentsByFile(
		filePath: string,
		documentTypes?: DocumentType[],
	): Promise<EnrichedSearchResult[]> {
		const docs = await this.store.getDocumentsByFile(filePath, documentTypes);

		// Convert to EnrichedSearchResult format
		return docs.map((doc) => ({
			document: doc,
			score: 1.0, // Direct lookup
			vectorScore: 1.0,
			keywordScore: 1.0,
			documentType: doc.documentType,
		}));
	}

	/**
	 * Get document type statistics
	 */
	async getDocumentStats(): Promise<Record<DocumentType, number>> {
		return this.store.getDocumentTypeStats();
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an enriched retriever
 */
export function createEnrichedRetriever(
	store: VectorStore,
	embeddings: IEmbeddingsClient,
	defaultUseCase?: SearchUseCase,
): EnrichedRetriever {
	return new EnrichedRetriever(store, embeddings, defaultUseCase);
}
