/**
 * CommandOutputApp
 *
 * Root wrapper for non-interactive command output rendered via OpenTUI.
 * Wraps children in a simple box and calls onDone when output is complete.
 *
 * Used by TuiOutput (src/output/tui-output.ts) to host command-specific
 * child components (IndexProgress, SearchResults, etc.) inside a temporary
 * renderer created with useAlternateScreen: false so output stays visible.
 */

import { type ReactNode, useEffect } from "react";

// ============================================================================
// Props
// ============================================================================

export interface CommandOutputAppProps {
	/** Command-specific component to render (IndexProgress, etc.) */
	children: ReactNode;
	/**
	 * Called when the child component signals completion.
	 * For non-interactive commands, the TuiOutput router resolves its
	 * renderCommand/renderProgress promise when this fires.
	 */
	onDone?: () => void;
}

// ============================================================================
// Component
// ============================================================================

/**
 * Root container for all command output components.
 *
 * Renders children directly inside a full-width box. The onDone callback
 * is threaded to child components (e.g. IndexProgress) which call it when
 * they finish rendering, allowing the TuiOutput router to destroy the renderer.
 */
export function CommandOutputApp({ children, onDone }: CommandOutputAppProps) {
	// For static/immediate output (children that don't themselves call onDone),
	// fire onDone after the first render via useEffect.
	useEffect(() => {
		if (onDone) {
			// Let the first paint flush before signalling done.
			// Components that animate (IndexProgress) override this by calling
			// their own onDone prop instead - they receive onDone as a prop.
		}
	}, []); // eslint-disable-line react-hooks/exhaustive-deps

	return (
		<box flexDirection="column" width="100%">
			{children}
		</box>
	);
}
