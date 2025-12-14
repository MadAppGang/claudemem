/**
 * Core types for claudemem
 */

// ============================================================================
// Code Chunk Types
// ============================================================================

export type ChunkType = "function" | "class" | "method" | "module" | "block";

export interface CodeChunk {
	/** SHA256 hash of content */
	id: string;
	/** Raw code content */
	content: string;
	/** Relative path from project root */
	filePath: string;
	/** Starting line number (1-indexed) */
	startLine: number;
	/** Ending line number (1-indexed) */
	endLine: number;
	/** Programming language */
	language: string;
	/** Type of code construct */
	chunkType: ChunkType;
	/** Name of function/class/method if available */
	name?: string;
	/** Enclosing class name for methods */
	parentName?: string;
	/** Function/method signature if extractable */
	signature?: string;
	/** Hash of the parent file for change tracking */
	fileHash: string;
}

export interface ChunkWithEmbedding extends CodeChunk {
	/** Vector embedding */
	vector: number[];
}

// ============================================================================
// Search Types
// ============================================================================

export interface SearchResult {
	/** The matched code chunk */
	chunk: CodeChunk;
	/** Combined relevance score (0-1) */
	score: number;
	/** Vector similarity score */
	vectorScore: number;
	/** BM25 keyword score */
	keywordScore: number;
}

export interface SearchOptions {
	/** Maximum results to return */
	limit?: number;
	/** Filter by language */
	language?: string;
	/** Filter by chunk type */
	chunkType?: ChunkType;
	/** Filter by file path pattern */
	pathPattern?: string;
	/** Search use case for weight presets */
	useCase?: SearchUseCase;
}

// ============================================================================
// Indexing Types
// ============================================================================

export interface IndexResult {
	/** Number of files indexed */
	filesIndexed: number;
	/** Number of chunks created */
	chunksCreated: number;
	/** Time taken in milliseconds */
	durationMs: number;
	/** Files that were skipped */
	skippedFiles: string[];
	/** Any errors encountered */
	errors: Array<{ file: string; error: string }>;
	/** Total cost in USD (if reported by provider) */
	cost?: number;
	/** Total tokens used (if reported by provider) */
	totalTokens?: number;
}

export interface IndexStatus {
	/** Whether an index exists */
	exists: boolean;
	/** Total number of indexed files */
	totalFiles: number;
	/** Total number of chunks */
	totalChunks: number;
	/** Last index update timestamp */
	lastUpdated?: Date;
	/** Embedding model used */
	embeddingModel?: string;
	/** Languages indexed */
	languages: string[];
}

export interface FileState {
	/** File path relative to project root */
	path: string;
	/** SHA256 hash of file content */
	contentHash: string;
	/** File modification time */
	mtime: number;
	/** IDs of chunks from this file */
	chunkIds: string[];
}

// ============================================================================
// Embedding Types
// ============================================================================

/** Supported embedding providers */
export type EmbeddingProvider = "openrouter" | "ollama" | "local" | "voyage";

/** Progress callback for embedding operations */
export type EmbeddingProgressCallback = (
	completed: number,
	total: number,
	/** Number of items currently being processed (for animation) */
	inProgress?: number
) => void;

/** Result of embedding operation with usage stats */
export interface EmbedResult {
	embeddings: number[][];
	/** Total tokens used (if reported by provider) */
	totalTokens?: number;
	/** Cost in USD (if reported by provider) */
	cost?: number;
}

/**
 * Embeddings client interface
 * All embedding providers must implement this interface
 */
export interface IEmbeddingsClient {
	/** Generate embeddings for multiple texts */
	embed(texts: string[], onProgress?: EmbeddingProgressCallback): Promise<EmbedResult>;
	/** Generate embedding for a single text */
	embedOne(text: string): Promise<number[]>;
	/** Get the model being used */
	getModel(): string;
	/** Get the embedding dimension (discovered after first request) */
	getDimension(): number | undefined;
}

export interface EmbeddingModel {
	/** Model ID (e.g., "qwen/qwen3-embedding-8b") */
	id: string;
	/** Human-readable name */
	name: string;
	/** Provider name */
	provider: string;
	/** Context window size */
	contextLength: number;
	/** Vector dimension */
	dimension?: number;
	/** Price per million tokens (input) */
	pricePerMillion: number;
	/** Whether model is free */
	isFree: boolean;
	/** Whether this is a top recommended model */
	isRecommended?: boolean;
}

