/**
 * Firebase Integration for Benchmark Results
 *
 * Uploads benchmark results to Firestore for tracking and comparison.
 *
 * Firestore Schema:
 * - benchmark_runs/{runId}
 *   - metadata (project, timestamp, config)
 *   - modelScores[] (embedded for simple queries)
 *
 * - benchmark_leaderboard/{modelId}
 *   - Aggregated stats across all runs
 */

import { initializeApp, type FirebaseApp } from "firebase/app";
import {
	getFirestore,
	collection,
	doc,
	setDoc,
	getDoc,
	getDocs,
	query,
	orderBy,
	limit,
	Timestamp,
	type Firestore,
	setLogLevel,
} from "firebase/firestore";
import type { NormalizedScores } from "../types.js";

// Suppress Firebase SDK console logging (it's very noisy on errors)
setLogLevel("silent");

// ============================================================================
// Firebase Configuration
// ============================================================================

const firebaseConfig = {
	apiKey: "AIzaSyCNkRYx0x-dcjPQJSGgCqugOJ17BwOpcDQ",
	authDomain: "claudish-6da10.firebaseapp.com",
	projectId: "claudish-6da10",
	storageBucket: "claudish-6da10.firebasestorage.app",
	messagingSenderId: "1095565486978",
	appId: "1:1095565486978:web:dc3f4ad44c77a0351d3d9b",
	measurementId: "G-GCN13V7EJR",
};

// ============================================================================
// Types
// ============================================================================

export interface BenchmarkRunDocument {
	runId: string;
	timestamp: Timestamp;
	projectName: string;
	projectPath: string;

	// Codebase type (for filtering/comparison)
	codebaseType: {
		language: string;
		category: string;
		stack: string;
		label: string;
		tags: string[];
	};

	// Configuration
	generators: string[];
	judges: string[];
	sampleSize: number;

	// Results
	status: "completed" | "failed" | "partial";
	durationMs: number;
	totalCost: number;

	// Model scores (embedded for easy querying)
	modelScores: ModelScoreEntry[];

	// Metadata
	claudememVersion: string;
	machineId?: string;
}

export interface ModelScoreEntry {
	modelId: string;
	displayName: string;

	// Quality scores (0-1)
	quality: {
		retrieval: number;
		contrastive: number;
		judge: number;
		overall: number;
	};

	// Operational metrics
	operational: {
		latencyMs: number;
		cost: number;
		refinementRounds: number;
		selfEvalScore: number;
	};

	// Detailed breakdowns
	details: {
		judge: {
			pointwise: number;
			pairwise: number;
		};
		retrieval: {
			precision1: number;
			precision5: number;
			mrr: number;
		};
		selfEval?: {
			retrieval: number;
			functionSelection: number;
		};
		iterative?: {
			avgRounds: number;
			successRate: number;
		};
	};
}

export interface LeaderboardEntry {
	modelId: string;
	displayName: string;
	runCount: number;
	avgQualityScore: number;
	avgRetrievalScore: number;
	avgContrastiveScore: number;
	avgJudgeScore: number;
	bestQualityScore: number;
	lastRunTimestamp: Timestamp;
}

// ============================================================================
// Firebase Client
// ============================================================================

let app: FirebaseApp | null = null;
let db: Firestore | null = null;

/**
 * Initialize Firebase (lazy initialization)
 */
function getFirebaseDb(): Firestore {
	if (!db) {
		app = initializeApp(firebaseConfig);
		db = getFirestore(app);
	}
	return db;
}

/**
 * Upload benchmark results to Firestore
 */
