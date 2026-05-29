/**
 * GitHub release changelog helpers for the update command.
 */

import { compareVersions } from "./version.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const MAGENTA = "\x1b[35m";
const DIM = "\x1b[2m";

export interface GitHubRelease {
	tag_name: string;
	name?: string;
	body?: string;
}

export type ChangelogItemType = "feat" | "fix" | "breaking" | "perf" | "chore";

export interface ChangelogItem {
	type: ChangelogItemType;
	text: string;
}

export interface ChangelogEntry {
	version: string;
	title: string;
	items: ChangelogItem[];
}

export interface FetchChangelogOptions {
	repo?: string;
	timeoutMs?: number;
}

export interface DisplayChangelogOptions {
	compact?: boolean;
	productName?: string;
	showEmptyMessage?: boolean;
}

const SECTION_TYPE_MAP: Record<string, ChangelogItemType | null> = {
	"new features": "feat",
	features: "feat",
	"bug fixes": "fix",
	fixes: "fix",
	"breaking changes": "breaking",
	performance: "perf",
	"other changes": "chore",
	chore: "chore",
	refactor: "chore",
	documentation: null,
	docs: null,
};

function normalizeVersion(version: string): string {
	const withoutPrefix = version.replace(/^v/, "");
	const match = withoutPrefix.match(/\d+\.\d+\.\d+/);
	return match ? match[0] : withoutPrefix;
}

function extractReleaseTitle(name: string): string {
	const dashMatch = name.match(/\s[—–-]\s(.+)$/);
	return dashMatch ? dashMatch[1].trim() : "";
}

/**
 * Parse one GitHub release body into a display-friendly changelog entry.
 */
export function parseRelease(release: GitHubRelease): ChangelogEntry {
	const version = normalizeVersion(release.tag_name);
	const title = extractReleaseTitle(release.name ?? "");
	const items: ChangelogItem[] = [];

	if (!release.body) {
		return { version, title, items };
	}

	const lines = release.body.split("\n");
	let currentType: ChangelogItemType | null = "feat";

	for (const line of lines) {
		if (/^##\s+Install/i.test(line)) break;

		const sectionMatch = line.match(/^###\s+(.+)$/);
		if (sectionMatch) {
			const sectionName = sectionMatch[1].trim().toLowerCase();
			const mapped = SECTION_TYPE_MAP[sectionName];
			currentType = mapped === undefined ? "chore" : mapped;
			continue;
		}

		if (currentType === null) continue;

		const bulletMatch = line.match(/^[\s]*[-*]\s+(.+)$/);
		if (!bulletMatch) continue;

		let text = bulletMatch[1].trim();
		text = text.replace(/\(\[`[a-f0-9]+`\]\([^)]*\)\)\s*$/, "").trim();
		text = text.replace(/^v\d+\.\d+\.\d+\s*[—–-]\s*/, "").trim();

		if (/^bump\s+to\s+v/i.test(text)) continue;
		if (/^update\s+CHANGELOG/i.test(text)) continue;
		if (!text) continue;

		items.push({ type: currentType, text });
	}

	return { version, title, items };
}

/**
 * Fetch GitHub releases between currentVersion (exclusive) and latestVersion
 * (inclusive). Network errors return an empty changelog.
 */
export async function fetchChangelog(
	currentVersion: string,
	latestVersion: string,
	options: FetchChangelogOptions = {},
): Promise<ChangelogEntry[]> {
	const repo = options.repo ?? "MadAppGang/mnemex";
	const timeoutMs = options.timeoutMs ?? 5000;
	let timeout: ReturnType<typeof setTimeout> | undefined;

	try {
		const controller = new AbortController();
		timeout = setTimeout(() => controller.abort(), timeoutMs);

		const response = await fetch(
			`https://api.github.com/repos/${repo}/releases`,
			{
				signal: controller.signal,
				headers: {
					Accept: "application/vnd.github+json",
					"User-Agent": "mnemex-updater",
				},
			},
		);

		if (!response.ok) {
			return [];
		}

		const releases = (await response.json()) as GitHubRelease[];
		const current = normalizeVersion(currentVersion);
		const latest = normalizeVersion(latestVersion);

		const relevant = releases.filter((release) => {
			const version = normalizeVersion(release.tag_name);
			return (
				compareVersions(version, current) > 0 &&
				compareVersions(version, latest) <= 0
			);
		});

		relevant.sort((a, b) =>
			compareVersions(
				normalizeVersion(b.tag_name),
				normalizeVersion(a.tag_name),
			),
		);

		return relevant.map((release) => parseRelease(release));
	} catch {
		return [];
	} finally {
		if (timeout) clearTimeout(timeout);
	}
}

function itemStyle(type: ChangelogItemType): { symbol: string; color: string } {
	switch (type) {
		case "feat":
			return { symbol: "*", color: GREEN };
		case "fix":
			return { symbol: "*", color: YELLOW };
		case "breaking":
			return { symbol: "*", color: MAGENTA };
		case "perf":
			return { symbol: "*", color: CYAN };
		case "chore":
			return { symbol: "-", color: DIM };
	}
}

/**
 * Display changelog entries with ANSI formatting.
 */
export function displayChangelog(
	entries: ChangelogEntry[],
	options: DisplayChangelogOptions = {},
): void {
	const {
		compact = false,
		productName = "mnemex",
		showEmptyMessage = false,
	} = options;

	if (entries.length === 0) {
		if (showEmptyMessage) {
			console.log("");
			console.log(`${DIM}No changelog entries found for this update.${RESET}`);
		}
		return;
	}

	if (compact) {
		console.log(`Changelog: ${entries.length} release(s)`);
		for (const entry of entries) {
			const title = entry.title ? ` - ${entry.title}` : "";
			console.log(`v${entry.version}${title}`);
			for (const item of entry.items) {
				console.log(`- ${item.text}`);
			}
		}
		return;
	}

	console.log("");
	console.log(`${CYAN}${BOLD}What's New${RESET}`);
	console.log(`${DIM}${"=".repeat(32)}${RESET}`);
	console.log("");

	for (const entry of entries) {
		const title = entry.title ? `  ${entry.title}` : "";
		console.log(`  ${BOLD}${GREEN}v${entry.version}${RESET}${title}`);
		console.log(`  ${DIM}${"-".repeat(30)}${RESET}`);

		for (const item of entry.items) {
			const { symbol, color } = itemStyle(item.type);
			console.log(`    ${color}${symbol}${RESET} ${item.text}`);
		}

		console.log("");
	}

	console.log(
		`${CYAN}Please restart any running ${productName} sessions.${RESET}`,
	);
}
