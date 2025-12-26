/**
 * Types for external documentation fetching
 */

import type { DocProviderType, DocumentType } from "../types.js";

// ============================================================================
// Provider Types
// ============================================================================

/** A single fetched documentation entry */
export interface FetchedDoc {
	/** Unique identifier for this doc */
	id: string;
	/** Document title */
	title: string;
	/** Full content (markdown) */
	content: string;
	/** Section/category within the library docs */
	section?: string;
	/** Original source URL */
	url?: string;
	/** Tags/topics */
	tags?: string[];
}

/** Options for fetching documentation */
export interface FetchOptions {
	/** Specific version to fetch (e.g., "v18", "3.0") */
	version?: string;
	/** Topic to filter by */
	topic?: string;
	/** Maximum pages to fetch (for paginated APIs) */
	maxPages?: number;
	/** Progress callback */
	onProgress?: (current: number, total: number) => void;
}

/** Documentation provider interface */
export interface DocProvider {
	/** Provider name */
	name: DocProviderType;
	/** Priority for fallback chain (lower = try first) */
	priority: number;

	/** Check if this provider supports the given library */
	supports(library: string): Promise<boolean>;

	/** Fetch documentation for a library */
	fetch(library: string, options?: FetchOptions): Promise<FetchedDoc[]>;
}

// ============================================================================
// Library Mapping Types
// ============================================================================

/** Package ecosystem/registry */
export type PackageEcosystem = "npm" | "pypi" | "go" | "cargo";

/** Version constraint from package file */
export interface VersionConstraint {
	/** Original version string (e.g., "^18.2.0", ">=3.9,<4.0") */
	raw: string;
	/** Parsed major version */
	major: number;
	/** Parsed minor version (optional) */
	minor?: number;
	/** Parsed patch version (optional) */
	patch?: number;
	/** Version operator (^, ~, >=, etc.) */
	operator?: string;
}

/** Dependency detected from a project's manifest files */
export interface DetectedDependency {
	/** Package name as specified in manifest */
	name: string;
	/** Version constraint from manifest */
	version: string;
	/** Extracted major version for API calls (e.g., "v18") */
	majorVersion?: string;
	/** Package ecosystem */
	ecosystem: PackageEcosystem;
	/** Whether this is a dev dependency */
	isDev: boolean;
}

/** Documentation source mapping for a library */
export interface LibrarySource {
	/** Context7 library ID (e.g., "facebook/react") */
	context7?: string;
	/** llms.txt URL (e.g., "https://vuejs.org/llms-full.txt") */
	llmsTxt?: string;
	/** DevDocs doc name (e.g., "react", "vue~3") */
	devdocs?: string;
}

// ============================================================================
// Chunking Types
// ============================================================================

/** A chunk of documentation ready for embedding */
export interface DocChunk {
	/** Unique identifier (hash of content + metadata) */
	id: string;
	/** Chunk content */
	content: string;
	/** Document title */
	title: string;
	/** Section within the documentation */
	section?: string;
	/** Classified document type */
	documentType: DocumentType;
	/** Provider that fetched this */
	provider: DocProviderType;
	/** Library this documentation is for */
	library: string;
	/** Version of the library */
	version?: string;
	/** Source URL */
	sourceUrl?: string;
}

// ============================================================================
// Cache Types
// ============================================================================

/** State of indexed documentation for a library */
export interface IndexedDocState {
	/** Library identifier */
	library: string;
	/** Version indexed */
	version?: string;
	/** Provider used */
	provider: DocProviderType;
	/** Content hash for change detection */
	contentHash: string;
	/** When this was fetched */
	fetchedAt: string;
	/** Chunk IDs stored in vector store */
	chunkIds: string[];
}
