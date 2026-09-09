/**
 * THE LAUNCH-CAPABILITY GRAPH RULE — layered ON TOP of the regex sweep in
 * `keychain.test.ts`, which stays.
 *
 * THE FINDING (round 8, external review, HIGH 2 — PARTIAL). The sweep
 * recognises PRIMITIVE acquisitions of a process-launch capability. It cannot
 * see (a) a capability obtained by IMPORTING A LOCAL MODULE — at the time,
 * `src/mcp/reindexer.ts` imported the generic `launchEntryPointDetached` and
 * fed it `REINDEX_COMMAND = "mnemex"`, while the allowlist justification said
 * the launcher was "the only file that may name or start a mnemex entry point"
 * — nor (b) aliases: `const runtime = Bun`, `globalThis["Bun"]`,
 * `process["binding"]`, `const { spawn: s } = cp`, re-export chains.
 *
 * THE RULE. Two capability KINDS with two allowlists (shared with the sweep
 * through `test/helpers/launch-allowlists.ts`):
 *
 *   primitive  any export of `node:child_process`; `Bun.spawn`/`spawnSync`/`$`
 *              (and the `Bun` global itself, so aliases carry it);
 *              `$`/`spawn` from "bun"; `process.binding`; known runners
 *   launcher   every export of `src/core/entry-point-launcher.ts`
 *
 * A file that CALLS (or tags, for `$`) a binding carrying a kind violates
 * unless it is on that kind's allowlist. Importing without calling is not a
 * violation; it is printed as an info line so drift is visible.
 *
 * RED BEFORE GREEN (real output, recorded in the session log):
 *   1. Against the pre-round-6 tree with an EMPTY caller allowlist (what the
 *      old justification literally claimed) the analyzer reported
 *      `src/mcp/reindexer.ts:70 [launcher] launchEntryPointDetached(command,
 *      args, cwd)` plus the three hook handlers.
 *   2. All nine calling fixtures fired with nothing allowlisted, including
 *      `negative-allowlisted-caller.ts` — which is what shows the allowlist,
 *      not the import specifier, is what silences it.
 *   3. Green after allowlisting exactly the five real callers.
 *
 * Nothing here executes a source file. The analyzer parses with the repo's
 * own tree-sitter grammars (`typescript@7` in this tree is the Go port: no
 * `createSourceFile`, and its one JS API spawns a binary — inside the test
 * that forbids spawning). No `/usr/bin/security`, no entry point, no child.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ENTRY_LAUNCHER,
	LAUNCHER_CALLER_ALLOWLIST,
	PROCESS_LAUNCH_ALLOWLIST,
} from "../../helpers/launch-allowlists.js";
import {
	type AnalyzeResult,
	analyzeLaunchCapabilities,
	formatFindings,
	type LaunchFinding,
	REEXPORT_DEPTH_LIMIT,
	type UnresolvedEntry,
} from "../../helpers/launch-capability-graph.js";

const REPO_ROOT = join(import.meta.dir, "../../..");
const FIXTURE_DIR = "test/testdata/launch-capability";

const PRIMITIVE_ALLOW = new Set(Object.keys(PROCESS_LAUNCH_ALLOWLIST));
const LAUNCHER_ALLOW = new Set(Object.keys(LAUNCHER_CALLER_ALLOWLIST));

function analyzeSrc(launcherCallerAllowlist: ReadonlySet<string>) {
	return analyzeLaunchCapabilities({
		repoRoot: REPO_ROOT,
		roots: [join(REPO_ROOT, "src")],
		launcherPath: ENTRY_LAUNCHER,
		primitiveAllowlist: PRIMITIVE_ALLOW,
		launcherCallerAllowlist,
	});
}

function analyzeFixtures(launcherCallerAllowlist: ReadonlySet<string>) {
	return analyzeLaunchCapabilities({
		repoRoot: REPO_ROOT,
		roots: [join(REPO_ROOT, FIXTURE_DIR)],
		launcherPath: ENTRY_LAUNCHER,
		primitiveAllowlist: PRIMITIVE_ALLOW,
		launcherCallerAllowlist,
	});
}

/** `file [kind]`, deduplicated and sorted — the shape verdicts are stated in. */
function verdicts(findings: LaunchFinding[]): string[] {
	return [...new Set(findings.map((f) => `${f.file} [${f.kind}]`))].sort();
}

