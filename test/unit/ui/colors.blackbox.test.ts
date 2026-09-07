/**
 * Black-box tests for the ANSI palette (`applyAnsiTheme`) from FR5: light
 * mode changes only what is unreadable on white, dark mode is untouched,
 * and every value is a well-formed SGR sequence (a light value that prints
 * garbage would be worse than an unreadable one).
 *
 * Complements `test/unit/ui/colors.test.ts` with: escape hygiene, strict
 * identity of the unchanged keys, and a luminance ceiling on the light-mode
 * replacements decoded from their 256-colour / truecolor / basic SGR form.
 */

import { afterEach, describe, expect, it } from "bun:test";
import {
	type AnsiPalette,
	applyAnsiTheme,
	colors,
} from "../../../src/ui/colors.js";

const ORIGINAL: AnsiPalette = { ...colors };
const ESC = "\x1b";
const SGR_BODY = /^\[[\d;]*m$/;

/** True when `value` is ESC followed by a well-formed SGR body. */
function isSgr(value: string): boolean {
	return value.startsWith(ESC) && SGR_BODY.test(value.slice(1));
}

/** xterm's default 16-colour palette (index → rgb 0..255). */
const BASIC16: Array<[number, number, number]> = [
	[0, 0, 0],
	[205, 0, 0],
	[0, 205, 0],
	[205, 205, 0],
	[0, 0, 238],
	[205, 0, 205],
	[0, 205, 205],
	[229, 229, 229],
	[127, 127, 127],
	[255, 0, 0],
	[0, 255, 0],
	[255, 255, 0],
	[92, 92, 255],
	[255, 0, 255],
	[0, 255, 255],
	[255, 255, 255],
];

function xterm256(n: number): [number, number, number] {
	if (n < 16) return BASIC16[n];
	if (n >= 232) {
		const v = 8 + 10 * (n - 232);
		return [v, v, v];
	}
	const idx = n - 16;
	const step = (v: number) => (v === 0 ? 0 : 55 + 40 * v);
	return [
		step(Math.floor(idx / 36)),
		step(Math.floor(idx / 6) % 6),
		step(idx % 6),
	];
}

/** Decodes a *foreground* SGR into rgb; null for non-colour codes (bold, reset, bg). */
function foregroundRgb(sgr: string): [number, number, number] | null {
	if (!isSgr(sgr)) throw new Error(`malformed SGR: ${JSON.stringify(sgr)}`);
	const parts = sgr.slice(2, -1).split(";").map(Number);
	if (parts[0] === 38 && parts[1] === 5 && parts.length === 3) {
		return xterm256(parts[2]);
	}
	if (parts[0] === 38 && parts[1] === 2 && parts.length === 5) {
		return [parts[2], parts[3], parts[4]];
	}
	if (parts.length === 1 && parts[0] >= 30 && parts[0] <= 37) {
		return BASIC16[parts[0] - 30];
	}
	if (parts.length === 1 && parts[0] >= 90 && parts[0] <= 97) {
		return BASIC16[parts[0] - 90 + 8];
	}
	return null;
}

function channel(v: number): number {
	const s = v / 255;
	return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

function luminance([r, g, b]: [number, number, number]): number {
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function changedKeys(): (keyof AnsiPalette)[] {
	return (Object.keys(ORIGINAL) as (keyof AnsiPalette)[]).filter(
		(k) => colors[k] !== ORIGINAL[k],
	);
}

describe("applyAnsiTheme (black box)", () => {
	afterEach(() => {
		applyAnsiTheme("dark");
	});

	it("AC-07: every value is a well-formed SGR sequence in both modes", () => {
		for (const mode of ["light", "dark"] as const) {
			applyAnsiTheme(mode);
			for (const [key, value] of Object.entries(colors)) {
				expect(typeof value, `${mode}.${key}`).toBe("string");
				expect(isSgr(value), `${mode}.${key}=${JSON.stringify(value)}`).toBe(
					true,
				);
			}
		}
	});

	it("AC-02/03: light changes something, and only a small named set", () => {
		applyAnsiTheme("light");
		const changed = changedKeys();
		expect(changed.length).toBeGreaterThan(0);
		expect(changed.length).toBeLessThanOrEqual(10);
	});

	it("AC-09: keys not overridden in light mode are the very same strings", () => {
		applyAnsiTheme("light");
		const changed = new Set(changedKeys());
		for (const key of Object.keys(ORIGINAL) as (keyof AnsiPalette)[]) {
			if (changed.has(key)) continue;
			expect(colors[key]).toBe(ORIGINAL[key]);
		}
		expect(colors.reset).toBe(ORIGINAL.reset);
	});

	it("AC-05: every light-mode replacement is a foreground colour that is not near-white", () => {
		applyAnsiTheme("light");
		for (const key of changedKeys()) {
			const rgb = foregroundRgb(colors[key]);
			expect(
				rgb,
				`${key} should be a decodable foreground colour`,
			).not.toBeNull();
			if (!rgb) continue;
			expect(luminance(rgb), `light.${key}`).toBeLessThanOrEqual(0.7);
		}
	});

	it("AC-05b: every light-mode replacement is darker than the dark-mode value it replaces", () => {
		applyAnsiTheme("light");
		for (const key of changedKeys()) {
			const light = foregroundRgb(colors[key]);
			const dark = foregroundRgb(ORIGINAL[key]);
			if (!light || !dark) continue;
			expect(luminance(light), `light.${key} vs dark.${key}`).toBeLessThan(
				luminance(dark),
			);
		}
	});

	it("AC-06: no dark-mode 256-colour / truecolor foreground is near-black", () => {
		applyAnsiTheme("dark");
		for (const [key, value] of Object.entries(colors)) {
			if (!value.startsWith(`${ESC}[38;`)) continue;
			const rgb = foregroundRgb(value);
			if (!rgb) continue;
			expect(luminance(rgb), `dark.${key}`).toBeGreaterThanOrEqual(0.1);
		}
	});

	it("AC-04: light → dark → light → dark ends byte-identical to import time", () => {
		applyAnsiTheme("light");
		applyAnsiTheme("dark");
		applyAnsiTheme("light");
		applyAnsiTheme("dark");
		expect(JSON.stringify(colors)).toBe(JSON.stringify(ORIGINAL));
	});
});
