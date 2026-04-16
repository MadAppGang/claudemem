import { describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ensureLineNumbers, parseRgArgs } from "../src/rg/parser";
import { matchesPattern, mergeResults } from "../src/rg/merger";
import { patchClaudeSettings } from "../src/rg/install";
import type { SearchResult } from "../src/types";

// ============================================================================
// Helpers
// ============================================================================

function mockResult(
	filePath: string,
	startLine: number,
	content: string,
	score: number,
): SearchResult {
	return {
		chunk: {
			id: `${filePath}:${startLine}`,
			contentHash: "abc123",
			filePath,
			startLine,
			endLine: startLine + content.split("\n").length - 1,
			content,
			language: "typescript",
			chunkType: "function",
			name: "testFn",
			fileHash: "def456",
		},
		score,
		vectorScore: score,
		keywordScore: score,
	} as SearchResult;
}

// ============================================================================
// parseRgArgs tests
// ============================================================================

describe("parseRgArgs", () => {
	test("simple pattern and path", () => {
		const result = parseRgArgs(["handleSearch", "."]);
		expect(result.pattern).toBe("handleSearch");
		expect(result.searchPath).toBe(".");
		expect(result.mode).toBe("content");
	});

	test("pattern only defaults searchPath to '.'", () => {
		const result = parseRgArgs(["handleSearch"]);
		expect(result.pattern).toBe("handleSearch");
		expect(result.searchPath).toBe(".");
		expect(result.mode).toBe("content");
	});

	test("-e flag sets pattern, positional becomes path", () => {
		const result = parseRgArgs(["-e", "foo", "src/"]);
		expect(result.pattern).toBe("foo");
		expect(result.searchPath).toBe("src/");
	});

	test("--regexp flag sets pattern", () => {
		const result = parseRgArgs(["--regexp", "foo"]);
		expect(result.pattern).toBe("foo");
	});

	test("--files-with-matches sets mode", () => {
		const result = parseRgArgs(["--files-with-matches", "test", "."]);
		expect(result.mode).toBe("files-with-matches");
		expect(result.pattern).toBe("test");
	});

	test("-l short flag sets files-with-matches mode", () => {
		const result = parseRgArgs(["-l", "test"]);
		expect(result.mode).toBe("files-with-matches");
		expect(result.pattern).toBe("test");
	});

	test("--count sets count mode", () => {
		const result = parseRgArgs(["--count", "test"]);
		expect(result.mode).toBe("count");
		expect(result.pattern).toBe("test");
	});

	test("-c short flag sets count mode", () => {
		const result = parseRgArgs(["-c", "test"]);
		expect(result.mode).toBe("count");
		expect(result.pattern).toBe("test");
	});

	test("combined boolean flags -in: pattern extracted, mode stays content", () => {
		const result = parseRgArgs(["-in", "test"]);
		expect(result.pattern).toBe("test");
		expect(result.mode).toBe("content");
	});

	test("combined flags -il: files-with-matches mode", () => {
		const result = parseRgArgs(["-il", "test"]);
		expect(result.pattern).toBe("test");
		expect(result.mode).toBe("files-with-matches");
	});

	test("-A consumes its value argument", () => {
		const result = parseRgArgs(["-A", "3", "test", "."]);
		expect(result.pattern).toBe("test");
		expect(result.searchPath).toBe(".");
	});

	test("--glob flag consumes its value argument", () => {
		const result = parseRgArgs(["--glob", "*.ts", "test"]);
		expect(result.pattern).toBe("test");
	});

	test("-- separator causes following args to be treated as positionals", () => {
		const result = parseRgArgs(["--", "-pattern-with-dash"]);
		expect(result.pattern).toBe("-pattern-with-dash");
	});

	test("no pattern returns undefined", () => {
		const result = parseRgArgs(["-l"]);
		expect(result.pattern).toBeUndefined();
	});

	test("--glob=*.ts equals form does not consume next arg", () => {
		const result = parseRgArgs(["--glob=*.ts", "test"]);
		expect(result.pattern).toBe("test");
	});
});

