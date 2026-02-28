/**
 * AgentOutput: OutputRouter implementation for machine-readable (--agent) mode.
 *
 * Behaviour:
 *   - start() / stop()  : no-ops
 *   - renderProgress()  : silent during updates; writes summary on finish()
 *   - text()            : console.log to stdout
 *   - error()           : console.error to stderr
 *
 * Progress summary is written by calling agentOutput.indexComplete() on finish().
 * Because AgentOutput does not have access to the final IndexResult at
 * renderProgress() time, the ProgressHandle returned here is intentionally
 * minimal — callers that need the full result summary should call
 * agentOutput.indexComplete() directly after awaiting the indexer.
 */

import type { OutputRouter, ProgressHandle } from "./index.js";

// ============================================================================
// TextProgressHandle
// ============================================================================

/**
 * A no-op progress handle for agent/non-TTY mode.
 *
 * Progress updates are suppressed entirely — agent output only emits the
 * final result summary (written by the command handler via agentOutput.*).
 */
class TextProgressHandle implements ProgressHandle {
	update(
		_completed: number,
		_total: number,
		_detail: string,
		_inProgress?: number,
	): void {
		// Silent during indexing in agent mode
	}

	finish(): void {
		// No-op: the command handler writes the final summary via agentOutput.*
	}

	stop(): void {
		// No-op
	}
}

// ============================================================================
// AgentOutput
// ============================================================================

/**
 * OutputRouter for --agent mode and non-TTY fallback.
 *
 * Writes plain key=value lines to stdout/stderr with no ANSI codes.
 */
export class AgentOutput implements OutputRouter {
	async start(): Promise<void> {
		// No renderer to initialise
	}

	async stop(): Promise<void> {
		// No renderer to tear down
	}

	renderProgress(): ProgressHandle {
		return new TextProgressHandle();
	}

	text(line: string): void {
		console.log(line);
	}

	error(line: string): void {
		console.error(line);
	}
}
