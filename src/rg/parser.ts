/**
 * rg argument parser
 *
 * Parses ripgrep CLI arguments to extract the search pattern, search path,
 * output mode, and passthrough flags.
 */

/** Output mode for rg command */
export type OutputMode = "content" | "files-with-matches" | "count";

/** Match semantics for mnemex-side pattern filtering */
export interface MatchFlags {
	/** `-F` / `--fixed-strings`: treat pattern as literal string, not regex */
	fixedStrings: boolean;
	/** `-w` / `--word-regexp`: require whole-word match */
	wordRegexp: boolean;
	/** `-x` / `--line-regexp`: require pattern to match entire line */
	lineRegexp: boolean;
	/** `-i` / `--ignore-case`: force case-insensitive */
	ignoreCase: boolean;
	/** `-s` / `--case-sensitive`: force case-sensitive */
	caseSensitive: boolean;
	/** `-S` / `--smart-case`: case-insensitive unless pattern has uppercase */
	smartCase: boolean;
}

/** Parsed rg arguments */
export interface ParsedRgArgs {
	/** The search pattern (may be undefined if not found) */
	pattern: string | undefined;
	/** The search path (defaults to ".") */
	searchPath: string;
	/** Output mode */
	mode: OutputMode;
	/** Match semantics flags for merger filtering */
	matchFlags: MatchFlags;
	/** Raw args to pass through to real rg */
	passthroughArgs: string[];
}

/** Flags that consume the next argument (value flags) */
const VALUE_FLAGS = new Set([
	"-e",
	"--regexp",
	"-f",
	"--file",
	"-A",
	"--after-context",
	"-B",
	"--before-context",
	"-C",
	"--context",
	"-g",
	"--glob",
	"-t",
	"--type",
	"-T",
	"--type-not",
	"--type-add",
	"--type-clear",
	"--color",
	"--colors",
	"--encoding",
	"-m",
	"--max-count",
	"--max-depth",
	"--max-filesize",
	"--pre",
	"--pre-glob",
	"--sort",
	"--sortr",
	"--field-match-separator",
	"--field-context-separator",
]);

/** Combined short flags that don't take values (single-char each) */
const BOOLEAN_SHORT_FLAGS = new Set([
	"i",
	"n",
	"N",
	"l",
	"c",
	"s",
	"S",
	"w",
	"x",
	"v",
	"h",
	"H",
	"p",
	"q",
	"u",
	"L",
	"z",
	"0",
	".",
]);

/**
 * Ensure `--line-number` is present in the args list.
 *
 * The result merger requires `file:line:content` format from rg, so we always
 * add `--line-number` unless the caller already passed `-n` or `--line-number`.
 * Returns a new array (does not mutate the input).
 */
export function ensureLineNumbers(args: string[]): string[] {
	if (args.includes("-n") || args.includes("--line-number")) return args;
	return ["--line-number", ...args];
}

/**
 * Parse ripgrep CLI arguments into structured form.
 *
 * Handles:
 * - `--` separator (end of flags)
 * - `-e`/`--regexp` pattern flag
 * - Combined short flags like `-in`, `-lc`
 * - `--files-with-matches`/`-l` output mode
 * - `--count`/`-c` output mode
 * - First and second positional args (pattern and path)
 */
export function parseRgArgs(args: string[]): ParsedRgArgs {
	let pattern: string | undefined;
	let searchPath = ".";
	let mode: OutputMode = "content";
	const matchFlags: MatchFlags = {
		fixedStrings: false,
		wordRegexp: false,
		lineRegexp: false,
		ignoreCase: false,
		caseSensitive: false,
		smartCase: false,
	};
	const positionals: string[] = [];
	let endOfFlags = false;

	let i = 0;
	while (i < args.length) {
		const arg = args[i];

		if (endOfFlags) {
			positionals.push(arg);
			i++;
			continue;
		}

		if (arg === "--") {
			endOfFlags = true;
			i++;
			continue;
		}

		// Long flags
		if (arg.startsWith("--")) {
			if (arg === "--files-with-matches") {
				mode = "files-with-matches";
				i++;
				continue;
			}
			if (arg === "--count" || arg === "--count-matches") {
				mode = "count";
				i++;
				continue;
			}
			if (arg === "--fixed-strings") {
				matchFlags.fixedStrings = true;
				i++;
				continue;
			}
			if (arg === "--word-regexp") {
				matchFlags.wordRegexp = true;
				i++;
				continue;
			}
			if (arg === "--line-regexp") {
				matchFlags.lineRegexp = true;
				i++;
				continue;
			}
			if (arg === "--ignore-case") {
				matchFlags.ignoreCase = true;
				i++;
				continue;
			}
			if (arg === "--case-sensitive") {
				matchFlags.caseSensitive = true;
				i++;
				continue;
			}
			if (arg === "--smart-case") {
				matchFlags.smartCase = true;
				i++;
				continue;
			}

			// Check if flag=value form (e.g. --glob=*.ts)
			const eqIdx = arg.indexOf("=");
			if (eqIdx !== -1) {
				// flag=value, no extra consumption
				i++;
				continue;
			}

			// -e / --regexp sets the pattern explicitly
			if (arg === "--regexp") {
				i++;
				if (i < args.length) {
					pattern = pattern ?? args[i];
					i++;
				}
				continue;
			}

			// Value-consuming long flags
			if (VALUE_FLAGS.has(arg)) {
				i += 2;
				continue;
			}

			// Boolean long flag
			i++;
			continue;
		}

		// Short flags (single dash)
		if (arg.startsWith("-") && arg.length > 1) {
			// Handle -e <pattern>
			if (arg === "-e") {
				i++;
				if (i < args.length) {
					pattern = pattern ?? args[i];
					i++;
				}
				continue;
			}

			// Check if this is a known value-consuming short flag (single char)
			const singleFlag = arg.slice(0, 2); // e.g. "-A"
			if (VALUE_FLAGS.has(singleFlag) && arg.length === 2) {
				// -A 3 style
				i += 2;
				continue;
			}
			if (VALUE_FLAGS.has(singleFlag) && arg.length > 2) {
				// -A3 style (value attached)
				i++;
				continue;
			}

			// Combined boolean short flags like -in, -lc, -Fw, -iS
			// Check each character after the dash
			let hasL = false;
			let hasC = false;
			for (const ch of arg.slice(1)) {
				if (ch === "l") hasL = true;
				else if (ch === "c") hasC = true;
				else if (ch === "F") matchFlags.fixedStrings = true;
				else if (ch === "w") matchFlags.wordRegexp = true;
				else if (ch === "x") matchFlags.lineRegexp = true;
				else if (ch === "i") matchFlags.ignoreCase = true;
				else if (ch === "s") matchFlags.caseSensitive = true;
				else if (ch === "S") matchFlags.smartCase = true;
			}
			if (hasL) mode = "files-with-matches";
			if (hasC) mode = "count";

			i++;
			continue;
		}

		// Positional argument
		positionals.push(arg);
		i++;
	}

	// First positional is pattern (unless set by -e)
	if (positionals.length >= 1 && pattern === undefined) {
		pattern = positionals[0];
		if (positionals.length >= 2) {
			searchPath = positionals[1];
		}
	} else if (positionals.length >= 1) {
		// Pattern was set by -e, first positional is search path
		searchPath = positionals[0];
	}

	return {
		pattern,
		searchPath,
		mode,
		matchFlags,
		passthroughArgs: args,
	};
}
