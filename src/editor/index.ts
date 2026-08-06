/**
 * Editor Module
 *
 * Public exports for the code editing system.
 */

export type { EditOptions, EditResult, InsertMode } from "./editor.js";
export { atomicWrite, SymbolEditor } from "./editor.js";
export type { EditSession } from "./history.js";
export { EditHistory } from "./history.js";
export type { SymbolLocation } from "./locator.js";
export {
	byteToUtf16Offset,
	SymbolLocator,
	utf16ToByteOffset,
} from "./locator.js";
export { EditValidator } from "./validator.js";