export async function uploadBenchmarkResults(
	runId: string,
	projectName: string,
	projectPath: string,
	codebaseType: {
		language: string;
		category: string;
		stack: string;
		label: string;
		tags: string[];
	},
	generators: string[],
	judges: string[],
	sampleSize: number,
	durationMs: number,
	totalCost: number,
	scores: Map<string, NormalizedScores>,
	latencyByModel: Map<string, number>,
	costByModel: Map<string, number>
): Promise<{ success: boolean; docId?: string; error?: string }> {
	// Quick timeout to prevent hanging on Firebase connection issues
	const UPLOAD_TIMEOUT_MS = 10_000; // 10 seconds max

	const uploadPromise = async (): Promise<{ success: boolean; docId?: string; error?: string }> => {
		const firestore = getFirebaseDb();

		// Build model scores array
		const modelScores: ModelScoreEntry[] = [];
		for (const [modelId, score] of scores) {
			const displayName = modelId.split("/").pop() || modelId;

			// Build details object without undefined values (Firestore doesn't accept undefined)
			const details: ModelScoreEntry["details"] = {
				judge: {
					pointwise: score.judge.pointwise,
					pairwise: score.judge.pairwise,
				},
				retrieval: {
					precision1: score.retrieval.precision1,
					precision5: score.retrieval.precision5,
					mrr: score.retrieval.mrr,
				},
			};

			// Only add optional fields if they exist
			if (score.self) {
				details.selfEval = {
					retrieval: score.self.retrieval,
					functionSelection: score.self.functionSelection,
				};
			}
			if (score.iterative) {
				details.iterative = {
					avgRounds: score.iterative.avgRounds,
					successRate: score.iterative.successRate,
				};
			}

			modelScores.push({
				modelId,
				displayName,
				quality: {
					retrieval: score.retrieval.combined,
					contrastive: score.contrastive.combined,
					judge: score.judge.combined,
					overall: score.overall,
				},
				operational: {
					latencyMs: latencyByModel.get(modelId) || 0,
					cost: costByModel.get(modelId) || 0,
					refinementRounds: score.iterative?.avgRounds || 0,
					selfEvalScore: score.self?.overall || 0,
				},
				details,
			});
		}

		// Sort by overall quality score
		modelScores.sort((a, b) => b.quality.overall - a.quality.overall);

		// Create the run document
		const runDoc: BenchmarkRunDocument = {
			runId,
			timestamp: Timestamp.now(),
			projectName,
			projectPath,
			codebaseType,
			generators,
			judges,
			sampleSize,
			status: "completed",
			durationMs,
			totalCost,
			modelScores,
			claudememVersion: "0.5.0",
		};

		// Upload to Firestore
		const docRef = doc(collection(firestore, "benchmark_runs"), runId);
		await setDoc(docRef, runDoc);

		// Update leaderboard entries
		await updateLeaderboard(firestore, modelScores);

		return { success: true, docId: runId };
	};

	// Race between upload and timeout
	try {
		return await Promise.race([
			uploadPromise(),
			new Promise<{ success: boolean; error: string }>((_, reject) =>
				setTimeout(() => reject(new Error("Firebase upload timed out")), UPLOAD_TIMEOUT_MS)
			),
		]);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { success: false, error: message };
	}
}

/**
 * Update the leaderboard with new scores
 */
async function updateLeaderboard(
	firestore: Firestore,
	modelScores: ModelScoreEntry[]
): Promise<void> {
	for (const score of modelScores) {
		const leaderboardRef = doc(
			collection(firestore, "benchmark_leaderboard"),
			score.modelId.replace(/\//g, "_") // Firestore doesn't allow / in doc IDs
		);

		// Get existing entry
		const existing = await getDoc(leaderboardRef);
		const existingData = existing.data() as LeaderboardEntry | undefined;

		const newEntry: LeaderboardEntry = {
			modelId: score.modelId,
			displayName: score.displayName,
			runCount: (existingData?.runCount || 0) + 1,
			avgQualityScore: existingData
				? (existingData.avgQualityScore * existingData.runCount +
						score.quality.overall) /
					(existingData.runCount + 1)
				: score.quality.overall,
			avgRetrievalScore: existingData
				? (existingData.avgRetrievalScore * existingData.runCount +
						score.quality.retrieval) /
					(existingData.runCount + 1)
				: score.quality.retrieval,
			avgContrastiveScore: existingData
				? (existingData.avgContrastiveScore * existingData.runCount +
						score.quality.contrastive) /
					(existingData.runCount + 1)
				: score.quality.contrastive,
			avgJudgeScore: existingData
				? (existingData.avgJudgeScore * existingData.runCount +
						score.quality.judge) /
					(existingData.runCount + 1)
				: score.quality.judge,
			bestQualityScore: Math.max(
				existingData?.bestQualityScore || 0,
				score.quality.overall
			),
			lastRunTimestamp: Timestamp.now(),
		};

		await setDoc(leaderboardRef, newEntry);
	}
}

/**
 * Get the leaderboard (top models by average quality score)
 */
export async function getLeaderboard(
	topN = 20
): Promise<LeaderboardEntry[]> {
	try {
		const firestore = getFirebaseDb();
		const leaderboardRef = collection(firestore, "benchmark_leaderboard");
		const q = query(
			leaderboardRef,
			orderBy("avgQualityScore", "desc"),
			limit(topN)
		);

		const snapshot = await getDocs(q);
		return snapshot.docs.map((doc) => doc.data() as LeaderboardEntry);
	} catch (error) {
		console.error("Failed to get leaderboard:", error);
		return [];
	}
}

/**
 * Get recent benchmark runs
 */
export async function getRecentRuns(
	limitCount = 10
): Promise<BenchmarkRunDocument[]> {
	try {
		const firestore = getFirebaseDb();
		const runsRef = collection(firestore, "benchmark_runs");
		const q = query(
			runsRef,
			orderBy("timestamp", "desc"),
			limit(limitCount)
		);

		const snapshot = await getDocs(q);
		return snapshot.docs.map((doc) => doc.data() as BenchmarkRunDocument);
	} catch (error) {
		console.error("Failed to get recent runs:", error);
		return [];
	}
}

/**
 * Check if Firebase is configured and accessible
 */
export async function testFirebaseConnection(): Promise<boolean> {
	try {
		const firestore = getFirebaseDb();
		// Try to access a collection (this will fail if not configured properly)
		await getDocs(query(collection(firestore, "benchmark_runs"), limit(1)));
		return true;
	} catch {
		return false;
	}
}
