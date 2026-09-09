/**
 * Regression test: background `mnemex` spawns must not crash the process when
 * the binary is absent from PATH.
 *
 * `child_process.spawn()` does NOT throw when the executable is missing — it
 * emits an asynchronous 'error' event. With no listener, Node re-raises it as
 * an unhandled 'error' and takes the process down, so a surrounding try/catch
 * never sees the ENOENT.
 *
 * This took down 15 CI tests across four unrelated suites from a single cause,
 * and the runner misattributed the crash to whichever test happened to be
 * running (a network docs test got blamed for a spawn ENOENT). It reproduces
 * for any user without mnemex on PATH: library use, npx, a dev checkout without
 * `npm link`, or CI.
 *
 * Sites that spawn "mnemex": src/editor/editor.ts, src/mcp/reindexer.ts,
 * src/mcp/server.ts.
 */

import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "../../../src");

describe("spawn() ENOENT semantics", () => {
	test("does not throw synchronously for a missing executable", () => {
		// The behaviour the old try/catch wrongly assumed.
		let threw = false;
		let child: ReturnType<typeof spawn> | undefined;
		try {
			child = spawn("definitely-not-a-real-binary-xyz", [], {
				stdio: "ignore",
			});
			child.on("error", () => {});
		} catch {
			threw = true;
		}
		expect(threw).toBe(false);
		child?.kill();
	});

	test("surfaces the failure asynchronously as an 'error' event", async () => {
		const err = await new Promise<NodeJS.ErrnoException>((resolve) => {
			const child = spawn("definitely-not-a-real-binary-xyz", [], {
				stdio: "ignore",
			});
			child.on("error", resolve);
		});
		expect(err.code).toBe("ENOENT");
	});
});

describe("every background mnemex launch attaches an 'error' listener", () => {
	/**
	 * The files that START a background mnemex, paired with the token that proves
	 * they still do.
	 *
	 * ROUND 4 rewrote all three. None of them writes `spawn("mnemex"` any more:
	 * `editor/editor.ts` did — a BARE BINARY NAME resolved through `PATH`, which
	 * launched the production entry point from every test that edited a symbol —
	 * and `mcp/server.ts` had the same spelling in `runBlockingIndex`. Both now
	 * take an injected launcher, and the single production launcher lives in
	 * `core/entry-point-launcher.ts`. What this file is actually about — the
	 * 'error' listener, without which a missing binary is FATAL rather than
	 * best-effort — is unchanged: it is attached by the caller, on whatever the
	 * launcher returns.
	 *
	 * The token is per-file rather than a shared disjunction so that a file which
	 * silently stops launching anything fails here instead of passing on its
	 * neighbour's evidence.
	 */
	const sites = [
		{ rel: "editor/editor.ts", token: "this.launchReindex(" },
		// Round 6: the reindexer no longer NAMES the binary; it calls the
		// purpose-specific launcher, which owns the name. This token proves it
		// still launches.
		{ rel: "mcp/reindexer.ts", token: "spawnMnemexDetached(args, cwd)" },
		{ rel: "mcp/server.ts", token: "spawnMnemexAwaited" },
		{
			rel: "core/entry-point-launcher.ts",
			token: 'MNEMEX_ENTRY_COMMAND = "mnemex"',
		},
	] as const;

	for (const { rel, token } of sites) {
		test(`${rel} handles spawn errors`, () => {
			const src = readFileSync(join(SRC, rel), "utf-8");

			// Only meaningful while the file still launches mnemex.
			expect(src).toContain(token);

			// An 'error' listener must exist; without it a missing binary is fatal.
			// The launcher module is the exception: it RETURNS the child, and the
			// listener is the caller's to attach — so it is asserted on the callers
			// above, which is where the omission would actually be fatal.
			if (rel !== "core/entry-point-launcher.ts") {
				expect(src).toMatch(/\.on\(\s*["']error["']/);
			}
		});
	}
});
