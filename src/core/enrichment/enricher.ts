/**
 * Enricher
 *
 * Main orchestrator for the enrichment process.
 * Coordinates pipeline, embedding, and storage of enriched documents.
 */

import type {
	BaseDocument,
	CodeChunk,
	DocumentType,
	DocumentWithEmbedding,
	EnrichmentProgressCallback,
	EnrichmentResult,
	IEmbeddingsClient,
	ILLMClient,
} from "../../types.js";
import type { VectorStore } from "../store.js";
import type { FileTracker } from "../tracker.js";
import {
	createDefaultExtractors,
	createExtractorRegistry,
	ExtractorRegistry,
	FileSummaryExtractor,
} from "./extractors/index.js";
import { createEnrichmentPipeline, EnrichmentPipeline } from "./pipeline.js";

// ============================================================================
// Types
// ============================================================================

export interface EnricherOptions {
	/** Document types to extract (default: all) */
	documentTypes?: DocumentType[];
	/** Progress callback */
	onProgress?: EnrichmentProgressCallback;
	/** Skip embedding (for testing) */
	skipEmbedding?: boolean;
	/** Maximum concurrent file enrichments (default: 3) */
	concurrency?: number;
}

export interface FileToEnrich {
	filePath: string;
	fileContent: string;
	codeChunks: CodeChunk[];
	language: string;
}

// ============================================================================
// Enricher Class
// ============================================================================

export class Enricher {
	private llmClient: ILLMClient;
	private embeddingsClient: IEmbeddingsClient;
	private vectorStore: VectorStore;
	private tracker: FileTracker;
	private pipeline: EnrichmentPipeline;
	private registry: ExtractorRegistry;

	constructor(
		llmClient: ILLMClient,
		embeddingsClient: IEmbeddingsClient,
		vectorStore: VectorStore,
		tracker: FileTracker,
	) {
		this.llmClient = llmClient;
		this.embeddingsClient = embeddingsClient;
		this.vectorStore = vectorStore;
		this.tracker = tracker;

		// Create registry and register extractors
		this.registry = createExtractorRegistry();
		this.registerDefaultExtractors();

		// Create pipeline
		this.pipeline = createEnrichmentPipeline(this.registry, llmClient);
	}

	/**
	 * Register default extractors.
	 */
	private registerDefaultExtractors(): void {
		const extractors = createDefaultExtractors();
		for (const extractor of extractors) {
			this.registry.register(extractor);
		}
	}

	/**
	 * Register a custom extractor
	 */
	registerExtractor(extractor: any): void {
		this.registry.register(extractor);
	}

	/**
	 * Enrich a single file
	 */
	async enrichFile(
		file: FileToEnrich,
		options: EnricherOptions = {},
	): Promise<EnrichmentResult> {
		const startTime = Date.now();
		let documentsCreated = 0;
		let documentsUpdated = 0;
		const errors: EnrichmentResult["errors"] = [];

		try {
			// Load existing docs for this file to enable true incremental enrichment
			// (extractors can skip if content unchanged)
			const existingDocs = await this.vectorStore.getDocumentsByFile(
				file.filePath,
				options.documentTypes,
			);

			// Extract documents using pipeline
			const pipelineResult = await this.pipeline.extractFile(
				file.filePath,
				file.fileContent,
				file.codeChunks,
				file.language,
				{
					documentTypes: options.documentTypes,
					onProgress: options.onProgress,
					existingDocs,
				},
			);

			// Transform pipeline errors to enrichment result format
			for (const err of pipelineResult.errors) {
				errors.push({
					file: err.filePath,
					documentType: err.documentType,
					error: err.error,
				});
			}

			if (pipelineResult.documents.length === 0) {
				return {
					documentsCreated: 0,
					documentsUpdated: 0,
					durationMs: Date.now() - startTime,
					errors,
				};
			}

			// Embed documents
			let documentsWithEmbeddings: DocumentWithEmbedding[];

			if (options.skipEmbedding) {
				// For testing - use zero vectors
				documentsWithEmbeddings = pipelineResult.documents.map((doc) => ({
					...doc,
					vector: new Array(384).fill(0),
				}));
			} else {
				documentsWithEmbeddings = await this.embedDocuments(pipelineResult.documents);
			}

			// Store documents
			await this.vectorStore.addDocuments(documentsWithEmbeddings);

			// Track documents
			const trackedDocs = documentsWithEmbeddings.map((doc) => ({
				id: doc.id,
				documentType: doc.documentType,
				filePath: doc.filePath || file.filePath,
				sourceIds: doc.sourceIds || [],
				createdAt: doc.createdAt,
				enrichedAt: doc.enrichedAt,
			}));

			this.tracker.trackDocuments(trackedDocs);

			// Update enrichment state
			const completedTypes = new Set(pipelineResult.documents.map((d) => d.documentType));
			for (const docType of completedTypes) {
				this.tracker.setEnrichmentState(file.filePath, docType, "complete");
			}

			documentsCreated = pipelineResult.documents.length;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			errors.push({
				file: file.filePath,
				documentType: "file_summary",
				error: errorMessage,
			});
		}

		return {
			documentsCreated,
			documentsUpdated,
			durationMs: Date.now() - startTime,
			errors,
		};
	}

