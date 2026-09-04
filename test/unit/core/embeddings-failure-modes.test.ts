/**
 * How the embeddings clients report a failure that is NOT about one chunk.
 *
 * This is the root cause of the corruption incident this workstream started
 * from. `OllamaEmbeddingsClient.embed` caught a per-text error, pushed `[]` in
 * that text's place and carried on — deliberate, so one bad file cannot lose a
 * whole index run. But a model that was never pulled fails for EVERY text, so
 * every text got `[]`:
 *
 *   - on an index run that writes a `FixedSizeList[0]` vector column, which no
 *     query can ever read (CLAUDE.md gotcha #15) — the corruption
 *     `assertVectorDimension` and `UnqueryableVectorIndexError` exist to cope
 *     with, arriving with no error at all;
 *   - on a search it produces a 0-dimension query vector, and LanceDB answers
 *     "No vector column found to match with the query vector dimension: 0",
 *     which names neither the model nor the cause.
 *
 * Verified against a live Ollama while writing these tests:
 *
 *   $ curl -i -X POST localhost:11434/api/embed \
 *       -d '{"model":"never-pulled-embed","input":"test"}'
 *   HTTP/1.1 404 Not Found
 *   {"error":"model \"never-pulled-embed\" not found, try pulling it first"}
 *
 * 404 — the same status the client used to read as "this server is too old for
 * /api/embed", which made it retry the identical question against the legacy
 * endpoint and get the identical 404. The body is the only discriminator.
 *
 * `fetch` is replaced per test and restored in afterEach; nothing here talks to
 * a real provider.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
	OllamaEmbeddingsClient,
	OpenRouterEmbeddingsClient,
} from "../../../src/core/embeddings.js";

const realFetch = globalThis.fetch;

/** Bodies Ollama actually returns, so the tests fail the way production did. */
const MODEL_NOT_FOUND_BODY = JSON.stringify({
	error: 'model "never-pulled-embed" not found, try pulling it first',
});

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

/** A valid OpenAI-shaped embedding response for `count` inputs. */
function openAiEmbeddings(count: number) {
	return {
		data: Array.from({ length: count }, (_, index) => ({
			index,
			embedding: [0.1, 0.2, 0.3],
		})),
		model: "test-model",
	};
}

let requests: string[] = [];

/**
 * Neutralize the retry backoff.
 *
 * A failing OpenRouter batch is retried 6 times with exponential delays — 31s
 * per batch, which is the right production behaviour and the wrong thing to sit
 * through in a unit test. These tests are about how a failure is CLASSIFIED,
 * not about the schedule, so the waiting is removed rather than reduced (which
 * would only make the suite slow and flaky instead of slow).
 */
function withInstantRetries<T>(client: T): T {
	(client as { sleep: (ms: number) => Promise<void> }).sleep = async () => {};
	return client;
}

beforeEach(() => {
	requests = [];
});

afterEach(() => {
	globalThis.fetch = realFetch;
});

describe("Ollama: a model that was never pulled", () => {
	beforeEach(() => {
		globalThis.fetch = (async (url: string | URL | Request) => {
			requests.push(String(url));
			// Both /api/embed and /api/embeddings answer this way — checked live.
			return new Response(MODEL_NOT_FOUND_BODY, { status: 404 });
		}) as typeof fetch;
	});

	test("throws instead of returning one empty vector per text", async () => {
		const client = withInstantRetries(
			new OllamaEmbeddingsClient({
				model: "never-pulled-embed",
				endpoint: "http://localhost:11434",
			}),
		);

		const error = await client.embed(["alpha", "beta", "gamma"]).then(
			() => null,
			(e: unknown) => e,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("never-pulled-embed");
	});

	test("does not mistake the 404 for an old server and retry on the legacy endpoint", async () => {
		// The old code flipped to /api/embeddings here, asked the same impossible
		// question, and fed the answer into the per-chunk skip.
		const client = withInstantRetries(
			new OllamaEmbeddingsClient({
				model: "never-pulled-embed",
				endpoint: "http://localhost:11434",
			}),
		);

		await client.embed(["alpha"]).catch(() => {});

		expect(requests.some((url) => url.endsWith("/api/embeddings"))).toBe(false);
	});

	test("embedOne never yields the 0-dimension query vector", async () => {
		const client = withInstantRetries(
			new OllamaEmbeddingsClient({
				model: "never-pulled-embed",
				endpoint: "http://localhost:11434",
			}),
		);

		expect(client.embedOne("query")).rejects.toBeInstanceOf(Error);
	});
});

describe("total failure is never a per-text condition", () => {
	test("every batch failing throws, even for a retryable reason", async () => {
		// A 500 is exactly the kind of error the skip behaviour is for. At a 100%
		// failure rate it stops being one: there is no good text to keep.
		globalThis.fetch = (async () =>
			new Response("upstream exploded", { status: 500 })) as typeof fetch;

		const client = withInstantRetries(
			new OpenRouterEmbeddingsClient({
				model: "test-model",
				apiKey: "test-key",
			}),
		);

		const error = await client.embed(["alpha", "beta"]).then(
			() => null,
			(e: unknown) => e,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("all 2 texts");
	}, 60_000);

	test("a PARTIAL failure still skips and warns — the deliberate behaviour", async () => {
		// MAX_BATCH_SIZE is 20, so 21 texts make two batches. The first succeeds,
		// the second does not: the run must keep the 20 good vectors.
		let call = 0;
		globalThis.fetch = (async () => {
			call++;
			if (call === 1) return jsonResponse(openAiEmbeddings(20));
			return new Response("upstream exploded", { status: 500 });
		}) as typeof fetch;

		const client = withInstantRetries(
			new OpenRouterEmbeddingsClient({
				model: "test-model",
				apiKey: "test-key",
			}),
		);

		const result = await client.embed(
			Array.from({ length: 21 }, (_, i) => `text-${i}`),
		);

		expect(result.embeddings).toHaveLength(21);
		expect(result.embeddings[0]).toEqual([0.1, 0.2, 0.3]);
		expect(result.embeddings[20]).toEqual([]);
		expect(result.warnings?.join(" ")).toContain("1/21 chunks skipped");
	}, 60_000);
});

describe("embedOne", () => {
	test("refuses an empty vector even when the provider reports success", async () => {
		// A provider that answers 200 with nothing usable is still unusable; the
		// caller would otherwise query with a zero-length vector.
		globalThis.fetch = (async () =>
			jsonResponse({
				data: [{ index: 0, embedding: [] }],
				model: "test-model",
			})) as typeof fetch;

		const client = withInstantRetries(
			new OpenRouterEmbeddingsClient({
				model: "test-model",
				apiKey: "test-key",
			}),
		);

		const error = await client.embedOne("query").then(
			() => null,
			(e: unknown) => e,
		);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("test-model");
	}, 60_000);
});
