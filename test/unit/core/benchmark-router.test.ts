/**
 * Unit tests for the `mnemex benchmark <subcommand>` router decision logic.
 *
 * The actual handlers (list/show/llm/embedding/delete) are side-effecting and
 * expensive (some need OPENROUTER_API_KEY / cost money), so the routing DECISION
 * is extracted into the pure `resolveBenchmarkSubcommand` function. These tests
 * pin the contract:
 *  - bare `benchmark` -> help (RUN NOTHING)
 *  - `benchmark --list` (a flag, not a subcommand) -> error WITH a hint (the
 *    footgun fix: it must never silently launch the embedding benchmark)
 *  - known subcommands route, stripping the subcommand token so each handler's
 *    own flag parsing still works (e.g. `embedding --verbose` -> rest=['--verbose'])
 *  - aliases (`run`->embedding, `rm`->delete) resolve
 *  - unknown subcommands -> error
 */

import { describe, expect, it } from "bun:test";
import { resolveBenchmarkSubcommand } from "../../../src/cli.js";

describe("resolveBenchmarkSubcommand", () => {
	it("returns help when no subcommand is given (runs nothing)", () => {
		expect(resolveBenchmarkSubcommand([])).toEqual({ kind: "help" });
	});

	it("returns help for explicit help tokens", () => {
		expect(resolveBenchmarkSubcommand(["help"])).toEqual({ kind: "help" });
		expect(resolveBenchmarkSubcommand(["--help"])).toEqual({ kind: "help" });
		expect(resolveBenchmarkSubcommand(["-h"])).toEqual({ kind: "help" });
	});

	it("rejects a leading flag with a hint (the footgun fix)", () => {
		const res = resolveBenchmarkSubcommand(["--list"]);
		expect(res.kind).toBe("error");
		if (res.kind === "error") {
			expect(res.message).toContain("Unknown flag '--list'");
			expect(res.message).toContain("mnemex benchmark help");
		}
	});

	it("routes `list`", () => {
		expect(resolveBenchmarkSubcommand(["list"])).toEqual({
			kind: "action",
			action: "list",
			rest: [],
		});
	});

	it("routes `show` and passes the run id + flags through as rest", () => {
		expect(resolveBenchmarkSubcommand(["show", "abc123", "--json"])).toEqual({
			kind: "action",
			action: "show",
			rest: ["abc123", "--json"],
		});
	});

	it("routes `llm` with its flags preserved in rest", () => {
		expect(
			resolveBenchmarkSubcommand([
				"llm",
				"--generators=anthropic",
				"--cases=20",
			]),
		).toEqual({
			kind: "action",
			action: "llm",
			rest: ["--generators=anthropic", "--cases=20"],
		});
	});

	it("routes `embedding` and strips the subcommand token (rest keeps flags)", () => {
		expect(resolveBenchmarkSubcommand(["embedding", "--verbose"])).toEqual({
			kind: "action",
			action: "embedding",
			rest: ["--verbose"],
		});
	});

	it("treats `run` as an alias for embedding", () => {
		expect(resolveBenchmarkSubcommand(["run"])).toEqual({
			kind: "action",
			action: "embedding",
			rest: [],
		});
	});

	it("routes `delete` with the run id in rest", () => {
		expect(resolveBenchmarkSubcommand(["delete", "abc123"])).toEqual({
			kind: "action",
			action: "delete",
			rest: ["abc123"],
		});
	});

	it("treats `rm` as an alias for delete", () => {
		expect(resolveBenchmarkSubcommand(["rm", "abc123"])).toEqual({
			kind: "action",
			action: "delete",
			rest: ["abc123"],
		});
	});

	it("rejects an unknown subcommand with a hint", () => {
		const res = resolveBenchmarkSubcommand(["frobnicate"]);
		expect(res.kind).toBe("error");
		if (res.kind === "error") {
			expect(res.message).toContain(
				"Unknown benchmark subcommand 'frobnicate'",
			);
			expect(res.message).toContain("mnemex benchmark help");
		}
	});
});
