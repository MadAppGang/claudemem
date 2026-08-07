/**
 * Command Output Components
 *
 * Barrel export for all components under src/tui/components/command/.
 * These components are used by TuiOutput (src/output/tui-output.ts) to
 * render non-interactive command output via OpenTUI React with a temporary
 * renderer (useAlternateScreen: false).
 *
 * Component map:
 *   CommandOutputApp  — root wrapper, hosts child component + onDone lifecycle
 *   IndexProgress     — animated multi-phase progress for `mnemex index`
 *   StatusMessage     — success / error / info / warning footer lines
 */

export type {
	BenchmarkListAppProps,
	BenchmarkRunSummary,
	RunError,
} from "./BenchmarkList.js";
export { BenchmarkListApp } from "./BenchmarkList.js";
export type {
	BenchmarkResultsAppProps,
	BenchmarkResultsData,
	BenchmarkResultsProps,
} from "./BenchmarkResults.js";
export { BenchmarkResults, BenchmarkResultsApp } from "./BenchmarkResults.js";
export type { CommandOutputAppProps } from "./CommandOutputApp.js";
export { CommandOutputApp } from "./CommandOutputApp.js";
export type { IndexProgressProps } from "./IndexProgress.js";
export { IndexProgress } from "./IndexProgress.js";
export type { MetricHint, MetricHintsProps } from "./MetricHints.js";
export { MetricHints } from "./MetricHints.js";
export type { MetricsColumn, MetricsTableProps } from "./MetricsTable.js";
export { MetricsTable } from "./MetricsTable.js";
export type { StatusMessageProps, StatusType } from "./StatusMessage.js";
export { StatusMessage } from "./StatusMessage.js";
