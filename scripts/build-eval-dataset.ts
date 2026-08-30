#!/usr/bin/env bun
/**
 * Build the git-derived retrieval evaluation dataset (BEIR layout).
 *
 * A commit message is a natural-language query; the files that commit touched
 * are the gold relevant set.  That gives labelled retrieval data for free, and
 * — unlike hand-authored qrels — it is not biased toward whatever the current
 * retrieval stack happens to return today.
 *
 * Output (consumed by eval/code-search-harness/loader.ts → loadBeirDataset):
 *   <out>/corpus.jsonl      {"_id","title","text"}
 *   <out>/queries.jsonl     {"_id","text","routerLabel"}
 *   <out>/qrels/test.tsv    query-id\tcorpus-id\tscore
 *   <out>/manifest.json     provenance + counts
 *
 * Usage:
 *   bun run build-eval-dataset
 *   bun scripts/build-eval-dataset.ts --out eval/datasets/mnemex-git
 *   bun scripts/build-eval-dataset.ts --label-with-llm    (needs an LLM provider)
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { classify_query_type_heuristic } from "../eval/code-search-harness/loader.js";
import type { RouterLabel } from "../src/benchmark-v2/types.js";

// ============================================================================
// Tunables
// ============================================================================

/** Commits touching more files than this are not focused retrieval targets. */
export const DEFAULT_MAX_FILES_PER_COMMIT = 10;

/** Query text shorter than this is too vague to be a useful query. */
export const DEFAULT_MIN_SUBJECT_CHARS = 15;

/** Per-document character cap, to keep corpus.jsonl a manageable size. */
export const DEFAULT_CORPUS_MAX_CHARS = 8000;

/** Character cap on the commit-body sentence appended to the query. */
export const BODY_SNIPPET_MAX_CHARS = 200;

// ============================================================================
// Corpus eligibility
// ============================================================================

/**
 * Path prefixes/segments that never belong in the corpus.
 *
 * `eval/datasets/` is on the list so that a regenerated corpus never ingests a
 * previously committed corpus.
 */
const DENY_PATH_SEGMENTS = [
	"node_modules/",
	"dist/",
	"build/",
	"grammars/",
	".mnemex/",
	".claudemem/",
	"vendor/",
	"eval/datasets/",
];

/** Individual files that are tracked but carry no retrieval signal. */
const DENY_BASENAMES = new Set([
	"package-lock.json",
	"bun.lock",
	"bun.lockb",
	"yarn.lock",
	"pnpm-lock.yaml",
	"CACHEDIR.TAG",
]);

/** Extensions treated as source / prose documents. */
const SOURCE_EXTENSIONS = new Set([
	"bash",
	"c",
	"cjs",
	"cpp",
	"cs",
	"css",
	"go",
	"h",
	"hpp",
	"html",
	"java",
	"js",
	"json",
	"jsx",
	"kt",
	"md",
	"mdx",
	"mjs",
	"php",
	"py",
	"rb",
	"rs",
	"scss",
	"sh",
	"sql",
	"swift",
	"toml",
	"ts",
	"tsx",
	"yaml",
	"yml",
	"zsh",
]);

function extensionOf(path: string): string {
	const base = basename(path);
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return "";
	return base.slice(dot + 1).toLowerCase();
}

/**
 * Whether a repo-relative path is eligible to become a corpus document.
 *
 * `git ls-files` already handles .gitignore; this filters the tracked-but-not-
 * source residue (lockfiles, committed index blobs, images, wasm, …).
 */
export function isCorpusEligible(path: string): boolean {
	if (path.length === 0) return false;
	for (const segment of DENY_PATH_SEGMENTS) {
		if (path.startsWith(segment) || path.includes(`/${segment}`)) return false;
	}
	if (DENY_BASENAMES.has(basename(path))) return false;
	return SOURCE_EXTENSIONS.has(extensionOf(path));
}

