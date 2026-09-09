/**
 * FIXTURE — the NEGATIVE for `import type`. Expected `launches=false`.
 *
 * `src/lsp/transport.ts` imports only the `ChildProcess` TYPE from
 * `node:child_process`. A type import is erased at compile time and cannot
 * launch anything, so the rule strips `import type … ;` statements before
 * matching. An INLINE type specifier mixed with a value import
 * (`import { type ChildProcess, spawn }`) still fires, because the value half
 * is a real capability.
 */

import type { ChildProcess } from "node:child_process";

export interface Transport {
	process: ChildProcess;
}
