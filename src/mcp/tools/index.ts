/**
 * MCP Tool Registrations
 *
 * Re-exports all register* functions for convenient wiring in the MCP server.
 */

export { registerAnalysisTools } from "./analysis.js";
export { registerCalleesTools } from "./callees.js";
export { registerCallersTools } from "./callers.js";
export { registerContextTools } from "./context.js";
export type { ToolDeps } from "./deps.js";
export { registerEditTools } from "./edit.js";
export { registerLegacyTools } from "./legacy.js";
export { registerLspTools } from "./lsp.js";
export { registerMapTools } from "./map.js";
export { registerMemoryTools } from "./memory.js";
export { registerObserveTools } from "./observe.js";
export { registerReadFileTools } from "./read-file.js";
export { registerReindexTools } from "./reindex.js";
export { registerRenameTools } from "./rename.js";
export { registerSearchTools } from "./search.js";
export { registerSearchPatternTools } from "./search-pattern.js";
export { registerStatusTools } from "./status.js";
export { registerSymbolTools } from "./symbol.js";
export { registerThinkTools } from "./think.js";
