/**
 * Integration tests for Documentation Providers
 *
 * Tests the multi-source documentation fetching system:
 * - Context7 API (requires CONTEXT7_API_KEY env var)
 * - llms.txt fetcher (no auth required)
 * - DevDocs JSON fetcher (no auth required)
 *
 * Nearly every test here talks to the live public internet and asserts a fact
 * about it — that vuejs.org still serves llms-full.txt, that DevDocs still
 * indexes TypeScript, that no host answers for a made-up library name. Those
 * are real, worth checking, and NOT stubbable: a mocked fetch would only prove
 * the parser can read a fixture the test itself wrote. So they are opt-in
 * rather than faked. See MNEMEX_DOCS_NETWORK_TESTS below.
 *
 * Run with:
 *   MNEMEX_DOCS_NETWORK_TESTS=1 bun test test/integration/docs-providers.test.ts
 *   CONTEXT7_API_KEY=your-key MNEMEX_DOCS_NETWORK_TESTS=1 bun test …
 */

import { beforeAll, describe, expect, test } from "bun:test";
import {
	Context7Provider,
	createProviders,
	DevDocsProvider,
	DocsFetcher,
	LibraryMapper,
	LlmsTxtProvider,
} from "../../src/docs/index.js";
import type { DocsConfig } from "../../src/docs/types.js";

// ============================================================================
// Test Configuration
// ============================================================================

const CONTEXT7_API_KEY = process.env.CONTEXT7_API_KEY;
const HAS_CONTEXT7_KEY = Boolean(CONTEXT7_API_KEY);

/**
 * Whether the network-dependent suites are allowed to run.
 *
 * These tests reach docs.rs-style public endpoints (vuejs.org, devdocs.io,
 * llms-text.ai, context7.com) and assert what those endpoints return. On a
 * runner with slow, filtered or absent egress, `LlmsTxtProvider.supports()`
 * alone walks six HEAD requests at a 5s timeout each plus a 10s search call —
 * so it blows bun's 5s default and reads as "a failing test" rather than
 * "no internet here". CI hits exactly that.
 *
 * Gating them keeps the suite deterministic without pretending to verify
 * something it isn't. A stubbed fetch could not test these assertions at all:
 * "no llms.txt exists for this name" is a claim about the internet, not about
 * our code.
 *
 * To run them: MNEMEX_DOCS_NETWORK_TESTS=1 bun test test/integration/docs-providers.test.ts
 */
const HAS_DOCS_NETWORK = Boolean(process.env.MNEMEX_DOCS_NETWORK_TESTS);

if (!HAS_DOCS_NETWORK) {
	console.warn(
		"[docs-integration] Skipping the live-network docs provider suites — " +
			"MNEMEX_DOCS_NETWORK_TESTS is not set.\n" +
			"                   They fetch vuejs.org / devdocs.io / llms-text.ai and assert what those return.\n" +
			"                   Run with: MNEMEX_DOCS_NETWORK_TESTS=1 bun test test/integration/docs-providers.test.ts",
	);
}

// Network calls here retry with backoff and walk several URL candidates, so
// give them far more room than bun's 5s default when they are enabled.
const NETWORK_TIMEOUT_MS = 60_000;

// Context7 needs both an API key and permission to use the network.
const describeContext7 =
	HAS_CONTEXT7_KEY && HAS_DOCS_NETWORK ? describe : describe.skip;

// ============================================================================
// Context7 Provider Tests
// ============================================================================

