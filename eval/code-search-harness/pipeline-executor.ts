/**
 * Code Search Harness — Real Pipeline SearchExecutor
 *
 * Implements the harness `SearchExecutor` interface against mnemex's actual
 * retrieval pipeline (`PipelineOrchestrator`), replacing `MockSearchExecutor`.
 *
 * Wiring mirrors the local-search path of `src/mcp/tools/search.ts` (backends →
 * router → orchestrator), but is rebuilt here so eval never imports from
 * `src/mcp/**`.
 *
 * Two properties matter for eval correctness:
 *
 * 1. **One context per run.** The tracker, graph manager, indexer and backends
 *    are constructed once and shared across every query. Constructing them per
 *    query would dominate the latency numbers and make a 135-query run take
 *    minutes of pure setup.
 * 2. **File-granular results.** qrels in `eval/datasets/mnemex-git` are keyed by
 *    repo-relative file path, so chunk-level results are collapsed to one entry
 *    per file (max score wins) *before* truncation to k.
 *
 * Usage:
 *   const ctx = await createPipelineContext({ projectPath });
 *   const executor = new PipelineSearchExecutor(ctx, { fusionMethod: "tm2c2" });
 *   const results = await executor.search("show changelog after update", { k: 10 });
 *   await ctx.close();
 */

import { existsSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { getIndexDbPath } from "../../src/config.js";
import { createIndexer, type Indexer } from "../../src/core/indexer.js";
import {
	createReferenceGraphManager,
	type ReferenceGraphManager,
} from "../../src/core/reference-graph.js";
import {
	createFileTracker,
	type IFileTracker,
} from "../../src/core/tracker.js";
import { getParserManager } from "../../src/parsers/parser-manager.js";
import { LocationBackend } from "../../src/retrieval/backends/location.js";
import { SemanticBackend } from "../../src/retrieval/backends/semantic.js";
import { SymbolGraphBackend } from "../../src/retrieval/backends/symbol-graph.js";
import { TreeSitterBackend } from "../../src/retrieval/backends/tree-sitter.js";
import {
	loadPipelineConfig,
	type PipelineConfig,
} from "../../src/retrieval/pipeline/config.js";
import { PipelineOrchestrator } from "../../src/retrieval/pipeline/orchestrator.js";
import type {
	ISearchBackend,
	MergedResult,
} from "../../src/retrieval/pipeline/types.js";
import { QueryRouter } from "../../src/retrieval/routing/query-router.js";
import type {
	SearchExecutor,
	SearchOptions,
	SearchResult,
} from "./ablation.js";

// ============================================================================
// docId normalization
// ============================================================================

/**
 * Normalize a pipeline result's `file` into the corpus `_id` shape used by the
 * BEIR datasets under `eval/datasets/`.
 *
 * Corpus ids are plain repo-relative POSIX paths with no `./` prefix
 * (e.g. `src/cli.ts`, `.github/workflows/release.yml`). Pipeline backends emit
 * repo-relative paths already, but this normalizes the shapes that can leak
 * through anyway: absolute paths under the project root, `./` prefixes,
 * Windows separators, and trailing/leading slashes.
 *
 * Returns `null` for results with no usable file anchor (e.g. session
 * observations recorded without affected files) so callers can drop them.
 */
export function normalizeDocId(
	file: string | undefined,
	projectPath: string,
): string | null {
	if (!file) return null;

	let path = file.replace(/\\/g, "/").trim();
	if (path.length === 0) return null;

	const root = projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
	if (isAbsolute(path) && root.length > 0) {
		const rel = relative(root, path).replace(/\\/g, "/");
		// `relative` escaping the root (../…) means the file is outside the repo
		// and can never match a corpus id — keep it verbatim so it simply misses.
		if (rel.length > 0 && !rel.startsWith("..")) {
			path = rel;
		}
	}

	path = path.replace(/^\.\//, "").replace(/^\/+/, "");
	return path.length > 0 ? path : null;
}

// ============================================================================
// Chunk → file dedup
// ============================================================================

/** A pipeline result reduced to the fields the harness needs. */
export interface ScoredDoc {
	docId: string;
	score: number;
	snippet?: string;
}

/**
 * Collapse multiple chunks from the same file into a single entry.
 *
 * Keeps the MAX score per file and re-sorts descending, breaking ties by first
 * appearance so the pipeline's own ordering survives for equal scores.
 *
 * This must run BEFORE truncating to k: the pipeline returns chunk-level hits,
 * and several chunks of one file routinely occupy consecutive ranks. Truncating
 * first would yield fewer than k distinct files.
 */
export function dedupeByFile(results: ScoredDoc[]): ScoredDoc[] {
	const best = new Map<string, { doc: ScoredDoc; order: number }>();

	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const existing = best.get(r.docId);
		if (!existing) {
			best.set(r.docId, { doc: { ...r }, order: i });
			continue;
		}
		if (r.score > existing.doc.score) {
			// Keep the earliest position; only the score (and its snippet) upgrade.
			existing.doc = { ...r };
		}
	}

	return [...best.values()]
		.sort((a, b) => {
			if (b.doc.score !== a.doc.score) return b.doc.score - a.doc.score;
			return a.order - b.order;
		})
		.map((e) => e.doc);
}

// ============================================================================
// Pipeline context — built once, shared by every executor in a run
// ============================================================================

export interface PipelineContextOptions {
	/** Repository root that was indexed (must contain a `.mnemex/index.db`) */
	projectPath: string;
	/**
	 * Base pipeline config. Defaults to `loadPipelineConfig()` with the LSP
	 * backend forced off — the harness has no LSP manager to hand it, and
	 * leaving it "enabled" would only add an unreachable branch.
	 */
	baseConfig?: PipelineConfig;
}

/**
 * Shared, expensive-to-build pipeline state.
 *
 * Owns the SQLite tracker and the Indexer. Multiple `PipelineSearchExecutor`s
 * (one per fusion method, say) can share one context: they differ only in the
 * `PipelineConfig` handed to their orchestrator.
 */
export interface PipelineContext {
	projectPath: string;
	baseConfig: PipelineConfig;
	backends: ISearchBackend[];
	router: QueryRouter;
	/** Names of backends that were actually constructed */
	activeBackends: string[];
	close(): Promise<void>;
}

/**
 * Wrap an Indexer so `close()` is a no-op.
 *
 * `SemanticBackend` closes the indexer its factory returns after every search.
 * That is right for the MCP server (one indexer per request) and wrong for an
 * eval run (135 searches). The proxy lets the backend keep its contract while
 * the context keeps ownership of the single real indexer.
 */
function nonClosingIndexer(indexer: Indexer): Indexer {
	return new Proxy(indexer, {
		get(target, prop) {
			if (prop === "close") {
				return async () => {};
			}
			const value = Reflect.get(target, prop, target) as unknown;
			return typeof value === "function"
				? (value as (...args: unknown[]) => unknown).bind(target)
				: value;
		},
	});
}

/**
 * Build the shared pipeline context: tracker, graph manager, indexer, backends
 * and a rule-only router (no LLM — deterministic and ~0ms).
 *
 * Throws when no index exists at `projectPath`; an eval run against a missing
 * index would otherwise silently produce all-zero metrics.
 */
export async function createPipelineContext(
	options: PipelineContextOptions,
): Promise<PipelineContext> {
	const { projectPath } = options;

	const dbPath = getIndexDbPath(projectPath);
	if (!existsSync(dbPath)) {
		throw new Error(
			`No mnemex index found at ${dbPath}. Run 'mnemex index' in ${projectPath} first.`,
		);
	}

	const baseConfig: PipelineConfig = options.baseConfig ?? {
		...loadPipelineConfig(),
		// No LSP manager is available inside the harness.
		backends: { ...loadPipelineConfig().backends, lsp: false },
	};

	const tracker: IFileTracker = createFileTracker(dbPath, projectPath);
	const graphManager: ReferenceGraphManager =
		createReferenceGraphManager(tracker);
	const indexer = createIndexer({ projectPath });
	const sharedIndexer = nonClosingIndexer(indexer);

	const backends: ISearchBackend[] = [];

	if (baseConfig.backends.symbolGraph) {
		backends.push(new SymbolGraphBackend(graphManager, projectPath));
	}
	if (baseConfig.backends.semantic) {
		backends.push(new SemanticBackend(() => sharedIndexer));
	}
	if (baseConfig.backends.location) {
		backends.push(new LocationBackend(tracker));
	}
	if (baseConfig.backends.treeSitter) {
		backends.push(
			new TreeSitterBackend(
				getParserManager(),
				tracker,
				projectPath,
				baseConfig.treeSitterConfig.maxFilesToScan,
			),
		);
	}

	// Rule-based router only: no LLM call, deterministic across conditions.
	const router = new QueryRouter(null, { useLLM: false });

	return {
		projectPath,
		baseConfig,
		backends,
		router,
		activeBackends: backends.map((b) => b.name),
		async close() {
			await indexer.close().catch(() => {});
			try {
				tracker.close();
			} catch {
				// Already closed — nothing to do.
			}
		},
	};
}

// ============================================================================
// PipelineSearchExecutor
// ============================================================================

export interface PipelineExecutorOptions {
	/**
	 * How many chunk-level results to request per file-level result.
	 *
	 * The pipeline ranks chunks; the qrels grade files. Requesting `k` chunks
	 * would return fewer than `k` distinct files whenever a file contributes
	 * several chunks, which silently depresses Recall@k. Default 5.
	 */
	overFetchFactor?: number;
	/** Hard cap on the chunk-level limit handed to the pipeline (default 200) */
	maxPipelineLimit?: number;
}

/**
 * `SearchExecutor` backed by the real `PipelineOrchestrator`.
 *
 * `SearchOptions.routerLabel` is intentionally ignored: `PipelineOrchestrator`
 * routes internally via its own `QueryRouter`, and there is no injection point
 * for an externally supplied label. `SearchOptions.expandedQuery` needs no
 * handling either — `runCondition` already passes the expanded string as the
 * query when expansion is enabled.
 */
export class PipelineSearchExecutor implements SearchExecutor {
	private readonly orchestrator: PipelineOrchestrator;
	private readonly overFetchFactor: number;
	private readonly maxPipelineLimit: number;
	readonly config: PipelineConfig;

	constructor(
		private readonly ctx: PipelineContext,
		configOverride: Partial<PipelineConfig> = {},
		options: PipelineExecutorOptions = {},
	) {
		this.config = { ...ctx.baseConfig, ...configOverride };
		this.overFetchFactor = options.overFetchFactor ?? 5;
		this.maxPipelineLimit = options.maxPipelineLimit ?? 200;
		this.orchestrator = new PipelineOrchestrator(
			ctx.router,
			ctx.backends,
			this.config,
		);
	}

	async search(query: string, options: SearchOptions): Promise<SearchResult[]> {
		const k = Math.max(1, options.k);
		const pipelineLimit = Math.min(
			this.maxPipelineLimit,
			k * this.overFetchFactor,
		);

		const merged: MergedResult[] = await this.orchestrator.search(query, {
			limit: pipelineLimit,
		});

		const scored: ScoredDoc[] = [];
		for (const r of merged) {
			const docId = normalizeDocId(r.file, this.ctx.projectPath);
			if (!docId) continue; // anchor-less result — cannot match a file-keyed qrel
			scored.push({
				docId,
				// `rrfScore` is Infinity for definitive LSP hits. Map to 1.0, the same
				// convention the MCP search tool uses, so the value stays JSON-safe
				// while still outranking real fusion scores (~1/60 scale).
				score: Number.isFinite(r.rrfScore) ? r.rrfScore : 1.0,
				snippet: r.snippet,
			});
		}

		// Dedup BEFORE truncation, then cut to k files.
		return dedupeByFile(scored).slice(0, k);
	}
}
