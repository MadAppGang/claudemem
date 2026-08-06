/**
 * rg + mnemex result merger
 *
 * Merges ripgrep stdout output with mnemex SearchResult[] and produces
 * rg-compatible output with mnemex-ranked results first.
 */

import { isAbsolute, relative as pathRelative } from "node:path";
import type { SearchResult } from "../types.js";
import type { MatchFlags, OutputMode } from "./parser.js";

/**
 * Mnemex stores absolute paths in its index, but rg emits paths relative to
 * its cwd. When merging, we normalize mnemex paths to match rg so the merged
 * output is path-format consistent. Paths outside the cwd are left as-is.
 */
function normalizePath(filePath: string, cwd: string): string {
	if (!isAbsolute(filePath)) return filePath;
	const rel = pathRelative(cwd, filePath);
	// If the relative path escapes cwd (starts with ..), keep the absolute
	// path so the consumer can still locate the file.
	if (rel.startsWith("..")) return filePath;
	return rel;
}

/**
 * Returns true if the given file path is a real on-disk file that rg could
 * have matched, as opposed to one of mnemex's pseudo-file entries like
 * `docs:typescript` (enriched doc chunks). rg-wrapper output must only
 * include real files.
 */
function isRealFilePath(filePath: string): boolean {
	// mnemex enrichment scheme uses `docs:<language>` and similar
	if (filePath.startsWith("docs:")) return false;
	if (filePath.includes("://")) return false;
	return true;
}

/** Default case-sensitive matching with no special semantics. */
const DEFAULT_FLAGS: MatchFlags = {
	fixedStrings: false,
	wordRegexp: false,
	lineRegexp: false,
	ignoreCase: false,
	caseSensitive: false,
	smartCase: false,
};

/** Escape a string for use as a regex literal. */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Resolve whether a match should be case-insensitive based on flag precedence:
 *   1. `-s` (case-sensitive) wins outright
 *   2. `-i` (ignore-case) forces insensitive
 *   3. `-S` (smart-case) → insensitive iff pattern has no uppercase
 *   4. Default: case-sensitive
 */
function isCaseInsensitive(pattern: string, flags: MatchFlags): boolean {
	if (flags.caseSensitive) return false;
	if (flags.ignoreCase) return true;
	if (flags.smartCase) return !/[A-Z]/.test(pattern);
	return false;
}

/** A parsed rg content-mode line */
interface RgLine {
	file: string;
	line: number;
	content: string;
	/** Original raw line (used as fallback for non-standard lines) */
	raw: string;
}

/**
 * Parse a single rg content-mode output line.
 * Format: `file:line:content`
 * Returns null if the line doesn't match that format (e.g. context separators).
 */
function parseRgLine(raw: string): RgLine | null {
	// rg uses file:line:content — find the colon after file and the colon after line
	// Files on Windows may have drive letters like C:\foo, but we're on Unix
	const firstColon = raw.indexOf(":");
	if (firstColon < 0) return null;
	const secondColon = raw.indexOf(":", firstColon + 1);
	if (secondColon < 0) return null;

	const file = raw.slice(0, firstColon);
	const lineStr = raw.slice(firstColon + 1, secondColon);
	const lineNum = Number.parseInt(lineStr, 10);
	if (Number.isNaN(lineNum)) return null;

	return {
		file,
		line: lineNum,
		content: raw.slice(secondColon + 1),
		raw,
	};
}

/**
 * Check whether a line of text matches the given pattern under rg-compatible
 * flag semantics. Used to filter mnemex-surfaced lines so the merger only
 * prepends lines that the real `rg` pattern would have matched.
 *
 * Supports: `-F` fixed-strings, `-w` word-regexp, `-x` line-regexp,
 * `-i`/`-s`/`-S` case modes. Defaults to case-sensitive regex matching —
 * this is a change from earlier behaviour which was always case-insensitive.
 */
export function matchesPattern(
	text: string,
	pattern: string,
	flags: MatchFlags = DEFAULT_FLAGS,
): boolean {
	const caseInsensitive = isCaseInsensitive(pattern, flags);
	const reFlags = caseInsensitive ? "i" : "";

	// Build the effective regex source based on flags
	let source: string;
	if (flags.fixedStrings) {
		source = escapeRegex(pattern);
	} else {
		source = pattern;
	}

	if (flags.wordRegexp) {
		// `-w`: require word boundaries around the whole match
		source = `\\b(?:${source})\\b`;
	}
	if (flags.lineRegexp) {
		// `-x`: pattern must match the entire line
		source = `^(?:${source})$`;
	}

	try {
		const re = new RegExp(source, reFlags);
		return re.test(text);
	} catch {
		// Invalid regex → fall back to literal substring match with case flag.
		// Word/line boundary constraints can't be honoured in the fallback
		// path; rejecting is safer than over-matching for the merger.
		if (flags.wordRegexp || flags.lineRegexp) return false;
		const hay = caseInsensitive ? text.toLowerCase() : text;
		const needle = caseInsensitive ? pattern.toLowerCase() : pattern;
		return hay.includes(needle);
	}
}

