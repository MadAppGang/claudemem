/**
 * Claude Code Hooks Module
 *
 * Handles Claude Code hook events for tool interception and session management.
 * Entry point: `mnemex hook` command reads JSON from stdin.
 */

export { handleHook } from "./dispatcher.js";
export type {
	HookHandler,
	HookInput,
	HookOptions,
	HookOutput,
	IndexStatus,
	PreToolUseOutput,
	ToolInput,
	ToolResponse,
} from "./types.js";
