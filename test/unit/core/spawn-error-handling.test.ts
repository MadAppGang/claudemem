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

describe("every background mnemex spawn attaches an 'error' listener", () => {
	const sites = [
		"editor/editor.ts",
		"mcp/reindexer.ts",
		"mcp/server.ts",
	] as const;

	for (const rel of sites) {
		test(`${rel} handles spawn errors`, () => {
			const src = readFileSync(join(SRC, rel), "utf-8");

			// Only meaningful while the file still spawns mnemex.
			expect(src).toContain('spawn("mnemex"');

			// An 'error' listener must exist; without it a missing binary is fatal.
			expect(src).toMatch(/\.on\(\s*["']error["']/);
		});
	}
});
