/**
 * Read File Tool
 *
 * Read file contents with optional line range. Uses workspace-relative
 * path resolution so agents don't need to know the absolute project path.
 *
 * Closes the gap where agents fall back to native Read() because the
 * context() tool returns a fixed symbol-scoped window.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";
import type { ToolDeps } from "./deps.js";
import { buildFreshness, errorResponse } from "./deps.js";

export function registerReadFileTools(
	server: McpServer,
	deps: ToolDeps,
): void {
	const { stateManager, config } = deps;

	server.tool(
		"read_file",
		"Read file contents with optional line range. Paths are relative to the workspace root.",
		{
			path: z
				.string()
				.describe("File path relative to workspace root"),
			startLine: z
				.number()
				.int()
				.min(1)
				.optional()
				.describe("First line to read (1-based, inclusive)"),
			endLine: z
				.number()
				.int()
				.min(1)
				.optional()
				.describe("Last line to read (1-based, inclusive)"),
		},
		async ({ path, startLine, endLine }) => {
			const startTime = Date.now();

			try {
				const absPath = resolve(config.workspaceRoot, path);

				// Security: prevent path traversal outside workspace
				if (!absPath.startsWith(config.workspaceRoot)) {
					return {
						content: [
							{
								type: "text" as const,
								text: "Error: path traversal outside workspace root is not allowed",
							},
						],
						isError: true,
					};
				}

				const content = readFileSync(absPath, "utf-8");
				const allLines = content.split("\n");
				const totalLines = allLines.length;

				// Apply line range if specified
				const start = startLine ? Math.max(1, startLine) : 1;
				const end = endLine
					? Math.min(totalLines, endLine)
					: totalLines;
				const selectedLines = allLines.slice(start - 1, end);

				// Format with line numbers
				const numbered = selectedLines
					.map((line, i) => `${start + i}\t${line}`)
					.join("\n");

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								path,
								totalLines,
								startLine: start,
								endLine: end,
								content: numbered,
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
