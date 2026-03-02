/**
 * Symbol Tool
 *
 * Find symbol definitions and usages using the AST reference graph.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "./deps.js";
import { buildFreshness, errorResponse } from "./deps.js";

export function registerSymbolTools(server: McpServer, deps: ToolDeps): void {
	const { cache, stateManager } = deps;

	server.tool(
		"symbol",
		"Find a symbol definition and its usages (callers) using the AST reference graph.",
		{
			symbol: z.string().describe("Symbol name to look up"),
			kind: z
				.enum(["function", "class", "interface", "type", "variable", "any"])
				.default("any")
				.describe("Symbol kind filter (default: any)"),
			includeUsages: z
				.boolean()
				.default(true)
				.describe("Include caller/usage locations (default: true)"),
		},
		async ({ symbol: symbolName, kind, includeUsages }) => {
			const startTime = Date.now();

			try {
				const { graphManager } = await cache.get();

				const found = graphManager.findSymbol(symbolName, {
					preferExported: true,
				});

				// Filter by kind if specified
				const definition =
					found && (kind === "any" || found.kind === kind) ? found : null;

				let usages: Array<{
					file: string;
					line: number;
					context: string;
					enclosingSymbol: string | null;
				}> = [];

				if (definition && includeUsages) {
					const callers = graphManager.getCallers(definition.id);
					usages = callers.map((c) => ({
						file: c.filePath,
						line: c.startLine,
						context: c.signature ?? c.name,
						enclosingSymbol: c.parentId ? c.name : null,
					}));
				}

				const definitionPayload = definition
					? {
							file: definition.filePath,
							line: definition.startLine,
							kind: definition.kind,
							name: definition.name,
							signature: definition.signature ?? null,
							isExported: definition.isExported,
							pageRank: definition.pagerankScore,
						}
					: null;

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								definition: definitionPayload,
								usages,
								usageCount: usages.length,
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
