#!/usr/bin/env node

/**
 * claudemem MCP Server
 *
 * Exposes code indexing and search as MCP tools for Claude Code.
 * Run with: claudemem --mcp (stdio transport)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createIndexer } from "./core/indexer.js";
import { discoverEmbeddingModels, formatModelInfo } from "./models/model-discovery.js";

// ============================================================================
// MCP Server Setup
// ============================================================================

async function main() {
	const server = new McpServer({
		name: "claudemem",
		version: "0.1.0",
	});

	// ========================================================================
	// Tool: index_codebase
	// ========================================================================
	server.tool(
		"index_codebase",
		"Index a codebase for semantic code search. Creates vector embeddings of code chunks and optionally generates LLM-powered enrichments (summaries, idioms, examples).",
		{
			path: z
				.string()
				.optional()
				.describe("Project root path to index (default: current directory)"),
			force: z
				.boolean()
				.optional()
				.describe("Force re-index all files, ignoring cached state"),
			model: z
				.string()
				.optional()
				.describe("Embedding model to use (default: qwen/qwen3-embedding-8b)"),
			enableEnrichment: z
				.boolean()
				.optional()
				.describe("Enable LLM enrichment to generate summaries, idioms, and examples (default: true)"),
		},
		async ({ path, force, model, enableEnrichment }) => {
			try {
				const projectPath = path || process.cwd();

				const indexer = createIndexer({
					projectPath,
					model,
					enableEnrichment: enableEnrichment !== false,
				});

				const result = await indexer.index(force || false);
				await indexer.close();

				let response = `## Indexing Complete\n\n`;
				response += `- **Files indexed**: ${result.filesIndexed}\n`;
				response += `- **Chunks created**: ${result.chunksCreated}\n`;
				response += `- **Duration**: ${(result.durationMs / 1000).toFixed(2)}s\n`;

				// Show enrichment stats if available
				if ("enrichment" in result && result.enrichment) {
					const enrichment = result.enrichment;
					const totalDocs = enrichment.documentsCreated + enrichment.documentsUpdated;
					response += `- **Enriched documents**: ${totalDocs}`;
					if (enrichment.documentsUpdated > 0) {
						response += ` (${enrichment.documentsCreated} new, ${enrichment.documentsUpdated} updated)`;
					}
					response += `\n`;
				}

				if (result.errors.length > 0) {
					response += `\n### Errors (${result.errors.length})\n`;
					for (const err of result.errors.slice(0, 5)) {
						response += `- \`${err.file}\`: ${err.error}\n`;
					}
					if (result.errors.length > 5) {
						response += `- ... and ${result.errors.length - 5} more\n`;
					}
				}

				return { content: [{ type: "text", text: response }] };
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				};
			}
		},
	);

	// ========================================================================
	// Tool: search_code
	// ========================================================================
	server.tool(
		"search_code",
		"Search indexed code using natural language. Automatically indexes new/modified files before searching. Supports different use cases with optimized result weighting.",
		{
			query: z.string().describe("Natural language search query"),
			limit: z
				.number()
				.optional()
				.describe("Maximum results to return (default: 10)"),
			language: z
				.string()
				.optional()
				.describe("Filter by programming language"),
			path: z
				.string()
				.optional()
				.describe("Project path (default: current directory)"),
			autoIndex: z
				.boolean()
				.optional()
				.describe("Auto-index changed files before search (default: true)"),
			useCase: z
				.enum(["fim", "search", "navigation"])
				.optional()
				.describe("Search preset: 'fim' for code completion, 'search' for general queries (default), 'navigation' for codebase exploration"),
		},
		async ({ query, limit, language, path, autoIndex, useCase }) => {
			try {
				const projectPath = path || process.cwd();
				const indexer = createIndexer({ projectPath });

				// Auto-index changed files before search (default: true)
				let autoIndexed = 0;
				if (autoIndex !== false) {
					const indexResult = await indexer.index(false); // incremental
					autoIndexed = indexResult.filesIndexed;
					if (autoIndexed > 0) {
						console.error(`[claudemem] Auto-indexed ${autoIndexed} changed files`);
					}
				}

				const results = await indexer.search(query, {
					limit: limit || 10,
					language,
					useCase: useCase || "search",
				});

				await indexer.close();

				if (results.length === 0) {
					return {
						content: [
							{
								type: "text",
								text: `No results found for "${query}". Make sure the codebase is indexed using \`index_codebase\`.`,
							},
						],
					};
				}

				let response = `## Search Results for "${query}"\n\n`;
				if (autoIndexed > 0) {
					response += `*Auto-indexed ${autoIndexed} changed file(s) before search*\n\n`;
				}
				response += `Found ${results.length} result(s):\n\n`;

				for (let i = 0; i < results.length; i++) {
					const r = results[i];
					const chunk = r.chunk;

					response += `### ${i + 1}. \`${chunk.filePath}\`:${chunk.startLine}-${chunk.endLine}\n`;
					response += `**${chunk.chunkType}**`;
					if (chunk.name) {
						response += `: \`${chunk.name}\``;
					}
					if (chunk.parentName) {
						response += ` (in \`${chunk.parentName}\`)`;
					}
					response += `\n`;
					response += `Score: ${(r.score * 100).toFixed(1)}% (vector: ${(r.vectorScore * 100).toFixed(0)}%, keyword: ${(r.keywordScore * 100).toFixed(0)}%)\n\n`;
					response += "```" + chunk.language + "\n";
					response += chunk.content.slice(0, 1000);
					if (chunk.content.length > 1000) {
						response += "\n// ... truncated";
					}
					response += "\n```\n\n";
				}

				return { content: [{ type: "text", text: response }] };
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				};
			}
		},
	);

	// ========================================================================
	// Tool: clear_index
	// ========================================================================
	server.tool(
		"clear_index",
		"Clear the code index for a project. Removes all indexed chunks and file state.",
		{
			path: z
				.string()
				.optional()
				.describe("Project path (default: current directory)"),
		},
		async ({ path }) => {
			try {
				const projectPath = path || process.cwd();

				const indexer = createIndexer({ projectPath });
				await indexer.clear();
				await indexer.close();

				return {
					content: [
						{
							type: "text",
							text: `Index cleared for ${projectPath}`,
						},
					],
				};
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				};
			}
		},
	);

	// ========================================================================
	// Tool: get_status
	// ========================================================================
	server.tool(
		"get_status",
		"Get the status of the code index for a project.",
		{
			path: z
				.string()
				.optional()
				.describe("Project path (default: current directory)"),
		},
		async ({ path }) => {
			try {
				const projectPath = path || process.cwd();

				const indexer = createIndexer({ projectPath });
				const status = await indexer.getStatus();
				await indexer.close();

				if (!status.exists) {
					return {
						content: [
							{
								type: "text",
								text: `No index found for ${projectPath}. Run \`index_codebase\` to create one.`,
							},
						],
					};
				}

				let response = `## Index Status\n\n`;
				response += `- **Path**: ${projectPath}\n`;
				response += `- **Files**: ${status.totalFiles}\n`;
				response += `- **Chunks**: ${status.totalChunks}\n`;
				response += `- **Languages**: ${status.languages.join(", ") || "none"}\n`;
				if (status.embeddingModel) {
					response += `- **Embedding model**: ${status.embeddingModel}\n`;
				}
				if (status.lastUpdated) {
					response += `- **Last updated**: ${status.lastUpdated.toISOString()}\n`;
				}

				return { content: [{ type: "text", text: response }] };
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				};
			}
		},
	);

	// ========================================================================
	// Tool: list_embedding_models
	// ========================================================================
	server.tool(
		"list_embedding_models",
		"List available embedding models from OpenRouter for code indexing.",
		{
			freeOnly: z
				.boolean()
				.optional()
				.describe("Show only free models"),
		},
		async ({ freeOnly }) => {
			try {
				const models = await discoverEmbeddingModels();
				const filtered = freeOnly ? models.filter((m) => m.isFree) : models;

				let response = `## Available Embedding Models\n\n`;
				response += `| Model | Provider | Price | Context |\n`;
				response += `|-------|----------|-------|----------|\n`;

				for (const model of filtered.slice(0, 15)) {
					const price = model.isFree
						? "FREE"
						: `$${model.pricePerMillion.toFixed(3)}/1M`;
					const context = `${Math.round(model.contextLength / 1000)}K`;
					response += `| ${model.id} | ${model.provider} | ${price} | ${context} |\n`;
				}

				if (filtered.length > 15) {
					response += `\n*... and ${filtered.length - 15} more models*\n`;
				}

				response += `\n**Recommended for code**: \`qwen/qwen3-embedding-8b\` (best quality/price ratio for code)\n`;

				return { content: [{ type: "text", text: response }] };
			} catch (error) {
				return {
					content: [
						{
							type: "text",
							text: `Error: ${error instanceof Error ? error.message : String(error)}`,
						},
					],
					isError: true,
				};
			}
		},
	);

	// ========================================================================
	// Start Server
	// ========================================================================
	const transport = new StdioServerTransport();
	await server.connect(transport);

	console.error("[claudemem] MCP server started");
}

// ============================================================================
// Entry Point
// ============================================================================

export function startMcpServer() {
	main().catch((error) => {
		console.error("[claudemem] MCP fatal error:", error);
		process.exit(1);
	});
}
