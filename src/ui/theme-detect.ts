/**
 * Terminal theme (light / dark) resolution.
 *
 * The theme is picked exactly once per process, before any coloured byte is
 * written, from an ordered list of sources where the first one with an opinion
 * wins:
 *
 *   flag (--theme) → MNEMEX_THEME → TERM_THEME → OSC 11 probe → COLORFGBG → dark
 *
 * The resolver is a chain of responsibility in function form: `CHAIN` below is
 * the single place the order is declared, each handler either answers a
 * `ThemeMode` or passes with `null`, and the last handler always answers so a
 * request cannot fall off the end. The result carries the `source` that
 * answered, which is what tests and `MNEMEX_DEBUG` use to name the handler.
 *
 * Rules that shaped this module:
 *  - TERM_THEME beats the probe and SKIPS it: the chain awaits handlers one at
 *    a time, so the probe is never even called when an earlier source answered.
 *    A `probe` spy in the tests proves this, not just the returned mode.
 *  - Only `light` and `dark` count for env values. `auto`, empty, or anything
 *    else means "no opinion" and falls through — it must NOT be read as dark.
 *    The CLI flag is stricter and throws on a bad value: a typo on the command
 *    line is a user error to report, a stale export is not worth bricking the
 *    CLI over.
 *  - The env comes from `theme-env.ts` (a pre-dotenv snapshot), never from
 *    `process.env` directly, so a `.env` file cannot supply the theme.
 *  - The probe can never take the chain down: its contract says it must not
 *    throw, and the loop enforces that contract with a try/catch anyway.
 *  - The probe is only reached when `interactive` is true, which the caller
 *    computes from agent mode, both TTYs, TERM, the `rg` command and
 *    help/version. In any mode whose stdout is a protocol nothing is written
 *    to the terminal.
 *
 * `probeTerminalBackground` is the one impure function here: it talks to the
 * tty and restores it on every path (see its doc comment). `detectThemeAtStartup`
 * is the startup glue: flag strip, FR6 gate, resolve, apply both palettes,
 * debug line. Everything else is pure and testable without a terminal.
 */

import { applyTheme } from "../tui/theme.js";
import { applyAnsiTheme } from "./colors.js";
import { getStartupEnv, type ThemeEnv, type ThemeMode } from "./theme-env.js";

export type { ThemeMode } from "./theme-env.js";

/** Which handler in the chain answered. The order here IS the resolution order. */
export type ThemeSource =
	| "flag" // --theme=light|dark
	| "env" // MNEMEX_THEME
	| "term-theme" // TERM_THEME
	| "osc11" // terminal replied to ESC ] 11 ; ? BEL
	| "colorfgbg" // COLORFGBG
	| "default"; // fell off the end → dark

export interface ThemeResolution {
	readonly mode: ThemeMode;
	readonly source: ThemeSource;
	/** argv with --theme stripped; identical to the input argv when no flag was present. */
	readonly argv: readonly string[];
}

/** Returns a mode, or null for "no opinion / no reply / not supported". Must never throw. */
export type ThemeProbe = () => Promise<ThemeMode | null>;

export interface ResolveThemeInput {
	readonly argv: readonly string[];
	/** From theme-env.ts, never process.env directly (FR3). */
	readonly env: ThemeEnv;
	/**
	 * true only when stdin AND stdout are TTYs, not agent mode, TERM != dumb,
	 * command != rg, and not --help/--version. Gates the probe (FR6).
	 */
	readonly interactive: boolean;
	readonly probe: ThemeProbe;
}

/** Thrown by `parseThemeFlag` for `--theme` with a missing or unrecognised value. */
export class ThemeFlagError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ThemeFlagError";
	}
}

/** Colour components in 0..1. */
export interface Rgb {
	readonly r: number;
	readonly g: number;
	readonly b: number;
}

export interface ProbeIo {
	stdin: NodeJS.ReadStream & {
		isTTY?: boolean;
		isRaw?: boolean;
		setRawMode?: (raw: boolean) => unknown;
	};
	stdout: NodeJS.WriteStream & { isTTY?: boolean };
}