// ============================================================================
// git log parsing
// ============================================================================

/**
 * `git log` format used by {@link parseGitLog}.
 *
 * Uses ASCII record (0x1e) / unit (0x1f) separators so that multi-line commit
 * bodies stay unambiguous — the name-status block is simply everything after
 * the fourth unit separator.
 */
export const GIT_LOG_FORMAT = "%x1e%h%x1f%s%x1f%b%x1f";

export interface RawCommit {
	/** Short sha — used as the query `_id`. */
	sha: string;
	subject: string;
	body: string;
	/** Raw `--name-status` lines, e.g. `M\tsrc/a.ts` or `R100\told.ts\tnew.ts`. */
	nameStatus: string[];
}

/** Parse the output of `git log --name-status --format=GIT_LOG_FORMAT`. */
export function parseGitLog(raw: string): RawCommit[] {
	const commits: RawCommit[] = [];
	for (const record of raw.split("\x1e")) {
		if (record.trim().length === 0) continue;
		const parts = record.split("\x1f");
		if (parts.length < 4) continue;
		const sha = (parts[0] ?? "").trim();
		const subject = (parts[1] ?? "").trim();
		const body = (parts[2] ?? "").trim();
		const nameStatus = parts
			.slice(3)
			.join("\x1f")
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0);
		if (sha.length === 0) continue;
		commits.push({ sha, subject, body, nameStatus });
	}
	return commits;
}

/**
 * Resolve `--name-status` records to the paths the commit is *about*.
 *
 * Rename (`R100 old new`) and copy (`C75 old new`) records resolve to the new
 * path, since that is the path that may still exist in the current tree.
 */
export function resolveTouchedPaths(nameStatus: string[]): string[] {
	const paths: string[] = [];
	for (const line of nameStatus) {
		const fields = line.split("\t").filter((f) => f.length > 0);
		if (fields.length < 2) continue;
		const status = fields[0] ?? "";
		const path =
			(status.startsWith("R") || status.startsWith("C")) && fields.length >= 3
				? fields[2]
				: fields[1];
		if (path && !paths.includes(path)) paths.push(path);
	}
	return paths;
}

/**
 * Keep only gold paths that exist in the corpus.
 *
 * The gold set is "files touched at that time"; the corpus is the current tree.
 * Anything since deleted (or never eligible) has to go, or the query would be
 * unanswerable by construction.
 */
export function filterGoldFiles(
	paths: string[],
	corpusIds: ReadonlySet<string>,
): string[] {
	return paths.filter((path) => corpusIds.has(path));
}

// ============================================================================
// Query text
// ============================================================================

/** `feat(rg)!: add X` → `add X`.  Subjects without a prefix pass through. */
const CONVENTIONAL_PREFIX = /^[a-z][a-z0-9-]*(\([^)]*\))?!?:\s*/i;