export interface EmbeddingResponse {
	/** Array of embedding vectors */
	embeddings: number[][];
	/** Model used */
	model: string;
	/** Token usage and cost */
	usage?: {
		promptTokens: number;
		totalTokens: number;
		/** Cost in USD (if reported by provider) */
		cost?: number;
	};
}

// ============================================================================
// Configuration Types
// ============================================================================

export interface GlobalConfig {
	/** Default embedding model to use */
	defaultModel?: string;
	/** OpenRouter API key */
	openrouterApiKey?: string;
	/** Voyage AI API key */
	voyageApiKey?: string;
	/** Global exclude patterns */
	excludePatterns: string[];
	/** Embedding provider (openrouter, ollama, local, voyage) */
	embeddingProvider?: EmbeddingProvider;
	/** Ollama endpoint URL (default: http://localhost:11434) */
	ollamaEndpoint?: string;
	/** Custom local endpoint URL */
	localEndpoint?: string;

	// ─── LLM Enrichment Settings ───
	/** LLM provider for enrichment (claude-code, anthropic, openrouter, local) */
	llmProvider?: LLMProvider;
	/** LLM model to use for enrichment */
	llmModel?: string;
	/** LLM endpoint URL (for local providers) */
	llmEndpoint?: string;
	/** Anthropic API key (for direct Anthropic API calls) */
	anthropicApiKey?: string;
	/** Enable LLM enrichment during indexing (default: true) */
	enableEnrichment?: boolean;
}

export interface ProjectConfig {
	/** Override embedding model for this project */
	model?: string;
	/** Additional exclude patterns (glob patterns) */
	excludePatterns?: string[];
	/** Include only these patterns (glob patterns) */
	includePatterns?: string[];
	/** Only index files with these extensions (e.g., [".ts", ".tsx"]) */
	includeExtensions?: string[];
	/** Exclude files with these extensions from indexing */
	excludeExtensions?: string[];
	/** Use .gitignore patterns for exclusion (default: true) */
	useGitignore?: boolean;
	/** Enable auto-indexing on search (default: true) */
	autoIndex?: boolean;
	/** Custom index directory path (default: .claudemem) */
	indexDir?: string;
	/** Last used embedding model (internal use) */
	lastModel?: string;

	// ─── Enrichment Settings ───
	/** Project-level enrichment configuration */
	enrichment?: {
		/** Enable/disable enrichment for this project (overrides global) */
		enabled?: boolean;
		/** Document types to generate */
		types?: DocumentType[];
		/** Override LLM provider for this project */
		llmProvider?: LLMProvider;
	};

	/** Search weight configuration per use case */
	searchWeights?: {
		fim?: Partial<Record<DocumentType, number>>;
		search?: Partial<Record<DocumentType, number>>;
		navigation?: Partial<Record<DocumentType, number>>;
	};
}

export interface Config extends GlobalConfig {
	/** Project-specific overrides */
	project?: ProjectConfig;
}

// ============================================================================
// CLI Types
// ============================================================================

export interface CLIConfig {
	/** Embedding model to use */
	model?: string;
	/** OpenRouter API key */
	openrouterApiKey?: string;
	/** Show only free models */
	freeOnly: boolean;
	/** Force re-index all files */
	force: boolean;
	/** Run in MCP server mode */
	mcpMode: boolean;
	/** Search query */
	query?: string;
	/** Search result limit */
	limit: number;
	/** Target path */
	path: string;
	/** Show verbose output */
	verbose: boolean;
	/** Output in JSON format */
	jsonOutput: boolean;
}

// ============================================================================
// Language Support Types
// ============================================================================

export type SupportedLanguage =
	| "typescript"
	| "javascript"
	| "tsx"
	| "jsx"
	| "python"
	| "go"
	| "rust"
	| "c"
	| "cpp"
	| "java";

export interface LanguageConfig {
	/** Language identifier */
	id: SupportedLanguage;
	/** File extensions */
	extensions: string[];
	/** Tree-sitter grammar file */
	grammarFile: string;
	/** Tree-sitter query for extracting chunks */
	chunkQuery: string;
	/** Tree-sitter query for extracting symbol references (optional) */
	referenceQuery?: string;
}

// ============================================================================
// Parser Types
// ============================================================================

