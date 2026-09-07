/**
 * Snapshot of the theme-relevant process environment.
 *
 * Why this module exists: `src/index.ts` calls `dotenv.config()` before
 * anything else, and dotenv injects any key that is not already present. A
 * `.env` file in the cwd could therefore supply `TERM_THEME` or `MNEMEX_THEME`
 * and be indistinguishable from a real export by the time the resolver reads
 * `process.env`. The requirement (FR3) is that those two names are read from
 * the real process environment ONLY, so the four keys the resolver needs are
 * copied out here, once, before dotenv runs, and the resolver reads the copy.
 *
 * Rules this module obeys:
 *  - no imports and no import-time side effects, so it can sit on the eager
 *    path of `src/index.ts` without pulling anything else in;
 *  - `ThemeMode` is declared here rather than in `theme-detect.ts` because
 *    `src/tui/theme.ts` and `src/ui/colors.ts` need it too, and
 *    `theme-detect.ts` imports both — declaring it there would be a cycle;
 *  - the capture is idempotent (first call wins) so a second caller cannot
 *    silently replace the pre-dotenv snapshot with a post-dotenv one.
 *
 * This is layer 2 of the FR3 defence. Layer 1 is `--env-file=/dev/null` on the
 * bun invocation (shebang / `--compile-exec-argv`), which stops bun's OWN
 * `.env` auto-load — that one runs before any user module and no code here can
 * see it. Both layers are needed under bun; this one is what defends against
 * dotenv specifically.
 */

export type ThemeMode = "light" | "dark";

export interface ThemeEnv {
	readonly MNEMEX_THEME?: string;
	readonly TERM_THEME?: string;
	readonly COLORFGBG?: string;
	readonly TERM?: string;
}

const THEME_ENV_KEYS = [
	"MNEMEX_THEME",
	"TERM_THEME",
	"COLORFGBG",
	"TERM",
] as const;

let startupEnv: ThemeEnv | null = null;

/**
 * Pure: copy only the theme-relevant keys out of `source`.
 *
 * Takes the source object explicitly so a test can hand it a plain object and
 * prove that later mutation of that object (what dotenv does to `process.env`)
 * does not reach the returned snapshot.
 */
export function captureThemeEnv(source: NodeJS.ProcessEnv): ThemeEnv {
	const out: Record<string, string> = {};
	for (const key of THEME_ENV_KEYS) {
		const value = source[key];
		if (value !== undefined) out[key] = value;
	}
	return Object.freeze(out);
}

/**
 * Called once by `src/index.ts` BEFORE `dotenv.config()`. Idempotent: the
 * first call wins, so nothing that runs after dotenv can overwrite the
 * pre-dotenv snapshot.
 */
export function captureStartupEnv(): ThemeEnv {
	startupEnv ??= captureThemeEnv(process.env);
	return startupEnv;
}

/**
 * The startup snapshot. If `src/index.ts` was bypassed (a unit test importing
 * `cli.ts` directly) there is no snapshot yet, and a live capture is taken —
 * in that situation dotenv has not run through `index.ts` either, so the live
 * environment is still the real one.
 */
export function getStartupEnv(): ThemeEnv {
	return startupEnv ?? captureStartupEnv();
}
