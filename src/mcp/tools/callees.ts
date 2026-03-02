/**
 * Callees Tool
 *
 * Traverse the call graph downward from a symbol, showing what it depends on.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "./deps.js";
import { buildFreshness, errorResponse } from "./deps.js";

export function registerCalleesTools(server: McpServer, deps: ToolDeps): void {
	const { cache, stateManager } = deps;

	server.tool(
		"callees",
		"Find all dependencies (callees) of a symbol, traversed downward through the call graph.",
		{
			symbol: z.string().describe("Symbol name to find dependencies of"),
			depth: z
				.number()
				.min(1)
				.max(5)
				.default(1)
				.describe("Traversal depth (default: 1, direct callees only)"),
			excludeExternal: z
				.boolean()
				.default(false)
				.describe("Exclude symbols from external packages (default: false)"),
		},
		async ({ symbol: symbolName, depth, excludeExternal }) => {
			const startTime = Date.now();

			try {
				const { graphManager } = await cache.get();

				const target = graphManager.findSymbol(symbolName, {
					preferExported: true,
				});

				if (!target) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									error: `Symbol "${symbolName}" not found in index.`,
									callees: [],
									...buildFreshness(stateManager, startTime),
								}),
							},
						],
					};
				}

				// BFS traversal downward up to `depth` levels
				const visited = new Set<string>([target.id]);
				const allCallees: Array<{
					symbol: string;
					file: string;
					line: number;
					isExternal: boolean;
					depth: number;
				}> = [];

				let frontier = [target.id];

				for (let d = 1; d <= (depth ?? 1); d++) {
					const nextFrontier: string[] = [];

					for (const id of frontier) {
						const callees = graphManager.getCallees(id);
						for (const callee of callees) {
							if (!visited.has(callee.id)) {
								visited.add(callee.id);
								nextFrontier.push(callee.id);

								// Heuristic: symbols from node_modules or without filePath are external
								const isExternal =
									callee.filePath.includes("node_modules") ||
									callee.filePath.startsWith("external:");

								if (excludeExternal && isExternal) {
									continue;
								}

								allCallees.push({
									symbol: callee.name,
									file: callee.filePath,
									line: callee.startLine,
									isExternal,
									depth: d,
								});
							}
						}
					}

					frontier = nextFrontier;
					if (frontier.length === 0) break;
				}

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								callees: allCallees,
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
