/**
 * File State Tracker
 *
 * Tracks file states using SQLite for efficient incremental indexing.
 * Uses content hashes and mtimes for fast change detection.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative } from "node:path";
import Database from "better-sqlite3";
import type { FileState } from "../types.js";

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

// ============================================================================
// File Tracker Class
// ============================================================================

export class FileTracker {
	private db: Database.Database;
	private projectRoot: string;

	constructor(dbPath: string, projectRoot: string) {
		// Ensure directory exists
		const dir = dirname(dbPath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		this.projectRoot = projectRoot;
		this.db = new Database(dbPath);
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
        indexed_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_files_content_hash ON files(content_hash);
    `);
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
	}

	/**
	 * Close the database connection
	 */
	close(): void {
		this.db.close();
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
