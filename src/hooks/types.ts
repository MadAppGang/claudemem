/**
 * Claude Code Hook Types
 *
 * Type definitions for handling Claude Code hook events.
 * Hooks receive JSON via stdin and respond via fd 3 (or stdout).
 */

// ============================================================================
// Hook Input Types
// ============================================================================

/**
 * Hook input from Claude Code (received via stdin)
 */
export interface HookInput {
	/** Unique session identifier */
	session_id: string;

	/** Path to conversation transcript */
	transcript_path: string;

	/** Current working directory */
	cwd: string;

	/** Permission mode */
	permission_mode: "default" | "plan" | "bypasspermissions";

	/** Hook event type */
	hook_event_name:
		| "SessionStart"
		| "PreToolUse"
		| "PostToolUse"
		| "Stop"
		| "SubagentStop";

	/** Tool name (for PreToolUse/PostToolUse) */
	tool_name?: string;

	/** Tool input parameters */
	tool_input?: ToolInput;

	/** Tool response (for PostToolUse) */
	tool_response?: ToolResponse;

	/** Tool use ID */
	tool_use_id?: string;
}

/**
 * Tool input parameters (varies by tool type)
 */
export interface ToolInput {
	// Grep
	pattern?: string;
	path?: string;

	// Bash
	command?: string;
	description?: string;

	// Write/Edit
	file_path?: string;
	content?: string;
	old_string?: string;
	new_string?: string;

	// Read
	offset?: number;
	limit?: number;

	// Generic extension
	[key: string]: unknown;
}

/**
 * Tool response (for PostToolUse events)
 */
export interface ToolResponse {
	filePath?: string;
	success?: boolean;
	[key: string]: unknown;
}

// ============================================================================
// Hook Output Types
// ============================================================================

/**
 * Hook output to Claude Code (written to fd 3 or stdout)
 */
export interface HookOutput {
	/** Additional context to show Claude */
	additionalContext?: string;

	/** Tool-specific control (PreToolUse only) */
	hookSpecificOutput?: PreToolUseOutput;
}

/**
 * PreToolUse-specific output for permission control
 */
export interface PreToolUseOutput {
	hookEventName: "PreToolUse";
	permissionDecision: "allow" | "deny";
	permissionDecisionReason?: string;
}

// ============================================================================
// Handler Types
// ============================================================================

/**
 * Handler function signature
 */
export type HookHandler = (input: HookInput) => Promise<HookOutput | null>;

/**
 * Handler options passed from CLI
 */
export interface HookOptions {
	debug?: boolean;
}

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Index status check result
 */
export interface IndexStatus {
	indexed: boolean;
	symbolCount?: string;
}
