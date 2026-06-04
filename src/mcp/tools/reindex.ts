/**
 * Reindex Tool
 *
 * Triggers a background or blocking reindex of the workspace.
 * Does NOT include freshness metadata in its response (it changes the index state).
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { buildIndexState } from "../index-state.js";
import type { ToolDeps } from "./deps.js";
import { errorResponse } from "./deps.js";

/**
 * Cap blocking reindex waits BELOW the MCP client tool timeout (~60s) so we can
 * return structured diagnostics before the client aborts. waitForCompletion's
 * own default is 300s — far too long for a blocking tool call.
 */
const REINDEX_BLOCKING_TIMEOUT_MS = 45000;

export function registerReindexTools(server: McpServer, deps: ToolDeps): void {
	const { reindexer, completionDetector, logger } = deps;

	server.tool(
		"reindex",
		"Trigger a reindex of the workspace. Can be debounced (default) or forced immediately. Optionally block until complete.",
		{
			force: z
				.boolean()
				.default(false)
				.describe("Skip debounce and reindex immediately (default: false)"),
			blocking: z
				.boolean()
				.default(false)
				.describe(
					"Wait until reindex completes before returning (default: false)",
				),
		},
		async ({ force, blocking }) => {
			const startTime = Date.now();

			try {
				if (!reindexer) {
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									status: "failed",
									message:
										"Reindexer not configured. The MCP server may not have been started with --watch mode.",
								}),
							},
						],
					};
				}

				// Check if already running (in-memory flag OR disk lock from any process)
				if (reindexer.isRunning()) {
					if (blocking && completionDetector) {
						logger.info("reindex: lock held, waiting for completion");
						const completed = await completionDetector.waitForCompletion(
							REINDEX_BLOCKING_TIMEOUT_MS,
						);
						if (completed) {
							return {
								content: [
									{
										type: "text" as const,
										text: JSON.stringify({
											status: "completed",
											durationMs: Date.now() - startTime,
											message: "Reindex completed (was already in progress)",
										}),
									},
								],
							};
						}
						// Timed out: return structured diagnostics instead of a bare
						// "timed out" string. status stays distinguishable ("timeout",
						// NOT spread from indexState.status — A7).
						const st = await buildIndexState(deps, startTime);
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										status: "timeout",
										durationMs: Date.now() - startTime,
										message: `Reindex still running after ${
											REINDEX_BLOCKING_TIMEOUT_MS / 1000
										}s; returning diagnostics.`,
										indexing: st.indexing,
										index: st.index,
										canReturnCachedResults: st.canReturnCachedResults,
										recommendations: st.recommendations,
									}),
								},
							],
						};
					}

					// Enrich already_running with the structured indexing/index/recommendations
					// block. Keep the "already_running" discriminator (do NOT spread ...st
					// whole, which would clobber status with st.status — A7).
					const st = await buildIndexState(deps, startTime);
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									status: "already_running",
									message: st.message,
									indexing: st.indexing,
									index: st.index,
									canReturnCachedResults: st.canReturnCachedResults,
									recommendations: st.recommendations,
								}),
							},
						],
					};
				}

				if (force) {
					await reindexer.forceReindex();
				} else {
					reindexer.scheduleReindex();
				}

				if (blocking && completionDetector) {
					logger.info("reindex: waiting for completion");
					const completed = await completionDetector.waitForCompletion(
						REINDEX_BLOCKING_TIMEOUT_MS,
					);
					if (completed) {
						return {
							content: [
								{
									type: "text" as const,
									text: JSON.stringify({
										status: "completed",
										durationMs: Date.now() - startTime,
										message: "Reindex completed successfully",
									}),
								},
							],
						};
					}
					// Timed out: structured diagnostics, distinguishable "timeout" status (A7).
					const st = await buildIndexState(deps, startTime);
					return {
						content: [
							{
								type: "text" as const,
								text: JSON.stringify({
									status: "timeout",
									durationMs: Date.now() - startTime,
									message: `Reindex still running after ${
										REINDEX_BLOCKING_TIMEOUT_MS / 1000
									}s; returning diagnostics.`,
									indexing: st.indexing,
									index: st.index,
									canReturnCachedResults: st.canReturnCachedResults,
									recommendations: st.recommendations,
								}),
							},
						],
					};
				}

				return {
					content: [
						{
							type: "text" as const,
							text: JSON.stringify({
								status: "started",
								message: force
									? "Reindex started immediately."
									: "Reindex scheduled (debounced).",
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
