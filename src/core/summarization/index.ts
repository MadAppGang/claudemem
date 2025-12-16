/**
 * Summarization Module
 *
 * Provides bottom-up summary generation for code units:
 * - Methods/functions summarized first
 * - Classes inject child summaries
 * - Files inject exported unit summaries
 */

export {
	BottomUpSummarizer,
	createBottomUpSummarizer,
	type SummarizationOptions,
	type SummarizationResult,
	type SummaryResult,
} from "./summarizer.js";

export {
	SUMMARY_SYSTEM_PROMPT,
	buildFunctionSummaryPrompt,
	buildClassSummaryPrompt,
	buildFileSummaryPrompt,
	buildGoFunctionSummaryPrompt,
	type FunctionSummaryInput,
	type ClassSummaryInput,
	type FileSummaryInput,
	type GoFunctionSummaryInput,
} from "./prompts.js";
