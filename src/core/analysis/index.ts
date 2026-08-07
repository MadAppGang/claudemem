/**
 * Code Analysis Module
 *
 * Exports analysis components:
 * - TestFileDetector: Language-aware test file detection
 * - CodeAnalyzer: Dead code, test gaps, impact analysis
 */

export {
	CodeAnalyzer,
	createCodeAnalyzer,
	type DeadCodeOptions,
	type DeadCodeResult,
	type ImpactAnalysis,
	type ImpactOptions,
	type ImpactResult,
	type TestGapOptions,
	type TestGapResult,
} from "./analyzer.js";
export {
	createTestFileDetector,
	type SupportedLanguage,
	TestFileDetector,
	type TestPattern,
} from "./test-detector.js";
