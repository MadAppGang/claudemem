/**
 * FIXTURE — deliberately unsafe, never executed.
 *
 * The capability obtained LAZILY, the way `src/cli.ts` and
 * `src/tui/components/command/BenchmarkResults.tsx` really do it. No static
 * import line to find; the `import("node:child_process")` expression is the
 * capability and is what the rule matches.
 */

export async function reindex(cwd: string): Promise<void> {
	const { exec } = await import("node:child_process");
	exec("mnemex index --quiet", { cwd });
}
