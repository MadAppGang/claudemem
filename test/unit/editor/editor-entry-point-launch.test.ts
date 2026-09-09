/**
 * ROUND 4 — the third instance of the entry-point bypass, closed and measured.
 *
 * `src/editor/editor.ts:262` was:
 *
 *     const child = spawn("mnemex", ["index", "--quiet", "--files", filePath], …)
 *
 * A BARE BINARY NAME resolved through `PATH`. Verified on the machine where this
 * was found: `which mnemex` answers `/Users/jack/.bun/bin/mnemex`, so the spawn
 * SUCCEEDED, ran the production entry point, and `src/index.ts:32` calls
 * `enableRealKeychainAccess()` in that child — from there `mnemex index` resolves
 * embedding credentials against the developer's real login keychain.
 * `SymbolEditor` is constructed by `test/helpers/test-workspace.ts` and driven by
 * `test/e2e/editor/editor.e2e.test.ts` and
 * `test/e2e/scenarios/edit-restore.e2e.test.ts`, so every edit in those suites
 * launched it.
 *
 * WHAT THIS FILE ASSERTS ON. The ARGV actually passed to the launcher, and a
 * monotonic COUNT of real launches. Not a report object, not an elapsed time —
 * the two substitutions that let earlier rounds pass while the hole was open.
 *
 * WHY INJECTION AND NOT A GUARDED CHILD ENVIRONMENT. Handing the child
 * `MNEMEX_KEYCHAIN_TEST_GUARD=1` would stop it reaching the keychain, but it
 * would still START A REAL BACKGROUND `mnemex index` per edit, in a temp
 * workspace, racing for `.mnemex/.indexing.lock` — which is the same mechanism
 * that produced the "pre-existing flake" traced in round 3
 * (`src/mcp/reindexer.ts`). It would also depend on every future call site
 * remembering to pass the environment. Injection makes "this test starts no
 * process" a property of CONSTRUCTION, which is checkable once, here.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	EntryPointLaunchRefusedError,
	entryPointLaunchCount,
	runSelfSync,
	spawnMnemexAwaited,
	spawnMnemexDetached,
	spawnSelfDetached,
} from "../../../src/core/entry-point-launcher.js";
import { TestWorkspace } from "../../helpers/test-workspace.js";

describe("SymbolEditor takes its reindex launcher from the caller", () => {
	let ws: TestWorkspace;

	afterEach(() => ws?.cleanup());

	test("an edit passes the reindex ARGV to the injected launcher and starts nothing", async () => {
		const before = entryPointLaunchCount();

		ws = TestWorkspace.create("editor-launcher-argv");
		ws.writeFile(
			"src/math.ts",
			TestWorkspace.tsFunction("add", "return a + b;"),
		);
		await ws.index();
		const editor = ws.createEditor();

		// Precondition: an edit has not happened yet, so nothing has been asked for.
		expect(ws.reindexLaunches).toEqual([]);

		await editor.editSymbol(
			"add",
			"export function add(a: number, b: number): number {\n  return a * b;\n}\n",
			"replace",
		);

		// The edit really happened — otherwise this test could pass by doing
		// nothing at all, which is how a "no spawn" assertion goes green for the
		// wrong reason.
		expect(readFileSync(join(ws.root, "src/math.ts"), "utf-8")).toContain(
			"return a * b;",
		);

		// THE ARGV ACTUALLY PASSED. Exactly one launch was requested, with the
		// arguments the old `spawn("mnemex", …)` used and the workspace root as
		// cwd. The absolute path of the edited file is the fourth argument.
		expect(ws.reindexLaunches).toHaveLength(1);
		const launch = ws.reindexLaunches[0];
		expect(launch?.args).toEqual([
			"index",
			"--quiet",
			"--files",
			join(ws.root, "src/math.ts"),
		]);
		expect(launch?.cwd).toBe(ws.getConfig().workspaceRoot);

		// THE COUNT. No real process was started by anything in this test. The
		// counter is monotonic and lives at the choke point in the launcher module,
		// so zero movement is a measured fact, not an inference.
		expect(entryPointLaunchCount()).toBe(before);
	});

	test("a dry run asks for no reindex at all", async () => {
		// The negative control for the assertion above: if `reindexLaunches` were
		// appended to by something other than a real edit, this would also be 1.
		ws = TestWorkspace.create("editor-launcher-dryrun");
		ws.writeFile(
			"src/math.ts",
			TestWorkspace.tsFunction("add", "return a + b;"),
		);
		await ws.index();
		const editor = ws.createEditor();

		await editor.editSymbol("add", "// nope\n", "replace", { dryRun: true });

		expect(ws.reindexLaunches).toEqual([]);
	});

	test("the constructor will not accept a missing launcher", () => {
		// The parameter is REQUIRED, and third rather than last, so no existing or
		// future construction can fall through to the installed binary. An optional
		// parameter defaulting to the production launcher would have left every
		// call site in the state round 4 found them in.
		//
		// Checked at the type level, where it is actually enforced: `bun run
		// typecheck` fails on a three-argument construction. Asserted here on the
		// runtime shape so the intent is recorded next to the behaviour.
		const { SymbolEditor } = require("../../../src/editor/editor.js");
		// cache, config, launchReindex, lspManager
		expect(SymbolEditor.length).toBe(3);
	});
});

describe("the production launchers refuse to run inside a guarded process", () => {
	// The second, independent protection. Injection covers code a test can reach;
	// this covers code a test cannot reach YET — the three hook handlers re-exec
	// the entry point through `process.execPath` and have no injector today.
	//
	// This process carries the private sentinel (`bunfig.toml` preload), which is
	// asserted first so a refusal cannot be mistaken for the launcher simply
	// failing.
	test("the sentinel really is set in this process", () => {
		expect(process.env.MNEMEX_KEYCHAIN_TEST_GUARD).toBe("1");
	});

	test("every exported launcher throws instead of launching, and the count never moves", () => {
		const before = entryPointLaunchCount();
		const cwd = process.cwd();

		expect(() => spawnMnemexDetached(["index", "--quiet"], cwd)).toThrow(
			EntryPointLaunchRefusedError,
		);
		expect(() => spawnMnemexAwaited(["index", "--quiet"], cwd)).toThrow(
			EntryPointLaunchRefusedError,
		);
		expect(() => spawnSelfDetached(["index", "--quiet"], cwd)).toThrow(
			EntryPointLaunchRefusedError,
		);
		expect(() => runSelfSync(["status", "--nologo"], cwd, 5000)).toThrow(
			EntryPointLaunchRefusedError,
		);
		// (Round 6 removed the generic `(command, args, cwd)` launcher; the four
		// above are every launcher the module exports.)

		// Four refusals, zero launches. `entryPointLaunches++` sits immediately
		// after the veto and immediately before the real `spawn`, with no setter
		// and no reset — the same contract as `realSecuritySpawns` in
		// `src/core/keychain.ts`.
		expect(entryPointLaunchCount()).toBe(before);
	});

	test("the refusal names the sentinel, so a confused caller can act on it", () => {
		let message = "";
		try {
			spawnMnemexDetached(["index"], process.cwd());
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toContain("MNEMEX_KEYCHAIN_TEST_GUARD=1");
		expect(message).toContain("inject its own launcher");
	});
});
