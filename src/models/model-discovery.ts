/**
 * OpenRouter embedding model discovery
 *
 * Discovers available embedding models from OpenRouter API,
 * with caching and filtering for free/cheap options.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import {
	CACHE_MAX_AGE_DAYS,
	OPENROUTER_MODELS_URL,
	getModelsCachePath,
} from "../config.js";
import type { EmbeddingModel } from "../types.js";

// ============================================================================
// Types
// ============================================================================

interface OpenRouterModel {
	id: string;
	name: string;
	description?: string;
	pricing?: {
		prompt?: string;
		completion?: string;
	};
	context_length?: number;
	architecture?: {
		modality?: string;
		input_modalities?: string[];
		output_modalities?: string[];
	};
	top_provider?: {
		context_length?: number;
	};
}

interface ModelsCache {
	lastUpdated: string;
	models: EmbeddingModel[];
}

// ============================================================================
// Recommended Models
// ============================================================================

/**
 * Curated list of recommended embedding models for code
 * Priority order: code-optimized, then by cost
 */
export const RECOMMENDED_MODELS: EmbeddingModel[] = [
	{
		id: "qwen/qwen3-embedding-8b",
		name: "Qwen3 Embedding 8B",
		provider: "Qwen",
		contextLength: 32768,
		dimension: 4096,
		pricePerMillion: 0.01,
		isFree: false,
	},
	{
		id: "qwen/qwen3-embedding-0.6b",
		name: "Qwen3 Embedding 0.6B",
		provider: "Qwen",
		contextLength: 32768,
		dimension: 1024,
		pricePerMillion: 0.002,
		isFree: false,
	},
	{
		id: "google/gemini-embedding-001",
		name: "Gemini Embedding 001",
		provider: "Google",
		contextLength: 20000,
		dimension: 768,
		pricePerMillion: 0.15,
		isFree: false,
	},
	{
		id: "openai/text-embedding-3-small",
		name: "Text Embedding 3 Small",
		provider: "OpenAI",
		contextLength: 8191,
		dimension: 1536,
		pricePerMillion: 0.02,
		isFree: false,
	},
	{
		id: "openai/text-embedding-3-large",
		name: "Text Embedding 3 Large",
		provider: "OpenAI",
		contextLength: 8191,
		dimension: 3072,
		pricePerMillion: 0.13,
		isFree: false,
	},
];

// ============================================================================
// Cache Management
// ============================================================================

/**
 * Check if the models cache is stale
 */
function isCacheStale(): boolean {
	const cachePath = getModelsCachePath();

	if (!existsSync(cachePath)) {
		return true;
	}

	try {
		const content = readFileSync(cachePath, "utf-8");
		const cache: ModelsCache = JSON.parse(content);

		if (!cache.lastUpdated) {
			return true;
		}

		const lastUpdated = new Date(cache.lastUpdated);
		const now = new Date();
		const ageInDays =
			(now.getTime() - lastUpdated.getTime()) / (1000 * 60 * 60 * 24);

		return ageInDays > CACHE_MAX_AGE_DAYS;
	} catch {
		return true;
	}
}

/**
 * Load models from cache
 */
function loadFromCache(): EmbeddingModel[] | null {
	const cachePath = getModelsCachePath();

	if (!existsSync(cachePath)) {
		return null;
	}

	try {
		const content = readFileSync(cachePath, "utf-8");
		const cache: ModelsCache = JSON.parse(content);
		return cache.models;
	} catch {
		return null;
	}
}

/**
 * Save models to cache
 */
function saveToCache(models: EmbeddingModel[]): void {
	const cachePath = getModelsCachePath();

	const cache: ModelsCache = {
		lastUpdated: new Date().toISOString(),
		models,
	};

	try {
		// Ensure directory exists
		const { mkdirSync } = require("node:fs");
		const { dirname } = require("node:path");
		mkdirSync(dirname(cachePath), { recursive: true });

		writeFileSync(cachePath, JSON.stringify(cache, null, 2), "utf-8");
	} catch (error) {
		console.warn("Failed to save models cache:", error);
	}
}

// ============================================================================
// API Functions
// ============================================================================

/**
 * Fetch embedding models from OpenRouter API
 */
