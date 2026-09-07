/**
 * The theme resolution chain (architecture §6, rows 1–10; AC 1–9, FR4, FR6).
 *
 * Every test injects `argv`, `env`, `interactive` and a `probe` spy, so none
 * of them needs a terminal. Where the requirement is "the probe is never
 * invoked" (AC 3, AC 5) the assertion is on the spy's call count, not just on
 * the returned mode — a chain that called the probe and then ignored its
 * answer would still return the right mode, and that is exactly the bug FR2
 * and FR6 forbid.
 */

import { afterEach, describe, expect, it, mock } from "bun:test";
import { applyTheme, theme } from "../../../src/tui/theme.js";
import { applyAnsiTheme, colors } from "../../../src/ui/colors.js";
import {
	type DetectOptions,
	detectThemeAtStartup,
	getTheme,
	type ProbeIo,
	type ResolveThemeInput,
	resolveTheme,
	ThemeFlagError,
	type ThemeMode,
	type ThemeProbe,
} from "../../../src/ui/theme-detect.js";
import { captureThemeEnv, type ThemeEnv } from "../../../src/ui/theme-env.js";

/** A probe spy that answers `reply`; tests read `.mock.calls.length`. */
function probeReturning(reply: ThemeMode | null) {
	return mock<ThemeProbe>(() => Promise.resolve(reply));
}

function input(overrides: Partial<ResolveThemeInput>): ResolveThemeInput {
	return {
		argv: [],
		env: {},
		interactive: true,
		probe: probeReturning(null),
		...overrides,
	};
}

