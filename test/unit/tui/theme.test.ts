/**
 * Theme-aware TUI palette (architecture §2.3, §3.1, §6).
 *
 * Covers the contract that lets 36 importers keep their `import { theme }`
 * lines untouched: `theme` is one object with a stable identity, `applyTheme`
 * mutates it in place, and the light palette is readable on white.
 *
 * The last block is a SOURCE-LEVEL guard: it walks `src/tui/**` and fails on
 * any module-scope capture of a `theme.<key>` value. That failure mode
 * ("renders dark in light mode") is invisible to a non-TTY test suite, so it
 * is caught by reading the source rather than by rendering.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
	readdirSync,
	readFileSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import {
	applyTheme,
	getScoreColor,
	type ThemePalette,
	theme,
} from "../../../src/tui/theme.js";

/** Import-time snapshot: the dark palette as it was before any applyTheme call. */
const DARK_SNAPSHOT: ThemePalette = { ...theme };

/** Keys that carry text on the light background and must meet WCAG AA (4.5:1). */
const LIGHT_TEXT_ROLE_KEYS: readonly (keyof ThemePalette)[] = [
	"text",
	"primary",
	"success",
	"error",
	"warning",
	"info",
	"valueBright",
	"dangerText",
	"secretBright",
	// Phase 4b: code-preview syntax roles, dead-code value, kind colours as text
	"syntaxKeyword",
	"syntaxString",
	"syntaxComment",
	"syntaxNumber",
	"syntaxType",
	"syntaxFunc",
	"syntaxPunctuation",
	"dangerValue",
	"kindFunc",
	"kindType",
	"kindModule",
];

/**
 * Foreground/background PAIRS drawn together (not on the page background).
 * Each must meet 4.5:1 in light mode; badges are dark boxes in both modes.
 */
const LIGHT_FG_BG_PAIRS: readonly [keyof ThemePalette, keyof ThemePalette][] = [
	["matchFg", "matchBg"],
	["selectedRowFg", "selectedRowBg"],
	["sectionText", "sectionBg"],
	["sectionText", "sectionBgAlt"],
	["sectionText", "sectionBgSoft"],
	["text", "detailSelectedBg"],
	["dangerFg", "dangerBg"],
	["dangerNote", "dangerBg"],
	["badgeText", "scoreHighBg"],
	["badgeText", "scoreMidBg"],
	["badgeText", "scoreLowBg"],
	["badgeVecFg", "badgeVecBg"],
	["badgeKwFg", "badgeKwBg"],
	["kindBadgeText", "kindFunc"],
	["kindBadgeText", "kindType"],
	["kindBadgeText", "kindModule"],
];

// ----------------------------------------------------------------------------
// Contrast helpers (WCAG 2.x relative luminance and contrast ratio)
// ----------------------------------------------------------------------------

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

