import * as vscode from "vscode";
import { SearchProvider } from "./SearchProvider.js";
import { CompanionPanelProvider } from "./CompanionPanelProvider.js";
import { findMnemex } from "./CliBridge.js";
import { log, getOutputChannel } from "./log.js";
import * as fs from "fs";

export function activate(context: vscode.ExtensionContext): void {
	const channel = getOutputChannel();
	context.subscriptions.push(channel);
	log("mnemex extension activating");

	// Auto-detect binary on activation and warn if not found
	const binaryPath = findMnemex();
	log(`Binary resolved: ${binaryPath}`);
	if (binaryPath === "mnemex" || !fs.existsSync(binaryPath)) {
		// Only warn if it's the bare name fallback (auto-detect found nothing)
		// We do a quick non-blocking check via which; if it fails, show a notification
		const cfg = vscode.workspace.getConfiguration("mnemex");
		const configured = cfg.get<string>("binaryPath", "");
		if (!configured || configured.trim() === "") {
			// Show notification with install instructions
			void vscode.window
				.showWarningMessage(
					"mnemex binary not found. Install with: npm install -g mnemex",
					"Open Settings",
				)
				.then((selection) => {
					if (selection === "Open Settings") {
						void vscode.commands.executeCommand(
							"workbench.action.openSettings",
							"mnemex.binaryPath",
						);
					}
				});
		}
	}

	log("Creating providers");
	const provider = new SearchProvider(context.extensionUri, context);
	const companion = new CompanionPanelProvider(context.extensionUri, context);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(SearchProvider.viewId, provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand("mnemex.reindex", () => {
			void provider.reindex();
		}),
		vscode.commands.registerCommand("mnemex.openSearch", () => {
			void vscode.commands.executeCommand("mnemexSearch.focus");
		}),
		vscode.commands.registerCommand("mnemex.openCompanion", () => {
			companion.open();
		}),
	);
}

export function deactivate(): void {}
