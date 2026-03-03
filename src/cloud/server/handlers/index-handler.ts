/**
 * POST /v1/index
 * Upload chunk index for a commit. Handles thin mode (with vectors) and
 * smart mode (text only). Inherits unchanged files from parent commits.
 */

import type { UploadChunk, UploadIndexRequest } from "../../types.js";
import type { Sql } from "../db.js";
import type { RequestContext } from "../router.js";
import { json } from "../router.js";

export async function uploadIndex(ctx: RequestContext): Promise<Response> {
	let body: UploadIndexRequest;
	try {
		body = (await ctx.req.json()) as UploadIndexRequest;
	} catch {
		ctx.metrics.errorCode = "invalid_json";
		return json({ error: "invalid_json" }, 400);
	}

	const {
		orgSlug,
		repoSlug,
		commitSha,
		parentShas,
		chunks,
		deletedFiles = [],
		mode,
		enrichmentDocs = [],
	} = body;

	// Validate required fields
	if (!orgSlug || !repoSlug || !commitSha || !mode) {
		ctx.metrics.errorCode = "missing_field";
		return json({ error: "missing_field" }, 400);
	}

	if (!/^[0-9a-f]{40}$/i.test(commitSha)) {
		ctx.metrics.orgSlug = orgSlug;
		ctx.metrics.repoSlug = repoSlug;
		ctx.metrics.errorCode = "invalid_field";
		return json({ error: "invalid_field", field: "commitSha" }, 422);
	}

	if (mode !== "thin" && mode !== "smart") {
		ctx.metrics.orgSlug = orgSlug;
		ctx.metrics.repoSlug = repoSlug;
		ctx.metrics.errorCode = "invalid_field";
		return json({ error: "invalid_field", field: "mode" }, 422);
	}

	// Run everything in a transaction
	let result: {
		commitId: number;
		status: string;
		newChunks: number;
		deduplicatedChunks: number;
	};

	try {
		// TransactionSql from postgres is Omit<Sql, ...> which loses call signatures
		// in TypeScript. Cast to Sql to use tagged template literals.
		result = await ctx.sql.begin(
			async (
				txRaw: unknown,
			): Promise<{
				commitId: number;
				status: string;
				newChunks: number;
				deduplicatedChunks: number;
			}> => {
				const sql = txRaw as Sql;
				return runTransaction(
					sql,
					orgSlug,
					repoSlug,
					commitSha,
					parentShas,
					chunks,
					deletedFiles,
					mode,
					enrichmentDocs,
				);
			},
		);
	} catch (err) {
		const e = err as {
			httpStatus?: number;
			errorCode?: string;
			expected?: number;
			received?: number;
			message?: string;
		};
		if (e.httpStatus) {
			ctx.metrics.orgSlug = orgSlug;
			ctx.metrics.repoSlug = repoSlug;
			ctx.metrics.commitSha = commitSha;
			ctx.metrics.mode = mode;
			ctx.metrics.errorCode = e.errorCode ?? "error";
			return json(
				{
					error: e.errorCode ?? "error",
					expected: e.expected,
					received: e.received,
					message: e.message,
				},
				e.httpStatus,
			);
		}
		console.error("[index-handler] Transaction error:", err);
		const message = err instanceof Error ? err.message : String(err);
		ctx.metrics.orgSlug = orgSlug;
		ctx.metrics.repoSlug = repoSlug;
		ctx.metrics.commitSha = commitSha;
		ctx.metrics.errorCode = "internal_error";
		return json({ error: "internal_error", message }, 500);
	}

	// Count total files after commit for inherited count
	const inheritedResult = await ctx.sql<{ count: string }[]>`
		SELECT COUNT(*) AS count
		FROM commit_files
		WHERE commit_id = ${result.commitId}
	`;
	const totalFiles = Number.parseInt(inheritedResult[0]?.count ?? "0", 10);
	const changedFileCount = new Set(chunks.map((c) => c.filePath)).size;
	const inheritedFiles = Math.max(0, totalFiles - changedFileCount);

	const responseBody: Record<string, unknown> = {
		ok: true,
		commitSha,
		status: result.status,
		chunksAdded: result.newChunks,
		chunksDeduplicated: result.deduplicatedChunks,
		chunksStored: result.newChunks,
		chunksDeduped: result.deduplicatedChunks,
		inheritedFiles,
	};

	if (mode === "smart") {
		const estimatedReadyAt = new Date(
			Date.now() + result.newChunks * 50,
		).toISOString();
		responseBody.pendingChunks = result.newChunks;
		responseBody.estimatedReadyAt = estimatedReadyAt;
	}

	// Telemetry for the index upload
	ctx.metrics.orgSlug = orgSlug;
	ctx.metrics.repoSlug = repoSlug;
	ctx.metrics.commitSha = commitSha;
	ctx.metrics.mode = mode;
	ctx.metrics.chunksTotal = chunks.length;
	ctx.metrics.chunksNew = result.newChunks;
	ctx.metrics.chunksDeduped = result.deduplicatedChunks;
	ctx.metrics.filesChanged = changedFileCount;
	ctx.metrics.filesInherited = inheritedFiles;

	return json(responseBody, 202);
}

