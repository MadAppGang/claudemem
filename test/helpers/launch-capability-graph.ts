/**
 * LAUNCH-CAPABILITY GRAPH — an AST-based, import- and alias-resolving rule.
 *
 * THE FINDING (round 8, external review, HIGH 2 — PARTIAL). The regex sweep in
 * `test/unit/core/keychain.test.ts` recognises PRIMITIVE acquisitions of a
 * process-launch capability (`node:child_process` imports, `Bun.spawn*`,
 * `Bun.$`, `$`/`spawn` from `"bun"`). It cannot see a capability obtained by
 * IMPORTING A LOCAL MODULE (a non-allowlisted file importing the launcher and
 * passing `"mnemex"` passed CI), nor aliases: `const runtime = Bun;
 * runtime.spawn(...)`, `globalThis["Bun"].spawn(...)`, `process["binding"]`,
 * `const { spawn: s } = cp`, and re-export chains.
 *
 * This module is the architectural enforcement layered ON TOP of that sweep.
 * The sweep stays: it is a cheap, fail-closed tripwire with no parser to
 * mis-handle. This rule is the one that understands bindings.
 *
 * WHY TREE-SITTER AND NOT THE TYPESCRIPT COMPILER API. `typescript@7` in this
 * tree is the native (Go) port: `node_modules/typescript/lib` holds only
 * `tsc.js` and `version.cjs`, `ts.createSourceFile` is `undefined`, and its
 * one JS API (`typescript/unstable/sync`) is a `Client` that SPAWNS the Go
 * binary — which would put a process launch inside the test that forbids
 * process launches. The tree already ships a real AST parser with TypeScript
 * and TSX grammars (`web-tree-sitter` + `grammars/*.wasm`, the same parser
 * mnemex indexes code with), so no dependency is added. It is a parser, not a
 * type checker: there is no symbol table, so resolution is done here.
 *
 * WHAT IT DOES. Nothing here executes a file. Every file is READ, parsed, and
 * walked; the result is a set of findings the test asserts on.
 *
 *   1. CAPABILITY SOURCES — see `moduleSourceTag` and `taintOfIdentifier`.
 *   2. INTRA-FILE TAINT — `taintOf` + `bindPattern`, to a per-file fixpoint.
 *   3. CROSS-FILE RESOLUTION — an import graph over the scanned roots, with
 *      `.js`→`.ts`/`.tsx`, index files, `export { a as b } from`, `export *`,
 *      `export default`, and re-export chains to a bounded depth with cycle
 *      protection. Iterated to a global fixpoint.
 *   4. THE RULE — a file that CALLS (or tags, for `$`) a tainted binding is a
 *      violation of that capability's KIND unless it is on the allowlist for
 *      that kind. Importing without calling is reported as INFO, never as a
 *      violation, so drift stays visible.
 *
 * DOCUMENTED LIMITS (best effort, each biased fail-CLOSED where it matters):
 *   - Bindings are tracked by NAME, flat per file — block scoping and
 *     shadowing are ignored. A shadowed name inherits the union of every
 *     binding of that name in the file, which can only ADD findings.
 *   - A function is NOT tainted by what its body calls. A wrapper that spawns
 *     fires as a violation in its own file (the existing allowlist policy); it
 *     does not become a source for its callers. The ONE module whose exports
 *     are all treated as sources is the entry-point launcher, by path.
 *   - Parameter taint follows a call ONLY within the same file: calling a
 *     local function with a tainted argument taints that parameter by name
 *     (and `this.<name>` for constructor parameter properties). Injection
 *     through a constructor called in ANOTHER file (`new DebounceReindexer(…,
 *     spawnDetachedReindex)`) is not followed — the injected value is itself
 *     obtainable only from the launcher, and the rule fires there.
 *   - A call's RESULT inherits the taint of its ARGUMENTS, not its callee, so
 *     `promisify(exec)` yields a launcher and `spawn(...)` yields a child that
 *     is not one. `new X(tainted)` does not propagate.
 *   - Object and array literals carry the union of their members' taint.
 *   - Computed keys resolve for string literals, substitution-free templates
 *     and same-file `const NAME = "literal"`; an UNRESOLVABLE key on `Bun`,
 *     `process`, `globalThis` or a namespace import is treated as "could be
 *     anything" and taints conservatively.
 *   - `import(x)` / `require(x)` specifiers climb the SAME ladder (literal,
 *     substitution-free template, same-file const). Anything else — an
 *     identifier that is not a same-file const, a template with a
 *     substitution, a concatenation, a call — is recorded in `unresolved` as
 *     `dynamic-import` AND the namespace is tainted with BOTH kinds. Round 9's
 *     external review found the previous behaviour (empty taint, nothing
 *     recorded) let `const m = "../core/entry-point-launcher.js"; await
 *     import(m)` pass every rule.
 *   - `export *` chains are followed to `REEXPORT_DEPTH_LIMIT` hops. One hop
 *     past the bound is recorded in `unresolved` as `reexport-depth` and
 *     taints BOTH kinds; it does not silently return empty.
 *   - A relative specifier that resolves to no file is recorded in
 *     `unresolved` as `specifier` and contributes no taint. Non-relative
 *     specifiers other than the known launch packages contribute none either.
 *
 * `unresolved` is LOAD-BEARING: the production-tree test asserts it is empty.
 * Every entry is a place the analyzer could not decide, and an undecidable
 * place is treated as a violation, never as an absence of evidence. That is
 * the same fail-closed stance as the keychain adapter's three vetoes.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import type { Node, Parser } from "web-tree-sitter";
import { getParserManager } from "../../src/parsers/parser-manager.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** The two capability kinds, each with its own allowlist. */
export type CapabilityKind = "primitive" | "launcher";