function filesCalling(result: AnalyzeResult, kind: "primitive" | "launcher") {
	return new Set(
		result.calls.filter((f) => f.kind === kind).map((f) => f.file),
	);
}

/** One line per undecidable place, so a failure names it. */
function formatUnresolved(entries: UnresolvedEntry[]): string {
	return entries
		.map((u) => `${u.file}:${u.line} [${u.kind}] ${u.text}`)
		.join("\n");
}

describe("launch-capability graph — the production tree", () => {
	test("no file calls a launch capability outside the allowlist for its KIND", async () => {
		const result = await analyzeSrc(LAUNCHER_ALLOW);

		// The wall time is reported separately from the suite's, as requested.
		console.info(
			`launch-capability graph: ${result.filesScanned} files, ` +
				`${result.passes} fixpoint passes, ${result.elapsedMs} ms`,
		);
		// Import-only holders are INFO, never a violation — but printed, so a new
		// one is visible in the run rather than silently absorbed.
		for (const info of result.importOnly) {
			console.info(
				`launch-capability graph: import-only [${info.kind}] ${info.file}: ${info.bindings.join(", ")}`,
			);
		}

		expect(result.filesScanned).toBeGreaterThan(300);
		// LOAD-BEARING (round 7 of the fix, round 9 review): every entry is a
		// place the analyzer could not decide — a computed `import(x)`, an
		// `export *` chain past `REEXPORT_DEPTH_LIMIT`, a specifier that resolves
		// to no file. An undecidable place is a violation, not an absence of
		// evidence, so the list must be EMPTY on the production tree. There is
		// no allowlist for it: a real computed import in `src/` is made
		// resolvable (a literal or same-file const specifier), not excused.
		expect(formatUnresolved(result.unresolved)).toBe("");
		expect(result.unresolved).toEqual([]);
		expect(formatFindings(result.violations)).toBe("");
		expect(result.violations).toEqual([]);
	});

	test("every file that HOLDS a launcher binding is on the caller allowlist — import-only included", async () => {
		// Holding is the thing the list permits ("files permitted to import from
		// the launcher"). `src/mcp/server.ts` imports two launchers and calls
		// neither; it is on the list for that reason, with that reason.
		const result = await analyzeSrc(LAUNCHER_ALLOW);
		const holders = [...result.acquired.launcher].sort();
		const unlisted = holders.filter((f) => !LAUNCHER_ALLOW.has(f));
		expect(unlisted).toEqual([]);
	});

	test("NO ROT — every allowlisted caller still holds the capability, and every reason is a sentence", async () => {
		const result = await analyzeSrc(LAUNCHER_ALLOW);
		const stale = [...LAUNCHER_ALLOW].filter(
			(f) => !result.acquired.launcher.has(f),
		);
		expect(stale).toEqual([]);
		for (const [file, why] of Object.entries(LAUNCHER_CALLER_ALLOWLIST)) {
			expect(why.length, file).toBeGreaterThan(20);
		}

		// The primitive table is the sweep's; here it is checked against what
		// the GRAPH sees. A file counts as holding the primitive if it binds one
		// OR calls one on a global directly (`Bun.spawnSync({...})` in the
		// keychain port and `import("node:child_process").then(...)` in
		// BenchmarkResults bind nothing and are calls all the same).
		const primitiveHolders = new Set([
			...result.acquired.primitive,
			...filesCalling(result, "primitive"),
		]);
		const stalePrimitive = [...PRIMITIVE_ALLOW].filter(
			(f) => !primitiveHolders.has(f),
		);
		expect(stalePrimitive).toEqual([]);
		const unlistedPrimitive = [...primitiveHolders].filter(
			(f) => !PRIMITIVE_ALLOW.has(f),
		);
		expect(unlistedPrimitive).toEqual([]);
	});

	test("the caller rule is not vacuous: with NO callers allowlisted, the real callers are violations", async () => {
		// This is red step 1 kept alive as a test. If the launcher import were
		// ever missed (a resolver regression, a renamed file), this would go
		// silent and the green above would be worth nothing.
		const result = await analyzeSrc(new Set());
		const launcherViolators = [
			...new Set(
				result.violations
					.filter((f) => f.kind === "launcher")
					.map((f) => f.file),
			),
		].sort();
		expect(launcherViolators).toEqual(
			[
				"src/hooks/handlers/post-tool-use.ts",
				"src/hooks/handlers/pre-tool-use.ts",
				"src/hooks/handlers/session-start.ts",
				"src/mcp/reindexer.ts",
			].sort(),
		);
		// And the reindexer's call is the PURPOSE-SPECIFIC launcher, not a
		// generic command-taking one: the file no longer names the binary.
		const reindexerCalls = result.calls.filter(
			(f) => f.file === "src/mcp/reindexer.ts",
		);
		expect(reindexerCalls.map((f) => f.text)).toEqual([
			"spawnMnemexDetached(args, cwd)",
		]);
		const reindexerSource = await Bun.file(
			join(REPO_ROOT, "src/mcp/reindexer.ts"),
		).text();
		expect(reindexerSource).not.toMatch(/REINDEX_COMMAND|"mnemex"/);
	});

	test("the launcher exports NO generic command-taking launcher", async () => {
		const mod = await import("../../../src/core/entry-point-launcher.js");
		expect(Object.keys(mod)).not.toContain("launchEntryPointDetached");
		const source = await Bun.file(join(REPO_ROOT, ENTRY_LAUNCHER)).text();
		// Every real spawn in the file names its own target; none takes a
		// `command` parameter — the shape that was removed. (Assembled from
		// parts so the argv sweeper in `keychain.test.ts` does not read this
		// regex literal as a spawn site.)
		const generic = new RegExp(
			["spa", "wn(?:Sync)?\\(\\s*command\\b"].join(""),
		);
		expect(source).not.toMatch(generic);
	});
});

