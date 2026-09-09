/**
 * FIXTURE (e) — `const { spawn: s } = cp`.
 *
 * The namespace import IS caught by the regex sweep (it matches the specifier),
 * so this fixture is about the graph rule's second half: following a rename
 * through a destructuring pattern so the CALL `s(...)` is attributed. The
 * finding is on the call, not on the import line. Kind `primitive`.
 */
import * as cp from "node:child_process";

const { spawn: s } = cp;

export function run(): void {
	s("ls", ["-la"]);
}
