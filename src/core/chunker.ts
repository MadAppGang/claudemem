/**
 * AST-based Code Chunker
 *
 * Uses tree-sitter to parse code and extract semantic chunks
 * (functions, classes, methods) while preserving context.
 */

import { createHash } from "node:crypto";
import type { Node, Tree } from "web-tree-sitter";
import { getParserManager } from "../parsers/parser-manager.js";
import type {
	ChunkType,
	CodeChunk,
	ParsedChunk,
	SupportedLanguage,
} from "../types.js";

// ============================================================================
// Constants
// ============================================================================

/** Maximum chunk size in tokens (approximate) */
const MAX_CHUNK_TOKENS = 1500;

/** Minimum chunk size in tokens */
const MIN_CHUNK_TOKENS = 50;

/** Characters per token estimate for code */
const CHARS_PER_TOKEN = 4;

// ============================================================================
// Chunk Extraction
// ============================================================================

/**
 * Extract chunks from a source file
 */
export async function chunkFile(
	source: string,
	filePath: string,
	language: SupportedLanguage,
	fileHash: string,
): Promise<CodeChunk[]> {
	const parserManager = getParserManager();

	// Parse the source
	const tree = await parserManager.parse(source, language);
	if (!tree) {
		// Fallback to line-based chunking if parsing fails
		return fallbackChunk(source, filePath, language, fileHash);
	}

	const config = parserManager.getLanguageConfig(language);

	// Extract semantic chunks using AST traversal
	const parsedChunks = extractChunks(tree, source, language);

	// Convert to CodeChunk format
	const chunks: CodeChunk[] = [];

	for (const parsed of parsedChunks) {
		// Split large chunks if necessary
		if (estimateTokens(parsed.content) > MAX_CHUNK_TOKENS) {
			const splitChunks = splitLargeChunk(parsed, source);
			for (const split of splitChunks) {
				chunks.push(createCodeChunk(split, filePath, language, fileHash));
			}
		} else if (estimateTokens(parsed.content) >= MIN_CHUNK_TOKENS) {
			chunks.push(createCodeChunk(parsed, filePath, language, fileHash));
		}
	}

	// If no chunks were extracted, fall back to line-based chunking
	if (chunks.length === 0) {
		return fallbackChunk(source, filePath, language, fileHash);
	}

	return chunks;
}

/**
 * Extract semantic chunks from AST
 */
function extractChunks(
	tree: Tree,
	source: string,
	language: SupportedLanguage,
): ParsedChunk[] {
	const chunks: ParsedChunk[] = [];
	const sourceLines = source.split("\n");

	// Walk the tree and extract semantic nodes
	walkTree(tree.rootNode, (node) => {
		const chunkType = getChunkType(node.type, language);
		if (!chunkType) {
			return true; // Continue traversing
		}

		// Get the name if available
		const name = extractName(node, language);

		// Get parent name for methods
		const parentName = extractParentName(node, language);

		// Get signature for functions/methods
		const signature = extractSignature(node, source, language);

		// Get content
		const content = source.slice(node.startIndex, node.endIndex);

		// Check if this is a meaningful chunk
		if (content.trim().length < 10) {
			return true; // Skip tiny chunks
		}

		chunks.push({
			content,
			startLine: node.startPosition.row,
			endLine: node.endPosition.row,
			chunkType,
			name,
			parentName,
			signature,
		});

		// Don't traverse into this node's children for nested chunks
		// (we want the whole function, not individual statements)
		return false;
	});

	return chunks;
}

/**
 * Walk tree recursively
 */
function walkTree(
	node: Node,
	callback: (node: Node) => boolean,
): void {
	const shouldContinue = callback(node);
	if (shouldContinue) {
		for (let i = 0; i < node.childCount; i++) {
			walkTree(node.child(i)!, callback);
		}
	}
}

/**
 * Map AST node type to chunk type
 */
