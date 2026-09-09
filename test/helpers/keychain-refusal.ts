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
export function expectedRefusalReason(platform: string): string {
	return platform === "darwin"
		? "real keychain access was never enabled in this process"
		: `keychain unavailable on ${platform}`;
}