/**
 * Upper bound on the OSC 11 wait. Local terminals answer in single-digit
 * milliseconds and a transcontinental SSH hop in 100–150 ms; with the DA1
 * sentinel this is only paid in full when the terminal answers nothing at all.
 */
export const OSC11_PROBE_TIMEOUT_MS = 200;

// ---------------------------------------------------------------------------
// Parsers (pure)
// ---------------------------------------------------------------------------

/**
 * Trim + lowercase; only the exact words `light` and `dark` count. Anything
 * else — `auto`, empty, `blue`, undefined — is "no opinion" (null), never dark.
 */
export function parseThemeWord(value: string | undefined): ThemeMode | null {
	const word = value?.trim().toLowerCase();
	if (word === "light" || word === "dark") return word;
	return null;
}

/**
 * Strip `--theme=X` / `--theme X` from any argv position and return the mode
 * plus the remaining argv. A bare `--theme` or a value that is not light/dark
 * throws `ThemeFlagError`. Stripping from every position mirrors how `--agent`
 * is handled today; ripgrep has no `--theme` option, so `rg` needs no special
 * case.
 */
export function parseThemeFlag(argv: readonly string[]): {
	mode: ThemeMode | null;
	rest: string[];
} {
	let mode: ThemeMode | null = null;
	const rest: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		let raw: string | undefined;

		if (arg === "--theme") {
			raw = argv[i + 1];
			if (raw === undefined) {
				throw new ThemeFlagError("--theme expects light or dark");
			}
			i++;
		} else if (arg.startsWith("--theme=")) {
			raw = arg.slice("--theme=".length);
		} else {
			rest.push(arg);
			continue;
		}

		const parsed = parseThemeWord(raw);
		if (parsed === null) {
			throw new ThemeFlagError(`--theme expects light or dark, got '${raw}'`);
		}
		mode = parsed;
	}

	return { mode, rest };
}

/**
 * `COLORFGBG` is `fg;bg` or `fg;x;bg`; the LAST field is the background
 * colour index. 0–6 and 8 are the dark half of the 16-colour palette, 7 and
 * 9–15 the light half. Anything that is not an integer 0–15 is no opinion.
 */
export function parseColorFgBg(value: string | undefined): ThemeMode | null {
	if (value === undefined) return null;
	const fields = value.split(";");
	const last = fields[fields.length - 1]?.trim();
	if (last === undefined || !/^\d{1,2}$/.test(last)) return null;
	const bg = Number.parseInt(last, 10);
	if (bg < 0 || bg > 15) return null;
	if (bg <= 6 || bg === 8) return "dark";
	return "light";
}

/**
 * Find an OSC 11 reply in an accumulated byte buffer. Both terminators (BEL,
 * ST) and the `rgb:` / `rgba:` forms are accepted; each component is scaled
 * by its own digit count, so `ffff/ffff/ffff`, `ff/ff/ff` and `f/f/f` all mean
 * white. Returns null when the pattern is absent so the caller keeps
 * accumulating until timeout. The regex is anchored on the OSC prefix and
 * bounded (`{1,4}`), so there is no ReDoS surface.
 */
const OSC11_REPLY =
	// biome-ignore lint/suspicious/noControlCharactersInRegex: \x1b and \x07 are intentional — this matches the terminal's OSC 11 reply (ESC ] 11 ; rgb:… BEL|ST)
	/\x1b\]11;rgba?:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})(?:\/[0-9a-f]{1,4})?(?:\x07|\x1b\\)/i;

export function parseOsc11Reply(text: string): Rgb | null {
	const match = OSC11_REPLY.exec(text);
	if (!match) return null;
	const scale = (hex: string): number =>
		Number.parseInt(hex, 16) / (16 ** hex.length - 1);
	return { r: scale(match[1]), g: scale(match[2]), b: scale(match[3]) };
}

/**
 * Rec. 601 gamma-space luminance, `< 0.5` → dark. This is the rule Neovim's
 * `background` autodetect and OpenTUI's own `RendererThemeMode` use, so the
 * TUI library's internal notion and ours agree on every background. On a
 * mid-grey it says light, which is the right call for our two text colours.
 */
