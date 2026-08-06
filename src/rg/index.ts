/**
 * rg module — drop-in ripgrep replacement with mnemex semantic augmentation
 */

export {
	handleRgInstall,
	handleRgUninstall,
	patchClaudeSettings,
} from "./install.js";
export { matchesPattern, mergeResults } from "./merger.js";
export type { MatchFlags, OutputMode, ParsedRgArgs } from "./parser.js";
export { ensureLineNumbers, parseRgArgs } from "./parser.js";
