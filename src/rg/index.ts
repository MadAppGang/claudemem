/**
 * rg module — drop-in ripgrep replacement with mnemex semantic augmentation
 */

export { parseRgArgs, ensureLineNumbers } from "./parser.js";
export type { MatchFlags, OutputMode, ParsedRgArgs } from "./parser.js";

export { mergeResults, matchesPattern } from "./merger.js";

export { handleRgInstall, handleRgUninstall, patchClaudeSettings } from "./install.js";