export function classifyLuminance(rgb: Rgb): ThemeMode {
	const luminance = 0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b;
	return luminance < 0.5 ? "dark" : "light";
}

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

/** The query: OSC 11 "what is your default background?" followed by DA1. */
const OSC11_QUERY = "\x1b]11;?\x07";
const DA1_QUERY = "\x1b[c";
const PROBE_QUERY = `${OSC11_QUERY}${DA1_QUERY}`;

/**
 * DA1 (Primary Device Attributes) reply: `ESC [ ? … c`. Every terminal answers
 * DA1, and answers in order, so if this arrives without an OSC 11 reply in
 * front of it the terminal does not support OSC 11 and the wait can stop now.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: \x1b is intentional — this matches the terminal's DA1 reply (ESC [ ? … c)
const DA1_REPLY = /\x1b\[\?[\d;]*c/;

/** Ctrl-C as a raw byte; the only keystroke acted on during the probe window. */
const ETX = "\x03";

/**
 * OSC 11 query with a bounded wait and guaranteed stdin restore.
 *
 * Writes `ESC ] 11 ; ? BEL` then `ESC [ c` (DA1, the sentinel), puts stdin in
 * raw mode so the reply is neither line-buffered nor echoed, and resolves on
 * the first of: an OSC 11 reply (classified by luminance), a DA1 reply with no
 * OSC 11 in front of it (terminal does not support the query → null), Ctrl-C
 * (restore, then re-raise SIGINT so the default behaviour happens), or the
 * timeout (null).
 *
 * Contract: never throws, never rejects, and on every path — including a
 * `setRawMode` that throws and an EPIPE on stdout — leaves stdin with zero
 * listeners of ours, in its previous raw/cooked state, and paused. That is the
 * state OpenTUI's `createCliRenderer` expects to find, and `pause()` is what
 * lets non-TUI commands exit instead of hanging on an open stdin.
 *
 * Preconditions are checked inside so the function is safe to call blindly:
 * both streams must be TTYs and `setRawMode` must exist, otherwise null with
 * no bytes written. Type-ahead during the window is discarded with the buffer.
 */
export async function probeTerminalBackground(
	io: ProbeIo = { stdin: process.stdin, stdout: process.stdout },
	timeoutMs: number = OSC11_PROBE_TIMEOUT_MS,
): Promise<ThemeMode | null> {
	const { stdin, stdout } = io;
	if (stdin.isTTY !== true || stdout.isTTY !== true) return null;
	if (typeof stdin.setRawMode !== "function") return null;

	return new Promise<ThemeMode | null>((resolve) => {
		const wasRaw = stdin.isRaw === true;
		let done = false;
		let buf = "";
		let timer: ReturnType<typeof setTimeout> | undefined;

		const onData = (chunk: Buffer | string): void => {
			buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");

			const rgb = parseOsc11Reply(buf);
			if (rgb) {
				finish(classifyLuminance(rgb));
				return;
			}
			if (DA1_REPLY.test(buf)) {
				finish(null);
				return;
			}
			if (buf.includes(ETX)) {
				finish(null);
				process.kill(process.pid, "SIGINT");
			}
		};

		// Idempotent; restores BEFORE resolving so no caller ever observes a
		// half-restored stdin. Each restore step is independent of the others.
		const onStdoutError = (): void => finish(null);

		const finish = (result: ThemeMode | null): void => {
			if (done) return;
			done = true;
			if (timer !== undefined) clearTimeout(timer);
			stdin.removeListener("data", onData);
			stdout.removeListener("error", onStdoutError);
			try {
				stdin.setRawMode?.(wasRaw);
			} catch {
				// not a real tty any more (EIO); nothing left to restore
			}
			try {
				stdin.pause();
			} catch {
				// same
			}
			resolve(result);
		};

		try {
			stdin.setRawMode?.(true);
			stdin.resume();
			stdin.on("data", onData);
			timer = setTimeout(() => finish(null), timeoutMs);
			// Write last: if the tty is gone (EPIPE) the callback or the stream's
			// "error" event fires and finish() tears down everything set up above.
			// The "error" listener also keeps an EPIPE from becoming an uncaught
			// exception, which is what an unlistened stream error turns into.
			stdout.once("error", onStdoutError);
			stdout.write(PROBE_QUERY, (err) => {
				if (err) finish(null);
			});
		} catch {
			finish(null);
		}
	});
}

