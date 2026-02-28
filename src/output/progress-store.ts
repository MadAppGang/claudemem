/**
 * ProgressStore: bridges imperative indexer callbacks to React state.
 *
 * The indexer calls onProgress at a high rate. Rather than updating React state
 * on every callback (causing excessive re-renders), the store accumulates updates
 * as mutable state. React components poll via getSnapshot() at 100ms intervals.
 *
 * Phase parsing logic extracted from createProgressRenderer() in cli.ts.
 */

// ============================================================================
// Types
// ============================================================================

export interface PhaseState {
	name: string;
	completed: number;
	total: number;
	inProgress: number;
	detail: string;
	isComplete: boolean;
	startTime: number;
	/** Frozen elapsed time (ms) captured when phase completes */
	finalDuration?: number;
}

export interface ProgressSnapshot {
	phases: PhaseState[];
	phaseOrder: string[];
	finished: boolean;
	globalStartTime: number;
}

// ============================================================================
// ProgressStore
// ============================================================================

/**
 * Mutable store for indexing progress state.
 *
 * Phase names are parsed from the detail string using the bracket convention:
 *   "[parsing] src/foo.ts"  → phase "parsing", detail "src/foo.ts"
 *   "[embedding] batch 1/4" → phase "embedding", detail "batch 1/4"
 *   "some detail"           → phase "processing", detail "some detail"
 *
 * A phase is marked complete when:
 *   completed >= total && total > 0 && inProgress === 0
 *
 * Once complete, elapsed time is frozen in finalDuration so React can display
 * the stable duration even after subsequent renders.
 */
export class ProgressStore {
	private phases = new Map<string, PhaseState>();
	private phaseOrder: string[] = [];
	private finished = false;
	private globalStartTime = Date.now();

	/**
	 * Update progress state from an indexer callback.
	 *
	 * @param completed - Items completed so far
	 * @param total     - Total items to process
	 * @param detail    - Detail string, optionally prefixed with "[phase-name]"
	 * @param inProgress - Items currently in-flight (for animation)
	 */
	update(
		completed: number,
		total: number,
		detail: string,
		inProgress = 0,
	): void {
		// Parse phase name from detail: "[phase name] rest of detail"
		const phaseMatch = detail.match(/^\[([^\]]+)\]/);
		const phaseName = phaseMatch ? phaseMatch[1] : "processing";
		const cleanDetail = detail.replace(/^\[[^\]]+\]\s*/, "");

		// Create phase on first appearance
		if (!this.phases.has(phaseName)) {
			this.phases.set(phaseName, {
				name: phaseName,
				completed: 0,
				total: 0,
				inProgress: 0,
				detail: "",
				startTime: Date.now(),
				isComplete: false,
			});
			this.phaseOrder.push(phaseName);
		}

		const phase = this.phases.get(phaseName)!;

		// Only update if not already complete (never regress a completed phase)
		if (!phase.isComplete) {
			phase.completed = completed;
			phase.total = total;
			phase.inProgress = inProgress;
			phase.detail = cleanDetail;

			// Mark complete when 100% and no in-progress items remain
			if (completed >= total && total > 0 && inProgress === 0) {
				phase.isComplete = true;
				// Freeze elapsed time so React can display it after completion
				phase.finalDuration = Date.now() - phase.startTime;
			}
		}
	}

	/**
	 * Mark indexing as finished. Forces all phases to complete state.
	 * Called after the indexer resolves.
	 */
	finish(): void {
		for (const phase of this.phases.values()) {
			if (!phase.isComplete) {
				phase.finalDuration = Date.now() - phase.startTime;
			}
			phase.isComplete = true;
			phase.completed = phase.total;
			phase.inProgress = 0;
		}
		this.finished = true;
	}

	/**
	 * Returns an immutable snapshot of current state.
	 * React components call this to read state without subscribing to the store.
	 *
	 * Returns new array/object references on each call so React's shallow
	 * comparison detects changes during setInterval polling.
	 */
	getSnapshot(): ProgressSnapshot {
		return {
			// Spread each PhaseState to create new object references
			phases: this.phaseOrder.map((name) => ({ ...this.phases.get(name)! })),
			phaseOrder: [...this.phaseOrder],
			finished: this.finished,
			globalStartTime: this.globalStartTime,
		};
	}

	/** Read the global start time (ms since epoch). */
	getGlobalStartTime(): number {
		return this.globalStartTime;
	}
}