	/**
	 * Enrich multiple files using batched LLM calls for efficiency.
	 * Processes file summaries AND symbol summaries in parallel for maximum throughput.
	 */
	async enrichFiles(
		files: FileToEnrich[],
		options: EnricherOptions = {},
	): Promise<EnrichmentResult> {
		const startTime = Date.now();
		const total = files.length;

		let totalCreated = 0;
		let totalUpdated = 0;
		const allErrors: EnrichmentResult["errors"] = [];

		// Cost and call tracking per phase
		let fileSummariesCost = 0;
		let symbolSummariesCost = 0;
		let fileSummariesCalls = 0;
		let symbolSummariesCalls = 0;

		// Get LLM provider label for display
		const provider = this.llmClient.getProvider();
		const providerLabel = provider === "claude-code" ? "Claude CLI"
			: provider === "anthropic" ? "Anthropic API"
			: provider === "openrouter" ? "OpenRouter"
			: provider === "local" ? "Local LLM"
			: provider;

		// Report progress helper - phase is used by CLI to show distinct progress bars
		const reportProgress = (phase: string, completed: number, phaseTotal: number, status: string, inProgress = 0) => {
			if (options.onProgress) {
				// Format: "[phase] status" - CLI parses this to show separate progress lines
				options.onProgress(completed, phaseTotal, phase as DocumentType, status, inProgress);
			}
		};

		// Thread-safe document accumulation (JS is single-threaded for sync ops)
		const fileSummaryDocs: BaseDocument[] = [];
		const symbolSummaryDocs: BaseDocument[] = [];
		const concurrency = options.concurrency ?? 10;

		// File summary extractor
		const fileSummaryExtractor = this.registry.get("file_summary") as FileSummaryExtractor | undefined;
		const otherTypes: DocumentType[] = ["symbol_summary"];

		// Reset usage tracking
		this.llmClient.resetAccumulatedUsage();

		// ============================================================================
		// PARALLEL PHASE: File summaries + Symbol summaries run concurrently
		// Each reports to its own progress line (CLI handles parallel phases)
		// ============================================================================

		// File summaries processor
		const processFileSummaries = async (): Promise<void> => {
			if (!fileSummaryExtractor) return;

			let completed = 0;
			const inProgress = new Set<string>();

			const processFile = async (file: FileToEnrich): Promise<void> => {
				const fileName = file.filePath.split("/").pop() || file.filePath;
				inProgress.add(fileName);

				const active = inProgress.size;
				const activeList = Array.from(inProgress).slice(0, 2).join(", ");
				const moreCount = active > 2 ? ` +${active - 2}` : "";
				reportProgress("file summaries", completed, total, `${completed}/${total} (${active} active) ${activeList}${moreCount}`, active);

				try {
					const docs = await fileSummaryExtractor.extract(
						{
							filePath: file.filePath,
							fileContent: file.fileContent,
							language: file.language,
							codeChunks: file.codeChunks,
							projectPath: "",
						},
						this.llmClient,
					);

					fileSummaryDocs.push(...docs);

					for (const doc of docs) {
						if (doc.filePath) {
							this.tracker.setEnrichmentState(doc.filePath, "file_summary", "complete");
						}
					}
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error);
					allErrors.push({
						file: file.filePath,
						documentType: "file_summary",
						error: errorMessage,
					});
				} finally {
					inProgress.delete(fileName);
					completed++;
				}
			};

			reportProgress("file summaries", 0, total, `0/${total} starting...`, 0);

			for (let i = 0; i < files.length; i += concurrency) {
				const batch = files.slice(i, i + concurrency);
				await Promise.all(batch.map(processFile));
			}

			reportProgress("file summaries", total, total, `${total}/${total} via ${providerLabel}`, 0);
		};

		// Symbol summaries processor
		const processSymbolSummaries = async (): Promise<void> => {
			if (otherTypes.length === 0) return;

			let completed = 0;
			const inProgress = new Set<string>();

			const processFile = async (file: FileToEnrich): Promise<void> => {
				const fileName = file.filePath.split("/").pop() || file.filePath;
				inProgress.add(fileName);

				const active = inProgress.size;
				const activeList = Array.from(inProgress).slice(0, 2).join(", ");
				const moreCount = active > 2 ? ` +${active - 2}` : "";
				reportProgress("symbol summaries", completed, total, `${completed}/${total} (${active} active) ${activeList}${moreCount}`, active);

				try {
					const pipelineResult = await this.pipeline.extractFile(
						file.filePath,
						file.fileContent,
						file.codeChunks,
						file.language,
						{
							documentTypes: otherTypes,
							existingDocs: [], // No dependency on file summaries
						},
					);

					symbolSummaryDocs.push(...pipelineResult.documents);

					for (const err of pipelineResult.errors) {
						allErrors.push({
							file: err.filePath,
							documentType: err.documentType,
							error: err.error,
						});
					}
				} catch (error) {
					const errorMessage = error instanceof Error ? error.message : String(error);
					allErrors.push({
						file: file.filePath,
						documentType: "symbol_summary",
						error: errorMessage,
					});
				} finally {
					inProgress.delete(fileName);
					completed++;
				}
			};

			reportProgress("symbol summaries", 0, total, `0/${total} starting...`, 0);

			for (let i = 0; i < files.length; i += concurrency) {
				const batch = files.slice(i, i + concurrency);
				await Promise.all(batch.map(processFile));
			}

			reportProgress("symbol summaries", total, total, `${total}/${total} done`, 0);
		};

