/**
 * Black-box tests for the theme resolution chain and its parsers, written
 * from the requirements (FR1–FR7, AC 1–9) and the §4 API contracts only.
 *
 * These complement `theme-detect.test.ts` / `theme-detect-parsers.test.ts`
 * with the scenarios a first pass tends to leave out: the error path having
 * no side effects, stdout being untouched by diagnostics (not just stderr
 * being quiet), argument passthrough on the gated commands, near-miss env
 * words, and the parser edges (frozen argv, `--theme --agent`, prefix safety,
 * COLORFGBG sweep, per-component OSC 11 scaling, luminance weighting).
 *
 * Inputs the spec leaves open are `test.todo`s, not assertions.
 */

import { afterEach, describe, expect, it, mock, spyOn, test } from "bun:test";
import { applyTheme } from "../../../src/tui/theme.js";
import { applyAnsiTheme } from "../../../src/ui/colors.js";
import {
	classifyLuminance,
	detectThemeAtStartup,
	getTheme,
	type ProbeIo,
	parseColorFgBg,
	parseOsc11Reply,
	parseThemeFlag,
	parseThemeWord,
	type ResolveThemeInput,
	type Rgb,
	resolveTheme,
	ThemeFlagError,
	type ThemeMode,
	type ThemeProbe,
	type ThemeSource,
} from "../../../src/ui/theme-detect.js";
import { captureThemeEnv } from "../../../src/ui/theme-env.js";

const ESC = "\x1b";
const BEL = "\x07";

function probeReturning(reply: ThemeMode | null) {
	return mock<ThemeProbe>(() => Promise.resolve(reply));
}

function resolve(overrides: Partial<ResolveThemeInput>) {
	return resolveTheme({
		argv: [],
		env: {},
		interactive: true,
		probe: probeReturning(null),
		...overrides,
	});
}

// ---------------------------------------------------------------------------
// resolveTheme — precedence edges
// ---------------------------------------------------------------------------

