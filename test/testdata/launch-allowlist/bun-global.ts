/**
 * FIXTURE — deliberately unsafe, never executed.
 *
 * The Bun global needs no import at all, so an import-only rule would miss it.
 * Both spellings here — the direct property and the destructured form — are
 * matched, as is `Bun.$`.
 */

const { spawnSync } = Bun;

export function status(): number {
	const direct = Bun.spawn(["mnemex", "status"], { stdout: "ignore" });
	direct.unref();
	return spawnSync(["mnemex", "status"]).exitCode;
}

export async function shell(): Promise<string> {
	return (await Bun.$`mnemex status --agent`.quiet()).text();
}
