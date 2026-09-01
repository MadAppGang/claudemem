/**
 * REGRESSION: issue #4 — local provider endpoint missing /v1 suffix.
 *
 * `LocalEmbeddingsClient` speaks the OpenAI-compatible wire protocol and POSTs
 * to `${endpoint}/embeddings`. The `lmstudio` provider defaults to an endpoint
 * that already carries `/v1`; the `local` provider's default
 * (`http://localhost:8000`) does not, so requests went to
 * `http://localhost:8000/embeddings` instead of
 * `http://localhost:8000/v1/embeddings` and every embed failed with a 404.
 *
 * The fix normalizes at the point of consumption (the client constructor)
 * rather than in the setup wizard, so configs already saved in the broken
 * state — plus endpoints supplied by env var or hand-edited config — self-heal
 * with no user action.
 *
 * These tests never contact a live server: the pure normalizer is called
 * directly, and the wire-level tests stub `globalThis.fetch`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	LocalEmbeddingsClient,
	normalizeOpenAIEndpoint,
	OllamaEmbeddingsClient,
} from "../../../src/core/embeddings.js";

// ---------------------------------------------------------------------------
// The pure normalizer
// ---------------------------------------------------------------------------

describe("normalizeOpenAIEndpoint", () => {
	test("appends /v1 to a bare origin", () => {
		expect(normalizeOpenAIEndpoint("http://localhost:8000")).toBe(
			"http://localhost:8000/v1",
		);
		expect(normalizeOpenAIEndpoint("https://embed.example.com")).toBe(
			"https://embed.example.com/v1",
		);
	});

	test("a trailing slash yields one separator, not two", () => {
		// PR #5's `endsWith("/v1")` check produced `http://localhost:8000//v1`.
		expect(normalizeOpenAIEndpoint("http://localhost:8000/")).toBe(
			"http://localhost:8000/v1",
		);
		expect(normalizeOpenAIEndpoint("http://localhost:8000///")).toBe(
			"http://localhost:8000/v1",
		);
	});

	test("an endpoint already carrying /v1 is left alone", () => {
		expect(normalizeOpenAIEndpoint("http://localhost:1234/v1")).toBe(
			"http://localhost:1234/v1",
		);
	});

	test("strips a trailing slash from an existing /v1", () => {
		expect(normalizeOpenAIEndpoint("http://localhost:1234/v1/")).toBe(
			"http://localhost:1234/v1",
		);
	});

	test("leaves a deliberate custom path untouched", () => {
		// Gateways (LiteLLM, vLLM behind a reverse proxy) mount the
		// OpenAI-compatible routes under arbitrary prefixes. Appending /v1 to a
		// path the user deliberately typed would break a working config.
		expect(normalizeOpenAIEndpoint("http://host/openai")).toBe(
			"http://host/openai",
		);
		expect(normalizeOpenAIEndpoint("http://host/api/v2")).toBe(
			"http://host/api/v2",
		);
		expect(normalizeOpenAIEndpoint("http://host/api/v1")).toBe(
			"http://host/api/v1",
		);
		// ...including a nested path whose trailing slash is still cleaned up.
		expect(normalizeOpenAIEndpoint("http://host/openai/")).toBe(
			"http://host/openai",
		);
	});

	test("preserves path case — /V1 is neither rewritten nor doubled", () => {
		// URL paths are case-sensitive (RFC 3986), so lowercasing could break a
		// server that routes /V1. It is a non-empty path, so it is left alone.
		expect(normalizeOpenAIEndpoint("http://host/V1")).toBe("http://host/V1");
	});

	test("trims surrounding whitespace from env-var / hand-edited values", () => {
		expect(normalizeOpenAIEndpoint("  http://localhost:8000\n")).toBe(
			"http://localhost:8000/v1",
		);
	});

	test("does not invent a URL from an empty value", () => {
		expect(normalizeOpenAIEndpoint("")).toBe("");
		expect(normalizeOpenAIEndpoint("   ")).toBe("");
	});

	test("handles a host with no scheme without corrupting it", () => {
		expect(normalizeOpenAIEndpoint("localhost:8000")).toBe("localhost:8000/v1");
	});

	// -------------------------------------------------------------------------
	// Query strings and fragments
	//
	// The first cut of this function decided "does it have a path?" with
	// `/[/?#]/.test(...)`, so `?` and `#` counted as evidence of a path. A bare
	// host carrying an auth token (`http://host?token=x`) was judged to already
	// have one, `/v1` was not appended, and the client's `${endpoint}/embeddings`
	// produced `http://host?token=x/embeddings`.
	//
	// `/v1` is part of the PATH, so it has to be spliced in before the query and
	// fragment. Dropping them instead would be a worse bug than the one being
	// fixed — the token is what makes the endpoint reachable.
	// -------------------------------------------------------------------------

	test("a bare host with a query string gets /v1 on the path, keeping the query", () => {
		expect(normalizeOpenAIEndpoint("http://host?token=x")).toBe(
			"http://host/v1?token=x",
		);
	});

	test("a bare host with a fragment gets /v1 on the path, keeping the fragment", () => {
		expect(normalizeOpenAIEndpoint("http://host#frag")).toBe(
			"http://host/v1#frag",
		);
	});

	test("query and fragment together keep their order after /v1", () => {
		expect(normalizeOpenAIEndpoint("http://host?token=x#frag")).toBe(
			"http://host/v1?token=x#frag",
		);
	});

	test("a trailing slash before a query still yields one separator", () => {
		// The whole-string trailing-slash strip cannot see this slash: it is not
		// at the end of the string.
		expect(normalizeOpenAIEndpoint("http://host/?token=x")).toBe(
			"http://host/v1?token=x",
		);
	});

	test("a real path plus a query is left alone — no /v1 added", () => {
		expect(normalizeOpenAIEndpoint("http://host/openai?token=x")).toBe(
			"http://host/openai?token=x",
		);
	});

	test("an endpoint already carrying /v1 plus a query is untouched", () => {
		expect(normalizeOpenAIEndpoint("http://host/v1?token=x")).toBe(
			"http://host/v1?token=x",
		);
	});

	test("does not lowercase the host while splicing in /v1", () => {
		// `new URL()` normalizes the host to lowercase, so the decision may be
		// made with the parser but the returned string must be surgery on the
		// original — never a rebuild from the URL object.
		expect(normalizeOpenAIEndpoint("http://HOST.Example.COM?token=x")).toBe(
			"http://HOST.Example.COM/v1?token=x",
		);
	});

	test("falls back to a literal scan when the value will not parse as a URL", () => {
		// `new URL("http://[::1")` throws (unterminated IPv6 literal). The
		// fallback must not let that escape out of the client constructor: it
		// scans for a `/` after `://` instead and treats the value as pathless.
		expect(normalizeOpenAIEndpoint("http://[::1")).toBe("http://[::1/v1");
		// The scheme-less form takes the same fallback, since `new URL()` reads
		// `localhost:` as the scheme and `8000` as a path.
		expect(normalizeOpenAIEndpoint("localhost:8000?token=x")).toBe(
			"localhost:8000/v1?token=x",
		);
		expect(normalizeOpenAIEndpoint("localhost:8000/openai?token=x")).toBe(
			"localhost:8000/openai?token=x",
		);
	});
});

// ---------------------------------------------------------------------------
// fetch stub
// ---------------------------------------------------------------------------

let requestedUrls: string[] = [];
let originalFetch: typeof globalThis.fetch;

/** OpenAI-compatible embeddings payload — satisfies warmup and embedBatch. */
function openAiResponse(): Response {
	return new Response(
		JSON.stringify({ data: [{ index: 0, embedding: [0.1, 0.2, 0.3] }] }),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

/** Ollama /api/embed payload. */
function ollamaResponse(): Response {
	return new Response(JSON.stringify({ embeddings: [[0.1, 0.2, 0.3]] }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

beforeEach(() => {
	requestedUrls = [];
	originalFetch = globalThis.fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function stubFetch(makeResponse: () => Response): void {
	globalThis.fetch = (async (input: RequestInfo | URL) => {
		requestedUrls.push(
			typeof input === "string" ? input : (input as URL).toString(),
		);
		return makeResponse();
	}) as unknown as typeof globalThis.fetch;
}

// ---------------------------------------------------------------------------
// Wire-level behaviour — the actual bug
// ---------------------------------------------------------------------------

describe("LocalEmbeddingsClient request URL", () => {
	test("local provider on the default endpoint hits /v1/embeddings", async () => {
		stubFetch(openAiResponse);
		// No endpoint supplied — falls back to DEFAULT_LOCAL_ENDPOINT, which is
		// the reporter's situation in issue #4.
		const client = new LocalEmbeddingsClient({}, "local");
		await client.embed(["hello"]);

		expect(requestedUrls.length).toBeGreaterThan(0);
		for (const url of requestedUrls) {
			expect(url).toBe("http://localhost:8000/v1/embeddings");
		}
	});

	test("endpoint without /v1 gains it", async () => {
		stubFetch(openAiResponse);
		const client = new LocalEmbeddingsClient(
			{ endpoint: "http://localhost:9000" },
			"local",
		);
		await client.embed(["hello"]);

		expect(requestedUrls[0]).toBe("http://localhost:9000/v1/embeddings");
	});

	test("trailing slash does not produce a doubled separator", async () => {
		stubFetch(openAiResponse);
		const client = new LocalEmbeddingsClient(
			{ endpoint: "http://localhost:8000/" },
			"local",
		);
		await client.embed(["hello"]);

		expect(requestedUrls[0]).toBe("http://localhost:8000/v1/embeddings");
		expect(requestedUrls[0]).not.toContain("//v1");
	});

	test("lmstudio endpoint keeps exactly one /v1 (unaffected)", async () => {
		stubFetch(openAiResponse);
		const client = new LocalEmbeddingsClient(
			{ endpoint: "http://localhost:1234/v1" },
			"lmstudio",
		);
		await client.embed(["hello"]);

		expect(requestedUrls[0]).toBe("http://localhost:1234/v1/embeddings");
	});
});

describe("OllamaEmbeddingsClient request URL", () => {
	test("ollama native routes are untouched by the normalization", async () => {
		stubFetch(ollamaResponse);
		const client = new OllamaEmbeddingsClient({});
		await client.embed(["hello"]);

		expect(requestedUrls.length).toBeGreaterThan(0);
		for (const url of requestedUrls) {
			expect(url).toBe("http://localhost:11434/api/embed");
		}
	});
});
