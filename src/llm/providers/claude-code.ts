/**
 * Claude Code CLI LLM Provider
 *
 * Executes Claude Code CLI as a subprocess to generate completions.
 * This allows reusing the user's existing Claude Code session/API access.
 */

import { spawn } from "node:child_process";
import { BaseLLMClient, DEFAULT_LLM_MODELS } from "../client.js";
import type { LLMGenerateOptions, LLMMessage, LLMResponse } from "../../types.js";

// ============================================================================
// Types
// ============================================================================

interface ClaudeCodeOptions {
	/** Model to use */
	model?: string;
	/** Request timeout in ms */
	timeout?: number;
}

// ============================================================================
// Claude Code CLI Client
// ============================================================================

export class ClaudeCodeLLMClient extends BaseLLMClient {
	constructor(options: ClaudeCodeOptions = {}) {
		super(
			"claude-code",
			options.model || DEFAULT_LLM_MODELS["claude-code"],
			options.timeout || 120000
		);
	}

	async complete(
		messages: LLMMessage[],
		options?: LLMGenerateOptions
	): Promise<LLMResponse> {
		return this.withRetry(async () => {
			// Build the prompt from messages
			const prompt = this.buildPrompt(messages, options?.systemPrompt);

			// Execute Claude Code CLI
			const result = await this.executeClaudeCode(prompt, options);

			return {
				content: result.content,
				model: this.model,
				usage: result.usage,
			};
		});
	}

	/**
	 * Build a prompt string from messages
	 */
	private buildPrompt(messages: LLMMessage[], systemPrompt?: string): string {
		const parts: string[] = [];

		// Add system prompt if provided
		if (systemPrompt) {
			parts.push(`System: ${systemPrompt}\n`);
		}

		// Add messages
		for (const msg of messages) {
			if (msg.role === "system") {
				parts.push(`System: ${msg.content}\n`);
			} else if (msg.role === "user") {
				parts.push(`${msg.content}`);
			} else if (msg.role === "assistant") {
				parts.push(`Assistant: ${msg.content}\n`);
			}
		}

		return parts.join("\n").trim();
	}

	/**
	 * Execute Claude Code CLI and get response
	 */
	private executeClaudeCode(
		prompt: string,
		options?: LLMGenerateOptions
	): Promise<{ content: string; usage?: { inputTokens: number; outputTokens: number } }> {
		return new Promise((resolve, reject) => {
			// Build command arguments
			const args = [
				"--print", // Print response only, no interactive mode
				"--output-format", "text", // Plain text output
			];

			// Add max tokens if specified
			if (options?.maxTokens) {
				args.push("--max-turns", "1");
			}

			// Spawn claude process
			const claude = spawn("claude", args, {
				stdio: ["pipe", "pipe", "pipe"],
				timeout: this.timeout,
			});

			let stdout = "";
			let stderr = "";
			let aborted = false;

			const onAbort = () => {
				aborted = true;
				claude.kill("SIGTERM");
			};

			if (options?.abortSignal) {
				if (options.abortSignal.aborted) {
					onAbort();
				} else {
					options.abortSignal.addEventListener("abort", onAbort, { once: true });
				}
			}

			claude.stdout.on("data", (data) => {
				stdout += data.toString();
			});

			claude.stderr.on("data", (data) => {
				stderr += data.toString();
			});

			claude.on("error", (error) => {
				if (error.message.includes("ENOENT")) {
					reject(new Error(
						"Claude Code CLI not found. Please install it with: npm install -g @anthropic-ai/claude-code"
					));
				} else {
					reject(error);
				}
			});

			claude.on("close", (code) => {
				if (options?.abortSignal) {
					options.abortSignal.removeEventListener("abort", onAbort);
				}

				if (aborted) {
					reject(new Error("Claude Code CLI request aborted"));
					return;
				}

				if (code !== 0) {
					// Check for common errors
					if (stderr.includes("authentication") || stderr.includes("API key")) {
						reject(new Error(
							"Claude Code authentication failed. Please run 'claude auth' to authenticate."
						));
					} else {
						reject(new Error(`Claude Code CLI exited with code ${code}: ${stderr || stdout}`));
					}
					return;
				}

				resolve({
					content: stdout.trim(),
					// Claude Code CLI doesn't provide token usage
					usage: undefined,
				});
			});

			// Set up timeout
			const timeoutId = setTimeout(() => {
				claude.kill("SIGTERM");
				reject(new Error(`Claude Code CLI timed out after ${this.timeout}ms`));
			}, this.timeout);

			claude.on("close", () => {
				clearTimeout(timeoutId);
			});

			// Write prompt to stdin and close
			claude.stdin.write(prompt);
			claude.stdin.end();
		});
	}

	/**
	 * Test if Claude Code CLI is available and authenticated
	 */
	async testConnection(): Promise<boolean> {
		try {
			// Try a simple completion
			const result = await this.complete(
				[{ role: "user", content: "Reply with only the word 'ok'" }],
				{ maxTokens: 10 }
			);
			return result.content.toLowerCase().includes("ok");
		} catch (error) {
			// Check if it's just not installed
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes("ENOENT") || msg.includes("not found")) {
				console.warn("Claude Code CLI not installed");
			} else if (msg.includes("authentication")) {
				console.warn("Claude Code CLI not authenticated");
			}
			return false;
		}
	}
}