export interface ParsedChunk {
	/** Raw code content */
	content: string;
	/** Starting line (0-indexed from tree-sitter) */
	startLine: number;
	/** Ending line (0-indexed from tree-sitter) */
	endLine: number;
	/** Type of code construct */
	chunkType: ChunkType;
	/** Name if available */
	name?: string;
	/** Parent name for methods */
	parentName?: string;
	/** Signature if extractable */
	signature?: string;
}

// ============================================================================
// AST Symbol Types (Symbol Graph)
// ============================================================================

/** Symbol kinds for AST extraction */
export type SymbolKind =
	| "function"
	| "class"
	| "method"
	| "type"
	| "interface"
	| "enum"
	| "variable"
	| "struct"
	| "trait"
	| "impl";

/** Reference kinds for symbol graph edges */
export type ReferenceKind =
	| "call"
	| "type_usage"
	| "import"
	| "extends"
	| "implements"
	| "field_access";

/** Symbol definition extracted from AST */
export interface SymbolDefinition {
	/** Unique identifier (SHA256 hash) */
	id: string;
	/** Symbol name */
	name: string;
	/** Type of symbol */
	kind: SymbolKind;
	/** File path (relative to project root) */
	filePath: string;
	/** Starting line number (1-indexed) */
	startLine: number;
	/** Ending line number (1-indexed) */
	endLine: number;
	/** Full signature (e.g., "async function foo(x: number): Promise<void>") */
	signature?: string;
	/** Docstring/JSDoc comment */
	docstring?: string;
	/** Parent symbol ID (for methods inside classes) */
	parentId?: string;
	/** Whether symbol is exported/public */
	isExported: boolean;
	/** Programming language */
	language: string;
	/** PageRank importance score */
	pagerankScore: number;
	/** Number of incoming references */
	inDegree?: number;
	/** Number of outgoing references */
	outDegree?: number;
	/** When symbol was created */
	createdAt: string;
	/** When symbol was last updated */
	updatedAt: string;
}

/** Reference between symbols (edge in the graph) */
export interface SymbolReference {
	/** Auto-increment ID (optional, from database) */
	id?: number;
	/** Symbol making the reference */
	fromSymbolId: string;
	/** Name being referenced (always stored for fallback) */
	toSymbolName: string;
	/** Resolved symbol ID (null if unresolved) */
	toSymbolId?: string;
	/** Type of reference */
	kind: ReferenceKind;
	/** File where reference occurs */
	filePath: string;
	/** Line number of reference */
	line: number;
	/** Whether reference has been resolved to a symbol */
	isResolved: boolean;
	/** When reference was created */
	createdAt: string;
}

/** Options for repo map generation */
export interface RepoMapOptions {
	/** Maximum tokens for the map (default: 2000) */
	maxTokens?: number;
	/** Include full signatures (default: true) */
	includeSignatures?: boolean;
	/** Filter by file path pattern */
	pathPattern?: string;
	/** Include top N symbols by PageRank */
	topNByPagerank?: number;
}

/** Entry in structured repo map */
export interface RepoMapEntry {
	/** File path */
	filePath: string;
	/** Symbols in this file */
	symbols: Array<{
		name: string;
		kind: SymbolKind;
		signature?: string;
		line: number;
		pagerankScore: number;
	}>;
}

/** Symbol graph statistics */
export interface SymbolGraphStats {
	/** Total symbols in graph */
	totalSymbols: number;
	/** Total references in graph */
	totalReferences: number;
	/** Number of resolved references */
	resolvedReferences: number;
	/** Symbols by kind */
	symbolsByKind: Partial<Record<SymbolKind, number>>;
	/** References by kind */
	referencesByKind: Partial<Record<ReferenceKind, number>>;
	/** When PageRank was last computed */
	pagerankComputedAt?: string;
}

// ============================================================================
// Document Types (Enriched RAG)
// ============================================================================

/** All document types in the enriched index */
export type DocumentType =
	| "code_chunk"
	| "file_summary"
	| "symbol_summary"
	| "idiom"
	| "usage_example"
	| "anti_pattern"
	| "project_doc";

