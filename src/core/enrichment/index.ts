/**
 * Enrichment Module Exports
 *
 * Public API for the enrichment system.
 */

export { createDependencyGraph, DependencyGraph } from "./dependency-graph.js";
export type {
	EnricherOptions,
	FileToEnrich,
	RefinementOptions,
	RefinementResult,
} from "./enricher.js";
// Core components
export { createEnricher, Enricher } from "./enricher.js";
// Extractor infrastructure
export {
	BaseExtractor,
	createExtractorRegistry,
	ExtractorRegistry,
} from "./extractors/base.js";
export type { PipelineOptions, PipelineResult } from "./pipeline.js";
export { createEnrichmentPipeline, EnrichmentPipeline } from "./pipeline.js";