export interface LaunchFinding {
	/** Repo-relative path. */
	file: string;
	/** 1-based. */
	line: number;
	kind: CapabilityKind;
	/** The call/tag expression, trimmed to one line. */
	text: string;
	/** Which tags the callee carried, for diagnosis. */
	via: string[];
}

export interface AcquisitionInfo {
	file: string;
	kind: CapabilityKind;
	/** Names bound in this file that carry the capability. */
	bindings: string[];
}

export interface AnalyzeOptions {
	/** Absolute repo root; all reported paths are relative to it. */
	repoRoot: string;
	/** Absolute directories whose `.ts`/`.tsx` files are subject to the rule. */
	roots: string[];
	/** Repo-relative path of the entry-point launcher module. */
	launcherPath: string;
	/** Repo-relative files allowed to call a PRIMITIVE launch capability. */
	primitiveAllowlist: ReadonlySet<string>;
	/** Repo-relative files allowed to call the LAUNCHER's exports. */
	launcherCallerAllowlist: ReadonlySet<string>;
	/** Skip paths containing any of these fragments (e.g. fixture dirs). */
	exclude?: string[];
}

/**
 * How many `export *` hops `lookupExport` follows before it stops deciding.
 * At the bound the analyzer FAILS CLOSED: the chain is recorded in
 * `unresolved` as `reexport-depth` and treated as carrying both kinds. Stated
 * in `test/testdata/launch-capability/README.md`; fixture `k-*` is one hop
 * past it.
 */
export const REEXPORT_DEPTH_LIMIT = 8;

/**
 * A place the analyzer could NOT decide. Each kind is fail-closed in its own
 * way, and the production-tree test asserts the list is EMPTY.
 *
 *   specifier       a relative import path that resolves to no file
 *   dynamic-import  `import(x)`/`require(x)` whose specifier is not a literal,
 *                   a substitution-free template or a same-file const string;
 *                   the namespace is tainted with BOTH kinds
 *   reexport-depth  an `export *` chain deeper than `REEXPORT_DEPTH_LIMIT`;
 *                   the lookup yields BOTH kinds
 */
export interface UnresolvedEntry {
	kind: "specifier" | "dynamic-import" | "reexport-depth";
	/** Repo-relative path of the file holding the undecidable construct. */
	file: string;
	/** 1-based line of that construct. */
	line: number;
	/** The construct, trimmed to one line. */
	text: string;
}

export interface AnalyzeResult {
	/** Every tainted call, allowlisted or not. */
	calls: LaunchFinding[];
	/** Calls NOT covered by the allowlist for their kind. */
	violations: LaunchFinding[];
	/** Files that hold a capability binding but never call it. */
	importOnly: AcquisitionInfo[];
	/** Every file that acquired a capability of each kind (for no-rot checks). */
	acquired: Record<CapabilityKind, Set<string>>;
	/** Every place the analyzer could not decide. Asserted EMPTY on `src/`. */
	unresolved: UnresolvedEntry[];
	filesScanned: number;
	/** Global fixpoint passes taken. */
	passes: number;
	/** Wall-clock milliseconds for the whole analysis. */
	elapsedMs: number;
}

// ---------------------------------------------------------------------------
// Taint tags
// ---------------------------------------------------------------------------

/**
 * A taint is a set of tags. The two that constitute a finding when CALLED are
 * `primitive` and `launcher`. The rest are intermediate: they describe a
 * value from which a finding can be reached by member access.
 *
 *   bun-global      the `Bun` object (or an alias of it)
 *   process-global  the `process` object
 *   globalThis      `globalThis`
 *   cp-ns           a namespace over `node:child_process` (every member launches)
 *   runner-ns       a namespace over a third-party runner package
 *   ns:<abs path>   a namespace import of a local module (members resolve
 *                   through that module's export table)
 */
type Taint = Set<string>;

const EMPTY: Taint = new Set();
const FINDING_TAGS: ReadonlySet<string> = new Set(["primitive", "launcher"]);

const CHILD_PROCESS_SPECIFIERS = new Set([
	"node:child_process",
	"child_process",
]);
const RUNNER_PACKAGES = new Set([
	"execa",
	"zx",
	"cross-spawn",
	"shelljs",
	"tinyexec",
	"nano-spawn",
	"child-process-promise",
	"promisify-child-process",
]);
const BUN_LAUNCH_MEMBERS = new Set(["spawn", "spawnSync", "$"]);

function union(...taints: Taint[]): Taint {
	const out: Taint = new Set();
	for (const t of taints) for (const tag of t) out.add(tag);
	return out;
}

function findingsOnly(t: Taint): Taint {
	const out: Taint = new Set();
	for (const tag of t) if (FINDING_TAGS.has(tag)) out.add(tag);
	return out;
}

function sameTaint(a: Taint | undefined, b: Taint | undefined): boolean {
	if (!a || !b) return a === b;
	if (a.size !== b.size) return false;
	for (const tag of a) if (!b.has(tag)) return false;
	return true;
}

// ---------------------------------------------------------------------------
// Module records
// ---------------------------------------------------------------------------

interface ModuleRecord {
	abs: string;
	rel: string;
	root: Node;
	/** Flat, by name. `this.<prop>` keys hold class-field taint. */
	bindings: Map<string, Taint>;
	/** Same-file `const NAME = "literal"` for computed-key resolution. */
	constStrings: Map<string, string>;
	/** Local function declarations, for parameter taint. */
	localFunctions: Map<string, string[]>;
	exports: Map<string, Taint>;
	/** `export * from` targets, with the line of the statement (for reports). */
	starReexports: { abs: string; line: number }[];
	/** Whether this module is subject to the rule (under a scanned root). */
	inScope: boolean;
}

