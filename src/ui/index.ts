/**
 * Shared UI Components
 *
 * Reusable terminal UI components for CLI benchmark tools:
 * - Embedding model benchmark
 * - LLM summary benchmark
 * - Index progress display
 */

// Colors
export { colors, c, colorize, styled } from "./colors.js";

// Progress bars
export {
	formatElapsed,
	createBenchmarkProgress,
	createSimpleProgress,
	type BenchmarkProgress,
} from "./progress.js";

// Table rendering
export {
	truncate,
	formatPercent,
	formatDuration,
	formatCost,
	formatContextLength,
	renderTable,
	renderSummary,
	renderHeader,
	renderInfo,
	renderBenchmarkBanner,
	renderSuccess,
	renderError,
	getHighlight,
	type TableColumn,
	type CellValue,
} from "./table.js";

// Logo and branding
export {
	getLogo,
	printLogo,
	printBenchmarkHeader,
	printPhaseHeader,
	printStatus,
} from "./logo.js";
