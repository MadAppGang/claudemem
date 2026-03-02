/**
 * Doctor module - Public API
 *
 * Diagnostic tool for context file health analysis
 */

export { scanForContextFiles } from "./scanner.js";
export { analyzeContextFile, aggregateDiagnoses } from "./analyzer.js";
export { aggregateScore, classifySeverity } from "./scorer.js";
export {
	formatDoctorReport,
	formatDoctorJSON,
	formatDoctorCompact,
} from "./formatter.js";
export { runGenerator, runGeneratorAgent } from "./generator.js";
export {
	gatherProjectContext,
	generateSmartQuestions,
} from "./smart-questions.js";
export type * from "./types.js";