// ---------------------------------------------------------------------------
// The analyzer
// ---------------------------------------------------------------------------

class LaunchCapabilityAnalyzer {
	private readonly modules = new Map<string, ModuleRecord | null>();
	/** Keyed by kind|file|line|text so fixpoint re-visits do not duplicate. */
	private readonly unresolved = new Map<string, UnresolvedEntry>();
	private readonly launcherAbs: string;
	private tsParser: Parser | null = null;
	private tsxParser: Parser | null = null;

	constructor(private readonly options: AnalyzeOptions) {
		this.launcherAbs = resolve(options.repoRoot, options.launcherPath);
	}

	// -- setup ---------------------------------------------------------------

	async init(): Promise<void> {
		const manager = getParserManager();
		await manager.initialize();
		this.tsParser = await manager.getParser("typescript");
		this.tsxParser = await manager.getParser("tsx");
		if (!this.tsParser || !this.tsxParser) {
			throw new Error(
				"launch-capability-graph: TypeScript/TSX grammars are missing — run `bun run download-grammars`",
			);
		}
	}

	private excluded(abs: string): boolean {
		return (this.options.exclude ?? []).some((frag) => abs.includes(frag));
	}

	private async collectRootFiles(): Promise<string[]> {
		const glob = new Bun.Glob("**/*.{ts,tsx}");
		const files: string[] = [];
		for (const root of this.options.roots) {
			for await (const abs of glob.scan({ cwd: root, absolute: true })) {
				if (abs.endsWith(".d.ts")) continue;
				if (this.excluded(abs)) continue;
				files.push(abs);
			}
		}
		return files.sort();
	}

	private load(abs: string, inScope: boolean): ModuleRecord | null {
		const cached = this.modules.get(abs);
		if (cached !== undefined) {
			if (cached && inScope) cached.inScope = true;
			return cached;
		}
		const ext = extname(abs);
		if (ext !== ".ts" && ext !== ".tsx" && ext !== ".mts") {
			this.modules.set(abs, null);
			return null;
		}
		const parser = ext === ".tsx" ? this.tsxParser : this.tsParser;
		const source = readFileSync(abs, "utf-8");
		const tree = parser?.parse(source);
		if (!tree) {
			this.modules.set(abs, null);
			return null;
		}
		const record: ModuleRecord = {
			abs,
			rel: relative(this.options.repoRoot, abs),
			root: tree.rootNode,
			bindings: new Map(),
			constStrings: new Map(),
			localFunctions: new Map(),
			exports: new Map(),
			starReexports: [],
			inScope,
		};
		this.modules.set(abs, record);
		return record;
	}

	// -- module resolution ---------------------------------------------------

	private recordUnresolved(entry: UnresolvedEntry): void {
		const text = entry.text.split("\n")[0]?.trim().slice(0, 120) ?? "";
		const normalised = { ...entry, text };
		this.unresolved.set(
			`${normalised.kind}|${normalised.file}|${normalised.line}|${normalised.text}`,
			normalised,
		);
	}

	/** Resolve a relative specifier to an absolute file, or null. */
	private resolveRelative(fromAbs: string, spec: string): string | null {
		const base = resolve(dirname(fromAbs), spec);
		const candidates: string[] = [];
		const push = (p: string) => {
			if (!candidates.includes(p)) candidates.push(p);
		};
		push(base);
		if (/\.(js|jsx|mjs|cjs)$/.test(base)) {
			const stem = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
			push(`${stem}.ts`);
			push(`${stem}.tsx`);
			push(`${stem}.mts`);
		}
		push(`${base}.ts`);
		push(`${base}.tsx`);
		push(join(base, "index.ts"));
		push(join(base, "index.tsx"));
		for (const c of candidates) {
			if (existsSync(c) && statSync(c).isFile()) return c;
		}
		return null;
	}

	/**
	 * What taint tag a module specifier contributes as a NAMESPACE. Returns
	 * `null` for specifiers that carry no launch capability.
	 */
	private moduleSourceTag(
		fromAbs: string,
		spec: string,
		line: number,
	): string | null {
		if (CHILD_PROCESS_SPECIFIERS.has(spec)) return "cp-ns";
		if (RUNNER_PACKAGES.has(spec)) return "runner-ns";
		if (spec === "bun") return "bun-global";
		if (spec.startsWith(".") || spec.startsWith("/")) {
			const abs = this.resolveRelative(fromAbs, spec);
			if (!abs) {
				this.recordUnresolved({
					kind: "specifier",
					file: relative(this.options.repoRoot, fromAbs),
					line,
					text: spec,
				});
				return null;
			}
			return `ns:${abs}`;
		}
		return null;
	}

	/**
	 * The taint of `import(<arg>)` / `require(<arg>)`.
	 *
	 * The specifier climbs the same ladder as a computed member key (`keyOf`):
	 * string literal, substitution-free template, same-file `const NAME =
	 * "literal"`. Anything else FAILS CLOSED: it is recorded in `unresolved`
	 * as `dynamic-import` and the namespace is tainted with BOTH capability
	 * kinds. Rationale: a computed specifier cannot be proven NOT to load a
	 * launch capability, so a non-allowlisted file that performs one is a
	 * violation by construction — the same fail-closed stance as the keychain
	 * adapter's three vetoes. Round 9's review showed the alternative (empty
	 * taint, nothing recorded) made `import(moduleName)` invisible to both
	 * enforcement layers.
	 */
	private importCallTaint(mod: ModuleRecord, call: Node): Taint {
		const F = LaunchCapabilityAnalyzer.field;
		const args = F(call, "arguments");
		const arg = args
			? (LaunchCapabilityAnalyzer.namedChildren(args)[0] ?? null)
			: null;
		const spec = this.keyOf(mod, arg);
		if (spec === null) {
			this.recordUnresolved({
				kind: "dynamic-import",
				file: mod.rel,
				line: call.startPosition.row + 1,
				text: call.text,
			});
			return new Set(["primitive", "launcher"]);
		}
		const tag = this.moduleSourceTag(mod.abs, spec, call.startPosition.row + 1);
		return tag ? new Set([tag]) : EMPTY;
	}

