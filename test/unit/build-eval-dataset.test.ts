import { describe, expect, test } from "bun:test";
import {
	buildDataset,
	buildQueryText,
	classifyExclusion,
	filterGoldFiles,
	isCorpusEligible,
	isReleaseChore,
	mapIntentToRouterLabel,
	parseGitLog,
	type RawCommit,
	resolveTouchedPaths,
	stripConventionalPrefix,
} from "../../scripts/build-eval-dataset.js";

const RS = "\x1e";
const US = "\x1f";

/** Build a fixture in the exact shape `git log --format=GIT_LOG_FORMAT` emits. */
function gitLogFixture(
	commits: Array<{
		sha: string;
		subject: string;
		body?: string;
		files: string[];
	}>,
): string {
	return commits
		.map(
			({ sha, subject, body = "", files }) =>
				`${RS}${sha}${US}${subject}${US}${body}${US}\n\n${files.join("\n")}\n`,
		)
		.join("");
}

function commit(overrides: Partial<RawCommit> = {}): RawCommit {
	return {
		sha: "abc1234",
		subject: "add drop-in ripgrep replacement",
		body: "",
		nameStatus: ["M\tsrc/rg/index.ts"],
		...overrides,
	};
}

describe("stripConventionalPrefix", () => {
	test("strips type with parenthesised scope", () => {
		expect(stripConventionalPrefix("feat(rg): add drop-in replacement")).toBe(
			"add drop-in replacement",
		);
	});

	test("strips type with a nested-looking scope and breaking marker", () => {
		expect(
			stripConventionalPrefix("refactor(cloud/server)!: rename wire headers"),
		).toBe("rename wire headers");
	});

	test("strips bare type prefix", () => {
		expect(stripConventionalPrefix("chore: ignore local runtime state")).toBe(
			"ignore local runtime state",
		);
	});

	test("passes through a subject with no prefix", () => {
		expect(stripConventionalPrefix("add missing source files for build")).toBe(
			"add missing source files for build",
		);
	});

	test("does not strip a colon that is not a leading type token", () => {
		expect(
			stripConventionalPrefix("rename to mnemex: npm package and binaries"),
		).toBe("rename to mnemex: npm package and binaries");
	});

	test("strips a trailing PR reference", () => {
		expect(
			stripConventionalPrefix("feat(mcp): return structured state (#6)"),
		).toBe("return structured state");
	});
});

describe("buildQueryText", () => {
	test("appends the first body paragraph when it adds signal", () => {
		const text = buildQueryText(
			"fix(store): guard JSON.parse",
			"Corrupted legacy index rows crashed the loader on startup.\n\nSecond paragraph is dropped.",
		);
		expect(text).toBe(
			"guard JSON.parse. Corrupted legacy index rows crashed the loader on startup.",
		);
	});

	test("ignores trailer-only bodies", () => {
		expect(
			buildQueryText(
				"fix(cli): skip API key check",
				"Co-Authored-By: Someone <someone@example.com>",
			),
		).toBe("skip API key check");
	});

	test("caps the appended paragraph", () => {
		const text = buildQueryText("feat: add thing", "word ".repeat(200));
		expect(text.length).toBeLessThanOrEqual("add thing. ".length + 200);
	});
});

describe("parseGitLog", () => {
	test("parses sha, subject, multi-line body and name-status block", () => {
		const raw = gitLogFixture([
			{
				sha: "1111111",
				subject: "feat(rg): add semantic augmentation",
				body: "Wraps ripgrep.\nSame byte-identical output.\n\nTrailer here",
				files: ["M\tsrc/rg/index.ts", "A\tsrc/rg/merger.ts"],
			},
			{
				sha: "2222222",
				subject: "chore: tidy",
				files: ["M\t.gitignore"],
			},
		]);

		const commits = parseGitLog(raw);
		expect(commits).toHaveLength(2);
		expect(commits[0]?.sha).toBe("1111111");
		expect(commits[0]?.subject).toBe("feat(rg): add semantic augmentation");
		expect(commits[0]?.body).toContain("Same byte-identical output.");
		expect(commits[0]?.nameStatus).toEqual([
			"M\tsrc/rg/index.ts",
			"A\tsrc/rg/merger.ts",
		]);
		expect(commits[1]?.nameStatus).toEqual(["M\t.gitignore"]);
	});

	test("returns nothing for empty output", () => {
		expect(parseGitLog("")).toEqual([]);
	});
});

