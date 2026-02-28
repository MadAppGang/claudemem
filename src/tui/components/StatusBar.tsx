/**
 * StatusBar Component
 *
 * Bottom bar showing project path + index status on the left
 * and context-sensitive keybinding hints on the right.
 */

import { useAppContext, type TabId } from "../context.js";
import { theme } from "../theme.js";
import { basename } from "node:path";
import { CURRENT_INDEX_VERSION } from "../../core/index-version.js";

// ============================================================================
// Keybinding Hints per View
// ============================================================================

const hints: Record<TabId, string> = {
	search: "/ search  j/k navigate  Enter expand  s symbol  ? help",
	map: "j/k navigate  Enter expand  Left collapse  s symbol  ? help",
	graph: "Tab:pane  Enter:drill  Backspace:back  ? help",
	analysis: "j/k navigate  Enter details  1-3 sub-tab  ? help",
	doctor: "j/k navigate  Enter select  r refresh  ? help",
};

// ============================================================================
// Component
// ============================================================================

export function StatusBar() {
	const { projectPath, activeTab, indexVersion } = useAppContext();
	const projectName = basename(projectPath);
	const isOutdated = indexVersion < CURRENT_INDEX_VERSION;

	return (
		<box
			flexDirection="row"
			width="100%"
			height={1}
			justifyContent="space-between"
		>
			<box paddingLeft={1} flexDirection="row">
				<text fg={theme.muted}>{projectName}</text>
				<text fg={theme.dimmed}> v{indexVersion}</text>
				{isOutdated && (
					<text fg={theme.warning}>
						{" [outdated - run: claudemem index --force]"}
					</text>
				)}
			</box>

			<box paddingRight={1}>
				<text fg={theme.dimmed}>{hints[activeTab]}</text>
			</box>
		</box>
	);
}
