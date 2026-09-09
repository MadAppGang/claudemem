/**
 * FIXTURE — deliberately unsafe, never executed (and `execa` is not installed;
 * the file is only ever READ by the sweep).
 *
 * A third-party process runner is a launch capability by another name. The
 * rule keeps a short list of the well-known ones; a new one that is not on it
 * must be added to the list, which is a smaller and more visible change than an
 * allowlist entry for the file that uses it.
 */

// @ts-expect-error — fixture only; the package is deliberately not a dependency.
import { execa } from "execa";

export async function reindex(cwd: string): Promise<void> {
	await execa("mnemex", ["index", "--quiet"], { cwd });
}
