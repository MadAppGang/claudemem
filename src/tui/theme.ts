/**
 * TUI Theme
 *
 * Color constants and style configuration for the terminal UI.
 * Matches the existing ui/colors.ts palette (orange branding).
 *
 * The palette is theme-aware: `theme` is a MUTABLE object with a stable
 * identity, initialised to the dark palette and swapped in place by
 * `applyTheme(mode)` at startup. Consumers keep importing `theme` and reading
 * `theme.x` at render time; nothing about their import lines changes.
 *
 * The one thing consumers must NOT do is copy a value out of `theme` at module
 * scope (`const X = theme.success`) — that is a snapshot of a string, not an
 * alias of the object, and `applyTheme` cannot reach it. A source-level guard
 * test (`test/unit/tui/theme.test.ts`) fails on any such capture under
 * `src/tui/**`.
 */

import type { ThemeMode } from "../ui/theme-env.js";

// ============================================================================
// Color Palette
// ============================================================================

/** Dark palette — the historical default. Values are unchanged. */
const DARK_PALETTE = {
	// Brand colors
	primary: "#FF8C57", // orange (matches existing branding)
	secondary: "#8B5CF6", // purple
	success: "#4ADE80", // green
	error: "#EF4444", // red
	warning: "#FBBF24", // yellow
	info: "#22D3EE", // cyan
	muted: "#6B7280", // gray
	text: "#E5E7EB", // light gray
	bg: "#1A1A2E", // dark background
	border: "#374151", // border gray
	highlight: "#FF8C57", // same as primary
	dimmed: "#4B5563", // darker gray for inactive elements
	selected: "#1E3A5F", // dark blue for selected items
	tabActive: "#FF8C57", // active tab color
	tabInactive: "#6B7280", // inactive tab color

	// btop-inspired additions
	borderDim: "#2D3748", // very dim border for secondary panels
	labelDim: "#4A5568", // dim label color (column headers etc.)
	valueBright: "#F9FAFB", // bright white for key values
	accentCyan: "#22D3EE", // accent for highlights
	accentGreen: "#4ADE80", // accent for success/active
	selectedBright: "#E5E7EB", // bright text when selected
	headerBg: "#0F172A", // very dark bg for header areas
	dangerBorder: "#7F1D1D", // dark red border for danger dialogs
	dangerText: "#FCA5A5", // soft red for danger text
	secretBright: "#FCD34D", // bright amber for secrets (stands out)
	shortcutKey: "#FF8C57", // orange for shortcut letters
	shortcutBracket: "#374151", // dim for shortcut brackets

	// Code preview syntax colouring (SyntaxLine) — One Dark values
	syntaxKeyword: "#C678DD",
	syntaxString: "#98C379",
	syntaxComment: "#5C6370",
	syntaxNumber: "#D19A66",
	syntaxType: "#E5C07B",
	syntaxFunc: "#61AFEF",
	syntaxPunctuation: "#ABB2BF",

	// Search-term match highlight and the selected result header row
	matchBg: "#B8860B",
	matchFg: "#000000",
	selectedRowBg: "#B8860B",
	selectedRowFg: "#000000",

	// Score / PageRank badge backgrounds (badgeText is drawn on top)
	scoreHighBg: "#1B5E20",
	scoreMidBg: "#E65100",
	scoreLowBg: "#B71C1C",
	badgeText: "#FFFFFF",
	badgeVecBg: "#1A237E",
	badgeVecFg: "#90CAF9",
	badgeKwBg: "#4A148C",
	badgeKwFg: "#CE93D8",

	// Detail view: section header bars, selected symbol row, danger block
	sectionBg: "#263238",
	sectionBgAlt: "#37474F",
	sectionBgSoft: "#455A64",
	sectionText: "#FFFFFF",
	detailSelectedBg: "#37474F",
	dangerBg: "#B71C1C",
	dangerFg: "#FFFFFF",
	dangerNote: "#FFCDD2",
	dangerValue: "#EF5350",

	// Symbol kind colours (badge background AND plain text, see kindBadgeText)
	kindFunc: "#61AFEF",
	kindType: "#E5C07B",
	kindModule: "#8B5CF6",
	kindBadgeText: "#000000",
} as const;

/** The palette shape: every key of the dark palette, widened to `string`. */
export type ThemePalette = {
	-readonly [K in keyof typeof DARK_PALETTE]: string;
};

/**
 * Light palette — same keys, chosen for >= 4.5:1 contrast on #FFFFFF
 * (Tailwind 700-weights of the same hues).
 */