describe("resolveTheme (black box) — precedence edges", () => {
	it("CH-03: --theme after the command still wins over MNEMEX_THEME and is stripped", async () => {
		const result = await resolve({
			argv: ["status", "--theme=dark"],
			env: { MNEMEX_THEME: "light" },
		});

		expect(result.mode).toBe("dark");
		expect(result.source).toBe("flag");
		expect(result.argv).toEqual(["status"]);
	});

	it("CH-05: ThemeFlagError names both accepted values and the offending one", async () => {
		let caught: unknown;
		try {
			await resolve({ argv: ["--theme=blue"] });
		} catch (err) {
			caught = err;
		}

		expect(caught).toBeInstanceOf(ThemeFlagError);
		const message = (caught as Error).message;
		expect(message).toContain("light");
		expect(message).toContain("dark");
		expect(message).toContain("blue");
	});

	it("CH-07: a bad flag fails before the probe is reached (no terminal write on the error path)", async () => {
		const probe = probeReturning("light");

		await expect(
			resolve({ argv: ["--theme=blue"], interactive: true, probe }),
		).rejects.toBeInstanceOf(ThemeFlagError);
		expect(probe.mock.calls.length).toBe(0);
	});

	it("CH-09: MNEMEX_THEME is trimmed and case-folded like TERM_THEME", async () => {
		const result = await resolve({
			env: { MNEMEX_THEME: " DARK ", TERM_THEME: "light" },
			interactive: false,
		});

		expect(result.mode).toBe("dark");
		expect(result.source).toBe("env");
	});

	it("CH-11: MNEMEX_THEME answering skips the probe entirely (FR2 applies to every earlier source)", async () => {
		const probe = probeReturning("light");

		const result = await resolve({
			env: { MNEMEX_THEME: "dark" },
			interactive: true,
			probe,
		});

		expect(result.mode).toBe("dark");
		expect(result.source).toBe("env");
		expect(probe.mock.calls.length).toBe(0);
	});

	it("CH-16: TERM_THEME=auto does not short-circuit to dark ahead of COLORFGBG", async () => {
		const result = await resolve({
			env: { TERM_THEME: "auto", COLORFGBG: "0;15" },
			interactive: false,
		});

		expect(result.mode).toBe("light");
		expect(result.source).toBe("colorfgbg");
	});

	describe("CH-18: near-miss TERM_THEME words have no opinion", () => {
		for (const word of ["lightish", "dark mode", "0", "1", "LIGHT DARK"]) {
			it(`TERM_THEME=${JSON.stringify(word)} falls through to the probe`, async () => {
				const probe = probeReturning("light");

				const result = await resolve({
					env: { TERM_THEME: word },
					interactive: true,
					probe,
				});

				expect(result.source).toBe("osc11");
				expect(result.mode).toBe("light");
				expect(probe.mock.calls.length).toBe(1);
			});
		}
	});

	it("CH-26: a null probe reply is not retried — exactly one invocation", async () => {
		const probe = probeReturning(null);

		const result = await resolve({ env: {}, interactive: true, probe });

		expect(result.source).toBe("default");
		expect(probe.mock.calls.length).toBe(1);
	});

	it("CH-37: resolveTheme itself never writes to stdout or stderr, whichever source answers", async () => {
		const out = spyOn(process.stdout, "write").mockImplementation(() => true);
		const err = spyOn(process.stderr, "write").mockImplementation(() => true);
		try {
			const cases: Array<[Partial<ResolveThemeInput>, ThemeSource]> = [
				[{ argv: ["--theme=light"] }, "flag"],
				[{ env: { MNEMEX_THEME: "light" } }, "env"],
				[{ env: { TERM_THEME: "light" } }, "term-theme"],
				[{ probe: probeReturning("light") }, "osc11"],
				[{ env: { COLORFGBG: "0;15" }, interactive: false }, "colorfgbg"],
				[{ interactive: false }, "default"],
			];
			for (const [overrides, source] of cases) {
				const result = await resolve(overrides);
				expect(result.source).toBe(source);
			}
			expect(out.mock.calls.length).toBe(0);
			expect(err.mock.calls.length).toBe(0);
		} finally {
			out.mockRestore();
			err.mockRestore();
		}
	});

	test.todo(
		"CH-04: is `--theme=LIGHT` (upper-case flag value) accepted like the env word, or a ThemeFlagError? FR1.1 says `light|dark`; FR1.3's case-insensitivity is stated for TERM_THEME only.",
	);
});

// ---------------------------------------------------------------------------
// captureThemeEnv — by value
// ---------------------------------------------------------------------------

describe("captureThemeEnv (black box)", () => {
	it("CH-34: the snapshot is a copy — mutating the source afterwards does not change it", () => {
		const source: NodeJS.ProcessEnv = {
			TERM_THEME: "light",
			MNEMEX_THEME: "dark",
			COLORFGBG: "0;15",
			TERM: "xterm",
			PATH: "/x",
		};
		const snap = captureThemeEnv(source);

		source.TERM_THEME = "dark";
		source.MNEMEX_THEME = "light";
		delete source.COLORFGBG;

		expect(snap.TERM_THEME).toBe("light");
		expect(snap.MNEMEX_THEME).toBe("dark");
		expect(snap.COLORFGBG).toBe("0;15");
		expect(snap.TERM).toBe("xterm");
		expect("PATH" in snap).toBe(false);
	});

	it("CH-35: an empty source resolves dark/default when non-interactive", async () => {
		const snap = captureThemeEnv({});

		expect(snap.TERM_THEME).toBeUndefined();
		expect(snap.MNEMEX_THEME).toBeUndefined();
		expect(snap.COLORFGBG).toBeUndefined();
		expect(snap.TERM).toBeUndefined();

		const result = await resolve({ env: snap, interactive: false });
		expect(result.mode).toBe("dark");
		expect(result.source).toBe("default");
	});
});

// ---------------------------------------------------------------------------
// detectThemeAtStartup — stdout silence, message hygiene, gate passthrough
// ---------------------------------------------------------------------------

function ttyIo(): ProbeIo {
	return {
		stdin: { isTTY: true } as ProbeIo["stdin"],
		stdout: { isTTY: true } as ProbeIo["stdout"],
	};
}