// ============================================================================
// mergeResults tests
// ============================================================================

describe("mergeResults — content mode", () => {
	test("empty rg output and empty mnemex results returns empty string", () => {
		const output = mergeResults("", [], "pattern", "content");
		expect(output).toBe("");
	});

	test("rg results only returns rg output unchanged", () => {
		const rgOutput = "src/a.ts:10:function handleSearch() {\n";
		const output = mergeResults(rgOutput, [], "handleSearch", "content");
		expect(output).toBe("src/a.ts:10:function handleSearch() {\n");
	});

	test("mnemex results only formats as file:line:content", () => {
		const result = mockResult("src/b.ts", 5, "function handleSearch() {}", 0.9);
		const output = mergeResults("", [result], "handleSearch", "content");
		expect(output).toContain("src/b.ts:5:function handleSearch() {}");
		expect(output).toEndWith("\n");
	});

	test("overlapping file:line between rg and mnemex are deduplicated", () => {
		// rg found line 10 in src/a.ts
		const rgOutput = "src/a.ts:10:function handleSearch() {\n";
		// mnemex also found the same line
		const result = mockResult("src/a.ts", 10, "function handleSearch() {", 0.9);
		const output = mergeResults(rgOutput, [result], "handleSearch", "content");
		// The line should appear exactly once
		const lines = output.split("\n").filter((l) => l.includes("src/a.ts:10:"));
		expect(lines.length).toBe(1);
	});

	test("mnemex results appear before rg results", () => {
		const rgOutput = "src/a.ts:1:handleSearch rg only\n";
		const result = mockResult("src/b.ts", 5, "handleSearch mnemex only", 0.9);
		const output = mergeResults(rgOutput, [result], "handleSearch", "content");
		const lines = output.split("\n").filter((l) => l.length > 0);
		expect(lines[0]).toContain("src/b.ts");
		expect(lines[1]).toContain("src/a.ts");
	});

	test("mnemex chunk lines that don't match pattern are excluded", () => {
		// chunk contains two lines; only one matches pattern
		const content = "function handleSearch() {}\nconst unrelated = true;";
		const result = mockResult("src/c.ts", 1, content, 0.9);
		const output = mergeResults("", [result], "handleSearch", "content");
		expect(output).toContain("handleSearch");
		expect(output).not.toContain("unrelated");
	});

	test("mnemex chunks with duplicate lines are deduplicated", () => {
		// Two results covering overlapping content
		const r1 = mockResult("src/d.ts", 1, "function handleSearch() {}", 0.9);
		const r2 = mockResult("src/d.ts", 1, "function handleSearch() {}", 0.8);
		const output = mergeResults("", [r1, r2], "handleSearch", "content");
		const lines = output.split("\n").filter((l) => l.includes("src/d.ts:1:"));
		expect(lines.length).toBe(1);
	});
});

describe("mergeResults — files-with-matches mode", () => {
	test("empty inputs return empty string", () => {
		const output = mergeResults("", [], "test", "files-with-matches");
		expect(output).toBe("");
	});

	test("rg files only returned when no mnemex results", () => {
		const rgOutput = "src/a.ts\nsrc/b.ts\n";
		const output = mergeResults(rgOutput, [], "test", "files-with-matches");
		expect(output).toContain("src/a.ts");
		expect(output).toContain("src/b.ts");
	});

	test("mnemex files appear before rg files", () => {
		const rgOutput = "src/a.ts\nsrc/b.ts\n";
		const result = mockResult("src/c.ts", 1, "test content", 0.9);
		const output = mergeResults(
			rgOutput,
			[result],
			"test",
			"files-with-matches",
		);
		const lines = output.split("\n").filter((l) => l.length > 0);
		expect(lines[0]).toBe("src/c.ts");
		expect(lines).toContain("src/a.ts");
		expect(lines).toContain("src/b.ts");
	});

	test("overlapping files are deduplicated", () => {
		const rgOutput = "src/a.ts\n";
		const result = mockResult("src/a.ts", 1, "test content", 0.9);
		const output = mergeResults(
			rgOutput,
			[result],
			"test",
			"files-with-matches",
		);
		const lines = output.split("\n").filter((l) => l.length > 0);
		const count = lines.filter((l) => l === "src/a.ts").length;
		expect(count).toBe(1);
	});

	test("mnemex files deduplicated across multiple results", () => {
		const r1 = mockResult("src/x.ts", 1, "test", 0.9);
		const r2 = mockResult("src/x.ts", 5, "test again", 0.8);
		const output = mergeResults("", [r1, r2], "test", "files-with-matches");
		const lines = output.split("\n").filter((l) => l.length > 0);
		const count = lines.filter((l) => l === "src/x.ts").length;
		expect(count).toBe(1);
	});

	test("output ends with newline when results present", () => {
		const result = mockResult("src/a.ts", 1, "test", 0.9);
		const output = mergeResults("", [result], "test", "files-with-matches");
		expect(output).toEndWith("\n");
	});
});

