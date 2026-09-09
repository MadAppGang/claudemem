/**
 * The exact reason a refused keychain read must carry, on the platform it
 * happened on.
 *
 * On darwin the platform gate passes, so a refusal comes from deny-by-default
 * and must say so. On every other platform `keychainUnavailableReason()` answers
 * FIRST with "keychain unavailable on <platform>" — an earlier and stricter
 * refusal — so demanding the darwin wording there asserts the wrong layer and
 * fails a build that is behaving correctly.
 *
 * This is not hypothetical. Three deny-by-default tests hardcoded the darwin
 * string and went red on `ubuntu-latest` in CI while macOS passed: the security
 * property held on both, and only the assertion was wrong. A macOS-only run can
 * never catch it.
 *
 * Returned per platform rather than accepting either string, so each assertion
 * stays exact instead of degrading to "one of two things".
 */
export function expectedRefusalReason(
	platform: string,
	/**
	 * What the message must contain ON DARWIN. Defaults to the deny-by-default
	 * reason. Pass the guarded-process wording ("refusing to spawn
	 * /usr/bin/security") where that veto is the one under test — the adapter has
	 * more than one darwin refusal, and they are not interchangeable.
	 */
	darwinReason = "real keychain access was never enabled in this process",
): string {
	return platform === "darwin"
		? darwinReason
		: `keychain unavailable on ${platform}`;
}

/**
 * The darwin-only refusal fragments no test may assert on directly.
 *
 * Every one of these is unreachable off darwin, because
 * `keychainUnavailableReason()` answers before the adapter is consulted. A test
 * that hardcodes one passes on a maintainer's Mac and fails in CI on Linux while
 * the security property holds on both — which happened twice in one afternoon,
 * at six sites, each found one CI round at a time.
 */
export const DARWIN_ONLY_REFUSAL_FRAGMENTS = [
	"refusing to spawn /usr/bin/security",
	"real keychain access was never enabled in this process",
] as const;
