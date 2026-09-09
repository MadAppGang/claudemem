/**
 * V13 — `OLLAMA_API_KEY` resolves through the macOS Keychain and reaches the wire.
 *
 * The defect this closes: `local.ts` read `process.env.OLLAMA_API_KEY` directly in
 * two places, so a key stored in the keychain was invisible to the one provider
 * that most needs it (Ollama Cloud rejects unauthenticated requests with 401).
 *
 * Resolution happens at the COMPOSITION SITE (`createLLMClient`), never inside the
 * adapter: `local.ts` must not import `config.ts` (cycle), and a constructor that
 * consulted the keychain would break `local-auth.test.ts` on any machine with an
 * ollama key stored.
 *
 * NO TEST HERE SPAWNS ANYTHING.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getOllamaApiKey } from "../../../src/config.js";
import { createLLMClient } from "../../../src/llm/client.js";
import { getLocalModelInfo } from "../../../src/llm/providers/local.js";
import {
	fakeKeychain,
	installKeychainStub,
	type KeychainStub,
	NOT_FOUND,
	uninstallKeychainStub,
} from "../../helpers/keychain-stub.js";

let stub: KeychainStub;
const originalFetch = globalThis.fetch;
const savedKey = process.env.OLLAMA_API_KEY;

function captureHeaders(): { get: () => Record<string, string> } {
	let seen: Record<string, string> = {};
	globalThis.fetch = (async (url: unknown, init: unknown) => {
		const request = init as { headers?: Record<string, string> } | undefined;
		if (String(url).includes("/chat/completions")) {
			seen = { ...(request?.headers ?? {}) };
		}
		return new Response(
			JSON.stringify({
				id: "1",
				model: "m",
				choices: [
					{
						message: { role: "assistant", content: "ok" },
						finish_reason: "stop",
					},
				],
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as unknown as typeof fetch;
	return { get: () => seen };
}

beforeEach(() => {
	delete process.env.OLLAMA_API_KEY;
	stub = installKeychainStub();
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (savedKey === undefined) delete process.env.OLLAMA_API_KEY;
	else process.env.OLLAMA_API_KEY = savedKey;
	uninstallKeychainStub();
});

describe("V13 — OLLAMA_API_KEY through the keychain", () => {
	test("getOllamaApiKey resolves a stored value", () => {
		stub.setRun(fakeKeychain(new Map([["ollama", "stored-ollama-key"]])));
		expect(getOllamaApiKey()).toBe("stored-ollama-key");
		// It is looked up under the short account name, like every other key.
		expect(stub.calls[0]?.args).toContain("ollama");
	});

	test("the environment still wins, at zero spawns", () => {
		process.env.OLLAMA_API_KEY = "env-key";
		stub.setRun(fakeKeychain(new Map([["ollama", "stored-ollama-key"]])));
		expect(getOllamaApiKey()).toBe("env-key");
		expect(stub.calls).toHaveLength(0);
	});

	test("a keychain-stored key reaches the Authorization header", async () => {
		stub.setRun(
			fakeKeychain(new Map([["ollama", "kctest-ollama-from-keychain"]])),
		);
		const capture = captureHeaders();

		const client = await createLLMClient({
			provider: "local",
			model: "gemma4:31b",
			endpoint: "https://ollama.com/v1",
		});
		await client.complete([{ role: "user", content: "hi" }]);

		expect(capture.get().Authorization).toBe(
			"Bearer kctest-ollama-from-keychain",
		);
	});

	test("no stored key means NO Authorization header — local Ollama keeps working", async () => {
		stub.setRun(() => NOT_FOUND());
		const capture = captureHeaders();

		const client = await createLLMClient({
			provider: "local",
			model: "llama3.2",
			endpoint: "http://localhost:11434/v1",
		});
		await client.complete([{ role: "user", content: "hi" }]);

		expect(capture.get().Authorization).toBeUndefined();
		expect(capture.get()["Content-Type"]).toBe("application/json");
	});

	test("an explicitly passed key still wins over the keychain", async () => {
		stub.setRun(fakeKeychain(new Map([["ollama", "from-keychain"]])));
		const capture = captureHeaders();

		const client = await createLLMClient({
			provider: "local",
			model: "gemma4:31b",
			endpoint: "https://ollama.com/v1",
			apiKey: "explicit-key",
		});
		await client.complete([{ role: "user", content: "hi" }]);

		expect(capture.get().Authorization).toBe("Bearer explicit-key");
	});

	test("getLocalModelInfo threads the key rather than reading process.env", async () => {
		// The two direct env reads inside `getOllamaModelInfo` are gone; the key is a
		// parameter, so `local.ts` gains no import and no cycle.
		let seenAuth: string | undefined;
		globalThis.fetch = (async (url: unknown, init: unknown) => {
			const request = init as { headers?: Record<string, string> } | undefined;
			if (String(url).includes("/api/show")) {
				seenAuth = request?.headers?.Authorization;
			}
			return new Response(JSON.stringify({ details: {} }), { status: 200 });
		}) as unknown as typeof fetch;

		await getLocalModelInfo(
			"threaded-model",
			"http://localhost:11434",
			"threaded-key",
		);
		expect(seenAuth).toBe("Bearer threaded-key");
	});
});

// ============================================================================
// B1 — the Ollama credential reaches ollama.com and NOWHERE else
// ============================================================================

/**
 * The leak this closes: routing `OLLAMA_API_KEY` through `getOllamaApiKey()` at
 * the composition site attached `Authorization: Bearer <secret>` to EVERY
 * `"local"` client. `ollama-cloud` is not its own provider — it resolves to
 * `"local"` pointed at `https://ollama.com/v1` — and so does LM Studio, and so
 * does any endpoint a user persists through `mnemex init`'s custom-endpoint
 * prompt. The user's Ollama Cloud credential was being sent to third-party and
 * self-hosted servers (CWE-200).
 *
 * Every assertion here is on the CAPTURED HEADERS of the outbound request. A
 * report object cannot show where a credential went.
 */
