/**
 * Configuration management for claudemem
 *
 * Handles both global config (~/.claudemem/config.json) and
 * project-specific config (.claudemem/config.json)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Config, GlobalConfig, ProjectConfig } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

/** Global config directory */
export const GLOBAL_CONFIG_DIR = join(homedir(), ".claudemem");

/** Global config file path */
export const GLOBAL_CONFIG_PATH = join(GLOBAL_CONFIG_DIR, "config.json");

/** Project config directory name */
export const PROJECT_CONFIG_DIR = ".claudemem";

/** Project config file name */
export const PROJECT_CONFIG_FILE = "config.json";

/** Index database file name */
export const INDEX_DB_FILE = "index.db";

/** Vector store directory name */
export const VECTORS_DIR = "vectors";

/** Embedding models cache file */
export const MODELS_CACHE_FILE = "embedding-models.json";

/** Cache max age in days */
export const CACHE_MAX_AGE_DAYS = 2;

/** Default exclude patterns */
export const DEFAULT_EXCLUDE_PATTERNS = [
	"node_modules/**",
	".git/**",
	"dist/**",
	"build/**",
	"out/**",
	".next/**",
	".nuxt/**",
	"coverage/**",
	"__pycache__/**",
	"*.pyc",
	"venv/**",
	".venv/**",
	"target/**",
	"vendor/**",
	"*.lock",
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"bun.lockb",
	"*.min.js",
	"*.min.css",
	"*.map",
	".claudemem/**",
];

/** Default recommended embedding model */
export const DEFAULT_EMBEDDING_MODEL = "qwen/qwen3-embedding-8b";

/** OpenRouter API endpoints */
export const OPENROUTER_API_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_EMBEDDINGS_URL = `${OPENROUTER_API_URL}/embeddings`;
export const OPENROUTER_MODELS_URL = `${OPENROUTER_API_URL}/models`;
export const OPENROUTER_EMBEDDING_MODELS_URL = `${OPENROUTER_API_URL}/embeddings/models`;

/** OpenRouter request headers */
export const OPENROUTER_HEADERS = {
	"HTTP-Referer": "https://github.com/MadAppGang/claudemem",
	"X-Title": "claudemem",
};

// ============================================================================
// Environment Variables
// ============================================================================

export const ENV = {
	OPENROUTER_API_KEY: "OPENROUTER_API_KEY",
	CLAUDE_MEM_MODEL: "CLAUDE_MEM_MODEL",
} as const;

// ============================================================================
// Configuration Loading
// ============================================================================

/**
 * Load global configuration from ~/.claudemem/config.json
 */
export function loadGlobalConfig(): GlobalConfig {
	const defaultConfig: GlobalConfig = {
		excludePatterns: DEFAULT_EXCLUDE_PATTERNS,
	};

	if (!existsSync(GLOBAL_CONFIG_PATH)) {
		return defaultConfig;
	}

	try {
		const content = readFileSync(GLOBAL_CONFIG_PATH, "utf-8");
		const loaded = JSON.parse(content) as Partial<GlobalConfig>;
		return {
			...defaultConfig,
			...loaded,
			excludePatterns: [
				...DEFAULT_EXCLUDE_PATTERNS,
				...(loaded.excludePatterns || []),
			],
		};
	} catch (error) {
		console.warn("Failed to load global config:", error);
		return defaultConfig;
	}
}

/**
 * Load project configuration from .claudemem/config.json
 */
export function loadProjectConfig(projectPath: string): ProjectConfig | null {
	const configPath = join(projectPath, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILE);

	if (!existsSync(configPath)) {
		return null;
	}

	try {
		const content = readFileSync(configPath, "utf-8");
		return JSON.parse(content) as ProjectConfig;
	} catch (error) {
		console.warn("Failed to load project config:", error);
		return null;
	}
}

/**
 * Load merged configuration (global + project)
 */
export function loadConfig(projectPath: string): Config {
	const global = loadGlobalConfig();
	const project = loadProjectConfig(projectPath);

	return {
		...global,
		project: project || undefined,
	};
}

/**
 * Save global configuration
 */
export function saveGlobalConfig(config: Partial<GlobalConfig>): void {
	// Ensure directory exists
	if (!existsSync(GLOBAL_CONFIG_DIR)) {
		mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
	}

	// Merge with existing config
	const existing = loadGlobalConfig();
	const merged = { ...existing, ...config };

	writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(merged, null, 2), "utf-8");
}

/**
 * Save project configuration
 */
export function saveProjectConfig(
	projectPath: string,
	config: Partial<ProjectConfig>,
): void {
	const configDir = join(projectPath, PROJECT_CONFIG_DIR);
	const configPath = join(configDir, PROJECT_CONFIG_FILE);

	// Ensure directory exists
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true });
	}

	// Merge with existing config
	const existing = loadProjectConfig(projectPath) || {
		excludePatterns: [],
		includePatterns: [],
	};
	const merged = { ...existing, ...config };

	writeFileSync(configPath, JSON.stringify(merged, null, 2), "utf-8");
}

// ============================================================================
// Project Paths
// ============================================================================

/**
 * Get the path to the project's index database
 */
export function getIndexDbPath(projectPath: string): string {
	return join(projectPath, PROJECT_CONFIG_DIR, INDEX_DB_FILE);
}

/**
 * Get the path to the project's vector store
 */
export function getVectorStorePath(projectPath: string): string {
	return join(projectPath, PROJECT_CONFIG_DIR, VECTORS_DIR);
}

/**
 * Get the path to the global models cache
 */
export function getModelsCachePath(): string {
	return join(GLOBAL_CONFIG_DIR, MODELS_CACHE_FILE);
}

/**
 * Ensure project config directory exists
 */
export function ensureProjectDir(projectPath: string): void {
	const configDir = join(projectPath, PROJECT_CONFIG_DIR);
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true });
	}

	// Create CACHEDIR.TAG to mark as cache directory
	const cacheTagPath = join(configDir, "CACHEDIR.TAG");
	if (!existsSync(cacheTagPath)) {
		writeFileSync(
			cacheTagPath,
			"Signature: 8a477f597d28d172789f06886806bc55\n# This file marks the directory as a cache directory.\n# For more information see https://bford.info/cachedir/\n",
			"utf-8",
		);
	}
}

// ============================================================================
// API Key Management
// ============================================================================

/**
 * Get OpenRouter API key from environment or config
 */
export function getApiKey(): string | undefined {
	// First check environment variable
	const envKey = process.env[ENV.OPENROUTER_API_KEY];
	if (envKey) {
		return envKey;
	}

	// Then check global config
	const config = loadGlobalConfig();
	return config.openrouterApiKey;
}

/**
 * Check if API key is configured
 */
export function hasApiKey(): boolean {
	return !!getApiKey();
}

/**
 * Get embedding model from environment or config
 */
export function getEmbeddingModel(projectPath?: string): string {
	// First check environment variable
	const envModel = process.env[ENV.CLAUDE_MEM_MODEL];
	if (envModel) {
		return envModel;
	}

	// Then check project config
	if (projectPath) {
		const projectConfig = loadProjectConfig(projectPath);
		if (projectConfig?.model) {
			return projectConfig.model;
		}
	}

	// Then check global config
	const globalConfig = loadGlobalConfig();
	if (globalConfig.defaultModel) {
		return globalConfig.defaultModel;
	}

	// Fall back to default
	return DEFAULT_EMBEDDING_MODEL;
}
