/**
 * Code Analysis Module
 *
 * Exports analysis components:
 * - TestFileDetector: Language-aware test file detection
 * - CodeAnalyzer: Dead code, test gaps, impact analysis
 */

export {
	TestFileDetector,
	createTestFileDetector,
	type TestPattern,
	type SupportedLanguage,
} from "./test-detector.js";

export {
	CodeAnalyzer,
	createCodeAnalyzer,
	type DeadCodeResult,
	type TestGapResult,
	type ImpactResult,
	type ImpactAnalysis,
	type DeadCodeOptions,
	type TestGapOptions,
	type ImpactOptions,
} from "./analyzer.js";