describe("launch-capability graph — fixtures, one per spelling the sweep cannot see", () => {
	const NEGATIVE_ALLOWLISTED = `${FIXTURE_DIR}/negative-allowlisted-caller.ts`;

	test("RED: with nothing allowlisted, every calling fixture fires — including the negative", async () => {
		const result = await analyzeFixtures(new Set());
		expect(verdicts(result.violations)).toEqual([
			`${FIXTURE_DIR}/a-imports-launcher.ts [launcher]`,
			`${FIXTURE_DIR}/b-bun-alias.ts [primitive]`,
			`${FIXTURE_DIR}/c-globalthis-bun.ts [primitive]`,
			`${FIXTURE_DIR}/d-process-binding.ts [primitive]`,
			`${FIXTURE_DIR}/e-destructure-rename.ts [primitive]`,
			`${FIXTURE_DIR}/f-reexport-caller.ts [launcher]`,
			`${FIXTURE_DIR}/g-concatenated-name.ts [primitive]`,
			`${FIXTURE_DIR}/h-fork.ts [primitive]`,
			`${FIXTURE_DIR}/i-dynamic-import-const.ts [launcher]`,
			`${FIXTURE_DIR}/j-dynamic-import-computed.ts [launcher]`,
			`${FIXTURE_DIR}/j-dynamic-import-computed.ts [primitive]`,
			`${FIXTURE_DIR}/k-reexport-deep-caller.ts [launcher]`,
			`${FIXTURE_DIR}/k-reexport-deep-caller.ts [primitive]`,
			`${FIXTURE_DIR}/n-let-reassigned-specifier.ts [launcher]`,
			`${FIXTURE_DIR}/n-let-reassigned-specifier.ts [primitive]`,
			`${NEGATIVE_ALLOWLISTED} [launcher]`, // sorts between `n-` and `o-`
			`${FIXTURE_DIR}/o-var-specifier.ts [launcher]`,
			`${FIXTURE_DIR}/o-var-specifier.ts [primitive]`,
			`${FIXTURE_DIR}/p-const-from-const.ts [launcher]`,
			`${FIXTURE_DIR}/p-const-from-const.ts [primitive]`,
		]);
		// (l) and (m) are BARE imports: they call nothing, so they are not
		// violations even with nothing allowlisted. They are caught by the
		// `unresolved` channel instead (next test), which has no allowlist.
		const files = new Set(result.violations.map((f) => f.file));
		expect(files.has(`${FIXTURE_DIR}/l-bare-import-computed.ts`)).toBe(false);
		expect(files.has(`${FIXTURE_DIR}/m-bare-require-computed.ts`)).toBe(false);
	});

	test("GREEN: allowlisting only the intended caller leaves exactly the fourteen evasions", async () => {
		const result = await analyzeFixtures(new Set([NEGATIVE_ALLOWLISTED]));
		// The ONLY undecidable places in the fixture set are the deliberate
		// ones: (j) computed specifiers, (k) the ninth `export *` hop, (l)/(m)
		// BARE computed imports, (n)/(o) `let`/`var` specifiers, (p) a two-hop
		// const. Fixture (i) is NOT here — its const-string specifier resolves
		// (rung 3) — and neither is `negative-bare-literal-import.ts`, whose
		// bare imports are literals.
		expect(result.unresolved).toEqual([
			{
				kind: "dynamic-import",
				file: `${FIXTURE_DIR}/j-dynamic-import-computed.ts`,
				line: 16,
				// biome-ignore lint/suspicious/noTemplateCurlyInString: the expected SOURCE TEXT of the fixture's computed specifier, not a template
				text: "import(`${dir}/${stem}.js`)",
			},
			{
				kind: "dynamic-import",
				file: `${FIXTURE_DIR}/j-dynamic-import-computed.ts`,
				line: 22,
				text: 'require(dir + "/" + stem + ".js")',
			},
			{
				kind: "reexport-depth",
				file: `${FIXTURE_DIR}/k-reexport-deep-hop9.ts`,
				line: 6,
				text: `export * chain exceeds ${REEXPORT_DEPTH_LIMIT} hops while resolving "launch"`,
			},
			{
				kind: "dynamic-import",
				file: `${FIXTURE_DIR}/l-bare-import-computed.ts`,
				line: 20,
				text: "import(moduleName)",
			},
			{
				kind: "dynamic-import",
				file: `${FIXTURE_DIR}/m-bare-require-computed.ts`,
				line: 10,
				text: "require(moduleName)",
			},
			{
				kind: "dynamic-import",
				file: `${FIXTURE_DIR}/n-let-reassigned-specifier.ts`,
				line: 15,
				text: "import(moduleName)",
			},
			{
				kind: "dynamic-import",
				file: `${FIXTURE_DIR}/o-var-specifier.ts`,
				line: 9,
				text: "import(moduleName)",
			},
			{
				kind: "dynamic-import",
				file: `${FIXTURE_DIR}/p-const-from-const.ts`,
				line: 16,
				text: "import(ALIAS)",
			},
		]);
		expect(verdicts(result.violations)).toEqual([
			// (a) the round-8 shape: a local-module import.
			`${FIXTURE_DIR}/a-imports-launcher.ts [launcher]`,
			// (b) `const runtime = Bun; runtime.spawn`.
			`${FIXTURE_DIR}/b-bun-alias.ts [primitive]`,
			// (c) `globalThis["Bun"].spawn`.
			`${FIXTURE_DIR}/c-globalthis-bun.ts [primitive]`,
			// (d) `process["binding"]`.
			`${FIXTURE_DIR}/d-process-binding.ts [primitive]`,
			// (e) `const { spawn: s } = cp; s(...)`.
			`${FIXTURE_DIR}/e-destructure-rename.ts [primitive]`,
			// (f) two-hop re-export chain: `export *` over `export { x as y } from`.
			`${FIXTURE_DIR}/f-reexport-caller.ts [launcher]`,
			// (g) `spawn(parts.join(""))` — caught by the KIND rule; the argument
			//     is never read.
			`${FIXTURE_DIR}/g-concatenated-name.ts [primitive]`,
			// (h) `fork`.
			`${FIXTURE_DIR}/h-fork.ts [primitive]`,
			// (i) `import(LAUNCHER)` with a same-file const — RESOLVED, so it is
			//     the launcher kind only, exactly like (a).
			`${FIXTURE_DIR}/i-dynamic-import-const.ts [launcher]`,
			// (j) `import(\`${dir}/${stem}.js\`)` — undecidable, so FAIL CLOSED:
			//     both kinds, and an `unresolved` entry (asserted above).
			`${FIXTURE_DIR}/j-dynamic-import-computed.ts [launcher]`,
			`${FIXTURE_DIR}/j-dynamic-import-computed.ts [primitive]`,
			// (k) nine `export *` hops, one past REEXPORT_DEPTH_LIMIT — the
			//     same fail-closed verdict as (j).
			`${FIXTURE_DIR}/k-reexport-deep-caller.ts [launcher]`,
			`${FIXTURE_DIR}/k-reexport-deep-caller.ts [primitive]`,
			// (n) `let m = "harmless"; m = launcher; import(m)` — a `let` is
			//     never a const string, so the STALE literal is not used: fail
			//     closed, both kinds.
			`${FIXTURE_DIR}/n-let-reassigned-specifier.ts [launcher]`,
			`${FIXTURE_DIR}/n-let-reassigned-specifier.ts [primitive]`,
			// (o) the `var` form of (n).
			`${FIXTURE_DIR}/o-var-specifier.ts [launcher]`,
			`${FIXTURE_DIR}/o-var-specifier.ts [primitive]`,
			// (p) `const B = A` — rung 3 is ONE hop; a two-hop const fails closed.
			`${FIXTURE_DIR}/p-const-from-const.ts [launcher]`,
			`${FIXTURE_DIR}/p-const-from-const.ts [primitive]`,
		]);

		// The negatives, by name, so a silent one is a proven silence and not
		// an absence nobody looked for.
		const files = new Set(result.violations.map((f) => f.file));
		expect(files.has(NEGATIVE_ALLOWLISTED)).toBe(false);
		expect(files.has(`${FIXTURE_DIR}/negative-non-launch-api.ts`)).toBe(false);
		// Bare LITERAL imports resolve silently: not a violation, not
		// unresolved (asserted exhaustively above), nothing acquired.
		const bareLiteral = `${FIXTURE_DIR}/negative-bare-literal-import.ts`;
		expect(files.has(bareLiteral)).toBe(false);
		expect(result.acquired.primitive.has(bareLiteral)).toBe(false);
		expect(result.acquired.launcher.has(bareLiteral)).toBe(false);
		// (l)/(m) bind nothing and call nothing: their ONLY trace is the
		// `unresolved` entry — which is enough, because that channel fails the
		// production tree with no allowlist to hide behind.
		for (const bare of [
			`${FIXTURE_DIR}/l-bare-import-computed.ts`,
			`${FIXTURE_DIR}/m-bare-require-computed.ts`,
		]) {
			expect(files.has(bare)).toBe(false);
			expect(result.acquired.primitive.has(bare)).toBe(false);
			expect(result.acquired.launcher.has(bare)).toBe(false);
		}
		expect(files.has(`${FIXTURE_DIR}/f-reexport-hop1.ts`)).toBe(false);
		expect(files.has(`${FIXTURE_DIR}/f-reexport-hop2.ts`)).toBe(false);
		for (let hop = 1; hop <= 10; hop++) {
			expect(files.has(`${FIXTURE_DIR}/k-reexport-deep-hop${hop}.ts`)).toBe(
				false,
			);
		}

		// (i) fired through RESOLUTION, not through the fail-closed path: its
		// callee carries the real module namespace, never the blanket taint.
		const i = result.violations.filter((f) =>
			f.file.endsWith("i-dynamic-import-const.ts"),
		);
		expect(i.map((f) => f.kind)).toEqual(["launcher"]);
		expect(i[0]?.line).toBe(14);
		// (j) is on the CALL line, not the import line — the graph rule fires
		// where the capability is USED, as with every other fixture.
		const j = result.violations.filter((f) =>
			f.file.endsWith("j-dynamic-import-computed.ts"),
		);
		expect(j.map((f) => f.line)).toEqual([17, 17, 23, 23]);

		// The allowlisted negative still CALLED — it is a recorded launch, not
		// an invisible one.
		expect(filesCalling(result, "launcher").has(NEGATIVE_ALLOWLISTED)).toBe(
			true,
		);
		// The non-launch negative bound nothing of either kind.
		expect(
			result.acquired.primitive.has(
				`${FIXTURE_DIR}/negative-non-launch-api.ts`,
			),
		).toBe(false);
		expect(
			result.acquired.launcher.has(`${FIXTURE_DIR}/negative-non-launch-api.ts`),
		).toBe(false);
	});

	test("the finding is on the CALL line, after the alias — not on the import", async () => {
		// (e) is the case: the import is line 9, the destructure line 11, the
		// call line 14. A rule that fired on the import would be the sweep again.
		const result = await analyzeFixtures(new Set([NEGATIVE_ALLOWLISTED]));
		const e = result.violations.find((f) =>
			f.file.endsWith("e-destructure-rename.ts"),
		);
		expect(e?.text).toBe('s("ls", ["-la"])');
		expect(e?.line).toBe(14);
		const b = result.violations.find((f) => f.file.endsWith("b-bun-alias.ts"));
		expect(b?.text).toBe('runtime.spawn(["ls", "-la"])');
	});
});

