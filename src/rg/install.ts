/**
 * rg install/uninstall helpers
 *
 * Installs a `~/.local/bin/rg` wrapper that delegates to `mnemex rg`,
 * and sets `USE_BUILTIN_RIPGREP=0` in `~/.claude/settings.json` so that
 * Claude Code uses the PATH rg instead of its bundled binary.
 */

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Path to the generated rg wrapper script */
function getRgWrapperPath(): string {
	return join(homedir(), ".local", "bin", "rg");
}

/** Path to Claude Code settings.json */
function getClaudeSettingsPath(): string {
	return join(homedir(), ".claude", "settings.json");
}

/** Content of the rg wrapper script */
const RG_WRAPPER_CONTENT = '#!/bin/sh\nexec mnemex rg "$@"\n';

/**
 * Install the rg wrapper and update Claude Code settings.
 */
export async function handleRgInstall(): Promise<void> {
	const wrapperPath = getRgWrapperPath();
	const wrapperDir = join(homedir(), ".local", "bin");

	// 1. Create ~/.local/bin if needed
	if (!existsSync(wrapperDir)) {
		mkdirSync(wrapperDir, { recursive: true });
		console.log(`Created directory: ${wrapperDir}`);
	}

	// 2. Write the wrapper script
	writeFileSync(wrapperPath, RG_WRAPPER_CONTENT, { encoding: "utf-8" });
	chmodSync(wrapperPath, 0o755);
	console.log(`Created rg wrapper: ${wrapperPath}`);

	// 3. Update ~/.claude/settings.json
	patchClaudeSettings(true);

	console.log("");
	console.log("mnemex rg installed successfully.");
	console.log("");
	console.log("To activate, ensure ~/.local/bin is early in your PATH:");
	console.log('  export PATH="$HOME/.local/bin:$PATH"');
	console.log("");
	console.log(
		"Claude Code will now use mnemex-enhanced search for Grep tool calls.",
	);
}

/**
 * Uninstall the rg wrapper and revert Claude Code settings.
 */
export async function handleRgUninstall(): Promise<void> {
	const wrapperPath = getRgWrapperPath();

	// 1. Remove the wrapper (safety check: must contain "mnemex")
	if (existsSync(wrapperPath)) {
		const content = readFileSync(wrapperPath, "utf-8");
		if (content.includes("mnemex")) {
			unlinkSync(wrapperPath);
			console.log(`Removed rg wrapper: ${wrapperPath}`);
		} else {
			console.log(
				`Skipped removal: ${wrapperPath} does not appear to be a mnemex wrapper.`,
			);
		}
	} else {
		console.log(`rg wrapper not found at ${wrapperPath}, nothing to remove.`);
	}

	// 2. Revert ~/.claude/settings.json
	patchClaudeSettings(false);

	console.log("");
	console.log("mnemex rg uninstalled.");
}

/**
 * Add or remove `USE_BUILTIN_RIPGREP=0` from Claude Code settings.json.
 *
 * @param install - true to add the key, false to remove it
 * @param settingsPath - override the default `~/.claude/settings.json` path (for testing)
 */
export function patchClaudeSettings(
	install: boolean,
	settingsPath = getClaudeSettingsPath(),
): void {
	let settings: Record<string, unknown> = {};

	if (existsSync(settingsPath)) {
		try {
			settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
		} catch {
			console.warn(
				`Warning: Could not parse ${settingsPath}, skipping settings update.`,
			);
			return;
		}
	}

	const env = (settings.env as Record<string, string> | undefined) ?? {};

	if (install) {
		if (env.USE_BUILTIN_RIPGREP !== "0") {
			env.USE_BUILTIN_RIPGREP = "0";
			settings.env = env;
			writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", {
				encoding: "utf-8",
			});
			console.log(`Updated ${settingsPath}: set USE_BUILTIN_RIPGREP=0`);
		} else {
			console.log(
				`${settingsPath}: USE_BUILTIN_RIPGREP=0 already set, no change.`,
			);
		}
	} else {
		if ("USE_BUILTIN_RIPGREP" in env) {
			delete env.USE_BUILTIN_RIPGREP;
			// If env is now empty, remove the key entirely
			if (Object.keys(env).length === 0) {
				delete settings.env;
			} else {
				settings.env = env;
			}
			writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n", {
				encoding: "utf-8",
			});
			console.log(`Updated ${settingsPath}: removed USE_BUILTIN_RIPGREP`);
		} else {
			console.log(
				`${settingsPath}: USE_BUILTIN_RIPGREP not found, no change needed.`,
			);
		}
	}
}