// ---------------------------------------------------------------------------
// Runtime state (FR7 introspection)
// ---------------------------------------------------------------------------

/**
 * The last resolution, written once per process by `detectThemeAtStartup`
 * and read by `getTheme()`. `resolveTheme` itself is pure and does
 * not touch it, so tests can call it freely. Before detection has run this
 * reports the default, which is the palette that would have been applied anyway.
 */
let current: ThemeResolution = { mode: "dark", source: "default", argv: [] };

export function getTheme(): ThemeResolution {
	return current;
}

// ---------------------------------------------------------------------------
// The chain
// ---------------------------------------------------------------------------

type HandlerContext = ResolveThemeInput & { readonly flag: ThemeMode | null };
type Handler = (
	ctx: HandlerContext,
) => ThemeMode | null | Promise<ThemeMode | null>;

/**
 * Declared exactly once, as one literal. Nobody composes it elsewhere; the
 * `ThemeSource` label on each row is what `ThemeResolution.source` reports.
 * The `osc11` row is only reached when nothing before it answered (FR2) and
 * only calls the probe when `interactive` is true (FR6).
 */
const CHAIN: ReadonlyArray<readonly [ThemeSource, Handler]> = [
	["flag", (c) => c.flag],
	["env", (c) => parseThemeWord(c.env.MNEMEX_THEME)],
	["term-theme", (c) => parseThemeWord(c.env.TERM_THEME)],
	["osc11", (c) => (c.interactive ? c.probe() : null)],
	["colorfgbg", (c) => parseColorFgBg(c.env.COLORFGBG)],
	["default", () => "dark"],
];

/**
 * Walk the chain; first answer wins. Sequential `await` in the loop is the
 * point — the probe is only awaited when it is reached. Throws
 * `ThemeFlagError` for a bad `--theme` value; every other failure (a probe
 * that breaks its never-throw contract) is swallowed into "no opinion".
 */
export async function resolveTheme(
	input: ResolveThemeInput,
): Promise<ThemeResolution> {
	const { mode: flag, rest } = parseThemeFlag(input.argv);
	const ctx: HandlerContext = { ...input, flag };

	for (const [source, handler] of CHAIN) {
		let mode: ThemeMode | null = null;
		try {
			mode = await handler(ctx);
		} catch {
			mode = null;
		}
		if (mode) return { mode, source, argv: rest };
	}

	throw new Error("unreachable: default handler always answers");
}

// ---------------------------------------------------------------------------
// Startup glue (called once from runCli)
// ---------------------------------------------------------------------------

export interface DetectOptions {
	/** `--agent` or an auto-detected agent environment: env-only, never probe. */
	readonly agentMode: boolean;
	/**
	 * Test seams. Production callers pass none of these: the env comes from the
	 * pre-dotenv snapshot, the streams are the process's, the probe is the real
	 * OSC 11 query and diagnostics go to `process.stderr`.
	 */
	readonly env?: ThemeEnv;
	readonly io?: ProbeIo;
	readonly probe?: ThemeProbe;
	readonly stderr?: Pick<NodeJS.WriteStream, "write">;
	/** Live `process.env.MNEMEX_DEBUG` by default (same switch `fatal()` uses). */
	readonly debug?: boolean;
}

/** Commands that exit before rendering anything coloured, so a probe is waste. */
const NO_PROBE_ARGS = new Set(["--help", "-h", "--version"]);

/**
 * The only commands that may run the OSC 11 probe: those that open a
 * full-screen TUI (`startTui`, `startMonitor`, `startSetupWizard`,
 * `startAdminTUI` in `src/cli.ts`). `init` is not here — it goes to
 * `handleInit`, not the wizard.
 *
 * Why the list exists: the probe calls `stdin.setRawMode(true)`, which is a
 * tcsetattr on the controlling terminal. A job the user backgrounded from an
 * interactive shell (`mnemex index &`, `mnemex watch &`) still has a TTY on
 * both stdin and stdout, so every other gate passes — and a background job
 * touching the terminal's attributes gets SIGTTOU and is STOPPED by the
 * kernel. A TUI command in the background is already unusable, so limiting
 * the query to them costs nothing; every other command still resolves the
 * theme from --theme / MNEMEX_THEME / TERM_THEME / COLORFGBG, so the ANSI
 * palette still switches — only the terminal query is skipped.
 */