function getChunkType(
	nodeType: string,
	language: SupportedLanguage,
): ChunkType | null {
	// Function types
	const functionTypes = [
		"function_declaration",
		"function_definition",
		"function_item",
		"arrow_function",
		"method_declaration",
	];

	// Class types
	const classTypes = [
		"class_declaration",
		"class_definition",
		"class_specifier",
		"struct_item",
		"struct_specifier",
		"interface_declaration",
		"trait_item",
		"impl_item",
	];

	// Method types
	const methodTypes = ["method_definition", "method_declaration"];

	// Module-level types
	const moduleTypes = [
		"type_alias_declaration",
		"enum_item",
		"enum_declaration",
		"enum_specifier",
	];

	if (methodTypes.includes(nodeType)) {
		return "method";
	}
	if (functionTypes.includes(nodeType)) {
		return "function";
	}
	if (classTypes.includes(nodeType)) {
		return "class";
	}
	if (moduleTypes.includes(nodeType)) {
		return "module";
	}

	return null;
}

/**
 * Extract name from AST node
 */
function extractName(
	node: Node,
	language: SupportedLanguage,
): string | undefined {
	// Try different name field patterns
	const namePatterns = ["name", "declarator"];

	for (const pattern of namePatterns) {
		const nameNode = node.childForFieldName(pattern);
		if (nameNode) {
			// Handle nested declarators (e.g., C function_declarator)
			if (nameNode.type.includes("declarator")) {
				const innerName = nameNode.childForFieldName("declarator");
				if (innerName) {
					return innerName.text;
				}
			}
			return nameNode.text;
		}
	}

	// For Go method declarations
	if (node.type === "method_declaration") {
		const nameNode = node.childForFieldName("name");
		if (nameNode) {
			return nameNode.text;
		}
	}

	return undefined;
}

/**
 * Extract parent class name for methods
 */
function extractParentName(
	node: Node,
	language: SupportedLanguage,
): string | undefined {
	// For method definitions inside classes
	if (node.type === "method_definition" || node.type === "method_declaration") {
		let parent = node.parent;
		while (parent) {
			if (
				parent.type === "class_declaration" ||
				parent.type === "class_definition" ||
				parent.type === "class_body"
			) {
				const classNode = parent.type === "class_body" ? parent.parent : parent;
				if (classNode) {
					const nameNode = classNode.childForFieldName("name");
					if (nameNode) {
						return nameNode.text;
					}
				}
			}
			parent = parent.parent;
		}
	}

	// For Rust impl blocks
	if (language === "rust" && node.type === "impl_item") {
		const typeNode = node.childForFieldName("type");
		if (typeNode) {
			return typeNode.text;
		}
	}

	// For Go methods (receiver type)
	if (language === "go" && node.type === "method_declaration") {
		const receiverNode = node.childForFieldName("receiver");
		if (receiverNode) {
			// Extract type from receiver
			const typeNode = receiverNode.descendantsOfType("type_identifier")[0];
			if (typeNode) {
				return typeNode.text;
			}
		}
	}

	return undefined;
}

/**
 * Extract function/method signature
 */
function extractSignature(
	node: Node,
	source: string,
	language: SupportedLanguage,
): string | undefined {
	// Get the first line or up to the opening brace
	const content = source.slice(node.startIndex, node.endIndex);
	const lines = content.split("\n");

	if (lines.length === 0) {
		return undefined;
	}

	// Find the signature (everything before the body)
	let signature = lines[0].trim();

	// For multi-line signatures, try to find the complete signature
	for (let i = 1; i < Math.min(lines.length, 5); i++) {
		const line = lines[i].trim();
		if (line.startsWith("{") || line.startsWith(":")) {
			break;
		}
		if (line.includes("{") || line.includes(":")) {
			// Include up to the brace/colon
			const braceIdx = Math.min(
				line.indexOf("{") >= 0 ? line.indexOf("{") : Infinity,
				line.indexOf(":") >= 0 ? line.indexOf(":") : Infinity,
			);
			signature += " " + line.slice(0, braceIdx).trim();
			break;
		}
		signature += " " + line;
	}

	// Clean up signature
	signature = signature.replace(/\s+/g, " ").trim();

	// Limit length
	if (signature.length > 200) {
		signature = signature.slice(0, 197) + "...";
	}

	return signature || undefined;
}

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Create a CodeChunk from parsed chunk data
 */
function createCodeChunk(
	parsed: ParsedChunk,
	filePath: string,
	language: SupportedLanguage,
	fileHash: string,
): CodeChunk {
	// Include filePath and line range in hash to prevent collisions across files
	// with identical content (e.g., boilerplate functions)
	const hashInput = `${filePath}:${parsed.startLine}:${parsed.endLine}:${parsed.content}`;
	const id = createHash("sha256").update(hashInput).digest("hex");

	return {
		id,
		content: parsed.content,
		filePath,
		startLine: parsed.startLine + 1, // Convert to 1-indexed
		endLine: parsed.endLine + 1,
		language,
		chunkType: parsed.chunkType,
		name: parsed.name,
		parentName: parsed.parentName,
		signature: parsed.signature,
		fileHash,
	};
}

