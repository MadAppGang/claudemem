/**
 * Reporter Factory
 *
 * Creates reporter instances based on format.
 */

import type { IReporter, ReportFormat } from "../types.js";
import { CLIReporter } from "./cli-reporter.js";
import { JSONReporter } from "./json-reporter.js";
import { DetailedReporter } from "./detailed-reporter.js";

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Create a reporter for the specified format.
 */
export function createReporter(format: ReportFormat): IReporter {
	switch (format) {
		case "cli":
			return new CLIReporter();
		case "json":
			return new JSONReporter();
		case "detailed":
			return new DetailedReporter();
		default:
			throw new Error(`Unknown report format: ${format}`);
	}
}

/**
 * Create multiple reporters for the specified formats.
 */
export function createReporters(formats: ReportFormat[]): IReporter[] {
	return formats.map(createReporter);
}
