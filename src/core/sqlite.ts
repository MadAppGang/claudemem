/**
 * SQLite Abstraction Layer
 *
 * Provides a unified interface that works with both:
 * - bun:sqlite (when running in Bun - dev mode or compiled binary)
 * - better-sqlite3 (when running in Node.js - npm install)
 */

// Detect if we're running in Bun
const isBun = typeof globalThis.Bun !== "undefined";

// Type definitions for our abstraction
export interface Statement {
	run(...params: unknown[]): void;
	get(...params: unknown[]): unknown;
	all(...params: unknown[]): unknown[];
}

export interface SQLiteDatabase {
	exec(sql: string): void;
	prepare(sql: string): Statement;
	close(): void;
}

/**
 * Create a SQLite database connection (synchronous)
 * Uses bun:sqlite in Bun, better-sqlite3 in Node.js
 */
export function createDatabaseSync(path: string): SQLiteDatabase {
	if (isBun) {
		// Use Bun's built-in SQLite
		// @ts-ignore - bun:sqlite is only available in Bun
		const { Database } = require("bun:sqlite");
		const db = new Database(path);

		return {
			exec: (sql: string) => db.exec(sql),
			prepare: (sql: string) => {
				const stmt = db.prepare(sql);
				return {
					run: (...params: unknown[]) => stmt.run(...params),
					get: (...params: unknown[]) => stmt.get(...params),
					all: (...params: unknown[]) => stmt.all(...params),
				};
			},
			close: () => db.close(),
		};
	} else {
		// Use better-sqlite3 for Node.js
		// @ts-ignore - dynamic require
		const BetterSqlite3 = require("better-sqlite3");
		const db = new BetterSqlite3(path);

		return {
			exec: (sql: string) => db.exec(sql),
			prepare: (sql: string) => {
				const stmt = db.prepare(sql);
				return {
					run: (...params: unknown[]) => stmt.run(...params),
					get: (...params: unknown[]) => stmt.get(...params),
					all: () => stmt.all(),
				};
			},
			close: () => db.close(),
		};
	}
}