describe("mergeResults — count mode", () => {
	test("returns rg output unchanged", () => {
		const rgOutput = "src/a.ts:5\nsrc/b.ts:3\n";
		const result = mockResult("src/c.ts", 1, "test content", 0.9);
		const output = mergeResults(rgOutput, [result], "test", "count");
		expect(output).toBe(rgOutput);
	});

	test("returns empty string when rg output is empty", () => {
		const output = mergeResults("", [], "test", "count");
		expect(output).toBe("");
	});
});

// ============================================================================
// parseRgArgs — additional edge cases
// ============================================================================

describe("parseRgArgs — additional edge cases", () => {
	test("empty args returns undefined pattern and defaults", () => {
		const result = parseRgArgs([]);
		expect(result.pattern).toBeUndefined();
		expect(result.searchPath).toBe(".");
		expect(result.mode).toBe("content");
	});

	test("--count-matches sets count mode", () => {
		const result = parseRgArgs(["--count-matches", "test"]);
		expect(result.mode).toBe("count");
		expect(result.pattern).toBe("test");
	});

	test("multiple -e flags: first pattern wins", () => {
		const result = parseRgArgs(["-e", "first", "-e", "second"]);
		expect(result.pattern).toBe("first");
	});

	test("mode flags after -- are treated as positionals", () => {
		const result = parseRgArgs(["--", "-l", "path"]);
		expect(result.mode).toBe("content"); // -l after -- is not a flag
		expect(result.pattern).toBe("-l");
	});

	test("-F extracts fixedStrings flag", () => {
		const result = parseRgArgs(["-F", "pattern"]);
		expect(result.matchFlags.fixedStrings).toBe(true);
	});

	test("--fixed-strings extracts fixedStrings flag", () => {
		const result = parseRgArgs(["--fixed-strings", "pattern"]);
		expect(result.matchFlags.fixedStrings).toBe(true);
	});

	test("-w extracts wordRegexp flag", () => {
		const result = parseRgArgs(["-w", "pattern"]);
		expect(result.matchFlags.wordRegexp).toBe(true);
	});

	test("-x extracts lineRegexp flag", () => {
		const result = parseRgArgs(["-x", "pattern"]);
		expect(result.matchFlags.lineRegexp).toBe(true);
	});

	test("-i extracts ignoreCase flag", () => {
		const result = parseRgArgs(["-i", "pattern"]);
		expect(result.matchFlags.ignoreCase).toBe(true);
	});

	test("-S extracts smartCase flag", () => {
		const result = parseRgArgs(["-S", "pattern"]);
		expect(result.matchFlags.smartCase).toBe(true);
	});

	test("combined -Fw extracts both fixedStrings and wordRegexp", () => {
		const result = parseRgArgs(["-Fw", "pattern"]);
		expect(result.matchFlags.fixedStrings).toBe(true);
		expect(result.matchFlags.wordRegexp).toBe(true);
	});

	test("--ignore-case long flag extracts ignoreCase", () => {
		const result = parseRgArgs(["--ignore-case", "pattern"]);
		expect(result.matchFlags.ignoreCase).toBe(true);
	});

	test("no flags means all matchFlags are false", () => {
		const result = parseRgArgs(["pattern"]);
		expect(result.matchFlags.fixedStrings).toBe(false);
		expect(result.matchFlags.wordRegexp).toBe(false);
		expect(result.matchFlags.lineRegexp).toBe(false);
		expect(result.matchFlags.ignoreCase).toBe(false);
		expect(result.matchFlags.caseSensitive).toBe(false);
		expect(result.matchFlags.smartCase).toBe(false);
	});
});

