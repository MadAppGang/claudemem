/**
 * ResultList Component
 *
 * Scrollable list of search results with rich display:
 *   Line 1: rank, name, combined score bar, vector/keyword scores
 *   Line 2: file:line, type, signature preview or first line of content
 *   Expanded: full code preview with syntax highlighting + AST if available
 */

import type { SearchResult, ASTMetadata } from "../../types.js";
import { ScoreBar } from "./ScoreBar.js";
import { CodePreview } from "./CodePreview.js";
import { theme } from "../theme.js";

// ============================================================================
// Helpers
// ============================================================================

/** Get a human-readable type label */
function typeLabel(result: SearchResult): string {
	const ut = result.unitType;
	const ct = result.chunk.chunkType;
	if (ut && ut !== "unknown") return ut;
	if (ct === "document-section") return "doc";
	return ct || "chunk";
}

/** Get a short description from signature or first content line */
function shortDesc(result: SearchResult): string {
	const { chunk } = result;
	if (chunk.signature) {
		// Truncate long signatures
		const sig = chunk.signature.replace(/\s+/g, " ").trim();
		return sig.length > 60 ? sig.substring(0, 57) + "..." : sig;
	}
	// Fall back to first non-empty line of content
	const lines = chunk.content.split("\n");
	for (const line of lines) {
		const trimmed = line.trim();
		if (trimmed && trimmed.length > 2) {
			return trimmed.length > 60 ? trimmed.substring(0, 57) + "..." : trimmed;
		}
	}
	return "";
}

/** Build AST metadata summary */
function buildAstBadge(metadata?: ASTMetadata): { text: string; hasAST: boolean } {
	if (!metadata || Object.keys(metadata).length === 0) {
		return { text: "", hasAST: false };
	}
	const parts: string[] = [];
	if (metadata.isExported) parts.push("exported");
	if (metadata.isAsync) parts.push("async");
	if (metadata.isGenerator) parts.push("gen");
	if (metadata.isStatic) parts.push("static");
	if (metadata.visibility && metadata.visibility !== "exported") parts.push(metadata.visibility);
	if (metadata.parameters) parts.push(`${metadata.parameters.length} params`);
	if (metadata.returnType) parts.push(`-> ${metadata.returnType}`);
	return { text: parts.length > 0 ? parts.join(", ") : "AST", hasAST: true };
}

// ============================================================================
// Props
// ============================================================================

export interface ResultListProps {
	results: SearchResult[];
	selectedIndex: number;
	expandedIndex: number | null;
	onSelect: (idx: number) => void;
	onToggleExpand: (idx: number) => void;
}

// ============================================================================
// Result Row Component
// ============================================================================

interface ResultRowProps {
	result: SearchResult;
	index: number;
	isSelected: boolean;
	isExpanded: boolean;
}

