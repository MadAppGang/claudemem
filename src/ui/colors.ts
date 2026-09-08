/**
 * Terminal Color Constants
 *
 * Shared color definitions for consistent CLI styling across all benchmark tools.
 *
 * The palette is theme-aware: `colors` (and its alias `c`) is a MUTABLE object
 * with a stable identity, initialised to the dark codes and swapped in place by
 * `applyAnsiTheme(mode)` at startup. Dark values are byte-identical to the
 * historical constants; light mode overrides only the handful of 256-colour
 * pastels that are unreadable on a white background.
 */

import type { ThemeMode } from "./theme-env.js";

/** ANSI escape codes for terminal colors — dark background (the historical default). */
const DARK_ANSI = {
	reset: "\x1b[0m",
	bold: "\x1b[1m",
	dim: "\x1b[2m",

	// Primary colors
	red: "\x1b[31m",
	green: "\x1b[38;5;78m",
	yellow: "\x1b[33m",
	cyan: "\x1b[36m",
	magenta: "\x1b[35m",
	purple: "\x1b[38;5;141m",
	orange: "\x1b[38;5;209m",
	gray: "\x1b[90m",

	// Semantic aliases
	success: "\x1b[38;5;78m",
	error: "\x1b[31m",
	warning: "\x1b[33m",
	info: "\x1b[36m",
	highlight: "\x1b[38;5;209m",
} as const;

/** The palette shape: every key of the dark codes, widened to `string`. */
export type AnsiPalette = { -readonly [K in keyof typeof DARK_ANSI]: string };

/**
 * Codes that fail on a white background and their light replacements.
 * Everything not listed here is a 16-colour code the user's terminal palette
 * already maps sensibly for its own background, so it is left alone.
 */
const LIGHT_ANSI_OVERRIDES: Partial<AnsiPalette> = {
	green: "\x1b[38;5;28m", // #008700; 38;5;78 (#5FD787) is ~1.7:1 on white
	success: "\x1b[38;5;28m",
	orange: "\x1b[38;5;166m", // #D75F00; 38;5;209 (#FF875F) is ~2.5:1 on white
	highlight: "\x1b[38;5;166m",
	purple: "\x1b[38;5;91m", // #8700AF; 38;5;141 (#AF87FF) is ~2.9:1 on white
	yellow: "\x1b[38;5;136m", // #AF8700; palette yellow (33) is the classic unreadable one
	warning: "\x1b[38;5;136m",
};

/**
 * The active ANSI palette. Mutable, stable identity: `applyAnsiTheme` updates
 * it in place, so every module that imported `colors` or `c` sees the new
 * values without re-importing. Only `applyAnsiTheme` in this file writes to it.
 */
export const colors: AnsiPalette = { ...DARK_ANSI };

/** Shorthand for colors (for compact code) */
export const c = colors;

/** Swap the active ANSI palette in place. Idempotent; safe to call any number of times. */
export function applyAnsiTheme(mode: ThemeMode): void {
	Object.assign(
		colors,
		DARK_ANSI,
		mode === "light" ? LIGHT_ANSI_OVERRIDES : {},
	);
}

/**
 * Apply color to text
 */
export function colorize(text: string, color: keyof typeof colors): string {
	return `${colors[color]}${text}${colors.reset}`;
}

/**
 * Apply multiple styles
 */
export function styled(
	text: string,
	...styles: (keyof typeof colors)[]
): string {
	const prefix = styles.map((s) => colors[s]).join("");
	return `${prefix}${text}${colors.reset}`;
}
