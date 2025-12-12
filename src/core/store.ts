/**
 * LanceDB Vector Store
 *
 * Handles vector storage and hybrid search (BM25 + vector similarity)
 * using LanceDB's embedded database.
 */

import * as lancedb from "@lancedb/lancedb";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ChunkWithEmbedding, CodeChunk, SearchResult } from "../types.js";

// ============================================================================
// Constants
// ============================================================================

/** Table name for code chunks */
const CHUNKS_TABLE = "code_chunks";

/** Default search limit */
const DEFAULT_LIMIT = 10;

/** BM25 weight in hybrid search */
const BM25_WEIGHT = 0.4;

/** Vector weight in hybrid search */
const VECTOR_WEIGHT = 0.6;

// ============================================================================
// Types
// ============================================================================

interface StoredChunk {
	[key: string]: unknown;
	id: string;
	content: string;
	filePath: string;
	startLine: number;
	endLine: number;
	language: string;
	chunkType: string;
	name: string;
	parentName: string;
	signature: string;
	fileHash: string;
	vector: number[];
}

interface SearchOptions {
	limit?: number;
	language?: string;
	filePath?: string;
}

// ============================================================================
// Vector Store Class
// ============================================================================

export class VectorStore {
	private dbPath: string;
	private db: lancedb.Connection | null = null;
	private table: lancedb.Table | null = null;
	private dimension: number | null = null;

	constructor(dbPath: string) {
		this.dbPath = dbPath;
	}

	/**
	 * Initialize the database connection
	 */
	async initialize(): Promise<void> {
		// Ensure directory exists
		if (!existsSync(dirname(this.dbPath))) {
			mkdirSync(dirname(this.dbPath), { recursive: true });
		}

		this.db = await lancedb.connect(this.dbPath);
	}

	/**
	 * Ensure the table exists, opening it if available
	 */
	private async ensureTableOpen(): Promise<lancedb.Table | null> {
		if (!this.db) {
			await this.initialize();
		}

		if (this.table) {
			return this.table;
		}

		// Check if table exists
		const tables = await this.db!.tableNames();
		if (tables.includes(CHUNKS_TABLE)) {
			this.table = await this.db!.openTable(CHUNKS_TABLE);
			return this.table;
		}

		return null;
	}

	/**
	 * Add chunks with embeddings to the store
	 */
	async addChunks(chunks: ChunkWithEmbedding[]): Promise<void> {
		if (chunks.length === 0) {
			return;
		}

		// Convert to stored format
		// Use empty strings instead of null for optional fields to avoid Arrow type inference issues
		const data: StoredChunk[] = chunks.map((chunk) => ({
			id: chunk.id,
			content: chunk.content,
			filePath: chunk.filePath,
			startLine: chunk.startLine,
			endLine: chunk.endLine,
			language: chunk.language,
			chunkType: chunk.chunkType,
			name: chunk.name || "",
			parentName: chunk.parentName || "",
			signature: chunk.signature || "",
			fileHash: chunk.fileHash,
			vector: chunk.vector,
		}));

		// Try to open existing table
		let table = await this.ensureTableOpen();

		if (table) {
			// Table exists, add to it
			await table.add(data);
		} else {
			// Create table with the first batch of data
			if (!this.db) {
				await this.initialize();
			}
			this.table = await this.db!.createTable(CHUNKS_TABLE, data, {
				mode: "create",
			});
		}

		// Store dimension for later
		if (data.length > 0 && !this.dimension) {
			this.dimension = data[0].vector.length;
		}
	}

	/**
	 * Search for similar chunks using hybrid search
	 */
	async search(
		queryText: string,
		queryVector: number[],
		options: SearchOptions = {},
	): Promise<SearchResult[]> {
		const { limit = DEFAULT_LIMIT, language, filePath } = options;

		const table = await this.ensureTableOpen();
		if (!table) {
			// No index yet, return empty results
			return [];
		}

		// Build filter string
		const filters: string[] = [];
		if (language) {
			filters.push(`language = '${language}'`);
		}
		if (filePath) {
			filters.push(`filePath LIKE '%${filePath}%'`);
		}
		const filterStr = filters.length > 0 ? filters.join(" AND ") : undefined;

		// Vector search
		let vectorQuery = table.vectorSearch(queryVector).limit(limit * 2);
		if (filterStr) {
			vectorQuery = vectorQuery.where(filterStr);
		}
		const vectorResults = await vectorQuery.toArray();

		// BM25 full-text search (if available)
		let bm25Results: any[] = [];
		try {
			let ftsQuery = table
				.search(queryText, "content")
				.limit(limit * 2);
			if (filterStr) {
				ftsQuery = ftsQuery.where(filterStr);
			}
			bm25Results = await ftsQuery.toArray();
		} catch {
			// FTS might not be available, fall back to vector-only
			bm25Results = [];
		}

		// Reciprocal Rank Fusion
		const results = reciprocalRankFusion(
			vectorResults,
			bm25Results,
			VECTOR_WEIGHT,
			BM25_WEIGHT,
		);

		// Convert to SearchResult format
		return results.slice(0, limit).map((r) => ({
			chunk: {
				id: r.id,
				content: r.content,
				filePath: r.filePath,
				startLine: r.startLine,
				endLine: r.endLine,
				language: r.language,
				chunkType: r.chunkType as any,
				name: r.name || undefined,
				parentName: r.parentName || undefined,
				signature: r.signature || undefined,
				fileHash: r.fileHash,
			},
			score: r.fusedScore,
			vectorScore: r.vectorScore || 0,
			keywordScore: r.keywordScore || 0,
		}));
	}

