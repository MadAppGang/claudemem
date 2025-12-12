/**
 * Code Indexer
 *
 * Orchestrates the indexing process: file discovery, chunking,
 * embedding generation, and storage.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { minimatch } from "minimatch";
import {
	DEFAULT_EXCLUDE_PATTERNS,
	ensureProjectDir,
	getEmbeddingModel,
	getIndexDbPath,
	getVectorStorePath,
	loadConfig,
	saveProjectConfig,
} from "../config.js";
import { getParserManager } from "../parsers/parser-manager.js";
import type {
	ChunkWithEmbedding,
	CodeChunk,
	IndexResult,
	IndexStatus,
	SearchOptions,
	SearchResult,
} from "../types.js";
import { chunkFileByPath } from "./chunker.js";
import { createEmbeddingsClient, type EmbeddingsClient } from "./embeddings.js";
import { createVectorStore, type VectorStore } from "./store.js";
import {
	computeFileHash,
	createFileTracker,
	type FileTracker,
} from "./tracker.js";

// ============================================================================
// Types
// ============================================================================

interface IndexerOptions {
	/** Project root path */
	projectPath: string;
	/** Embedding model to use */
	model?: string;
	/** Additional exclude patterns */
	excludePatterns?: string[];
	/** Include only these patterns */
	includePatterns?: string[];
	/** Progress callback */
	onProgress?: (current: number, total: number, file: string) => void;
	/** Force re-index all files */
	force?: boolean;
}

// ============================================================================
// Indexer Class
// ============================================================================

export class Indexer {
	private projectPath: string;
	private model: string;
	private excludePatterns: string[];
	private includePatterns: string[];
	private onProgress?: (current: number, total: number, file: string) => void;

	private embeddingsClient: EmbeddingsClient | null = null;
	private vectorStore: VectorStore | null = null;
	private fileTracker: FileTracker | null = null;

	constructor(options: IndexerOptions) {
		this.projectPath = options.projectPath;
		this.model = options.model || getEmbeddingModel(options.projectPath);
		this.excludePatterns = [
			...DEFAULT_EXCLUDE_PATTERNS,
			...(options.excludePatterns || []),
		];
		this.includePatterns = options.includePatterns || [];
		this.onProgress = options.onProgress;
	}

	/**
	 * Initialize all components
	 */
	private async initialize(): Promise<void> {
		// Ensure project directory exists
		ensureProjectDir(this.projectPath);

		// Initialize parser manager
		const parserManager = getParserManager();
		await parserManager.initialize();

		// Create embeddings client
		this.embeddingsClient = createEmbeddingsClient({ model: this.model });

		// Create vector store
		const vectorStorePath = getVectorStorePath(this.projectPath);
		this.vectorStore = createVectorStore(vectorStorePath);
		await this.vectorStore.initialize();

		// Create file tracker
		const indexDbPath = getIndexDbPath(this.projectPath);
		this.fileTracker = createFileTracker(indexDbPath, this.projectPath);
	}

	/**
	 * Index the codebase
	 */
	async index(force = false): Promise<IndexResult> {
		const startTime = Date.now();
		await this.initialize();

		// Discover files
		const allFiles = this.discoverFiles();

		// Get changes
		let filesToIndex: string[];
		let deletedFiles: string[] = [];

		if (force) {
			// Force re-index all files
			filesToIndex = allFiles;
			// Clear existing data
			await this.vectorStore!.clear();
			this.fileTracker!.clear();
		} else {
			// Incremental indexing
			const changes = this.fileTracker!.getChanges(allFiles);
			filesToIndex = [...changes.newFiles, ...changes.modifiedFiles];
			deletedFiles = changes.deletedFiles;

			// Remove deleted files from index
			for (const deletedFile of deletedFiles) {
				const chunkIds = this.fileTracker!.getChunkIds(deletedFile);
				if (chunkIds.length > 0) {
					await this.vectorStore!.deleteByFile(deletedFile);
				}
				this.fileTracker!.removeFile(deletedFile);
			}
		}

		// Index files
		let filesIndexed = 0;
		let chunksCreated = 0;
		const skippedFiles: string[] = [];
		const errors: Array<{ file: string; error: string }> = [];

		for (let i = 0; i < filesToIndex.length; i++) {
			const filePath = filesToIndex[i];
			const relativePath = relative(this.projectPath, filePath);

			// Report progress
			if (this.onProgress) {
				this.onProgress(i + 1, filesToIndex.length, relativePath);
			}

			try {
				const result = await this.indexFile(filePath);

				if (result.chunks.length > 0) {
					filesIndexed++;
					chunksCreated += result.chunks.length;
				} else {
					skippedFiles.push(relativePath);
				}
			} catch (error) {
				const errorMsg =
					error instanceof Error ? error.message : String(error);
				errors.push({ file: relativePath, error: errorMsg });
			}
		}

		// Save model info to project config
		saveProjectConfig(this.projectPath, {
			lastModel: this.model,
		});

		// Save metadata
		this.fileTracker!.setMetadata(
			"embeddingModel",
			this.model,
		);
		this.fileTracker!.setMetadata(
			"lastIndexed",
			new Date().toISOString(),
		);

		const durationMs = Date.now() - startTime;

		return {
			filesIndexed,
			chunksCreated,
			durationMs,
			skippedFiles,
			errors,
		};
	}

