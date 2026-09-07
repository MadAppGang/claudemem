/**
 * Theme-aware ANSI palette (architecture §2.4, §3.1, §6).
 *
 * FR5 requires dark mode to be behaviour-preserving: after any sequence of
 * `applyAnsiTheme` calls ending in "dark", `colors` must be byte-identical to
 * what it was at import. Light mode overrides exactly the seven keys in the
 * §3.1 table and nothing else.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
	type AnsiPalette,
	applyAnsiTheme,
	c,
	colorize,
	colors,
	styled,
} from "../../../src/ui/colors.js";

/** Import-time snapshot of the dark codes. */
const DARK_SNAPSHOT: AnsiPalette = { ...colors };

/** The §3.1 table: exactly these keys change in light mode. */
const LIGHT_OVERRIDES: Readonly<Partial<AnsiPalette>> = {
	green: "\x1b[38;5;28m",
	success: "\x1b[38;5;28m",
	orange: "\x1b[38;5;166m",
	highlight: "\x1b[38;5;166m",
	purple: "\x1b[38;5;91m",
	yellow: "\x1b[38;5;136m",
	warning: "\x1b[38;5;136m",
};

describe("applyAnsiTheme", () => {
	beforeEach(() => {
		applyAnsiTheme("dark");
	});

	it("the import-time snapshot holds the historical dark codes", () => {
		expect(DARK_SNAPSHOT.green).toBe("\x1b[38;5;78m");
		expect(DARK_SNAPSHOT.orange).toBe("\x1b[38;5;209m");
		expect(DARK_SNAPSHOT.purple).toBe("\x1b[38;5;141m");
		expect(DARK_SNAPSHOT.yellow).toBe("\x1b[33m");
		expect(DARK_SNAPSHOT.reset).toBe("\x1b[0m");
	});

	it("keeps object identity, and `c` stays the same object as `colors`", () => {
		const before = colors;
		applyAnsiTheme("light");
		expect(colors).toBe(before);
		expect(c).toBe(colors);
	});

	it("light changes exactly the 7 table keys and nothing else", () => {
		applyAnsiTheme("light");
		const changed = (Object.keys(DARK_SNAPSHOT) as (keyof AnsiPalette)[])
			.filter((k) => colors[k] !== DARK_SNAPSHOT[k])
			.sort();
		expect(changed).toEqual(
			(Object.keys(LIGHT_OVERRIDES) as (keyof AnsiPalette)[]).sort(),
		);
		for (const [key, value] of Object.entries(LIGHT_OVERRIDES)) {
			expect(colors[key as keyof AnsiPalette]).toBe(value as string);
		}
	});

	it("light keeps the same key set (no key added or dropped)", () => {
		applyAnsiTheme("light");
		expect(Object.keys(colors).sort()).toEqual(
			Object.keys(DARK_SNAPSHOT).sort(),
		);
	});

	it("dark is byte-identical to the import-time snapshot after a light round-trip", () => {
		applyAnsiTheme("light");
		applyAnsiTheme("dark");
		expect(colors).toEqual(DARK_SNAPSHOT);
		for (const key of Object.keys(DARK_SNAPSHOT) as (keyof AnsiPalette)[]) {
			expect(Buffer.from(colors[key])).toEqual(Buffer.from(DARK_SNAPSHOT[key]));
		}
	});

	it("colorize/styled read at call time and follow the swap", () => {
		expect(colorize("x", "success")).toBe(`${DARK_SNAPSHOT.success}x\x1b[0m`);
		applyAnsiTheme("light");
		expect(colorize("x", "success")).toBe("\x1b[38;5;28mx\x1b[0m");
		expect(styled("x", "bold", "warning")).toBe(
			"\x1b[1m\x1b[38;5;136mx\x1b[0m",
		);
	});
});