describe("resolveTouchedPaths", () => {
	test("resolves a rename record to the new path", () => {
		expect(
			resolveTouchedPaths([
				"R100\tsrc/old-name.ts\tsrc/new-name.ts",
				"M\tsrc/other.ts",
			]),
		).toEqual(["src/new-name.ts", "src/other.ts"]);
	});

	test("resolves a copy record to the new path", () => {
		expect(resolveTouchedPaths(["C75\tsrc/a.ts\tsrc/b.ts"])).toEqual([
			"src/b.ts",
		]);
	});

	test("keeps add/modify/delete paths and dedupes", () => {
		expect(
			resolveTouchedPaths(["A\tsrc/a.ts", "D\tsrc/b.ts", "M\tsrc/a.ts"]),
		).toEqual(["src/a.ts", "src/b.ts"]);
	});

	test("ignores malformed lines", () => {
		expect(resolveTouchedPaths(["", "M", "M\tsrc/a.ts"])).toEqual(["src/a.ts"]);
	});
});

describe("isCorpusEligible", () => {
	test("accepts source and prose files", () => {
		expect(isCorpusEligible("src/core/store.ts")).toBe(true);
		expect(isCorpusEligible("docs/CLI.md")).toBe(true);
		expect(isCorpusEligible("package.json")).toBe(true);
	});

	test("rejects lockfiles, build output, grammars and index blobs", () => {
		expect(isCorpusEligible("package-lock.json")).toBe(false);
		expect(isCorpusEligible("bun.lock")).toBe(false);
		expect(isCorpusEligible("dist/index.js")).toBe(false);
		expect(isCorpusEligible("node_modules/foo/index.js")).toBe(false);
		expect(isCorpusEligible("grammars/tree-sitter-typescript.wasm")).toBe(
			false,
		);
		expect(isCorpusEligible("a/.mnemex/index.db")).toBe(false);
		expect(isCorpusEligible("assets/logo.png")).toBe(false);
		expect(isCorpusEligible(".gitignore")).toBe(false);
	});

	test("never ingests a previously generated dataset", () => {
		expect(isCorpusEligible("eval/datasets/mnemex-git/corpus.jsonl")).toBe(
			false,
		);
		expect(isCorpusEligible("eval/datasets/mnemex-git/manifest.json")).toBe(
			false,
		);
	});
});

describe("filterGoldFiles", () => {
	test("drops paths absent from the corpus", () => {
		const corpus = new Set(["src/a.ts", "src/b.ts"]);
		expect(
			filterGoldFiles(["src/a.ts", "src/deleted.ts", "bun.lock"], corpus),
		).toEqual(["src/a.ts"]);
	});
});

describe("isReleaseChore", () => {
	test.each([
		"chore(release): bump version to 0.32.0",
		"release: v0.20.1 — detail view drill-down",
		"v0.19.0 rework the indexer pipeline",
		"docs: update changelog for 0.30.0",
		"chore: sync MCP server version to 0.20.1",
	])("excludes %s", (subject) => {
		expect(isReleaseChore(subject)).toBe(true);
	});

	test("keeps ordinary feature subjects", () => {
		expect(isReleaseChore("feat(rg): add drop-in ripgrep replacement")).toBe(
			false,
		);
	});
});

describe("classifyExclusion", () => {
	const corpusPaths = ["src/rg/index.ts"];

	test("keeps a focused commit with surviving gold files", () => {
		expect(classifyExclusion(commit(), corpusPaths)).toBeNull();
	});

	test("excludes release chores", () => {
		expect(
			classifyExclusion(
				commit({ subject: "chore(release): bump version to 0.32.0" }),
				corpusPaths,
			),
		).toBe("release_chore");
	});

	test("excludes commits touching no files", () => {
		expect(classifyExclusion(commit({ nameStatus: [] }), [])).toBe("no_files");
	});

	test("excludes commits touching more than 10 files", () => {
		const nameStatus = Array.from(
			{ length: 11 },
			(_, i) => `M\tsrc/file-${i}.ts`,
		);
		expect(classifyExclusion(commit({ nameStatus }), corpusPaths)).toBe(
			"too_many_files",
		);
	});

	test("excludes subjects shorter than 15 characters", () => {
		expect(
			classifyExclusion(commit({ subject: "fix: typo" }), corpusPaths),
		).toBe("short_subject");
	});

	test("excludes docs-only commits whose files are outside the corpus", () => {
		expect(
			classifyExclusion(
				commit({
					subject: "document the wire protocol migration window",
					nameStatus: ["M\tCHANGELOG.txt", "M\t.gitignore"],
				}),
				[],
			),
		).toBe("no_gold_files");
	});

	test("respects overridden thresholds", () => {
		expect(
			classifyExclusion(commit({ subject: "fix: typo" }), corpusPaths, {
				minSubjectChars: 3,
			}),
		).toBeNull();
	});
});