/** Trailing PR reference, e.g. `… (#10)`. */
const PR_TRAILER = /\s*\(#\d+\)\s*$/;

/** Strip a conventional-commit type/scope prefix and any trailing `(#123)`. */
export function stripConventionalPrefix(subject: string): string {
	return subject
		.trim()
		.replace(CONVENTIONAL_PREFIX, "")
		.replace(PR_TRAILER, "")
		.trim();
}

/** git trailers and tool signatures that add no retrieval signal. */
const BODY_NOISE =
	/^(co-authored-by|signed-off-by|generated with|crafted with|🤖|https?:\/\/)/i;

function firstParagraph(body: string): string {
	const paragraph = body.split(/\n\s*\n/)[0] ?? "";
	return paragraph.replace(/\s+/g, " ").trim();
}

function truncateOnWord(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	const space = cut.lastIndexOf(" ");
	return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd();
}

/**
 * Build the query text: stripped subject, optionally extended with the first
 * paragraph of the body when that paragraph adds signal.
 */
export function buildQueryText(subject: string, body = ""): string {
	const head = stripConventionalPrefix(subject);
	const paragraph = firstParagraph(body);
	if (
		paragraph.length < 20 ||
		BODY_NOISE.test(paragraph) ||
		paragraph.toLowerCase() === head.toLowerCase()
	) {
		return head;
	}
	const snippet = truncateOnWord(paragraph, BODY_SNIPPET_MAX_CHARS);
	return `${head}. ${snippet}`;
}

// ============================================================================
// Exclusion
// ============================================================================

export type ExclusionReason =
	| "release_chore"
	| "no_files"
	| "too_many_files"
	| "short_subject"
	| "no_gold_files";

export const EXCLUSION_REASONS: ExclusionReason[] = [
	"release_chore",
	"no_files",
	"too_many_files",
	"short_subject",
	"no_gold_files",
];

/** Version / changelog housekeeping — real commits, useless as queries. */
const RELEASE_SUBJECT_PATTERNS = [
	/^chore\(release\)/i,
	/^release[:(\s]/i,
	/\bbump\s+version\b/i,
	/\bbump\s+to\s+v?\d+\.\d+/i,
	/\bversion\s+to\s+v?\d+\.\d+/i,
	/^v?\d+\.\d+\.\d+\b/,
	/\bupdate\s+changelog\b/i,
];

export function isReleaseChore(subject: string): boolean {
	const trimmed = subject.trim();
	return RELEASE_SUBJECT_PATTERNS.some((pattern) => pattern.test(trimmed));
}

export interface ExclusionOptions {
	maxFiles?: number;
	minSubjectChars?: number;
}

/**
 * Decide whether a commit becomes a query.  Returns the reason it was rejected,
 * or `null` when it is kept.  Checks run in a fixed order so the manifest's
 * per-reason counts stay interpretable.
 */
export function classifyExclusion(
	commit: RawCommit,
	goldFiles: string[],
	options: ExclusionOptions = {},
): ExclusionReason | null {
	const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES_PER_COMMIT;
	const minSubjectChars = options.minSubjectChars ?? DEFAULT_MIN_SUBJECT_CHARS;

	if (isReleaseChore(commit.subject)) return "release_chore";

	const touched = resolveTouchedPaths(commit.nameStatus);
	if (touched.length === 0) return "no_files";
	if (touched.length > maxFiles) return "too_many_files";

	if (stripConventionalPrefix(commit.subject).length < minSubjectChars) {
		return "short_subject";
	}

	if (goldFiles.length === 0) return "no_gold_files";

	return null;
}

// ============================================================================
// Dataset assembly
// ============================================================================

export interface DatasetQuery {
	_id: string;
	text: string;
	routerLabel: RouterLabel;
}

export interface Qrel {
	queryId: string;
	docId: string;
	score: number;
}

export interface BuildDatasetResult {
	queries: DatasetQuery[];
	qrels: Qrel[];
	scanned: number;
	kept: number;
	excluded: Record<ExclusionReason, number>;
}

export interface BuildDatasetOptions extends ExclusionOptions {
	/** Sync labeller; defaults to the harness's rule-based heuristic. */
	label?: (query: string) => RouterLabel;
}

function emptyExclusionCounts(): Record<ExclusionReason, number> {
	const counts = {} as Record<ExclusionReason, number>;
	for (const reason of EXCLUSION_REASONS) counts[reason] = 0;
	return counts;
}

/**
 * Turn parsed commits + the corpus id set into queries and qrels.
 *
 * Pure: no git, no filesystem, no network.
 */
export function buildDataset(
	commits: RawCommit[],
	corpusIds: ReadonlySet<string>,
	options: BuildDatasetOptions = {},
): BuildDatasetResult {
	const label = options.label ?? classify_query_type_heuristic;
	const queries: DatasetQuery[] = [];
	const qrels: Qrel[] = [];
	const excluded = emptyExclusionCounts();

	for (const commit of commits) {
		const gold = filterGoldFiles(
			resolveTouchedPaths(commit.nameStatus),
			corpusIds,
		);
		const reason = classifyExclusion(commit, gold, options);
		if (reason !== null) {
			excluded[reason] += 1;
			continue;
		}
		const text = buildQueryText(commit.subject, commit.body);
		queries.push({ _id: commit.sha, text, routerLabel: label(text) });
		for (const docId of gold) {
			qrels.push({ queryId: commit.sha, docId, score: 1 });
		}
	}

	return {
		queries,
		qrels,
		scanned: commits.length,
		kept: queries.length,
		excluded,
	};
}

// ============================================================================
// LLM label distillation (opt-in)
// ============================================================================

/**
 * Map the router's 5-value `QueryIntent` onto the harness's 4-class
 * `RouterLabel`.
 *
 * `similarity` ("code like X", "example of") is exploratory; `location`
 * ("files under src/rg") is repo-structure navigation, i.e. structural.
 */
export function mapIntentToRouterLabel(intent: string): RouterLabel {
	switch (intent) {
		case "symbol_lookup":
			return "symbol_lookup";
		case "structural":
		case "location":
			return "structural";
		case "similarity":
			return "exploratory";
		default:
			return "semantic_search";
	}
}

/**
 * Thin wrapper over the existing QueryRouter, so labels can be distilled from
 * the production router instead of cloned from the rules a classifier would be
 * meant to replace.
 *
 * Caveat recorded in the manifest: `QueryRouter.route()` short-circuits to its
 * rule classifier whenever the rules are ≥0.85 confident (only the
 * symbol_lookup patterns reach that), so a minority of labels are still
 * rule-derived.  `classifyWithLLM` is private, so there is no thin way to force
 * the LLM for every query without editing the router.
 */
async function createLlmLabeler(
	repoRoot: string,
): Promise<(query: string) => Promise<RouterLabel>> {
	const { createLLMClient } = await import("../src/llm/client.js");
	const { createQueryRouter } = await import(
		"../src/retrieval/routing/query-router.js"
	);
	const client = await createLLMClient(undefined, repoRoot);
	const router = createQueryRouter(client, { useLLM: true, minConfidence: 0 });
	return async (query: string) => {
		const { classification } = await router.route(query);
		return mapIntentToRouterLabel(classification.intent);
	};
}

// ============================================================================
// git / filesystem (impure)
// ============================================================================

function git(repoRoot: string, args: string[]): string {
	return execFileSync("git", ["-C", repoRoot, ...args], {
		encoding: "utf8",
		maxBuffer: 512 * 1024 * 1024,
	});
}

export interface CorpusDoc {
	_id: string;
	title: string;
	text: string;
}

interface CorpusResult {
	docs: CorpusDoc[];
	tracked: number;
	skippedIneligible: number;
	skippedUnreadable: number;
	skippedEmptyOrBinary: number;
}

/**
 * Read many blobs through a single `git cat-file --batch` process.
 *
 * Returns contents in request order, with `null` where git reported the object
 * missing.  One process rather than one per file: ~800 individual `git show`
 * calls proved flaky under concurrent git activity in the same repo (occasional
 * empty stdout), which silently dropped documents from the corpus.
 */
function readBlobs(repoRoot: string, revs: string[]): Array<string | null> {
	if (revs.length === 0) return [];
	const stdout = execFileSync("git", ["-C", repoRoot, "cat-file", "--batch"], {
		input: `${revs.join("\n")}\n`,
		maxBuffer: 1024 * 1024 * 1024,
	});

	const results: Array<string | null> = [];
	let offset = 0;
	while (offset < stdout.length && results.length < revs.length) {
		const newline = stdout.indexOf(0x0a, offset);
		if (newline === -1) break;
		const header = stdout.toString("utf8", offset, newline);
		offset = newline + 1;
		if (header.endsWith(" missing")) {
			results.push(null);
			continue;
		}
		const size = Number.parseInt(header.split(" ")[2] ?? "", 10);
		if (!Number.isFinite(size)) {
			results.push(null);
			continue;
		}
		results.push(stdout.toString("utf8", offset, offset + size));
		offset += size + 1; // blob content is followed by a newline
	}
	while (results.length < revs.length) results.push(null);
	return results;
}

/**
 * Build the corpus from the tree at `commit`, not from the working tree, so the
 * dataset is reproducible from the sha recorded in the manifest (and immune to
 * whatever happens to be uncommitted at generation time).
 */
function buildCorpus(
	repoRoot: string,
	commit: string,
	maxChars: number,
): CorpusResult {
	const tracked = git(repoRoot, ["ls-tree", "-r", "-z", "--name-only", commit])
		.split("\0")
		.filter((path) => path.length > 0);

	const docs: CorpusDoc[] = [];
	let skippedIneligible = 0;
	let skippedUnreadable = 0;
	let skippedEmptyOrBinary = 0;

	const eligible = tracked.filter((path) => {
		if (isCorpusEligible(path)) return true;
		skippedIneligible += 1;
		return false;
	});
	const contents = readBlobs(
		repoRoot,
		eligible.map((path) => `${commit}:${path}`),
	);

	for (const [index, path] of eligible.entries()) {
		const content = contents[index];
		if (content === null || content === undefined) {
			skippedUnreadable += 1;
			continue;
		}
		if (content.trim().length === 0 || content.includes("\u0000")) {
			skippedEmptyOrBinary += 1;
			continue;
		}
		docs.push({
			_id: path,
			title: basename(path),
			text: content.slice(0, maxChars),
		});
	}

	return {
		docs,
		tracked: tracked.length,
		skippedIneligible,
		skippedUnreadable,
		skippedEmptyOrBinary,
	};
}

function writeJsonl(path: string, rows: unknown[]): void {
	const body = rows.map((row) => JSON.stringify(row)).join("\n");
	writeFileSync(path, rows.length > 0 ? `${body}\n` : "", "utf8");
}

// ============================================================================
// CLI
// ============================================================================

interface CliOptions {
	repoRoot: string;
	outDir: string;
	labelWithLlm: boolean;
	maxFiles: number;
	minSubjectChars: number;
	maxChars: number;
}

export function parseArgs(argv: string[], defaultRoot: string): CliOptions {
	const options: CliOptions = {
		repoRoot: defaultRoot,
		outDir: join(defaultRoot, "eval", "datasets", "mnemex-git"),
		labelWithLlm: false,
		maxFiles: DEFAULT_MAX_FILES_PER_COMMIT,
		minSubjectChars: DEFAULT_MIN_SUBJECT_CHARS,
		maxChars: DEFAULT_CORPUS_MAX_CHARS,
	};
	let explicitOut = false;

	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const next = argv[i + 1];
		switch (arg) {
			case "--label-with-llm":
				options.labelWithLlm = true;
				break;
			case "--repo":
				if (next) options.repoRoot = resolve(next);
				i++;
				break;
			case "--out":
				if (next) {
					options.outDir = resolve(next);
					explicitOut = true;
				}
				i++;
				break;
			case "--max-files":
				if (next) options.maxFiles = Number.parseInt(next, 10);
				i++;
				break;
			case "--min-subject-chars":
				if (next) options.minSubjectChars = Number.parseInt(next, 10);
				i++;
				break;
			case "--max-chars":
				if (next) options.maxChars = Number.parseInt(next, 10);
				i++;
				break;
			default:
				break;
		}
	}

	if (!explicitOut) {
		options.outDir = join(options.repoRoot, "eval", "datasets", "mnemex-git");
	}
	return options;
}

async function main(): Promise<void> {
	const scriptDir = dirname(fileURLToPath(import.meta.url));
	const options = parseArgs(process.argv.slice(2), resolve(scriptDir, ".."));

	console.log(`repo:   ${options.repoRoot}`);
	console.log(`output: ${options.outDir}`);

	const head = git(options.repoRoot, ["rev-parse", "HEAD"]).trim();

	const corpus = buildCorpus(options.repoRoot, head, options.maxChars);
	const corpusIds = new Set(corpus.docs.map((doc) => doc._id));
	console.log(
		`corpus: ${corpus.docs.length} docs from ${corpus.tracked} tracked files`,
	);

	const commits = parseGitLog(
		git(options.repoRoot, [
			"log",
			"--no-merges",
			"--name-status",
			`--format=${GIT_LOG_FORMAT}`,
		]),
	);
	console.log(`commits: ${commits.length} non-merge`);

	const result = buildDataset(commits, corpusIds, {
		maxFiles: options.maxFiles,
		minSubjectChars: options.minSubjectChars,
	});

	let routerLabelSource = "rules";
	let agreementWithRules: number | null = null;

	if (options.labelWithLlm) {
		routerLabelSource = "llm-router";
		const labeler = await createLlmLabeler(options.repoRoot);
		let agree = 0;
		for (const [index, query] of result.queries.entries()) {
			const ruleLabel = query.routerLabel;
			try {
				query.routerLabel = await labeler(query.text);
			} catch (error) {
				console.warn(`  label failed for ${query._id}: ${String(error)}`);
			}
			if (query.routerLabel === ruleLabel) agree += 1;
			if ((index + 1) % 10 === 0) {
				console.log(`  labelled ${index + 1}/${result.queries.length}`);
			}
		}
		agreementWithRules =
			result.queries.length > 0 ? agree / result.queries.length : null;
	}

	mkdirSync(join(options.outDir, "qrels"), { recursive: true });
	writeJsonl(join(options.outDir, "corpus.jsonl"), corpus.docs);
	writeJsonl(join(options.outDir, "queries.jsonl"), result.queries);
	const qrelLines = [
		"query-id\tcorpus-id\tscore",
		...result.qrels.map((q) => `${q.queryId}\t${q.docId}\t${q.score}`),
	];
	writeFileSync(
		join(options.outDir, "qrels", "test.tsv"),
		`${qrelLines.join("\n")}\n`,
		"utf8",
	);

	const excludedTotal = EXCLUSION_REASONS.reduce(
		(sum, reason) => sum + result.excluded[reason],
		0,
	);
	const manifest = {
		generatedAt: new Date().toISOString(),
		head,
		generator: "scripts/build-eval-dataset.ts",
		commitsScanned: result.scanned,
		commitsExcluded: result.excluded,
		commitsExcludedTotal: excludedTotal,
		commitsKept: result.kept,
		queryCount: result.queries.length,
		corpusDocCount: corpus.docs.length,
		corpusTrackedFiles: corpus.tracked,
		corpusSkipped: {
			ineligible: corpus.skippedIneligible,
			unreadable: corpus.skippedUnreadable,
			emptyOrBinary: corpus.skippedEmptyOrBinary,
		},
		qrelCount: result.qrels.length,
		meanGoldFilesPerQuery:
			result.queries.length > 0
				? Number((result.qrels.length / result.queries.length).toFixed(3))
				: 0,
		routerLabelSource,
		routerLabelAgreementWithRules: agreementWithRules,
		routerLabelDistribution: result.queries.reduce<Record<string, number>>(
			(acc, query) => {
				acc[query.routerLabel] = (acc[query.routerLabel] ?? 0) + 1;
				return acc;
			},
			{},
		),
		settings: {
			maxFilesPerCommit: options.maxFiles,
			minSubjectChars: options.minSubjectChars,
			corpusMaxChars: options.maxChars,
		},
	};
	writeFileSync(
		join(options.outDir, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
		"utf8",
	);

	console.log("");
	console.log(JSON.stringify(manifest, null, 2));
}

if (import.meta.main) {
	await main();
}