function pipedIo(): ProbeIo {
	return {
		stdin: { isTTY: false } as ProbeIo["stdin"],
		stdout: { isTTY: false } as ProbeIo["stdout"],
	};
}

type DetectOverrides = {
	agentMode?: boolean;
	env?: Record<string, string>;
	io?: ProbeIo;
	debug?: boolean;
	probe?: ThemeProbe;
};

async function detect(args: string[], overrides: DetectOverrides = {}) {
	const stderrWrites: string[] = [];
	const probe = overrides.probe ?? probeReturning(null);
	const result = await detectThemeAtStartup(args, {
		agentMode: false,
		env: {},
		io: pipedIo(),
		debug: true,
		...overrides,
		probe,
		stderr: {
			write: ((chunk: string | Uint8Array) => {
				stderrWrites.push(String(chunk));
				return true;
			}) as unknown as NodeJS.WriteStream["write"],
		},
	});
	return { ...result, stderrWrites, probe };
}

describe("detectThemeAtStartup (black box) — diagnostics never touch stdout (FR4)", () => {
	afterEach(() => {
		applyTheme("dark");
		applyAnsiTheme("dark");
	});

	it("CH-39/40: the non-interactive default line goes to stderr only; process.stdout and console.log stay untouched", async () => {
		const out = spyOn(process.stdout, "write").mockImplementation(() => true);
		const log = spyOn(console, "log").mockImplementation(() => {});
		try {
			const { theme, stderrWrites } = await detect(["ui"], {
				agentMode: true,
				io: pipedIo(),
				debug: true,
			});

			expect(theme.mode).toBe("dark");
			expect(theme.source).toBe("default");
			expect(stderrWrites.length).toBe(1);
			expect(stderrWrites[0]).toMatch(/theme defaulted to dark/);
			expect(out.mock.calls.length).toBe(0);
			expect(log.mock.calls.length).toBe(0);
		} finally {
			out.mockRestore();
			log.mockRestore();
		}
	});

	it("CH-41: the interactive default line names MNEMEX_THEME as the way to skip detection, stdout untouched", async () => {
		const out = spyOn(process.stdout, "write").mockImplementation(() => true);
		try {
			const { theme, stderrWrites } = await detect(["ui"], {
				io: ttyIo(),
				debug: true,
			});

			expect(theme.source).toBe("default");
			expect(stderrWrites.length).toBe(1);
			expect(stderrWrites[0]).toMatch(/theme not detected/);
			expect(stderrWrites[0]).toContain("MNEMEX_THEME");
			expect(out.mock.calls.length).toBe(0);
		} finally {
			out.mockRestore();
		}
	});

	it("CH-42: each diagnostic is one newline-terminated line with no ANSI escapes", async () => {
		const nonInteractive = await detect(["ui"], {
			agentMode: true,
			io: pipedIo(),
			debug: true,
		});
		const interactive = await detect(["ui"], {
			io: ttyIo(),
			debug: true,
		});

		for (const line of [
			nonInteractive.stderrWrites[0],
			interactive.stderrWrites[0],
		]) {
			expect(line).toBeDefined();
			expect(line.endsWith("\n")).toBe(true);
			expect(line.slice(0, -1)).not.toContain("\n");
			expect(line).not.toContain(`${ESC}[`);
		}
	});

	it("CH-38: with debug off, neither default path writes anything", async () => {
		const nonInteractive = await detect([], {
			agentMode: true,
			io: pipedIo(),
			debug: false,
		});
		const interactive = await detect(["ui"], {
			io: ttyIo(),
			debug: false,
		});

		expect(nonInteractive.theme.source).toBe("default");
		expect(interactive.theme.source).toBe("default");
		expect(nonInteractive.stderrWrites.length).toBe(0);
		expect(interactive.stderrWrites.length).toBe(0);
	});
});

