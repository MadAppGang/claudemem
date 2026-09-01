/**
 * Learned File Boosts
 *
 * Single implementation of learned per-file score boosting, shared by the
 * pipeline orchestrator (`search` tool) and the legacy `search_code` tool so
 * the two retrieval paths rank identically.
 *
 * Dependency-free by design: the learning system is injected as a plain
 * `Map<file, multiplier>` so the pipeline core never imports src/learning.
 */

/**
 * Supplies learned per-file boost multipliers, or null when learning is
 * unavailable/inactive (the default — learning is opt-in).
 */
export type FileBoostProvider = () => Map<string, number> | null;

/**
 * Apply learned file boosts multiplicatively and re-sort descending by score.
 *
 * Files absent from the boost map default to a 1.0 multiplier (no change).
 * A null/empty map is a no-op: the input array is returned untouched.
 * Non-finite scores (e.g. `Infinity` for definitive LSP matches) are left
 * exactly as-is so a boost can never demote a definitive result.
 *
 * @param items    Results to boost (not mutated)
 * @param boosts   Learned multipliers keyed by file path
 * @param getFile  Reads the file path from an item
 * @param getScore Reads the score to boost from an item
 * @param withScore Returns a copy of the item carrying the new score
 */
export function applyFileBoosts<T>(
	items: T[],
	boosts: Map<string, number> | null | undefined,
	getFile: (item: T) => string,
	getScore: (item: T) => number,
	withScore: (item: T, score: number) => T,
): T[] {
	if (!boosts || boosts.size === 0) return items;

	const boosted = items.map((item) => {
		const score = getScore(item);
		// Leave Infinity (isDefinitive) and other non-finite scores untouched
		if (!Number.isFinite(score)) return item;
		const multiplier = boosts.get(getFile(item)) ?? 1.0;
		if (multiplier === 1.0) return item;
		return withScore(item, score * multiplier);
	});

	// Equality check first: Infinity - Infinity is NaN, which makes the
	// comparator inconsistent and the sort order implementation-defined.
	boosted.sort((a, b) => {
		const scoreA = getScore(a);
		const scoreB = getScore(b);
		if (scoreA === scoreB) return 0;
		return scoreB - scoreA;
	});
	return boosted;
}
