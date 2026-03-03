/**
 * POST /v1/chunks/check
 * Check which content hashes are already stored in the cloud.
 */

import type { RequestContext } from "../router.js";
import { json } from "../router.js";

const MAX_HASHES = 2000;

export async function check(ctx: RequestContext): Promise<Response> {
	let body: Record<string, unknown>;
	try {
		body = (await ctx.req.json()) as Record<string, unknown>;
	} catch {
		ctx.metrics.errorCode = "invalid_json";
		return json({ error: "invalid_json" }, 400);
	}

	const { hashes } = body;

	if (!Array.isArray(hashes)) {
		ctx.metrics.errorCode = "invalid_field";
		return json({ error: "invalid_field", field: "hashes" }, 400);
	}

	if (hashes.length > MAX_HASHES) {
		ctx.metrics.errorCode = "too_many_hashes";
		return json({ error: "too_many_hashes", max: MAX_HASHES }, 400);
	}

	// Extract correlation header — optional, missing on older clients
	const commitSha = ctx.req.headers.get("X-ClaudeMem-Commit-SHA");
	if (commitSha) {
		ctx.metrics.commitSha = commitSha;
	}

	ctx.metrics.hashesChecked = hashes.length;

	if (hashes.length === 0) {
		ctx.metrics.hashesExisting = 0;
		ctx.metrics.hashesMissing = 0;
		return json({ existing: [], missing: [] });
	}

	// Query which hashes already exist
	const rows = await ctx.sql<{ content_hash: string }[]>`
		SELECT content_hash
		FROM chunks
		WHERE content_hash = ANY(${hashes}::text[])
	`;

	const existingSet = new Set(rows.map((r) => r.content_hash));
	const existing: string[] = [];
	const missing: string[] = [];

	for (const hash of hashes) {
		if (typeof hash === "string") {
			if (existingSet.has(hash)) {
				existing.push(hash);
			} else {
				missing.push(hash);
			}
		}
	}

	ctx.metrics.hashesExisting = existing.length;
	ctx.metrics.hashesMissing = missing.length;

	return json({ existing, missing });
}
