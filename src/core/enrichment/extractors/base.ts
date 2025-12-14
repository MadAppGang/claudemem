/**
 * Base Document Extractor
 *
 * Interface and base class for document extractors.
 * Each document type has its own extractor implementation.
 */

import type {
	BaseDocument,
	CodeChunk,
	Document,
	DocumentType,
	ExtractionContext,
	IDocumentExtractor,
	ILLMClient,
} from "../../../types.js";

// ============================================================================
// Base Extractor Class
// ============================================================================

/**
 * Abstract base class for document extractors.
 * Provides common functionality and enforces the interface.
 */
export abstract class BaseExtractor implements IDocumentExtractor {
	protected documentType: DocumentType;
	protected dependencies: DocumentType[];

	constructor(documentType: DocumentType, dependencies: DocumentType[] = []) {
		this.documentType = documentType;
		this.dependencies = dependencies;
	}

	/**
	 * Get the document type this extractor produces
	 */
	getDocumentType(): DocumentType {
		return this.documentType;
	}

	/**
	 * Get document types this extractor depends on
	 */
	getDependencies(): DocumentType[] {
		return this.dependencies;
	}

	/**
	 * Extract documents from the given context.
	 * Must be implemented by subclasses.
	 */
	abstract extract(
		context: ExtractionContext,
		llmClient: ILLMClient,
	): Promise<BaseDocument[]>;

	/**
	 * Check if extraction is needed (for incremental updates).
	 * Default implementation: needs update if no existing docs of this type.
	 */
	needsUpdate(context: ExtractionContext): boolean {
		if (!context.existingDocs) {
			return true;
		}

		// Check if there are existing docs of this type for this file
		const existingOfType = context.existingDocs.filter(
			(doc) =>
				doc.documentType === this.documentType &&
				doc.filePath === context.filePath,
		);

		return existingOfType.length === 0;
	}

	/**
	 * Generate a unique document ID
	 */
	protected generateId(content: string, ...parts: string[]): string {
		const crypto = require("node:crypto");
		const input = [this.documentType, ...parts, content].join("::");
		return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
	}

	/**
	 * Create base document fields
	 */
	protected createBaseDocument(
		content: string,
		context: ExtractionContext,
		sourceIds?: string[],
		metadata?: Record<string, unknown>,
	): Omit<BaseDocument, "id"> {
		return {
			content,
			documentType: this.documentType,
			filePath: context.filePath,
			fileHash: context.codeChunks[0]?.fileHash,
			createdAt: new Date().toISOString(),
			enrichedAt: new Date().toISOString(),
			sourceIds: sourceIds || context.codeChunks.map((c) => c.id),
			metadata,
		};
	}
}

// ============================================================================
// Extractor Registry
// ============================================================================

/**
 * Registry for document extractors
 */
export class ExtractorRegistry {
	private extractors: Map<DocumentType, IDocumentExtractor> = new Map();

	/**
	 * Register an extractor
	 */
	register(extractor: IDocumentExtractor): void {
		this.extractors.set(extractor.getDocumentType(), extractor);
	}

	/**
	 * Get an extractor by document type
	 */
	get(documentType: DocumentType): IDocumentExtractor | undefined {
		return this.extractors.get(documentType);
	}

	/**
	 * Get all registered extractors
	 */
	getAll(): IDocumentExtractor[] {
		return Array.from(this.extractors.values());
	}

	/**
	 * Get all registered document types
	 */
	getTypes(): DocumentType[] {
		return Array.from(this.extractors.keys());
	}
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create an extractor registry
 */
export function createExtractorRegistry(): ExtractorRegistry {
	return new ExtractorRegistry();
}
