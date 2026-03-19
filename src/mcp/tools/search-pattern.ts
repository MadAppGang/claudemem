/**
 * Search Pattern Tool
 *
 * Regex/literal pattern search across the codebase, complementing the
 * semantic `search` tool with precise text matching. Uses ripgrep (rg)
 * when available, falling back to grep.
 *
 * Addresses the issue where agents send 16+ semantic search_code calls
 * rephrasing the same query — NL search against code text is unreliable
 * for exact patterns.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import type { ToolDeps } from "./deps.js";
import { buildFreshness, errorResponse } from "./deps.js";

/** Check if a binary is available on PATH */
function hasCommand(cmd: string): boolean {
	try {
		execFileSync("which", [cmd], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

const HAS_RG = hasCommand("rg");

export function registerSearchPatternTools(
	server: McpServer,
	deps: ToolDeps,
): void {
	const { stateManager, config } = deps;

	server.tool(
		"search_pattern",
		"Search for a regex or literal pattern across the codebase. Returns matching lines with file paths and line numbers. Complements semantic search with precise text matching.",
		{
			pattern: z
				.string()
				.min(1)
				.max(500)
				.describe(
					"Search pattern (regex by default, or literal if fixedString is true)",
				),
			fixedString: z
				.boolean()
				.default(false)
				.describe("Treat pattern as a literal string instead of regex"),
			fileGlob: z
				.string()
				.optional()
				.describe(
					"Glob pattern to filter files (e.g. '*.ts', '**/*.py')",
				),
			caseSensitive: z
				.boolean()
				.default(true)
				.describe("Case-sensitive search (default: true)"),
			limit: z
				.number()
				.int()
				.min(1)
				.max(200)
				.default(50)
				.describe("Maximum number of matching lines to return (default: 50)"),
		},
		async ({ pattern, fixedString, fileGlob, caseSensitive, limit }) => {
			const startTime = Date.now();

			try {
				let stdout: string;

				if (HAS_RG) {
					// Use ripgrep
					const args = [
						"--no-heading",
						"--line-number",
						"--color=never",
						`--max-count=${limit}`,
					];
					if (fixedString) args.push("--fixed-strings");
					if (!caseSensitive) args.push("--ignore-case");
					if (fileGlob) args.push(`--glob=${fileGlob}`);
					args.push("--", pattern, ".");

					try {
						stdout = execFileSync("rg", args, {
							cwd: config.workspaceRoot,
							encoding: "utf-8",
							maxBuffer: 10 * 1024 * 1024,
							timeout: 30_000,
						});
					} catch (err: unknown) {
						// rg exits with code 1 when no matches found
						if (
							err &&
							typeof err === "object" &&
							"status" in err &&
							(err as { status: number }).status === 1
						) {
							stdout = "";
						} else {
							throw err;
						}
					}
				} else {
					// Fallback to grep
					const args = ["-rn", "--color=never"];
					if (fixedString) args.push("-F");
					if (!caseSensitive) args.push("-i");
					if (fileGlob) args.push(`--include=${fileGlob}`);
					args.push("--", pattern, ".");

					try {
						stdout = execFileSync("grep", args, {
							cwd: config.workspaceRoot,
							encoding: "utf-8",
							maxBuffer: 10 * 1024 * 1024,
							timeout: 30_000,
						});
					} catch (err: unknown) {
						// grep exits with code 1 when no matches found
						if (
							err &&
							typeof err === "object" &&
							"status" in err &&
							(err as { status: number }).status === 1
						) {
							stdout = "";
						} else {
							throw err;
						}
					}
				}

				// Parse output into structured results
				const lines = stdout.trim().split("\n").filter(Boolean);
				const matches = lines.slice(0, limit).map((line) => {
					// Format: ./path/to/file:lineNum:content
					const match = line.match(/^\.\/(.+?):(\d+):(.*)$/);
					if (match) {
						return {
							file: match[1],
							line: parseInt(match[2], 10),
							content: match[3],
						};
					}
					// Fallback for unexpected format
					return { file: "", line: 0, content: line };
				});

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								matches,
								totalMatches: matches.length,
								truncated: lines.length > limit,
								engine: HAS_RG ? "ripgrep" : "grep",
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