describe("detectThemeAtStartup (black box) — the FR6 gate keeps args and never probes", () => {
	afterEach(() => {
		applyTheme("dark");
		applyAnsiTheme("dark");
	});

	it("CH-44: `rg` args are returned untouched and the probe is not invoked", async () => {
		const { args, theme, probe } = await detect(["rg", "pattern", "-n"], {
			io: ttyIo(),
		});

		expect(args).toEqual(["rg", "pattern", "-n"]);
		expect(theme.mode).toBe("dark");
		expect(theme.source).toBe("default");
		expect(probe.mock.calls.length).toBe(0);
	});

	it("CH-45: flag before `rg` is stripped, answers, and rg keeps its own args", async () => {
		const { args, theme, probe } = await detect(
			["--theme", "light", "rg", "x"],
			{ io: ttyIo() },
		);

		expect(theme.mode).toBe("light");
		expect(theme.source).toBe("flag");
		expect(args).toEqual(["rg", "x"]);
		expect(probe.mock.calls.length).toBe(0);
	});

	it("CH-50: `ui` with both streams TTY probes (the TUI needs the answer)", async () => {
		const { probe } = await detect(["ui"], { io: ttyIo() });

		expect(probe.mock.calls.length).toBe(1);
	});

	for (const cmd of ["search", "index", "watch"]) {
		it(`CH-51: \`${cmd}\` with both streams TTY never probes (SIGTTOU on a backgrounded job)`, async () => {
			const { theme, probe } = await detect([cmd, "x"], { io: ttyIo() });

			expect(probe.mock.calls.length).toBe(0);
			expect(theme.source).toBe("default");
		});
	}

	it("CH-48: a TTY stdout with a non-TTY stdin never probes", async () => {
		const { theme, probe } = await detect(["ui"], {
			io: { stdin: pipedIo().stdin, stdout: ttyIo().stdout },
		});

		expect(probe.mock.calls.length).toBe(0);
		expect(theme.source).toBe("default");
	});

	it("CH-49: an empty argv (bare `mnemex`) prints help, so it never probes and is returned untouched", async () => {
		const { args, theme, probe } = await detect([], { io: ttyIo() });

		expect(args).toEqual([]);
		expect(probe.mock.calls.length).toBe(0);
		expect(theme.source).toBe("default");
		expect(theme.mode).toBe("dark");
	});

	it("CH-46: agent mode with a TTY still resolves from env (env-only, not forced dark)", async () => {
		const { theme, probe } = await detect(["ui"], {
			io: ttyIo(),
			agentMode: true,
			env: { COLORFGBG: "0;15" },
		});

		expect(theme.mode).toBe("light");
		expect(theme.source).toBe("colorfgbg");
		expect(probe.mock.calls.length).toBe(0);
	});

	it("CH-52/53: getTheme() agrees with the last returned resolution and has the contract shape", async () => {
		const first = await detect(["--theme=light", "ui"], {});
		expect(getTheme()).toEqual(first.theme);

		const second = await detect(["--theme=dark", "ui"], {});
		const current = getTheme();

		expect(current).toEqual(second.theme);
		expect(["light", "dark"]).toContain(current.mode);
		expect([
			"flag",
			"env",
			"term-theme",
			"osc11",
			"colorfgbg",
			"default",
		]).toContain(current.source);
		expect(Array.isArray(current.argv)).toBe(true);
		expect(current.argv).toEqual(["ui"]);
	});
});

// ---------------------------------------------------------------------------
// parseThemeWord
// ---------------------------------------------------------------------------

describe("parseThemeWord (black box)", () => {
	it("PW-04: a trailing newline (shell export typo) is trimmed", () => {
		expect(parseThemeWord("light\n")).toBe("light");
		expect(parseThemeWord("dark\r\n")).toBe("dark");
	});

	it("PW-05: no substring matching", () => {
		expect(parseThemeWord("lightdark")).toBeNull();
		expect(parseThemeWord("light,dark")).toBeNull();
		expect(parseThemeWord("dark;light")).toBeNull();
		expect(parseThemeWord("darker")).toBeNull();
	});
});

// ---------------------------------------------------------------------------
// parseThemeFlag
// ---------------------------------------------------------------------------

