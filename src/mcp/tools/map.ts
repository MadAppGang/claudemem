/**
 * Map Tool
 *
 * Generates an architectural overview (repo map) of the codebase,
 * using PageRank to prioritize the most important files and symbols.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { ToolDeps } from "./deps.js";
import { buildFreshness, errorResponse } from "./deps.js";

export function registerMapTools(server: McpServer, deps: ToolDeps): void {
	const { cache, stateManager } = deps;

	server.tool(
		"map",
		"Generate an architectural overview of the codebase, with symbols ranked by PageRank importance.",
		{
			root: z
				.string()
				.default(".")
				.describe(
					"Root directory to map, relative to workspace (default: '.')",
				),
			depth: z
				.number()
				.min(1)
				.max(8)
				.default(3)
				.describe("Approximate token budget in thousands (default: 3 = 3000 tokens)"),
			includeSymbols: z
				.boolean()
				.default(true)
				.describe("Include symbol signatures in the map (default: true)"),
		},
		async ({ root, depth, includeSymbols }) => {
			const startTime = Date.now();

			try {
				const { repoMapGen } = await cache.get();

				// depth is repurposed as token budget in thousands
				const maxTokens = (depth ?? 3) * 1000;

				const pathPattern =
					root && root !== "." ? root : undefined;

				const mapText = repoMapGen.generate({
					maxTokens,
					includeSignatures: includeSymbols ?? true,
					pathPattern,
				});

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								mapText,
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
