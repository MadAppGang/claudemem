/**
 * Federated Learning Module - Opt-in pattern sharing.
 *
 * This module provides:
 * - PatternHasher: Anonymize patterns for privacy-preserving sharing
 * - SyncCoordinator: Coordinate pattern exchange with peers
 *
 * Key privacy features:
 * - Differential privacy (Laplace noise)
 * - K-anonymity (minimum count threshold)
 * - Structural hashing (match patterns without revealing details)
 * - Opt-in only (disabled by default)
 *
 * Usage:
 * ```typescript
 * import {
 *   createPatternHasher,
 *   createSyncCoordinator
 * } from "./learning/federated/index.js";
 *
 * // Create components
 * const hasher = createPatternHasher({
 *   salt: "my-unique-installation-id",
 *   epsilon: 1.0, // Differential privacy
 *   minCount: 5   // K-anonymity
 * });
 *
 * const coordinator = createSyncCoordinator(hasher, {
 *   enabled: true // Opt-in
 * });
 *
 * // Prepare patterns for sharing
 * const packet = coordinator.prepareForSync(localPatterns);
 *
 * // Receive patterns from peer
 * const result = coordinator.receivePatterns(peerPacket);
 *
 * // Get merged patterns for local use
 * const merged = coordinator.getMergedPatterns();
 * ```
 */

// Pattern Hasher
export {
	type AnonymizedPatternData,
	createPatternHasher,
	DEFAULT_HASHER_CONFIG,
	type HashedPattern,
	type HashingResult,
	PatternHasher,
	type PatternHasherConfig,
	type PrivacyReport,
} from "./pattern-hasher.js";

// Sync Coordinator
export {
	type AggregatedPatternData,
	createSyncCoordinator,
	DEFAULT_SYNC_CONFIG,
	type MergedPattern,
	SyncCoordinator,
	type SyncCoordinatorConfig,
	type SyncMetadata,
	type SyncPacket,
	type SyncPeer,
	type SyncResult,
} from "./sync-coordinator.js";
