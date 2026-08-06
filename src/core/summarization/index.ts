/**
 * Summarization Module
 *
 * Provides bottom-up summary generation for code units:
 * - Methods/functions summarized first
 * - Classes inject child summaries
 * - Files inject exported unit summaries
 */

export {
	buildClassSummaryPrompt,
	buildFileSummaryPrompt,
	buildFunctionSummaryPrompt,
	buildGoFunctionSummaryPrompt,
	type ClassSummaryInput,
	type FileSummaryInput,
	type FunctionSummaryInput,
	type GoFunctionSummaryInput,
	SUMMARY_SYSTEM_PROMPT,
} from "./prompts.js";
export {
	BottomUpSummarizer,
	createBottomUpSummarizer,
	type SummarizationOptions,
	type SummarizationResult,
	type SummaryResult,
} from "./summarizer.js";
