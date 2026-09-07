/**
 * StatusMessage
 *
 * Renders a single-line status notification with an icon and colored text.
 * Used as a footer row inside CommandOutputApp for success/error/info/warning
 * messages at the end of a command's output.
 *
 * Examples:
 *   ✓ Indexed 42 files in 3.2s
 *   ✗ Failed to connect to embedding API
 *   ℹ No index found — run: mnemex index
 *   ⚠ Index is outdated, re-run: mnemex index --force
 */

import { type ThemePalette, theme } from "../../theme.js";

// ============================================================================
// Types
// ============================================================================

export type StatusType = "success" | "error" | "info" | "warning";

// ============================================================================
// Props
// ============================================================================

export interface StatusMessageProps {
	/** Visual severity level — controls icon and text color */
	type: StatusType;
	/** The message to display */
	message: string;
}

// ============================================================================
// Helpers
// ============================================================================

/** Map message type to leading icon character */
const ICONS: Record<StatusType, string> = {
	success: "✓",
	error: "✗",
	info: "ℹ",
	warning: "⚠",
};

/**
 * Map message type to the palette KEY, not the value. The value is read from
 * `theme` at render time so that `applyTheme()` (which swaps the palette in
 * place after this module has been imported) is honoured. A module-scope copy
 * of `theme.success` would be a stale string snapshot.
 */
const COLOR_KEY: Record<StatusType, keyof ThemePalette> = {
	success: "success",
	error: "error",
	info: "info",
	warning: "warning",
};

// ============================================================================
// Component
// ============================================================================

/**
 * Inline status line: icon + message in the appropriate color.
 *
 * Uses <text> with nested <span> so that the icon and message share
 * the same text renderable (no layout gaps between them).
 */
export function StatusMessage({ type, message }: StatusMessageProps) {
	const icon = ICONS[type];
	const color = theme[COLOR_KEY[type]];

	return (
		<box flexDirection="row" paddingTop={1}>
			<text>
				<span fg={color}>{`${icon} ${message}`}</span>
			</text>
		</box>
	);
}