	/**
	 * Index a single file
	 */
	private async indexFile(
		filePath: string,
	): Promise<{ chunks: CodeChunk[] }> {
		// Read file content
		const content = readFileSync(filePath, "utf-8");
		const fileHash = computeFileHash(filePath);

		// Chunk the file
		const chunks = await chunkFileByPath(content, filePath, fileHash);

		if (chunks.length === 0) {
			return { chunks: [] };
		}

		// Generate embeddings
		const texts = chunks.map((c) => c.content);
		const embeddings = await this.embeddingsClient!.embed(texts);

		// Combine chunks with embeddings
		const chunksWithEmbeddings: ChunkWithEmbedding[] = chunks.map(
			(chunk, i) => ({
				...chunk,
				vector: embeddings[i],
			}),
		);

		// Store in vector database
		await this.vectorStore!.addChunks(chunksWithEmbeddings);

		// Update file tracker
		const chunkIds = chunks.map((c) => c.id);
		this.fileTracker!.markIndexed(filePath, fileHash, chunkIds);

		return { chunks };
	}

	/**
	 * Search the indexed codebase
	 */
	async search(
		query: string,
		options: SearchOptions = {},
	): Promise<SearchResult[]> {
		await this.initialize();

		// Generate query embedding
		const queryVector = await this.embeddingsClient!.embedOne(query);

		// Search
		return this.vectorStore!.search(query, queryVector, options);
	}

	/**
	 * Get index status
	 */
	async getStatus(): Promise<IndexStatus> {
		const indexDbPath = getIndexDbPath(this.projectPath);

		if (!existsSync(indexDbPath)) {
			return {
				exists: false,
				totalFiles: 0,
				totalChunks: 0,
				languages: [],
			};
		}

		await this.initialize();

		const trackerStats = this.fileTracker!.getStats();
		const storeStats = await this.vectorStore!.getStats();

		const embeddingModel = this.fileTracker!.getMetadata("embeddingModel");
		const lastIndexed = this.fileTracker!.getMetadata("lastIndexed");

		return {
			exists: true,
			totalFiles: trackerStats.totalFiles,
			totalChunks: storeStats.totalChunks,
			lastUpdated: lastIndexed ? new Date(lastIndexed) : undefined,
			embeddingModel: embeddingModel || undefined,
			languages: storeStats.languages,
		};
	}

	/**
	 * Clear the index
	 */
	async clear(): Promise<void> {
		await this.initialize();

		await this.vectorStore!.clear();
		this.fileTracker!.clear();
	}

	/**
	 * Discover files to index
	 */
	private discoverFiles(): string[] {
		const files: string[] = [];
		const parserManager = getParserManager();
		const supportedExtensions = new Set(parserManager.getSupportedExtensions());

		const walk = (dir: string) => {
			const entries = readdirSync(dir, { withFileTypes: true });

			for (const entry of entries) {
				const fullPath = join(dir, entry.name);
				const relativePath = relative(this.projectPath, fullPath);

				// Check exclude patterns
				if (this.shouldExclude(relativePath, entry.isDirectory())) {
					continue;
				}

				if (entry.isDirectory()) {
					walk(fullPath);
				} else if (entry.isFile()) {
					// Check include patterns if specified
					if (
						this.includePatterns.length > 0 &&
						!this.shouldInclude(relativePath)
					) {
						continue;
					}

					// Check if file extension is supported
					const ext = "." + entry.name.split(".").pop();
					if (supportedExtensions.has(ext)) {
						files.push(fullPath);
					}
				}
			}
		};

		walk(this.projectPath);
		return files;
	}

	/**
	 * Check if a path should be excluded
	 */
	private shouldExclude(relativePath: string, isDirectory: boolean): boolean {
		const pathToCheck = isDirectory ? relativePath + "/" : relativePath;

		for (const pattern of this.excludePatterns) {
			if (minimatch(pathToCheck, pattern, { dot: true })) {
				return true;
			}
			// Also check just the path without trailing slash for directories
			if (isDirectory && minimatch(relativePath, pattern, { dot: true })) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Check if a path matches include patterns
	 */
	private shouldInclude(relativePath: string): boolean {
		for (const pattern of this.includePatterns) {
			if (minimatch(relativePath, pattern, { dot: true })) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Close all resources
	 */
	async close(): Promise<void> {
		if (this.vectorStore) {
			await this.vectorStore.close();
		}
		if (this.fileTracker) {
			this.fileTracker.close();
		}
	}
}

// ============================================================================
// Factory Functions
// ============================================================================

/**
 * Create an indexer for a project
 */
export function createIndexer(options: IndexerOptions): Indexer {
	return new Indexer(options);
}

/**
 * Quick index function
 */
export async function indexProject(
	projectPath: string,
	options: Partial<IndexerOptions> = {},
): Promise<IndexResult> {
	const indexer = createIndexer({ projectPath, ...options });
	try {
		return await indexer.index(options.force !== false);
	} finally {
		await indexer.close();
	}
}

/**
 * Quick search function
 */
export async function searchProject(
	projectPath: string,
	query: string,
	options: SearchOptions = {},
): Promise<SearchResult[]> {
	const indexer = createIndexer({ projectPath });
	try {
		return await indexer.search(query, options);
	} finally {
		await indexer.close();
	}
}
