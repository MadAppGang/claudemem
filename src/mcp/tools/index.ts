/**
 * MCP Tool Registrations
 *
 * Re-exports all register* functions for convenient wiring in the MCP server.
 */

export { registerSearchTools } from "./search.js";
export { registerSymbolTools } from "./symbol.js";
export { registerCallersTools } from "./callers.js";
export { registerCalleesTools } from "./callees.js";
export { registerMapTools } from "./map.js";
export { registerContextTools } from "./context.js";
export { registerAnalysisTools } from "./analysis.js";
export { registerStatusTools } from "./status.js";
export { registerReindexTools } from "./reindex.js";
export { registerLegacyTools } from "./legacy.js";
export type { ToolDeps } from "./deps.js";
