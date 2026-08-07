/**
 * Cloud module barrel export
 *
 * Re-exports all public cloud API symbols for convenient import:
 *   import { GitDiffChangeDetector, LocalCloudStub, isCloudEnabled } from "./cloud/index.js"
 */

// Auth manager
export {
	CloudAuthManager,
	createCloudAuthManager,
	getDefaultAuthManager,
} from "./auth.js";
// Cloud configuration helpers
export {
	createCloudClientFromConfig,
	DEFAULT_CLOUD_ENDPOINT,
	getCloudEndpoint,
	getCloudMode,
	getRepoSlug,
	getTeamConfig,
	isCloudEnabled,
	parseRepoNameFromUrl,
} from "./config.js";
// Git diff change detector
export {
	createGitDiffChangeDetector,
	GitDiffChangeDetector,
} from "./git-diff.js";
export type { GraphSyncOptions, GraphSyncResult } from "./graph-sync.js";
// Graph sync
export {
	createGraphSyncer,
	GraphSyncer,
} from "./graph-sync.js";
export type { CloudIndexerOptions, CloudIndexResult } from "./indexer.js";
// Cloud-aware indexer
export {
	CloudAwareIndexer,
	createCloudIndexer,
} from "./indexer.js";
export type { MergedSearchResult } from "./merger.js";
// Overlay merger
export { OverlayMerger } from "./merger.js";
export type { OverlayIndexOptions } from "./overlay.js";

// Overlay index for dirty files
export {
	createOverlayIndex,
	OverlayIndex,
} from "./overlay.js";
export type { CloudSearchOptions } from "./search.js";
// Cloud-aware search
export {
	CloudAwareSearch,
	createCloudAwareSearch,
} from "./search.js";
// Real HTTP client — smart mode (cloud computes embeddings server-side)
export {
	createSmartCloudClient,
	SmartCloudClient,
} from "./smart-client.js";
// In-memory stub for testing
export { createLocalCloudStub, LocalCloudStub } from "./stub.js";
export type { ThinCloudClientOptions } from "./thin-client.js";
// Real HTTP client — thin mode (client computes embeddings locally)
export {
	CloudApiError,
	createThinCloudClient,
	ThinCloudClient,
} from "./thin-client.js";
// Types
export type {
	ChangedFile,
	ChunkCheckResult,
	CloudCalleeResult,
	CloudCallerResult,
	CloudEnrichmentDoc,
	CloudGraphResult,
	CloudSearchRequest,
	CloudSearchResult,
	CloudSymbol,
	CloudSymbolReference,
	CommitStatus,
	DirtyFile,
	IChangeDetector,
	ICloudIndexClient,
	IOverlayIndex,
	RegisterRepoRequest,
	RegisterRepoResponse,
	TeamConfig,
	UploadChunk,
	UploadIndexRequest,
	UploadIndexResponse,
} from "./types.js";