describe("resolveTheme — the chain", () => {
	it("1. --theme=light beats MNEMEX_THEME, TERM_THEME, COLORFGBG and the probe (AC 1)", async () => {
		const probe = probeReturning("dark");
		const env: ThemeEnv = {
			MNEMEX_THEME: "dark",
			TERM_THEME: "dark",
			COLORFGBG: "15;0",
		};

		const result = await resolveTheme(
			input({
				argv: ["--theme=light", "status"],
				env,
				interactive: true,
				probe,
			}),
		);

		expect(result.mode).toBe("light");
		expect(result.source).toBe("flag");
		expect(result.argv).toEqual(["status"]);
		expect(probe.mock.calls.length).toBe(0);
	});

	it("1b. --theme light (space form) is equivalent to --theme=light", async () => {
		const probe = probeReturning("dark");
		const env: ThemeEnv = {
			MNEMEX_THEME: "dark",
			TERM_THEME: "dark",
			COLORFGBG: "15;0",
		};

		const result = await resolveTheme(
			input({
				argv: ["--theme", "light", "status"],
				env,
				interactive: true,
				probe,
			}),
		);

		expect(result.mode).toBe("light");
		expect(result.source).toBe("flag");
		expect(result.argv).toEqual(["status"]);
		expect(probe.mock.calls.length).toBe(0);
	});

	it("1c. --theme=blue throws ThemeFlagError (fail fast on a user typo)", async () => {
		await expect(
			resolveTheme(input({ argv: ["--theme=blue"] })),
		).rejects.toBeInstanceOf(ThemeFlagError);
		await expect(
			resolveTheme(input({ argv: ["status", "--theme"] })),
		).rejects.toBeInstanceOf(ThemeFlagError);
	});

	it("2. MNEMEX_THEME=light beats TERM_THEME=dark (AC 2)", async () => {
		const result = await resolveTheme(
			input({ env: { MNEMEX_THEME: "light", TERM_THEME: "dark" } }),
		);

		expect(result.mode).toBe("light");
		expect(result.source).toBe("env");
	});

	it("3. TERM_THEME=light beats a probe that would answer dark, and the probe is never invoked (AC 3 / FR2)", async () => {
		const probe = probeReturning("dark");

		const result = await resolveTheme(
			input({ env: { TERM_THEME: "light" }, interactive: true, probe }),
		);

		expect(result.mode).toBe("light");
		expect(result.source).toBe("term-theme");
		expect(probe.mock.calls.length).toBe(0);
	});

	describe("4. TERM_THEME values that are not exactly light/dark fall through (AC 4)", () => {
		for (const value of ["auto", "", "blue"]) {
			it(`TERM_THEME=${JSON.stringify(value)} has no opinion; the probe runs`, async () => {
				const probe = probeReturning("light");

				const result = await resolveTheme(
					input({ env: { TERM_THEME: value }, interactive: true, probe }),
				);

				// If "auto" had been read as dark the source would be term-theme.
				expect(result.source).toBe("osc11");
				expect(result.mode).toBe("light");
				expect(probe.mock.calls.length).toBe(1);
			});
		}

		it('TERM_THEME="Light " (case + whitespace) resolves light without probing', async () => {
			const probe = probeReturning("dark");

			const result = await resolveTheme(
				input({ env: { TERM_THEME: "Light " }, interactive: true, probe }),
			);

			expect(result.mode).toBe("light");
			expect(result.source).toBe("term-theme");
			expect(probe.mock.calls.length).toBe(0);
		});
	});

	it("5. no env + non-interactive: probe not invoked, result dark/default (AC 5 / FR6)", async () => {
		const probe = probeReturning("light");

		const result = await resolveTheme(
			input({ env: {}, interactive: false, probe }),
		);

		expect(result.mode).toBe("dark");
		expect(result.source).toBe("default");
		expect(probe.mock.calls.length).toBe(0);
	});

	describe("6. no env + interactive: the probe decides (AC 6)", () => {
		it("6a. probe → light (rgb:ffff/ffff/ffff) yields light via osc11", async () => {
			const probe = probeReturning("light");

			const result = await resolveTheme(
				input({ env: {}, interactive: true, probe }),
			);

			expect(result.mode).toBe("light");
			expect(result.source).toBe("osc11");
			expect(probe.mock.calls.length).toBe(1);
		});

		it("6b. probe → dark (rgb:0000/0000/0000) yields dark via osc11", async () => {
			const probe = probeReturning("dark");

			const result = await resolveTheme(
				input({ env: {}, interactive: true, probe }),
			);

			expect(result.mode).toBe("dark");
			expect(result.source).toBe("osc11");
			expect(probe.mock.calls.length).toBe(1);
		});

		it("6c. probe timeout (null) falls through to COLORFGBG", async () => {
			const probe = probeReturning(null);

			const result = await resolveTheme(
				input({ env: { COLORFGBG: "0;15" }, interactive: true, probe }),
			);

			expect(result.mode).toBe("light");
			expect(result.source).toBe("colorfgbg");
			expect(probe.mock.calls.length).toBe(1);
		});

		it("6d. a probe that rejects is treated as null and the chain continues", async () => {
			const probe = mock<ThemeProbe>(() =>
				Promise.reject(new Error("tty exploded")),
			);

			const result = await resolveTheme(
				input({ env: { COLORFGBG: "0;15" }, interactive: true, probe }),
			);

			expect(result.mode).toBe("light");
			expect(result.source).toBe("colorfgbg");
			expect(probe.mock.calls.length).toBe(1);
		});

		it("6d'. a probe that throws synchronously is also swallowed", async () => {
			const probe = mock<ThemeProbe>(() => {
				throw new Error("sync throw");
			});

			const result = await resolveTheme(
				input({ env: {}, interactive: true, probe }),
			);

			expect(result.mode).toBe("dark");
			expect(result.source).toBe("default");
		});
	});

	describe("7. COLORFGBG (AC 7)", () => {
		const cases: Array<[string, ThemeMode, string]> = [
			["0;15", "light", "colorfgbg"],
			["15;0", "dark", "colorfgbg"],
			["0;0;7", "light", "colorfgbg"],
			["garbage", "dark", "default"],
		];

		for (const [value, mode, source] of cases) {
			it(`COLORFGBG=${value} → ${mode} (${source})`, async () => {
				const result = await resolveTheme(
					input({ env: { COLORFGBG: value }, interactive: false }),
				);

				expect(result.mode).toBe(mode);
				expect(result.source).toBe(source);
			});
		}
	});

	it("8. a snapshot taken before dotenv injects TERM_THEME is unaffected by the injection (AC 8 / FR3)", async () => {
		// A stand-in for process.env: empty at startup, mutated later by dotenv.
		const proc: NodeJS.ProcessEnv = {};
		const snapshot = captureThemeEnv(proc);

		// What dotenv.config() does to process.env when ./.env has TERM_THEME=light.
		proc.TERM_THEME = "light";

		const withSnapshot = await resolveTheme(
			input({ env: snapshot, interactive: false }),
		);
		expect(withSnapshot.mode).toBe("dark");
		expect(withSnapshot.source).toBe("default");

		// Negative control: capturing AFTER the injection does see it, which
		// proves the snapshot (not some other rule) is what kept it out above.
		const late = captureThemeEnv(proc);
		const withLateCapture = await resolveTheme(
			input({ env: late, interactive: false }),
		);
		expect(withLateCapture.mode).toBe("light");
		expect(withLateCapture.source).toBe("term-theme");
	});

	it("argv is returned untouched when no --theme flag is present", async () => {
		const argv = ["search", "--limit", "5", "query"];

		const result = await resolveTheme(input({ argv, interactive: false }));

		expect(result.argv).toEqual(argv);
	});
});

