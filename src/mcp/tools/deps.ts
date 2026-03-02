/**
 * Tool Dependencies
 *
 * Common dependency injection interface passed to all tool registration
 * functions, reducing boilerplate and centralizing infrastructure access.
 */

import type { IndexCache } from "../cache.js";
import type { IndexStateManager } from "../state-manager.js";
import type { McpConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { DebounceReindexer } from "../reindexer.js";
import type { CompletionDetector } from "../completion-detector.js";
import type { FreshnessMetadata } from "../types.js";

export interface ToolDeps {
	cache: IndexCache;
	stateManager: IndexStateManager;
	config: McpConfig;
	logger: Logger;
	reindexer?: DebounceReindexer;
	completionDetector?: CompletionDetector;
	serverStartTime: number;
	watcherActive: boolean;
}

/**
 * Build freshness metadata with the elapsed response time filled in.
 */
export function buildFreshness(
	stateManager: IndexStateManager,
	startTime: number,
): FreshnessMetadata {
	return {
		...stateManager.getFreshness(),
		responseTimeMs: Date.now() - startTime,
	};
}

/**
 * Format an error for MCP tool response.
 */
export function errorResponse(err: unknown): {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
} {
	const message = err instanceof Error ? err.message : String(err);
	return {
		content: [{ type: "text", text: `Error: ${message}` }],
		isError: true,
	};
}