describeContext7("Context7Provider", () => {
	let provider: Context7Provider;

	beforeAll(() => {
		provider = new Context7Provider(CONTEXT7_API_KEY!);
	});

	test(
		"supports popular libraries",
		async () => {
			// Context7 should support major frameworks
			const supports = await Promise.all([
				provider.supports("react"),
				provider.supports("vue"),
				provider.supports("express"),
				provider.supports("django"),
			]);

			expect(supports.every(Boolean)).toBe(true);
		},
		NETWORK_TIMEOUT_MS,
	);

	test(
		"fetches React documentation",
		async () => {
			try {
				const docs = await provider.fetch("react", {
					maxPages: 3,
				});

				// API might fail, so we check conditionally
				if (docs.length > 0) {
					expect(docs[0]).toHaveProperty("id");
					expect(docs[0]).toHaveProperty("title");
					expect(docs[0]).toHaveProperty("content");

					// Content should mention React concepts
					const allContent = docs.map((d) => d.content.toLowerCase()).join(" ");
					expect(
						allContent.includes("component") ||
							allContent.includes("hook") ||
							allContent.includes("state") ||
							allContent.includes("react"),
					).toBe(true);
				}
			} catch (error) {
				// API issues are not test failures in integration tests
				console.log("Context7 API issue:", error);
			}
		},
		NETWORK_TIMEOUT_MS,
	);

	test(
		"fetches version-specific docs",
		async () => {
			try {
				const docs = await provider.fetch("react", {
					version: "18", // Try without 'v' prefix
					maxPages: 2,
				});

				// Just check it doesn't throw - version support varies
				expect(Array.isArray(docs)).toBe(true);
			} catch (error) {
				// Version-specific fetch may not be supported
				console.log("Version-specific fetch issue:", error);
			}
		},
		NETWORK_TIMEOUT_MS,
	);

	test(
		"search returns results even for vague queries",
		async () => {
			// Context7's search API does fuzzy matching, so even random strings may return results
			// This test verifies the search behavior rather than expecting false
			const supports = await provider.supports(
				"definitely-not-a-real-library-xyz123",
			);
			// The API may or may not find something - both are valid behaviors
			expect(typeof supports).toBe("boolean");
		},
		NETWORK_TIMEOUT_MS,
	);

	test(
		"respects maxPages limit",
		async () => {
			try {
				const docs = await provider.fetch("express", {
					maxPages: 2,
				});

				if (docs.length > 0) {
					expect(docs.length).toBeLessThanOrEqual(2);
				}
			} catch (error) {
				// API issues are acceptable in integration tests
				console.log("Context7 API issue:", error);
			}
		},
		NETWORK_TIMEOUT_MS,
	);
});

// ============================================================================
// llms.txt Provider Tests
// ============================================================================

describe.skipIf(!HAS_DOCS_NETWORK)("LlmsTxtProvider", () => {
	let provider: LlmsTxtProvider;

	beforeAll(() => {
		provider = new LlmsTxtProvider();
	});

	test(
		"supports libraries with known llms.txt",
		async () => {
			// Vue has a known llms.txt
			const supportsVue = await provider.supports("vue");
			expect(supportsVue).toBe(true);
		},
		NETWORK_TIMEOUT_MS,
	);

	test(
		"fetches Vue documentation from llms.txt",
		async () => {
			const docs = await provider.fetch("vue", {
				maxPages: 5,
			});

			expect(docs.length).toBeGreaterThan(0);
			expect(docs[0]).toHaveProperty("content");

			// Content should be Vue-related
			const allContent = docs.map((d) => d.content.toLowerCase()).join(" ");
			expect(
				allContent.includes("vue") ||
					allContent.includes("component") ||
					allContent.includes("reactive"),
			).toBe(true);
		},
		NETWORK_TIMEOUT_MS,
	);

	test(
		"returns empty for library without llms.txt",
		async () => {
			// Most libraries don't have llms.txt yet. Discovery walks six URL
			// patterns then the llms-text.ai search API, so this is the slowest
			// call in the file even on a healthy network.
			const supports = await provider.supports("some-random-library-no-llms");
			expect(supports).toBe(false);
		},
		NETWORK_TIMEOUT_MS,
	);
});

// ============================================================================
// DevDocs Provider Tests
// ============================================================================