	/**
	 * Delete all chunks from a specific file
	 */
	async deleteByFile(filePath: string): Promise<number> {
		if (!this.db || !this.table) {
			return 0;
		}

		try {
			await this.table.delete(`filePath = '${filePath}'`);
			return 1; // LanceDB doesn't return count
		} catch {
			return 0;
		}
	}

	/**
	 * Delete chunks by file hash
	 */
	async deleteByFileHash(fileHash: string): Promise<number> {
		if (!this.db || !this.table) {
			return 0;
		}

		try {
			await this.table.delete(`fileHash = '${fileHash}'`);
			return 1;
		} catch {
			return 0;
		}
	}

	/**
	 * Delete all chunks
	 */
	async clear(): Promise<void> {
		if (!this.db) {
			return;
		}

		// Drop and recreate the table
		const tables = await this.db.tableNames();
		if (tables.includes(CHUNKS_TABLE)) {
			await this.db.dropTable(CHUNKS_TABLE);
		}
		this.table = null;
	}

	/**
	 * Get chunk contents for benchmarking
	 */
	async getChunkContents(limit?: number): Promise<string[]> {
		const table = await this.ensureTableOpen();
		if (!table) {
			return [];
		}

		try {
			let query = table.query();
			if (limit) {
				query = query.limit(limit);
			}
			const allData = await query.toArray();
			return allData.map((row) => row.content as string);
		} catch {
			return [];
		}
	}

	/**
	 * Get statistics about the store
	 */
	async getStats(): Promise<{
		totalChunks: number;
		uniqueFiles: number;
		languages: string[];
	}> {
		// Ensure table is opened before querying
		const table = await this.ensureTableOpen();
		if (!table) {
			return { totalChunks: 0, uniqueFiles: 0, languages: [] };
		}

		try {
			const allData = await table.query().toArray();

			const files = new Set<string>();
			const languages = new Set<string>();

			for (const row of allData) {
				files.add(row.filePath);
				languages.add(row.language);
			}

			return {
				totalChunks: allData.length,
				uniqueFiles: files.size,
				languages: Array.from(languages),
			};
		} catch {
			return { totalChunks: 0, uniqueFiles: 0, languages: [] };
		}
	}

	/**
	 * Close the database connection
	 */
	async close(): Promise<void> {
		// LanceDB connections are auto-managed
		this.db = null;
		this.table = null;
	}
}

// ============================================================================
// Reciprocal Rank Fusion
// ============================================================================

interface FusedResult extends StoredChunk {
	fusedScore: number;
	vectorScore?: number;
	keywordScore?: number;
}

/**
 * Combine results from vector and BM25 search using RRF
 */
function reciprocalRankFusion(
	vectorResults: any[],
	bm25Results: any[],
	vectorWeight: number,
	bm25Weight: number,
	k = 60, // RRF constant
): FusedResult[] {
	const scores = new Map<string, FusedResult>();

	// Add vector results with their ranks
	for (let i = 0; i < vectorResults.length; i++) {
		const result = vectorResults[i];
		const id = result.id;
		const rrf = vectorWeight / (k + i + 1);

		if (!scores.has(id)) {
			scores.set(id, {
				...result,
				fusedScore: rrf,
				vectorScore: 1 / (i + 1),
			});
		} else {
			const existing = scores.get(id)!;
			existing.fusedScore += rrf;
			existing.vectorScore = 1 / (i + 1);
		}
	}

	// Add BM25 results with their ranks
	for (let i = 0; i < bm25Results.length; i++) {
		const result = bm25Results[i];
		const id = result.id;
		const rrf = bm25Weight / (k + i + 1);

		if (!scores.has(id)) {
			scores.set(id, {
				...result,
				fusedScore: rrf,
				keywordScore: 1 / (i + 1),
			});
		} else {
			const existing = scores.get(id)!;
			existing.fusedScore += rrf;
			existing.keywordScore = 1 / (i + 1);
		}
	}

	// Sort by fused score
	return Array.from(scores.values()).sort((a, b) => b.fusedScore - a.fusedScore);
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a vector store for a project
 */
export function createVectorStore(dbPath: string): VectorStore {
	return new VectorStore(dbPath);
}