describe("buildDataset", () => {
	const corpus = new Set(["src/rg/index.ts", "src/rg/merger.ts"]);

	test("emits queries + qrels and counts every exclusion reason", () => {
		const commits = parseGitLog(
			gitLogFixture([
				{
					sha: "aaaaaaa",
					subject: "feat(rg): add drop-in ripgrep replacement",
					files: ["M\tsrc/rg/index.ts", "A\tsrc/rg/merger.ts"],
				},
				{
					sha: "bbbbbbb",
					subject: "chore(release): bump version to 0.32.0",
					files: ["M\tpackage.json"],
				},
				{
					sha: "ccccccc",
					subject: "fix: typo",
					files: ["M\tsrc/rg/index.ts"],
				},
				{
					sha: "ddddddd",
					subject: "rename the ripgrep merger module for clarity",
					files: ["R100\tsrc/rg/old-merger.ts\tsrc/rg/merger.ts"],
				},
				{
					sha: "eeeeeee",
					subject: "delete the abandoned prototype retriever",
					files: ["D\tsrc/rg/prototype.ts"],
				},
				{
					sha: "fffffff",
					subject: "sweeping refactor across the whole codebase",
					files: Array.from({ length: 11 }, (_, i) => `M\tsrc/f${i}.ts`),
				},
			]),
		);

		const result = buildDataset(commits, corpus);

		expect(result.scanned).toBe(6);
		expect(result.kept).toBe(2);
		expect(result.queries.map((q) => q._id)).toEqual(["aaaaaaa", "ddddddd"]);
		expect(result.excluded).toEqual({
			release_chore: 1,
			no_files: 0,
			too_many_files: 1,
			short_subject: 1,
			no_gold_files: 1,
		});

		// Rename resolves to the surviving new path.
		expect(result.qrels.filter((q) => q.queryId === "ddddddd")).toEqual([
			{ queryId: "ddddddd", docId: "src/rg/merger.ts", score: 1 },
		]);
		// Binary relevance for every gold file.
		expect(result.qrels.every((q) => q.score === 1)).toBe(true);
		expect(result.qrels.filter((q) => q.queryId === "aaaaaaa")).toHaveLength(2);
	});

	test("query text is the stripped subject and labels default to the heuristic", () => {
		const commits = parseGitLog(
			gitLogFixture([
				{
					sha: "aaaaaaa",
					subject: "feat(rg): add support for streaming results",
					files: ["M\tsrc/rg/index.ts"],
				},
			]),
		);
		const [query] = buildDataset(commits, corpus).queries;
		expect(query?.text).toBe("add support for streaming results");
		expect(query?.routerLabel).toBe("exploratory");
	});

	test("honours an injected labeller", () => {
		const commits = parseGitLog(
			gitLogFixture([
				{
					sha: "aaaaaaa",
					subject: "add drop-in ripgrep replacement",
					files: ["M\tsrc/rg/index.ts"],
				},
			]),
		);
		const result = buildDataset(commits, corpus, {
			label: () => "structural",
		});
		expect(result.queries[0]?.routerLabel).toBe("structural");
	});
});

describe("mapIntentToRouterLabel", () => {
	test("maps the router's 5 intents onto the 4 harness labels", () => {
		expect(mapIntentToRouterLabel("symbol_lookup")).toBe("symbol_lookup");
		expect(mapIntentToRouterLabel("structural")).toBe("structural");
		expect(mapIntentToRouterLabel("location")).toBe("structural");
		expect(mapIntentToRouterLabel("similarity")).toBe("exploratory");
		expect(mapIntentToRouterLabel("semantic")).toBe("semantic_search");
		expect(mapIntentToRouterLabel("something-new")).toBe("semantic_search");
	});
});
