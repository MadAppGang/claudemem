/**
 * Shared UI Components
 *
 * Reusable terminal UI components for CLI benchmark tools:
 * - Embedding model benchmark
 * - LLM summary benchmark
 * - Index progress display
 */

// Colors
export { c, colorize, colors, styled } from "./colors.js";
// Logo and branding
export {
	getLogo,
	printBenchmarkHeader,
	printLogo,
	printPhaseHeader,
	printStatus,
} from "./logo.js";
// Progress bars
export {
	type BenchmarkProgress,
	createBenchmarkProgress,
	createSimpleProgress,
	formatElapsed,
} from "./progress.js";
// Table rendering
export {
	type CellValue,
	formatContextLength,
	formatCost,
	formatDuration,
	formatPercent,
	getHighlight,
	renderBenchmarkBanner,
	renderError,
	renderHeader,
	renderInfo,
	renderSuccess,
	renderSummary,
	renderTable,
	type TableColumn,
	truncate,
} from "./table.js";
