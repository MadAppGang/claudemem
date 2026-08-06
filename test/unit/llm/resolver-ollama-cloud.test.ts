/**
 * Spec resolution for hosted Ollama (`ollama-cloud/...`).
 *
 * Ollama Cloud speaks the same OpenAI-compatible protocol as local Ollama, so
 * it reuses the "local" provider — but it must resolve to https://ollama.com/v1
 * rather than localhost, otherwise the request silently goes to a local daemon
 * that is usually not running.
 */

import { describe, expect, test } from "bun:test";
import { LLMResolver } from "../../../src/llm/resolver.js";

describe("LLMResolver: ollama-cloud spec", () => {
	test("resolves to the hosted endpoint, not localhost", () => {
		const spec = LLMResolver.parseSpec("ollama-cloud/gemma4:31b");
		expect(spec.provider).toBe("local");
		expect(spec.endpoint).toBe("https://ollama.com/v1");
		expect(spec.model).toBe("gemma4:31b");
	});

	test("keeps plain `ollama` pointed at localhost", () => {
		const spec = LLMResolver.parseSpec("ollama/llama3.2");
		expect(spec.provider).toBe("local");
		expect(spec.endpoint).toBe("http://localhost:11434/v1");
	});

	test("bare `ollama-cloud` falls back to a sensible default model", () => {
		const spec = LLMResolver.parseSpec("ollama-cloud");
		expect(spec.endpoint).toBe("https://ollama.com/v1");
		expect(spec.model).toBe("gemma4:31b");
	});

	test("preserves model names containing slashes", () => {
		const spec = LLMResolver.parseSpec("ollama-cloud/library/qwen3.5:397b");
		expect(spec.model).toBe("library/qwen3.5:397b");
		expect(spec.endpoint).toBe("https://ollama.com/v1");
	});

	test("cloud and local specs do not collide", () => {
		const cloud = LLMResolver.parseSpec("ollama-cloud/gemma4:31b");
		const local = LLMResolver.parseSpec("ollama/gemma4:31b");
		expect(cloud.endpoint).not.toBe(local.endpoint);
		expect(cloud.model).toBe(local.model);
	});
});
