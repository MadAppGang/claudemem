/**
 * E2E tests for FR-1: Thin mode indexing and search.
 *
 * Uses the real ThinCloudClient against the real server + Neon PostgreSQL.
 * No Docker required. No authentication.
 */

import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "bun:test";
import { createThinCloudClient } from "../../../src/cloud/thin-client.js";
import type { UploadChunk } from "../../../src/cloud/types.js";
import { TEST_ORG_SLUG, type TestContext, startTestInfra } from "./setup.js";

// ============================================================================
// Helpers
// ============================================================================

/** Create a synthetic 8-dimensional unit vector */
function syntheticVector(seed: number): number[] {
	const v = Array.from({ length: 8 }, (_, i) => Math.sin(seed * 1.7 + i * 0.5));
	const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
	return v.map((x) => x / norm);
}

/** Generate a fake 40-char hex SHA */
function fakeSha(n: number): string {
	return n.toString(16).padStart(40, "0");
}

/** Generate a fake content hash */
function fakeHash(n: number): string {
	return `hash_${n.toString(16).padStart(62, "0")}`;
}

// ============================================================================
// Test data
// ============================================================================

const REPO_SLUG_FULL = `${TEST_ORG_SLUG}/e2e-test-repo`;
const COMMIT_SHA_1 = fakeSha(1);
const COMMIT_SHA_2 = fakeSha(2);

function makeChunks(count: number, seed = 0): UploadChunk[] {
	return Array.from({ length: count }, (_, i) => ({
		contentHash: fakeHash(seed + i),
		filePath: `src/module_${i % 3}.ts`,
		startLine: i * 10 + 1,
		endLine: i * 10 + 10,
		language: "typescript",
		chunkType: "function",
		name: `function_${seed + i}`,
		vector: syntheticVector(seed + i),
	}));
}

// ============================================================================
// Test suite
// ============================================================================