describe("launch-capability graph — the two fail-closed edges, at the exact bound", () => {
	// Built in a temp dir, NOT under the fixture dir: the point is to vary the
	// chain length around `REEXPORT_DEPTH_LIMIT` and prove the constant is
	// exact, which one committed fixture cannot do. The temp tree carries its
	// own stand-in launcher (`launcherPath` is a path, and the launcher is a
	// source BY PATH), so nothing here reads or names the real one. Nothing is
	// executed; the analyzer parses and walks.
	const tmpRoots: string[] = [];
	afterAll(() => {
		for (const dir of tmpRoots) rmSync(dir, { recursive: true, force: true });
	});

	function freshTree(prefix: string): { repoRoot: string; src: string } {
		const repoRoot = mkdtempSync(join(tmpdir(), prefix));
		tmpRoots.push(repoRoot);
		const src = join(repoRoot, "src");
		mkdirSync(src);
		writeFileSync(join(src, "launcher.ts"), "export function go() {}\n");
		return { repoRoot, src };
	}

	function analyzeTree(repoRoot: string, src: string) {
		return analyzeLaunchCapabilities({
			repoRoot,
			roots: [src],
			launcherPath: "src/launcher.ts",
			primitiveAllowlist: new Set(),
			launcherCallerAllowlist: new Set(),
		});
	}

	/** caller -> hop1 -> ... -> hopN (each `export *`) -> tail (rename) -> launcher. */
	async function analyzeChain(starHops: number) {
		const { repoRoot, src } = freshTree("lcg-depth-");
		writeFileSync(
			join(src, "tail.ts"),
			'export { go as launch } from "./launcher.js";\n',
		);
		for (let i = 1; i <= starHops; i++) {
			const next = i === starHops ? "tail" : `hop${i + 1}`;
			writeFileSync(join(src, `hop${i}.ts`), `export * from "./${next}.js";\n`);
		}
		writeFileSync(
			join(src, "caller.ts"),
			'import { launch } from "./hop1.js";\nexport function run() { launch(); }\n',
		);
		return analyzeTree(repoRoot, src);
	}

	test(`exactly REEXPORT_DEPTH_LIMIT (${REEXPORT_DEPTH_LIMIT}) star hops RESOLVE: launcher kind only, nothing unresolved`, async () => {
		const result = await analyzeChain(REEXPORT_DEPTH_LIMIT);
		expect(result.unresolved).toEqual([]);
		expect(verdicts(result.violations)).toEqual(["src/caller.ts [launcher]"]);
	});

	test("one hop past the bound FAILS CLOSED: both kinds, and a `reexport-depth` entry at the refused hop", async () => {
		const result = await analyzeChain(REEXPORT_DEPTH_LIMIT + 1);
		expect(verdicts(result.violations)).toEqual([
			"src/caller.ts [launcher]",
			"src/caller.ts [primitive]",
		]);
		expect(result.unresolved).toEqual([
			{
				kind: "reexport-depth",
				// The (LIMIT+1)th `export *` is the one not followed.
				file: `src/hop${REEXPORT_DEPTH_LIMIT + 1}.ts`,
				line: 1,
				text: `export * chain exceeds ${REEXPORT_DEPTH_LIMIT} hops while resolving "launch"`,
			},
		]);
	});

	test("every rung of the specifier ladder, in one file: literal, template, const resolve; the rest fail closed", async () => {
		const { repoRoot, src } = freshTree("lcg-ladder-");
		writeFileSync(join(src, "harmless.ts"), "export function noop() {}\n");
		writeFileSync(
			join(src, "ladder.ts"),
			[
				'const HARMLESS = "./harmless.js";',
				"const which = process.argv[2];",
				'export async function a() { (await import("./harmless.js")).noop(); }', // rung 1
				"export async function b() { (await import(`./harmless.js`)).noop(); }", // rung 2
				"export async function c() { (await import(HARMLESS)).noop(); }", // rung 3
				"export async function d() { (await import(which)).noop(); }", // identifier, not a const string
				// biome-ignore lint/suspicious/noTemplateCurlyInString: source text WRITTEN to the temp file; the substitution must survive into it
				"export async function e() { (await import(`./${which}.js`)).noop(); }", // substitution
				'export async function f() { (await import("./" + which)).noop(); }', // concatenation
				"export async function g() { (await import(pick())).noop(); }", // call
				"function pick() { return HARMLESS; }",
				"",
			].join("\n"),
		);
		const result = await analyzeTree(repoRoot, src);
		// Rungs 1–3 resolved to a module that carries nothing, so they are
		// silent — a resolved specifier is judged on what it loads. d–g are
		// undecidable and fire with BOTH kinds, each recorded once.
		expect(result.violations.map((f) => `${f.line} [${f.kind}]`)).toEqual([
			"6 [launcher]",
			"6 [primitive]",
			"7 [launcher]",
			"7 [primitive]",
			"8 [launcher]",
			"8 [primitive]",
			"9 [launcher]",
			"9 [primitive]",
		]);
		expect(
			result.unresolved.map((u) => `${u.line} ${u.kind} ${u.text}`),
		).toEqual([
			"6 dynamic-import import(which)",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: expected source text of the recorded specifier
			"7 dynamic-import import(`./${which}.js`)",
			'8 dynamic-import import("./" + which)',
			"9 dynamic-import import(pick())",
		]);
	});

	test("rung 3 is `const` ONLY, one hop, unshadowed: every other binding of the name poisons it", async () => {
		// Bindings are flat per file, so a name that is a const string in one
		// place and ANYTHING else in another is not a constant: a `let`/`var`
		// (reassignable), a `const` initialised from another const (two hops),
		// a parameter, a destructuring pattern, a `for…of` head, a `catch`
		// binding, an import, or a plain assignment target. Each shape below
		// is a spelling by which `import(NAME)` could otherwise resolve to a
		// stale or wrong literal; each must fail CLOSED (both kinds + an
		// `unresolved` entry). The last two are the controls: a clean const
		// resolves (silent), and a bare LITERAL import is not unresolved.
		const { repoRoot, src } = freshTree("lcg-const-only-");
		writeFileSync(join(src, "harmless.ts"), "export function noop() {}\n");
		writeFileSync(join(src, "other.ts"), 'export const IMPORTED = "x";\n');
		writeFileSync(
			join(src, "consts.ts"),
			[
				'import { IMPORTED } from "./other.js";', // 1
				'let LET_NAME = "./harmless.js";', // 2
				'var VAR_NAME = "./harmless.js";', // 3
				'const ONE_HOP = "./harmless.js";', // 4
				"const TWO_HOP = ONE_HOP;", // 5
				'const PARAM = "./harmless.js";', // 6
				'const DESTRUCTURED = "./harmless.js";', // 7
				'const LOOPED = "./harmless.js";', // 8
				'const CAUGHT = "./harmless.js";', // 9
				'const ASSIGNED = "./harmless.js";', // 10
				'const TWICE = "./harmless.js";', // 11
				'const CLEAN = "./harmless.js";', // 12
				"export async function a() { (await import(LET_NAME)).noop(); }", // 13
				"export async function b() { (await import(VAR_NAME)).noop(); }", // 14
				"export async function c() { (await import(TWO_HOP)).noop(); }", // 15
				"export async function d(PARAM: string) { (await import(PARAM)).noop(); }", // 16
				"export async function e(o: { DESTRUCTURED: string }) { const { DESTRUCTURED } = o; (await import(DESTRUCTURED)).noop(); }", // 17
				"export async function f(xs: string[]) { for (const LOOPED of xs) (await import(LOOPED)).noop(); }", // 18
				"export async function g() { try { throw 0; } catch (CAUGHT) { (await import(CAUGHT)).noop(); } }", // 19
				"export async function h(next: string) { ASSIGNED = next; (await import(ASSIGNED)).noop(); }", // 20
				'export async function i() { { const TWICE = "./elsewhere.js"; } (await import(TWICE)).noop(); }', // 21
				"export async function j() { (await import(IMPORTED)).noop(); }", // 22
				"export async function k() { (await import(CLEAN)).noop(); }", // 23 control: resolves
				'export async function l() { await import("./harmless.js"); require("./harmless.js"); }', // 24 control: bare literals
				"export async function m() { await import(LET_NAME); }", // 25 bare computed: unresolved, NOT a violation
				"",
			].join("\n"),
		);
		const result = await analyzeTree(repoRoot, src);
		const unresolvedLines = result.unresolved.map(
			(u) => `${u.line} ${u.kind} ${u.text}`,
		);
		expect(unresolvedLines).toEqual([
			"13 dynamic-import import(LET_NAME)",
			"14 dynamic-import import(VAR_NAME)",
			"15 dynamic-import import(TWO_HOP)",
			"16 dynamic-import import(PARAM)",
			"17 dynamic-import import(DESTRUCTURED)",
			"18 dynamic-import import(LOOPED)",
			"19 dynamic-import import(CAUGHT)",
			"20 dynamic-import import(ASSIGNED)",
			"21 dynamic-import import(TWICE)",
			"22 dynamic-import import(IMPORTED)",
			"25 dynamic-import import(LET_NAME)",
		]);
		// Lines 13–22 fire with both kinds; 23 resolved to a harmless module
		// (silent); 24 is literal (silent); 25 is bare (unresolved only).
		expect(
			[...new Set(result.violations.map((f) => f.line))].sort((x, y) => x - y),
		).toEqual([13, 14, 15, 16, 17, 18, 19, 20, 21, 22]);
		for (const f of result.violations)
			expect(["launcher", "primitive"]).toContain(f.kind);
		expect(result.violations.length).toBe(20);
	});
});