// ============================================================================
// ensureLineNumbers
// ============================================================================

describe("ensureLineNumbers", () => {
	test("adds --line-number when not present", () => {
		expect(ensureLineNumbers(["pattern", "."])).toEqual([
			"--line-number",
			"pattern",
			".",
		]);
	});

	test("does not duplicate -n", () => {
		expect(ensureLineNumbers(["-n", "pattern"])).toEqual(["-n", "pattern"]);
	});

	test("does not duplicate --line-number", () => {
		expect(ensureLineNumbers(["--line-number", "pattern"])).toEqual([
			"--line-number",
			"pattern",
		]);
	});

	test("does not mutate original array when inserting", () => {
		const args = ["pattern", "."];
		const result = ensureLineNumbers(args);
		expect(args).toEqual(["pattern", "."]);
		expect(result).toEqual(["--line-number", "pattern", "."]);
	});
});

// ============================================================================
// matchesPattern
// ============================================================================

describe("matchesPattern", () => {
	const noFlags = {
		fixedStrings: false,
		wordRegexp: false,
		lineRegexp: false,
		ignoreCase: false,
		caseSensitive: false,
		smartCase: false,
	};

	test("default is case-sensitive (matches rg's default)", () => {
		// rg's default IS case-sensitive; previous implementation was wrong
		expect(matchesPattern("function HandleSearch() {}", "handlesearch")).toBe(
			false,
		);
		expect(matchesPattern("function HandleSearch() {}", "HandleSearch")).toBe(
			true,
		);
	});

	test("-i / ignoreCase forces case-insensitive match", () => {
		expect(
			matchesPattern("function HandleSearch() {}", "handlesearch", {
				...noFlags,
				ignoreCase: true,
			}),
		).toBe(true);
	});

	test("-S / smartCase is insensitive when pattern is all lowercase", () => {
		expect(
			matchesPattern("function HandleSearch() {}", "handlesearch", {
				...noFlags,
				smartCase: true,
			}),
		).toBe(true);
	});

	test("-S / smartCase is sensitive when pattern has uppercase", () => {
		expect(
			matchesPattern("function handleSearch() {}", "HandleSearch", {
				...noFlags,
				smartCase: true,
			}),
		).toBe(false);
	});

	test("-s / caseSensitive wins over -i precedence", () => {
		expect(
			matchesPattern("function HandleSearch() {}", "handlesearch", {
				...noFlags,
				ignoreCase: true,
				caseSensitive: true,
			}),
		).toBe(false);
	});

	test("-F / fixedStrings treats pattern as literal (no regex meta)", () => {
		// `.` in regex matches any char; with -F it only matches a literal dot
		expect(
			matchesPattern("const x = 1.5;", "1.5", { ...noFlags, fixedStrings: true }),
		).toBe(true);
		expect(
			matchesPattern("const x = 125;", "1.5", { ...noFlags, fixedStrings: true }),
		).toBe(false); // would match without -F because `.` is any-char
	});

	test("-w / wordRegexp requires word boundaries", () => {
		expect(
			matchesPattern("const handleSearch = ...", "handle", {
				...noFlags,
				wordRegexp: true,
			}),
		).toBe(false); // "handle" is a substring of "handleSearch", not a whole word
		expect(
			matchesPattern("const handle = ...", "handle", {
				...noFlags,
				wordRegexp: true,
			}),
		).toBe(true);
	});

	test("-x / lineRegexp requires pattern to match entire line", () => {
		expect(
			matchesPattern("foo", "foo", { ...noFlags, lineRegexp: true }),
		).toBe(true);
		expect(
			matchesPattern("foo bar", "foo", { ...noFlags, lineRegexp: true }),
		).toBe(false);
	});

	test("-F + -w combined: literal word match", () => {
		expect(
			matchesPattern("const x = 1.5;", "1.5", {
				...noFlags,
				fixedStrings: true,
				wordRegexp: true,
			}),
		).toBe(true);
	});

	test("returns false when pattern not present", () => {
		expect(matchesPattern("const x = 1;", "handleSearch")).toBe(false);
	});

	test("invalid regex falls back to literal substring match", () => {
		// Pattern with unclosed bracket is invalid regex
		expect(matchesPattern("some [unclosed content", "[unclosed")).toBe(true);
	});

	test("invalid regex fallback returns false when substring not present", () => {
		expect(matchesPattern("some other content", "[unclosed")).toBe(false);
	});
});

