/**
 * File State Tracker
 *
 * Tracks file states using SQLite for efficient incremental indexing.
 * Uses content hashes and mtimes for fast change detection.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative } from "node:path";
import type { DocumentType, EnrichmentState, FileState } from "../types.js";
import { createDatabaseSync, type SQLiteDatabase } from "./sqlite.js";

// ============================================================================
// Types
// ============================================================================

export interface FileChanges {
	/** Files that are new (not in index) */
	newFiles: string[];
	/** Files that have been modified */
	modifiedFiles: string[];
	/** Files that have been deleted */
	deletedFiles: string[];
	/** Files that are unchanged */
	unchangedFiles: string[];
}

/** Enrichment state per document type for a file */
export type EnrichmentStateMap = Partial<Record<DocumentType, EnrichmentState>>;

/** Document tracking info */
export interface TrackedDocument {
	id: string;
	documentType: DocumentType;
	filePath: string;
	sourceIds: string[];
	createdAt: string;
	enrichedAt?: string;
}

// ============================================================================
// File Tracker Class
// ============================================================================

export class FileTracker {
	private db: SQLiteDatabase;
	private projectRoot: string;

	constructor(dbPath: string, projectRoot: string) {
		// Ensure directory exists
		const dir = dirname(dbPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		this.projectRoot = projectRoot;
		this.db = createDatabaseSync(dbPath);
		this.initializeSchema();
	}

	/**
	 * Initialize the database schema
	 */
	private initializeSchema(): void {
		this.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        mtime REAL NOT NULL,
        chunk_ids TEXT NOT NULL,
        indexed_at TEXT NOT NULL,
        enrichment_state TEXT DEFAULT '{}',
        enriched_at TEXT
      );

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        document_type TEXT NOT NULL,
        file_path TEXT,
        source_ids TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        enriched_at TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_files_content_hash ON files(content_hash);
      CREATE INDEX IF NOT EXISTS idx_documents_file_path ON documents(file_path);
      CREATE INDEX IF NOT EXISTS idx_documents_type ON documents(document_type);
    `);

		// Migration: Add enrichment columns if they don't exist (for existing databases)
		this.migrateSchema();
	}

	/**
	 * Migrate schema for existing databases
	 */
	private migrateSchema(): void {
		try {
			// Check if enrichment_state column exists
			const columns = this.db.prepare("PRAGMA table_info(files)").all() as Array<{ name: string }>;
			const columnNames = columns.map((c) => c.name);

			if (!columnNames.includes("enrichment_state")) {
				this.db.exec("ALTER TABLE files ADD COLUMN enrichment_state TEXT DEFAULT '{}'");
			}
			if (!columnNames.includes("enriched_at")) {
				this.db.exec("ALTER TABLE files ADD COLUMN enriched_at TEXT");
			}
		} catch {
			// Ignore migration errors (columns might already exist)
		}
	}

	/**
	 * Get changes between current files and indexed state
	 */
	getChanges(currentFiles: string[]): FileChanges {
		const newFiles: string[] = [];
		const modifiedFiles: string[] = [];
		const unchangedFiles: string[] = [];

		// Get all indexed files
		const indexedFiles = new Set<string>();
		const stmt = this.db.prepare("SELECT path, content_hash, mtime FROM files");
		const indexed = stmt.all() as Array<{
			path: string;
			content_hash: string;
			mtime: number;
		}>;

		const indexedMap = new Map(indexed.map((f) => [f.path, f]));
		for (const f of indexed) {
			indexedFiles.add(f.path);
		}

		// Check each current file
		for (const filePath of currentFiles) {
			const relativePath = relative(this.projectRoot, filePath);

			if (!indexedMap.has(relativePath)) {
				// New file
				newFiles.push(filePath);
			} else {
				// Check if modified
				const indexedFile = indexedMap.get(relativePath)!;

				try {
					const stat = statSync(filePath);
					const currentMtime = stat.mtimeMs;

					// Fast path: check mtime first
					if (currentMtime !== indexedFile.mtime) {
						// Mtime changed, verify with hash
						const currentHash = this.computeFileHash(filePath);

						if (currentHash !== indexedFile.content_hash) {
							modifiedFiles.push(filePath);
						} else {
							// Hash same, just update mtime
							this.updateMtime(relativePath, currentMtime);
							unchangedFiles.push(filePath);
						}
					} else {
						// Mtime unchanged, assume file unchanged
						unchangedFiles.push(filePath);
					}
				} catch {
					// File might have been deleted between listing and checking
					modifiedFiles.push(filePath);
				}
			}
		}

		// Find deleted files
		const currentSet = new Set(
			currentFiles.map((f) => relative(this.projectRoot, f)),
		);
		const deletedFiles: string[] = [];

		for (const indexedPath of indexedFiles) {
			if (!currentSet.has(indexedPath)) {
				deletedFiles.push(indexedPath);
			}
		}

		return { newFiles, modifiedFiles, deletedFiles, unchangedFiles };
	}

	/**
	 * Mark a file as indexed
	 */
	markIndexed(
		filePath: string,
		contentHash: string,
		chunkIds: string[],
	): void {
		const relativePath = relative(this.projectRoot, filePath);

		let mtime: number;
		try {
			const stat = statSync(filePath);
			mtime = stat.mtimeMs;
		} catch {
			mtime = Date.now();
		}

		const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO files (path, content_hash, mtime, chunk_ids, indexed_at)
      VALUES (?, ?, ?, ?, ?)
    `);

