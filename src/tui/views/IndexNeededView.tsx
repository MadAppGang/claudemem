/**
 * IndexNeededView
 *
 * Shown when the project has no index or an outdated index.
 * Offers the user a choice to start indexing or quit.
 *
 * States:
 *   1. Prompt — "Press Enter to index, q to quit"
 *   2. Indexing — shows live IndexProgress component
 *   3. Done — transitions back to normal tabs (handled by App.tsx)
 */

import { basename } from "node:path";
import { useKeyboard } from "@opentui/react";
import { getEmbeddingModel } from "../../config.js";
import { IndexProgress } from "../components/command/IndexProgress.js";
import { useAppContext } from "../context.js";
import { theme } from "../theme.js";

// ============================================================================
// Component
// ============================================================================

export function IndexNeededView() {
	const {
		projectPath,
		indexing,
		indexReason,
		progressStore,
		startIndexing,
		quit,
	} = useAppContext();

	// Keyboard: Enter to index, q to quit (only when not actively indexing)
	useKeyboard((key) => {
		if (indexing) return;

		if (key.name === "return" || key.name === "enter") {
			startIndexing();
			return;
		}

		if (key.name === "q" && !key.ctrl && !key.meta) {
			quit();
		}
	});

	// While indexing, show the progress display
	if (indexing && progressStore) {
		const projectName = basename(projectPath);
		const model = getEmbeddingModel(projectPath);
		const isForce = indexReason === "outdated";

		return (
			<box
				flexDirection="column"
				width="100%"
				height="100%"
				justifyContent="center"
				alignItems="center"
			>
				<box flexDirection="column" paddingLeft={4}>
					<box flexDirection="row" height={1}>
						<text fg={theme.primary}>
							{isForce
								? `Re-indexing ${projectName} (version upgrade)`
								: `Indexing ${projectName}`}
						</text>
					</box>
					<box flexDirection="row" height={1}>
						<text fg={theme.dimmed}>{`  Model: ${model}`}</text>
					</box>
					<box flexDirection="row" height={1}>
						<text fg={theme.muted}> </text>
					</box>
					<IndexProgress
						store={progressStore}
						globalStartTime={progressStore.getGlobalStartTime()}
					/>
				</box>
			</box>
		);
	}

	// Prompt state
	const reason = indexReason ?? "missing";
	const projectName = basename(projectPath);

	return (
		<box
			flexDirection="column"
			width="100%"
			height="100%"
			justifyContent="center"
			alignItems="center"
		>
			<box flexDirection="column" paddingLeft={2} paddingRight={2}>
				<box flexDirection="row" height={1}>
					<text fg={theme.primary}>{"Index Required"}</text>
				</box>

				<box flexDirection="row" height={1}>
					<text fg={theme.muted}> </text>
				</box>

				<box flexDirection="row" height={1}>
					<text fg={theme.text}>
						{reason === "missing"
							? `No index found for ${projectName}.`
							: `Index for ${projectName} is outdated (full re-index needed).`}
					</text>
				</box>

				{reason === "outdated" && (
					<box flexDirection="row" height={1}>
						<text fg={theme.dimmed}>
							{"  New version adds AST metadata and hierarchical code units."}
						</text>
					</box>
				)}

				<box flexDirection="row" height={1}>
					<text fg={theme.muted}> </text>
				</box>

				<box flexDirection="row" height={1}>
					<text fg={theme.muted}>{"Indexing enables:"}</text>
				</box>
				<box flexDirection="row" height={1}>
					<text fg={theme.dimmed}>{"  • Semantic code search"}</text>
				</box>
				<box flexDirection="row" height={1}>
					<text fg={theme.dimmed}>{"  • Symbol graph with PageRank"}</text>
				</box>
				<box flexDirection="row" height={1}>
					<text fg={theme.dimmed}>{"  • Dead code & test gap analysis"}</text>
				</box>

				<box flexDirection="row" height={1}>
					<text fg={theme.muted}> </text>
				</box>

				<box height={1}>
					<text fg={theme.dimmed}>
						{reason === "outdated"
							? "Press [Enter] to re-index (force)"
							: "Press [Enter] to start indexing"}
					</text>
				</box>
				<box height={1}>
					<text fg={theme.dimmed}>{"Press [q] to quit"}</text>
				</box>
			</box>
		</box>
	);
}