// ============================================================================
// mergeResults — nonMatchLines / separator passthrough
// ============================================================================

describe("mergeResults — nonMatchLines passthrough", () => {
	test("preserves rg context separator lines", () => {
		const rgOutput = "src/a.ts:10:match1\n--\nsrc/b.ts:20:match2\n";
		const output = mergeResults(rgOutput, [], "match", "content");
		expect(output).toContain("--");
		expect(output).toContain("src/a.ts:10:match1");
		expect(output).toContain("src/b.ts:20:match2");
	});

	test("preserves rg lines without line numbers", () => {
		const rgOutput = "src/a.ts:match without line number\n";
		const output = mergeResults(rgOutput, [], "match", "content");
		expect(output).toContain("src/a.ts:match without line number");
	});
});

// ============================================================================
// mergeResults — invalid-regex fallback in merger
// ============================================================================

describe("mergeResults — invalid-regex pattern handling", () => {
	test("invalid regex falls back to literal substring match in merge", () => {
		// Pattern with unclosed bracket is invalid regex
		const result = mockResult("src/a.ts", 1, "some [unclosed content", 0.9);
		const output = mergeResults("", [result], "[unclosed", "content");
		expect(output).toContain("src/a.ts:1:some [unclosed content");
	});
});

// ============================================================================
// install/uninstall — patchClaudeSettings
// ============================================================================

describe("patchClaudeSettings", () => {
	function makeTmpSettings(content?: string): string {
		const dir = mkdtempSync(join(tmpdir(), "mnemex-test-"));
		const path = join(dir, "settings.json");
		if (content !== undefined) {
			writeFileSync(path, content, "utf-8");
		}
		return path;
	}

	test("creates settings.json with USE_BUILTIN_RIPGREP=0 when file does not exist", () => {
		const dir = mkdtempSync(join(tmpdir(), "mnemex-test-"));
		const path = join(dir, "settings.json");
		// File must NOT exist yet
		expect(existsSync(path)).toBe(false);

		patchClaudeSettings(true, path);

		expect(existsSync(path)).toBe(true);
		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed.env?.USE_BUILTIN_RIPGREP).toBe("0");
	});

	test("install is idempotent when USE_BUILTIN_RIPGREP=0 already set", () => {
		const existing = JSON.stringify({ env: { USE_BUILTIN_RIPGREP: "0" } });
		const path = makeTmpSettings(existing);

		patchClaudeSettings(true, path);

		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed.env?.USE_BUILTIN_RIPGREP).toBe("0");
		// Content should be unchanged
		expect(readFileSync(path, "utf-8").trim()).toBe(existing.trim());
	});

	test("uninstall removes USE_BUILTIN_RIPGREP key", () => {
		const existing = JSON.stringify({
			env: { USE_BUILTIN_RIPGREP: "0", OTHER_KEY: "1" },
		});
		const path = makeTmpSettings(existing);

		patchClaudeSettings(false, path);

		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed.env?.USE_BUILTIN_RIPGREP).toBeUndefined();
		expect(parsed.env?.OTHER_KEY).toBe("1");
	});

	test("uninstall removes env key entirely when env becomes empty", () => {
		const existing = JSON.stringify({ env: { USE_BUILTIN_RIPGREP: "0" } });
		const path = makeTmpSettings(existing);

		patchClaudeSettings(false, path);

		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(Object.prototype.hasOwnProperty.call(parsed, "env")).toBe(false);
	});

	test("uninstall is a no-op when USE_BUILTIN_RIPGREP not present", () => {
		const existing = JSON.stringify({ env: { OTHER_KEY: "1" } });
		const path = makeTmpSettings(existing);
		const before = readFileSync(path, "utf-8");

		patchClaudeSettings(false, path);

		// File content should be identical (no write occurred)
		expect(readFileSync(path, "utf-8")).toBe(before);
	});

	test("install adds USE_BUILTIN_RIPGREP=0 to existing settings without env key", () => {
		const existing = JSON.stringify({ someOtherKey: true });
		const path = makeTmpSettings(existing);

		patchClaudeSettings(true, path);

		const parsed = JSON.parse(readFileSync(path, "utf-8"));
		expect(parsed.env?.USE_BUILTIN_RIPGREP).toBe("0");
		expect(parsed.someOtherKey).toBe(true);
	});
});

