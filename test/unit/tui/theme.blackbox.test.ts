/**
 * Black-box tests for the OpenTUI palette (`applyTheme`) from FR5:
 * a light palette must exist, dark mode must be behaviour-preserving, and
 * neither palette may put near-white on white or near-black on black.
 *
 * Complements `test/unit/tui/theme.test.ts` with: uniform colour format in
 * both modes, the DARK palette's own readability (the regression guard for
 * "behaviour-preserving"), a ceiling on light-mode text luminance, light
 * backgrounds actually being light, and double-application round-trips.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
	applyTheme,
	type ThemePalette,
	theme,
} from "../../../src/tui/theme.js";

const ORIGINAL: ThemePalette = { ...theme };

const TEXT_ROLE_KEYS = [
	"text",
	"primary",
	"success",
	"error",
	"warning",
	"info",
	"valueBright",
	"dangerText",
	"secretBright",
] as const;

const HEX6 = /^#[0-9a-fA-F]{6}$/;

function hexToRgb(hex: string): [number, number, number] {
	const m = /^#([0-9a-f]{6})$/i.exec(hex);
	if (!m) throw new Error(`not a 6-digit hex colour: ${hex}`);
	const n = Number.parseInt(m[1], 16);
	return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function channel(v: number): number {
	const s = v / 255;
	return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
	const [r, g, b] = hexToRgb(hex);
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: string, b: string): number {
	const la = luminance(a);
	const lb = luminance(b);
	const [hi, lo] = la > lb ? [la, lb] : [lb, la];
	return (hi + 0.05) / (lo + 0.05);
}

/** Text-role keys that exist in the palette (skip, do not fail, on absence). */
function presentTextKeys(): (keyof ThemePalette)[] {
	return TEXT_ROLE_KEYS.filter(
		(k) => typeof (theme as Record<string, unknown>)[k] === "string",
	) as (keyof ThemePalette)[];
}

describe("applyTheme (black box)", () => {
	afterEach(() => {
		applyTheme("dark");
	});

	it("at least `text` and `primary` exist in the palette", () => {
		expect(typeof ORIGINAL.text).toBe("string");
		expect(typeof ORIGINAL.primary).toBe("string");
	});

	it("TT-06: every value is a #rrggbb colour in both modes, and no key is undefined", () => {
		for (const mode of ["light", "dark"] as const) {
			applyTheme(mode);
			for (const [key, value] of Object.entries(theme)) {
				expect(typeof value, `${mode}.${key}`).toBe("string");
				expect(value, `${mode}.${key}=${value}`).toMatch(HEX6);
			}
		}
	});

	it("TT-04: double application is idempotent in both directions", () => {
		applyTheme("light");
		const lightOnce = { ...theme };
		applyTheme("light");
		expect(theme).toEqual(lightOnce);

		applyTheme("dark");
		applyTheme("dark");
		expect(theme).toEqual(ORIGINAL);
	});

	it("TT-01: light text is darker than dark text (it is meant for a white background)", () => {
		applyTheme("light");
		expect(theme.text).not.toBe(ORIGINAL.text);
		expect(luminance(theme.text)).toBeLessThan(luminance(ORIGINAL.text));
	});

	it("TT-08: the dark palette's text roles read on black (>= 4.5:1) — behaviour-preserving means readable too", () => {
		applyTheme("dark");
		for (const key of presentTextKeys()) {
			expect(
				contrast(theme[key], "#000000"),
				`dark.${key}`,
			).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("TT-09: no light-mode text role is near-white (luminance <= 0.8)", () => {
		applyTheme("light");
		for (const key of presentTextKeys()) {
			expect(luminance(theme[key]), `light.${key}`).toBeLessThanOrEqual(0.8);
		}
	});

	it("TT-07: every light-mode text role reads on white (>= 4.5:1)", () => {
		applyTheme("light");
		for (const key of presentTextKeys()) {
			expect(
				contrast(theme[key], "#FFFFFF"),
				`light.${key}`,
			).toBeGreaterThanOrEqual(4.5);
		}
	});

	it("TT-10: light-mode background keys are light (luminance >= 0.6)", () => {
		applyTheme("light");
		const bgKeys = Object.keys(theme).filter((k) =>
			/^bg|background|surface/i.test(k),
		);
		expect(bgKeys.length).toBeGreaterThan(0);
		for (const key of bgKeys) {
			const value = (theme as Record<string, string>)[key];
			expect(luminance(value), `light.${key}=${value}`).toBeGreaterThanOrEqual(
				0.6,
			);
		}
	});

	it("TT-10b: dark-mode background keys are dark (luminance <= 0.3)", () => {
		applyTheme("dark");
		const bgKeys = Object.keys(theme).filter((k) =>
			/^bg|background|surface/i.test(k),
		);
		for (const key of bgKeys) {
			const value = (theme as Record<string, string>)[key];
			expect(luminance(value), `dark.${key}=${value}`).toBeLessThanOrEqual(0.3);
		}
	});

	it("TT-02: consumers holding the reference see the light values after the swap", () => {
		const ref = theme;
		applyTheme("light");
		expect(ref).toBe(theme);
		expect(ref.text).toBe(theme.text);
		expect(ref.text).not.toBe(ORIGINAL.text);
	});
});