describe("parseThemeFlag (black box)", () => {
	it("PF-07: `--theme --agent` does not consume the next flag as the theme word", () => {
		expect(() => parseThemeFlag(["--theme", "--agent"])).toThrow(
			ThemeFlagError,
		);
	});

	it("PF-08: other flags survive the strip in their original order", () => {
		expect(parseThemeFlag(["--theme=light", "--agent", "ui"])).toEqual({
			mode: "light",
			rest: ["--agent", "ui"],
		});
		expect(
			parseThemeFlag(["--agent", "ui", "--theme", "dark", "--json"]),
		).toEqual({
			mode: "dark",
			rest: ["--agent", "ui", "--json"],
		});
	});

	it("PF-09: prefix must not match (`--themes=light`, `--theme-x`)", () => {
		expect(parseThemeFlag(["--themes=light"])).toEqual({
			mode: null,
			rest: ["--themes=light"],
		});
		expect(parseThemeFlag(["--theme-x", "ui"])).toEqual({
			mode: null,
			rest: ["--theme-x", "ui"],
		});
	});

	it("PF-10: a repeated flag leaves no --theme token behind", () => {
		const { mode, rest } = parseThemeFlag(["--theme=light", "--theme=dark"]);
		expect(["light", "dark"]).toContain(mode);
		expect(rest).toEqual([]);
	});

	it("PF-11: input argv is not mutated; rest is a new array", () => {
		const frozen = Object.freeze(["--theme=light", "x"]);
		const { mode, rest } = parseThemeFlag(frozen);

		expect(mode).toBe("light");
		expect(rest).toEqual(["x"]);
		expect(rest).not.toBe(frozen);
		expect(frozen).toEqual(["--theme=light", "x"]);

		const noFlag = Object.freeze(["ui", "--agent"]);
		const passthrough = parseThemeFlag(noFlag);
		expect(passthrough.rest).toEqual(["ui", "--agent"]);
		expect(passthrough.rest).not.toBe(noFlag);
	});

	it("PF-05: empty argv", () => {
		expect(parseThemeFlag([])).toEqual({ mode: null, rest: [] });
	});
});

// ---------------------------------------------------------------------------
// parseColorFgBg
// ---------------------------------------------------------------------------

describe("parseColorFgBg (black box)", () => {
	describe("PC-06: full background sweep 0–15 (FR1.5)", () => {
		for (let bg = 0; bg <= 15; bg++) {
			const expected: ThemeMode = bg <= 6 || bg === 8 ? "dark" : "light";
			it(`"0;${bg}" → ${expected}`, () => {
				expect(parseColorFgBg(`0;${bg}`)).toBe(expected);
			});
		}
	});

	describe("PC-07: malformed background fields are no opinion", () => {
		for (const value of ["0;-1", "0;1.5", "0;", ";", "0;15;", "0;0x7"]) {
			it(`${JSON.stringify(value)} → null`, () => {
				expect(parseColorFgBg(value)).toBeNull();
			});
		}
	});

	it("PC-08: rxvt's `default;default` is no opinion", () => {
		expect(parseColorFgBg("default;default")).toBeNull();
		expect(parseColorFgBg("default;0;default")).toBeNull();
	});

	it("PC-09: whitespace around the value must never yield the wrong answer", () => {
		expect(parseColorFgBg(" 0;15 ")).not.toBe("dark");
		expect(parseColorFgBg(" 15;0 ")).not.toBe("light");
	});

	test.todo(
		"PC-07 single field: is `COLORFGBG=15` a background (light) or malformed (null)? FR1.5 only specifies `fg;bg` and `fg;x;bg`.",
	);
});

// ---------------------------------------------------------------------------
// parseOsc11Reply
// ---------------------------------------------------------------------------

