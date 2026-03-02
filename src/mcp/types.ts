/**
 * Shared types for the MCP server.
 *
 * FreshnessMetadata describes the current index state relative to the workspace.
 */

export interface FreshnessMetadata {
	/** "fresh" if no files changed since last index, "stale" otherwise */
	freshness: "fresh" | "stale";
	/** ISO timestamp of last successful index completion, or null if never indexed */
	lastIndexed: string | null;
	/** ISO timestamp of first file change after last index (when staleness began), or null */
	staleSince: string | null;
	/** Relative paths of files changed since last index */
	filesChanged: string[];
	/** True if a background reindex is currently in progress */
	reindexingInProgress: boolean;
	/** How long this response took to produce (caller fills this in) */
	responseTimeMs: number;
}
