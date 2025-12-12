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
}

export interface EmbeddingResponse {
	/** Array of embedding vectors */
	embeddings: number[][];
	/** Model used */
	model: string;
	/** Token usage */
	usage?: {
		promptTokens: number;
		totalTokens: number;
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
	/** Global exclude patterns */
	excludePatterns: string[];
}

export interface ProjectConfig {
	/** Override embedding model for this project */
	model?: string;
	/** Additional exclude patterns */
	excludePatterns: string[];
	/** Include only these patterns */
	includePatterns: string[];
	/** Last used embedding model */
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
