/**
 * Auth header behaviour for the OpenAI-compatible local LLM client.
 *
 * Local Ollama (http://localhost:11434/v1) and LM Studio accept unauthenticated
 * requests. Ollama Cloud (https://ollama.com/v1) rejects them with HTTP 401.
 * The client must therefore send `Authorization: Bearer …` when a key is
 * configured and send no such header when one is not, so local setups keep
 * working unchanged.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LocalLLMClient } from "../../../src/llm/providers/local.js";

const originalFetch = globalThis.fetch;
const originalKey = process.env.OLLAMA_API_KEY;

/** Capture headers of the next chat/completions request. */
function captureHeaders(): { get: () => Record<string, string> } {
	let seen: Record<string, string> = {};
	globalThis.fetch = (async (url: any, init: any) => {
		if (String(url).includes("/chat/completions")) {
			seen = { ...(init?.headers ?? {}) };
		}
		return new Response(
			JSON.stringify({
				id: "1",
				model: "m",
				choices: [
					{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" },
				],
			}),
			{ status: 200, headers: { "Content-Type": "application/json" } },
		);
	}) as unknown as typeof fetch;
	return { get: () => seen };
}

afterEach(() => {
	globalThis.fetch = originalFetch;
	if (originalKey === undefined) delete process.env.OLLAMA_API_KEY;
	else process.env.OLLAMA_API_KEY = originalKey;
});

beforeEach(() => {
	delete process.env.OLLAMA_API_KEY;
});

describe("LocalLLMClient auth headers", () => {
	test("sends no Authorization header when no key is configured", async () => {
		const cap = captureHeaders();
		const client = new LocalLLMClient({ endpoint: "http://localhost:11434/v1" });
		await client.complete([{ role: "user", content: "hi" }]);

		expect(cap.get()["Content-Type"]).toBe("application/json");
		expect(cap.get().Authorization).toBeUndefined();
	});

	test("sends Bearer auth when apiKey is passed explicitly", async () => {
		const cap = captureHeaders();
		const client = new LocalLLMClient({
			endpoint: "https://ollama.com/v1",
			apiKey: "test-key-123",
		});
		await client.complete([{ role: "user", content: "hi" }]);

		expect(cap.get().Authorization).toBe("Bearer test-key-123");
	});

	test("falls back to OLLAMA_API_KEY from the environment", async () => {
		process.env.OLLAMA_API_KEY = "env-key-456";
		const cap = captureHeaders();
		const client = new LocalLLMClient({ endpoint: "https://ollama.com/v1" });
		await client.complete([{ role: "user", content: "hi" }]);

		expect(cap.get().Authorization).toBe("Bearer env-key-456");
	});

	test("explicit apiKey wins over the environment variable", async () => {
		process.env.OLLAMA_API_KEY = "env-key-456";
		const cap = captureHeaders();
		const client = new LocalLLMClient({
			endpoint: "https://ollama.com/v1",
			apiKey: "explicit-key",
		});
		await client.complete([{ role: "user", content: "hi" }]);

		expect(cap.get().Authorization).toBe("Bearer explicit-key");
	});
});
