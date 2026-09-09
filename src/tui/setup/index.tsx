/**
 * Setup TUI Entry Point
 *
 * Shows btop-inspired deployment mode diagrams first,
 * then launches the OpenTUI wizard for remaining steps.
 */

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import {
	getPendingSecretWarnings,
	setSecretWarningSink,
} from "../../core/secrets.js";
import { selectMode } from "./mode-diagrams.js";
import { SetupApp } from "./SetupApp.js";

// ============================================================================
// Entry
// ============================================================================

export async function startSetupWizard(): Promise<void> {
	if (!process.stdout.isTTY) {
		throw new Error("mnemex setup requires an interactive terminal (TTY)");
	}

	// Phase 1: Show mode diagrams and collect selection (plain terminal)
	const selectedMode = await selectMode();

	// CLAUDE.md #6: a `console.error` emitted inside a live OpenTUI screen corrupts
	// the display. Buffer keychain diagnostics for the whole life of the wizard.
	//
	// INSTALLED AT THE COMPOSITION ROOT, before the renderer exists — not in a
	// `useEffect`. `SetupApp`'s `useState` initializer calls
	// `prefillFromExistingConfig()`, which reaches the keychain, and a `useState`
	// initializer runs during the FIRST render, before any effect. A failure there
	// wrote straight to `console.error` mid-render: precisely the corruption the
	// buffering exists to prevent, on the wizard's very first keychain access.
	setSecretWarningSink(null);

	const drainWarnings = () => {
		setSecretWarningSink(console.error);
		for (const message of getPendingSecretWarnings()) console.error(message);
	};

	// Phase 2: Launch OpenTUI wizard starting after mode-select
	const renderer = await createCliRenderer({
		exitOnCtrlC: true,
		screenMode: "alternate-screen",
		useMouse: false,
		onDestroy: () => {
			// The screen is gone by the time this runs, so stderr is safe again. It
			// must happen HERE: `onDestroy` exits the process, so anything after
			// `renderer.destroy()` in `quit` never runs.
			drainWarnings();
			process.exit(0);
		},
	});

	const quit = () => {
		root.unmount();
		renderer.destroy();
	};

	const root = createRoot(renderer);
	root.render(<SetupApp quit={quit} initialMode={selectedMode} />);
}
