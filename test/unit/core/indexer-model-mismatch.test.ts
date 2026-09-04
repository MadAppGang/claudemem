/**
 * Runs the model-mismatch probe suite in its own bun process.
 *
 * The probe fakes the vector store, the file tracker and the embeddings client
 * with `mock.module`, which in bun replaces the module registry for the whole
 * PROCESS and is not undone by `mock.restore()` — nor by re-registering the
 * real module, since every importer evaluated in the meantime has already bound
 * the fake. Left in the main run it broke 24 tests in files that never asked
 * for a mock (the editor e2e suite got the fake tracker). A subprocess is the
 * containment: the fakes cannot outlive it.
 *
 * The child's own output is the failure report — this wrapper only relays it.
 */

import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROBE = join(
	dirname(fileURLToPath(import.meta.url)),
	"probes",
	"indexer-model-mismatch.probe.ts",
);

describe("model-mismatch policy (isolated process)", () => {
	test("the probe suite passes", async () => {
		const proc = Bun.spawn(["bun", "test", PROBE], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);

		if (exitCode !== 0) {
			throw new Error(`probe suite failed:\n${stdout}\n${stderr}`);
		}
		// bun test writes its summary to stderr.
		expect(stderr).toContain("0 fail");
	}, 120_000);
});