describe("B1 — the Ollama key is scoped to the Ollama Cloud endpoint", () => {
	const NOT_OLLAMA_CLOUD = [
		["LM Studio", "http://localhost:1234/v1"],
		["local Ollama", "http://localhost:11434/v1"],
		["a user-configured endpoint", "https://inference.example.com/v1"],
		// Substring matching would let both of these through. They are somebody
		// else's servers.
		["a lookalike suffix host", "https://ollama.com.evil.example/v1"],
		["a lookalike prefix host", "https://notollama.com/v1"],
		["plain http on the real host", "http://ollama.com/v1"],
	] as const;

	for (const [label, endpoint] of NOT_OLLAMA_CLOUD) {
		test(`a KEYCHAIN-stored key is not sent to ${label}`, async () => {
			stub.setRun(fakeKeychain(new Map([["ollama", "kctest-ollama-LEAKED"]])));
			const capture = captureHeaders();

			const client = await createLLMClient({
				provider: "local",
				model: "m",
				endpoint,
			});
			await client.complete([{ role: "user", content: "hi" }]);

			expect(capture.get().Authorization).toBeUndefined();
			// And the value itself appears in no header at all.
			expect(JSON.stringify(capture.get())).not.toContain(
				"kctest-ollama-LEAKED",
			);
		});

		test(`an ENVIRONMENT key is not sent to ${label}`, async () => {
			// The adapter's own bare `process.env.OLLAMA_API_KEY` fallback is the
			// second leak path, and it predates this feature. Same rule.
			process.env.OLLAMA_API_KEY = "env-ollama-LEAKED";
			const capture = captureHeaders();

			const client = await createLLMClient({
				provider: "local",
				model: "m",
				endpoint,
			});
			await client.complete([{ role: "user", content: "hi" }]);

			expect(capture.get().Authorization).toBeUndefined();
		});
	}

	test("the key IS sent to https://ollama.com/v1", async () => {
		stub.setRun(fakeKeychain(new Map([["ollama", "kctest-ollama-CORRECT"]])));
		const capture = captureHeaders();

		const client = await createLLMClient({
			provider: "local",
			model: "gemma4:31b",
			endpoint: "https://ollama.com/v1",
		});
		await client.complete([{ role: "user", content: "hi" }]);

		expect(capture.get().Authorization).toBe("Bearer kctest-ollama-CORRECT");
	});

	test("the key is sent to an ollama.com SUBDOMAIN", async () => {
		stub.setRun(fakeKeychain(new Map([["ollama", "kctest-ollama-CORRECT"]])));
		const capture = captureHeaders();

		const client = await createLLMClient({
			provider: "local",
			model: "gemma4:31b",
			endpoint: "https://api.ollama.com/v1",
		});
		await client.complete([{ role: "user", content: "hi" }]);

		expect(capture.get().Authorization).toBe("Bearer kctest-ollama-CORRECT");
	});

	test("an EXPLICIT key is honoured anywhere — the gate is on the implicit fallbacks", async () => {
		// A caller passing a key has chosen to authenticate to that endpoint. Only
		// the keychain/config lookup and the bare env read are gated.
		const capture = captureHeaders();
		const client = await createLLMClient({
			provider: "local",
			model: "m",
			endpoint: "https://inference.example.com/v1",
			apiKey: "deliberate-key",
		});
		await client.complete([{ role: "user", content: "hi" }]);

		expect(capture.get().Authorization).toBe("Bearer deliberate-key");
	});

	test('an explicit "" means NO AUTH and does not fall through to a stored key', async () => {
		// `||` would have fallen through to `getOllamaApiKey()` here.
		stub.setRun(fakeKeychain(new Map([["ollama", "kctest-ollama-LEAKED"]])));
		const capture = captureHeaders();

		const client = await createLLMClient({
			provider: "local",
			model: "gemma4:31b",
			endpoint: "https://ollama.com/v1",
			apiKey: "",
		});
		await client.complete([{ role: "user", content: "hi" }]);

		expect(capture.get().Authorization).toBeUndefined();
	});

	test("a non-ollama-cloud local endpoint costs ZERO keychain reads", async () => {
		// The gate is applied BEFORE resolution, not after: an LM Studio run must not
		// pay a `security` spawn to fetch a key it will then discard.
		stub.setRun(fakeKeychain(new Map([["ollama", "kctest-ollama-LEAKED"]])));
		await createLLMClient({
			provider: "local",
			model: "m",
			endpoint: "http://localhost:1234/v1",
		});
		expect(stub.calls).toHaveLength(0);
	});
});

describe("the embeddings path stays unauthenticated (CLAUDE.md #18)", () => {
	test("getOllamaApiKey is documented as generation-only and is not used by embeddings", async () => {
		// Ollama Cloud's /api/embed returns 401 for EVERY model, so a key on the
		// embeddings path turns a working local-Ollama run into a confusing failure.
		const source = await Bun.file(
			new URL("../../../src/core/embeddings.ts", import.meta.url).pathname,
		).text();
		expect(source).not.toContain("getOllamaApiKey");
		expect(source).not.toContain("OLLAMA_API_KEY");
	});
});
