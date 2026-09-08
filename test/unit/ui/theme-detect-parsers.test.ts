/**
 * The pure parsers behind theme resolution (architecture §6, parser tables).
 *
 * These are table-driven on purpose: each row is one terminal or environment
 * convention seen in the wild, and the tables are where a new convention gets
 * added when a terminal answers in a form not yet covered.
 */

import { describe, expect, it } from "bun:test";
import {
	classifyLuminance,
	OSC11_PROBE_TIMEOUT_MS,
	parseColorFgBg,
	parseOsc11Reply,
	parseThemeFlag,
	parseThemeWord,
	probeTerminalBackground,
	type Rgb,
	ThemeFlagError,
	type ThemeMode,
} from "../../../src/ui/theme-detect.js";

const BEL = "\x07";
const ESC = "\x1b";
const ST = `${ESC}\\`;

describe("parseThemeWord", () => {
	const cases: Array<[string | undefined, ThemeMode | null]> = [
		["light", "light"],
		["dark", "dark"],
		["Light ", "light"],
		["  DARK", "dark"],
		["auto", null],
		["", null],
		["   ", null],
		["blue", null],
		["lightish", null],
		[undefined, null],
	];

	for (const [value, expected] of cases) {
		it(`${JSON.stringify(value)} → ${expected}`, () => {
			expect(parseThemeWord(value)).toBe(expected);
		});
	}
});

describe("parseThemeFlag", () => {
	it("strips --theme=X from any position", () => {
		expect(parseThemeFlag(["status", "--theme=dark", "--json"])).toEqual({
			mode: "dark",
			rest: ["status", "--json"],
		});
	});

	it("strips --theme X (two tokens) from any position", () => {
		expect(parseThemeFlag(["--theme", "light", "status"])).toEqual({
			mode: "light",
			rest: ["status"],
		});
	});

	it("normalises case and whitespace like the env parser", () => {
		expect(parseThemeFlag(["--theme=Light"]).mode).toBe("light");
	});

	it("returns null mode and the same argv when the flag is absent", () => {
		expect(parseThemeFlag(["search", "foo"])).toEqual({
			mode: null,
			rest: ["search", "foo"],
		});
	});

	it("last occurrence wins when the flag is repeated", () => {
		expect(parseThemeFlag(["--theme=dark", "--theme=light"]).mode).toBe(
			"light",
		);
	});

	it("throws ThemeFlagError naming the bad value", () => {
		expect(() => parseThemeFlag(["--theme=blue"])).toThrow(ThemeFlagError);
		expect(() => parseThemeFlag(["--theme=blue"])).toThrow(/got 'blue'/);
		expect(() => parseThemeFlag(["--theme=auto"])).toThrow(ThemeFlagError);
		expect(() => parseThemeFlag(["--theme="])).toThrow(ThemeFlagError);
	});

	it("throws ThemeFlagError for a bare --theme with nothing after it", () => {
		expect(() => parseThemeFlag(["status", "--theme"])).toThrow(ThemeFlagError);
	});

	it("does not treat --theme-something as the flag", () => {
		expect(parseThemeFlag(["--theme-x"])).toEqual({
			mode: null,
			rest: ["--theme-x"],
		});
	});
});

describe("parseColorFgBg", () => {
	const cases: Array<[string | undefined, ThemeMode | null]> = [
		["0;15", "light"],
		["15;0", "dark"],
		["7;0;8", "dark"], // three fields: last one is the background
		["0;0;7", "light"],
		["0;7", "light"],
		["15;8", "dark"], // 8 is bright black
		["0;9", "light"],
		["1;16", null], // out of range
		["a;b", null],
		["", null],
		["15", "light"], // a single field is treated as the background
		[" 0;15 ", "light"],
		[undefined, null],
	];

	for (const [value, expected] of cases) {
		it(`${JSON.stringify(value)} → ${expected}`, () => {
			expect(parseColorFgBg(value)).toBe(expected);
		});
	}
});

