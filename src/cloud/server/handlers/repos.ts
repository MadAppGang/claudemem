/**
 * POST /v1/repos/:orgSlug/:repoSlug/register
 * Register a repository. Idempotent — calling twice with same params succeeds.
 * Returns 409 if called with a different embeddingModel for an existing repo.
 */

import type { RequestContext } from "../router.js";
import { json } from "../router.js";

export async function register(ctx: RequestContext): Promise<Response> {
	const { orgSlug, repoSlug } = ctx.params;

	if (!orgSlug || !repoSlug) {
		ctx.metrics.errorCode = "missing_param";
		return json({ error: "missing_param" }, 400);
	}

	let body: Record<string, unknown>;
	try {
		body = (await ctx.req.json()) as Record<string, unknown>;
	} catch {
		ctx.metrics.errorCode = "invalid_json";
		return json({ error: "invalid_json" }, 400);
	}

	const embeddingModel =
		typeof body.embeddingModel === "string"
			? body.embeddingModel
			: "synthetic-8d";
	const embeddingDim =
		typeof body.embeddingDim === "number" ? body.embeddingDim : 8;

	if (!Number.isInteger(embeddingDim) || embeddingDim <= 0) {
		ctx.metrics.orgSlug = orgSlug;
		ctx.metrics.repoSlug = repoSlug;
		ctx.metrics.errorCode = "invalid_field";
		return json({ error: "invalid_field", field: "embeddingDim" }, 400);
	}

	// Auto-create org if it doesn't exist (no auth = no pre-seeding)
	const orgs = await ctx.sql<{ id: number }[]>`
		INSERT INTO orgs (slug)
		VALUES (${orgSlug})
		ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
		RETURNING id
	`;
	const orgId = orgs[0]!.id;

	// Try to insert repo (ON CONFLICT DO NOTHING for idempotency)
	const inserted = await ctx.sql<
		{ id: number; embedding_model: string; embedding_dim: number }[]
	>`
		INSERT INTO repos (org_id, slug, embedding_model, embedding_dim)
		VALUES (${orgId}, ${repoSlug}, ${embeddingModel}, ${embeddingDim})
		ON CONFLICT (org_id, slug) DO NOTHING
		RETURNING id, embedding_model, embedding_dim
	`;

	let repoId: number;
	let existingModel: string;
	let existingDim: number;

	if (inserted.length > 0) {
		repoId = inserted[0]!.id;
		existingModel = inserted[0]!.embedding_model;
		existingDim = inserted[0]!.embedding_dim;
	} else {
		// Already exists — fetch to check for conflicts
		const existing = await ctx.sql<
			{ id: number; embedding_model: string; embedding_dim: number }[]
		>`
			SELECT id, embedding_model, embedding_dim
			FROM repos
			WHERE org_id = ${orgId} AND slug = ${repoSlug}
			LIMIT 1
		`;

		if (existing.length === 0) {
			ctx.metrics.orgSlug = orgSlug;
			ctx.metrics.repoSlug = repoSlug;
			ctx.metrics.errorCode = "internal_error";
			return json({ error: "internal_error" }, 500);
		}

		repoId = existing[0]!.id;
		existingModel = existing[0]!.embedding_model;
		existingDim = existing[0]!.embedding_dim;

		if (existingModel !== embeddingModel) {
			ctx.metrics.orgSlug = orgSlug;
			ctx.metrics.repoSlug = repoSlug;
			ctx.metrics.errorCode = "embedding_model_mismatch";
			return json(
				{
					error: "embedding_model_mismatch",
					existing: existingModel,
					requested: embeddingModel,
				},
				409,
			);
		}
		if (existingDim !== embeddingDim) {
			ctx.metrics.orgSlug = orgSlug;
			ctx.metrics.repoSlug = repoSlug;
			ctx.metrics.errorCode = "embedding_dim_mismatch";
			return json(
				{
					error: "embedding_dim_mismatch",
					existing: existingDim,
					requested: embeddingDim,
				},
				409,
			);
		}
	}

	ctx.metrics.orgSlug = orgSlug;
	ctx.metrics.repoSlug = repoSlug;
	return json({
		ok: true,
		created: inserted.length > 0,
		repoId,
		repoSlug,
		orgSlug,
		embeddingModel: existingModel ?? embeddingModel,
		embeddingDim: existingDim ?? embeddingDim,
	});
}
