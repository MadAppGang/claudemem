/**
 * Context file scanner
 *
 * Discovers CLAUDE.md, AGENTS.md, .cursorrules, and other context files
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { ContextFile, ContextFileType } from "./types.js";

/**
 * Scan project root for context files
 */
export function scanForContextFiles(projectPath: string): ContextFile[] {
	const files: ContextFile[] = [];

	// Primary context files at project root
	const primaryFiles = [
		{ name: "CLAUDE.md", type: "claude-md" as const },
		{ name: "AGENTS.md", type: "agents-md" as const },
		{ name: ".cursorrules", type: "cursorrules" as const },
		{ name: ".github/copilot-instructions.md", type: "copilot" as const },
		{ name: ".windsurfrules", type: "other" as const },
		{ name: "codex.md", type: "other" as const },
	];

	for (const { name, type } of primaryFiles) {
		const fullPath = join(projectPath, name);
		if (existsSync(fullPath)) {
			const content = readFileSync(fullPath, "utf-8");
			const lineCount = content.split("\n").length;
			const tokenEstimate = Math.ceil(content.length / 4);

			files.push({
				path: fullPath,
				relativePath: relative(projectPath, fullPath),
				type,
				content,
				lineCount,
				tokenEstimate,
			});
		}
	}

	// Scan .claude/ directory for skill files
	const claudeDir = join(projectPath, ".claude");
	if (existsSync(claudeDir) && statSync(claudeDir).isDirectory()) {
		scanDirectory(claudeDir, projectPath, "skill", files);
	}

	// Scan .cursor/ directory for rule/skill files
	const cursorDir = join(projectPath, ".cursor");
	if (existsSync(cursorDir) && statSync(cursorDir).isDirectory()) {
		scanDirectory(cursorDir, projectPath, "other", files);
	}

	// Scan .windsurfrules directory
	const windDir = join(projectPath, ".windsurfrules");
	if (existsSync(windDir) && statSync(windDir).isDirectory()) {
		scanDirectory(windDir, projectPath, "other", files);
	}

	return files;
}

/**
 * Recursively scan directory for context files
 */
function scanDirectory(
	dirPath: string,
	projectPath: string,
	type: ContextFileType,
	files: ContextFile[],
	depth = 0,
): void {
	if (depth > 3) return; // Limit recursion depth

	try {
		const entries = readdirSync(dirPath, { withFileTypes: true });

		for (const entry of entries) {
			const fullPath = join(dirPath, entry.name);

			if (
				entry.isFile() &&
				(entry.name.endsWith(".md") || entry.name.endsWith(".txt"))
			) {
				const content = readFileSync(fullPath, "utf-8");
				const lineCount = content.split("\n").length;
				const tokenEstimate = Math.ceil(content.length / 4);

				files.push({
					path: fullPath,
					relativePath: relative(projectPath, fullPath),
					type,
					content,
					lineCount,
					tokenEstimate,
				});
			} else if (
				entry.isDirectory() &&
				!entry.name.startsWith(".") &&
				!entry.name.startsWith("node_modules")
			) {
				scanDirectory(fullPath, projectPath, type, files, depth + 1);
			}
		}
	} catch {
		// Silently ignore unreadable directories
	}
}
