/**
 * Doctor module - Public API
 *
 * Diagnostic tool for context file health analysis
 */

export { aggregateDiagnoses, analyzeContextFile } from "./analyzer.js";
export {
	formatDoctorCompact,
	formatDoctorJSON,
	formatDoctorReport,
} from "./formatter.js";
export { runGenerator, runGeneratorAgent } from "./generator.js";
export { scanForContextFiles } from "./scanner.js";
export { aggregateScore, classifySeverity } from "./scorer.js";
export {
	gatherProjectContext,
	generateSmartQuestions,
} from "./smart-questions.js";
export type * from "./types.js";
