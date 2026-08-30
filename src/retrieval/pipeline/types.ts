/**
 * Parallel Search Pipeline Types
 *
 * Core interfaces shared across all pipeline components.
 */

import type { DocumentType, QueryClassification } from "../../types.js";

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
	/**
	 * Stable identity for this result (e.g. chunk id). When present it is used
	 * as the merge key instead of `file:startLine` — required for results that
	 * have no file anchor (observations recorded without affected files), which
	 * would otherwise all collapse into a single `":0"` entry.
	 */
	id?: string;
	/**
	 * Document type from the index (code_chunk, session_observation, …).
	 * Absent for backends that do not read from the document store.
	 */
	documentType?: DocumentType;
	/** Observation metadata — only set for `session_observation` results */
	observationMetadata?: Record<string, unknown>;
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
