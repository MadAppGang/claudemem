/**
 * E2E test infrastructure for the mnemex cloud server.
 *
 * Uses Neon PostgreSQL — no Docker required.
 * No authentication — simplified for testing.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import { startServer, stopServer } from "../../../src/cloud/server/index.js";

// ============================================================================
// Constants
// ============================================================================

// Read from the environment — never hardcode a real connection string in a
// committed test (it leaks the credential to git history and every fork).
export const NEON_DB_URL =
	process.env.NEON_DB_URL ?? process.env.DATABASE_URL ?? "";

/**
 * Whether a PostgreSQL instance is configured for the cloud e2e suites.
 *
 * These tests need a real database. With no URL set, `postgres("")` silently
 * falls back to localhost:5432 and every test in the suite dies on
 * ECONNREFUSED — which reads as "6 failing tests" rather than "infrastructure
 * absent". Suites gate on this and skip loudly instead.
 *
 * To run them: NEON_DB_URL=postgres://… bun test test/e2e/cloud
 */
export const HAS_CLOUD_DB = NEON_DB_URL.length > 0;

/** Print a one-time explanation of why the cloud suites were skipped. */
let cloudSkipWarned = false;
export function warnCloudDbMissing(suite: string): void {
	if (cloudSkipWarned) return;
	cloudSkipWarned = true;
	console.warn(
		`[cloud-e2e] Skipping "${suite}" and the other cloud suites — no NEON_DB_URL/DATABASE_URL set.\n` +
			"           These require a real PostgreSQL instance. Run with:\n" +
			"             NEON_DB_URL=postgres://… bun test test/e2e/cloud",
	);
}

export const TEST_ORG_SLUG = "test-org";

const PROJECT_ROOT = join(import.meta.dir, "../../..");
const SCHEMA_PATH = join(PROJECT_ROOT, "src/cloud/server/schema.sql");

// ============================================================================
// Per-file test context
// ============================================================================

export interface TestContext {
	endpoint: string;
	port: number;
	stop: () => Promise<void>;
	resetDb: () => Promise<void>;
}

/**
 * Start the full test infrastructure for a single test file.
 * Connects to Neon, runs schema, starts HTTP server.
 */
export async function startTestInfra(port?: number): Promise<TestContext> {
	// Connect to Neon and run schema
	const sql = postgres(NEON_DB_URL, { max: 5 });

	// Test connectivity
	try {
		await sql`SELECT 1`;
	} catch (err) {
		await sql.end();
		throw new Error(`Cannot connect to Neon: ${err}`);
	}

	const schema = readFileSync(SCHEMA_PATH, "utf-8");
	const statements = schema
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	for (const stmt of statements) {
		await sql.unsafe(`${stmt};`);
	}

	// Clean slate
	await sql`TRUNCATE TABLE api_key_usage, api_keys, enrichment_docs, commit_files, commits, chunks, repos, orgs RESTART IDENTITY CASCADE`;

	// Start the Bun server
	const serverPort = port ?? 4520 + Math.floor(Math.random() * 80);
	const { stop: serverStop } = await startServer({
		port: serverPort,
		databaseUrl: NEON_DB_URL,
		embeddingDim: 8,
	});

	await sleep(100);

	const endpoint = `http://localhost:${serverPort}`;

	const ctx: TestContext = {
		endpoint,
		port: serverPort,
		async stop() {
			await serverStop();
			await sql.end();
		},
		async resetDb() {
			await sql`TRUNCATE TABLE api_key_usage, api_keys, enrichment_docs, commit_files, commits, chunks, repos, orgs RESTART IDENTITY CASCADE`;
		},
	};

	return ctx;
}

/**
 * Stop all test infrastructure.
 */
export async function stopTestInfra(): Promise<void> {
	await stopServer();
}

// ============================================================================
// Helpers
// ============================================================================

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export { stopServer };