		stmt.run(
			relativePath,
			contentHash,
			mtime,
			JSON.stringify(chunkIds),
			new Date().toISOString(),
		);
	}

	/**
	 * Get chunk IDs for a file
	 */
	getChunkIds(filePath: string): string[] {
		const relativePath = relative(this.projectRoot, filePath);

		const stmt = this.db.prepare(
			"SELECT chunk_ids FROM files WHERE path = ?",
		);
		const row = stmt.get(relativePath) as { chunk_ids: string } | undefined;

		if (!row) {
			return [];
		}

		try {
			return JSON.parse(row.chunk_ids);
		} catch {
			return [];
		}
	}

	/**
	 * Remove a file from the index
	 */
	removeFile(filePath: string): void {
		// Handle both absolute and relative paths
		const relativePath = filePath.startsWith(this.projectRoot)
			? relative(this.projectRoot, filePath)
			: filePath;

		const stmt = this.db.prepare("DELETE FROM files WHERE path = ?");
		stmt.run(relativePath);
	}

	/**
	 * Get file state
	 */
	getFileState(filePath: string): FileState | null {
		const relativePath = relative(this.projectRoot, filePath);

		const stmt = this.db.prepare(
			"SELECT path, content_hash, mtime, chunk_ids FROM files WHERE path = ?",
		);
		const row = stmt.get(relativePath) as
			| {
					path: string;
					content_hash: string;
					mtime: number;
					chunk_ids: string;
			  }
			| undefined;

		if (!row) {
			return null;
		}

		return {
			path: row.path,
			contentHash: row.content_hash,
			mtime: row.mtime,
			chunkIds: JSON.parse(row.chunk_ids),
		};
	}

	/**
	 * Get all indexed files
	 */
	getAllFiles(): FileState[] {
		const stmt = this.db.prepare(
			"SELECT path, content_hash, mtime, chunk_ids FROM files",
		);
		const rows = stmt.all() as Array<{
			path: string;
			content_hash: string;
			mtime: number;
			chunk_ids: string;
		}>;

		return rows.map((row) => ({
			path: row.path,
			contentHash: row.content_hash,
			mtime: row.mtime,
			chunkIds: JSON.parse(row.chunk_ids),
		}));
	}

	/**
	 * Get metadata value
	 */
	getMetadata(key: string): string | null {
		const stmt = this.db.prepare(
			"SELECT value FROM metadata WHERE key = ?",
		);
		const row = stmt.get(key) as { value: string } | undefined;
		return row?.value || null;
	}

	/**
	 * Set metadata value
	 */
	setMetadata(key: string, value: string): void {
		const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO metadata (key, value) VALUES (?, ?)
    `);
		stmt.run(key, value);
	}

	/**
	 * Get statistics
	 */
	getStats(): { totalFiles: number; lastIndexed: string | null } {
		const countStmt = this.db.prepare("SELECT COUNT(*) as count FROM files");
		const countRow = countStmt.get() as { count: number };

		const lastStmt = this.db.prepare(
			"SELECT MAX(indexed_at) as last FROM files",
		);
		const lastRow = lastStmt.get() as { last: string | null };

		return {
			totalFiles: countRow.count,
			lastIndexed: lastRow.last,
		};
	}

	/**
	 * Clear all data
	 */
	clear(): void {
		this.db.exec("DELETE FROM files");
		this.db.exec("DELETE FROM metadata");
		this.db.exec("DELETE FROM documents");
	}

	/**
	 * Close the database connection
	 */
	close(): void {
		this.db.close();
	}

	// ========================================================================
	// Enrichment Tracking Methods
	// ========================================================================

	/**
	 * Get enrichment state for a file
	 */
	getEnrichmentState(filePath: string): EnrichmentStateMap {
		const relativePath = relative(this.projectRoot, filePath);

		const stmt = this.db.prepare(
			"SELECT enrichment_state FROM files WHERE path = ?",
		);
		const row = stmt.get(relativePath) as { enrichment_state: string } | undefined;

		if (!row || !row.enrichment_state) {
			return {};
		}

		try {
			return JSON.parse(row.enrichment_state);
		} catch {
			return {};
		}
	}

	/**
	 * Set enrichment state for a specific document type
	 */
	setEnrichmentState(
		filePath: string,
		documentType: DocumentType,
		state: EnrichmentState,
	): void {
		const relativePath = relative(this.projectRoot, filePath);

		// Get current state
		const current = this.getEnrichmentState(filePath);
		current[documentType] = state;

		const stmt = this.db.prepare(`
			UPDATE files SET enrichment_state = ?, enriched_at = ?
			WHERE path = ?
		`);

		stmt.run(
			JSON.stringify(current),
			state === "complete" ? new Date().toISOString() : null,
			relativePath,
		);
	}

	/**
	 * Set all enrichment states for a file at once
	 */
	setAllEnrichmentStates(
		filePath: string,
		states: EnrichmentStateMap,
	): void {
		const relativePath = relative(this.projectRoot, filePath);

		const hasComplete = Object.values(states).some((s) => s === "complete");

		const stmt = this.db.prepare(`
			UPDATE files SET enrichment_state = ?, enriched_at = ?
			WHERE path = ?
		`);

		stmt.run(
			JSON.stringify(states),
			hasComplete ? new Date().toISOString() : null,
			relativePath,
		);
	}

	/**
	 * Reset enrichment state for a file (e.g., when file is modified)
	 */
	resetEnrichmentState(filePath: string): void {
		const relativePath = relative(this.projectRoot, filePath);

		const stmt = this.db.prepare(`
			UPDATE files SET enrichment_state = '{}', enriched_at = NULL
			WHERE path = ?
		`);

		stmt.run(relativePath);
	}

	/**
	 * Check if a file needs enrichment for a specific document type
	 */
	needsEnrichment(filePath: string, documentType: DocumentType): boolean {
		const state = this.getEnrichmentState(filePath);
		return state[documentType] !== "complete";
	}

	/**
	 * Get all files that need enrichment for a specific document type
	 */
	getFilesNeedingEnrichment(documentType: DocumentType): string[] {
		const stmt = this.db.prepare("SELECT path, enrichment_state FROM files");
		const rows = stmt.all() as Array<{ path: string; enrichment_state: string }>;

		const needsEnrichment: string[] = [];
		for (const row of rows) {
			try {
				const state = JSON.parse(row.enrichment_state || "{}") as EnrichmentStateMap;
				if (state[documentType] !== "complete") {
					needsEnrichment.push(row.path);
				}
			} catch {
				needsEnrichment.push(row.path);
			}
		}

		return needsEnrichment;
	}

	// ========================================================================
	// Document Tracking Methods
	// ========================================================================

	/**
	 * Track a document in the documents table
	 */
	trackDocument(doc: TrackedDocument): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO documents (id, document_type, file_path, source_ids, created_at, enriched_at)
			VALUES (?, ?, ?, ?, ?, ?)
		`);

		stmt.run(
			doc.id,
			doc.documentType,
			doc.filePath,
			JSON.stringify(doc.sourceIds),
			doc.createdAt,
			doc.enrichedAt || null,
		);
	}

	/**
	 * Track multiple documents at once
	 */
	trackDocuments(docs: TrackedDocument[]): void {
		const stmt = this.db.prepare(`
			INSERT OR REPLACE INTO documents (id, document_type, file_path, source_ids, created_at, enriched_at)
			VALUES (?, ?, ?, ?, ?, ?)
		`);

		for (const doc of docs) {
			stmt.run(
				doc.id,
				doc.documentType,
				doc.filePath,
				JSON.stringify(doc.sourceIds),
				doc.createdAt,
				doc.enrichedAt || null,
			);
		}
	}

	/**
	 * Get all tracked documents for a file
	 */
	getDocumentsForFile(filePath: string): TrackedDocument[] {
		const relativePath = relative(this.projectRoot, filePath);

		const stmt = this.db.prepare(
			"SELECT id, document_type, file_path, source_ids, created_at, enriched_at FROM documents WHERE file_path = ?",
		);
		const rows = stmt.all(relativePath) as Array<{
			id: string;
			document_type: string;
			file_path: string;
			source_ids: string;
			created_at: string;
			enriched_at: string | null;
		}>;

		return rows.map((row) => ({
			id: row.id,
			documentType: row.document_type as DocumentType,
			filePath: row.file_path,
			sourceIds: JSON.parse(row.source_ids),
			createdAt: row.created_at,
			enrichedAt: row.enriched_at || undefined,
		}));
	}

	/**
	 * Get all tracked documents of a specific type
	 */
	getDocumentsByType(documentType: DocumentType): TrackedDocument[] {
		const stmt = this.db.prepare(
			"SELECT id, document_type, file_path, source_ids, created_at, enriched_at FROM documents WHERE document_type = ?",
		);
		const rows = stmt.all(documentType) as Array<{
			id: string;
			document_type: string;
			file_path: string;
			source_ids: string;
			created_at: string;
			enriched_at: string | null;
		}>;

		return rows.map((row) => ({
			id: row.id,
			documentType: row.document_type as DocumentType,
			filePath: row.file_path,
			sourceIds: JSON.parse(row.source_ids),
			createdAt: row.created_at,
			enrichedAt: row.enriched_at || undefined,
		}));
	}

	/**
	 * Delete all documents for a file
	 */
	deleteDocumentsForFile(filePath: string): void {
		const relativePath = relative(this.projectRoot, filePath);

		const stmt = this.db.prepare("DELETE FROM documents WHERE file_path = ?");
		stmt.run(relativePath);
	}

	/**
	 * Delete documents by type
	 */
	deleteDocumentsByType(documentType: DocumentType): void {
		const stmt = this.db.prepare("DELETE FROM documents WHERE document_type = ?");
		stmt.run(documentType);
	}

	/**
	 * Get document count by type
	 */
	getDocumentCounts(): Record<DocumentType, number> {
		const stmt = this.db.prepare(
			"SELECT document_type, COUNT(*) as count FROM documents GROUP BY document_type",
		);
		const rows = stmt.all() as Array<{ document_type: string; count: number }>;

		const counts: Record<string, number> = {};
		for (const row of rows) {
			counts[row.document_type] = row.count;
		}

		return counts as Record<DocumentType, number>;
	}

	/**
	 * Update mtime for a file without changing other fields
	 */
	private updateMtime(relativePath: string, mtime: number): void {
		const stmt = this.db.prepare(
			"UPDATE files SET mtime = ? WHERE path = ?",
		);
		stmt.run(mtime, relativePath);
	}

	/**
	 * Compute SHA256 hash of file content
	 */
	private computeFileHash(filePath: string): string {
		const content = readFileSync(filePath);
		return createHash("sha256").update(content).digest("hex");
	}
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Compute SHA256 hash of a string
 */
export function computeHash(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

/**
 * Compute SHA256 hash of a file
 */
export function computeFileHash(filePath: string): string {
	const content = readFileSync(filePath);
	return createHash("sha256").update(content).digest("hex");
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a file tracker for a project
 */
export function createFileTracker(
	dbPath: string,
	projectRoot: string,
): FileTracker {
	return new FileTracker(dbPath, projectRoot);
}
