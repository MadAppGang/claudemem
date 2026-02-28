/**
 * Output Router
 *
 * Central abstraction for all CLI output. Creates either:
 *   - AgentOutput  (plain key=value text, for --agent mode and non-TTY)
 *   - TuiOutput    (ANSI progress rendering, for interactive TTY)
 *
 * Command handlers use OutputRouter instead of inline `if (agentMode)` branches:
 *
 *   const output = createOutput(agentMode)
 *   await output.start()
 *   const progress = output.renderProgress()
 *   // ... indexer runs, calls progress.update(...)
 *   progress.finish()
 *   await output.stop()
 */

import { AgentOutput } from "./agent-output.js";
import { TuiOutput } from "./tui-output.js";

// ============================================================================
// Interfaces
// ============================================================================

/**
 * Handle returned by renderProgress(). Wraps the indexer callback API.
 */
export interface ProgressHandle {
	/**
	 * Called by the indexer on each progress event.
	 *
	 * @param completed  - Items completed so far
	 * @param total      - Total items to process
	 * @param detail     - Detail string (may include "[phase]" prefix)
	 * @param inProgress - Items currently in-flight
	 */
	update(
		completed: number,
		total: number,
		detail: string,
		inProgress?: number,
	): void;

	/** Called when indexing completes successfully. */
	finish(): void;

	/** Called to stop rendering without marking complete (e.g. on error). */
	stop(): void;
}

/**
 * Output router interface. One instance per command invocation.
 *
 * Lifecycle:
 *   1. createOutput(agentMode) → OutputRouter
 *   2. await output.start()   → initialise renderer (no-op for agent mode)
 *   3. ... use output ...
 *   4. await output.stop()    → tear down renderer (no-op for agent mode)
 */
export interface OutputRouter {
	/** Initialise the renderer. Must be called before any other method. */
	start(): Promise<void>;

	/** Tear down the renderer. Call when the command is done. */
	stop(): Promise<void>;

	/**
	 * Return a ProgressHandle for the current indexing operation.
	 * In TUI mode this starts rendering an animated progress bar.
	 * In agent mode this is silent during updates; agent summary is written on finish().
	 */
	renderProgress(): ProgressHandle;

	/** Write a plain text line to stdout. No-op in TUI mode. */
	text(line: string): void;

	/** Write an error line to stderr. */
	error(line: string): void;
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create the appropriate OutputRouter for the current environment.
 *
 * Selection logic:
 *   - agentMode=true  → AgentOutput (structured key=value, no TTY required)
 *   - TTY available   → TuiOutput (ANSI animated progress)
 *   - non-TTY         → AgentOutput (plain text fallback)
 */
export function createOutput(agentMode: boolean): OutputRouter {
	if (agentMode || !process.stdout.isTTY) {
		return new AgentOutput();
	}
	return new TuiOutput();
}

// Re-export concrete classes for consumers that need them explicitly
export { AgentOutput } from "./agent-output.js";
export { TuiOutput } from "./tui-output.js";
export { ProgressStore } from "./progress-store.js";
export type { PhaseState, ProgressSnapshot } from "./progress-store.js";
