/**
 * Does the user ever find out that a different embedding model answered?
 *
 * `onModelMismatch: "use-indexed"` (the default) keeps the index and quietly
 * switches to the model it was built with. That is the right behaviour and the
 * wrong thing to do silently: a user edits `defaultModel`, mnemex keeps using
 * the old one, and nothing says so. The indexer's `onProgress` notice does not
 * count — it reaches no surface on its own:
 *
 *   - `--agent` passes no onProgress callback at all (src/cli.ts);
 *   - the TTY progress renderer truncates detail to the column width and then
 *     replaces it with "done" when the phase completes;
 *   - the MCP search tool passes no callback either.
 *
 * So the fact travels as DATA on the result object, and each surface renders
 * it. These tests pin the two rendering seams: the human one (stderr, because
 * stdout is the JSON-RPC stream under --mcp and must stay ripgrep-identical
 * under `rg` — CLAUDE.md gotcha #14) and the machine one (key=value lines).
 */

import { afterEach, describe, expect, test } from "bun:test";
import { reportAdoptedModel } from "../../../src/cli.js";
import { agentOutput } from "../../../src/output/agent.js";
import type { EnrichedIndexResult, SearchResult } from "../../../src/types.js";

const realStderrWrite = process.stderr.write.bind(process.stderr);
const realStdoutWrite = process.stdout.write.bind(process.stdout);
const realLog = console.log;

afterEach(() => {
	process.stderr.write = realStderrWrite;
	process.stdout.write = realStdoutWrite;
	console.log = realLog;
});

/** Run `fn`, returning everything it wrote to each stream. */
function capture(fn: () => void): { stdout: string; stderr: string } {
	let stdout = "";
	let stderr = "";
	process.stdout.write = ((chunk: string) => {
		stdout += chunk;
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string) => {
		stderr += chunk;
		return true;
	}) as typeof process.stderr.write;
	// agentOutput prints through console.log, which would otherwise bypass the
	// stdout hook above under bun.
	console.log = (...args: unknown[]) => {
		stdout += `${args.join(" ")}\n`;
	};
	try {
		fn();
	} finally {
		process.stdout.write = realStdoutWrite;
		process.stderr.write = realStderrWrite;
		console.log = realLog;
	}
	return { stdout, stderr };
}

function indexResult(over: Partial<EnrichedIndexResult>): EnrichedIndexResult {
	return {
		filesIndexed: 1,
		chunksCreated: 1,
		durationMs: 10,
		skippedFiles: [],
		errors: [],
		...over,
	};
}

describe("the human surface (non-agent CLI)", () => {
	test("says which model was used and which one was set aside", () => {
		const { stderr } = capture(() =>
			reportAdoptedModel({
				model: "ollama/nomic-embed-text",
				adopted: true,
				configuredModel: "voyage-3.5-lite",
			}),
		);

		expect(stderr).toContain("ollama/nomic-embed-text");
		expect(stderr).toContain("voyage-3.5-lite");
		// And how to stop it, or the user knows there is a problem and not what
		// to do about it.
		expect(stderr).toContain("mnemex index --force");
		expect(stderr).toContain("force-model");
	});

	test("writes to stderr, never stdout", () => {
		// stdout is the JSON-RPC stream under --mcp and must stay byte-identical
		// to ripgrep under `rg`.
		const { stdout, stderr } = capture(() =>
			reportAdoptedModel({
				model: "stored-model",
				adopted: true,
				configuredModel: "configured-model",
			}),
		);

		expect(stdout).toBe("");
		expect(stderr.length).toBeGreaterThan(0);
	});

	test("stays quiet when the configured model is the one in use", () => {
		const { stdout, stderr } = capture(() =>
			reportAdoptedModel({ model: "configured-model", adopted: false }),
		);

		expect(stderr).toBe("");
		expect(stdout).toBe("");
	});
});

describe("the machine surface (--agent)", () => {
	test("indexComplete reports the effective model and the substitution", () => {
		const { stdout } = capture(() =>
			agentOutput.indexComplete(
				indexResult({
					embeddingModel: "stored-model",
					adoptedIndexedModel: true,
					configuredModel: "configured-model",
				}),
			),
		);

		expect(stdout).toContain("embedding_model=stored-model");
		expect(stdout).toContain("embedding_model_adopted=true");
		expect(stdout).toContain("configured_model=configured-model");
	});

	test("indexComplete claims no substitution on an ordinary run", () => {
		const { stdout } = capture(() =>
			agentOutput.indexComplete(
				indexResult({
					embeddingModel: "configured-model",
					adoptedIndexedModel: false,
				}),
			),
		);

		expect(stdout).toContain("embedding_model=configured-model");
		expect(stdout).not.toContain("embedding_model_adopted");
		expect(stdout).not.toContain("configured_model=");
	});

	test("searchResults reports it too — --agent skips the auto-reindex entirely", () => {
		// On that path index() never runs, so indexComplete never fires and this
		// is the only channel left.
		const { stdout } = capture(() =>
			agentOutput.searchResults("greet", [] as SearchResult[], {
				embeddingModel: "stored-model",
				configuredModel: "configured-model",
			}),
		);

		expect(stdout).toContain("embedding_model=stored-model");
		expect(stdout).toContain("embedding_model_adopted=true");
		expect(stdout).toContain("configured_model=configured-model");
	});

	test("searchResults stays unchanged when nothing was adopted", () => {
		const { stdout } = capture(() =>
			agentOutput.searchResults("greet", [] as SearchResult[]),
		);

		expect(stdout).toContain("query=greet");
		expect(stdout).not.toContain("embedding_model");
	});
});
