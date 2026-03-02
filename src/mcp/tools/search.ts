/**
 * Search Tool
 *
 * Semantic + BM25 hybrid code search.
 * Auto-indexes changed files incrementally before searching.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createIndexer } from "../../core/indexer.js";
import type { ToolDeps } from "./deps.js";
import { buildFreshness, errorResponse } from "./deps.js";

export function registerSearchTools(server: McpServer, deps: ToolDeps): void {
	const { stateManager, config, logger } = deps;

	server.tool(
		"search",
		"Semantic + BM25 hybrid code search. Auto-indexes changed files before searching.",
		{
			query: z
				.string()
				.min(2)
				.max(500)
				.describe("Natural language or code search query"),
			limit: z
				.number()
				.min(1)
				.max(50)
				.default(10)
				.describe("Maximum number of results (default: 10)"),
			filePattern: z
				.string()
				.optional()
				.describe("Glob pattern to filter results by file path"),
		},
		async ({ query, limit, filePattern }) => {
			const startTime = Date.now();

			try {
				const indexer = createIndexer({
					projectPath: config.workspaceRoot,
				});

				// Incremental auto-index of changed files
				let autoIndexed = 0;
				try {
					const indexResult = await indexer.index(false);
					autoIndexed = indexResult.filesIndexed;
					if (autoIndexed > 0) {
						logger.info(`search: auto-indexed ${autoIndexed} changed files`);
					}
				} catch (indexErr) {
					// Non-fatal: proceed with existing index
					logger.warn("search: auto-index failed, searching existing index", indexErr);
				}

				const results = await indexer.search(query, {
					limit: limit ?? 10,
					useCase: "search",
				});

				await indexer.close();

				// Apply file pattern filter if provided
				const filtered =
					filePattern
						? results.filter((r) => {
								const pat = filePattern.replace(/\*\*/g, ".*").replace(/\*/g, "[^/]*");
								return new RegExp(pat).test(r.chunk.filePath);
							})
						: results;

				const resultItems = filtered.map((r) => ({
					file: r.chunk.filePath,
					line: r.chunk.startLine,
					lineEnd: r.chunk.endLine,
					symbol: r.chunk.name ?? null,
					snippet: r.chunk.content.slice(0, 800),
					score: r.score,
					vectorScore: r.vectorScore,
					keywordScore: r.keywordScore,
				}));

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								results: resultItems,
								totalMatches: resultItems.length,
								autoIndexed,
								...buildFreshness(stateManager, startTime),
							}),
						},
					],
				};
			} catch (err) {
				return errorResponse(err);
			}
		},
	);
}
