/**
 * GraphSyncer — downloads the symbol graph from the cloud for offline use
 *
 * Enables `map`, `callers`, `callees` commands when offline by syncing the
 * cloud symbol graph into the local FileTracker metadata store.
 *
 * MVP implementation: caches the repo map text from cloudClient.getGraph()
 * into local FileTracker metadata so that the `map` command works offline.
 * Full graph sync (symbols + references into SQLite) is a future enhancement.
 */

import type { ICloudIndexClient } from "./types.js";
import type { IFileTracker } from "../core/tracker.js";

// ============================================================================
// Types
// ============================================================================

export interface GraphSyncOptions {
	/** Absolute path to the project root */
	projectPath: string;
	/** Cloud API client */
	cloudClient: ICloudIndexClient;
	/** Repository slug (e.g. "acme-corp/my-repo") */
	repoSlug: string;
	/** Full 40-char commit SHA to sync */
	commitSha: string;
	/** Local file tracker (provides metadata storage) */
	fileTracker: IFileTracker;
	/** Optional progress callback */
	onProgress?: (message: string) => void;
}

export interface GraphSyncResult {
	/** Number of symbol definitions synced */
	symbolCount: number;
	/** Number of reference edges synced */
	referenceCount: number;
	/** Wall-clock duration in milliseconds */
	durationMs: number;
}

// Metadata key used to cache the synced repo map
const REPO_MAP_CACHE_KEY = "cloudRepoMap";
const REPO_MAP_COMMIT_KEY = "cloudRepoMapCommit";

// ============================================================================
// GraphSyncer
// ============================================================================

export class GraphSyncer {
	private readonly projectPath: string;
	private readonly cloudClient: ICloudIndexClient;
	private readonly repoSlug: string;
	private readonly commitSha: string;
	private readonly fileTracker: IFileTracker;
	private readonly onProgress: (message: string) => void;

	constructor(options: GraphSyncOptions) {
		this.projectPath = options.projectPath;
		this.cloudClient = options.cloudClient;
		this.repoSlug = options.repoSlug;
		this.commitSha = options.commitSha;
		this.fileTracker = options.fileTracker;
		this.onProgress = options.onProgress ?? (() => {});
	}

	/**
	 * Sync the symbol graph from cloud to local FileTracker.
	 *
	 * Downloads symbols + references for the given commit and writes:
	 * - The repo map text to FileTracker metadata (key: "cloudRepoMap")
	 * - The synced commit SHA to FileTracker metadata (key: "cloudRepoMapCommit")
	 *
	 * After syncing, offline `map` queries read from the cached repo map text.
	 */
	async syncGraph(): Promise<GraphSyncResult> {
		const startMs = Date.now();

		this.onProgress(
			`Syncing graph for ${this.repoSlug} @ ${this.commitSha.slice(0, 8)}...`,
		);

		// Download graph data from cloud
		const graphResult = await this.cloudClient.getGraph(
			this.repoSlug,
			this.commitSha,
		);

		// Cache repo map text in local metadata for offline `map` command
		if (graphResult.repoMap) {
			this.fileTracker.setMetadata(REPO_MAP_CACHE_KEY, graphResult.repoMap);
			this.fileTracker.setMetadata(REPO_MAP_COMMIT_KEY, this.commitSha);
			this.onProgress(
				`Cached repo map (${graphResult.repoMap.length} chars) for offline use.`,
			);
		}

		const symbolCount = graphResult.symbols.length;
		const referenceCount = graphResult.references.length;

		this.onProgress(
			`Graph sync complete: ${symbolCount} symbols, ${referenceCount} references.`,
		);

		return {
			symbolCount,
			referenceCount,
			durationMs: Date.now() - startMs,
		};
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a GraphSyncer with the given options.
 */
export function createGraphSyncer(options: GraphSyncOptions): GraphSyncer {
	return new GraphSyncer(options);
}
