/**
 * Precedence and default for `onModelMismatch`.
 *
 * The setting decides whether a model disagreement between an index and the
 * config destroys the index (`force-model`) or leaves it alone and adopts the
 * model that built it (`use-indexed`). Getting the default or the precedence
 * wrong is expensive in exactly the way the setting exists to prevent, so both
 * are pinned here: env > project > global > 'use-indexed'.
 *
 * Every case runs in a SUBPROCESS with HOME pointed at a throwaway directory.
 * `GLOBAL_CONFIG_PATH` is computed from `homedir()` at module load, so an
 * in-process test would read the developer's own ~/.mnemex/config.json — the
 * result would depend on the machine, and on whether another test file had
 * already imported config.ts. A subprocess makes each case hermetic.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_MODULE = join(
	dirname(fileURLToPath(import.meta.url)),
	"../../../src/config.ts",
);

/** Reads the resolved mode out of a clean process and prints it. */
const PROBE = `
	const config = await import(process.env.PROBE_CONFIG_MODULE);
	const projectPath = process.env.PROBE_PROJECT || undefined;
	process.stdout.write(config.getModelMismatchMode(projectPath));
`;

const tempDirs: string[] = [];

afterAll(() => {
	for (const dir of tempDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

/**
 * Resolve the mode with the given config levels present and nothing else.
 * `undefined` at a level means that level says nothing; a string is written
 * verbatim, so invalid values can be exercised too.
 */
async function resolveMode(levels: {
	env?: string;
	project?: string;
	global?: string;
	/** Ask about a project at all (default true when `project` is set). */
	withProject?: boolean;
}): Promise<string> {
	const home = makeTempDir("mnemex-mismatch-home-");
	if (levels.global !== undefined) {
		mkdirSync(join(home, ".mnemex"), { recursive: true });
		writeFileSync(
			join(home, ".mnemex", "config.json"),
			JSON.stringify({ onModelMismatch: levels.global }),
		);
	}

	const wantsProject = levels.withProject ?? levels.project !== undefined;
	let projectPath: string | undefined;
	if (wantsProject) {
		projectPath = makeTempDir("mnemex-mismatch-project-");
		if (levels.project !== undefined) {
			writeFileSync(
				join(projectPath, "mnemex.json"),
				JSON.stringify({ onModelMismatch: levels.project }),
			);
		}
	}

	const proc = Bun.spawn(["bun", "-e", PROBE], {
		env: {
			PATH: process.env.PATH ?? "",
			HOME: home,
			PROBE_CONFIG_MODULE: CONFIG_MODULE,
			...(projectPath ? { PROBE_PROJECT: projectPath } : {}),
			...(levels.env !== undefined
				? { MNEMEX_ON_MODEL_MISMATCH: levels.env }
				: {}),
		},
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (exitCode !== 0) {
		throw new Error(`probe failed (${exitCode}): ${stderr}`);
	}
	return stdout.trim();
}

describe("getModelMismatchMode", () => {
	test("defaults to use-indexed when nothing is configured", async () => {
		// The default must be the non-destructive branch: an unwanted rebuild
		// spends money silently, an unreachable stored model fails loudly.
		expect(await resolveMode({})).toBe("use-indexed");
	});

	test("global config is used when nothing overrides it", async () => {
		expect(await resolveMode({ global: "force-model" })).toBe("force-model");
	});

	test("project config beats global config", async () => {
		expect(
			await resolveMode({ global: "use-indexed", project: "force-model" }),
		).toBe("force-model");
	});

	test("env beats project and global config", async () => {
		expect(
			await resolveMode({
				env: "use-indexed",
				project: "force-model",
				global: "force-model",
			}),
		).toBe("use-indexed");
	});

	test("a project with no opinion falls through to global", async () => {
		expect(
			await resolveMode({ global: "force-model", withProject: true }),
		).toBe("force-model");
	});
});

describe("getModelMismatchMode with unrecognised values", () => {
	// An unreadable setting must not become a third behaviour, and must not be
	// fatal: this is read on an already-degraded path, where refusing to run
	// would turn a recoverable state into a hard stop.

	test("an unrecognised env value falls through to the next level", async () => {
		expect(await resolveMode({ env: "nonsense", global: "force-model" })).toBe(
			"force-model",
		);
	});

	test("an unrecognised project value falls through to global", async () => {
		expect(
			await resolveMode({ project: "rebuild-please", global: "force-model" }),
		).toBe("force-model");
	});

	test("unrecognised values everywhere still resolve to the default", async () => {
		expect(await resolveMode({ env: "", project: "yes", global: "true" })).toBe(
			"use-indexed",
		);
	});
});
