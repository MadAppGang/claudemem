/**
 * Retrieval Module Exports
 *
 * Public API for the retrieval system.
 */

export type {
	EnhancedRetrieverOptions,
	EnhancedSearchResult,
	SearchOptions,
} from "./enhanced-retriever.js";
// Enhanced retriever (new hierarchical model)
export {
	createEnhancedRetriever,
	EnhancedRetriever,
} from "./enhanced-retriever.js";
export type {
	FormatInput,
	FormatterOptions,
} from "./formatting/context-formatter.js";
// Context formatting
export {
	ContextFormatter,
	createContextFormatter,
} from "./formatting/context-formatter.js";
// Prompts
export {
	CONTEXT_FILTER_PROMPT,
	formatCandidatesForReranking,
	formatContextForFiltering,
	QUERY_CLASSIFICATION_PROMPT,
	QUERY_EXPANSION_PROMPT,
	RERANKING_PROMPT,
} from "./prompts.js";
export type {
	RerankableResult,
	RerankerOptions,
} from "./reranking/llm-reranker.js";

// Reranking
export { createLLMReranker, LLMReranker } from "./reranking/llm-reranker.js";
export type { RetrieverOptions } from "./retriever.js";
// Original enriched retriever (backward compatibility)
export {
	createEnrichedRetriever,
	DEFAULT_TYPE_WEIGHTS,
	EnrichedRetriever,
} from "./retriever.js";
export type {
	QueryRouterOptions,
	RetrievalStrategy,
	RouteResult,
} from "./routing/query-router.js";
// Query routing
export { createQueryRouter, QueryRouter } from "./routing/query-router.js";