	/** The taint of `export <name>` from the module behind a namespace tag. */
	private exportTaint(nsTag: string, name: string | null): Taint {
		if (nsTag === "cp-ns" || nsTag === "runner-ns")
			return new Set(["primitive"]);
		if (nsTag === "bun-global") {
			// `import { $ } from "bun"` / `import * as bun from "bun"`.
			if (name === null || BUN_LAUNCH_MEMBERS.has(name))
				return new Set(["primitive"]);
			return EMPTY;
		}
		if (!nsTag.startsWith("ns:")) return EMPTY;
		const abs = nsTag.slice(3);
		// THE LAUNCHER IS ITSELF A SOURCE: every export, whatever it is.
		if (abs === this.launcherAbs) return new Set(["launcher"]);
		return this.lookupExport(abs, name, new Set(), 0);
	}

	private lookupExport(
		abs: string,
		name: string | null,
		visited: Set<string>,
		depth: number,
	): Taint {
		// A cycle contributes nothing NEW: the module is already on the path
		// being summed, so returning empty here is not fail-open.
		if (visited.has(abs)) return EMPTY;
		visited.add(abs);
		if (abs === this.launcherAbs) return new Set(["launcher"]);
		const mod = this.load(abs, false);
		if (!mod) return EMPTY;
		let out: Taint = new Set();
		if (name === null) {
			for (const t of mod.exports.values()) out = union(out, t);
		} else {
			const own = mod.exports.get(name);
			if (own) out = union(out, own);
		}
		// `export * from` chains, bounded and cycle-safe. `depth` counts the
		// star hops already taken to reach `mod`; the hop that would exceed
		// `REEXPORT_DEPTH_LIMIT` is NOT followed — it is recorded and FAILS
		// CLOSED with both kinds, because a chain the analyzer stopped reading
		// cannot be proven not to end at a launch capability.
		if (name === null || !mod.exports.has(name)) {
			for (const star of mod.starReexports) {
				if (depth >= REEXPORT_DEPTH_LIMIT) {
					this.recordUnresolved({
						kind: "reexport-depth",
						file: mod.rel,
						line: star.line,
						text: `export * chain exceeds ${REEXPORT_DEPTH_LIMIT} hops while resolving "${name ?? "*"}"`,
					});
					out = union(out, new Set(["primitive", "launcher"]));
					continue;
				}
				out = union(out, this.lookupExport(star.abs, name, visited, depth + 1));
			}
		}
		return out;
	}

	// -- AST helpers ---------------------------------------------------------

	private static field(node: Node, name: string): Node | null {
		return node.childForFieldName(name);
	}

	private static namedChildren(node: Node): Node[] {
		const out: Node[] = [];
		for (let i = 0; i < node.namedChildCount; i++) {
			const c = node.namedChild(i);
			if (c) out.push(c);
		}
		return out;
	}

	private static hasKeyword(node: Node, keyword: string): boolean {
		for (let i = 0; i < node.childCount; i++) {
			const c = node.child(i);
			if (c && !c.isNamed && c.type === keyword) return true;
		}
		return false;
	}

	/** The literal string of a `string` node, or null if it has substitutions. */
	private static stringLiteral(node: Node | null): string | null {
		if (!node) return null;
		if (node.type === "string") {
			const frags = LaunchCapabilityAnalyzer.namedChildren(node);
			if (frags.length === 0) return "";
			if (
				frags.every(
					(f) => f.type === "string_fragment" || f.type === "escape_sequence",
				)
			)
				return frags.map((f) => f.text).join("");
			return null;
		}
		if (node.type === "template_string") {
			const parts = LaunchCapabilityAnalyzer.namedChildren(node);
			if (parts.some((p) => p.type === "template_substitution")) return null;
			return parts.map((p) => p.text).join("");
		}
		return null;
	}

	/** Resolve a computed key: literal, literal template, or same-file const. */
	private keyOf(mod: ModuleRecord, index: Node | null): string | null {
		if (!index) return null;
		const lit = LaunchCapabilityAnalyzer.stringLiteral(index);
		if (lit !== null) return lit;
		if (index.type === "identifier")
			return mod.constStrings.get(index.text) ?? null;
		if (index.type === "parenthesized_expression") {
			return this.keyOf(
				mod,
				LaunchCapabilityAnalyzer.namedChildren(index)[0] ?? null,
			);
		}
		return null;
	}

	// -- taint of an expression ----------------------------------------------

	private memberTaint(t: Taint, key: string | null): Taint {
		const out: Taint = new Set();
		for (const tag of t) {
			switch (tag) {
				case "cp-ns":
				case "runner-ns":
				case "primitive":
					out.add("primitive");
					break;
				case "launcher":
					out.add("launcher");
					break;
				case "bun-global":
					if (key === null || BUN_LAUNCH_MEMBERS.has(key)) out.add("primitive");
					break;
				case "process-global":
					if (key === null || key === "binding") out.add("primitive");
					break;
				case "globalThis":
					if (key === null || key === "Bun") out.add("bun-global");
					if (key === null || key === "process") out.add("process-global");
					if (key === "globalThis") out.add("globalThis");
					break;
				default:
					if (tag.startsWith("ns:")) {
						for (const x of this.exportTaint(tag, key)) out.add(x);
					}
			}
		}
		return out;
	}

