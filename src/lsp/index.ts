/**
 * LSP Module
 *
 * Public exports for the LSP client layer.
 */

export type { LspClientConfig, LspState } from "./client.js";
export { LspClient } from "./client.js";
export type { LspManagerConfig } from "./manager.js";
export { LspManager } from "./manager.js";
export {
	type Hover,
	type InitializeResult,
	type Location,
	LSP_METHODS,
	type MarkupContent,
	type Position,
	pathToUri,
	type Range,
	type ReferenceParams,
	type RenameParams,
	type ServerCapabilities,
	type TextDocumentEdit,
	type TextEdit,
	uriToPath,
	type WorkspaceEdit,
} from "./protocol.js";
export type { LanguageServerConfig } from "./registry.js";
export { LANGUAGE_SERVER_CONFIGS } from "./registry.js";
export { LspTransport } from "./transport.js";