/** Base interface for all document types */
export interface BaseDocument {
	/** Unique identifier (SHA256 hash) */
	id: string;
	/** Document content (for embedding and search) */
	content: string;
	/** Document type discriminator */
	documentType: DocumentType;
	/** File path this document relates to (optional for project docs) */
	filePath?: string;
	/** Hash of source file for change tracking */
	fileHash?: string;
	/** When this document was created */
	createdAt: string;
	/** When this document was enriched (if by LLM) */
	enrichedAt?: string;
	/** IDs of source code chunks this was derived from */
	sourceIds?: string[];
	/** Additional type-specific metadata (JSON) */
	metadata?: Record<string, unknown>;
}

/** Document with embedding vector attached */
export interface DocumentWithEmbedding extends BaseDocument {
	/** Vector embedding */
	vector: number[];
}

/** File-level summary document */
export interface FileSummary extends BaseDocument {
	documentType: "file_summary";
	filePath: string;
	/** Programming language */
	language: string;
	/** High-level purpose of the file */
	summary: string;
	/** Main responsibilities (2-3 bullet points) */
	responsibilities: string[];
	/** Exported functions/classes/types */
	exports: string[];
	/** Imported modules/dependencies */
	dependencies: string[];
	/** Notable patterns used (hooks, middleware, etc.) */
	patterns: string[];
}

/** Symbol-level summary (function, class, method) */
export interface SymbolSummary extends BaseDocument {
	documentType: "symbol_summary";
	filePath: string;
	/** Symbol name */
	symbolName: string;
	/** Type of symbol */
	symbolType: "function" | "class" | "method" | "module";
	/** What it does (one sentence) */
	summary: string;
	/** Key parameters and their purpose */
	parameters?: Array<{ name: string; description: string }>;
	/** What it returns and when */
	returnDescription?: string;
	/** Side effects (API calls, state mutations, etc.) */
	sideEffects?: string[];
	/** When/where to use this */
	usageContext?: string;
}

/** Project idiom/pattern document */
export interface Idiom extends BaseDocument {
	documentType: "idiom";
	/** Category (error_handling, async_patterns, naming, etc.) */
	category: string;
	/** Programming language */
	language: string;
	/** Pattern name/description */
	pattern: string;
	/** Code example showing the pattern */
	example: string;
	/** Why this pattern is used */
	rationale: string;
	/** Where this pattern applies */
	appliesTo: string[];
}

/** Usage example document */
export interface UsageExample extends BaseDocument {
	documentType: "usage_example";
	filePath: string;
	/** Symbol this example is for */
	symbol: string;
	/** Type of example */
	exampleType: "basic" | "with_options" | "error_case" | "in_context" | "test";
	/** The example code */
	code: string;
	/** Brief description of what this example shows */
	description?: string;
}

/** Anti-pattern document */
export interface AntiPattern extends BaseDocument {
	documentType: "anti_pattern";
	/** What to avoid */
	pattern: string;
	/** Bad code example */
	badExample: string;
	/** Why it's problematic */
	reason: string;
	/** What to do instead */
	alternative: string;
	/** Severity level */
	severity: "low" | "medium" | "high";
}

/** Project documentation document */
export interface ProjectDoc extends BaseDocument {
	documentType: "project_doc";
	/** Document title */
	title: string;
	/** Category of documentation */
	category: "architecture" | "getting_started" | "api" | "contributing" | "standards";
	/** Document sections */
	sections: Array<{
		heading: string;
		content: string;
	}>;
}

/** Union type of all document types */
export type Document =
	| FileSummary
	| SymbolSummary
	| Idiom
	| UsageExample
	| AntiPattern
	| ProjectDoc;

// ============================================================================
// LLM Types (for Enrichment)
// ============================================================================

/** Supported LLM providers for enrichment */
export type LLMProvider = "claude-code" | "anthropic" | "openrouter" | "local";

/** Message in LLM conversation */
export interface LLMMessage {
	role: "user" | "assistant" | "system";
	content: string;
}

/** Response from LLM */
export interface LLMResponse {
	/** Generated content */
	content: string;
	/** Model that generated the response */
	model: string;
	/** Usage statistics */
	usage?: {
		inputTokens: number;
		outputTokens: number;
		/** Cost in USD (if available) */
		cost?: number;
	};
}

/** Options for LLM generation */
export interface LLMGenerateOptions {
	/** Model to use (overrides default) */
	model?: string;
	/** Temperature for generation (0-1) */
	temperature?: number;
	/** Maximum tokens to generate */
	maxTokens?: number;
	/** System prompt */
	systemPrompt?: string;
}