describe("parseOsc11Reply", () => {
	const white: Rgb = { r: 1, g: 1, b: 1 };

	function expectRgbClose(actual: Rgb | null, expected: Rgb) {
		expect(actual).not.toBeNull();
		if (!actual) return;
		expect(actual.r).toBeCloseTo(expected.r, 5);
		expect(actual.g).toBeCloseTo(expected.g, 5);
		expect(actual.b).toBeCloseTo(expected.b, 5);
	}

	it("BEL-terminated 16-bit reply", () => {
		expectRgbClose(
			parseOsc11Reply(`${ESC}]11;rgb:ffff/ffff/ffff${BEL}`),
			white,
		);
	});

	it("ST-terminated 16-bit reply", () => {
		expectRgbClose(parseOsc11Reply(`${ESC}]11;rgb:0000/0000/0000${ST}`), {
			r: 0,
			g: 0,
			b: 0,
		});
	});

	it("8-bit short form rgb:ff/ff/ff scales to the same white", () => {
		expectRgbClose(parseOsc11Reply(`${ESC}]11;rgb:ff/ff/ff${BEL}`), white);
	});

	it("4-bit short form rgb:f/f/f scales to the same white", () => {
		expectRgbClose(parseOsc11Reply(`${ESC}]11;rgb:f/f/f${BEL}`), white);
	});

	it("rgba: with an alpha component is accepted and alpha ignored", () => {
		expectRgbClose(
			parseOsc11Reply(`${ESC}]11;rgba:1e1e/1e1e/1e1e/ffff${BEL}`),
			{
				r: 0x1e1e / 0xffff,
				g: 0x1e1e / 0xffff,
				b: 0x1e1e / 0xffff,
			},
		);
	});

	it("mixed-case hex digits are accepted", () => {
		expectRgbClose(parseOsc11Reply(`${ESC}]11;rgb:FdFd/F6F6/E3E3${BEL}`), {
			r: 0xfdfd / 0xffff,
			g: 0xf6f6 / 0xffff,
			b: 0xe3e3 / 0xffff,
		});
	});

	it("reply embedded after junk bytes (type-ahead) is still found", () => {
		expectRgbClose(
			parseOsc11Reply(`abc\x04${ESC}]11;rgb:ffff/ffff/ffff${BEL}${ESC}[?1;2c`),
			white,
		);
	});

	it("partial reply without a terminator yet → null (caller keeps accumulating)", () => {
		expect(parseOsc11Reply(`${ESC}]11;rgb:ffff/ffff/ff`)).toBeNull();
		expect(parseOsc11Reply(`${ESC}]11;rgb:ffff/ffff/ffff`)).toBeNull();
		expect(parseOsc11Reply(`${ESC}]11;`)).toBeNull();
	});

	it("DA1-only buffer (terminal does not support OSC 11) → null", () => {
		expect(parseOsc11Reply(`${ESC}[?62;22c`)).toBeNull();
	});

	it("empty buffer → null", () => {
		expect(parseOsc11Reply("")).toBeNull();
	});

	it("OSC 10 (foreground) reply is not mistaken for OSC 11", () => {
		expect(parseOsc11Reply(`${ESC}]10;rgb:ffff/ffff/ffff${BEL}`)).toBeNull();
	});
});

describe("classifyLuminance", () => {
	function hex(h: string): Rgb {
		const n = Number.parseInt(h.replace("#", ""), 16);
		return {
			r: ((n >> 16) & 0xff) / 255,
			g: ((n >> 8) & 0xff) / 255,
			b: (n & 0xff) / 255,
		};
	}

	const cases: Array<[string, ThemeMode]> = [
		["#FFFFFF", "light"],
		["#000000", "dark"],
		["#A0A0A0", "light"], // mid-grey: light-mode text has the better contrast here
		["#002B36", "dark"], // Solarized dark
		["#FDF6E3", "light"], // Solarized light
		["#1A1A2E", "dark"], // the TUI's own dark bg
		["#282C34", "dark"], // One Dark
		["#EEEEEE", "light"],
	];

	for (const [color, expected] of cases) {
		it(`${color} → ${expected}`, () => {
			expect(classifyLuminance(hex(color))).toBe(expected);
		});
	}

	it("round-trips through parseOsc11Reply for the two AC 6 replies", () => {
		const whiteReply = parseOsc11Reply(`${ESC}]11;rgb:ffff/ffff/ffff${BEL}`);
		const blackReply = parseOsc11Reply(`${ESC}]11;rgb:0000/0000/0000${BEL}`);
		expect(whiteReply && classifyLuminance(whiteReply)).toBe("light");
		expect(blackReply && classifyLuminance(blackReply)).toBe("dark");
	});
});

describe("probe constants and stub", () => {
	it("OSC11_PROBE_TIMEOUT_MS is within the 100–250 ms bound the requirements allow", () => {
		expect(OSC11_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(100);
		expect(OSC11_PROBE_TIMEOUT_MS).toBeLessThanOrEqual(250);
	});

	// The real probe (theme-probe.test.ts) is exercised with fake streams; this
	// only pins that the default io is safe when the runner's stdio is piped.
	it.skipIf(process.stdin.isTTY === true && process.stdout.isTTY === true)(
		"probeTerminalBackground with default io resolves null when stdio is not a terminal",
		async () => {
			await expect(probeTerminalBackground()).resolves.toBeNull();
		},
	);
});