// ============================================================================
// e2e helpers
// ============================================================================

const CLI_PATH = join(import.meta.dir, "..", "src", "index.ts");

function runMnemexRg(
	args: string[],
	cwd: string,
): { stdout: string; stderr: string; exitCode: number } {
	const result = spawnSync("bun", [CLI_PATH, "rg", ...args], {
		cwd,
		encoding: "utf-8",
		timeout: 10000,
		env: { ...process.env, NO_COLOR: "1" },
	});
	return {
		stdout: result.stdout || "",
		stderr: result.stderr || "",
		exitCode: result.status ?? 1,
	};
}

function setupTmpDir(files: Record<string, string>): string {
	const dir = mkdtempSync(join(tmpdir(), "rg-e2e-"));
	for (const [path, content] of Object.entries(files)) {
		const fullPath = join(dir, path);
		const parentDir = join(fullPath, "..");
		if (!existsSync(parentDir)) mkdirSync(parentDir, { recursive: true });
		writeFileSync(fullPath, content);
	}
	return dir;
}

// ============================================================================
// e2e: handleRgPassthrough
// ============================================================================

describe("e2e: handleRgPassthrough", () => {
	test("falls back to rg when .mnemex/ dir absent", () => {
		const dir = setupTmpDir({ "test.ts": "function handleSearch() {}\n" });
		const { exitCode, stdout } = runMnemexRg(
			["--line-number", "handleSearch", "."],
			dir,
		);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("test.ts");
		expect(stdout).toMatch(/test\.ts:\d+:.*handleSearch/);
	});

	test("exit code 1 when no matches found", () => {
		const dir = setupTmpDir({ "test.ts": "const x = 1;\n" });
		const { exitCode, stdout } = runMnemexRg(
			["TOTALLY_ABSENT_XYZ987", "."],
			dir,
		);
		expect(exitCode).toBe(1);
		expect(stdout).toBe("");
	});

	test("exit code 0 when matches found", () => {
		const dir = setupTmpDir({ "test.ts": "const MATCHME = 1;\n" });
		const { exitCode, stdout } = runMnemexRg(["MATCHME", "."], dir);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("MATCHME");
	});

	test("output format is file:line:content with no ANSI codes", () => {
		const dir = setupTmpDir({
			"src/utils.ts":
				"export function parseQuery(q: string) { return q; }\n",
		});
		const { stdout } = runMnemexRg(
			["--line-number", "--color=never", "parseQuery", "."],
			dir,
		);
		const lines = stdout
			.split("\n")
			.filter((l) => l.length > 0 && l !== "--");
		for (const line of lines) {
			expect(line).toMatch(/^[^:]+:\d+:.+/);
			expect(line).not.toContain("\x1b[");
		}
	});

	test("--files-with-matches produces one file path per line", () => {
		const dir = setupTmpDir({
			"a.ts": "function foo() {}\n",
			"b.ts": "function bar() {}\n",
			"c.ts": "function foo() {} // also foo\n",
		});
		const { exitCode, stdout } = runMnemexRg(
			["--files-with-matches", "foo", "."],
			dir,
		);
		expect(exitCode).toBe(0);
		const lines = stdout.split("\n").filter((l) => l.length > 0);
		// Each line should be a plain file path (no :digit: pattern)
		for (const line of lines) {
			expect(line).not.toMatch(/:\d+:/);
		}
		// a.ts and c.ts match, b.ts does not
		const filenames = lines.map((l) => l.replace(/.*\//, ""));
		expect(filenames).toContain("a.ts");
		expect(filenames).toContain("c.ts");
		expect(filenames).not.toContain("b.ts");
		// No duplicates
		const unique = new Set(lines);
		expect(unique.size).toBe(lines.length);
	});

	test("--count mode produces file:count format", () => {
		const dir = setupTmpDir({
			"a.ts": "foo\nfoo\nfoo\n",
			"b.ts": "bar\n",
		});
		const { exitCode, stdout } = runMnemexRg(["--count", "foo", "."], dir);
		expect(exitCode).toBe(0);
		expect(stdout).toMatch(/a\.ts:3/);
		expect(stdout).not.toContain("b.ts");
	});

	test("--glob filter restricts file matches", () => {
		const dir = setupTmpDir({
			"a.ts": "const MATCH = 1;\n",
			"b.js": "const MATCH = 2;\n",
		});
		const { stdout } = runMnemexRg(["--glob", "*.ts", "MATCH", "."], dir);
		expect(stdout).toContain("a.ts");
		expect(stdout).not.toContain("b.js");
	});

	test("-C context flag preserves context lines", () => {
		const dir = setupTmpDir({
			"test.ts": "line1\nline2\nMATCH_HERE\nline4\nline5\n",
		});
		const { stdout } = runMnemexRg(["-C", "1", "MATCH_HERE", "."], dir);
		expect(stdout).toContain("line2");
		expect(stdout).toContain("MATCH_HERE");
		expect(stdout).toContain("line4");
	});

	test("Claude Code typical flag combination works", () => {
		const dir = setupTmpDir({
			"src/handler.ts":
				"export function handleSearch(q: string) {\n  return q;\n}\n",
		});
		const { exitCode, stdout } = runMnemexRg(
			["--line-number", "--no-heading", "--color=never", "-i", "handlesearch", "."],
			dir,
		);
		expect(exitCode).toBe(0);
		const lines = stdout.split("\n").filter((l) => l.length > 0 && l !== "--");
		for (const line of lines) {
			expect(line).toMatch(/^[^:]+:\d+:.+$/);
		}
		expect(stdout.toLowerCase()).toContain("handlesearch");
	});

	test("regex pattern works correctly", () => {
		const dir = setupTmpDir({
			"test.ts":
				"function handleSearch() {}\nfunction handleMap() {}\nconst x = 1;\n",
		});
		const { exitCode, stdout } = runMnemexRg(
			["function\\s+handle\\w+", "."],
			dir,
		);
		expect(exitCode).toBe(0);
		expect(stdout).toContain("handleSearch");
		expect(stdout).toContain("handleMap");
		expect(stdout).not.toContain("const x");
	});
});

// ============================================================================
// rg binary smoke test
// ============================================================================

describe("rg binary smoke test", () => {
	test("bundled rg binary is accessible and produces output", async () => {
		const { rgPath } = await import("@vscode/ripgrep");
		expect(existsSync(rgPath)).toBe(true);

		const dir = setupTmpDir({ "test.ts": "function hello() {}\n" });
		const result = spawnSync(rgPath, ["--line-number", "hello", dir], {
			encoding: "utf-8",
		});

		expect(result.status).toBe(0);
		expect(result.stdout).toMatch(/test\.ts:\d+:.*hello/);
	});
});