/**
 * LLM client interface
 * All LLM providers must implement this interface
 */
export interface ILLMClient {
	/** Generate completion from messages */
	complete(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<LLMResponse>;
	/** Generate completion and parse as JSON */
	completeJSON<T>(messages: LLMMessage[], options?: LLMGenerateOptions): Promise<T>;
	/** Get the provider being used */
	getProvider(): LLMProvider;
	/** Get the model being used */
	getModel(): string;
	/** Test connection to the provider */
	testConnection(): Promise<boolean>;
}

/** Progress callback for enrichment operations */
export type EnrichmentProgressCallback = (
	completed: number,
	total: number,
	documentType: DocumentType,
	/** Status message (e.g., files being processed) */
	status?: string,
	/** Number of items currently in progress (for animation) */
	inProgress?: number
) => void;

// ============================================================================
// Extractor Types (for Enrichment Pipeline)
// ============================================================================

/** Context passed to document extractors */
export interface ExtractionContext {
	/** Project root path */
	projectPath: string;
	/** Code chunks for the current file */
	codeChunks: CodeChunk[];
	/** File path being processed */
	filePath: string;
	/** Full file content */
	fileContent: string;
	/** Programming language */
	language: string;
	/** Existing documents for this file (for incremental updates) */
	existingDocs?: BaseDocument[];
	/** All files in project (for project-level extraction) */
	allFiles?: string[];
}

/** Enrichment state for a file */
export type EnrichmentState = "pending" | "in_progress" | "complete" | "failed";

/**
 * Document extractor interface
 * Each document type has its own extractor implementation
 */
export interface IDocumentExtractor {
	/** Get the document type this extractor produces */
	getDocumentType(): DocumentType;
	/** Extract documents from the given context */
	extract(context: ExtractionContext, llmClient: ILLMClient): Promise<BaseDocument[]>;
	/** Check if extraction is needed (for incremental updates) */
	needsUpdate(context: ExtractionContext): boolean;
	/** Get document types this extractor depends on */
	getDependencies(): DocumentType[];
}

// ============================================================================
// Enriched Search Types
// ============================================================================

/** Search result with enriched document */
export interface EnrichedSearchResult {
	/** The matched document */
	document: BaseDocument;
	/** Combined relevance score (0-1) */
	score: number;
	/** Vector similarity score */
	vectorScore: number;
	/** BM25 keyword score */
	keywordScore: number;
	/** Document type for filtering/display */
	documentType: DocumentType;
}

/** Use case for search weight presets */
export type SearchUseCase = "fim" | "search" | "navigation";

/** Search options with enrichment support */
export interface EnrichedSearchOptions extends SearchOptions {
	/** Filter by document types */
	documentTypes?: DocumentType[];
	/** Custom weights per document type (overrides use case) */
	typeWeights?: Partial<Record<DocumentType, number>>;
	/** Use case preset for automatic weight configuration */
	useCase?: SearchUseCase;
	/** Include code chunks in results (default: true) */
	includeCodeChunks?: boolean;
}

/** Response from retriever with optional repo map context */
export interface RetrieverSearchResponse {
	/** Search results ranked by relevance */
	results: EnrichedSearchResult[];
	/** Token-budgeted repo map context relevant to the query */
	repoMapContext?: string;
	/** Search metadata */
	metadata?: {
		/** Total documents searched */
		totalDocuments?: number;
		/** Time taken in milliseconds */
		durationMs?: number;
		/** Whether repo map was included */
		includesRepoMap?: boolean;
	};
}

// ============================================================================
// Enrichment Result Types
// ============================================================================

/** Result of enrichment operation */
export interface EnrichmentResult {
	/** Number of documents created */
	documentsCreated: number;
	/** Number of documents updated */
	documentsUpdated: number;
	/** Time taken in milliseconds */
	durationMs: number;
	/** Errors encountered during enrichment */
	errors: Array<{ file: string; documentType: DocumentType; error: string }>;
	/** LLM cost in USD (if available) */
	cost?: number;
	/** Total LLM tokens used */
	totalTokens?: number;
}

/** Extended index result with enrichment stats */
export interface EnrichedIndexResult extends IndexResult {
	/** Enrichment statistics */
	enrichment?: EnrichmentResult;
}
