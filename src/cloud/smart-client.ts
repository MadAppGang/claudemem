/**
 * SmartCloudClient — uploads raw text instead of vectors
 *
 * Extends ThinCloudClient with a single override: uploadIndex sends chunk
 * text fields (not vector fields) and sets mode to "smart" so the server
 * knows it must compute embeddings itself.
 *
 * All other methods (checkChunks, getCommitStatus, waitForCommit, search, …)
 * are inherited from ThinCloudClient unchanged.
 */

import { ThinCloudClient } from "./thin-client.js";
import type { ThinCloudClientOptions } from "./thin-client.js";
import type {
	ICloudIndexClient,
	UploadIndexRequest,
	UploadIndexResponse,
} from "./types.js";

// ============================================================================
// SmartCloudClient
// ============================================================================

/**
 * Cloud client for "smart" mode: uploads chunk text and lets the cloud
 * compute embeddings server-side with its best available model.
 *
 * Use this when you want to avoid running an embeddings model locally.
 * The trade-off is a small latency window where the commit is "pending"
 * until the server finishes embedding; call waitForCommit() if you need
 * to block until the commit is searchable.
 */
export class SmartCloudClient extends ThinCloudClient {
	/**
	 * Upload an index in smart mode.
	 *
	 * Key differences from ThinCloudClient.uploadIndex:
	 *  - Forces request.mode to "smart" (overrides whatever caller set)
	 *  - Strips vector fields from chunks (server ignores them in smart mode)
	 *  - Preserves text fields — these are required for server-side embedding
	 *
	 * The response may have status "pending" while the server embeds the text.
	 * Call waitForCommit() if you need to block until the commit is ready.
	 */
	override async uploadIndex(
		request: UploadIndexRequest,
	): Promise<UploadIndexResponse> {
		const smartRequest: UploadIndexRequest = {
			...request,
			mode: "smart",
			chunks: request.chunks.map((chunk) => {
				// In smart mode: include text, omit vector (save bandwidth)
				const { vector: _vector, ...rest } = chunk;
				return rest;
			}),
		};
		return this.post<UploadIndexResponse>("/v1/index", smartRequest);
	}
}

// ============================================================================
// Factory
// ============================================================================

/**
 * Create a new SmartCloudClient.
 * Accepts the same options as ThinCloudClient.
 */
export function createSmartCloudClient(
	options: ThinCloudClientOptions,
): ICloudIndexClient {
	return new SmartCloudClient(options);
}
