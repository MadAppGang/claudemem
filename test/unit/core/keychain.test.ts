/**
 * Engine behaviour, through the injectable seam. NO TEST HERE SPAWNS ANYTHING.
 *
 * Covers validation criteria V1-V7, V10, V11, V12, V15, plus the design's own
 * rows: the memo/keychain-target isolation, the un-cached signal kill, the
 * breaker surviving cache invalidation, and the process budget clamp.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import {
	deleteKeychainAccount,
	describeUnstorableValue,
	ENUMERATE_TIMEOUT_MS,
	enumerateKeychainAccounts,
	invalidateKeychainCache,
	KEYCHAIN_PROCESS_BUDGET_MS,
	KeychainError,
	keychainProcessBudgetUsedMs,
	lookupKeychainAccount,
	maskSecret,
	parseDumpAccounts,
	readKeychainAccount,
	resetKeychainBreaker,
	SPAWN_TIMEOUT_MS,
	setKeychainProcessBudgetUsedMs,
	writeKeychainAccount,
} from "../../../src/core/keychain.js";
import {
	FAILURE,
	fakeKeychain,
	installKeychainStub,
	type KeychainStub,
	LOCKED,
	NOT_FOUND,
	OK,
	renderDump,
	SIGNAL_KILL,
	uninstallKeychainStub,
} from "../../helpers/keychain-stub.js";
import {
	ENTRY_LAUNCHER,
	PROCESS_LAUNCH_ALLOWLIST,
} from "../../helpers/launch-allowlists.js";

let stub: KeychainStub;
const LABEL = 'mnemex: OPENROUTER_API_KEY (account "openrouter")';
const REPO_ROOT = join(import.meta.dir, "../../..");

beforeEach(() => {
	stub = installKeychainStub();
});

afterEach(() => {
	uninstallKeychainStub();
	delete process.env.MNEMEX_KEYCHAIN_FILE;
});

// ============================================================================
// The guard — a real spawn must be impossible, not merely discouraged
// ============================================================================

describe("test guards (D-7 / H3)", () => {
	test("the real adapter refuses in a guarded process", () => {
		// Restore the REAL deps and confirm the adapter refuses rather than spawning.
		// Two independent reasons apply: the preload's private sentinel, and the
		// `testDepsEverInstalled` latch this very file tripped.
		uninstallKeychainStub();
		expect(process.env.MNEMEX_KEYCHAIN_TEST_GUARD).toBe("1");

		const read = readKeychainAccount("openrouter");
		expect(read.status).toBe("failed");
		if (read.status === "failed") {
			expect(read.error).toContain("refusing to spawn /usr/bin/security");
		}

		stub = installKeychainStub();
	});

	/**
	 * Remove comments, keeping string and template literals intact.
	 *
	 * The sweep is about CODE. Every file that enforces this rule also DESCRIBES it,
	 * and a pattern broad enough to catch a hoisted `const BIN = "/usr/bin/security"`
	 * is broad enough to match the prose next to it. Stripping comments is what lets
	 * the patterns be broad without the documentation setting them off.
	 */
	function stripComments(source: string): string {
		let out = "";
		let i = 0;
		let quote: string | null = null;
		while (i < source.length) {
			const c = source[i];
			const next = source[i + 1];
			if (quote) {
				if (c === "\\") {
					out += c + (next ?? "");
					i += 2;
					continue;
				}
				if (c === quote) quote = null;
				out += c;
				i++;
				continue;
			}
			if (c === '"' || c === "'" || c === "`") {
				quote = c;
				out += c;
				i++;
				continue;
			}
			if (c === "/" && next === "/") {
				while (i < source.length && source[i] !== "\n") i++;
				continue;
			}
			if (c === "/" && next === "*") {
				i += 2;
				while (
					i < source.length &&
					!(source[i] === "*" && source[i + 1] === "/")
				)
					i++;
				i += 2;
				continue;
			}
			out += c;
			i++;
		}
		return out;
	}

	/**
	 * The patterns, in one place so the sweep and the sweep's own self-test cannot
	 * drift apart. Evaluated against nine realistic spawn forms; the previous set
	 * missed five of them.
	 */
	function securitySpawnPatterns(): RegExp[] {
		return [
			// Object form: `Bun.spawnSync({ cmd: ["…security", …] })`.
			/cmd:\s*\[\s*[\x22\x27\x60][^\x22\x27\x60]*security/,
			// Array form, string form, sync or async, Bun or node:child_process.
			/(?:Bun\.)?spawn(?:Sync)?\(\s*(?:\{\s*cmd:\s*)?\[?\s*[\x22\x27\x60][^\x22\x27\x60]*security/,
			/exec(?:File)?(?:Sync)?\(\s*[\x22\x27\x60][^\x22\x27\x60]*security/,
			// The binary path lifted into a variable, which defeats command-position
			// matching entirely.
			/=\s*[\x22\x27\x60]\/usr\/bin\/security/,
			// Bun's shell tag.
			/\$`[^`]*\bsecurity\b/,
			// Destructive or interactive subcommands, built from parts so this
			// sweeper does not match itself.
			new RegExp(
				["create", "delete", "unlock", "set"]
					.map((v) => `${v}-keychain`)
					.join("|"),
			),
		];
	}

	test("no test file can spawn `security`, in EITHER test root", async () => {
		// A STATIC sweep, because the runtime guards can only refuse a call that is
		// made — this catches a test that tries to make one at all. The incident this
		// rule comes from flooded the user's screen with authorization dialogs nobody
		// could answer, because a throwaway keychain's password was known only to the
		// tooling and it re-locked on its idle timer.
		//
		// The previous pattern set was evaluated against nine realistic spawn forms
		// and MISSED five of them, including `Bun.spawn([...])` (the idiomatic async
		// form), `node:child_process`'s `spawn` — which `spawn-error-handling.test.ts`
		// already imports — and a binary path lifted into a const. It also scanned
		// only `test/`, while `bun test` runs, and `bun run lint` lints, a second root
		// at `tests/`.
		//
		// Patterns run against COMMENT-STRIPPED source, so the argv assertion at V1
		// and the prose in every guard file are not false positives.
		const spawnsSecurity = securitySpawnPatterns();

		// Every executable extension `bun test` will actually load, not just `.ts`.
		const glob = new Bun.Glob("**/*.{ts,tsx,js,jsx,mjs,cjs,sh}");
		const offenders: string[] = [];
		let scanned = 0;
		for (const root of ["test", "tests"]) {
			for await (const file of glob.scan({ cwd: root, absolute: true })) {
				scanned++;
				const source = stripComments(await Bun.file(file).text());
				if (spawnsSecurity.some((re) => re.test(source))) offenders.push(file);
			}
		}
		expect(offenders).toEqual([]);
		// A sweep that scanned nothing passes vacuously. A missing root throws
		// ENOENT rather than yielding zero, but a bad glob would not.
		expect(scanned).toBeGreaterThan(50);
	});

	test("the sweep's own patterns catch every form, including the five it missed", () => {
		// Guards the guard. Each string is a spawn form the PREVIOUS pattern set was
		// measured against; five of these nine got through. If a future edit narrows
		// the patterns again, this fails instead of the sweep silently passing.
		// EVERY occurrence below is assembled from parts, so this array does not trip
		// the real sweep above — the same trick the original sweeper used on itself.
		const S = ["sec", "urity"].join("");
		const BIN = ["/usr", "bin", S].join("/");
		const forms = [
			`Bun.spawnSync({ cmd: ["${BIN}", "-h"] })`, // was caught
			`Bun.spawnSync(["${BIN}", "-h"])`, // was MISSED (array form)
			`Bun.spawn(["${BIN}", "-h"])`, // was MISSED (async, idiomatic Bun)
			`spawn("${BIN}", ["-h"])`, // was MISSED (node:child_process)
			`const B = "${BIN}"; Bun.spawnSync({ cmd: [B] })`, // was MISSED (hoisted)
			`await $\`${BIN} -h\``, // was MISSED (Bun shell tag)
			`spawnSync("${BIN}", ["-h"])`, // was caught
			`execSync("${S} find-generic-password")`, // was caught
			`${"create"}-keychain /tmp/x.keychain`, // was caught
		];

		const patterns = securitySpawnPatterns();
		const missed = forms.filter((f) => !patterns.some((re) => re.test(f)));
		expect(missed).toEqual([]);
	});

	// ==========================================================================
	// THE ENTRY-POINT DETECTOR
	//
	// Round 3 of external review found this detector blind in the way detectors
	// are usually blind: it recognised ONE SPELLING of the thing it detects.
	// `tests/rg.test.ts` wrote the path as
	// `join(import.meta.dir, "..", "src", "index.ts")` — the components are
	// separate arguments, so the contiguous `src/index.ts` regex never matched.
	// That file spawned the production entry point with `{ ...process.env }` for
	// three rounds while this sweep reported green. A sweep that knows one
	// spelling reports the absence of that spelling, not the absence of the risk.
	//
	// Two changes: the path is recognised however it is CONSTRUCTED, and the
	// guard must be supplied AT THE SPAWN SITE — an import at the top of the file
	// plus a raw `{ ...process.env }` at the call used to pass.
	// ==========================================================================

	/**
	 * `dist/index.js` / `src/index.ts` — contiguous, OR split across `join()`
	 * arguments, which is the form that leaked.
	 */
	const ENTRY_PATH =
		/(?:dist[/\\]index\.js|src[/\\]index\.ts|[\x22\x27\x60]dist[\x22\x27\x60]\s*,\s*[\x22\x27\x60]index\.js[\x22\x27\x60]|[\x22\x27\x60]src[\x22\x27\x60]\s*,\s*[\x22\x27\x60]index\.ts[\x22\x27\x60])/;

	/** A lone `"index.ts"` component, which only counts inside a path expression. */
	const ENTRY_FILE = /[\x22\x27\x60]index\.[jt]s[\x22\x27\x60]/;
	const PATH_BUILD = /\b(?:join|resolve)\s*\(|\$\{/;

	// --------------------------------------------------------------------------
	// ROUND 4 — the entry point that has NO PATH AT ALL.
	//
	// Every spelling above describes a FILE. `src/editor/editor.ts:262` wrote
	//
	//     spawn("mnemex", ["index", "--quiet", "--files", filePath], …)
	//
	// a BARE BINARY NAME resolved through `PATH`. On this machine `which mnemex`
	// answers `/Users/jack/.bun/bin/mnemex`, so the spawn SUCCEEDS, runs the real
	// entry point, and `enableRealKeychainAccess()` at `src/index.ts:32` reaches
	// the developer's login keychain. `SymbolEditor` is constructed by
	// `test/helpers/test-workspace.ts` and driven by two e2e suites, so this was
	// live. Round 3 missed a `path.join(…)` spelling; round 4 missed a name with
	// no path in it whatsoever. The detector below therefore stops asking "does
	// this look like the entry FILE" and asks "does this command position resolve
	// to the entry POINT, by any spelling at all".
	// --------------------------------------------------------------------------

	/** `"mnemex"` — resolved through a mutable `PATH`. THE ROUND-4 FINDING. */
	const BARE_BINARY = /[\x22\x27\x60]mnemex[\x22\x27\x60]/;
	/**
	 * `"/opt/homebrew/bin/mnemex"` — the same binary, named absolutely.
	 * `:` is excluded from the run so `"https://github.com/…/mnemex"` (a URL in a
	 * header, of which this repository has several) can never look like a path.
	 * Applied only INSIDE a spawn's balanced argv, which is the second guard
	 * against that.
	 */
	const ABSOLUTE_BINARY =
		/[\x22\x27\x60][^\x22\x27\x60:]*[/\\]mnemex[\x22\x27\x60]/;
	/** `npx`/`bunx` — a runner that DOWNLOADS AND EXECUTES the package. */
	const PACKAGE_RUNNER = /[\x22\x27\x60](?:npx|bunx)[\x22\x27\x60]/;
	/** `"mnemex"` or `"mnemex@latest"` as the runner's package argument. */
	const RUNNER_PACKAGE =
		/[\x22\x27\x60]mnemex(?:@[^\x22\x27\x60]*)?[\x22\x27\x60]/;
	/**
	 * `spawn(process.execPath, [process.argv[1], …])` — re-executing THIS
	 * process's own script. In production `process.argv[1]` IS `dist/index.js`,
	 * so this is the entry point under a name that contains neither "mnemex" nor
	 * "index". Three hook handlers use it. BOTH halves are required, so an
	 * ordinary `spawn(process.execPath, [someOtherScript])` is not caught.
	 */
	const SELF_EXEC = /process\s*\.\s*execPath/;
	const SELF_ARGV = /process\s*\.\s*argv\s*\[\s*1\s*\]/;
	/**
	 * A SHELL STRING — `execSync("mnemex index --quiet")`, or the same handed to
	 * `sh -c`. The command and its arguments share one literal, so the quote does
	 * NOT close after the binary name and `BARE_BINARY` misses it entirely. The
	 * binary must sit at the START of the string (optionally with a directory
	 * prefix) and be followed by whitespace, which keeps the repository's many
	 * user-facing `"Run 'mnemex init' to set up"` strings out of it — and those
	 * are only ever examined at all when they appear inside a spawn's argv.
	 */
	const SHELL_STRING = /[\x22\x27\x60](?:[^\x22\x27\x60]*[/\\])?mnemex\s/;
	/**
	 * Bun's shell tag: ``$`mnemex index` ``. There is no call to find, so this is
	 * matched over the whole file rather than inside an argument list —
	 * `src/learning/validation/environment-manager.ts` uses this form heavily
	 * (for `git` and `docker`, never for mnemex).
	 */
	const BUN_SHELL_TAG = /\$`[^`]*\bmnemex\b[^`]*`/;

	/**
	 * Does this text name a mnemex entry point, by ANY spelling?
	 *
	 * One predicate, used by both the binding scanner and the call-site scanner,
	 * so a spelling can never be understood in one place and not the other — which
	 * is exactly how the hoisted `join()` form survived round 3.
	 */
	function namesEntryPoint(text: string): boolean {
		if (ENTRY_PATH.test(text)) return true;
		if (BARE_BINARY.test(text)) return true;
		if (ABSOLUTE_BINARY.test(text)) return true;
		if (SHELL_STRING.test(text)) return true;
		if (PACKAGE_RUNNER.test(text) && RUNNER_PACKAGE.test(text)) return true;
		if (SELF_EXEC.test(text) && SELF_ARGV.test(text)) return true;
		return false;
	}

	/** Does this right-hand side evaluate to an entry-point path, however built? */
	function bindsEntryPath(rhs: string): boolean {
		if (namesEntryPoint(rhs)) return true;
		// `join(DIST_DIR, "index.js")` — the directory lives in another variable, so
		// neither spelling above appears and the result is still the entry point.
		return ENTRY_FILE.test(rhs) && PATH_BUILD.test(rhs);
	}

	/**
	 * Identifiers bound to an entry-point path, so `const CLI = join(ROOT,
	 * "dist", "index.js")` followed by `spawnSync("bun", [CLI, ...])` is caught.
	 * Hoisting is how the previous pattern set was defeated five times over; it is
	 * not allowed to work here either, at any depth.
	 */
	function entryPointIdentifiers(source: string): string[] {
		const ids = new Set<string>();
		const bindings = [
			...source.matchAll(
				/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;]{0,300});/g,
			),
		].map((m) => ({ name: m[1] as string, rhs: m[2] ?? "" }));

		for (const b of bindings) if (bindsEntryPath(b.rhs)) ids.add(b.name);

		// TRANSITIVE. `const ENTRY = join(ROOT, "dist", "index.js");
		//              const ARGV = [ENTRY, "index"]; spawnSync("bun", ARGV);`
		// is the same evasion one level up, and a fixed point costs nothing.
		for (let pass = 0; pass < 3; pass++) {
			const before = ids.size;
			for (const b of bindings) {
				if (ids.has(b.name)) continue;
				for (const id of ids) {
					if (new RegExp(`\\b${id}\\b`).test(b.rhs)) {
						ids.add(b.name);
						break;
					}
				}
			}
			if (ids.size === before) break;
		}
		return [...ids];
	}

	/**
	 * Does this text name the blessed constant AND import it from the blessed
	 * module?
	 *
	 * `KEYCHAIN_CHILD_GUARD_ENV` is the single definition of the two variables, so
	 * a spawn site that spreads it is guarded — but only if the identifier is the
	 * real one. A file could declare a local `const KEYCHAIN_CHILD_GUARD_ENV = {}`
	 * and satisfy a name-only check while setting nothing, so the import is
	 * required too. Checked against the WHOLE file, since the import is never in
	 * the same expression as the spread.
	 */
	function importsBlessedGuardConstant(source: string): boolean {
		// A RE-DECLARATION anywhere in the file disqualifies it, import or no
		// import. `stripComments` is a quote-state scanner that preserves string
		// contents, so a child program written as a template literal — which is how
		// this suite's own guard children are written — can contain the import text
		// and satisfy a file-wide check while the identifier at the spawn site is a
		// local shadow that sets nothing. Refusing on re-declaration kills both that
		// shape and the plain impostor, and costs a real file nothing: no file has
		// any reason to declare a name the helper already exports.
		if (
			/(?:const|let|var|function|class)\s+KEYCHAIN_CHILD_GUARD_ENV\b/.test(
				source,
			)
		)
			return false;
		// Anchored to a statement start, so the match cannot come from inside a
		// string, an expression, or a longer identifier.
		return /^\s*import\s*\{[^}]*\bKEYCHAIN_CHILD_GUARD_ENV\b[^}]*\}\s*from\s*["'][^"']*helpers\/child-env\.js["']/m.test(
			source,
		);
	}

	/** The two guard variables, or the shared helper that sets them. */
	function suppliesGuardText(text: string, source?: string): boolean {
		if (text.includes("keychainSafeChildEnv")) return true;
		if (
			text.includes("KEYCHAIN_CHILD_GUARD_ENV") &&
			source !== undefined &&
			importsBlessedGuardConstant(source)
		) {
			return true;
		}
		return (
			text.includes("MNEMEX_KEYCHAIN_TEST_GUARD") &&
			text.includes("MNEMEX_DISABLE_KEYCHAIN")
		);
	}

	/** The balanced `{...}` block that starts at `open`. */
	function blockAt(source: string, open: number): string {
		let depth = 0;
		for (let i = open; i < source.length && i < open + 4000; i++) {
			if (source[i] === "{") depth++;
			else if (source[i] === "}" && --depth === 0) return source.slice(open, i);
		}
		return source.slice(open, open + 4000);
	}

	/**
	 * Names whose OWN DEFINITION supplies the guard, so `env: childEnv()` and
	 * `env,` (a local built a few lines above) count at the call site.
	 *
	 * Scoped to the definition's balanced body on purpose. A window of N
	 * characters after the name is not a scope: in `guard-in-the-wrong-place.ts`
	 * a correctly-guarded helper spawn sits a few lines above an UNGUARDED
	 * entry-point spawn, and a windowed rule marked every const between them as
	 * guard-supplying — reproducing, one level down, the same "the token appears
	 * somewhere nearby" mistake that let the file-level rule pass a live bypass.
	 */
	function guardSupplyingIdentifiers(source: string): string[] {
		const ids = new Set<string>();

		// (a) A local mutated into shape: `env.MNEMEX_KEYCHAIN_TEST_GUARD = "1"`.
		// The quote characters are \x-escaped because `stripComments` above is a
		// quote-state scanner and cannot tell a regex literal from a string: an odd
		// number of raw quotes in a pattern silently disables comment stripping for
		// the rest of the file, which is how this edit first showed up — as an
		// unrelated sweep matching prose in a comment.
		for (const m of source.matchAll(
			/([A-Za-z_$][\w$]*)\s*(?:\.|\[[\x22\x27])MNEMEX_(?:KEYCHAIN_TEST_GUARD|DISABLE_KEYCHAIN)/g,
		)) {
			ids.add(m[1] as string);
		}

		// (b) A function, arrow or object literal whose balanced body supplies it.
		for (const m of source.matchAll(
			/(?:function\s+([A-Za-z_$][\w$]*)|(?:const|let|var)\s+([A-Za-z_$][\w$]*))/g,
		)) {
			const name = m[1] ?? m[2];
			if (!name) continue;
			// The body must START at this definition: the first `{` must come before
			// the `;` that would end a plain binding.
			const head = source.slice(m.index, m.index + 200);
			const open = head.indexOf("{");
			const semi = head.indexOf(";");
			if (open < 0 || (semi >= 0 && semi < open)) continue;
			if (suppliesGuardText(blockAt(source, m.index + open), source))
				ids.add(name);
		}
		return [...ids];
	}

	/** The balanced `(...)` argument list starting at `open`. */
	function argsAt(source: string, open: number): string {
		let depth = 0;
		for (let i = open; i < source.length && i < open + 4000; i++) {
			if (source[i] === "(") depth++;
			else if (source[i] === ")" && --depth === 0) return source.slice(open, i);
		}
		return source.slice(open, open + 4000);
	}

	/**
	 * Every call in `source` that launches a mnemex entry point, as its BALANCED
	 * argument list.
	 *
	 * Balanced rather than "the next 400 characters": a fixed window both misses
	 * a long options object and swallows the statements after the call. The
	 * second half of that is not cosmetic — in `guard-in-the-wrong-place.ts` a
	 * windowed rule read `return result.stdout` from AFTER the unguarded call,
	 * matched the `result` of a different, correctly-guarded call above it, and
	 * declared the offending site guarded.
	 */
	function entryPointSpawnSites(source: string): string[] {
		const ids = entryPointIdentifiers(source);
		const call =
			/(?:Bun\.)?(?:spawnSync|spawn|execFileSync|execFile|execSync|exec)\s*\(/g;
		const sites: string[] = [];
		for (const m of source.matchAll(call)) {
			// A `spawn(` that is itself INSIDE a string literal is an assertion about
			// spawning, not a spawn. `spawn-error-handling.test.ts` asserts on the
			// text `spawn("mnemex"` and is not an offender; a rule that called it one
			// would be deleted within a week, and then the real rule with it.
			const prev = source[m.index - 1] ?? "";
			if (prev === '"' || prev === "'" || prev === "`") continue;

			const argv = argsAt(source, m.index + m[0].length - 1);
			if (
				namesEntryPoint(argv) ||
				ids.some((id) => new RegExp(`\\b${id}\\b`).test(argv))
			) {
				sites.push(argv);
			}
		}

		// Bun's shell tag has no call parentheses to find, so it is matched over
		// the whole source instead. ``$`mnemex index` `` launches the entry point
		// exactly as `spawn("mnemex", ["index"])` does, and none of the rules above
		// would see it.
		for (const m of source.matchAll(/\$`[^`]*`/g)) {
			if (BUN_SHELL_TAG.test(m[0])) sites.push(m[0]);
		}
		return sites;
	}

	/**
	 * Does this source SPAWN a mnemex entry point?
	 *
	 * The entry point is the one thing that calls `enableRealKeychainAccess()`, so
	 * a child running it turns the production gate ON inside itself. That is the
	 * shape the runtime guards cannot refuse, and it is the shape that actually
	 * caused the incident.
	 */
	function spawnsEntryPoint(source: string, isShell = false): boolean {
		// A shell script has no call syntax worth parsing; naming the path at all is
		// enough, and the only such script in the repo does spawn it.
		if (isShell) return ENTRY_PATH.test(source);
		return entryPointSpawnSites(source).length > 0;
	}

	/** How many of those spawns fail to supply the guard AT THE CALL. */
	function unguardedEntryPointSpawns(source: string, isShell = false): number {
		if (isShell) {
			return ENTRY_PATH.test(source) && !suppliesGuardText(source, source)
				? 1
				: 0;
		}
		const guardIds = guardSupplyingIdentifiers(source);
		let count = 0;
		for (const argv of entryPointSpawnSites(source)) {
			const guarded =
				suppliesGuardText(argv, source) ||
				guardIds.some((id) => new RegExp(`\\b${id}\\b`).test(argv));
			if (!guarded) count++;
		}
		return count;
	}

	/**
	 * Files that are DELIBERATELY offending, kept as real files with real
	 * extensions so the rejection is proved on the same input the sweep sees.
	 * Skipped here, and asserted on one by one in its own test below.
	 */
	const SWEEP_FIXTURE_DIR = ["testdata", "entrypoint-sweep", ""].join("/");
	/** Round 7's fixtures for the allowlist rule, likewise deliberately offending. */
	const LAUNCH_FIXTURE_DIR = ["testdata", "launch-allowlist", ""].join("/");
	/** Round 6 (round 8 review): fixtures for the import-resolving graph rule. */
	const GRAPH_FIXTURE_DIR = ["testdata", "launch-capability", ""].join("/");
	function isSweepFixture(file: string): boolean {
		return (
			file.includes(SWEEP_FIXTURE_DIR) ||
			file.includes(LAUNCH_FIXTURE_DIR) ||
			file.includes(GRAPH_FIXTURE_DIR)
		);
	}

	test("a test that spawns an ENTRY POINT must set the guard variables itself", async () => {
		// THE FINDING (external review, CRITICAL 1 / CWE-284).
		//
		// Deny-by-default protects a test that IMPORTS the keychain module. It
		// cannot protect a test that SPAWNS `dist/index.js`, because `src/index.ts`
		// calls `enableRealKeychainAccess()` at line 32 — the child enables itself.
		// The only remaining veto is the private sentinel, and its only writer was
		// `bunfig.toml`'s `[test] preload`, which bun resolves against the CWD and
		// does not walk up for.
		//
		// `tests/rg.e2e.test.ts` forwarded `{...process.env}` and set neither
		// variable. Its `runMnemexRg()` -> semantic search -> embeddings client ->
		// `getVoyageApiKey()` -> `realRun()` -> `Bun.spawnSync` reached
		// /usr/bin/security. Inherited state is not a guard; this test makes
		// supplying the variables at the spawn site mandatory and checkable.
		const glob = new Bun.Glob("**/*.{ts,tsx,js,jsx,mjs,cjs,sh}");
		const offenders: string[] = [];
		let entryPointSpawners = 0;
		for (const root of ["test", "tests"]) {
			for await (const file of glob.scan({ cwd: root, absolute: true })) {
				if (isSweepFixture(file)) continue;
				const source = stripComments(await Bun.file(file).text());
				const isShell = file.endsWith(".sh");
				if (!spawnsEntryPoint(source, isShell)) continue;
				entryPointSpawners++;
				if (unguardedEntryPointSpawns(source, isShell) > 0)
					offenders.push(file);
			}
		}
		expect(offenders).toEqual([]);
		// A detector that matches nothing proves nothing. There are known
		// entry-point spawners in both roots; if this count drops, the pattern
		// broke, not the repository. FOUR is the number only AFTER the split
		// `join()` form is understood: `tests/rg.test.ts` and
		// `test/e2e/pack-e2e.test.ts` were both invisible to the old regex, and one
		// of them was a live offender for three review rounds.
		expect(entryPointSpawners).toBeGreaterThanOrEqual(4);
	});

	test("no test may reach the entry point TRANSITIVELY, through the reindex launcher", async () => {
		// The round-3 CRITICAL that no spawn-site sweep could ever have seen: not
		// one test file names an entry-point path, and yet nine `DebounceReindexer`
		// constructions in `test/integration/mcp-server.test.ts` each launched the
		// INSTALLED `mnemex` binary. The `spawn("mnemex", ["index", …])` lived in
		// PRODUCTION code (`src/mcp/reindexer.ts`), inherited the test process's
		// environment, and on a developer machine `mnemex` is on PATH.
		//
		// The class now takes its launcher as a REQUIRED constructor argument, so
		// the only route from a test back to the real binary is to import the
		// production launcher by name. This forbids exactly that. It is a
		// name-level rule and it does not generalise — the general lesson is that a
		// sweep over call sites cannot see a launch made two files away, so any
		// production code that starts an entry point must take its launcher from
		// its caller.
		const forbidden = new RegExp(["spawn", "Detached", "Reindex"].join(""));
		const glob = new Bun.Glob("**/*.{ts,tsx}");
		const offenders: string[] = [];
		let scanned = 0;
		for (const root of ["test", "tests"]) {
			for await (const file of glob.scan({ cwd: root, absolute: true })) {
				if (isSweepFixture(file)) continue;
				scanned++;
				if (forbidden.test(stripComments(await Bun.file(file).text()))) {
					offenders.push(file);
				}
			}
		}
		expect(offenders).toEqual([]);
		expect(scanned).toBeGreaterThan(50);
	});

	// `ENTRY_LAUNCHER` — the ONE production file allowed to PERFORM a mnemex
	// entry-point launch — and `PROCESS_LAUNCH_ALLOWLIST` are imported from
	// `test/helpers/launch-allowlists.ts`, shared with the import-resolving graph
	// rule in `launch-capability-graph.test.ts` so the two rules cannot disagree
	// about who may launch. Deliberately the same shape as `src/core/keychain.ts`
	// being the one file allowed to spawn `security`: a single exception is
	// auditable.

	// ==========================================================================
	// ROUND 7 — THE RULE IS INVERTED. Process launch is a CAPABILITY, and a file
	// either has it, with a written justification, or it does not.
	//
	// Four rounds, four families of spelling the argument-shaped detector above
	// did not know: the literal path (R3a), `path.join` (R3a again), the bare
	// binary name (R4), and external review's round-7 list — `fork(...)`,
	// `spawn(obj.cli, …)`, `spawn(parts.join(""), …)`, and an imported wrapper
	// whose `spawn(command, args)` lives in another file. It also over-matched:
	// `spawn("brew", ["upgrade", "mnemex"])` read as a launch, and `git grep
	// mnemex` would have. A regex over ARGUMENTS cannot win this — every round
	// adds a spelling, and the next round finds the one it did not add.
	//
	// So the arguments are no longer consulted for the files that matter. To
	// start a process at all, a file must first OBTAIN a launch capability, and
	// there are only a handful of ways to do that in Node/Bun: import (static,
	// dynamic or `require`) `node:child_process`; touch `Bun.spawn`,
	// `Bun.spawnSync` or `Bun.$` (directly or destructured); import `$`/`spawn`
	// from `"bun"`; or import a third-party runner. Those spellings are finite
	// and they do not look like anything else. A file that obtains one and is
	// not on the allowlist below is a finding, whatever it goes on to launch.
	// A file on the allowlist is then held to ONE narrow rule: it may not name a
	// mnemex entry point in a launch (the argument-shaped detector, applied
	// where it can no longer be evaded by choosing a different file).
	//
	// THE CONSEQUENCE, STATED HONESTLY. `spawn("git", ["grep", "mnemex"])` in a
	// non-allowlisted file fires — not because of `"mnemex"`, but because it is a
	// launch outside the adapter set. The remedy is an allowlist entry with a
	// justification, after which only the narrow rule applies. And the CALLER of
	// an imported wrapper is not where the rule fires: the WRAPPER is, at the
	// point it acquires the capability. A generic pass-through adapter cannot
	// enter `src/` without someone writing "forwards whatever it is given" in
	// the table, which is the sentence a reviewer must refuse.
	//
	// WHAT THIS SWEEP DOES NOT SEE — stated after round 8's external review,
	// which found the justification here claiming more than was enforced. This
	// is a regex over PRIMITIVE acquisitions. It cannot see a capability
	// obtained by IMPORTING A LOCAL MODULE (a file importing the launcher and
	// calling it passed this sweep), nor an alias (`const runtime = Bun`,
	// `globalThis["Bun"]`, `process["binding"]`, `const { spawn: s } = cp`, a
	// re-export chain). The precise statement is therefore: the launcher is the
	// only file that PERFORMS a mnemex entry-point launch, and a BOUNDED,
	// ENUMERATED set of callers may REQUEST one through its purpose-specific
	// exports. The second half is enforced by the import- and alias-resolving
	// rule in `launch-capability-graph.test.ts`, against
	// `LAUNCHER_CALLER_ALLOWLIST`. The two rules share one table module
	// (`test/helpers/launch-allowlists.ts`); this sweep stays because it is a
	// cheap tripwire with no parser to mis-handle.
	// ==========================================================================

	/**
	 * `import type … ;` statements are erased at compile time and can launch
	 * nothing (`src/lsp/transport.ts` imports only the `ChildProcess` type).
	 * Removed before matching. An inline `{ type X, spawn }` keeps its value half
	 * and still fires.
	 */
	function withoutTypeOnlyImports(source: string): string {
		return source.replace(/\bimport\s+type\s+[^;]*;/g, "");
	}

	/**
	 * The ways a file can OBTAIN a process-launch capability. Finite, and
	 * unlike an argument list, not something a caller can spell differently.
	 * In one place so the rule and its self-test cannot drift.
	 */
	function launchCapabilityPatterns(): RegExp[] {
		return [
			// `node:child_process` / `child_process`: static import, dynamic
			// `import(...)`, or `require(...)`.
			/(?:from\s*|require\s*\(\s*|import\s*\(\s*)[\x22\x27](?:node:)?child_process[\x22\x27]/,
			// The Bun global, by property.
			/\bBun\s*\.\s*(?:spawn(?:Sync)?\b|\$)/,
			// The Bun global, destructured: `const { spawn } = Bun;`
			/\{[^}]*(?:\$|\bspawn(?:Sync)?\b)[^}]*\}\s*=\s*(?:globalThis\s*\.\s*)?Bun\b/,
			// `import { $ } from "bun"` / `import { spawn } from "bun"`.
			/import\s*\{[^}]*(?:\$|\bspawn(?:Sync)?\b)[^}]*\}\s*from\s*[\x22\x27]bun[\x22\x27]/,
			// Well-known third-party runners. A new one goes on THIS list.
			/(?:from\s*|require\s*\(\s*|import\s*\(\s*)[\x22\x27](?:execa|zx|cross-spawn|shelljs|tinyexec|nano-spawn|child-process-promise|promisify-child-process)[\x22\x27]/,
			// Reaching under the runtime for the primitive itself.
			/process\s*\.\s*binding\s*\(/,
		];
	}

	/** Does this (comment-stripped) source obtain a launch capability? */
	function obtainsLaunchCapability(source: string): boolean {
		const code = withoutTypeOnlyImports(source);
		return launchCapabilityPatterns().some((re) => re.test(code));
	}

	test("no PRODUCTION file may obtain a process-launch capability unless it is on the allowlist", async () => {
		// THE ROUND-7 HIGH. Arguments are not consulted: the capability is the
		// finding. Every hit below is either an entry in the table (with its
		// reason) or a defect.
		const glob = new Bun.Glob("**/*.{ts,tsx,js,jsx,mjs,cjs}");
		const offenders: string[] = [];
		const seen = new Set<string>();
		let scanned = 0;
		for await (const file of glob.scan({ cwd: "src", absolute: true })) {
			scanned++;
			const rel = file.slice(REPO_ROOT.length + 1);
			const source = stripComments(await Bun.file(file).text());
			if (!obtainsLaunchCapability(source)) continue;
			seen.add(rel);
			if (!(rel in PROCESS_LAUNCH_ALLOWLIST)) offenders.push(rel);
		}
		expect(offenders).toEqual([]);
		expect(scanned).toBeGreaterThan(50);

		// NO ROT. Every allowlisted file must exist AND still hold a capability;
		// otherwise the table becomes the "known-safe call sites" list that the
		// previous design was written to avoid.
		const stale = Object.keys(PROCESS_LAUNCH_ALLOWLIST).filter(
			(rel) => !seen.has(rel),
		);
		expect(stale).toEqual([]);
		// And every entry carries a reason a reviewer can disagree with.
		for (const [rel, why] of Object.entries(PROCESS_LAUNCH_ALLOWLIST)) {
			expect(why.length, rel).toBeGreaterThan(20);
		}
	});

	test("of the allowlisted files, only the launcher may name a mnemex entry point", async () => {
		// THE NARROW CHECK — the argument-shaped detector, applied to the only
		// files that can launch anything. It can no longer be evaded by moving the
		// call to a file it does not scan, because every such file is above.
		//
		// R3b and R4 both live here as history: `src/mcp/reindexer.ts` and
		// `src/editor/editor.ts` launched the installed binary from production
		// code. Neither holds a capability now — they receive a launcher from their
		// caller — so neither is on the allowlist, and this check never needs to
		// look at them.
		const offenders: { file: string; site: string }[] = [];
		for (const rel of Object.keys(PROCESS_LAUNCH_ALLOWLIST)) {
			if (rel === ENTRY_LAUNCHER) continue; // the one exception
			const source = stripComments(await Bun.file(join(REPO_ROOT, rel)).text());
			for (const site of entryPointSpawnSites(source)) {
				offenders.push({ file: rel, site: site.slice(0, 120) });
			}
		}
		expect(offenders).toEqual([]);
	});

	test("the allowlist rule catches every spelling the argument detector missed — proved on files", async () => {
		// Round 7's four evasions and the earlier families, as real files. The
		// verdict is `launches=<obtains a capability>`; note that NOT ONE of these
		// verdicts depends on what the file passes to the API. The two negatives
		// are the honest edges of a file-level rule and are documented as such in
		// the directory's README.
		const dir = join(import.meta.dir, "../../testdata/launch-allowlist");
		const glob = new Bun.Glob("**/*.ts");
		const verdicts: Record<string, string> = {};
		for await (const file of glob.scan({ cwd: dir, absolute: true })) {
			const source = stripComments(await Bun.file(file).text());
			verdicts[file.slice(dir.length + 1)] =
				`launches=${obtainsLaunchCapability(source)}`;
		}
		expect(verdicts).toEqual({
			// ROUND 7 — the four the reviewer listed.
			"fork-entry.ts": "launches=true",
			"object-property-command.ts": "launches=true",
			"concatenated-name.ts": "launches=true",
			"imported-wrapper.ts": "launches=true",
			// The caller half of the wrapper evasion: no capability of its own.
			// The rule fires on the wrapper, which cannot exist un-allowlisted.
			"imported-wrapper-caller.ts": "launches=false",
			// The shapes production code actually uses for the capability.
			"dynamic-import.ts": "launches=true",
			"bun-global.ts": "launches=true",
			"third-party-runner.ts": "launches=true",
			// `git grep mnemex` THROUGH A LAUNCH API fires — it is a launch outside
			// the adapter set, and the argument is beside the point.
			"git-grep-spawn.ts": "launches=true",
			// `git grep mnemex`, `brew upgrade mnemex` and the entry-point path as
			// DATA, with no launch API anywhere: not a finding. The old detector's
			// over-matches came from reading arguments; this one reads none.
			"git-grep-no-launch.ts": "launches=false",
			// A type-only import is erased and cannot launch.
			"type-only-import.ts": "launches=false",
		});

		// And the round-3/round-4 fixture family, every one of which obtained the
		// capability through `node:child_process` or `import { $ } from "bun"`.
		// Under this rule they are all caught by their FIRST line, before any of
		// the argument spellings they were written to demonstrate.
		const older = join(import.meta.dir, "../../testdata/entrypoint-sweep");
		let olderCount = 0;
		for await (const file of glob.scan({ cwd: older, absolute: true })) {
			olderCount++;
			const source = stripComments(await Bun.file(file).text());
			expect(obtainsLaunchCapability(source), file).toBe(true);
		}
		expect(olderCount).toBeGreaterThanOrEqual(10);
	});

	test("the capability patterns catch the exotic acquisitions and ignore prose", () => {
		// Assembled from parts where a literal would make this file match itself.
		const CP = ["child_", "process"].join("");
		const fires = [
			`import { spawn } from "node:${CP}";`,
			`import { type ChildProcess, spawn } from "node:${CP}";`,
			`const { execFile } = require("${CP}");`,
			`const cp = await import("node:${CP}");`,
			`import("node:${CP}").then(({ exec }) => exec(cmd));`,
			"const { spawnSync } = Bun;",
			"const { $ } = globalThis.Bun;",
			"Bun.spawn(argv);",
			"Bun.$`ls`;",
			`import { $ } from "bun";`,
			`import { spawn } from "bun";`,
			`import { execa } from "execa";`,
			`const { $ } = require("zx");`,
			`process.binding("spawn_sync");`,
		];
		for (const form of fires) {
			expect(obtainsLaunchCapability(form), form).toBe(true);
		}

		const silent = [
			// Type-only: erased.
			`import type { ChildProcess } from "node:${CP}";`,
			// Other Bun APIs, which the repository uses everywhere.
			"await Bun.file(path).text(); new Bun.Glob(pattern); Bun.env.HOME;",
			// `$` as an ordinary identifier, a jQuery-style helper, or a regex anchor.
			"const total = $ + 1; const re = /^x$/; const s = `${a}$`;",
			// The variable name mentioned in a string.
			`console.error("set ${CP} options");`,
			// A method NAMED exec on some other object, and a regex exec.
			"db.exec(sql); /x/.exec(input); env.exec(command);",
		];
		for (const form of silent) {
			expect(obtainsLaunchCapability(form), form).toBe(false);
		}
	});

	test("the launcher module exists and is the only production namer of the entry point", async () => {
		// The exception above is worth nothing if the file it exempts is empty or
		// missing — the sweep would pass vacuously, which is the failure mode this
		// suite keeps having to re-close. So the exempted file must actually be the
		// launcher, and it must actually launch.
		const source = stripComments(
			await Bun.file(join(REPO_ROOT, ENTRY_LAUNCHER)).text(),
		);
		expect(entryPointSpawnSites(source).length).toBeGreaterThanOrEqual(3);

		const mod = await import("../../../src/core/entry-point-launcher.js");
		expect(typeof mod.spawnMnemexDetached).toBe("function");
		expect(typeof mod.spawnSelfDetached).toBe("function");
		expect(typeof mod.runSelfSync).toBe("function");
		expect(typeof mod.entryPointLaunchCount).toBe("function");
	});

	test("the sweep REJECTS a constructed-path spawn — proved on files, not strings", async () => {
		// The round-3 finding was not "one file was missed". It was "the detector
		// recognises one spelling", and a detector cannot be trusted on the strength
		// of the cases someone remembered to write inline next to it. These are real
		// files with real extensions under `test/`, read exactly as the sweep reads
		// them, and every one MUST come back as an unguarded entry-point spawn.
		const dir = join(import.meta.dir, "../../testdata/entrypoint-sweep");
		const glob = new Bun.Glob("**/*.ts");
		const verdicts: Record<string, string> = {};
		for await (const file of glob.scan({ cwd: dir, absolute: true })) {
			const source = stripComments(await Bun.file(file).text());
			const name = file.slice(dir.length + 1);
			verdicts[name] = `spawns=${spawnsEntryPoint(source)} unguarded=${
				unguardedEntryPointSpawns(source) > 0
			}`;
		}
		// Named, so an empty directory cannot pass this vacuously — the exact
		// failure mode ("it scanned nothing and reported green") this file exists
		// to prevent.
		expect(verdicts).toEqual({
			"constructed-join-path.ts": "spawns=true unguarded=true",
			"guard-in-the-wrong-place.ts": "spawns=true unguarded=true",
			// The blessed constant's NAME with none of its content. Proves the
			// acceptance added for `...KEYCHAIN_CHILD_GUARD_ENV` is conditional on
			// importing it from `helpers/child-env.js`, not on spelling it.
			"impostor-guard-constant.ts": "spawns=true unguarded=true",
			// The second shape: a REAL import at the top, shadowed by a local of the
			// same name at the spawn site. The import check alone cannot see it, so a
			// re-declaration anywhere in the file is disqualifying on its own.
			"shadowed-guard-constant.ts": "spawns=true unguarded=true",
			"hoisted-argv.ts": "spawns=true unguarded=true",
			"interpolated-path.ts": "spawns=true unguarded=true",
			// ROUND 4 — the spellings with no path in them at all. Each was invisible
			// to every rule above until this round, and the first one is the bug that
			// was actually live in `src/editor/editor.ts`.
			"absolute-binary-path.ts": "spawns=true unguarded=true",
			"bare-binary-name.ts": "spawns=true unguarded=true",
			"hoisted-bare-name.ts": "spawns=true unguarded=true",
			"package-runner.ts": "spawns=true unguarded=true",
			"self-reexec.ts": "spawns=true unguarded=true",
			"shell-string.ts": "spawns=true unguarded=true",
		});
	});

	test("the entry-point detector catches the exact form that leaked, and the fix", () => {
		// EVERY path component below is assembled from parts, and never written as
		// a literal, so this array does not trip the sweep it describes — the same
		// trick the `security` sweeper two tests above uses on itself. The
		// split-argument spelling makes this stricter than before: even
		// `"src", "index.ts"` inside a call to a helper would now match.
		const D = ["di", "st"].join("");
		const IJS = ["index", ".js"].join("");
		const S = ["sr", "c"].join("");
		const ITS = ["index", ".ts"].join("");
		const DIST = `${D}/${IJS}`;
		const SRC = `${S}/${ITS}`;
		const BIN = ["mne", "mex"].join("");
		/** `"src", "index.ts"` — the split spelling, built so it is not literal here. */
		const split = (...parts: string[]) => parts.map((p) => `"${p}"`).join(", ");
		const leaked = [
			// The exact shape `tests/rg.e2e.test.ts` had: the path hoisted into a
			// const, argv referring to it, `{...process.env}` and nothing else.
			`const CLI_BIN = "${DIST}";\nspawnSync("bun", [CLI_BIN, "rg"], { env: { ...process.env } });`,
			`Bun.spawnSync({ cmd: ["bun", "${SRC}", "index"] })`,
			`spawnSync("${BIN}", ["status"], {})`,
			// ROUND 3 — the split `join()` form `tests/rg.test.ts` actually had.
			`const CLI_PATH = join(import.meta.dir, "..", ${split(S, ITS)});\nspawnSync("bun", [CLI_PATH, "rg"], { env: { ...process.env, NO_COLOR: "1" } });`,
			// Directory in one variable, filename added in a later call.
			`const DD = join(ROOT, "${D}");\nconst CLI = join(DD, "${IJS}");\nspawnSync("bun", [CLI], {});`,
			// Interpolated.
			`spawnSync("bun", [\`\${ROOT}/${DIST}\`], { env: { ...process.env } })`,
			// Argv hoisted instead of the path.
			`const CLI = join(R, ${split(D, IJS)});\nconst ARGV = [CLI, "index"];\nspawnSync("bun", ARGV, {});`,
			// The guard imported at the top and NOT used at THIS call — a pass under
			// the old file-level rule.
			`import { keychainSafeChildEnv } from "x";\nfunction other() { return keychainSafeChildEnv(); }\nconst CLI = join(R, ${split(S, ITS)});\nspawnSync("bun", [CLI], { env: { ...process.env } });`,
			// ROUND 4 — no path anywhere. The bare binary name resolved through
			// PATH, which is what `src/editor/editor.ts:262` wrote.
			`spawn("${BIN}", ["index", "--quiet", "--files", filePath], { cwd, detached: true });`,
			// The same binary named absolutely.
			`spawnSync("/opt/homebrew/bin/${BIN}", ["status"], { env: { ...process.env } });`,
			// Hoisted bare name, two levels deep.
			`const C = "${BIN}";\nconst ARGV = [C, "index"];\nspawn(ARGV[0], ARGV.slice(1), { cwd });`,
			// A package runner, with a version suffix that defeats an exact-string
			// rule.
			`spawnSync("npx", ["${BIN}@latest", "index"], { env: { ...process.env } });`,
			`spawnSync("bunx", ["${BIN}", "index"], { env: { ...process.env } });`,
			// Re-exec of this process's own script: in production `argv[1]` IS the
			// entry point, under a name containing neither "mnemex" nor "index".
			`spawnSync(process.execPath, [process.argv[1], "status"], { cwd });`,
			// A shell string: the quote does not close after the binary name, so an
			// exact-token rule sees nothing.
			`execSync("${BIN} index --quiet", { cwd, env: { ...process.env } });`,
			`spawnSync("sh", ["-c", "${BIN} status --agent"], { cwd });`,
			// Bun's shell tag: no call parentheses for a call-site rule to find.
			`const { stdout } = await $\`${BIN} status --agent\`.quiet();`,
		];
		for (const form of leaked) {
			expect(spawnsEntryPoint(form)).toBe(true);
			expect(unguardedEntryPointSpawns(form)).toBeGreaterThan(0);
		}

		const fixed = [
			`spawnSync("bun", ["${DIST}"], { env: keychainSafeChildEnv() })`,
			// The guard built into a local a few lines up and passed by name — the
			// shape `keychain-entrypoint-guard.test.ts` uses.
			`const env = { HOME: h, MNEMEX_KEYCHAIN_TEST_GUARD: "1", MNEMEX_DISABLE_KEYCHAIN: "0" };\nconst CLI = join(R, ${split(S, ITS)});\nBun.spawnSync({ cmd: ["bun", CLI], env });`,
		];
		for (const form of fixed) {
			expect(spawnsEntryPoint(form)).toBe(true);
			expect(unguardedEntryPointSpawns(form)).toBe(0);
		}

		// And a child that is NOT an entry point is not caught at all, or every
		// helper spawn in the suite becomes an offender and the rule gets deleted.
		// These are real shapes from this repository, not invented ones.
		const benign = [
			// Every `bun run <helper child>` in the guard suites.
			`Bun.spawnSync({ cmd: ["bun", "run", CHILD] })`,
			// `process.execPath` WITHOUT `process.argv[1]` — a worker, not a re-exec.
			// Both halves are required precisely so this stays out.
			`spawn(process.execPath, [WORKER_SCRIPT], { cwd });`,
			// `test/e2e/pack-e2e.test.ts:991` — a package runner running something
			// that is not mnemex.
			`spawnSync("npx", ["repomix", "--style", "xml", "--stdout"], { timeout: 60000 });`,
			// `src/cli.ts` shelling out to the bundled ripgrep.
			`spawn(rgPath, rgArgs, { stdio: ["inherit", "pipe", "pipe"] });`,
			// `src/learning/validation/environment-manager.ts` uses Bun's shell tag
			// heavily, for git and docker. Only a tag naming mnemex counts. The
			// interpolations are written as bare identifiers rather than `${…}`
			// because a `${` inside a plain string is itself a lint warning, and the
			// tag is what is being tested, not the substitution.
			"await $`cd WORKDIR && git init -q`;",
			"await $`docker exec CONTAINER sh -c CMD`.quiet();",
			// A user-facing help string is not a launch, even though it reads like
			// one. It is only ever examined inside a spawn's argv, and this is the
			// shape that made `SHELL_STRING` anchor at the start of the literal.
			`console.error("Run 'mnemex init' to set up, or set " + envHint);`,
		];
		for (const form of benign) {
			expect(spawnsEntryPoint(form)).toBe(false);
		}

		// KNOWN OVER-MATCH, recorded rather than papered over: an inline
		// `spawn("brew", ["upgrade", "mnemex"])` reads as an entry-point launch
		// because the argv contains the quoted binary name. It is not one — brew
		// upgrades a formula, it does not execute mnemex. `src/updater/index.ts`
		// builds that argv into a variable, so the live code is not flagged, and a
		// detector that fails CLOSED on an ambiguous argv is the right way round.
		expect(spawnsEntryPoint(`spawn("brew", ["upgrade", "${BIN}"]);`)).toBe(
			true,
		);
	});

	test("nothing may re-introduce a seam that turns the production gate ON", async () => {
		// BYPASS 2. `setRealKeychainAccessEnabledForTests(true)` wrote
		// `realAccessEnabled` unconditionally: in a fresh process with no sentinel
		// and no installed seam, calling it and then `readKeychainAccount()` reached
		// the real adapter. A test seam that can enable the production gate is a
		// second entry point. The replacement is disable-only and its type makes the
		// other direction unwritable — this keeps it that way.
		// Assembled from parts so this sweeper does not match its own source — the
		// same trick the argv sweeper two tests above uses on itself.
		const GATE = ["real", "AccessEnabled"].join("");
		const forbidden = [
			new RegExp(["set", "RealKeychain", "AccessEnabled"].join("")),
			// Any other exported setter shaped like "turn the gate on".
			// Safe as a literal: its source contains `export\s+function`, never the
			// bare `export function` it matches, so it cannot flag this file.
			/export\s+function\s+\w*[Ee]nableRealKeychainAccess\w*ForTests/,
			// A direct write to the gate from outside its own declaration site.
			new RegExp(`${GATE}\\s*=\\s*(?:true|enabled|!)`),
		];
		const offenders: { file: string; pattern: string }[] = [];
		const glob = new Bun.Glob("**/*.{ts,tsx}");
		for (const root of ["test", "tests", "src"]) {
			for await (const file of glob.scan({ cwd: root, absolute: true })) {
				const source = stripComments(await Bun.file(file).text());
				for (const re of forbidden) {
					// The gate's own file legitimately assigns it in
					// `enableRealKeychainAccess`, which is guarded by the sentinel.
					if (
						file.endsWith("src/core/keychain.ts") &&
						re.source.includes(GATE)
					) {
						continue;
					}
					if (re.test(source)) offenders.push({ file, pattern: re.source });
				}
			}
		}
		expect(offenders).toEqual([]);
	});

	test("no PRODUCTION file spawns `security` outside the port either", async () => {
		// BYPASS 3. `src/llm/providers/claude-code.ts` ran
		// `execSync(<relative name> + " find-generic-password ... -w")` — the DEFAULT
		// enrichment provider, reading Claude Code's OAuth token with no gate, no
		// sentinel, no budget, and the binary resolved through a mutable PATH
		// (CWE-426). The sweep scanned only `test/` and `tests/`, so it was invisible
		// to the mechanism that exists to catch exactly this.
		//
		// `src/core/keychain.ts` is the ONE file allowed to spawn it. That is what
		// "one driven port" means, and it is now checked rather than asserted.
		const spawnsSecurity = securitySpawnPatterns();
		const glob = new Bun.Glob("**/*.{ts,tsx}");
		const offenders: string[] = [];
		let scanned = 0;
		for await (const file of glob.scan({ cwd: "src", absolute: true })) {
			if (file.endsWith("src/core/keychain.ts")) continue; // the port itself
			scanned++;
			const source = stripComments(await Bun.file(file).text());
			if (spawnsSecurity.some((re) => re.test(source))) offenders.push(file);
		}
		expect(offenders).toEqual([]);
		expect(scanned).toBeGreaterThan(50);
	});

	test("the sweep does not fire on the argv assertions and prose it lives next to", () => {
		// The other half: a sweep that flags every file is as useless as one that
		// flags none, and would be silenced by narrowing it back.
		const benign = [
			`expect(stdin).toContain('-T "/usr/bin/security"');`,
			`Bun.spawnSync({ cmd: ["bun", "run", CHILD], env })`,
			`const proc = Bun.spawnSync({ cmd: ["node", "-e", "1"] });`,
		];
		const patterns = securitySpawnPatterns();
		const fired = benign.filter((f) => patterns.some((re) => re.test(f)));
		expect(fired).toEqual([]);
	});

	test("the environment sentinel is present — a wrong-cwd run FAILS LOUDLY", () => {
		// `bunfig.toml`'s preload is resolved against the working directory and does
		// not walk up, so `cd test && bun test ../…` silently sheds two guard layers.
		// Deny-by-default in the adapter covers the actual danger; this makes the
		// degraded configuration visible instead of quiet.
		expect(process.env.MNEMEX_KEYCHAIN_TEST_GUARD).toBe("1");
	});
});

// ============================================================================
// V1 — the secret never enters argv
// ============================================================================

describe("V1 — a write never places the secret in argv", () => {
	test("argv is exactly ['-i']; the value rides as hex on stdin", () => {
		const secret = "kctest-or-SUPER-SECRET-VALUE";
		const store = new Map<string, string>();
		stub.setRun(fakeKeychain(store));

		writeKeychainAccount("openrouter", secret, LABEL);

		const write = stub.writes()[0];
		expect(write).toBeDefined();
		expect(write?.args).toEqual(["-i"]);

		// Neither the secret NOR its hex encoding appears anywhere in argv.
		const argv = stub.allArgv().join(" ");
		expect(argv).not.toContain(secret);
		expect(argv).not.toContain(Buffer.from(secret, "utf8").toString("hex"));

		// The hex appears only on stdin.
		expect(write?.stdin).toContain(Buffer.from(secret, "utf8").toString("hex"));
		// And the raw secret is never in the stdin command line either.
		expect(write?.stdin).not.toContain(secret);
	});

	test("the ACL is pinned to /usr/bin/security and the write upserts", () => {
		stub.setRun(fakeKeychain(new Map()));
		writeKeychainAccount("openrouter", "kctest-or-x", LABEL);
		const stdin = stub.writes()[0]?.stdin ?? "";
		expect(stdin).toContain('-T "/usr/bin/security"');
		expect(stdin).toContain(" -U ");
		expect(stdin).toContain('-s "mnemex"');
	});
});

// ============================================================================
// V2 — hostile values round-trip
// ============================================================================

describe("V2 — hostile values round-trip through the hex encoding", () => {
	const hostile = [
		"has spaces",
		'has "double" quotes',
		"has 'single' quotes",
		"has\\backslash",
		"has $dollar and `backtick`",
		"kctest-or-ünïcödé-ключ",
	];

	for (const value of hostile) {
		test(`round-trips ${JSON.stringify(value)}`, () => {
			const store = new Map<string, string>();
			stub.setRun(fakeKeychain(store));

			// The fake decodes `-X <hex>` exactly as real `security` does, so a
			// successful verified write IS the round-trip assertion.
			writeKeychainAccount("openrouter", value, LABEL);
			expect(store.get("openrouter")).toBe(value);

			invalidateKeychainCache();
			const read = readKeychainAccount("openrouter");
			expect(read).toEqual({ status: "found", value });
		});
	}
});

// ============================================================================
// V3 — control characters rejected BEFORE any seam call
// ============================================================================

describe("V3 — control characters are rejected at write time", () => {
	test("throws and the seam is never invoked", () => {
		stub.setRun(() => {
			throw new Error("the seam must not be reached");
		});

		expect(() => writeKeychainAccount("openrouter", "a\nb", LABEL)).toThrow(
			KeychainError,
		);
		expect(stub.calls).toHaveLength(0);
	});

	test("describeUnstorableValue explains why, and passes a normal key", () => {
		expect(describeUnstorableValue("a\nb")).toContain("control characters");
		expect(describeUnstorableValue("")).toBe("value is empty");
		expect(describeUnstorableValue("kctest-or-normal")).toBeNull();
	});
});

// ============================================================================
// V4 — exactly one trailing newline, never .trim()
// ============================================================================

describe("V4 — exactly one trailing newline is stripped", () => {
	test('" key \\n" reads back as " key ", not "key"', () => {
		stub.setRun(() => OK(" key \n"));
		const read = readKeychainAccount("openrouter");
		expect(read).toEqual({ status: "found", value: " key " });
	});

	test("only ONE newline is removed", () => {
		stub.setRun(() => OK("value\n\n"));
		const read = readKeychainAccount("openrouter");
		expect(read).toEqual({ status: "found", value: "value\n" });
	});
});

// ============================================================================
// V5 / V6 — spawn counts
// ============================================================================

describe("V5/V6 — cold read costs at most ONE spawn, warm costs ZERO", () => {
	test("cold = 1, warm = 0, and a spawn again once the burst window closes", () => {
		stub.setRun(() => OK("kctest-or-value\n"));

		expect(readKeychainAccount("openrouter").status).toBe("found");
		expect(stub.calls).toHaveLength(1); // V5

		expect(readKeychainAccount("openrouter").status).toBe("found");
		expect(stub.calls).toHaveLength(1); // V6

		// The memo is a BURST window, not a session cache: a user may edit the item
		// in Keychain Access.app mid-run, so the answer must expire.
		invalidateKeychainCache();
		expect(readKeychainAccount("openrouter").status).toBe("found");
		expect(stub.calls).toHaveLength(2);
	});

	test("a memoised ABSENCE is equally free", () => {
		stub.setRun(() => NOT_FOUND());
		expect(readKeychainAccount("voyage")).toEqual({ status: "absent" });
		expect(readKeychainAccount("voyage")).toEqual({ status: "absent" });
		expect(stub.calls).toHaveLength(1);
	});

	test("`fresh` ASKS — a warm memo does not answer the read that carries proof", () => {
		// External review round 3, HIGH 2. `persistSecrets` treats a byte-identical
		// pre-read as proof that the keychain holds the value, and that proof
		// authorises deleting the plaintext copy from `config.json`. Served from the
		// burst memo, it proved only that the keychain held it at some point in the
		// last three seconds — during which another process's unforced
		// `keychain rm` could have removed it. The memo is right for the getters and
		// wrong for that one read, so the read that carries proof asks for itself.
		//
		// The count is the assertion: a call that reached the seam is a call that
		// would have reached `security`.
		let answer = "kctest-or-A\n";
		stub.setRun(() => OK(answer));

		expect(readKeychainAccount("openrouter")).toEqual({
			status: "found",
			value: "kctest-or-A",
		});
		expect(stub.calls).toHaveLength(1);

		// Warm: the getter path is unchanged, and still free.
		expect(readKeychainAccount("openrouter").status).toBe("found");
		expect(stub.calls).toHaveLength(1);

		// The world changes underneath the memo — another process deleted the item.
		answer = "";
		stub.setRun(() => NOT_FOUND());

		// The memo would still say "found sk-or-A". `fresh` does not ask it.
		expect(readKeychainAccount("openrouter", { fresh: true })).toEqual({
			status: "absent",
		});
		expect(stub.calls).toHaveLength(2);
	});
});

// ============================================================================
// V7 — enumeration answers for every key in one call
// ============================================================================

describe("V7 — one dump-keychain answers for all six accounts", () => {
	test("all accounts parsed from a single spawn", () => {
		const accounts = [
			"openrouter",
			"voyage",
			"anthropic",
			"context7",
			"cloud",
			"ollama",
		];
		stub.setRun(() => OK(renderDump(accounts)));

		const result = enumerateKeychainAccounts();
		expect(result.failed).toBe(false);
		expect(result.accounts).toEqual([...accounts].sort());
		expect(stub.calls).toHaveLength(1);
		expect(stub.calls[0]?.args).toEqual(["dump-keychain"]);
	});

	test("a fresh enumeration answers 'absent' for a missing account at ZERO spawns", () => {
		stub.setRun((call) =>
			call.args[0] === "dump-keychain"
				? OK(renderDump(["openrouter"]))
				: NOT_FOUND(),
		);
		enumerateKeychainAccounts();
		expect(stub.calls).toHaveLength(1);

		expect(readKeychainAccount("voyage")).toEqual({ status: "absent" });
		expect(stub.calls).toHaveLength(1);
	});

	test("parses a captured REAL dump block and keeps unknown accounts", () => {
		// Shape captured from a real `security dump-keychain` run. This fixture is
		// what keeps the un-remeasurable output format honest.
		const real = `keychain: "/Users/jack/Library/Keychains/login.keychain-db"
class: "genp"
attributes:
    0x00000007 <blob>="Chrome Safe Storage"
    "acct"<blob>="Chrome"
    "svce"<blob>="Chrome Safe Storage"
class: "genp"
attributes:
    0x00000007 <blob>="mnemex: OPENROUTER_API_KEY (account \\"openrouter\\")"
    "acct"<blob>="openrouter"
    "desc"<blob>="application password"
    "svce"<blob>="mnemex"
class: "genp"
attributes:
    0x00000007 <blob>="OLLAMA_API_KEY"
    "acct"<blob>="OLLAMA_API_KEY"
    "svce"<blob>="mnemex"
class: "inet"
attributes:
    "acct"<blob>="someone@example.com"
    "svce"<blob>="mnemex"
`;
		// Other services filtered out; a non-genp item ignored; a HAND-CREATED item
		// under svce=mnemex kept rather than silently dropped.
		expect(parseDumpAccounts(real)).toEqual(["OLLAMA_API_KEY", "openrouter"]);
	});
});

// ============================================================================
// V10 / V11 — failure is not absence
// ============================================================================

describe("V10/V11 — failure and absence are different values", () => {
	test("V10: a non-44 error is `failed`, never `absent`", () => {
		stub.setRun(() => FAILURE("security: SecKeychainSearchCopyNext: -25308"));
		const read = readKeychainAccount("openrouter");
		expect(read.status).toBe("failed");
		expect(lookupKeychainAccount("openrouter")).toEqual({
			present: false,
			failed: true,
		});
	});

	test("V11: exit 44 is absence, not failure", () => {
		stub.setRun(() => NOT_FOUND());
		expect(readKeychainAccount("openrouter")).toEqual({ status: "absent" });
		expect(lookupKeychainAccount("openrouter")).toEqual({
			present: false,
			failed: false,
		});
	});

	test("the stderr line classifies a miss even if exit 44 ever changes", () => {
		// EXIT_ITEM_NOT_FOUND is inherited and deliberately not re-measured; the
		// regex is the actual guard.
		stub.setRun(() => ({
			code: 1,
			stdout: "",
			stderr:
				"security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.",
		}));
		expect(readKeychainAccount("openrouter")).toEqual({ status: "absent" });
	});

	test("a failed enumeration reports failed, and NEVER an empty account list as success", () => {
		stub.setRun(() => FAILURE("security: dump-keychain: timed out"));
		const result = enumerateKeychainAccounts();
		expect(result.failed).toBe(true);
		expect(result.accounts).toEqual([]);
		expect(result.error).toContain("timed out");
	});
});

// ============================================================================
// V12 — a lock failure is not retried per key
// ============================================================================

describe("V12 — one store-wide failure bounds the whole burst", () => {
	test("five different accounts cost ONE spawn after a failure", () => {
		stub.setRun(() => FAILURE("security: SecKeychainUnlock: -25308"));

		const ids = ["openrouter", "voyage", "anthropic", "context7", "ollama"];
		const results = ids.map((a) => readKeychainAccount(a));

		expect(stub.calls).toHaveLength(1);
		for (const r of results) expect(r.status).toBe("failed");
	});
});

// ============================================================================
// V15 — nothing reaches stdout
// ============================================================================

describe("V15 — the engine writes to stdout zero times", () => {
	test("across read, enumerate, write, delete AND their failure paths", () => {
		const stdoutSpy = spyOn(process.stdout, "write").mockImplementation(
			() => true,
		);
		const logSpy = spyOn(console, "log").mockImplementation(() => {});

		try {
			const store = new Map<string, string>([["voyage", "kctest-voy-value"]]);
			stub.setRun(fakeKeychain(store));

			readKeychainAccount("voyage");
			readKeychainAccount("missing");
			enumerateKeychainAccounts();
			writeKeychainAccount("openrouter", "kctest-or-x", LABEL);
			deleteKeychainAccount("openrouter");

			// Failure paths.
			stub.setRun(() => FAILURE());
			invalidateKeychainCache();
			readKeychainAccount("voyage");
			enumerateKeychainAccounts();
			expect(() => writeKeychainAccount("voyage", "x", LABEL)).toThrow();
			expect(() => deleteKeychainAccount("voyage")).toThrow();

			expect(stdoutSpy).not.toHaveBeenCalled();
			expect(logSpy).not.toHaveBeenCalled();
		} finally {
			stdoutSpy.mockRestore();
			logSpy.mockRestore();
		}
	});
});

// ============================================================================
// H6 — a memo never crosses keychains
// ============================================================================

describe("memos are keyed on the resolved keychain target (H6)", () => {
	test("flipping MNEMEX_KEYCHAIN_FILE inside the window re-reads", () => {
		stub.setRun((call) =>
			call.args.includes("/tmp/other.keychain")
				? OK("value-from-other\n")
				: OK("value-from-login\n"),
		);

		expect(readKeychainAccount("openrouter")).toEqual({
			status: "found",
			value: "value-from-login",
		});
		expect(stub.calls).toHaveLength(1);

		process.env.MNEMEX_KEYCHAIN_FILE = "/tmp/other.keychain";
		expect(readKeychainAccount("openrouter")).toEqual({
			status: "found",
			value: "value-from-other",
		});
		expect(stub.calls).toHaveLength(2);
		// The keychain path is LAST in argv, as `security` requires.
		expect(stub.calls[1]?.args.at(-1)).toBe("/tmp/other.keychain");
	});

	test("a failure latched against one keychain does not answer for another", () => {
		stub.setRun((call) =>
			call.args.includes("/tmp/other.keychain") ? OK("ok\n") : FAILURE(),
		);
		expect(readKeychainAccount("openrouter").status).toBe("failed");

		process.env.MNEMEX_KEYCHAIN_FILE = "/tmp/other.keychain";
		expect(readKeychainAccount("openrouter")).toEqual({
			status: "found",
			value: "ok",
		});
	});
});

// ============================================================================
// H5 — a signal kill is not cached
// ============================================================================

describe("a signal kill is never cached (H5)", () => {
	test("the next call inside the TTL spawns again and can succeed", () => {
		let first = true;
		stub.setRun(() => {
			if (first) {
				first = false;
				return SIGNAL_KILL();
			}
			return OK("kctest-or-late\n");
		});

		expect(readKeychainAccount("openrouter").status).toBe("failed");
		// The breaker DID trip (that is the stall mechanism), so clear it the way the
		// pre-hard-exit re-ask does, and confirm nothing was memoised.
		resetKeychainBreaker();

		expect(readKeychainAccount("openrouter")).toEqual({
			status: "found",
			value: "kctest-or-late",
		});
		expect(stub.calls).toHaveLength(2);
	});
});

// ============================================================================
// H7 — the breaker and the process budget
// ============================================================================

describe("circuit breaker and process budget (H7 / N4)", () => {
	test("the breaker survives invalidateKeychainCache()", () => {
		stub.setRun(() => LOCKED());
		expect(readKeychainAccount("openrouter").status).toBe("failed");
		expect(stub.calls).toHaveLength(1);

		// invalidateKeychainCache runs before AND after every mutation, so a
		// memo-based breaker would be defeated on exactly the path that costs most.
		invalidateKeychainCache();
		expect(readKeychainAccount("voyage").status).toBe("failed");
		expect(stub.calls).toHaveLength(1);

		// Writes are bounded by it too.
		expect(() => writeKeychainAccount("voyage", "x", LABEL)).toThrow();
		expect(stub.calls).toHaveLength(1);
	});

	test("an open breaker cannot be cleared by a would-be success — only by a reset", () => {
		// Named honestly. The old name was "a successful run clears the breaker",
		// and the test called `resetKeychainBreaker()` BEFORE the success, so it
		// could not have detected the thing it appeared to assert. It cannot be
		// detected, because it is not true: an OPEN breaker returns CODE_INERT
		// without spawning, so no success can occur to clear it. That is deliberate —
		// the breaker is what bounds a locked keychain — and this test now pins it.
		let locked = true;
		stub.setRun(() => (locked ? LOCKED() : OK("v\n")));
		expect(readKeychainAccount("openrouter").status).toBe("failed");

		// The keychain is healthy again, but the breaker is still open: the read is
		// answered inert, at ZERO spawns.
		locked = false;
		invalidateKeychainCache();
		const spawnsBefore = stub.calls.length;
		expect(readKeychainAccount("openrouter").status).toBe("failed");
		expect(stub.calls).toHaveLength(spawnsBefore);

		// Only an explicit reset reopens the path.
		resetKeychainBreaker();
		invalidateKeychainCache();
		expect(readKeychainAccount("openrouter").status).toBe("found");

		// Breaker is clear: a subsequent read spawns normally.
		invalidateKeychainCache();
		expect(readKeychainAccount("voyage").status).toBe("found");
		expect(stub.calls).toHaveLength(3);
	});

	test("the budget CLAMPS the requested timeout (N4), it does not merely trip after the fact", () => {
		// A post-hoc check would permit a spawn to BEGIN at 5999 ms consumed; with
		// ENUMERATE_TIMEOUT_MS that spawn can block another 5 s, for ~11 s of
		// contiguously blocked event loop — above the 10 s at which `isLockStale`
		// reclaims a held index lock. The clamp is what makes the stated bound real.
		const timeouts: number[] = [];
		stub.setRun((call) => {
			timeouts.push(call.timeoutMs ?? -1);
			return OK("v\n");
		});

		// Fresh budget: each operation asks for its own full timeout.
		readKeychainAccount("openrouter");
		expect(timeouts.at(-1)).toBe(SPAWN_TIMEOUT_MS);
		enumerateKeychainAccounts();
		expect(timeouts.at(-1)).toBe(ENUMERATE_TIMEOUT_MS);

		// With only 500 ms of budget left, an ENUMERATE may ask for 500 ms, not 5000.
		setKeychainProcessBudgetUsedMs(KEYCHAIN_PROCESS_BUDGET_MS - 500);
		invalidateKeychainCache();
		enumerateKeychainAccounts();
		expect(timeouts.at(-1)).toBe(500);

		// Same for a single read.
		setKeychainProcessBudgetUsedMs(KEYCHAIN_PROCESS_BUDGET_MS - 120);
		invalidateKeychainCache();
		readKeychainAccount("voyage");
		expect(timeouts.at(-1)).toBe(120);

		// Therefore the total time ever spent inside deps.run is <= the budget, and
		// worst-case heartbeat staleness is <= 1000 (phase) + 6000 = 7000 < 10000.
		for (const t of timeouts) {
			expect(t).toBeLessThanOrEqual(KEYCHAIN_PROCESS_BUDGET_MS);
		}
	});

	test("an exhausted budget makes the module inert with ZERO further spawns", () => {
		stub.setRun(() => OK("v\n"));
		// The accumulator is monotonic, so `>= 0` was true of any number and could
		// not fail (LOW (d)). What it should have said: a real call moves it, and it
		// stays inside the budget.
		const before1 = keychainProcessBudgetUsedMs();
		readKeychainAccount("openrouter");
		expect(keychainProcessBudgetUsedMs()).toBeGreaterThanOrEqual(before1);
		expect(keychainProcessBudgetUsedMs()).toBeLessThan(
			KEYCHAIN_PROCESS_BUDGET_MS,
		);

		setKeychainProcessBudgetUsedMs(KEYCHAIN_PROCESS_BUDGET_MS);
		invalidateKeychainCache();
		const before = stub.calls.length;

		const read = readKeychainAccount("openrouter");
		expect(read.status).toBe("failed");
		if (read.status === "failed") expect(read.error).toContain("budget");

		const enumeration = enumerateKeychainAccounts();
		expect(enumeration.failed).toBe(true);

		expect(() => writeKeychainAccount("voyage", "x", LABEL)).toThrow();

		expect(stub.calls).toHaveLength(before);
	});
});

// ============================================================================
// Write verification and delete semantics
// ============================================================================

describe("write verification (F7) and delete confirmation (I3)", () => {
	test("exit 0 is not proof — a write that does not round-trip throws", () => {
		stub.setRun((call) =>
			call.args[0] === "-i" ? OK() : OK("SOMETHING-ELSE\n"),
		);
		expect(() =>
			writeKeychainAccount("openrouter", "kctest-or-x", LABEL),
		).toThrow(/did not round-trip/);
	});

	test("an unverifiable write throws rather than claiming success", () => {
		stub.setRun((call) => (call.args[0] === "-i" ? OK() : FAILURE()));
		expect(() =>
			writeKeychainAccount("openrouter", "kctest-or-x", LABEL),
		).toThrow(/could not be verified/);
	});

	test("delete: exit 0 -> true, exit 44 -> false, other -> throws", () => {
		const store = new Map<string, string>([["openrouter", "v"]]);
		stub.setRun(fakeKeychain(store));
		expect(deleteKeychainAccount("openrouter")).toBe(true);
		expect(deleteKeychainAccount("openrouter")).toBe(false);

		stub.setRun(() => FAILURE("security: ACL denied"));
		expect(() => deleteKeychainAccount("openrouter")).toThrow(KeychainError);
	});
});

// ============================================================================
// maskSecret — the only rendering of a secret this module can produce
// ============================================================================

describe("maskSecret", () => {
	test("never reveals more than four characters, and nothing when short", () => {
		expect(maskSecret("kctest-or-abcdefgh1234")).toBe("••••1234");
		expect(maskSecret("short")).toBe("••••");
		expect(maskSecret("")).toBe("••••");
	});
});