function relativeLuminance(hex: string): number {
	const [r, g, b] = hexToRgb(hex);
	return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(a: string, b: string): number {
	const la = relativeLuminance(a);
	const lb = relativeLuminance(b);
	const [hi, lo] = la > lb ? [la, lb] : [lb, la];
	return (hi + 0.05) / (lo + 0.05);
}

// ----------------------------------------------------------------------------
// Palette behaviour
// ----------------------------------------------------------------------------

describe("applyTheme", () => {
	beforeEach(() => {
		applyTheme("dark");
	});

	it("starts dark: the import-time snapshot has the historical dark values", () => {
		expect(DARK_SNAPSHOT.text).toBe("#E5E7EB");
		expect(DARK_SNAPSHOT.primary).toBe("#FF8C57");
		expect(DARK_SNAPSHOT.bg).toBe("#1A1A2E");
		expect(DARK_SNAPSHOT.valueBright).toBe("#F9FAFB");
	});

	it("light changes theme.text to #1F2937 and keeps the object identity", () => {
		const before = theme;
		applyTheme("light");
		expect(theme).toBe(before);
		expect(theme.text).toBe("#1F2937");
		expect(theme.bg).toBe("#FFFFFF");
		expect(theme.valueBright).toBe("#111827");
	});

	it("dark restores every key deep-equal to the import-time copy", () => {
		applyTheme("light");
		applyTheme("dark");
		expect(theme).toEqual(DARK_SNAPSHOT);
	});

	it("light keeps the same key set as dark (no key added or dropped)", () => {
		applyTheme("light");
		expect(Object.keys(theme).sort()).toEqual(
			Object.keys(DARK_SNAPSHOT).sort(),
		);
	});

	it("is idempotent", () => {
		applyTheme("light");
		const once = { ...theme };
		applyTheme("light");
		expect(theme).toEqual(once);
	});

	it("call-time readers such as getScoreColor follow the swap", () => {
		expect(getScoreColor(0.9)).toBe(DARK_SNAPSHOT.success);
		applyTheme("light");
		expect(getScoreColor(0.9)).toBe("#15803D");
		expect(getScoreColor(0.5)).toBe("#B45309");
		expect(getScoreColor(0.1)).toBe("#B91C1C");
	});
});

describe("light palette contrast on #FFFFFF", () => {
	beforeEach(() => {
		applyTheme("light");
	});

	for (const key of LIGHT_TEXT_ROLE_KEYS) {
		it(`${key} is >= 4.5:1 (WCAG AA body text)`, () => {
			const ratio = contrastRatio(theme[key], "#FFFFFF");
			expect(ratio).toBeGreaterThanOrEqual(4.5);
		});
	}

	for (const [fg, bg] of LIGHT_FG_BG_PAIRS) {
		it(`${fg} on ${bg} is >= 4.5:1`, () => {
			const ratio = contrastRatio(theme[fg], theme[bg]);
			expect(ratio).toBeGreaterThanOrEqual(4.5);
		});
	}

	it("the dark text colour would NOT have passed (the check is not vacuous)", () => {
		expect(contrastRatio(DARK_SNAPSHOT.text, "#FFFFFF")).toBeLessThan(4.5);
		expect(contrastRatio(DARK_SNAPSHOT.primary, "#FFFFFF")).toBeLessThan(4.5);
		// The One Dark syntax colours are the reason the syntax roles exist
		expect(contrastRatio(DARK_SNAPSHOT.syntaxString, "#FFFFFF")).toBeLessThan(
			4.5,
		);
		expect(contrastRatio(DARK_SNAPSHOT.syntaxFunc, "#FFFFFF")).toBeLessThan(
			4.5,
		);
	});
});

describe("palette completeness", () => {
	beforeEach(() => {
		applyTheme("dark");
	});

	/**
	 * TypeScript already enforces that LIGHT_PALETTE has every ThemePalette
	 * key; this documents it at runtime and catches an `undefined` slipping
	 * through a cast. Both directions: light adds nothing, drops nothing.
	 */
	it("every ThemePalette key is a #rrggbb string in BOTH palettes", () => {
		const darkKeys = Object.keys(DARK_SNAPSHOT).sort();
		applyTheme("light");
		const lightKeys = Object.keys(theme).sort();
		expect(lightKeys).toEqual(darkKeys);
		for (const key of darkKeys) {
			expect(DARK_SNAPSHOT[key as keyof ThemePalette]).toMatch(
				/^#[0-9A-Fa-f]{6}$/,
			);
			expect(theme[key as keyof ThemePalette]).toMatch(/^#[0-9A-Fa-f]{6}$/);
		}
	});

	it("the phase 4b roles exist and their dark values are the literals they replaced", () => {
		expect(DARK_SNAPSHOT.syntaxKeyword).toBe("#C678DD");
		expect(DARK_SNAPSHOT.syntaxPunctuation).toBe("#ABB2BF");
		expect(DARK_SNAPSHOT.matchBg).toBe("#B8860B");
		expect(DARK_SNAPSHOT.matchFg).toBe("#000000");
		expect(DARK_SNAPSHOT.selectedRowBg).toBe("#B8860B");
		expect(DARK_SNAPSHOT.scoreHighBg).toBe("#1B5E20");
		expect(DARK_SNAPSHOT.scoreMidBg).toBe("#E65100");
		expect(DARK_SNAPSHOT.scoreLowBg).toBe("#B71C1C");
		expect(DARK_SNAPSHOT.badgeVecBg).toBe("#1A237E");
		expect(DARK_SNAPSHOT.badgeVecFg).toBe("#90CAF9");
		expect(DARK_SNAPSHOT.badgeKwBg).toBe("#4A148C");
		expect(DARK_SNAPSHOT.badgeKwFg).toBe("#CE93D8");
		expect(DARK_SNAPSHOT.sectionBg).toBe("#263238");
		expect(DARK_SNAPSHOT.sectionBgAlt).toBe("#37474F");
		expect(DARK_SNAPSHOT.sectionBgSoft).toBe("#455A64");
		expect(DARK_SNAPSHOT.sectionText).toBe("#FFFFFF");
		expect(DARK_SNAPSHOT.detailSelectedBg).toBe("#37474F");
		expect(DARK_SNAPSHOT.dangerBg).toBe("#B71C1C");
		expect(DARK_SNAPSHOT.dangerNote).toBe("#FFCDD2");
		expect(DARK_SNAPSHOT.dangerValue).toBe("#EF5350");
		expect(DARK_SNAPSHOT.kindFunc).toBe("#61AFEF");
		expect(DARK_SNAPSHOT.kindType).toBe("#E5C07B");
		expect(DARK_SNAPSHOT.kindModule).toBe("#8B5CF6");
		expect(DARK_SNAPSHOT.kindBadgeText).toBe("#000000");
	});
});

// ----------------------------------------------------------------------------
// Guard: no module-scope palette value copies under src/tui (MEDIUM-3)
// ----------------------------------------------------------------------------

/**
 * A module-scope capture of a theme VALUE is a string snapshot that
 * `applyTheme` cannot update. Two shapes are detected, both by line-anchored
 * regex on the source text:
 *
 *   1. `const X = theme.success;`   — a top-level binding (column 0, optional
 *      `export`) whose initialiser starts with `theme.<key>`.
 *   2. `const X = {` at column 0 followed, before the closing `};` at column 0,
 *      by a property line whose value is `theme.<key>` (one-tab indented, as
 *      biome formats top-level object literals).
 *
 * Limits, on purpose: this is a heuristic over formatted source, not a parse.
 * It does not see captures nested deeper than one tab (arrays of objects,
 * helper factories called at module scope), captures via destructuring
 * (`const { success } = theme`), or code that biome has not formatted. It is
 * meant to catch the shape that actually occurred (StatusMessage.tsx before
 * §2.5), not every conceivable one. Reads at render/call time — inside a
 * function body — are the correct pattern and are indented past one tab, so
 * they never match.
 */
const TOP_LEVEL_VALUE_CAPTURE =
	/^(export )?(const|let|var) [^=]*=\s*theme\.\w+/;
const TOP_LEVEL_OBJECT_OPEN = /^(export )?(const|let|var) \w+[^=]*=\s*\{\s*$/;
const TOP_LEVEL_OBJECT_CLOSE = /^\}(\s+as\s+const)?;?\s*$/;
const ONE_TAB_PROPERTY_CAPTURE = /^\t[\w"']+\s*:\s*theme\.\w+/;

function walkSources(dir: string, out: string[] = []): string[] {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			walkSources(full, out);
		} else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) {
			out.push(full);
		}
	}
	return out;
}