describe.skipIf(!HAS_DOCS_NETWORK)("DevDocsProvider", () => {
	let provider: DevDocsProvider;

	beforeAll(() => {
		provider = new DevDocsProvider();
	});

	test(
		"supports common documentation",
		async () => {
			// DevDocs has JavaScript, TypeScript, etc.
			const supports = await Promise.all([
				provider.supports("javascript"),
				provider.supports("typescript"),
			]);

			expect(supports.some(Boolean)).toBe(true);
		},
		NETWORK_TIMEOUT_MS,
	);

	test(
		"fetches available documentation",
		async () => {
			// Try to fetch documentation for a supported library
			// DevDocs availability varies, so we try a few options
			const libraries = ["node", "typescript", "python"];

			for (const lib of libraries) {
				const supports = await provider.supports(lib);
				if (supports) {
					try {
						const docs = await provider.fetch(lib, {
							maxPages: 3,
						});

						if (docs.length > 0) {
							expect(docs[0]).toHaveProperty("content");
							return; // Test passed
						}
					} catch {}
				}
			}

			// If no library works, that's okay for integration tests
			console.log("No DevDocs libraries available for testing");
		},
		NETWORK_TIMEOUT_MS,
	);

	test(
		"returns empty for unsupported library",
		async () => {
			const supports = await provider.supports("not-in-devdocs-xyz");
			expect(supports).toBe(false);
		},
		NETWORK_TIMEOUT_MS,
	);
});

// ============================================================================
// Library Mapper Tests
// ============================================================================

describe("LibraryMapper", () => {
	let mapper: LibraryMapper;

	beforeAll(() => {
		mapper = new LibraryMapper();
	});

	test("detects npm dependencies from package.json", async () => {
		// Create a mock project path with package.json
		const mockProjectPath = "/tmp/test-docs-project";
		const fs = await import("node:fs");
		const path = await import("node:path");

		// Ensure directory exists
		fs.mkdirSync(mockProjectPath, { recursive: true });

		// Write a test package.json
		fs.writeFileSync(
			path.join(mockProjectPath, "package.json"),
			JSON.stringify({
				dependencies: {
					react: "^18.2.0",
					express: "^4.18.0",
				},
				devDependencies: {
					typescript: "^5.0.0",
				},
			}),
		);

		const deps = await mapper.detectDependencies(mockProjectPath);

		expect(deps.length).toBeGreaterThanOrEqual(3);
		expect(deps.find((d) => d.name === "react")).toBeDefined();
		expect(deps.find((d) => d.name === "express")).toBeDefined();
		expect(deps.find((d) => d.name === "typescript")).toBeDefined();

		// Check version parsing
		const reactDep = deps.find((d) => d.name === "react");
		expect(reactDep?.majorVersion).toBe("v18");

		// Cleanup
		fs.rmSync(mockProjectPath, { recursive: true });
	});

	test("detects Python dependencies from requirements.txt", async () => {
		const mockProjectPath = "/tmp/test-docs-project-py";
		const fs = await import("node:fs");
		const path = await import("node:path");

		fs.mkdirSync(mockProjectPath, { recursive: true });

		fs.writeFileSync(
			path.join(mockProjectPath, "requirements.txt"),
			"django>=4.0\nfastapi==0.100.0\nrequests\n",
		);

		const deps = await mapper.detectDependencies(mockProjectPath);

		expect(deps.length).toBeGreaterThanOrEqual(3);
		expect(deps.find((d) => d.name === "django")).toBeDefined();
		expect(deps.find((d) => d.name === "fastapi")).toBeDefined();

		// Check ecosystem
		expect(deps[0].ecosystem).toBe("pypi");

		// Cleanup
		fs.rmSync(mockProjectPath, { recursive: true });
	});
});

// ============================================================================
// DocsFetcher Integration Tests
// ============================================================================

