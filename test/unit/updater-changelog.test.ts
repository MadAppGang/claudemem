import { describe, expect, test } from "bun:test";
import {
	displayChangelog,
	fetchChangelog,
	parseRelease,
} from "../../src/updater/changelog.js";

describe("updater changelog", () => {
	test("parses release sections into changelog items", () => {
		const entry = parseRelease({
			tag_name: "v0.32.0",
			name: "v0.32.0 - update command changelog",
			body: [
				"### Features",
				"- v0.32.0 - show changelog after update ([`abc1234`](https://example.com))",
				"### Bug Fixes",
				"- fix update cache",
				"### Docs",
				"- ignore documentation-only notes",
				"### Other Changes",
				"- bump to v0.32.0",
				"- update CHANGELOG",
				"- clean release metadata",
				"## Install",
				"- npm install -g mnemex@latest",
			].join("\n"),
		});

		expect(entry).toEqual({
			version: "0.32.0",
			title: "update command changelog",
			items: [
				{ type: "feat", text: "show changelog after update" },
				{ type: "fix", text: "fix update cache" },
				{ type: "chore", text: "clean release metadata" },
			],
		});
	});

	test("fetches releases newer than current through latest", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response(
				JSON.stringify([
					{
						tag_name: "v0.33.0",
						name: "v0.33.0 - newest",
						body: "### Features\n- newest feature",
					},
					{
						tag_name: "v0.31.0",
						name: "v0.31.0 - current",
						body: "### Features\n- already installed",
					},
					{
						tag_name: "v0.32.0",
						name: "v0.32.0 - middle",
						body: "### Bug Fixes\n- middle fix",
					},
				]),
				{ status: 200 },
			)) as unknown as typeof fetch;

		try {
			const entries = await fetchChangelog("0.31.0", "0.33.0", {
				repo: "MadAppGang/mnemex",
				timeoutMs: 1000,
			});

			expect(entries.map((entry) => entry.version)).toEqual([
				"0.33.0",
				"0.32.0",
			]);
			expect(entries[0].items[0]).toEqual({
				type: "feat",
				text: "newest feature",
			});
			expect(entries[1].items[0]).toEqual({
				type: "fix",
				text: "middle fix",
			});
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("prints an empty changelog notice when requested", () => {
		const originalLog = console.log;
		const lines: string[] = [];
		console.log = (...args: unknown[]) => {
			lines.push(args.join(" "));
		};

		try {
			displayChangelog([], { showEmptyMessage: true });
		} finally {
			console.log = originalLog;
		}

		expect(lines.join("\n")).toContain(
			"No changelog entries found for this update.",
		);
	});
});
