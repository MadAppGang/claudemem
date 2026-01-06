/**
 * Document chunker for header-based chunking of documentation files.
 * Supports Markdown, RST, AsciiDoc, and Org formats.
 */

import type { CodeChunk } from "../types.js";
import crypto from "node:crypto";

// ============================================================================
// Constants
// ============================================================================

const MAX_CHUNK_TOKENS = 1500;
const MIN_CHUNK_TOKENS = 50;
const CHARS_PER_TOKEN = 4;

// ============================================================================
// Types
// ============================================================================

interface DocumentHeader {
	level: number; // 1 = h1, 2 = h2, etc.
	text: string; // Header text
	startLine: number; // Line number where header starts (1-indexed)
	endLine: number; // Line number where section ends (1-indexed)
	content: string; // Section content (including header)
	parentHeader?: string; // Parent section title
}

type DocumentLanguage = "markdown" | "rst" | "asciidoc" | "org";

// ============================================================================
// Public API
// ============================================================================

/**
 * Check if a file is a document format (not code)
 */
export function isDocumentFormat(language: string): boolean {
	return ["markdown", "rst", "asciidoc", "org"].includes(language);
}

/**
 * Chunk a document file by headers
 */
export async function chunkDocument(
	source: string,
	filePath: string,
	language: DocumentLanguage,
	fileHash: string,
): Promise<CodeChunk[]> {
	// Empty documents return no chunks
	if (!source.trim()) {
		return [];
	}

	// Extract headers and build hierarchy
	const headers = extractHeaders(source, language);

	// If no headers, create a single chunk for the entire file
	if (headers.length === 0) {
		const lines = source.split("\n");
		const chunk = createChunk(
			source,
			filePath.split("/").pop() || filePath,
			filePath,
			1,
			lines.length,
			language,
			fileHash,
			undefined,
			undefined,
		);
		return [chunk];
	}

	// Split large sections that exceed MAX_CHUNK_TOKENS
	const processedHeaders: DocumentHeader[] = [];
	for (const header of headers) {
		const tokenCount = estimateTokens(header.content);
		if (tokenCount > MAX_CHUNK_TOKENS) {
			const splits = splitLargeSection(header, language);
			processedHeaders.push(...splits);
		} else {
			// Include all sections regardless of size - small sections are still valuable for search
			processedHeaders.push(header);
		}
	}

	// Convert headers to CodeChunks
	const chunks: CodeChunk[] = processedHeaders.map((header) =>
		createChunk(
			header.content,
			header.text,
			filePath,
			header.startLine,
			header.endLine,
			language,
			fileHash,
			header.parentHeader,
			buildHeaderSignature(header.text, header.level, language),
		),
	);

	return chunks;
}

// ============================================================================
// Internal Functions
// ============================================================================

/**
 * Extract headers from document with hierarchy tracking
 */
function extractHeaders(
	source: string,
	language: DocumentLanguage,
): DocumentHeader[] {
	const lines = source.split("\n");
	const headers: DocumentHeader[] = [];

	switch (language) {
		case "markdown":
			return extractMarkdownHeaders(lines);
		case "rst":
			return extractRSTHeaders(lines);
		case "asciidoc":
			return extractAsciiDocHeaders(lines);
		case "org":
			return extractOrgHeaders(lines);
	}
}

/**
 * Extract Markdown headers (# ## ###)
 */
function extractMarkdownHeaders(lines: string[]): DocumentHeader[] {
	const headers: DocumentHeader[] = [];
	const headerStack: Array<{ level: number; text: string }> = [];
	const headerRegex = /^(#{1,6})\s+(.+)$/;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const match = line.match(headerRegex);

		if (match) {
			// Finalize previous header's content
			if (headers.length > 0) {
				headers[headers.length - 1].endLine = i; // Previous section ends here
			}

			const level = match[1].length;
			const text = match[2].trim();

			// Update header stack (pop headers at same or deeper level)
			while (
				headerStack.length > 0 &&
				headerStack[headerStack.length - 1].level >= level
			) {
				headerStack.pop();
			}

			// Determine parent header
			const parentHeader =
				headerStack.length > 0
					? headerStack[headerStack.length - 1].text
					: undefined;

			// Push current header to stack
			headerStack.push({ level, text });

			// Add new header
			headers.push({
				level,
				text,
				startLine: i + 1, // 1-indexed
				endLine: lines.length, // Placeholder, will be updated
				content: "", // Will be filled later
				parentHeader,
			});
		}
	}

	// Fill content for each header
	for (let i = 0; i < headers.length; i++) {
		const header = headers[i];
		const nextHeader = headers[i + 1];
		const endLine = nextHeader ? nextHeader.startLine - 1 : lines.length;

		header.endLine = endLine;
		header.content = lines.slice(header.startLine - 1, endLine).join("\n");
	}

	return headers;
}

/**
 * Extract RST headers (underline style)
 */