	private taintOfIdentifier(mod: ModuleRecord, name: string): Taint {
		const out: Taint = new Set(mod.bindings.get(name) ?? EMPTY);
		if (name === "Bun") out.add("bun-global");
		else if (name === "process") out.add("process-global");
		else if (name === "globalThis") out.add("globalThis");
		return out;
	}

	private taintOf(mod: ModuleRecord, node: Node | null): Taint {
		if (!node) return EMPTY;
		const F = LaunchCapabilityAnalyzer.field;
		const kids = LaunchCapabilityAnalyzer.namedChildren(node);
		switch (node.type) {
			case "identifier":
			case "shorthand_property_identifier":
				return this.taintOfIdentifier(mod, node.text);
			case "member_expression": {
				const object = F(node, "object");
				const prop = F(node, "property");
				if (object?.type === "this") {
					return new Set(mod.bindings.get(`this.${prop?.text}`) ?? EMPTY);
				}
				return this.memberTaint(this.taintOf(mod, object), prop?.text ?? null);
			}
			case "subscript_expression": {
				const object = F(node, "object");
				const key = this.keyOf(mod, F(node, "index"));
				if (object?.type === "this") {
					return key
						? new Set(mod.bindings.get(`this.${key}`) ?? EMPTY)
						: EMPTY;
				}
				return this.memberTaint(this.taintOf(mod, object), key);
			}
			case "call_expression": {
				const fn = F(node, "function");
				const args = F(node, "arguments");
				// `import(x)` / `require(x)` yield the module namespace — or,
				// when `x` cannot be resolved, BOTH kinds (see importCallTaint).
				if (
					fn &&
					(fn.type === "import" ||
						(fn.type === "identifier" && fn.text === "require"))
				) {
					return this.importCallTaint(mod, node);
				}
				// A call's result carries its ARGUMENTS' finding-tags (promisify),
				// never its callee's (a spawned child is not a launcher).
				let out: Taint = new Set();
				if (args) {
					for (const a of LaunchCapabilityAnalyzer.namedChildren(args)) {
						out = union(out, findingsOnly(this.taintOf(mod, a)));
					}
				}
				return out;
			}
			case "await_expression":
			case "parenthesized_expression":
			case "as_expression":
			case "satisfies_expression":
			case "non_null_expression":
			case "type_assertion":
			case "spread_element":
				return this.taintOf(mod, kids[0] ?? null);
			case "ternary_expression":
				return union(
					this.taintOf(mod, F(node, "consequence")),
					this.taintOf(mod, F(node, "alternative")),
				);
			case "binary_expression": {
				const op = F(node, "operator")?.text;
				if (op === "||" || op === "??" || op === "&&") {
					return union(
						this.taintOf(mod, F(node, "left")),
						this.taintOf(mod, F(node, "right")),
					);
				}
				return EMPTY;
			}
			case "sequence_expression":
				return this.taintOf(mod, kids[kids.length - 1] ?? null);
			case "assignment_expression":
				return this.taintOf(mod, F(node, "right"));
			case "object": {
				let out: Taint = new Set();
				for (const p of kids) {
					if (p.type === "pair")
						out = union(out, this.taintOf(mod, F(p, "value")));
					else if (p.type === "shorthand_property_identifier")
						out = union(out, this.taintOfIdentifier(mod, p.text));
					else if (p.type === "spread_element")
						out = union(out, this.taintOf(mod, p));
				}
				return findingsOnly(out);
			}
			case "array": {
				let out: Taint = new Set();
				for (const e of kids) out = union(out, this.taintOf(mod, e));
				return findingsOnly(out);
			}
			default:
				return EMPTY;
		}
	}

	// -- binding patterns ----------------------------------------------------

	private bind(mod: ModuleRecord, name: string, taint: Taint): boolean {
		if (taint.size === 0) return false;
		const before = mod.bindings.get(name);
		const after = union(before ?? EMPTY, taint);
		if (sameTaint(before, after)) return false;
		mod.bindings.set(name, after);
		return true;
	}

	private bindPattern(
		mod: ModuleRecord,
		pattern: Node | null,
		taint: Taint,
	): boolean {
		if (!pattern || taint.size === 0) return false;
		const F = LaunchCapabilityAnalyzer.field;
		let changed = false;
		switch (pattern.type) {
			case "identifier":
				return this.bind(mod, pattern.text, taint);
			case "object_pattern":
				for (const p of LaunchCapabilityAnalyzer.namedChildren(pattern)) {
					if (p.type === "shorthand_property_identifier_pattern") {
						changed =
							this.bind(mod, p.text, this.memberTaint(taint, p.text)) ||
							changed;
					} else if (p.type === "pair_pattern") {
						const key = F(p, "key");
						const keyText =
							key?.type === "computed_property_name"
								? this.keyOf(
										mod,
										LaunchCapabilityAnalyzer.namedChildren(key)[0] ?? null,
									)
								: (LaunchCapabilityAnalyzer.stringLiteral(key) ??
									key?.text ??
									null);
						changed =
							this.bindPattern(
								mod,
								F(p, "value"),
								this.memberTaint(taint, keyText),
							) || changed;
					} else if (p.type === "object_assignment_pattern") {
						const left = F(p, "left");
						changed =
							this.bindPattern(
								mod,
								left,
								this.memberTaint(taint, left?.text ?? null),
							) || changed;
					} else if (p.type === "rest_pattern") {
						changed =
							this.bindPattern(
								mod,
								LaunchCapabilityAnalyzer.namedChildren(p)[0] ?? null,
								taint,
							) || changed;
					}
				}
				return changed;
			case "array_pattern":
				for (const e of LaunchCapabilityAnalyzer.namedChildren(pattern)) {
					changed =
						this.bindPattern(mod, e, this.memberTaint(taint, null)) || changed;
				}
				return changed;
			case "assignment_pattern":
				return this.bindPattern(mod, F(pattern, "left"), taint);
			case "rest_pattern":
				return this.bindPattern(
					mod,
					LaunchCapabilityAnalyzer.namedChildren(pattern)[0] ?? null,
					taint,
				);
			default:
				return false;
		}
	}