/** Returns "path:line: text" for each offending line in one file. */
function findModuleScopeThemeCaptures(file: string): string[] {
	const lines = readFileSync(file, "utf8").split("\n");
	const hits: string[] = [];
	let inTopLevelObject = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (inTopLevelObject) {
			if (TOP_LEVEL_OBJECT_CLOSE.test(line)) {
				inTopLevelObject = false;
			} else if (ONE_TAB_PROPERTY_CAPTURE.test(line)) {
				hits.push(`${file}:${i + 1}: ${line.trim()}`);
			}
			continue;
		}
		if (TOP_LEVEL_VALUE_CAPTURE.test(line)) {
			hits.push(`${file}:${i + 1}: ${line.trim()}`);
		} else if (TOP_LEVEL_OBJECT_OPEN.test(line)) {
			inTopLevelObject = true;
		}
	}
	return hits;
}

describe("guard: no module-scope theme value copies under src/tui", () => {
	const root = join(import.meta.dir, "../../../src/tui");

	it("walks a non-trivial set of source files", () => {
		expect(walkSources(root).length).toBeGreaterThan(10);
	});

	it("the detector recognises both capture shapes (self-test)", () => {
		const sample = [
			'import { theme } from "./theme.js";',
			"export const STALE = theme.success;",
			"const COLORS: Record<string, string> = {",
			"\tsuccess: theme.success,",
			"\terror: theme.error,",
			"};",
			"export function ok() {",
			"\tconst live = theme.success;",
			"\treturn live;",
			"}",
		].join("\n");
		const tmp = join(import.meta.dir, "__guard_sample__.ts");
		writeFileSync(tmp, sample);
		try {
			const hits = findModuleScopeThemeCaptures(tmp);
			expect(hits.map((h) => h.replace(/^.*?:\d+: /, ""))).toEqual([
				"export const STALE = theme.success;",
				"success: theme.success,",
				"error: theme.error,",
			]);
		} finally {
			unlinkSync(tmp);
		}
	});

	it("no file captures a theme value at module scope", () => {
		const offenders = walkSources(root).flatMap((f) =>
			findModuleScopeThemeCaptures(f).map((h) => relative(root, h)),
		);
		expect(offenders).toEqual([]);
	});
});
