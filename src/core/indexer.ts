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
	ensureProjectDir,
	getEmbeddingModel,
	getExcludePatterns,
	getIndexDbPath,
	getVectorStorePath,
	loadProjectConfig,
	saveProjectConfig,
} from "../config.js";
import { getParserManager } from "../parsers/parser-manager.js";
import type {
	ChunkWithEmbedding,
	CodeChunk,
	IEmbeddingsClient,
	IndexResult,
	IndexStatus,
	SearchOptions,
	SearchResult,
} from "../types.js";
import { chunkFileByPath } from "./chunker.js";
import { createEmbeddingsClient } from "./embeddings.js";
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
	private includeExtensions: Set<string> | null;
	private excludeExtensions: Set<string>;
	private onProgress?: (current: number, total: number, file: string) => void;

	private embeddingsClient: IEmbeddingsClient | null = null;
	private vectorStore: VectorStore | null = null;
	private fileTracker: FileTracker | null = null;

	constructor(options: IndexerOptions) {
		this.projectPath = options.projectPath;
		this.model = options.model || getEmbeddingModel(options.projectPath);
		// Get exclude patterns from config (includes defaults, gitignore, etc.)
		this.excludePatterns = [
			...getExcludePatterns(options.projectPath),
			...(options.excludePatterns || []),
		];
		// Get config options
		const projectConfig = loadProjectConfig(options.projectPath);
		this.includePatterns = options.includePatterns || projectConfig?.includePatterns || [];

		// Extension filters from config
		// includeExtensions: if set, ONLY index these extensions
		// excludeExtensions: never index these extensions
		this.includeExtensions = projectConfig?.includeExtensions
			? new Set(projectConfig.includeExtensions.map(e => e.startsWith('.') ? e : `.${e}`))
			: null;
		this.excludeExtensions = new Set(
			(projectConfig?.excludeExtensions || []).map(e => e.startsWith('.') ? e : `.${e}`)
		);

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

	/** Maximum files to process per batch (limits memory usage) */
	private static readonly FILES_PER_BATCH = 500;

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

		// Process files in batches to limit memory usage
		// Each batch: parse → embed → store → release memory
		const skippedFiles: string[] = [];
		const errors: Array<{ file: string; error: string }> = [];
		let totalFilesIndexed = 0;
		let totalChunksCreated = 0;
		let totalCost = 0;
		let totalTokens = 0;

		const totalBatches = Math.ceil(filesToIndex.length / Indexer.FILES_PER_BATCH);

		for (let batchNum = 0; batchNum < totalBatches; batchNum++) {
			const batchStart = batchNum * Indexer.FILES_PER_BATCH;
			const batchEnd = Math.min(batchStart + Indexer.FILES_PER_BATCH, filesToIndex.length);
			const batchFiles = filesToIndex.slice(batchStart, batchEnd);

			// Phase 1: Parse and chunk batch of files
			const batchChunks: Array<{ chunk: CodeChunk; filePath: string; fileHash: string }> = [];

			for (let i = 0; i < batchFiles.length; i++) {
				const filePath = batchFiles[i];
				const relativePath = relative(this.projectPath, filePath);
				const globalIndex = batchStart + i + 1;

				// Report progress (parsing phase) - show "X/Y" with filename, or just "X/Y files" at completion
				if (this.onProgress) {
					const batchInfo = totalBatches > 1 ? ` [batch ${batchNum + 1}/${totalBatches}]` : "";
					const isLast = globalIndex === filesToIndex.length;
					const detail = isLast ? `${globalIndex}/${filesToIndex.length} files` : `${globalIndex}/${filesToIndex.length} ${relativePath}`;
					this.onProgress(globalIndex, filesToIndex.length, `[parsing]${batchInfo} ${detail}`);
				}

				try {
					const content = readFileSync(filePath, "utf-8");
					const fileHash = computeFileHash(filePath);
					const chunks = await chunkFileByPath(content, filePath, fileHash);

					if (chunks.length === 0) {
						skippedFiles.push(relativePath);
					} else {
						for (const chunk of chunks) {
							batchChunks.push({ chunk, filePath, fileHash });
						}
					}
				} catch (error) {
					const errorMsg = error instanceof Error ? error.message : String(error);
					errors.push({ file: relativePath, error: errorMsg });
				}
			}

			// Skip embedding/storing if no chunks in this batch
			if (batchChunks.length === 0) {
				continue;
			}

			// Phase 2: Embed batch chunks
			const batchInfo = totalBatches > 1 ? ` [batch ${batchNum + 1}/${totalBatches}]` : "";
			if (this.onProgress) {
				this.onProgress(0, batchChunks.length, `[embedding]${batchInfo} ${batchChunks.length} chunks...`);
			}

			const texts = batchChunks.map((c) => c.chunk.content);
			let embedResult: { embeddings: number[][]; cost?: number; totalTokens?: number };

			try {
				// Pass progress callback to track embedding progress
				embedResult = await this.embeddingsClient!.embed(texts, (completed, total) => {
					if (this.onProgress) {
						this.onProgress(completed, total, `[embedding]${batchInfo} ${completed}/${total} chunks`);
					}
				});
			} catch (error) {
				const errorMsg = error instanceof Error ? error.message : String(error);
				throw new Error(`Embedding generation failed: ${errorMsg}`);
			}

			// Track cost and tokens
			if (embedResult.cost) totalCost += embedResult.cost;
			if (embedResult.totalTokens) totalTokens += embedResult.totalTokens;

			// Verify we got embeddings for all chunks
			if (embedResult.embeddings.length !== texts.length) {
				throw new Error(
					`Embedding count mismatch: expected ${texts.length}, got ${embedResult.embeddings.length}`,
				);
			}

			// Phase 3: Store batch chunks with embeddings
			const chunksWithEmbeddings: ChunkWithEmbedding[] = batchChunks.map((c, i) => ({
				...c.chunk,
				vector: embedResult.embeddings[i],
			}));

			if (this.onProgress) {
				const batchInfo = totalBatches > 1 ? ` [batch ${batchNum + 1}/${totalBatches}]` : "";
				this.onProgress(0, chunksWithEmbeddings.length, `[storing]${batchInfo} ${chunksWithEmbeddings.length} chunks...`);
			}
			await this.vectorStore!.addChunks(chunksWithEmbeddings);

			// Phase 4: Update file tracker for this batch
			const fileChunkMap = new Map<string, { fileHash: string; chunkIds: string[] }>();
			for (const { chunk, filePath, fileHash } of batchChunks) {
				if (!fileChunkMap.has(filePath)) {
					fileChunkMap.set(filePath, { fileHash, chunkIds: [] });
				}
				fileChunkMap.get(filePath)!.chunkIds.push(chunk.id);
			}

			for (const [filePath, { fileHash, chunkIds }] of fileChunkMap) {
				this.fileTracker!.markIndexed(filePath, fileHash, chunkIds);
			}

			totalFilesIndexed += fileChunkMap.size;
			totalChunksCreated += batchChunks.length;

			// Memory is released when batchChunks, embeddings, chunksWithEmbeddings go out of scope
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
			filesIndexed: totalFilesIndexed,
			chunksCreated: totalChunksCreated,
			durationMs,
			skippedFiles,
			errors,
			cost: totalCost > 0 ? totalCost : undefined,
			totalTokens: totalTokens > 0 ? totalTokens : undefined,
		};
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

					// Get file extension
					const ext = "." + entry.name.split(".").pop()?.toLowerCase();

					// Check extension filters from config
					if (this.excludeExtensions.has(ext)) {
						continue; // Skip excluded extensions
					}
					if (this.includeExtensions && !this.includeExtensions.has(ext)) {
						continue; // Skip if not in include list (when include list is specified)
					}

					// Check if file extension is supported by parser
					if (supportedExtensions.has(ext)) {
						files.push(fullPath);
					}
				}
			}
		};

		walk(this.projectPath);
		return files;
	}

	/** Directories to always exclude (fast path, no glob matching needed) */
	private static readonly ALWAYS_EXCLUDE_DIRS = new Set([
		"node_modules",
		".git",
		".svn",
		".hg",
		"dist",
		"build",
		"out",
		".next",
		".nuxt",
		"coverage",
		"__pycache__",
		"venv",
		".venv",
		"target",
		"vendor",
		".idea",
		".vscode",
		".cache",
		".claudemem",
		".turbo",
		".expo",
	]);

	/**
	 * Check if a path should be excluded
	 */
	private shouldExclude(relativePath: string, isDirectory: boolean): boolean {
		// Fast path: check if any path segment is in the always-exclude list
		const segments = relativePath.split("/");
		for (const segment of segments) {
			if (Indexer.ALWAYS_EXCLUDE_DIRS.has(segment)) {
				return true;
			}
		}

		// Slow path: check glob patterns
		const pathToCheck = isDirectory ? relativePath + "/" : relativePath;

		for (const pattern of this.excludePatterns) {
			if (minimatch(pathToCheck, pattern, { dot: true })) {
				return true;
			}
			// Also check without trailing slash
			if (minimatch(relativePath, pattern, { dot: true })) {
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