		// Run BOTH phases in parallel - this doubles throughput when using cloud LLM!
		await Promise.all([
			processFileSummaries(),
			processSymbolSummaries(),
		]);

		// Combine all documents
		const allDocuments = [...fileSummaryDocs, ...symbolSummaryDocs];

		// Get combined usage
		const combinedUsage = this.llmClient.getAccumulatedUsage();
		const fileSummaryRatio = fileSummaryDocs.length / Math.max(1, allDocuments.length);
		fileSummariesCost = combinedUsage.cost * fileSummaryRatio;
		symbolSummariesCost = combinedUsage.cost * (1 - fileSummaryRatio);
		fileSummariesCalls = Math.round(combinedUsage.calls * fileSummaryRatio);
		symbolSummariesCalls = combinedUsage.calls - fileSummariesCalls;

		// Step 3: Embed all documents in batch
		const docCount = allDocuments.length;
		if (docCount > 0) {
			reportProgress("embed summaries", 0, docCount, `${docCount} documents...`, docCount);

			let documentsWithEmbeddings: DocumentWithEmbedding[];
			if (options.skipEmbedding) {
				documentsWithEmbeddings = allDocuments.map((doc) => ({
					...doc,
					vector: new Array(384).fill(0),
				}));
			} else {
				documentsWithEmbeddings = await this.embedDocuments(allDocuments);
			}

			reportProgress("embed summaries", docCount, docCount, `${docCount} embedded`, 0);

			// Step 4: Store all documents
			reportProgress("store vectors", 0, docCount, `${docCount} documents...`, docCount);
			await this.vectorStore.addDocuments(documentsWithEmbeddings);

			// Track all documents
			const trackedDocs = documentsWithEmbeddings.map((doc) => ({
				id: doc.id,
				documentType: doc.documentType,
				filePath: doc.filePath || "",
				sourceIds: doc.sourceIds || [],
				createdAt: doc.createdAt,
				enrichedAt: doc.enrichedAt,
			}));
			this.tracker.trackDocuments(trackedDocs);

			totalCreated = allDocuments.length;
			reportProgress("store vectors", docCount, docCount, `${docCount} stored`, 0);
		}

		// Calculate totals
		const totalCost = fileSummariesCost + symbolSummariesCost;
		const totalCalls = fileSummariesCalls + symbolSummariesCalls;

		return {
			documentsCreated: totalCreated,
			documentsUpdated: totalUpdated,
			durationMs: Date.now() - startTime,
			errors: allErrors,
			llmProvider: provider,
			cost: totalCost > 0 ? totalCost : undefined,
			costBreakdown: totalCost > 0 ? {
				fileSummaries: fileSummariesCost > 0 ? fileSummariesCost : undefined,
				symbolSummaries: symbolSummariesCost > 0 ? symbolSummariesCost : undefined,
			} : undefined,
			llmCalls: totalCalls > 0 ? {
				fileSummaries: fileSummariesCalls,
				symbolSummaries: symbolSummariesCalls,
				total: totalCalls,
			} : undefined,
		};
	}

	/**
	 * Embed documents using the embeddings client
	 */
	private async embedDocuments(
		documents: BaseDocument[],
	): Promise<DocumentWithEmbedding[]> {
		if (documents.length === 0) {
			return [];
		}

		// Extract content for embedding
		const contents = documents.map((doc) => doc.content);

		// Generate embeddings
		const result = await this.embeddingsClient.embed(contents);

		// Combine documents with embeddings
		return documents.map((doc, i) => ({
			...doc,
			vector: result.embeddings[i],
		}));
	}

	/**
	 * Get the extraction order for document types
	 */
	getExtractionOrder(types: DocumentType[]): DocumentType[] {
		return this.pipeline.getExtractionOrder(types);
	}

	/**
	 * Check if a file needs enrichment
	 */
	needsEnrichment(filePath: string, documentType: DocumentType): boolean {
		return this.tracker.needsEnrichment(filePath, documentType);
	}

	/**
	 * Get files that need enrichment for a document type
	 */
	getFilesNeedingEnrichment(documentType: DocumentType): string[] {
		return this.tracker.getFilesNeedingEnrichment(documentType);
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an enricher
 */
export function createEnricher(
	llmClient: ILLMClient,
	embeddingsClient: IEmbeddingsClient,
	vectorStore: VectorStore,
	tracker: FileTracker,
): Enricher {
	return new Enricher(llmClient, embeddingsClient, vectorStore, tracker);
}