/**
 * Merge rg stdout output with mnemex SearchResult[] into rg-compatible output.
 *
 * Ordering:
 *   1. Lines from mnemex chunks that also match the pattern (semantically ranked)
 *   2. Remaining rg lines that mnemex didn't surface
 *
 * For `--files-with-matches` mode:
 *   1. Unique files from mnemex results (by score order)
 *   2. Remaining rg files
 *
 * For `--count` mode:
 *   Passthrough rg output only (mnemex can't count regex matches).
 */
export function mergeResults(
	rgOutput: string,
	mnemexResults: SearchResult[],
	pattern: string,
	mode: OutputMode,
	matchFlags: MatchFlags = DEFAULT_FLAGS,
	cwd: string = process.cwd(),
): string {
	if (mode === "count") {
		// Pass through rg count output unchanged
		return rgOutput;
	}

	if (mode === "files-with-matches") {
		return mergeFilesMode(rgOutput, mnemexResults, cwd);
	}

	// Default: content mode
	return mergeContentMode(rgOutput, mnemexResults, pattern, matchFlags, cwd);
}

/** Merge for --files-with-matches mode */
function mergeFilesMode(
	rgOutput: string,
	mnemexResults: SearchResult[],
	cwd: string,
): string {
	const rgFiles = rgOutput
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l.length > 0);
	const rgFileSet = new Set(rgFiles);

	// Collect mnemex files in score order, deduplicated; normalize paths
	// to match rg's relative-to-cwd format. Skip mnemex pseudo-files
	// (enrichment docs etc) so the output matches what rg could actually find.
	const mnemexFiles: string[] = [];
	const seenMnemex = new Set<string>();
	for (const result of mnemexResults) {
		const raw = result.chunk.filePath;
		if (!isRealFilePath(raw)) continue;
		const fp = normalizePath(raw, cwd);
		if (!seenMnemex.has(fp)) {
			seenMnemex.add(fp);
			mnemexFiles.push(fp);
		}
	}

	// Output: mnemex files first (deduplicated), then rg files mnemex didn't include
	const lines: string[] = [
		...mnemexFiles,
		...rgFiles.filter((f) => !seenMnemex.has(f)),
	];

	// Deduplicate while preserving order
	const seen = new Set<string>();
	const deduped = lines.filter((l) => {
		if (seen.has(l)) return false;
		seen.add(l);
		return true;
	});

	if (deduped.length === 0) return "";
	return `${deduped.join("\n")}\n`;
}

/** Merge for content mode */
function mergeContentMode(
	rgOutput: string,
	mnemexResults: SearchResult[],
	pattern: string,
	matchFlags: MatchFlags,
	cwd: string,
): string {
	// Parse rg output into structured lines
	const rawLines = rgOutput.split("\n");
	const rgParsed: RgLine[] = [];
	const nonMatchLines: string[] = []; // separators, context lines, etc.

	for (const raw of rawLines) {
		if (raw.length === 0) continue;
		const parsed = parseRgLine(raw);
		if (parsed) {
			rgParsed.push(parsed);
		} else {
			nonMatchLines.push(raw);
		}
	}

	// Build a set of all rg file:line keys for deduplication
	const rgSet = new Set<string>(rgParsed.map((r) => `${r.file}:${r.line}`));

	// Extract matching lines from mnemex chunks
	const mnemexLines: RgLine[] = [];
	const mnemexKeySet = new Set<string>();

	for (const result of mnemexResults) {
		const raw = result.chunk.filePath;
		if (!isRealFilePath(raw)) continue;
		const { startLine, content } = result.chunk;
		const filePath = normalizePath(raw, cwd);
		const chunkLines = content.split("\n");

		for (let idx = 0; idx < chunkLines.length; idx++) {
			const lineContent = chunkLines[idx];
			const lineNum = startLine + idx;
			const key = `${filePath}:${lineNum}`;

			// Skip if rg already found this line
			if (rgSet.has(key)) continue;
			// Skip if we already added this line from another mnemex chunk
			if (mnemexKeySet.has(key)) continue;
			// Only include lines that actually match the pattern under rg flag semantics
			if (!matchesPattern(lineContent, pattern, matchFlags)) continue;

			mnemexKeySet.add(key);
			mnemexLines.push({
				file: filePath,
				line: lineNum,
				content: lineContent,
				raw: `${filePath}:${lineNum}:${lineContent}`,
			});
		}
	}

	// Build final output
	const outputLines: string[] = [];

	// mnemex-ranked results first
	for (const line of mnemexLines) {
		outputLines.push(line.raw);
	}

	// Remaining rg results (not surfaced by mnemex)
	for (const line of rgParsed) {
		const key = `${line.file}:${line.line}`;
		if (!mnemexKeySet.has(key)) {
			outputLines.push(line.raw);
		}
	}

	// Include non-parseable rg lines (context separators, lines without -n, etc.)
	for (const raw of nonMatchLines) {
		outputLines.push(raw);
	}

	if (outputLines.length === 0) return "";
	return `${outputLines.join("\n")}\n`;
}