	private static parameterNames(params: Node | null): string[] {
		if (!params) return [];
		return LaunchCapabilityAnalyzer.namedChildren(params).map((p) => {
			const pattern = LaunchCapabilityAnalyzer.field(p, "pattern") ?? p;
			const id =
				pattern.type === "identifier"
					? pattern
					: pattern.descendantsOfType("identifier")[0];
			return id?.text ?? "";
		});
	}

	// -- passes --------------------------------------------------------------

	/**
	 * Structural facts that never change: const strings, local functions.
	 *
	 * A name is a CONST STRING only if EVERY binding of that name in the file
	 * is `const NAME = <literal>` with one and the same value. Bindings are
	 * flat per file (no scopes), so any other binding site for the name — a
	 * `let`/`var` declarator, a `const` with a non-literal initialiser (which
	 * is why a two-hop `const B = A` is NOT resolved: rung 3 is exactly one
	 * hop), a destructuring pattern, a parameter, a `catch` binding, a
	 * `for…of` head, an import, a function or class name, an assignment
	 * target — POISONS it, and `keyOf` falls to the fail-closed rung. Round
	 * 10's review showed the alternative: `let m = "./config.js"; m =
	 * "../core/entry-point-launcher.js"; import(m)` resolved to the STALE
	 * literal and loaded the launcher unreported.
	 */
	private collectStatics(mod: ModuleRecord): void {
		const F = LaunchCapabilityAnalyzer.field;
		const candidates = new Map<string, string>();
		const poisoned = new Set<string>();
		const poisonAll = (n: Node | null) => {
			if (!n) return;
			if (
				n.type === "identifier" ||
				n.type === "shorthand_property_identifier_pattern"
			)
				poisoned.add(n.text);
			for (const c of LaunchCapabilityAnalyzer.namedChildren(n)) poisonAll(c);
		};
		const walk = (n: Node) => {
			if (n.type === "variable_declarator") {
				const name = F(n, "name");
				const value = F(n, "value");
				const lit = LaunchCapabilityAnalyzer.stringLiteral(value);
				const isConst =
					n.parent?.type === "lexical_declaration" &&
					LaunchCapabilityAnalyzer.hasKeyword(n.parent, "const");
				if (name?.type === "identifier" && lit !== null && isConst) {
					const prior = candidates.get(name.text);
					if (prior !== undefined && prior !== lit) poisoned.add(name.text);
					else candidates.set(name.text, lit);
				} else poisonAll(name);
				if (
					name?.type === "identifier" &&
					value &&
					(value.type === "arrow_function" ||
						value.type === "function_expression" ||
						value.type === "function")
				) {
					mod.localFunctions.set(
						name.text,
						LaunchCapabilityAnalyzer.parameterNames(F(value, "parameters")),
					);
				}
			} else if (n.type === "function_declaration") {
				const name = F(n, "name");
				if (name) {
					poisoned.add(name.text);
					mod.localFunctions.set(
						name.text,
						LaunchCapabilityAnalyzer.parameterNames(F(n, "parameters")),
					);
				}
			} else if (
				n.type === "class_declaration" ||
				n.type === "abstract_class_declaration" ||
				n.type === "enum_declaration"
			) {
				poisonAll(F(n, "name"));
			} else if (
				n.type === "formal_parameters" ||
				n.type === "import_clause" ||
				n.type === "catch_clause"
			) {
				// Parameters (including destructured and rest), every import
				// binding, and `catch (e)`. `catch_clause` has more than the
				// binding under it; poisoning its body's identifiers too is a
				// false NEGATIVE for resolution only, never a false positive.
				poisonAll(n.type === "catch_clause" ? F(n, "parameter") : n);
			} else if (n.type === "arrow_function") {
				const single = F(n, "parameter"); // `m => …` without parentheses
				if (single) poisonAll(single);
			} else if (n.type === "for_in_statement") {
				poisonAll(F(n, "left"));
			} else if (n.type === "assignment_expression") {
				poisonAll(F(n, "left"));
			}
			for (const c of LaunchCapabilityAnalyzer.namedChildren(n)) walk(c);
		};
		walk(mod.root);
		for (const [name, lit] of candidates)
			if (!poisoned.has(name)) mod.constStrings.set(name, lit);
	}

