/**
 * Parallel Search Pipeline Types
 *
 * Core interfaces shared across all pipeline components.
 */

import type { QueryClassification } from "../../types.js";

// ============================================================================
// Backend Types
// ============================================================================

export type BackendName =
	| "symbol-graph"
	| "lsp"
	| "tree-sitter"
	| "semantic"
	| "location";

export interface BackendResult {
	/** Relative file path */
	file: string;
	/** Starting line number (1-indexed) */
	startLine: number;
	/** Ending line number (1-indexed), if known */
	endLine?: number;
	/** Symbol name, if applicable */
	symbol?: string;
	/** Source body text, if read from disk */
	body?: string;
	/** Display snippet (max 800 chars) */
	snippet: string;
	/** Normalized score [0, 1] within this backend */
	score: number;
	/** Which backend produced this result */
	backend: BackendName;
	/** Whether this result is a definitive exact match (LSP flag) */
	isDefinitive?: boolean;
}

export interface MergedResult extends BackendResult {
	/** Final merged RRF score */
	rrfScore: number;
	/** All backends that returned this result */
	backends: BackendName[];
}

export interface SearchOptions {
	/** Maximum results to return */
	limit?: number;
	/** Glob pattern to filter by file path */
	filePattern?: string;
}

// ============================================================================
// Backend Interface
// ============================================================================

export interface ISearchBackend {
	readonly name: BackendName;
	search(
		query: string,
		intent: QueryClassification,
		options: SearchOptions,
		signal: AbortSignal,
	): Promise<BackendResult[]>;
}
