/**
 * MetricHints
 *
 * Renders a block of dim metric hint lines with bullet points.
 *
 * Example output:
 *   Quality metrics (used for ranking):
 *     • Retr. (45%):  Can agents FIND the right code?
 *     • Contr. (30%): Can agents DISTINGUISH similar code?
 */

import { theme } from "../../theme.js";

// ============================================================================
// Props
// ============================================================================

export interface MetricHint {
	label: string;
	description: string;
}

export interface MetricHintsProps {
	/** Array of hint items to display as bullet points */
	hints: MetricHint[];
	/** Optional title line shown before the bullets */
	title?: string;
}

// ============================================================================
// Component
// ============================================================================

export function MetricHints({ hints, title }: MetricHintsProps) {
	return (
		<box flexDirection="column">
			{title && (
				<box height={1}>
					<text fg={theme.muted}>{title}</text>
				</box>
			)}
			{hints.map((hint, i) => (
				<box key={i} height={1}>
					<text fg={theme.muted}>
						{"  "}
						{"• "}
						<strong>{hint.label}</strong>
						{"  "}
						{hint.description}
					</text>
				</box>
			))}
		</box>
	);
}