function extractRSTHeaders(lines: string[]): DocumentHeader[] {
	const headers: DocumentHeader[] = [];
	const headerStack: Array<{ level: number; text: string }> = [];

	// RST underline characters (order defines hierarchy)
	const underlineChars = [
		"=",
		"-",
		"`",
		":",
		".",
		"'",
		'"',
		"~",
		"^",
		"_",
		"*",
		"+",
		"#",
	];
	const levelMap = new Map<string, number>();

	for (let i = 0; i < lines.length - 1; i++) {
		const line = lines[i];
		const nextLine = lines[i + 1];

		// Check if next line is an underline (3+ same characters)
		const underlineMatch = nextLine.match(/^([=\-`:.'"~^_*+#])\1{2,}$/);
		if (underlineMatch && line.trim()) {
			// Finalize previous header's content
			if (headers.length > 0) {
				headers[headers.length - 1].endLine = i; // Previous section ends here
			}

			const underlineChar = underlineMatch[1];
			const text = line.trim();

			// Assign level based on first occurrence
			if (!levelMap.has(underlineChar)) {
				levelMap.set(underlineChar, levelMap.size + 1);
			}
			const level = levelMap.get(underlineChar)!;

			// Update header stack
			while (
				headerStack.length > 0 &&
				headerStack[headerStack.length - 1].level >= level
			) {
				headerStack.pop();
			}

			const parentHeader =
				headerStack.length > 0
					? headerStack[headerStack.length - 1].text
					: undefined;
			headerStack.push({ level, text });

			headers.push({
				level,
				text,
				startLine: i + 1, // 1-indexed
				endLine: lines.length,
				content: "",
				parentHeader,
			});

			i++; // Skip underline line
		}
	}

	// Fill content for each header
	for (let i = 0; i < headers.length; i++) {
		const header = headers[i];
		const nextHeader = headers[i + 1];
		const endLine = nextHeader ? nextHeader.startLine - 1 : lines.length;

		header.endLine = endLine;
		header.content = lines.slice(header.startLine - 1, endLine).join("\n");
	}

	return headers;
}

/**
 * Extract AsciiDoc headers (= ==)
 */
function extractAsciiDocHeaders(lines: string[]): DocumentHeader[] {
	const headers: DocumentHeader[] = [];
	const headerStack: Array<{ level: number; text: string }> = [];
	const headerRegex = /^(={1,6})\s+(.+)$/;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const match = line.match(headerRegex);

		if (match) {
			if (headers.length > 0) {
				headers[headers.length - 1].endLine = i;
			}

			const level = match[1].length;
			const text = match[2].trim();

			while (
				headerStack.length > 0 &&
				headerStack[headerStack.length - 1].level >= level
			) {
				headerStack.pop();
			}

			const parentHeader =
				headerStack.length > 0
					? headerStack[headerStack.length - 1].text
					: undefined;
			headerStack.push({ level, text });

			headers.push({
				level,
				text,
				startLine: i + 1,
				endLine: lines.length,
				content: "",
				parentHeader,
			});
		}
	}

	// Fill content
	for (let i = 0; i < headers.length; i++) {
		const header = headers[i];
		const nextHeader = headers[i + 1];
		const endLine = nextHeader ? nextHeader.startLine - 1 : lines.length;

		header.endLine = endLine;
		header.content = lines.slice(header.startLine - 1, endLine).join("\n");
	}

	return headers;
}

/**
 * Extract Org mode headers (* **)
 */
function extractOrgHeaders(lines: string[]): DocumentHeader[] {
	const headers: DocumentHeader[] = [];
	const headerStack: Array<{ level: number; text: string }> = [];
	const headerRegex = /^(\*{1,6})\s+(.+)$/;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const match = line.match(headerRegex);

		if (match) {
			if (headers.length > 0) {
				headers[headers.length - 1].endLine = i;
			}

			const level = match[1].length;
			const text = match[2].trim();

			while (
				headerStack.length > 0 &&
				headerStack[headerStack.length - 1].level >= level
			) {
				headerStack.pop();
			}

			const parentHeader =
				headerStack.length > 0
					? headerStack[headerStack.length - 1].text
					: undefined;
			headerStack.push({ level, text });

			headers.push({
				level,
				text,
				startLine: i + 1,
				endLine: lines.length,
				content: "",
				parentHeader,
			});
		}
	}

	// Fill content
	for (let i = 0; i < headers.length; i++) {
		const header = headers[i];
		const nextHeader = headers[i + 1];
		const endLine = nextHeader ? nextHeader.startLine - 1 : lines.length;

		header.endLine = endLine;
		header.content = lines.slice(header.startLine - 1, endLine).join("\n");
	}

	return headers;
}

/**
 * Split large document sections to respect token limits
 */
function splitLargeSection(
	section: DocumentHeader,
	language: DocumentLanguage,
): DocumentHeader[] {
	const codeBlockRanges = findCodeBlockRanges(section.content, language);
	const lines = section.content.split("\n");
	const chunks: DocumentHeader[] = [];

	let currentChunk: string[] = [];
	let currentStartLine = section.startLine;
	let chunkIndex = 0;

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const absoluteLine = section.startLine + i;

		// Check if we're inside a code block
		const insideCodeBlock = codeBlockRanges.some(
			(range) => i >= range.start && i <= range.end,
		);

		currentChunk.push(line);

		// Split if we exceed MAX_CHUNK_TOKENS and not inside a code block
		const tokenCount = estimateTokens(currentChunk.join("\n"));
		if (tokenCount >= MAX_CHUNK_TOKENS && !insideCodeBlock) {
			// Find paragraph boundary (blank line)
			const nextBlankLine = lines
				.slice(i + 1)
				.findIndex((l) => l.trim() === "");
			if (nextBlankLine !== -1 && nextBlankLine < 10) {
				// Look ahead up to 10 lines
				// Include lines up to blank line
				for (let j = 0; j <= nextBlankLine; j++) {
					if (i + 1 + j < lines.length) {
						currentChunk.push(lines[i + 1 + j]);
						i++;
					}
				}
			}

			// Create chunk
			chunks.push({
				level: section.level,
				text: `${section.text} (part ${chunkIndex + 1})`,
				startLine: currentStartLine,
				endLine: section.startLine + i,
				content: currentChunk.join("\n"),
				parentHeader: section.parentHeader,
			});

			chunkIndex++;
			currentChunk = [];
			currentStartLine = section.startLine + i + 1;
		}
	}

	// Add remaining content
	if (currentChunk.length > 0) {
		chunks.push({
			level: section.level,
			text:
				chunks.length > 0
					? `${section.text} (part ${chunkIndex + 1})`
					: section.text,
			startLine: currentStartLine,
			endLine: section.endLine,
			content: currentChunk.join("\n"),
			parentHeader: section.parentHeader,
		});
	}

	return chunks.length > 0 ? chunks : [section];
}

/**
 * Find code block ranges to avoid splitting inside them
 */
function findCodeBlockRanges(
	content: string,
	language: DocumentLanguage,
): Array<{ start: number; end: number }> {
	const lines = content.split("\n");
	const ranges: Array<{ start: number; end: number }> = [];

	switch (language) {
		case "markdown": {
			let inBlock = false;
			let blockStart = 0;
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].startsWith("```")) {
					if (inBlock) {
						ranges.push({ start: blockStart, end: i });
						inBlock = false;
					} else {
						blockStart = i;
						inBlock = true;
					}
				}
			}
			break;
		}
		case "rst": {
			// RST code blocks start with "::" and indented content
			let inBlock = false;
			let blockStart = 0;
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].trim().endsWith("::")) {
					blockStart = i;
					inBlock = true;
				} else if (
					inBlock &&
					lines[i].trim() &&
					!lines[i].startsWith(" ") &&
					!lines[i].startsWith("\t")
				) {
					ranges.push({ start: blockStart, end: i - 1 });
					inBlock = false;
				}
			}
			break;
		}
		case "asciidoc": {
			let inBlock = false;
			let blockStart = 0;
			for (let i = 0; i < lines.length; i++) {
				if (lines[i].startsWith("----")) {
					if (inBlock) {
						ranges.push({ start: blockStart, end: i });
						inBlock = false;
					} else {
						blockStart = i;
						inBlock = true;
					}
				}
			}
			break;
		}
		case "org": {
			let inBlock = false;
			let blockStart = 0;
			for (let i = 0; i < lines.length; i++) {
				const lower = lines[i].toLowerCase();
				if (lower.startsWith("#+begin_src")) {
					blockStart = i;
					inBlock = true;
				} else if (lower.startsWith("#+end_src")) {
					ranges.push({ start: blockStart, end: i });
					inBlock = false;
				}
			}
			break;
		}
	}

	return ranges;
}

