/**
 * Extractor Exports
 *
 * Public API for document extractors.
 */

export {
	AntiPatternExtractor,
	createAntiPatternExtractor,
} from "./anti-pattern.js";
// Base classes
export {
	BaseExtractor,
	createExtractorRegistry,
	ExtractorRegistry,
} from "./base.js";
// Extractors
export {
	createFileSummaryExtractor,
	FileSummaryExtractor,
} from "./file-summary.js";
export { createIdiomExtractor, IdiomExtractor } from "./idiom.js";
export {
	createProjectDocExtractor,
	ProjectDocExtractor,
} from "./project-doc.js";
export {
	createSymbolSummaryExtractor,
	SymbolSummaryExtractor,
} from "./symbol-summary.js";
export {
	createUsageExampleExtractor,
	UsageExampleExtractor,
} from "./usage-example.js";

import { createAntiPatternExtractor } from "./anti-pattern.js";
// Import for internal use
import { createFileSummaryExtractor } from "./file-summary.js";
import { createIdiomExtractor } from "./idiom.js";
import { createProjectDocExtractor } from "./project-doc.js";
import { createSymbolSummaryExtractor } from "./symbol-summary.js";
import { createUsageExampleExtractor } from "./usage-example.js";

// Factory to create all default extractors
export function createDefaultExtractors() {
	return [
		createFileSummaryExtractor(),
		createSymbolSummaryExtractor(),
		createIdiomExtractor(),
		createUsageExampleExtractor(),
		createAntiPatternExtractor(),
		createProjectDocExtractor(),
	];
}