describe("captureThemeEnv", () => {
	it("copies only the four theme keys and freezes the result", () => {
		const snapshot = captureThemeEnv({
			MNEMEX_THEME: "light",
			TERM_THEME: "dark",
			COLORFGBG: "0;15",
			TERM: "xterm-256color",
			MNEMEX_MODEL: "not-a-theme-key",
			HOME: "/nowhere",
		});

		expect(snapshot).toEqual({
			MNEMEX_THEME: "light",
			TERM_THEME: "dark",
			COLORFGBG: "0;15",
			TERM: "xterm-256color",
		});
		expect(Object.isFrozen(snapshot)).toBe(true);
	});

	it("omits keys that are unset rather than storing undefined", () => {
		const snapshot = captureThemeEnv({ TERM: "dumb" });

		expect(Object.keys(snapshot)).toEqual(["TERM"]);
		expect("TERM_THEME" in snapshot).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// detectThemeAtStartup — the startup glue (architecture §6, rows 9–10)
// ---------------------------------------------------------------------------

/** Both streams reported as TTYs; the probe is injected so nothing is written. */
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

/** A stderr spy; `.mock.calls` is the list of writes. */
function stderrSpy() {
	return mock<(chunk: string | Uint8Array) => boolean>(() => true);
}

async function detect(
	args: string[],
	overrides: Partial<DetectOptions> & { agentMode?: boolean },
) {
	const stderr = stderrSpy();
	const probe = overrides.probe ?? probeReturning(null);
	const result = await detectThemeAtStartup(args, {
		agentMode: false,
		env: {},
		io: pipedIo(),
		debug: true,
		...overrides,
		probe,
		stderr: { write: stderr as unknown as NodeJS.WriteStream["write"] },
	});
	return { ...result, stderr, probe };
}

describe("detectThemeAtStartup — diagnostics (row 9; AC 9 / FR4)", () => {
	// The glue mutates the shared palettes; put them back so the palette
	// tests' import-time snapshots and byte-identity checks stay meaningful.
	afterEach(() => {
		applyTheme("dark");
		applyAnsiTheme("dark");
	});

	const answering: Array<{
		name: string;
		args: string[];
		opts: Partial<DetectOptions>;
	}> = [
		{ name: "flag", args: ["--theme=light", "status"], opts: {} },
		{ name: "env", args: ["status"], opts: { env: { MNEMEX_THEME: "light" } } },
		{
			name: "term-theme",
			args: ["status"],
			opts: { env: { TERM_THEME: "light" } },
		},
		{
			name: "osc11",
			args: ["status"],
			opts: { io: ttyIo(), probe: probeReturning("light") },
		},
		{
			name: "colorfgbg",
			args: ["status"],
			opts: { env: { COLORFGBG: "0;15" } },
		},
	];

	for (const { name, args, opts } of answering) {
		it(`writes nothing to stderr when '${name}' answered, even with MNEMEX_DEBUG`, async () => {
			const { theme: resolved, stderr } = await detect(args, {
				debug: true,
				...opts,
			});

			expect(resolved.source).toBe(name);
			expect(resolved.mode).toBe("light");
			expect(stderr.mock.calls.length).toBe(0);
		});
	}

	it("default + interactive + MNEMEX_DEBUG: exactly one 'theme not detected' line", async () => {
		const {
			theme: resolved,
			stderr,
			probe,
		} = await detect(["status"], {
			io: ttyIo(),
			debug: true,
		});

		expect(resolved.source).toBe("default");
		expect(probe.mock.calls.length).toBe(1);
		expect(stderr.mock.calls.length).toBe(1);
		expect(String(stderr.mock.calls[0][0])).toContain("theme not detected");
	});

	it("default + non-interactive + MNEMEX_DEBUG: exactly one 'theme defaulted to dark' line", async () => {
		const {
			theme: resolved,
			stderr,
			probe,
		} = await detect(["status"], {
			io: pipedIo(),
			debug: true,
		});

		expect(resolved.source).toBe("default");
		expect(probe.mock.calls.length).toBe(0);
		expect(stderr.mock.calls.length).toBe(1);
		expect(String(stderr.mock.calls[0][0])).toContain(
			"theme defaulted to dark",
		);
	});

	it("default without MNEMEX_DEBUG: zero writes", async () => {
		const { theme: resolved, stderr } = await detect(["status"], {
			io: ttyIo(),
			debug: false,
		});

		expect(resolved.source).toBe("default");
		expect(stderr.mock.calls.length).toBe(0);
	});

	it("applies the resolved mode to both palettes and records it for getTheme()", async () => {
		const darkText = theme.text;
		const darkGreen = colors.green;

		const { theme: resolved } = await detect(["--theme=light", "status"], {});

		expect(resolved.mode).toBe("light");
		expect(getTheme()).toBe(resolved);
		expect(theme.text).not.toBe(darkText);
		expect(colors.green).not.toBe(darkGreen);

		await detect(["--theme=dark", "status"], {});
		expect(theme.text).toBe(darkText);
		expect(colors.green).toBe(darkGreen);
	});
});

describe("detectThemeAtStartup — the FR6 gate (row 10)", () => {
	afterEach(() => {
		applyTheme("dark");
		applyAnsiTheme("dark");
	});

	it("flag answers first: --theme=light with a TTY never reaches the probe, and rg keeps its args", async () => {
		const {
			args,
			theme: resolved,
			probe,
		} = await detect(["--theme=light", "rg", "x"], { io: ttyIo() });

		expect(resolved.source).toBe("flag");
		expect(args).toEqual(["rg", "x"]);
		expect(probe.mock.calls.length).toBe(0);
	});

	it("rg gate: `rg` with a TTY and no env never probes (stdout is ripgrep's)", async () => {
		const { theme: resolved, probe } = await detect(["rg", "pattern"], {
			io: ttyIo(),
		});

		expect(resolved.source).toBe("default");
		expect(resolved.mode).toBe("dark");
		expect(probe.mock.calls.length).toBe(0);
	});

	for (const flag of ["--help", "-h", "--version"]) {
		it(`${flag} gate: exits before any colour, so never probes`, async () => {
			const { probe } = await detect([flag], { io: ttyIo() });

			expect(probe.mock.calls.length).toBe(0);
		});
	}

	it("bare argv gate: empty args print help (runCli's `!command`), so never probes", async () => {
		const { args, probe } = await detect([], { io: ttyIo() });

		expect(args).toEqual([]);
		expect(probe.mock.calls.length).toBe(0);
	});

	it("agent mode never probes even on a TTY", async () => {
		const { probe } = await detect(["status"], {
			io: ttyIo(),
			agentMode: true,
		});

		expect(probe.mock.calls.length).toBe(0);
	});

	it("TERM=dumb from the startup snapshot never probes", async () => {
		const { probe } = await detect(["status"], {
			io: ttyIo(),
			env: { TERM: "dumb" },
		});

		expect(probe.mock.calls.length).toBe(0);
	});

	it("a piped stdout never probes; a TTY on both ends does", async () => {
		const piped = await detect(["status"], {
			io: { stdin: ttyIo().stdin, stdout: pipedIo().stdout },
		});
		expect(piped.probe.mock.calls.length).toBe(0);

		const tty = await detect(["status"], { io: ttyIo() });
		expect(tty.probe.mock.calls.length).toBe(1);
	});

	it("a bad --theme value throws ThemeFlagError before anything is applied", async () => {
		await expect(
			detect(["--theme=blue", "status"], { io: ttyIo() }),
		).rejects.toBeInstanceOf(ThemeFlagError);
	});
});