	/** One propagation pass over a module. Returns whether any binding grew. */
	private propagate(mod: ModuleRecord): boolean {
		const F = LaunchCapabilityAnalyzer.field;
		let changed = false;
		const walk = (n: Node) => {
			switch (n.type) {
				case "import_statement": {
					if (LaunchCapabilityAnalyzer.hasKeyword(n, "type")) break; // `import type`
					const spec = LaunchCapabilityAnalyzer.stringLiteral(F(n, "source"));
					if (spec === null) break;
					const tag = this.moduleSourceTag(
						mod.abs,
						spec,
						n.startPosition.row + 1,
					);
					if (!tag) break;
					const clause = n.namedChildren.find(
						(c) => c?.type === "import_clause",
					);
					if (!clause) break;
					for (const c of LaunchCapabilityAnalyzer.namedChildren(clause)) {
						if (c.type === "identifier") {
							changed =
								this.bind(mod, c.text, this.exportTaint(tag, "default")) ||
								changed;
						} else if (c.type === "namespace_import") {
							const id = c.descendantsOfType("identifier")[0];
							if (id)
								changed = this.bind(mod, id.text, new Set([tag])) || changed;
						} else if (c.type === "named_imports") {
							for (const s of LaunchCapabilityAnalyzer.namedChildren(c)) {
								if (s.type !== "import_specifier") continue;
								if (LaunchCapabilityAnalyzer.hasKeyword(s, "type")) continue;
								const name = F(s, "name");
								const alias = F(s, "alias") ?? name;
								if (!name || !alias) continue;
								changed =
									this.bind(
										mod,
										alias.text,
										this.exportTaint(tag, name.text),
									) || changed;
							}
						}
					}
					break;
				}
				case "variable_declarator":
					changed =
						this.bindPattern(
							mod,
							F(n, "name"),
							this.taintOf(mod, F(n, "value")),
						) || changed;
					break;
				case "assignment_expression":
				case "augmented_assignment_expression": {
					const left = F(n, "left");
					const t = this.taintOf(mod, F(n, "right"));
					if (left?.type === "identifier")
						changed = this.bind(mod, left.text, t) || changed;
					else if (
						left?.type === "member_expression" &&
						F(left, "object")?.type === "this"
					) {
						changed =
							this.bind(mod, `this.${F(left, "property")?.text}`, t) || changed;
					} else changed = this.bindPattern(mod, left, t) || changed;
					break;
				}
				case "public_field_definition": {
					const name = F(n, "name");
					if (name)
						changed =
							this.bind(
								mod,
								`this.${name.text}`,
								this.taintOf(mod, F(n, "value")),
							) || changed;
					break;
				}
				case "call_expression": {
					const fn = F(n, "function");
					const args = F(n, "arguments");
					// EVERY `import(x)` / `require(x)` is evaluated where it stands
					// — bound, awaited, chained, or BARE (`await import(m);` for
					// side effects only). `taintOf` reaches an import only when
					// its value flows somewhere, so before round 8 a bare
					// computed import produced no `dynamic-import` entry at all.
					// The result is discarded here on purpose: a bare import
					// calls nothing, so it is not a violation; an unresolvable
					// one is recorded in `unresolved`, which has NO allowlist and
					// is asserted empty on the production tree — a stricter
					// channel than a violation, not a weaker one. Re-visits
					// across fixpoint passes dedupe in `recordUnresolved`.
					if (
						fn &&
						(fn.type === "import" ||
							(fn.type === "identifier" && fn.text === "require"))
					) {
						this.importCallTaint(mod, n);
						break;
					}
					// Same-file parameter taint: `wrap(spawn)` taints `wrap`'s param.
					if (
						fn?.type === "identifier" &&
						args &&
						mod.localFunctions.has(fn.text)
					) {
						const params = mod.localFunctions.get(fn.text) ?? [];
						LaunchCapabilityAnalyzer.namedChildren(args).forEach((a, i) => {
							const t = findingsOnly(this.taintOf(mod, a));
							const p = params[i];
							if (p && t.size > 0) {
								changed = this.bind(mod, p, t) || changed;
								changed = this.bind(mod, `this.${p}`, t) || changed;
							}
						});
					}
					break;
				}
				default:
					break;
			}
			for (const c of LaunchCapabilityAnalyzer.namedChildren(n)) walk(c);
		};
		walk(mod.root);
		return changed;
	}

	/** Recompute the export table from bindings. Returns whether it changed. */
	private computeExports(mod: ModuleRecord): boolean {
		const F = LaunchCapabilityAnalyzer.field;
		const next = new Map<string, Taint>();
		const stars: { abs: string; line: number }[] = [];
		const put = (name: string, t: Taint) => {
			if (t.size > 0) next.set(name, union(next.get(name) ?? EMPTY, t));
		};
		for (const n of LaunchCapabilityAnalyzer.namedChildren(mod.root)) {
			if (n.type !== "export_statement") continue;
			if (LaunchCapabilityAnalyzer.hasKeyword(n, "type")) continue; // `export type {…}`
			const source = LaunchCapabilityAnalyzer.stringLiteral(F(n, "source"));
			const line = n.startPosition.row + 1;
			const tag =
				source === null ? null : this.moduleSourceTag(mod.abs, source, line);
			const decl = F(n, "declaration");
			const value = F(n, "value");
			const kids = LaunchCapabilityAnalyzer.namedChildren(n);
			if (LaunchCapabilityAnalyzer.hasKeyword(n, "default")) {
				const expr =
					value ??
					kids.find((k) => k.type !== "decorator" && k.type !== "comment") ??
					null;
				put("default", this.taintOf(mod, expr));
				continue;
			}
			if (decl) {
				if (
					decl.type === "lexical_declaration" ||
					decl.type === "variable_declaration"
				) {
					for (const d of LaunchCapabilityAnalyzer.namedChildren(decl)) {
						if (d.type !== "variable_declarator") continue;
						const name = F(d, "name");
						if (!name) continue;
						for (const id of name.type === "identifier"
							? [name]
							: name.descendantsOfType("identifier")) {
							put(id.text, mod.bindings.get(id.text) ?? EMPTY);
						}
					}
				}
				continue;
			}
			const clause = kids.find((k) => k.type === "export_clause");
			const nsExport = kids.find((k) => k.type === "namespace_export");
			if (nsExport) {
				const id = nsExport.descendantsOfType("identifier")[0];
				if (id && tag) put(id.text, new Set([tag]));
				continue;
			}
			if (!clause && source !== null) {
				// `export * from "x"`
				if (tag?.startsWith("ns:")) stars.push({ abs: tag.slice(3), line });
				else if (tag) put("*", new Set([tag]));
				continue;
			}
			if (clause) {
				for (const s of LaunchCapabilityAnalyzer.namedChildren(clause)) {
					if (s.type !== "export_specifier") continue;
					if (LaunchCapabilityAnalyzer.hasKeyword(s, "type")) continue;
					const name = F(s, "name");
					const alias = F(s, "alias") ?? name;
					if (!name || !alias) continue;
					put(
						alias.text,
						tag
							? this.exportTaint(tag, name.text)
							: (mod.bindings.get(name.text) ?? EMPTY),
					);
				}
			}
		}
		let changed =
			stars.length !== mod.starReexports.length ||
			stars.some((s, i) => s.abs !== mod.starReexports[i]?.abs) ||
			next.size !== mod.exports.size;
		if (!changed) {
			for (const [k, v] of next)
				if (!sameTaint(mod.exports.get(k), v)) changed = true;
		}
		mod.exports = next;
		mod.starReexports = stars;
		return changed;
	}

