/**
 * mnemex Integration Plugin for OpenCode
 *
 * Intercepts grep/glob/list tools and suggests mnemex alternatives
 * for semantic code search.
 *
 * Installation:
 *   1. Copy to .opencode/plugin/mnemex.ts
 *   2. Add to opencode.json: { "plugin": ["file://.opencode/plugin/mnemex.ts"] }
 *
 * @see https://github.com/MadAppGang/mnemex
 */

import type { Plugin } from "@opencode-ai/plugin";

export const MnemexPlugin: Plugin = async (ctx) => {
	const { $ } = ctx;

	// Check if mnemex is available (cross-platform)
	let mnemexAvailable = false;
	let mnemexIndexed = false;

	try {
		const whichResult = await $`which mnemex`.quiet();
		mnemexAvailable = whichResult.exitCode === 0;

		if (mnemexAvailable) {
			const statusResult = await $`mnemex status`.quiet();
			mnemexIndexed = statusResult.exitCode === 0;
		}
	} catch {
		mnemexAvailable = false;
	}

	// Log status on plugin load
	if (!mnemexAvailable) {
		console.log(
			"\n⚠️  mnemex not installed. Install with: npm install -g mnemex\n",
		);
	} else if (!mnemexIndexed) {
		console.log("\n⚠️  mnemex not indexed. Run: mnemex index\n");
	} else {
		console.log("\n✅ mnemex plugin loaded\n");
	}

	return {
		"tool.execute.before": async (input, output) => {
			if (!mnemexAvailable || !mnemexIndexed) return;

			const tool = input.tool;
			const args = output.args;

			// Intercept grep with semantic queries
			if (tool === "grep" && args.pattern) {
				const pattern = String(args.pattern);

				// Detect semantic queries (not regex patterns)
				// Regex patterns typically have: [ ] ( ) | * + ? { } \ ^ $
				const isSemanticQuery =
					!pattern.match(/[\[\]\(\)\|\+\?\{\}\\^$]/) &&
					pattern.length > 3 &&
					pattern.includes(" "); // Natural language usually has spaces

				if (isSemanticQuery) {
					console.log(`\n💡 Tip: For semantic search, try:`);
					console.log(`   mnemex --nologo search "${pattern}" --raw`);
					console.log(`   mnemex --nologo map "${pattern}" --raw\n`);
				}
			}

			// Intercept glob for broad file searches
			if (tool === "glob" && args.pattern) {
				const pattern = String(args.pattern);

				// Detect broad patterns like **/*.ts or **/*
				if (pattern.startsWith("**")) {
					console.log(`\n💡 Tip: For structural overview, try:`);
					console.log(`   mnemex --nologo map --raw`);
					console.log(`   (Shows symbols ranked by importance)\n`);
				}
			}

			// Intercept list for directory exploration
			if (tool === "list") {
				console.log(`\n💡 Tip: For codebase structure with PageRank, try:`);
				console.log(`   mnemex --nologo map --raw\n`);
			}

			// Intercept read for multiple files (suggest targeted reads)
			if (tool === "read" && args.filePath) {
				// If reading a whole directory's worth, suggest map first
				const filePath = String(args.filePath);
				if (filePath.includes("*") || filePath.endsWith("/")) {
					console.log(`\n💡 Tip: Find specific code locations first:`);
					console.log(`   mnemex --nologo symbol <name> --raw`);
					console.log(`   (Then read specific file:line ranges)\n`);
				}
			}
		},
	};
};

export default MnemexPlugin;