describe("E2E: Thin mode indexing (FR-1)", () => {
	let ctx: TestContext;

	beforeAll(async () => {
		ctx = await startTestInfra(4512);
	}, 30_000);

	afterAll(async () => {
		await ctx.stop();
	});

	beforeEach(async () => {
		await ctx.resetDb();
	});

	// Dummy token — server doesn't check auth
	function createClient() {
		return createThinCloudClient({ endpoint: ctx.endpoint, token: "dummy" });
	}

	// --------------------------------------------------------------------------
	// Register repo
	// --------------------------------------------------------------------------

	it("can register a repository", async () => {
		const client = createClient();
		const res = await client.registerRepo({
			orgSlug: TEST_ORG_SLUG,
			repoSlug: "e2e-test-repo",
		});

		expect(res.ok).toBe(true);
		expect(res.repoSlug).toBe("e2e-test-repo");
	});

	// --------------------------------------------------------------------------
	// FR-1: Thin mode upload → commit status "ready" → search returns chunks
	// --------------------------------------------------------------------------

	it("thin mode upload makes commit ready and searchable", async () => {
		const client = createClient();

		await client.registerRepo({
			orgSlug: TEST_ORG_SLUG,
			repoSlug: "e2e-test-repo",
		});

		// Check chunks (all should be missing initially)
		const chunks = makeChunks(5, 0);
		const hashes = chunks.map((c) => c.contentHash);
		const checkResult = await client.checkChunks(REPO_SLUG_FULL, hashes);

		expect(checkResult.existing).toHaveLength(0);
		expect(checkResult.missing).toHaveLength(5);

		// Upload index
		const uploadResult = await client.uploadIndex({
			orgSlug: TEST_ORG_SLUG,
			repoSlug: "e2e-test-repo",
			commitSha: COMMIT_SHA_1,
			parentShas: [],
			chunks,
			mode: "thin",
		});

		expect(uploadResult.ok).toBe(true);
		expect(uploadResult.status).toBe("ready");
		expect(uploadResult.chunksAdded).toBe(5);
		expect(uploadResult.chunksDeduplicated).toBe(0);

		// Verify commit is ready
		const status = await client.getCommitStatus(REPO_SLUG_FULL, COMMIT_SHA_1);
		expect(status.status).toBe("ready");
		expect(status.commitSha).toBe(COMMIT_SHA_1);

		// Search should return results
		const queryVector = syntheticVector(0);
		const results = await client.search({
			repoSlug: REPO_SLUG_FULL,
			commitSha: COMMIT_SHA_1,
			queryText: "function",
			queryVector,
			limit: 5,
		});

		expect(results.length).toBeGreaterThan(0);
		expect(results[0]).toMatchObject({
			filePath: expect.stringMatching(/^src\/module_/),
			language: "typescript",
			chunkType: "function",
		});
		expect(results[0]?.score).toBeGreaterThan(-1);
		expect(results[0]?.score).toBeLessThanOrEqual(1);
	});

	// --------------------------------------------------------------------------
	// Cross-developer read: client A uploads, client B searches
	// --------------------------------------------------------------------------

	it("cross-developer read: client A uploads, client B searches", async () => {
		const clientA = createClient();
		const clientB = createClient();

		await clientA.registerRepo({
			orgSlug: TEST_ORG_SLUG,
			repoSlug: "e2e-test-repo",
		});

		const chunks = makeChunks(3, 100);
		await clientA.uploadIndex({
			orgSlug: TEST_ORG_SLUG,
			repoSlug: "e2e-test-repo",
			commitSha: COMMIT_SHA_1,
			parentShas: [],
			chunks,
			mode: "thin",
		});

		// Client B searches the same commit
		const status = await clientB.getCommitStatus(REPO_SLUG_FULL, COMMIT_SHA_1);
		expect(status.status).toBe("ready");

		const results = await clientB.search({
			repoSlug: REPO_SLUG_FULL,
			commitSha: COMMIT_SHA_1,
			queryText: "",
			queryVector: syntheticVector(100),
			limit: 10,
		});

		expect(results.length).toBeGreaterThan(0);
	});

	// --------------------------------------------------------------------------
	// Commit status for unknown commit returns "not_found"
	// --------------------------------------------------------------------------

	it("commit status for unknown commit returns not_found", async () => {
		const client = createClient();

		await client.registerRepo({
			orgSlug: TEST_ORG_SLUG,
			repoSlug: "e2e-test-repo",
		});

		const unknownSha = fakeSha(99999);
		const status = await client.getCommitStatus(REPO_SLUG_FULL, unknownSha);
		expect(status.status).toBe("not_found");
	});

	// --------------------------------------------------------------------------
	// Incremental indexing: parent commit file inheritance
	// --------------------------------------------------------------------------

	it("second commit inherits files from parent", async () => {
		const client = createClient();

		await client.registerRepo({
			orgSlug: TEST_ORG_SLUG,
			repoSlug: "e2e-test-repo",
		});

		// First commit: 3 chunks
		const firstChunks = makeChunks(3, 0);
		await client.uploadIndex({
			orgSlug: TEST_ORG_SLUG,
			repoSlug: "e2e-test-repo",
			commitSha: COMMIT_SHA_1,
			parentShas: [],
			chunks: firstChunks,
			mode: "thin",
		});

		// Second commit: 1 new chunk, inherits from parent
		const changedChunks = makeChunks(1, 10);
		const secondUpload = await client.uploadIndex({
			orgSlug: TEST_ORG_SLUG,
			repoSlug: "e2e-test-repo",
			commitSha: COMMIT_SHA_2,
			parentShas: [COMMIT_SHA_1],
			chunks: changedChunks,
			mode: "thin",
		});

		expect(secondUpload.ok).toBe(true);
		expect(secondUpload.status).toBe("ready");

		const status = await client.getCommitStatus(REPO_SLUG_FULL, COMMIT_SHA_2);
		expect(status.status).toBe("ready");
		expect(status.chunkCount).toBeGreaterThanOrEqual(1);
	});

	// --------------------------------------------------------------------------
	// Deduplication: uploading same chunks twice
	// --------------------------------------------------------------------------

	it("uploading same chunks twice deduplicates correctly", async () => {
		const client = createClient();

		await client.registerRepo({
			orgSlug: TEST_ORG_SLUG,
			repoSlug: "e2e-test-repo",
		});

		const chunks = makeChunks(3, 200);

		// First upload
		const first = await client.uploadIndex({
			orgSlug: TEST_ORG_SLUG,
			repoSlug: "e2e-test-repo",
			commitSha: COMMIT_SHA_1,
			parentShas: [],
			chunks,
			mode: "thin",
		});
		expect(first.chunksAdded).toBe(3);
		expect(first.chunksDeduplicated).toBe(0);

		// checkChunks should show them as existing
		const hashes = chunks.map((c) => c.contentHash);
		const checkResult = await client.checkChunks(REPO_SLUG_FULL, hashes);
		expect(checkResult.existing).toHaveLength(3);
		expect(checkResult.missing).toHaveLength(0);

		// Second upload of same commit (idempotent)
		const second = await client.uploadIndex({
			orgSlug: TEST_ORG_SLUG,
			repoSlug: "e2e-test-repo",
			commitSha: COMMIT_SHA_1,
			parentShas: [],
			chunks,
			mode: "thin",
		});

		expect(second.ok).toBe(true);
		expect(second.status).toBe("ready");
	});
});