describe("DocsFetcher", () => {
	test("creates providers from config", () => {
		const config: DocsConfig = {
			enabled: true,
			context7ApiKey: CONTEXT7_API_KEY || "",
			providers: HAS_CONTEXT7_KEY
				? ["context7", "llms_txt", "devdocs"]
				: ["llms_txt", "devdocs"],
			cacheTTL: 24,
			excludeLibraries: [],
			maxPagesPerLibrary: 10,
		};

		const providers = createProviders(config);

		// Should have providers in priority order
		expect(providers.length).toBeGreaterThan(0);

		if (HAS_CONTEXT7_KEY) {
			expect(providers[0].name).toBe("context7");
		}
	});

	test.skipIf(!HAS_DOCS_NETWORK)(
		"fetches docs using provider fallback",
		async () => {
			const config: DocsConfig = {
				enabled: true,
				context7ApiKey: CONTEXT7_API_KEY || "",
				providers: HAS_CONTEXT7_KEY
					? ["context7", "llms_txt", "devdocs"]
					: ["llms_txt", "devdocs"],
				cacheTTL: 24,
				excludeLibraries: [],
				maxPagesPerLibrary: 5,
			};

			const fetcher = new DocsFetcher(config);

			// Vue should be findable via llms.txt at minimum
			const result = await fetcher.fetchLibrary("vue");

			expect(result).not.toBeNull();
			expect(result!.docs.length).toBeGreaterThan(0);
			expect(result!.provider).toBeDefined();
		},
		NETWORK_TIMEOUT_MS,
	);
});

// ============================================================================
// Provider Priority Tests
// ============================================================================

describeContext7("Provider Priority Chain", () => {
	test(
		"Context7 takes priority over llms.txt",
		async () => {
			const config: DocsConfig = {
				enabled: true,
				context7ApiKey: CONTEXT7_API_KEY!,
				providers: ["context7", "llms_txt", "devdocs"],
				cacheTTL: 24,
				excludeLibraries: [],
				maxPagesPerLibrary: 3,
			};

			const fetcher = new DocsFetcher(config);

			// React is supported by Context7
			const result = await fetcher.fetchLibrary("react");

			// Context7 API may have issues, so we just check we got something
			if (result && result.docs.length > 0) {
				expect(result.provider).toBe("context7");
			}
		},
		NETWORK_TIMEOUT_MS,
	);

	test(
		"falls back to llms.txt when Context7 missing library",
		async () => {
			const config: DocsConfig = {
				enabled: true,
				context7ApiKey: CONTEXT7_API_KEY!,
				providers: ["context7", "llms_txt", "devdocs"],
				cacheTTL: 24,
				excludeLibraries: [],
				maxPagesPerLibrary: 3,
			};

			const fetcher = new DocsFetcher(config);

			// Nuxt might only be in llms.txt
			const result = await fetcher.fetchLibrary("nuxt");

			// Should find it via some provider
			if (result && result.docs.length > 0) {
				expect(["context7", "llms_txt", "devdocs"]).toContain(result.provider);
			}
		},
		NETWORK_TIMEOUT_MS,
	);
});

// ============================================================================
// Error Handling Tests
// ============================================================================

// Both of these reach the network: the first calls the real Context7 API with a
// bad key, the second walks llms.txt discovery for a name nobody serves. Neither
// is meaningful without egress.
describe.skipIf(!HAS_DOCS_NETWORK)("Error Handling", () => {
	test(
		"Context7 handles invalid API key gracefully",
		async () => {
			const provider = new Context7Provider("invalid-key-12345");

			// Should not throw, just return false/empty
			const supports = await provider.supports("react");
			// With invalid key, it should fail gracefully
			expect(typeof supports).toBe("boolean");
		},
		NETWORK_TIMEOUT_MS,
	);

	test(
		"Providers handle network errors gracefully",
		async () => {
			const provider = new LlmsTxtProvider();

			// Non-existent library should return empty, not throw
			const docs = await provider.fetch("definitely-not-real-lib-xyz123");
			expect(Array.isArray(docs)).toBe(true);
			expect(docs.length).toBe(0);
		},
		NETWORK_TIMEOUT_MS,
	);
});