export const TUI_COMMANDS: ReadonlySet<string> = new Set([
	"ui",
	"monitor",
	"setup",
	"configure",
	"profile",
	"admin",
]);

/**
 * The FR6 gate: the probe may only run when the process really is talking to
 * a person at a terminal. Every condition is independent and any one of them
 * is enough to say no; `rg` is byte-identical to ripgrep and must never see a
 * query echoed into its output, and help/version exit before any colour is
 * drawn (LOW-8). TERM comes from the startup snapshot, like the other env.
 * Finally, only a TUI command may query at all (see `TUI_COMMANDS`).
 */
function isInteractive(
	rest: readonly string[],
	opts: DetectOptions,
	env: ThemeEnv,
	io: ProbeIo,
): boolean {
	if (opts.agentMode) return false;
	if (io.stdin.isTTY !== true || io.stdout.isTTY !== true) return false;
	if (env.TERM === "dumb") return false;
	if (rest[0] === "rg") return false;
	if (rest.some((arg) => NO_PROBE_ARGS.has(arg))) return false;
	// Bare argv prints help, same as --help (runCli's `!command` branch).
	if (rest.length === 0) return false;
	// Only a TUI command may touch the tty: a backgrounded non-TUI job would
	// be stopped by SIGTTOU on setRawMode.
	if (!TUI_COMMANDS.has(rest[0])) return false;
	return true;
}

const NOT_DETECTED_LINE =
	"mnemex: theme not detected (no --theme, MNEMEX_THEME, TERM_THEME, COLORFGBG, and the terminal did not answer OSC 11); using dark. Set MNEMEX_THEME=light|dark to skip detection.\n";
const DEFAULTED_LINE =
	"mnemex: theme defaulted to dark (non-interactive; sources checked: --theme, MNEMEX_THEME, TERM_THEME, COLORFGBG)\n";

/**
 * Once per process, before any coloured byte is written. Strips `--theme`
 * from `args` (so it must run before `const command = args[0]`), gates the
 * probe, resolves, applies BOTH palettes (OpenTUI and ANSI), records the
 * result for `getTheme()` and returns the remaining args.
 *
 * Diagnostics (FR4 / AC 9): exactly one line, on stderr only, and only when
 * the chain fell through to `default` AND `MNEMEX_DEBUG` is set. When any
 * source answered — including the probe — nothing is printed. The line
 * differs by interactivity: after a real probe that got no answer it says so
 * and names the override; in a non-interactive run it says which sources
 * were checked (that shorter line is what the FR3 e2e asserts on).
 *
 * Throws `ThemeFlagError` for a bad `--theme` value; the caller reports it.
 */
export async function detectThemeAtStartup(
	args: string[],
	opts: DetectOptions,
): Promise<{ args: string[]; theme: ThemeResolution }> {
	const env = opts.env ?? getStartupEnv();
	const io = opts.io ?? { stdin: process.stdin, stdout: process.stdout };
	const probe = opts.probe ?? (() => probeTerminalBackground(io));
	const stderr = opts.stderr ?? process.stderr;
	const debug = opts.debug ?? process.env.MNEMEX_DEBUG !== undefined;

	// Parse first so a bad flag fails before anything else and so the gate
	// sees the command with --theme already stripped.
	const { rest } = parseThemeFlag(args);
	const interactive = isInteractive(rest, opts, env, io);

	const theme = await resolveTheme({ argv: args, env, interactive, probe });

	applyTheme(theme.mode);
	applyAnsiTheme(theme.mode);
	current = theme;

	if (theme.source === "default" && debug) {
		stderr.write(interactive ? NOT_DETECTED_LINE : DEFAULTED_LINE);
	}

	return { args: [...theme.argv], theme };
}
