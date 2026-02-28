/**
 * ScoreBar Component
 *
 * Renders a colored bar like: ████████░░░░ 85%
 * Color depends on score: green for high, yellow for mid, red for low.
 */

import { theme, scoreBarChars, getScoreColor } from "../theme.js";

// ============================================================================
// Props
// ============================================================================

export interface ScoreBarProps {
	/** Score from 0 to 1 */
	score: number;
	/** Width in characters (default: 10) */
	width?: number;
	/** Optional label shown after the bar */
	label?: string;
	/** Show percentage (default: true) */
	showPercent?: boolean;
}

// ============================================================================
// Component
// ============================================================================

export function ScoreBar({
	score,
	width = 10,
	label,
	showPercent = true,
}: ScoreBarProps) {
	const clampedScore = Math.max(0, Math.min(1, score));
	const filledCount = Math.round(clampedScore * width);
	const emptyCount = width - filledCount;

	const bar =
		scoreBarChars.filled.repeat(filledCount) +
		scoreBarChars.empty.repeat(emptyCount);
	const percent = Math.round(clampedScore * 100);
	const color = getScoreColor(clampedScore);

	return (
		<box flexDirection="row">
			<text fg={color}>{bar}</text>
			{showPercent && (
				<text fg={theme.muted}> {percent.toString().padStart(3)}%</text>
			)}
			{label && <text fg={theme.text}> {label}</text>}
		</box>
	);
}
