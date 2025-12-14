/**
 * LanceDB Vector Store
 *
 * Handles vector storage and hybrid search (BM25 + vector similarity)
 * using LanceDB's embedded database.
 */

import * as lancedb from "@lancedb/lancedb";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
	BaseDocument,
	ChunkWithEmbedding,
	CodeChunk,
	DocumentType,
	DocumentWithEmbedding,
	EnrichedSearchOptions,
	EnrichedSearchResult,
	SearchResult,
	SearchUseCase,
} from "../types.js";

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
// Helper Functions
// ============================================================================

/**
 * Escape special characters in filter values to prevent injection attacks
 * and crashes on special characters (identified by multi-model review)
 */
function escapeFilterValue(value: string): string {
	// Escape single quotes by doubling them (SQL-style escaping)
	// Also escape backslashes and other special chars
	return value
		.replace(/\\/g, "\\\\")
		.replace(/'/g, "''")
		.replace(/%/g, "\\%")
		.replace(/_/g, "\\_");
}

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
	// Enriched document fields
	documentType: string; // "code_chunk" for code, others for enriched docs
	sourceIds: string; // JSON array of source chunk IDs
	metadata: string; // JSON for type-specific fields
	createdAt: string;
	enrichedAt: string;
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
	private tableDimension: number | null = null;
	private _dimensionMismatchCleared = false;

	constructor(dbPath: string) {
		this.dbPath = dbPath;
	}

	/**
	 * Returns true if vectors were auto-cleared due to dimension mismatch
	 * during this session. Used by indexer to also clear file tracker.
	 */
	get dimensionMismatchCleared(): boolean {
		return this._dimensionMismatchCleared;
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

			// Extract vector dimension from schema for compatibility checks
			try {
				const schema = await this.table.schema();
				const vectorField = schema.fields.find((f: { name: string }) => f.name === "vector");
				if (vectorField && vectorField.type && "listSize" in vectorField.type) {
					this.tableDimension = (vectorField.type as { listSize: number }).listSize;
				}
			} catch {
				// Ignore schema read errors - dimension check will be skipped
			}

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
		const now = new Date().toISOString();
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
			// Enriched document fields (defaults for code chunks)
			documentType: "code_chunk",
			sourceIds: "[]",
			metadata: "{}",
			createdAt: now,
			enrichedAt: "",
		}));

		// Try to open existing table
		let table = await this.ensureTableOpen();

		// Check for dimension mismatch with existing table
		const incomingDimension = data[0].vector.length;
		if (table && this.tableDimension && this.tableDimension !== incomingDimension) {
			// Dimension mismatch - clear the table and recreate
			// This happens when embedding model changes but tracker metadata wasn't updated properly
			console.warn(
				`⚠️  Vector dimension mismatch: table has ${this.tableDimension}d, new embeddings are ${incomingDimension}d`,
			);
			console.warn("   Clearing existing vectors to match new embedding model...\n");
			await this.clear();
			table = null;
			this.tableDimension = null;
			this._dimensionMismatchCleared = true;
		}

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
			this.tableDimension = incomingDimension;
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

		// Build filter string with escaped values to prevent injection
		const filters: string[] = [];
		if (language) {
			filters.push(`language = '${escapeFilterValue(language)}'`);
		}
		if (filePath) {
			filters.push(`filePath LIKE '%${escapeFilterValue(filePath)}%'`);
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

	// ========================================================================
	// Enriched Document Methods
	// ========================================================================

	/**
	 * Add enriched documents with embeddings to the store
	 */
	async addDocuments(documents: DocumentWithEmbedding[]): Promise<void> {
		if (documents.length === 0) {
			return;
		}

		const now = new Date().toISOString();
		const data: StoredChunk[] = documents.map((doc) => ({
			id: doc.id,
			content: doc.content,
			filePath: doc.filePath || "",
			startLine: 0,
			endLine: 0,
			language: "",
			chunkType: "",
			name: "",
			parentName: "",
			signature: "",
			fileHash: doc.fileHash || "",
			vector: doc.vector,
			// Enriched document fields
			documentType: doc.documentType,
			sourceIds: JSON.stringify(doc.sourceIds || []),
			metadata: JSON.stringify(doc.metadata || {}),
			createdAt: doc.createdAt || now,
			enrichedAt: doc.enrichedAt || now,
		}));

		// Try to open existing table
		let table = await this.ensureTableOpen();

		// Check for dimension mismatch with existing table
		const incomingDimension = data[0].vector.length;
		if (table && this.tableDimension && this.tableDimension !== incomingDimension) {
			console.warn(
				`⚠️  Vector dimension mismatch: table has ${this.tableDimension}d, new embeddings are ${incomingDimension}d`,
			);
			console.warn("   Clearing existing vectors to match new embedding model...\n");
			await this.clear();
			table = null;
			this.tableDimension = null;
			this._dimensionMismatchCleared = true;
		}

		if (table) {
			await table.add(data);
		} else {
			if (!this.db) {
				await this.initialize();
			}
			this.table = await this.db!.createTable(CHUNKS_TABLE, data, {
				mode: "create",
			});
			this.tableDimension = incomingDimension;
		}

		if (data.length > 0 && !this.dimension) {
			this.dimension = data[0].vector.length;
		}
	}

	/**
	 * Delete all documents of a specific type
	 */
	async deleteByDocumentType(documentType: DocumentType): Promise<number> {
		if (!this.db || !this.table) {
			return 0;
		}

		try {
			await this.table.delete(`documentType = '${documentType}'`);
			return 1;
		} catch {
			return 0;
		}
	}

	/**
	 * Delete all documents (code chunks and enriched) for a specific file
	 */
	async deleteAllByFile(filePath: string): Promise<number> {
		if (!this.db || !this.table) {
			return 0;
		}

		try {
			await this.table.delete(`filePath = '${filePath}'`);
			return 1;
		} catch {
			return 0;
		}
	}

	/**
	 * Get all documents for a specific file
	 */
	async getDocumentsByFile(
		filePath: string,
		documentTypes?: DocumentType[],
	): Promise<BaseDocument[]> {
		const table = await this.ensureTableOpen();
		if (!table) {
			return [];
		}

		try {
			let filter = `filePath = '${filePath}'`;
			if (documentTypes && documentTypes.length > 0) {
				const types = documentTypes.map((t) => `'${t}'`).join(", ");
				filter += ` AND documentType IN (${types})`;
			}

			const results = await table.query().where(filter).toArray();

			return results.map((row) => ({
				id: row.id,
				content: row.content,
				documentType: row.documentType as DocumentType,
				filePath: row.filePath || undefined,
				fileHash: row.fileHash || undefined,
				createdAt: row.createdAt,
				enrichedAt: row.enrichedAt || undefined,
				sourceIds: row.sourceIds ? JSON.parse(row.sourceIds) : undefined,
				metadata: row.metadata ? JSON.parse(row.metadata) : undefined,
			}));
		} catch {
			return [];
		}
	}

	/**
	 * Search with document type filtering and use-case weights
	 */
	async searchDocuments(
		queryText: string,
		queryVector: number[],
		options: EnrichedSearchOptions = {},
	): Promise<EnrichedSearchResult[]> {
		const {
			limit = DEFAULT_LIMIT,
			language,
			pathPattern,
			documentTypes,
			typeWeights,
			useCase,
			includeCodeChunks = true,
		} = options;

		const table = await this.ensureTableOpen();
		if (!table) {
			return [];
		}

		// Build filter string with escaped values to prevent injection
		const filters: string[] = [];
		if (language) {
			filters.push(`language = '${escapeFilterValue(language)}'`);
		}
		if (pathPattern) {
			filters.push(`filePath LIKE '%${escapeFilterValue(pathPattern)}%'`);
		}

		// Filter by document types (these are enum values, but escape anyway for safety)
		const effectiveTypes = documentTypes || (includeCodeChunks
			? undefined // No filter = all types
			: ["file_summary", "symbol_summary", "idiom", "usage_example", "anti_pattern", "project_doc"]);

		if (effectiveTypes && effectiveTypes.length > 0) {
			const types = effectiveTypes.map((t) => `'${escapeFilterValue(t)}'`).join(", ");
			filters.push(`documentType IN (${types})`);
		}

		const filterStr = filters.length > 0 ? filters.join(" AND ") : undefined;

		// Vector search
		let vectorQuery = table.vectorSearch(queryVector).limit(limit * 3);
		if (filterStr) {
			vectorQuery = vectorQuery.where(filterStr);
		}
		const vectorResults = await vectorQuery.toArray();

		// BM25 full-text search
		let bm25Results: any[] = [];
		try {
			let ftsQuery = table.search(queryText, "content").limit(limit * 3);
			if (filterStr) {
				ftsQuery = ftsQuery.where(filterStr);
			}
			bm25Results = await ftsQuery.toArray();
		} catch {
			bm25Results = [];
		}

		// Get weights for the use case
		const weights = typeWeights || getUseCaseWeights(useCase);

		// Type-aware RRF fusion
		const results = typeAwareRRFFusion(
			vectorResults,
			bm25Results,
			VECTOR_WEIGHT,
			BM25_WEIGHT,
			weights,
		);

		// Convert to EnrichedSearchResult format
		return results.slice(0, limit).map((r) => ({
			document: {
				id: r.id,
				content: r.content,
				documentType: r.documentType as DocumentType,
				filePath: r.filePath || undefined,
				fileHash: r.fileHash || undefined,
				createdAt: r.createdAt,
				enrichedAt: r.enrichedAt || undefined,
				sourceIds: r.sourceIds ? JSON.parse(r.sourceIds) : undefined,
				metadata: r.metadata ? JSON.parse(r.metadata) : undefined,
			},
			score: r.fusedScore,
			vectorScore: r.vectorScore || 0,
			keywordScore: r.keywordScore || 0,
			documentType: r.documentType as DocumentType,
		}));
	}

	/**
	 * Get document type statistics
	 */
	async getDocumentTypeStats(): Promise<Record<DocumentType, number>> {
		const table = await this.ensureTableOpen();
		if (!table) {
			return {} as Record<DocumentType, number>;
		}

		try {
			const allData = await table.query().toArray();

			const counts: Record<string, number> = {};
			for (const row of allData) {
				const docType = row.documentType || "code_chunk";
				counts[docType] = (counts[docType] || 0) + 1;
			}

			return counts as Record<DocumentType, number>;
		} catch {
			return {} as Record<DocumentType, number>;
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
// Use Case Weights
// ============================================================================

/** Default weights per document type for each use case */
const USE_CASE_WEIGHTS: Record<SearchUseCase, Partial<Record<DocumentType, number>>> = {
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

/**
 * Get weights for a use case (or default balanced weights)
 */
function getUseCaseWeights(useCase?: SearchUseCase): Partial<Record<DocumentType, number>> {
	if (useCase && USE_CASE_WEIGHTS[useCase]) {
		return USE_CASE_WEIGHTS[useCase];
	}
	// Default balanced weights
	return {
		code_chunk: 0.3,
		file_summary: 0.15,
		symbol_summary: 0.2,
		idiom: 0.15,
		usage_example: 0.1,
		anti_pattern: 0.05,
		project_doc: 0.05,
	};
}

// ============================================================================
// Type-Aware RRF Fusion
// ============================================================================

/**
 * Combine results with document type weighting
 */
function typeAwareRRFFusion(
	vectorResults: any[],
	bm25Results: any[],
	vectorWeight: number,
	bm25Weight: number,
	typeWeights: Partial<Record<DocumentType, number>>,
	k = 60,
): FusedResult[] {
	const scores = new Map<string, FusedResult>();

	// Process vector results
	for (let i = 0; i < vectorResults.length; i++) {
		const result = vectorResults[i];
		const id = result.id;
		const docType = (result.documentType || "code_chunk") as DocumentType;
		const typeWeight = typeWeights[docType] ?? 0.1;
		const rrf = (vectorWeight * typeWeight) / (k + i + 1);

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

	// Process BM25 results
	for (let i = 0; i < bm25Results.length; i++) {
		const result = bm25Results[i];
		const id = result.id;
		const docType = (result.documentType || "code_chunk") as DocumentType;
		const typeWeight = typeWeights[docType] ?? 0.1;
		const rrf = (bm25Weight * typeWeight) / (k + i + 1);

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