describe("parseOsc11Reply (black box)", () => {
	it("PO-10: components scale, not truncate — 8000/ffff is ~0.5", () => {
		const rgb = parseOsc11Reply(`${ESC}]11;rgb:8000/8000/8000${BEL}`);
		expect(rgb).not.toBeNull();
		if (!rgb) return;
		expect(rgb.r).toBeCloseTo(0.5, 3);
		expect(rgb.g).toBeCloseTo(0.5, 3);
		expect(rgb.b).toBeCloseTo(0.5, 3);
	});

	it("PO-11: mixed digit widths scale per component", () => {
		const rgb = parseOsc11Reply(`${ESC}]11;rgb:ff/ffff/f${BEL}`);
		expect(rgb).not.toBeNull();
		if (!rgb) return;
		expect(rgb.r).toBeCloseTo(1, 9);
		expect(rgb.g).toBeCloseTo(1, 9);
		expect(rgb.b).toBeCloseTo(1, 9);
	});

	it("PO-15: non-hex digits are rejected", () => {
		expect(parseOsc11Reply(`${ESC}]11;rgb:gggg/0000/0000${BEL}`)).toBeNull();
		expect(parseOsc11Reply(`${ESC}]11;rgb:zz/zz/zz${BEL}`)).toBeNull();
	});

	it("PO-07: too few components is a partial reply", () => {
		expect(parseOsc11Reply(`${ESC}]11;rgb:ffff/ffff${BEL}`)).toBeNull();
	});

	it("PO-12: an upper-case `RGB:` keyword must never decode to a wrong colour", () => {
		const rgb = parseOsc11Reply(`${ESC}]11;RGB:FFFF/FFFF/FFFF${BEL}`);
		if (rgb !== null) {
			expect(rgb.r).toBeCloseTo(1, 5);
			expect(rgb.g).toBeCloseTo(1, 5);
			expect(rgb.b).toBeCloseTo(1, 5);
		}
	});

	test.todo(
		"PO-12: should the `RGB:` keyword be accepted case-insensitively, or only the hex digits? The contract regex has the /i flag but the spec text does not say.",
	);

	test.todo(
		"PO-14: `ESC ] 11 ; #ffffff BEL` (some terminals answer in #rrggbb form) — unsupported per architecture, but should it be null or parsed?",
	);
});

// ---------------------------------------------------------------------------
// classifyLuminance
// ---------------------------------------------------------------------------

describe("classifyLuminance (black box)", () => {
	function hex(h: string): Rgb {
		const n = Number.parseInt(h.replace("#", ""), 16);
		return {
			r: ((n >> 16) & 0xff) / 255,
			g: ((n >> 8) & 0xff) / 255,
			b: (n & 0xff) / 255,
		};
	}

	describe("PL-06: common dark backgrounds", () => {
		for (const h of ["#1E1E1E", "#000080", "#2E3440", "#24292E"]) {
			it(`${h} → dark`, () => {
				expect(classifyLuminance(hex(h))).toBe("dark");
			});
		}
	});

	describe("PL-07: common light backgrounds", () => {
		for (const h of ["#F5F5F5", "#FFFFE0", "#E0E0E0", "#FAFAFA"]) {
			it(`${h} → light`, () => {
				expect(classifyLuminance(hex(h))).toBe("light");
			});
		}
	});

	it("PL-08: channels are weighted — pure green is light, pure blue is dark", () => {
		expect(classifyLuminance({ r: 0, g: 1, b: 0 })).toBe("light");
		expect(classifyLuminance({ r: 0, g: 0, b: 1 })).toBe("dark");
	});

	it("PL-09: mid-grey boundary at the 16-bit values a terminal actually sends", () => {
		// rgb:8000/8000/8000 is the first grey a 16-bit terminal reports above
		// the midpoint; rgb:7fff/7fff/7fff is the last one below it. Exact 0.5 is
		// not asserted: a weighted sum of three 0.5s rounds to 0.49999999999999994.
		const above = 0x8000 / 0xffff;
		const below = 0x7fff / 0xffff;
		expect(classifyLuminance({ r: above, g: above, b: above })).toBe("light");
		expect(classifyLuminance({ r: below, g: below, b: below })).toBe("dark");
		expect(classifyLuminance({ r: 0.49, g: 0.49, b: 0.49 })).toBe("dark");
		expect(classifyLuminance({ r: 0.51, g: 0.51, b: 0.51 })).toBe("light");
	});
});