/**
 * Estimate tokens in text
 */
function estimateTokens(text: string): number {
	return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Split a large chunk into smaller pieces
 */
function splitLargeChunk(chunk: ParsedChunk, source: string): ParsedChunk[] {
	const lines = chunk.content.split("\n");
	const maxLinesPerChunk = Math.floor(
		(MAX_CHUNK_TOKENS * CHARS_PER_TOKEN) / 80,
	); // Assume 80 chars per line

	const chunks: ParsedChunk[] = [];
	let currentLines: string[] = [];
	let currentStartLine = chunk.startLine;

	for (let i = 0; i < lines.length; i++) {
		currentLines.push(lines[i]);

		if (currentLines.length >= maxLinesPerChunk) {
			chunks.push({
				content: currentLines.join("\n"),
				startLine: currentStartLine,
				endLine: currentStartLine + currentLines.length - 1,
				chunkType: "block",
				name: chunk.name ? `${chunk.name} (part ${chunks.length + 1})` : undefined,
				parentName: chunk.parentName,
			});

			currentLines = [];
			currentStartLine = chunk.startLine + i + 1;
		}
	}

	// Add remaining lines
	if (currentLines.length > 0) {
		chunks.push({
			content: currentLines.join("\n"),
			startLine: currentStartLine,
			endLine: currentStartLine + currentLines.length - 1,
			chunkType: "block",
			name: chunk.name ? `${chunk.name} (part ${chunks.length + 1})` : undefined,
			parentName: chunk.parentName,
		});
	}

	return chunks;
}

/**
 * Fallback line-based chunking for unsupported languages
 */
function fallbackChunk(
	source: string,
	filePath: string,
	language: string,
	fileHash: string,
): CodeChunk[] {
	const lines = source.split("\n");
	const maxLinesPerChunk = Math.floor(
		(MAX_CHUNK_TOKENS * CHARS_PER_TOKEN) / 80,
	);

	const chunks: CodeChunk[] = [];
	let currentLines: string[] = [];
	let currentStartLine = 0;

	for (let i = 0; i < lines.length; i++) {
		currentLines.push(lines[i]);

		if (currentLines.length >= maxLinesPerChunk) {
			const content = currentLines.join("\n");
			if (content.trim().length >= MIN_CHUNK_TOKENS * CHARS_PER_TOKEN) {
				const startLine = currentStartLine + 1;
				const endLine = i + 1;
				const hashInput = `${filePath}:${startLine}:${endLine}:${content}`;
				const id = createHash("sha256").update(hashInput).digest("hex");
				chunks.push({
					id,
					content,
					filePath,
					startLine,
					endLine,
					language,
					chunkType: "block",
					fileHash,
				});
			}

			currentLines = [];
			currentStartLine = i + 1;
		}
	}

	// Add remaining lines
	if (currentLines.length > 0) {
		const content = currentLines.join("\n");
		if (content.trim().length >= MIN_CHUNK_TOKENS * CHARS_PER_TOKEN) {
			const startLine = currentStartLine + 1;
			const endLine = lines.length;
			const hashInput = `${filePath}:${startLine}:${endLine}:${content}`;
			const id = createHash("sha256").update(hashInput).digest("hex");
			chunks.push({
				id,
				content,
				filePath,
				startLine,
				endLine,
				language,
				chunkType: "block",
				fileHash,
			});
		}
	}

	return chunks;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Chunk a file by path
 */
export async function chunkFileByPath(
	source: string,
	filePath: string,
	fileHash: string,
): Promise<CodeChunk[]> {
	const parserManager = getParserManager();
	const language = parserManager.getLanguage(filePath);

	if (!language) {
		// Unsupported language - use fallback chunking
		const ext = filePath.split(".").pop() || "unknown";
		return fallbackChunk(source, filePath, ext, fileHash);
	}

	return chunkFile(source, filePath, language, fileHash);
}

/**
 * Check if a file can be chunked
 */
export function canChunkFile(filePath: string): boolean {
	const parserManager = getParserManager();
	return parserManager.isSupported(filePath);
}