// ============================================================================
// Transaction implementation
// ============================================================================

async function runTransaction(
	sql: Sql,
	orgSlug: string,
	repoSlug: string,
	commitSha: string,
	parentShas: string[],
	chunks: UploadChunk[],
	deletedFiles: string[],
	mode: "thin" | "smart",
	enrichmentDocs: import("../../types.js").CloudEnrichmentDoc[],
): Promise<{
	commitId: number;
	status: string;
	newChunks: number;
	deduplicatedChunks: number;
}> {
	// Step 1 — resolve repo
	const repos = await sql<{ repo_id: number; embedding_dim: number }[]>`
		SELECT r.id AS repo_id, r.embedding_dim
		FROM repos r
		JOIN orgs o ON r.org_id = o.id
		WHERE o.slug = ${orgSlug} AND r.slug = ${repoSlug}
		LIMIT 1
	`;

	if (repos.length === 0) {
		throw Object.assign(new Error("repo_not_found"), {
			httpStatus: 404,
			errorCode: "repo_not_found",
		});
	}

	const { repo_id: repoId, embedding_dim: embeddingDim } = repos[0]!;

	// Validate dimensions for thin mode
	if (mode === "thin") {
		for (const chunk of chunks) {
			if (chunk.vector && chunk.vector.length !== embeddingDim) {
				throw Object.assign(
					new Error(
						`Dimension mismatch: expected ${embeddingDim}, got ${chunk.vector.length}`,
					),
					{
						httpStatus: 422,
						errorCode: "dimension_mismatch",
						expected: embeddingDim,
						received: chunk.vector.length,
					},
				);
			}
		}
	}

	// Step 2 — advisory lock (idempotency guard)
	await sql`SELECT pg_advisory_xact_lock(hashtext(${`${String(repoId)}:${commitSha}`}))`;

	// Step 3 — upsert commit record
	const insertedCommits = await sql<{ id: number; status: string }[]>`
		INSERT INTO commits (repo_id, sha, parent_shas, status)
		VALUES (${repoId}, ${commitSha}, ${parentShas}, 'pending')
		ON CONFLICT (repo_id, sha) DO NOTHING
		RETURNING id, status
	`;

	let commitId: number;
	let commitStatus: string;

	if (insertedCommits.length > 0) {
		commitId = insertedCommits[0]?.id;
		commitStatus = insertedCommits[0]?.status;
	} else {
		// Already exists
		const existing = await sql<{ id: number; status: string }[]>`
			SELECT id, status FROM commits
			WHERE repo_id = ${repoId} AND sha = ${commitSha}
			LIMIT 1
		`;
		commitId = existing[0]?.id;
		commitStatus = existing[0]?.status;
	}

	// If already ready, return early (idempotent)
	if (commitStatus === "ready") {
		return {
			commitId,
			status: "ready",
			newChunks: 0,
			deduplicatedChunks: 0,
		};
	}

	// Step 4 — insert chunk metadata (content-addressed)
	let newChunks = 0;
	let deduplicatedChunks = 0;

	if (chunks.length > 0) {
		for (const c of chunks) {
			const insertResult = await sql<{ content_hash: string }[]>`
				INSERT INTO chunks (
					content_hash, file_path, start_line, end_line,
					name, kind, chunk_type, language, text
				)
				VALUES (
					${c.contentHash},
					${c.filePath},
					${c.startLine},
					${c.endLine},
					${c.name ?? null},
					${c.chunkType},
					${c.chunkType},
					${c.language},
					${mode === "smart" ? (c.text ?? null) : null}
				)
				ON CONFLICT (content_hash) DO NOTHING
				RETURNING content_hash
			`;
			if (insertResult.length > 0) {
				newChunks++;
			} else {
				deduplicatedChunks++;
			}
		}

		// Step 5 — store vectors (thin mode)
		if (mode === "thin") {
			for (const chunk of chunks) {
				if (chunk.vector && chunk.vector.length > 0) {
					const vecStr = `[${chunk.vector.join(",")}]`;
					await sql`
						UPDATE chunks
						SET vector = ${vecStr}::vector
						WHERE content_hash = ${chunk.contentHash} AND vector IS NULL
					`;
				}
			}
		}
	}

	// Step 6 — insert commit_files for changed files (group by filePath)
	const fileMap = new Map<
		string,
		{ fileHash: string; chunkHashes: string[] }
	>();
	for (const chunk of chunks) {
		const existing = fileMap.get(chunk.filePath);
		if (existing) {
			existing.chunkHashes.push(chunk.contentHash);
		} else {
			fileMap.set(chunk.filePath, {
				fileHash: "",
				chunkHashes: [chunk.contentHash],
			});
		}
	}

	for (const [filePath, fileData] of fileMap) {
		await sql`
			INSERT INTO commit_files (commit_id, file_path, file_hash, chunk_hashes)
			VALUES (
				${commitId},
				${filePath},
				${fileData.fileHash},
				${fileData.chunkHashes}
			)
			ON CONFLICT (commit_id, file_path) DO UPDATE
				SET file_hash = EXCLUDED.file_hash,
					chunk_hashes = EXCLUDED.chunk_hashes
		`;
	}

	// Step 7 — inherit unchanged files from parent commits
	const changedAndDeletedPaths = [...fileMap.keys(), ...deletedFiles];

	for (const parentSha of parentShas) {
		await sql`
			INSERT INTO commit_files (commit_id, file_path, file_hash, chunk_hashes)
			SELECT
				${commitId},
				cf.file_path,
				cf.file_hash,
				cf.chunk_hashes
			FROM commit_files cf
			JOIN commits parent ON cf.commit_id = parent.id
			WHERE parent.sha = ${parentSha}
			  AND parent.repo_id = ${repoId}
			  AND cf.file_path != ALL(${changedAndDeletedPaths}::text[])
			ON CONFLICT (commit_id, file_path) DO NOTHING
		`;
	}

	// Step 8 — enrichment docs (optional)
	for (const doc of enrichmentDocs) {
		await sql`
			INSERT INTO enrichment_docs (content_hash, doc_type, content, llm_model)
			VALUES (
				${doc.contentHash},
				${doc.docType},
				${doc.content},
				${doc.llmModel}
			)
			ON CONFLICT (content_hash, doc_type) DO UPDATE
				SET content = EXCLUDED.content,
					llm_model = EXCLUDED.llm_model
		`;
	}

	// Step 9 — update commit status
	const finalStatus = mode === "thin" ? "ready" : "embedding";
	if (finalStatus === "ready") {
		await sql`
			UPDATE commits
			SET status = ${finalStatus}, indexed_at = now()
			WHERE id = ${commitId}
		`;
	} else {
		await sql`
			UPDATE commits
			SET status = ${finalStatus}
			WHERE id = ${commitId}
		`;
	}

	return {
		commitId,
		status: finalStatus,
		newChunks,
		deduplicatedChunks,
	};
}
