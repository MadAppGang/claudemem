/**
 * Black-box tests for the one contract-visible piece of V13 / D7 that lives outside the
 * secrets layer: `isOllamaCloudEndpoint` (public-signatures.md, [ollama-cloud]). The
 * OLLAMA_API_KEY credential is bound to the ollama.com endpoint; a predicate that matched by
 * substring would ship the key to `https://ollama.com.evil.example`.
 *
 * The header-level assertion in V13 (the Ollama provider "carries" the key) is NOT covered
 * here: the LLM client constructor is not part of the published contract. See test-plan.md.
 */
import { describe, expect, test } from "bun:test";
import {
	isOllamaCloudEndpoint,
	OLLAMA_CLOUD_ENDPOINT,
} from "../../src/llm/ollama-cloud.js";

describe("isOllamaCloudEndpoint", () => {
	test("the canonical cloud endpoint is recognised", () => {
		expect(OLLAMA_CLOUD_ENDPOINT).toBe("https://ollama.com/v1");
		expect(isOllamaCloudEndpoint(OLLAMA_CLOUD_ENDPOINT)).toBe(true);
		expect(isOllamaCloudEndpoint("https://ollama.com/v1/")).toBe(true);
		expect(isOllamaCloudEndpoint("https://ollama.com")).toBe(true);
	});

	test("hosts that merely CONTAIN ollama.com are rejected", () => {
		expect(isOllamaCloudEndpoint("https://ollama.com.evil.example/v1")).toBe(
			false,
		);
		expect(isOllamaCloudEndpoint("https://evil.example/ollama.com/v1")).toBe(
			false,
		);
		expect(
			isOllamaCloudEndpoint("https://evil.example/?next=https://ollama.com/v1"),
		).toBe(false);
		expect(
			isOllamaCloudEndpoint("https://user@ollama.com.evil.example/v1"),
		).toBe(false);
	});

	test("local, self-hosted and third-party endpoints are not the cloud", () => {
		expect(isOllamaCloudEndpoint("http://localhost:11434/v1")).toBe(false);
		expect(isOllamaCloudEndpoint("http://127.0.0.1:1234/v1")).toBe(false);
		expect(isOllamaCloudEndpoint("https://openrouter.ai/api/v1")).toBe(false);
	});

	test("missing or malformed input is not the cloud and does not throw", () => {
		expect(isOllamaCloudEndpoint(undefined)).toBe(false);
		expect(isOllamaCloudEndpoint("")).toBe(false);
		expect(isOllamaCloudEndpoint("not a url")).toBe(false);
	});
});