const LIGHT_PALETTE: ThemePalette = {
	primary: "#C2410C", // orange-700; #FF8C57 is 2.3:1 on white
	secondary: "#6D28D9", // violet-700
	success: "#15803D", // green-700
	error: "#B91C1C", // red-700
	warning: "#B45309", // amber-700
	info: "#0E7490", // cyan-700
	muted: "#6B7280", // gray-500, 4.8:1 — kept
	text: "#1F2937", // gray-800
	bg: "#FFFFFF",
	border: "#D1D5DB", // gray-300
	highlight: "#C2410C",
	dimmed: "#9CA3AF", // gray-400: decorative only, never body text
	selected: "#DBEAFE", // blue-100 row background
	tabActive: "#C2410C",
	tabInactive: "#6B7280",
	borderDim: "#E5E7EB",
	labelDim: "#9CA3AF",
	valueBright: "#111827", // gray-900 (was near-white — the FR5 "no near-white on white" case)
	accentCyan: "#0E7490",
	accentGreen: "#15803D",
	selectedBright: "#111827",
	headerBg: "#F3F4F6",
	dangerBorder: "#FCA5A5",
	dangerText: "#991B1B",
	secretBright: "#92400E", // amber-800
	shortcutKey: "#C2410C",
	shortcutBracket: "#D1D5DB",

	// Syntax colouring — One Light hues, darkened where needed to reach 4.5:1
	syntaxKeyword: "#A626A4", // 6.1:1
	syntaxString: "#2E7D32", // 5.1:1 (One Light's #50A14F is 3.2:1)
	syntaxComment: "#6B7280", // 4.8:1
	syntaxNumber: "#986801", // 4.9:1
	syntaxType: "#A16207", // yellow-700, 4.9:1 (#C18401 is 3.2:1)
	syntaxFunc: "#1D4ED8", // blue-700, 6.7:1 (#4078F2 is 4.05:1)
	syntaxPunctuation: "#383A42", // 11.3:1

	// Match highlight and selected result row: pale fills, gray-800 text
	matchBg: "#FDE68A", // amber-200
	matchFg: "#1F2937",
	selectedRowBg: "#FED7AA", // orange-200
	selectedRowFg: "#1F2937",

	// Badges stay dark boxes with light text in both modes
	scoreHighBg: "#15803D",
	scoreMidBg: "#C2410C",
	scoreLowBg: "#B91C1C",
	badgeText: "#FFFFFF",
	badgeVecBg: "#1A237E",
	badgeVecFg: "#BFDBFE", // blue-200
	badgeKwBg: "#4A148C",
	badgeKwFg: "#E9D5FF", // purple-200

	// Detail view
	sectionBg: "#E5E7EB", // gray-200
	sectionBgAlt: "#D1D5DB", // gray-300
	sectionBgSoft: "#BFC5CD",
	sectionText: "#111827", // gray-900
	detailSelectedBg: "#DBEAFE", // blue-100
	dangerBg: "#FEE2E2", // red-100
	dangerFg: "#991B1B", // red-800
	dangerNote: "#B91C1C", // red-700
	dangerValue: "#B91C1C",

	// Kind colours double as badge fill (white text) and plain text on white
	kindFunc: "#1D4ED8",
	kindType: "#A16207",
	kindModule: "#6D28D9",
	kindBadgeText: "#FFFFFF",
};

/**
 * The active palette. Mutable, stable identity: `applyTheme` updates it in
 * place, so every module that imported `theme` sees the new values without
 * re-importing. Only `applyTheme` in this file writes to it.
 */
export const theme: ThemePalette = { ...DARK_PALETTE };

/** Swap the active palette in place. Idempotent; safe to call any number of times. */
export function applyTheme(mode: ThemeMode): void {
	Object.assign(theme, mode === "light" ? LIGHT_PALETTE : DARK_PALETTE);
}

// ============================================================================
// Score Bar Configuration
// ============================================================================

/** Characters used to render the score bar */
export const scoreBarChars = {
	filled: "\u2588", // █
	empty: "\u2591", // ░
	half: "\u2584", // ▄
} as const;

/** Get color for a score 0-1 */
export function getScoreColor(score: number): string {
	if (score >= 0.7) return theme.success;
	if (score >= 0.4) return theme.warning;
	return theme.error;
}

// ============================================================================
// Border Styles
// ============================================================================

export type BorderStyle = "rounded" | "single" | "double" | "none";

export const borderStyles = {
	panel: "rounded" as BorderStyle,
	input: "single" as BorderStyle,
	overlay: "double" as BorderStyle,
} as const;

// ============================================================================
// Layout Constants
// ============================================================================

export const layout = {
	tabBarHeight: 1,
	statusBarHeight: 1,
	inputHeight: 1,
	minWidth: 80,
	wideWidth: 120, // threshold for wide layout
} as const;