	/** Final pass: every CALL (or `$` tag) of a tainted callee. */
	private collectCalls(mod: ModuleRecord): LaunchFinding[] {
		const F = LaunchCapabilityAnalyzer.field;
		const out: LaunchFinding[] = [];
		const walk = (n: Node) => {
			if (n.type === "call_expression") {
				const fn = F(n, "function");
				if (
					fn &&
					fn.type !== "import" &&
					!(fn.type === "identifier" && fn.text === "require")
				) {
					const t = findingsOnly(this.taintOf(mod, fn));
					for (const kind of t as Set<CapabilityKind>) {
						out.push({
							file: mod.rel,
							line: n.startPosition.row + 1,
							kind,
							text: n.text.split("\n")[0]?.trim().slice(0, 120) ?? "",
							via: [...this.taintOf(mod, fn)],
						});
					}
				}
			}
			for (const c of LaunchCapabilityAnalyzer.namedChildren(n)) walk(c);
		};
		walk(mod.root);
		return out;
	}

	// -- driver --------------------------------------------------------------

	async run(): Promise<AnalyzeResult> {
		const started = Date.now();
		await this.init();
		const rootFiles = await this.collectRootFiles();
		for (const abs of rootFiles) this.load(abs, true);

		// Statics first; then global fixpoint over bindings + exports. Modules
		// pulled in by resolution during a pass are picked up on the next one.
		const prepared = new Set<string>();
		let passes = 0;
		let changed = true;
		while (changed && passes < 12) {
			passes++;
			changed = false;
			for (const mod of [...this.modules.values()]) {
				if (!mod) continue;
				if (!prepared.has(mod.abs)) {
					prepared.add(mod.abs);
					this.collectStatics(mod);
					changed = true;
				}
				// Local fixpoint.
				let local = true;
				let guard = 0;
				while (local && guard++ < 20) local = this.propagate(mod);
				if (guard > 1) changed = true;
				if (this.computeExports(mod)) changed = true;
			}
		}

		const calls: LaunchFinding[] = [];
		const violations: LaunchFinding[] = [];
		const importOnly: AcquisitionInfo[] = [];
		const acquired: Record<CapabilityKind, Set<string>> = {
			primitive: new Set(),
			launcher: new Set(),
		};
		const inScope = [...this.modules.values()].filter(
			(m): m is ModuleRecord => m !== null && m.inScope === true,
		);
		for (const mod of inScope) {
			const found = this.collectCalls(mod);
			calls.push(...found);
			const calledKinds = new Set(found.map((f) => f.kind));
			for (const kind of ["primitive", "launcher"] as const) {
				const names = [...mod.bindings.entries()]
					.filter(([, t]) => t.has(kind))
					.map(([name]) => name);
				if (names.length === 0) continue;
				acquired[kind].add(mod.rel);
				if (!calledKinds.has(kind))
					importOnly.push({ file: mod.rel, kind, bindings: names });
			}
			for (const f of found) {
				const allow =
					f.kind === "primitive"
						? this.options.primitiveAllowlist
						: this.options.launcherCallerAllowlist;
				if (!allow.has(f.file)) violations.push(f);
			}
		}
		const byPos = (a: LaunchFinding, b: LaunchFinding) =>
			a.file.localeCompare(b.file) ||
			a.line - b.line ||
			a.kind.localeCompare(b.kind);
		calls.sort(byPos);
		violations.sort(byPos);
		return {
			calls,
			violations,
			importOnly: importOnly.sort((a, b) => a.file.localeCompare(b.file)),
			acquired,
			unresolved: [...this.unresolved.values()].sort(
				(a, b) =>
					a.file.localeCompare(b.file) ||
					a.line - b.line ||
					a.kind.localeCompare(b.kind),
			),
			filesScanned: inScope.length,
			passes,
			elapsedMs: Date.now() - started,
		};
	}
}

/** Run the launch-capability rule. Reads files; executes none. */
export async function analyzeLaunchCapabilities(
	options: AnalyzeOptions,
): Promise<AnalyzeResult> {
	return new LaunchCapabilityAnalyzer(options).run();
}

/** One line per finding, for logs and assertion messages. */
export function formatFindings(findings: LaunchFinding[]): string {
	return findings
		.map((f) => `${f.file}:${f.line} [${f.kind}] ${f.text}`)
		.join("\n");
}
