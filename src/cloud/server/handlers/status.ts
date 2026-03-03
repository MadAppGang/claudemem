/**
 * GET /v1/commits/:sha/status?repo=orgSlug/repoSlug
 * Get the indexing status of a specific commit.
 */

import type { CommitStatus } from "../../types.js";
import type { RequestContext } from "../router.js";
import { json } from "../router.js";

export async function getStatus(ctx: RequestContext): Promise<Response> {
	const { sha } = ctx.params;

	if (!sha) {
		ctx.metrics.errorCode = "missing_param";
		return json({ error: "missing_param", param: "sha" }, 400);
	}

	const repoParam = ctx.query.get("repo");
	if (!repoParam) {
		ctx.metrics.errorCode = "missing_param";
		return json({ error: "missing_param", param: "repo" }, 400);
	}

	// repo is in "orgSlug/repoSlug" format
	const slashIdx = repoParam.indexOf("/");
	if (slashIdx === -1) {
		ctx.metrics.errorCode = "invalid_param";
		return json(
			{ error: "invalid_param", param: "repo", expected: "orgSlug/repoSlug" },
			400,
		);
	}

	const orgSlug = repoParam.slice(0, slashIdx);
	const repoSlug = repoParam.slice(slashIdx + 1);

	// Resolve repo
	const repos = await ctx.sql<{ repo_id: number }[]>`
		SELECT r.id AS repo_id
		FROM repos r
		JOIN orgs o ON r.org_id = o.id
		WHERE o.slug = ${orgSlug} AND r.slug = ${repoSlug}
		LIMIT 1
	`;

	if (repos.length === 0) {
		// Return not_found as a valid status (per architecture: HTTP 200 not 404)
		ctx.metrics.orgSlug = orgSlug;
		ctx.metrics.repoSlug = repoSlug;
		ctx.metrics.commitSha = sha;
		ctx.metrics.commitStatus = "not_found";
		const response: CommitStatus = {
			commitSha: sha,
			status: "not_found",
		};
		return json(response);
	}

	const repoId = repos[0]?.repo_id;

	// Get commit status
	const commits = await ctx.sql<
		{
			status: string;
			indexed_at: Date | null;
			file_count: string;
			chunk_count: string;
		}[]
	>`
		SELECT
			c.status,
			c.indexed_at,
			(SELECT COUNT(*) FROM commit_files cf WHERE cf.commit_id = c.id)::text AS file_count,
			(
				SELECT COUNT(DISTINCT h)::text
				FROM commit_files cf,
				     LATERAL UNNEST(cf.chunk_hashes) AS h
				WHERE cf.commit_id = c.id
			) AS chunk_count
		FROM commits c
		WHERE c.repo_id = ${repoId} AND c.sha = ${sha}
		LIMIT 1
	`;

	if (commits.length === 0) {
		ctx.metrics.orgSlug = orgSlug;
		ctx.metrics.repoSlug = repoSlug;
		ctx.metrics.commitSha = sha;
		ctx.metrics.commitStatus = "not_found";
		const response: CommitStatus = {
			commitSha: sha,
			status: "not_found",
		};
		return json(response);
	}

	const commit = commits[0]!;
	ctx.metrics.orgSlug = orgSlug;
	ctx.metrics.repoSlug = repoSlug;
	ctx.metrics.commitSha = sha;
	ctx.metrics.commitStatus = commit.status;

	const response: CommitStatus = {
		commitSha: sha,
		status: commit.status as CommitStatus["status"],
		indexedAt: commit.indexed_at?.toISOString(),
		chunkCount: Number.parseInt(commit.chunk_count, 10),
	};

	return json(response);
}