function ResultRow({ result, index, isSelected, isExpanded }: ResultRowProps) {
	const { chunk, score, vectorScore, keywordScore, metadata, summary } = result;
	const rank = index + 1;
	const name = chunk.name || typeLabel(result);
	const fileName = chunk.filePath.split("/").pop() ?? chunk.filePath;
	const tLabel = typeLabel(result);
	const desc = shortDesc(result);
	const { text: astText, hasAST } = buildAstBadge(metadata);

	// Color code type labels
	const isCode = ["function", "method", "class", "interface", "type", "enum", "module"].includes(tLabel);

	return (
		<box flexDirection="column" width="100%">
			{/* Line 1: Rank, name, scores */}
			<box flexDirection="row" paddingLeft={1} height={1}>
				<text fg={isSelected ? theme.primary : theme.dimmed} width={4}>
					{`#${rank}`}
				</text>
				<text fg={isCode ? theme.info : theme.dimmed} width={10}>
					{tLabel}
				</text>
				<text fg={isSelected ? theme.primary : theme.text} width={26}>
					{name}
				</text>
				<ScoreBar score={score} width={8} showPercent={true} />
				<text fg={theme.dimmed}>
					{`  v:${Math.round(vectorScore * 100)}% k:${Math.round(keywordScore * 100)}%`}
				</text>
				{hasAST && (
					<text fg={theme.success}>{`  [${astText}]`}</text>
				)}
			</box>

			{/* Line 2: Location + signature/description */}
			<box flexDirection="row" paddingLeft={5} height={1}>
				<text fg={isSelected ? theme.text : theme.muted} width={30}>
					{`${fileName}:${chunk.startLine}`}
				</text>
				<text fg={theme.dimmed}>
					{desc}
				</text>
			</box>

			{/* Expanded view */}
			{isExpanded && (
				<box flexDirection="column" paddingLeft={5} paddingBottom={1}>
					{/* Summary / description */}
					{summary && (
						<box height={1}>
							<text fg={theme.muted}>{"desc: "}</text>
							<text fg={theme.text}>{summary}</text>
						</box>
					)}

					{/* Full file path */}
					<box height={1}>
						<text fg={theme.muted}>{"path: "}</text>
						<text fg={theme.text}>{`${chunk.filePath}:${chunk.startLine}-${chunk.endLine}`}</text>
					</box>

					{/* Signature if available */}
					{chunk.signature && (
						<box height={1}>
							<text fg={theme.muted}>{"sig:  "}</text>
							<text fg={theme.warning}>{chunk.signature.replace(/\s+/g, " ").trim()}</text>
						</box>
					)}

					{/* Code preview */}
					<CodePreview
						content={chunk.content}
						filePath={chunk.filePath}
						startLine={chunk.startLine}
						maxLines={15}
					/>

					{/* Full AST details when available */}
					{hasAST && metadata && (
						<box flexDirection="column" paddingTop={1}>
							<text fg={theme.muted}>{"AST Metadata:"}</text>
							{metadata.parameters && metadata.parameters.length > 0 && (
								<box paddingLeft={2} height={1}>
									<text fg={theme.dimmed}>{"params:  "}</text>
									<text fg={theme.text}>
										{metadata.parameters.map((p) => p.type ? `${p.name}: ${p.type}` : p.name).join(", ")}
									</text>
								</box>
							)}
							{metadata.returnType && (
								<box paddingLeft={2} height={1}>
									<text fg={theme.dimmed}>{"returns: "}</text>
									<text fg={theme.text}>{metadata.returnType}</text>
								</box>
							)}
							{metadata.functionsCalled && metadata.functionsCalled.length > 0 && (
								<box paddingLeft={2} height={1}>
									<text fg={theme.dimmed}>{"calls:   "}</text>
									<text fg={theme.info}>{metadata.functionsCalled.join(", ")}</text>
								</box>
							)}
							{metadata.typesReferenced && metadata.typesReferenced.length > 0 && (
								<box paddingLeft={2} height={1}>
									<text fg={theme.dimmed}>{"types:   "}</text>
									<text fg={theme.info}>{metadata.typesReferenced.join(", ")}</text>
								</box>
							)}
							{metadata.importsUsed && metadata.importsUsed.length > 0 && (
								<box paddingLeft={2} height={1}>
									<text fg={theme.dimmed}>{"imports: "}</text>
									<text fg={theme.text}>{metadata.importsUsed.join(", ")}</text>
								</box>
							)}
							{metadata.docstring && (
								<box paddingLeft={2}>
									<text fg={theme.dimmed}>{"doc:     "}</text>
									<text fg={theme.text}>{metadata.docstring}</text>
								</box>
							)}
						</box>
					)}
				</box>
			)}
		</box>
	);
}

// ============================================================================
// Main Component
// ============================================================================

export function ResultList({
	results,
	selectedIndex,
	expandedIndex,
	onSelect,
	onToggleExpand,
}: ResultListProps) {
	if (results.length === 0) {
		return (
			<box padding={2}>
				<text fg={theme.muted}>No results</text>
			</box>
		);
	}

	return (
		<scrollbox width="100%" height="100%">
			{results.map((result, i) => (
				<box key={result.chunk.id}>
					<ResultRow
						result={result}
						index={i}
						isSelected={i === selectedIndex}
						isExpanded={i === expandedIndex}
					/>
				</box>
			))}
		</scrollbox>
	);
}
