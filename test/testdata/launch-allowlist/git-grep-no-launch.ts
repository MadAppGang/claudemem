/**
 * FIXTURE — the NEGATIVE. Expected `launches=false`.
 *
 * Mentions `git grep mnemex`, `brew upgrade mnemex` and the entry-point path in
 * strings, reads a file, writes a help message — and obtains no launch
 * capability anywhere. The old detector's over-matches (`brew upgrade mnemex`,
 * and it would have flagged `git grep mnemex`) came from reading ARGUMENTS; the
 * allowlist rule reads none, so prose and data can say what they like.
 */

export const HELP = [
	"Run 'mnemex init' to set up.",
	"To find uses: git grep mnemex",
	"To upgrade: brew upgrade mnemex",
	"Entry point: dist/index.js",
].join("\n");

export async function readManifest(path: string): Promise<string> {
	return Bun.file(path).text();
}