async function fetchModelsFromAPI(): Promise<EmbeddingModel[]> {
	try {
		const response = await fetch(OPENROUTER_MODELS_URL);

		if (!response.ok) {
			throw new Error(`API returned ${response.status}`);
		}

		const data = (await response.json()) as { data: OpenRouterModel[] };
		const allModels = data.data || [];

		// Filter for embedding models
		const embeddingModels = allModels.filter((model) => {
			const outputModalities = model.architecture?.output_modalities || [];
			const modality = model.architecture?.modality || "";

			// Check if it's an embedding model
			return (
				outputModalities.includes("embedding") ||
				modality.includes("embedding") ||
				model.id.toLowerCase().includes("embed")
			);
		});

		// Transform to our format
		return embeddingModels.map((model): EmbeddingModel => {
			const promptPrice = parseFloat(model.pricing?.prompt || "0");
			const pricePerMillion = promptPrice * 1000000;

			return {
				id: model.id,
				name: model.name,
				provider: model.id.split("/")[0],
				contextLength:
					model.context_length ||
					model.top_provider?.context_length ||
					8192,
				pricePerMillion,
				isFree: pricePerMillion === 0,
			};
		});
	} catch (error) {
		console.error("Failed to fetch models from OpenRouter:", error);
		return [];
	}
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Discover available embedding models
 *
 * Returns models from cache if fresh, otherwise fetches from API
 */
export async function discoverEmbeddingModels(
	forceRefresh = false,
): Promise<EmbeddingModel[]> {
	// Check cache first
	if (!forceRefresh && !isCacheStale()) {
		const cached = loadFromCache();
		if (cached && cached.length > 0) {
			return cached;
		}
	}

	// Fetch from API
	console.error("🔄 Fetching embedding models from OpenRouter...");
	const apiModels = await fetchModelsFromAPI();

	if (apiModels.length > 0) {
		// Merge with recommended models (recommended first, then API models)
		const recommendedIds = new Set(RECOMMENDED_MODELS.map((m) => m.id));
		const uniqueApiModels = apiModels.filter((m) => !recommendedIds.has(m.id));

		const merged = [...RECOMMENDED_MODELS, ...uniqueApiModels];

		// Sort: free first, then by price
		merged.sort((a, b) => {
			if (a.isFree && !b.isFree) return -1;
			if (!a.isFree && b.isFree) return 1;
			return a.pricePerMillion - b.pricePerMillion;
		});

		// Cache the result
		saveToCache(merged);

		console.error(`✅ Found ${merged.length} embedding models`);
		return merged;
	}

	// Fall back to recommended models
	console.warn("⚠️  Using cached recommended models");
	return RECOMMENDED_MODELS;
}

/**
 * Get free embedding models only
 */
export async function getFreeEmbeddingModels(): Promise<EmbeddingModel[]> {
	const all = await discoverEmbeddingModels();
	return all.filter((m) => m.isFree);
}

/**
 * Get a specific model by ID
 */
export async function getModelById(
	modelId: string,
): Promise<EmbeddingModel | null> {
	const all = await discoverEmbeddingModels();
	return all.find((m) => m.id === modelId) || null;
}

/**
 * Search models by name or ID
 */
export async function searchModels(query: string): Promise<EmbeddingModel[]> {
	const all = await discoverEmbeddingModels();
	const lowerQuery = query.toLowerCase();

	return all.filter(
		(m) =>
			m.id.toLowerCase().includes(lowerQuery) ||
			m.name.toLowerCase().includes(lowerQuery) ||
			m.provider.toLowerCase().includes(lowerQuery),
	);
}

/**
 * Get the best free model for code embeddings
 */
export function getBestFreeModel(): EmbeddingModel | null {
	// Check if any recommended models are free
	const freeRecommended = RECOMMENDED_MODELS.filter((m) => m.isFree);
	if (freeRecommended.length > 0) {
		return freeRecommended[0];
	}

	// Otherwise return the cheapest recommended model
	const sorted = [...RECOMMENDED_MODELS].sort(
		(a, b) => a.pricePerMillion - b.pricePerMillion,
	);
	return sorted[0] || null;
}

/**
 * Format model info for display
 */
export function formatModelInfo(model: EmbeddingModel): string {
	const price = model.isFree
		? "FREE"
		: `$${model.pricePerMillion.toFixed(3)}/1M`;

	const context = model.contextLength
		? `${Math.round(model.contextLength / 1000)}K`
		: "N/A";

	return `${model.name} (${model.provider}) - ${price} - ${context} tokens`;
}
