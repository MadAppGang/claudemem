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
