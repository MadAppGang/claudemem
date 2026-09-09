/**
 * Which endpoints the Ollama Cloud credential is allowed to reach.
 *
 * A LEAF module on purpose: `resolver.ts`, `client.ts` and `providers/local.ts`
 * all need this predicate, and none of them may import the others (client <-
 * resolver is already a cycle held together by a dynamic import, and `local.ts`
 * must not import `config.ts` at all).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS — review finding B1, a credential leak.
 *
 * `ollama-cloud/<model>` is not its own provider: it resolves to provider
 * `"local"` pointed at `https://ollama.com/v1`, because it speaks the same
 * OpenAI-compatible protocol as a local Ollama (CLAUDE.md #18). Routing
 * `OLLAMA_API_KEY` through `getOllamaApiKey()` at the composition site therefore
 * attached `Authorization: Bearer <secret>` to EVERY `"local"` client — LM Studio
 * on `localhost:1234`, and any endpoint a user persisted through
 * `mnemex init`'s custom-endpoint prompt, which can be an arbitrary host.
 *
 * That ships an Ollama Cloud credential to third-party and self-hosted servers
 * that never needed it (CWE-200). The provider TYPE is not the security boundary;
 * the endpoint IDENTITY is. Bind the header to the identity.
 *
 * An explicitly supplied `apiKey` is always honoured — that is the caller
 * deliberately authenticating to an endpoint of its choosing. What this predicate
 * gates is only the IMPLICIT fallbacks: the keychain/config lookup in
 * `createLLMClient` and the `process.env.OLLAMA_API_KEY` read in
 * `LocalLLMClient`'s constructor.
 */

/** The one hosted endpoint the `"local"` provider serves. */
export const OLLAMA_CLOUD_ENDPOINT = "https://ollama.com/v1";

/** Hosts that are Ollama Cloud. Subdomains included; nothing else is. */
const OLLAMA_CLOUD_HOST = "ollama.com";

/**
 * True only for an `https://…ollama.com` endpoint.
 *
 * Parsed as a URL rather than matched as a substring: `https://ollama.com.evil.io`
 * and `https://notollama.com` both contain the host as a substring and are both
 * somebody else's server. An unparseable or non-https endpoint is false — failing
 * closed here costs a 401 the user can read, where failing open costs them a
 * credential.
 */
export function isOllamaCloudEndpoint(endpoint: string | undefined): boolean {
	if (!endpoint) return false;
	let host: string;
	let protocol: string;
	try {
		const url = new URL(endpoint);
		host = url.hostname.toLowerCase();
		protocol = url.protocol;
	} catch {
		return false;
	}
	if (protocol !== "https:") return false;
	return host === OLLAMA_CLOUD_HOST || host.endsWith(`.${OLLAMA_CLOUD_HOST}`);
}