/**
 * Estimate token count from text
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Build header signature based on format
 */
function buildHeaderSignature(
	text: string,
	level: number,
	language: DocumentLanguage,
): string {
	switch (language) {
		case "markdown":
			return `${"#".repeat(level)} ${text}`;
		case "asciidoc":
			return `${"=".repeat(level)} ${text}`;
		case "org":
			return `${"*".repeat(level)} ${text}`;
		case "rst":
			// RST uses underlines - use most common convention
			const underlineChars = ["=", "-", "`", ":", ".", "'"];
			const char = underlineChars[level - 1] || "=";
			return `${text}\n${char.repeat(text.length)}`;
	}
}

/**
 * Create a CodeChunk from section data
 */
function createChunk(
	content: string,
	name: string,
	filePath: string,
	startLine: number,
	endLine: number,
	language: string,
	fileHash: string,
	parentName: string | undefined,
	signature: string | undefined,
): CodeChunk {
	// Generate unique ID
	const idContent = `${content}:${filePath}:${startLine}:${endLine}`;
	const id = crypto.createHash("sha256").update(idContent).digest("hex");

	// Generate content hash (stable across position changes)
	const contentHash = crypto.createHash("sha256").update(content).digest("hex");

	return {
		id,
		contentHash,
		content,
		filePath,
		startLine,
		endLine,
		language,
		chunkType: "document-section" as any, // Will be added to types.ts
		name,
		parentName,
		signature,
		fileHash,
	};
}
