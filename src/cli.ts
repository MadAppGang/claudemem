/**
 * claudemem CLI
 *
 * Command-line interface for code indexing and search.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import inquirerSearch from "@inquirer/search";
import { confirm, input, select } from "@inquirer/prompts";
import {
	ENV,
	getApiKey,
	hasApiKey,
	loadGlobalConfig,
	saveGlobalConfig,
} from "./config.js";
import { createIndexer } from "./core/indexer.js";
import { OpenRouterEmbeddingsClient } from "./core/embeddings.js";
import { chunkFileByPath, canChunkFile } from "./core/chunker.js";
import { createVectorStore } from "./core/store.js";
import {
	CURATED_PICKS,
	discoverEmbeddingModels,
	formatModelInfo,
	RECOMMENDED_MODELS,
} from "./models/model-discovery.js";

// ============================================================================
// Version
// ============================================================================

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJson = JSON.parse(
	readFileSync(join(__dirname, "../package.json"), "utf-8"),
);
const VERSION = packageJson.version;

// ============================================================================
// CLI Entry Point
// ============================================================================

export async function runCli(args: string[]): Promise<void> {
	// Parse command
	const command = args[0];

	// Handle global flags
	if (args.includes("--version") || args.includes("-v")) {
		console.log(`claudemem version ${VERSION}`);
		return;
	}

	if (args.includes("--help") || args.includes("-h") || !command) {
		printHelp();
		return;
	}

	// Handle --models as global flag
	if (args.includes("--models")) {
		const remainingArgs = args.filter((a) => a !== "--models");
		await handleModels(remainingArgs);
		return;
	}

	// Route to command handler
	switch (command) {
		case "index":
			await handleIndex(args.slice(1));
			break;
		case "search":
			await handleSearch(args.slice(1));
			break;
		case "status":
			await handleStatus(args.slice(1));
			break;
		case "clear":
			await handleClear(args.slice(1));
			break;
		case "init":
			await handleInit();
			break;
		case "models":
			await handleModels(args.slice(1));
			break;
		case "benchmark":
			await handleBenchmark(args.slice(1));
			break;
		default:
			// Check if it looks like a search query
			if (!command.startsWith("-")) {
				await handleSearch(args);
			} else {
				console.error(`Unknown command: ${command}`);
				console.error('Run "claudemem --help" for usage information.');
				process.exit(1);
			}
	}
}

// ============================================================================
// Command Handlers
// ============================================================================

/** Format elapsed time as mm:ss */
function formatElapsed(ms: number): string {
	const seconds = Math.floor(ms / 1000);
	const mins = Math.floor(seconds / 60);
	const secs = seconds % 60;
	return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
}

/** Animation frames for "in progress" portion */
const ANIM_FRAMES = ["▓", "▒", "░", "▒"];

/** Progress state for continuous rendering */
interface ProgressState {
	completed: number;
	total: number;
	inProgress: number;
	phase: string;
	detail: string;
}

/** Create a progress renderer with continuous timer and animation */
function createProgressRenderer() {
	const startTime = Date.now();
	let state: ProgressState = { completed: 0, total: 0, inProgress: 0, phase: "starting", detail: "scanning files..." };
	let animFrame = 0;
	let interval: ReturnType<typeof setInterval> | null = null;
	let lastPhase = "";

	function render() {
		animFrame = (animFrame + 1) % ANIM_FRAMES.length;
		const elapsed = formatElapsed(Date.now() - startTime);
		const { completed, total, inProgress, phase, detail } = state;
		const percent = total > 0 ? Math.round((completed / total) * 100) : 0;

		// Build three-state progress bar
		const width = 20;
		const filledRatio = total > 0 ? completed / total : 0;
		const inProgressRatio = total > 0 ? inProgress / total : 0;

		const filledWidth = Math.round(filledRatio * width);
		const inProgressWidth = Math.min(Math.round(inProgressRatio * width), width - filledWidth);
		const emptyWidth = width - filledWidth - inProgressWidth;

		const filled = "█".repeat(filledWidth);
		// Wave animation: each position has a different phase
		let animated = "";
		for (let i = 0; i < inProgressWidth; i++) {
			const charIndex = (animFrame + i) % ANIM_FRAMES.length;
			animated += ANIM_FRAMES[charIndex];
		}
		const empty = "░".repeat(emptyWidth);
		const bar = filled + animated + empty;

		process.stdout.write(
			`\r⏱ ${elapsed} │ ${bar} ${percent.toString().padStart(3)}% │ ${phase.padEnd(9)} │ ${detail.padEnd(35)}`
		);
	}

	return {
		start() {
			interval = setInterval(render, 100); // Update every 100ms
			// Allow the process to exit even if interval is running
			if (interval.unref) interval.unref();
		},
		update(completed: number, total: number, detail: string, inProgress = 0) {
			// Extract phase from detail (e.g., "[parsing] filename")
			const phaseMatch = detail.match(/^\[(\w+)\]/);
			const phase = phaseMatch ? phaseMatch[1] : "processing";
			const cleanDetail = detail.replace(/^\[\w+\]\s*/, "").slice(0, 35);

			// On phase change: render final state of previous phase before moving on
			if (phase !== lastPhase && lastPhase !== "") {
				// Show previous phase at 100% completion
				state = { ...state, completed: state.total, inProgress: 0 };
				render();
				process.stdout.write("\n");
			}
			lastPhase = phase;

			state = { completed, total, inProgress, phase, detail: cleanDetail };
		},
		stop() {
			if (interval) {
				clearInterval(interval);
				interval = null;
			}
		},
		/** Render final 100% state before clearing */
		finish() {
			this.stop();
			// Show final completed state
			state = { ...state, completed: state.total, inProgress: 0 };
			render();
			process.stdout.write("\n");
		},
	};
}

async function handleIndex(args: string[]): Promise<void> {
	// Parse arguments
	const force = args.includes("--force") || args.includes("-f");
	const pathArg = args.find((a) => !a.startsWith("-"));
	const projectPath = pathArg ? resolve(pathArg) : process.cwd();

	// Check for API key
	if (!hasApiKey()) {
		console.error("Error: OpenRouter API key not configured.");
		console.error("Run 'claudemem init' to set up, or set OPENROUTER_API_KEY.");
		process.exit(1);
	}

	console.log(`\nIndexing ${projectPath}...`);
	if (force) {
		console.log("(Force mode: re-indexing all files)\n");
	}

	// Create progress renderer with continuous timer and animation
	const progress = createProgressRenderer();
	progress.start();

	const indexer = createIndexer({
		projectPath,
		onProgress: (current, total, file, inProgress) => {
			progress.update(current, total, file, inProgress ?? 0);
		},
	});

	try {
		const result = await indexer.index(force);

		// Show final state and stop progress renderer
		progress.finish();

		const totalElapsed = formatElapsed(result.durationMs);
		console.log(`✅ Indexing complete in ${totalElapsed}!\n`);
		console.log(`  Files indexed:  ${result.filesIndexed}`);
		console.log(`  Chunks created: ${result.chunksCreated}`);
		console.log(`  Duration:       ${(result.durationMs / 1000).toFixed(2)}s`);
		if (result.cost !== undefined) {
			console.log(`  Cost:           $${result.cost.toFixed(6)}`);
		}

		if (result.errors.length > 0) {
			console.log(`\n⚠️  Errors (${result.errors.length}):`);
			for (const err of result.errors.slice(0, 5)) {
				console.log(`  - ${err.file}: ${err.error}`);
			}
			if (result.errors.length > 5) {
				console.log(`  ... and ${result.errors.length - 5} more`);
			}
		}
	} finally {
		progress.stop();
		await indexer.close();
	}
}

async function handleSearch(args: string[]): Promise<void> {
	// Parse arguments
	const limitIdx = args.findIndex((a) => a === "-n" || a === "--limit");
	const limit =
		limitIdx >= 0 && args[limitIdx + 1]
			? parseInt(args[limitIdx + 1], 10)
			: 10;

	const langIdx = args.findIndex((a) => a === "-l" || a === "--language");
	const language = langIdx >= 0 ? args[langIdx + 1] : undefined;

	const pathIdx = args.findIndex((a) => a === "-p" || a === "--path");
	const projectPath = pathIdx >= 0 ? resolve(args[pathIdx + 1]) : process.cwd();

	// Auto-index flags
	const noReindex = args.includes("--no-reindex");
	const autoYes = args.includes("-y") || args.includes("--yes");

	// Get query (everything that's not a flag)
	// Only add indices to flagIndices if the flag was actually found (>= 0)
	const flagIndices = new Set<number>();
	if (limitIdx >= 0) { flagIndices.add(limitIdx); flagIndices.add(limitIdx + 1); }
	if (langIdx >= 0) { flagIndices.add(langIdx); flagIndices.add(langIdx + 1); }
	if (pathIdx >= 0) { flagIndices.add(pathIdx); flagIndices.add(pathIdx + 1); }
	const queryParts = args.filter((_, i) => !flagIndices.has(i) && !args[i].startsWith("-"));
	const query = queryParts.join(" ");

	if (!query) {
		console.error("Error: No search query provided.");
		console.error('Usage: claudemem search "your query"');
		process.exit(1);
	}

	// Check for API key
	if (!hasApiKey()) {
		console.error("Error: OpenRouter API key not configured.");
		console.error("Run 'claudemem init' to set up, or set OPENROUTER_API_KEY.");
		process.exit(1);
	}

	const indexer = createIndexer({ projectPath });

	try {
		// Check if index exists
		const status = await indexer.getStatus();

		if (!status.exists) {
			// No index - prompt to create or auto-create with -y
			if (autoYes) {
				console.log("\nNo index found. Creating initial index...\n");
			} else {
				const shouldIndex = await confirm({
					message: "No index found. Create initial index now?",
					default: true,
				});

				if (!shouldIndex) {
					console.log("Search cancelled. Run 'claudemem index' to create an index.");
					return;
				}
				console.log("");
			}

			// Create initial index
			const result = await indexer.index(false);
			console.log(`✅ Indexed ${result.filesIndexed} files (${result.chunksCreated} chunks)\n`);
		} else if (!noReindex) {
			// Index exists - auto-reindex changed files
			const result = await indexer.index(false); // incremental
			if (result.filesIndexed > 0) {
				console.log(`\n🔄 Auto-indexed ${result.filesIndexed} changed file(s)\n`);
			}
		}

		console.log(`Searching for: "${query}"\n`);

		const results = await indexer.search(query, { limit, language });

		if (results.length === 0) {
			console.log("No results found.");
			console.log("Make sure the codebase is indexed: claudemem index");
			return;
		}

		console.log(`Found ${results.length} result(s):\n`);

		for (let i = 0; i < results.length; i++) {
			const r = results[i];
			const chunk = r.chunk;

			console.log(`━━━ ${i + 1}. ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} ━━━`);
			console.log(`Type: ${chunk.chunkType}${chunk.name ? ` | Name: ${chunk.name}` : ""}${chunk.parentName ? ` | Parent: ${chunk.parentName}` : ""}`);
			console.log(`Score: ${(r.score * 100).toFixed(1)}% (vector: ${(r.vectorScore * 100).toFixed(0)}%, keyword: ${(r.keywordScore * 100).toFixed(0)}%)`);
			console.log("");

			// Print code with truncation
			const lines = chunk.content.split("\n");
			const maxLines = 20;
			const displayLines = lines.slice(0, maxLines);

			for (const line of displayLines) {
				console.log(`  ${line}`);
			}

			if (lines.length > maxLines) {
				console.log(`  ... (${lines.length - maxLines} more lines)`);
			}

			console.log("");
		}
	} finally {
		await indexer.close();
	}
}

async function handleStatus(args: string[]): Promise<void> {
	const pathArg = args.find((a) => !a.startsWith("-"));
	const projectPath = pathArg ? resolve(pathArg) : process.cwd();

	const indexer = createIndexer({ projectPath });

	try {
		const status = await indexer.getStatus();

		if (!status.exists) {
			console.log("\nNo index found for this project.");
			console.log("Run 'claudemem index' to create one.");
			return;
		}

		console.log("\n📊 Index Status\n");
		console.log(`  Path: ${projectPath}`);
		console.log(`  Files: ${status.totalFiles}`);
		console.log(`  Chunks: ${status.totalChunks}`);
		console.log(`  Languages: ${status.languages.join(", ") || "none"}`);
		if (status.embeddingModel) {
			console.log(`  Embedding model: ${status.embeddingModel}`);
		}
		if (status.lastUpdated) {
			console.log(`  Last updated: ${status.lastUpdated.toISOString()}`);
		}
	} finally {
		await indexer.close();
	}
}

async function handleClear(args: string[]): Promise<void> {
	const pathArg = args.find((a) => !a.startsWith("-"));
	const projectPath = pathArg ? resolve(pathArg) : process.cwd();

	const force = args.includes("--force") || args.includes("-f");

	if (!force) {
		const confirmed = await confirm({
			message: `Clear index for ${projectPath}?`,
			default: false,
		});

		if (!confirmed) {
			console.log("Cancelled.");
			return;
		}
	}

	const indexer = createIndexer({ projectPath });

	try {
		await indexer.clear();
		console.log("\n✅ Index cleared.");
	} finally {
		await indexer.close();
	}
}

async function handleInit(): Promise<void> {
	console.log("\n🔧 claudemem Setup\n");

	// Step 1: Select embedding provider
	const provider = await select({
		message: "Select embedding provider:",
		choices: [
			{
				name: "OpenRouter (cloud API, requires API key)",
				value: "openrouter",
			},
			{
				name: "Ollama (local, free, requires Ollama installed)",
				value: "ollama",
			},
			{
				name: "Custom endpoint (local HTTP server)",
				value: "local",
			},
		],
	}) as "openrouter" | "ollama" | "local";

	let modelId: string;
	let endpoint: string | undefined;

	if (provider === "openrouter") {
		// OpenRouter setup
		const existingKey = getApiKey();
		if (existingKey) {
			const useExisting = await confirm({
				message: "OpenRouter API key already configured. Keep it?",
				default: true,
			});

			if (!useExisting) {
				await promptForApiKey();
			}
		} else {
			await promptForApiKey();
		}

		// Select OpenRouter model
		console.log("\n📦 Selecting embedding model...\n");
		const models = await discoverEmbeddingModels();

		modelId = await inquirerSearch({
			message: "Choose default embedding model:",
			source: async (term: string | undefined) => {
				const filtered = term
					? models.filter(
							(m) =>
								m.id.toLowerCase().includes(term.toLowerCase()) ||
								m.name.toLowerCase().includes(term.toLowerCase()),
						)
					: models.slice(0, 10);

				return filtered.map((m) => ({
					name: formatModelInfo(m),
					value: m.id,
				}));
			},
		});

	} else if (provider === "ollama") {
		// Ollama setup
		endpoint = await input({
			message: "Ollama endpoint URL:",
			default: "http://localhost:11434",
		});

		// Test connection
		console.log("\n🔄 Testing Ollama connection...");
		try {
			const response = await fetch(`${endpoint}/api/tags`);
			if (response.ok) {
				const data = await response.json() as { models?: Array<{ name: string }> };
				const installedModels = data.models || [];
				const embeddingModels = installedModels.filter((m: { name: string }) =>
					m.name.includes("embed") || m.name.includes("nomic") || m.name.includes("minilm") || m.name.includes("bge")
				);

				if (embeddingModels.length > 0) {
					console.log(`✅ Found ${embeddingModels.length} embedding model(s)`);
					modelId = await select({
						message: "Select embedding model:",
						choices: embeddingModels.map((m: { name: string }) => ({
							name: m.name,
							value: m.name.replace(":latest", ""),
						})),
					});
				} else {
					console.log("⚠️  No embedding models found. Installing nomic-embed-text...");
					console.log("   Run: ollama pull nomic-embed-text");
					modelId = "nomic-embed-text";
				}
			} else {
				throw new Error("Connection failed");
			}
		} catch {
			console.log("⚠️  Could not connect to Ollama. Make sure it's running.");
			console.log("   Start with: ollama serve");
			modelId = await input({
				message: "Enter embedding model name:",
				default: "nomic-embed-text",
			});
		}

	} else {
		// Custom endpoint setup
		endpoint = await input({
			message: "Custom endpoint URL:",
			default: "http://localhost:8000",
		});

		modelId = await input({
			message: "Model name:",
			default: "all-minilm-l6-v2",
		});
	}

	// Save configuration
	saveGlobalConfig({
		embeddingProvider: provider,
		defaultModel: modelId,
		...(provider === "ollama" && endpoint ? { ollamaEndpoint: endpoint } : {}),
		...(provider === "local" && endpoint ? { localEndpoint: endpoint } : {}),
	});

	console.log("\n✅ Setup complete!");
	console.log(`\nProvider: ${provider}`);
	console.log(`Model: ${modelId}`);
	if (endpoint) console.log(`Endpoint: ${endpoint}`);
	console.log("\nYou can now index your codebase:");
	console.log("  claudemem index\n");
}

async function handleModels(args: string[]): Promise<void> {
	const freeOnly = args.includes("--free");
	const forceRefresh = args.includes("--refresh");
	const showOllama = args.includes("--ollama");

	// Colors for output
	const c = {
		reset: "\x1b[0m",
		bold: "\x1b[1m",
		dim: "\x1b[2m",
		cyan: "\x1b[36m",
		green: "\x1b[38;5;78m",
		yellow: "\x1b[33m",
		magenta: "\x1b[35m",
		orange: "\x1b[38;5;209m",
	};

	// Check current provider
	const config = loadGlobalConfig();
	const currentProvider = config.embeddingProvider || "openrouter";

	// Show Ollama models if requested or if using Ollama provider
	if (showOllama || currentProvider === "ollama") {
		console.log("\n📦 Ollama Embedding Models\n");

		// Show recommended Ollama models
		console.log(`${c.orange}${c.bold}⭐ RECOMMENDED OLLAMA MODELS${c.reset}\n`);

		const ollamaModels = [
			{ id: "nomic-embed-text", dim: 768, size: "274MB", desc: "Best quality, multilingual" },
			{ id: "mxbai-embed-large", dim: 1024, size: "670MB", desc: "Large context, high quality" },
			{ id: "all-minilm", dim: 384, size: "46MB", desc: "Fastest, lightweight" },
			{ id: "snowflake-arctic-embed", dim: 1024, size: "670MB", desc: "Optimized for retrieval" },
		];

		for (const m of ollamaModels) {
			console.log(`  ${c.cyan}${m.id}${c.reset}`);
			console.log(`     ${m.desc} | ${m.dim}d | ${m.size}`);
		}

		console.log(`\n${c.bold}Install:${c.reset} ollama pull nomic-embed-text`);
		console.log(`${c.bold}Current provider:${c.reset} ${currentProvider}`);
		if (config.ollamaEndpoint) {
			console.log(`${c.bold}Endpoint:${c.reset} ${config.ollamaEndpoint}`);
		}
		console.log("");
		return;
	}

	// Show current provider info
	console.log(`\n${c.dim}Current provider: ${currentProvider}${c.reset}`);
	console.log("📦 Fetching embedding models from OpenRouter...\n");

	const allModels = await discoverEmbeddingModels(forceRefresh);

	// Categorize models
	const freeModels = allModels.filter((m) => m.isFree);
	const paidModels = allModels.filter((m) => !m.isFree);
	const recommendedIds = new Set(RECOMMENDED_MODELS.map((m) => m.id));

	// Helper to print a model row
	const printModel = (model: typeof allModels[0], prefix = "  ") => {
		const id = model.id.length > 35 ? model.id.slice(0, 32) + "..." : model.id;
		const price = model.isFree ? `${c.green}FREE${c.reset}` : `$${model.pricePerMillion.toFixed(3)}/1M`;
		const context = `${Math.round(model.contextLength / 1000)}K`;
		const dim = model.dimension ? `${model.dimension}d` : "N/A";
		console.log(
			`${prefix}${id.padEnd(36)} ${model.provider.padEnd(10)} ${price.padEnd(20)} ${context.padEnd(6)} ${dim}`,
		);
	};

	// Print header
	const printHeader = () => {
		console.log(`  ${"Model".padEnd(36)} ${"Provider".padEnd(10)} ${"Price".padEnd(12)} ${"Context".padEnd(6)} Dim`);
		console.log("  " + "─".repeat(78));
	};

	if (freeOnly) {
		// Show only free models
		console.log(`${c.yellow}${c.bold}FREE EMBEDDING MODELS${c.reset}\n`);
		printHeader();

		if (freeModels.length === 0) {
			console.log(`  ${c.dim}No free models currently available${c.reset}`);
		} else {
			for (const model of freeModels) {
				printModel(model);
			}
		}
		console.log("");
		console.log(`${c.dim}Note: Free model availability changes frequently.${c.reset}`);
		console.log(`${c.dim}Use --refresh to fetch the latest list.${c.reset}\n`);
		return;
	}

	// Show all categories

	// 1. Curated Picks (4 categories)
	console.log(`${c.orange}${c.bold}⭐ CURATED PICKS${c.reset}\n`);

	const picks = [
		{ label: "Best Quality", emoji: "🏆", model: CURATED_PICKS.bestQuality, desc: "Top-tier code understanding" },
		{ label: "Best Balanced", emoji: "⚖️", model: CURATED_PICKS.bestBalanced, desc: "Excellent quality/price ratio" },
		{ label: "Best Value", emoji: "💰", model: CURATED_PICKS.bestValue, desc: "Great quality, lowest cost" },
		{ label: "Fastest", emoji: "⚡", model: CURATED_PICKS.fastest, desc: "Optimized for speed" },
	];

	for (const pick of picks) {
		const price = pick.model.isFree ? `${c.green}FREE${c.reset}` : `$${pick.model.pricePerMillion.toFixed(3)}/1M`;
		const context = `${Math.round(pick.model.contextLength / 1000)}K`;
		const dim = pick.model.dimension ? `${pick.model.dimension}d` : "";
		console.log(`  ${pick.emoji} ${c.bold}${pick.label}${c.reset}: ${c.cyan}${pick.model.id}${c.reset}`);
		console.log(`     ${pick.desc} | ${price} | ${context} ctx | ${dim}`);
	}
	console.log("");

	// 3. Free Models (if any)
	if (freeModels.length > 0) {
		console.log(`${c.green}${c.bold}🆓 FREE MODELS${c.reset} ${c.dim}(Currently available)${c.reset}\n`);
		printHeader();
		for (const model of freeModels.slice(0, 10)) {
			printModel(model);
		}
		if (freeModels.length > 10) {
			console.log(`  ${c.dim}... and ${freeModels.length - 10} more free models${c.reset}`);
		}
		console.log("");
	}

	// 4. Other Paid Models
	const otherPaid = paidModels.filter((m) => !recommendedIds.has(m.id));
	if (otherPaid.length > 0) {
		console.log(`${c.cyan}${c.bold}💰 OTHER PAID MODELS${c.reset}\n`);
		printHeader();
		for (const model of otherPaid) {
			printModel(model);
		}
		console.log("");
	}

	// Summary
	console.log(`${c.bold}Summary:${c.reset} ${allModels.length} total models (${freeModels.length} free, ${paidModels.length} paid)`);
	console.log(`\n${c.dim}Use --free to show only free models, --refresh to update from API${c.reset}\n`);
}

// ============================================================================
// Helper Functions
// ============================================================================

async function promptForApiKey(): Promise<void> {
	console.log("OpenRouter API key required for embeddings.");
	console.log("Get yours at: https://openrouter.ai/keys\n");

	const apiKey = await input({
		message: "Enter your OpenRouter API key:",
		validate: (value) => {
			if (!value.trim()) {
				return "API key is required";
			}
			if (!value.startsWith("sk-or-")) {
				return "Invalid format. OpenRouter keys start with 'sk-or-'";
			}
			return true;
		},
	});

	saveGlobalConfig({ openrouterApiKey: apiKey });
	console.log("\n✅ API key saved.");
}

// ============================================================================
// Benchmark Command
// ============================================================================

/** Directories to always exclude when discovering files */
const EXCLUDE_DIRS = new Set([
	"node_modules", ".git", ".svn", ".hg", "dist", "build", "out",
	".next", ".nuxt", ".output", "coverage", ".cache", ".claudemem",
	"__pycache__", ".pytest_cache", "venv", ".venv", "target",
]);

/** Multi-line progress renderer for benchmark */
function createBenchmarkProgress(modelIds: string[]) {
	const globalStartTime = Date.now();
	const ANIM_FRAMES = ["▓", "▒", "░", "▒"];
	let animFrame = 0;
	let interval: ReturnType<typeof setInterval> | null = null;

	// State for each model (with individual timing)
	const modelState = new Map<string, {
		completed: number;
		total: number;
		inProgress: number;
		phase: string;
		done: boolean;
		error?: string;
		startTime: number;
		endTime?: number;
	}>();
	for (const id of modelIds) {
		modelState.set(id, { completed: 0, total: 0, inProgress: 0, phase: "embed", done: false, startTime: globalStartTime });
	}

	function render() {
		animFrame = (animFrame + 1) % ANIM_FRAMES.length;

		// Move cursor up to overwrite previous lines
		if (modelIds.length > 0) {
			process.stdout.write(`\x1b[${modelIds.length}A`);
		}

		for (const modelId of modelIds) {
			const state = modelState.get(modelId)!;
			const { completed, total, inProgress, phase, done, error, startTime, endTime } = state;

			// Calculate elapsed time (frozen when done/error)
			const elapsedMs = (endTime || Date.now()) - startTime;
			const elapsed = formatElapsed(elapsedMs);

			// Short model name (last part after /)
			const shortName = modelId.split("/").pop() || modelId;
			const displayName = shortName.length > 25 ? shortName.slice(0, 22) + "..." : shortName;

			// Build progress bar and status
			const width = 20;
			let bar: string;
			let percent: number;
			let status: string;

			if (error) {
				bar = "\x1b[31m" + "✗".repeat(width) + "\x1b[0m";
				percent = 0;
				status = `\x1b[31m${"✗ error".padEnd(20)}\x1b[0m`;
			} else if (done) {
				bar = "█".repeat(width);
				percent = 100;
				status = `\x1b[38;5;78m${"✓ done".padEnd(20)}\x1b[0m`;
			} else {
				percent = total > 0 ? Math.round((completed / total) * 100) : 0;
				const filledRatio = total > 0 ? completed / total : 0;
				const inProgressRatio = total > 0 ? inProgress / total : 0;

				const filledWidth = Math.round(filledRatio * width);
				const inProgressWidth = Math.min(Math.round(inProgressRatio * width), width - filledWidth);
				const emptyWidth = width - filledWidth - inProgressWidth;

				const filled = "█".repeat(filledWidth);
				let animated = "";
				for (let i = 0; i < inProgressWidth; i++) {
					const charIndex = (animFrame + i) % ANIM_FRAMES.length;
					animated += ANIM_FRAMES[charIndex];
				}
				const empty = "░".repeat(emptyWidth);
				bar = filled + animated + empty;
				status = `${phase}: ${completed}/${total}`.padEnd(20);
			}

			process.stdout.write(`\r⏱ ${elapsed} │ ${bar} ${percent.toString().padStart(3)}% │ ${displayName.padEnd(25)} │ ${status}\n`);
		}
	}

	return {
		start() {
			for (let i = 0; i < modelIds.length; i++) {
				console.log("");
			}
			interval = setInterval(render, 100);
			if (interval.unref) interval.unref();
			render();
		},
		update(modelId: string, completed: number, total: number, inProgress: number, phase = "embed") {
			const state = modelState.get(modelId);
			if (state) {
				state.completed = completed;
				state.total = total;
				state.inProgress = inProgress;
				state.phase = phase;
			}
		},
		finish(modelId: string) {
			const state = modelState.get(modelId);
			if (state) {
				state.done = true;
				state.inProgress = 0;
				state.completed = state.total;
				state.endTime = Date.now();
			}
		},
		setError(modelId: string, error: string) {
			const state = modelState.get(modelId);
			if (state) {
				state.error = error;
				state.done = true;
				state.endTime = Date.now();
			}
		},
		stop() {
			if (interval) {
				clearInterval(interval);
				interval = null;
			}
			render();
		},
	};
}

interface BenchmarkResult {
	model: string;
	speedMs: number;
	cost: number | undefined;
	dimension: number;
	chunks: number;
	// Quality metrics
	ndcg: number;
	mrr: number;
	hitRate: { k1: number; k3: number; k5: number };
	error?: string;
}

/**
 * Discover source files and parse them into chunks for benchmarking
 */
async function discoverAndChunkFiles(projectPath: string, maxChunks: number): Promise<string[]> {
	const files: string[] = [];

	// Walk directory to find source files
	const walk = (dir: string) => {
		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = join(dir, entry.name);

				if (entry.isDirectory()) {
					// Skip excluded directories
					if (!EXCLUDE_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
						walk(fullPath);
					}
				} else if (entry.isFile()) {
					// Check if file can be chunked (supported language)
					if (canChunkFile(fullPath)) {
						files.push(fullPath);
					}
				}
			}
		} catch {
			// Ignore permission errors
		}
	};

	walk(projectPath);

	// Parse files into chunks
	const allChunks: string[] = [];
	for (const filePath of files) {
		if (allChunks.length >= maxChunks) break;

		try {
			const content = readFileSync(filePath, "utf-8");
			const fileHash = createHash("md5").update(content).digest("hex");
			const chunks = await chunkFileByPath(content, filePath, fileHash);

			for (const chunk of chunks) {
				if (allChunks.length >= maxChunks) break;
				allChunks.push(chunk.content);
			}
		} catch {
			// Skip files that can't be read/parsed
		}
	}

	return allChunks;
}

/**
 * Discover source files and parse them into chunks WITH file paths
 * (needed for auto test query generation)
 */
async function discoverAndChunkFilesWithPaths(
	projectPath: string,
	maxChunks: number,
): Promise<Array<{ content: string; fileName: string }>> {
	const files: string[] = [];

	// Walk directory to find source files
	const walk = (dir: string) => {
		try {
			const entries = readdirSync(dir, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = join(dir, entry.name);

				if (entry.isDirectory()) {
					if (!EXCLUDE_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
						walk(fullPath);
					}
				} else if (entry.isFile()) {
					if (canChunkFile(fullPath)) {
						files.push(fullPath);
					}
				}
			}
		} catch {
			// Ignore permission errors
		}
	};

	walk(projectPath);

	// Sort files for reproducible chunk selection
	files.sort();

	// Parse files into chunks with file paths
	const allChunks: Array<{ content: string; fileName: string }> = [];
	for (const filePath of files) {
		if (allChunks.length >= maxChunks) break;

		try {
			const content = readFileSync(filePath, "utf-8");
			const fileHash = createHash("md5").update(content).digest("hex");
			const chunks = await chunkFileByPath(content, filePath, fileHash);
			const fileName = filePath.split("/").pop() || "";

			for (const chunk of chunks) {
				if (allChunks.length >= maxChunks) break;
				allChunks.push({ content: chunk.content, fileName });
			}
		} catch {
			// Skip files that can't be read/parsed
		}
	}

	return allChunks;
}

async function handleBenchmark(args: string[]): Promise<void> {
	const c = {
		reset: "\x1b[0m",
		bold: "\x1b[1m",
		dim: "\x1b[2m",
		cyan: "\x1b[36m",
		green: "\x1b[38;5;78m",
		yellow: "\x1b[33m",
		red: "\x1b[31m",
		orange: "\x1b[38;5;209m",
	};

	// Check for API key
	if (!hasApiKey()) {
		console.error("Error: OpenRouter API key not configured.");
		console.error("Run 'claudemem init' to set up, or set OPENROUTER_API_KEY.");
		process.exit(1);
	}

	// Parse flags
	const useRealData = args.includes("--real");
	const verbose = args.includes("--verbose") || args.includes("-v");
	const autoMode = args.includes("--auto");

	// Parse --models flag (support multiple formats)
	let models: string[];
	const modelsArgEquals = args.find((a) => a.startsWith("--models="));
	const modelsArgNoEquals = args.find((a) => a.startsWith("--models") && a.length > 8 && !a.includes("="));
	const modelsArgIndex = args.findIndex((a) => a === "--models");

	if (modelsArgEquals) {
		// --models=model1,model2
		models = modelsArgEquals.replace("--models=", "").split(",").map((s) => s.trim());
	} else if (modelsArgNoEquals) {
		// --modelsmodel1,model2 (typo - missing =)
		models = modelsArgNoEquals.replace("--models", "").split(",").map((s) => s.trim());
		console.log(`${c.dim}(Note: use --models= for clarity)${c.reset}`);
	} else if (modelsArgIndex !== -1 && args[modelsArgIndex + 1] && !args[modelsArgIndex + 1].startsWith("-")) {
		// --models model1,model2 (space-separated)
		models = args[modelsArgIndex + 1].split(",").map((s) => s.trim());
	} else {
		// Default models
		models = [
			CURATED_PICKS.bestBalanced.id,  // qwen/qwen3-embedding-8b
			"openai/text-embedding-3-small",
		];
	}

	const projectPath = process.cwd();

	console.log(`\n${c.orange}${c.bold}🏁 EMBEDDING MODEL BENCHMARK${c.reset}\n`);

	// Get chunks with file paths (always needed for quality testing)
	console.log(`${c.dim}Parsing source files...${c.reset}`);
	const chunksWithPaths = await discoverAndChunkFilesWithPaths(projectPath, useRealData ? 100 : 50);
	if (chunksWithPaths.length === 0) {
		console.error("No source files found in the current directory.");
		process.exit(1);
	}

	// Get test queries - either auto-generated or predefined
	let testQueries: TestQuery[];
	if (autoMode) {
		testQueries = await extractAutoTestQueries(projectPath);
		if (testQueries.length === 0) {
			console.error("No functions with docstrings found. Run without --auto to use predefined queries.");
			process.exit(1);
		}
	} else {
		// Predefined queries for claudemem codebase
		testQueries = [
			{ query: "convert text to vector representation", category: "semantic", expected: [{ file: "embeddings.ts", relevance: 3 }, { file: "store.ts", relevance: 2 }], description: "embedding" },
			{ query: "split code into smaller pieces", category: "semantic", expected: [{ file: "chunker.ts", relevance: 3 }, { file: "parser-manager.ts", relevance: 2 }], description: "chunking" },
			{ query: "find similar code based on meaning", category: "semantic", expected: [{ file: "store.ts", relevance: 3 }, { file: "indexer.ts", relevance: 2 }], description: "search" },
			{ query: "LanceDB vector database", category: "keyword", expected: [{ file: "store.ts", relevance: 3 }], description: "LanceDB" },
			{ query: "tree-sitter parser AST", category: "keyword", expected: [{ file: "parser-manager.ts", relevance: 3 }, { file: "chunker.ts", relevance: 2 }], description: "tree-sitter" },
			{ query: "OpenRouter API embeddings", category: "keyword", expected: [{ file: "embeddings.ts", relevance: 3 }, { file: "config.ts", relevance: 2 }], description: "OpenRouter" },
			{ query: "how do I search for code", category: "natural", expected: [{ file: "indexer.ts", relevance: 3 }, { file: "store.ts", relevance: 2 }], description: "search usage" },
			{ query: "createEmbeddingsClient function", category: "api", expected: [{ file: "embeddings.ts", relevance: 3 }], description: "embeddings API" },
			{ query: "VectorStore search method", category: "api", expected: [{ file: "store.ts", relevance: 3 }], description: "vector store" },
			{ query: "handle API timeout retry", category: "error", expected: [{ file: "embeddings.ts", relevance: 3 }], description: "retry logic" },
		];
	}

	console.log(`${c.dim}Testing ${models.length} models with ${chunksWithPaths.length} chunks + ${testQueries.length} quality queries${c.reset}\n`);

	// Create multi-line progress display
	const progress = createBenchmarkProgress(models);
	progress.start();

	// Benchmark directory for temp stores
	const benchDbBase = join(projectPath, ".claudemem", "benchmark");
	if (!existsSync(benchDbBase)) {
		mkdirSync(benchDbBase, { recursive: true });
	}

	// Run all models in PARALLEL
	const benchmarkPromises = models.map(async (modelId): Promise<BenchmarkResult> => {
		const startTime = Date.now();
		const modelSlug = modelId.replace(/[^a-zA-Z0-9]/g, "-");
		const tempDbPath = join(benchDbBase, modelSlug);

		try {
			const client = new OpenRouterEmbeddingsClient({ model: modelId });

			// Phase 1: Embed all chunks
			const embedResult = await client.embed(
				chunksWithPaths.map((c) => c.content),
				(completed, total, inProgress) => {
					progress.update(modelId, completed, total, inProgress, "embed");
				},
			);

			const embedTimeMs = Date.now() - startTime;

			// Phase 2: Build temp vector store and run quality queries
			progress.update(modelId, 0, testQueries.length, testQueries.length, "quality");

			// Clear existing temp db
			if (existsSync(tempDbPath)) {
				const { rmSync } = await import("node:fs");
				rmSync(tempDbPath, { recursive: true, force: true });
			}

			const store = createVectorStore(tempDbPath);
			await store.initialize();

			// Add chunks with embeddings
			const chunksForStore = chunksWithPaths.map((chunk, i) => ({
				id: `chunk-${i}`,
				content: chunk.content,
				filePath: chunk.fileName,
				startLine: 0,
				endLine: 0,
				language: "unknown",
				chunkType: "code" as const,
				fileHash: `hash-${i}`,
				vector: embedResult.embeddings[i],
			}));
			await store.addChunks(chunksForStore);

			// Run quality queries
			let mrrSum = 0;
			let ndcgSum = 0;
			const hitCounts = { k1: 0, k3: 0, k5: 0 };

			for (let qi = 0; qi < testQueries.length; qi++) {
				const tq = testQueries[qi];
				progress.update(modelId, qi, testQueries.length, 1, "quality");

				// Embed query and search
				const queryVector = await client.embedOne(tq.query);
				const searchResults = await store.search(tq.query, queryVector, { limit: 5 });

				// Build relevance map
				const relevanceMap = new Map<string, number>();
				for (const exp of tq.expected) {
					relevanceMap.set(exp.file, exp.relevance);
				}

				// Score results
				let firstRelevantRank: number | null = null;
				const actualRelevances: number[] = [];
				const idealRelevances = tq.expected.map((e) => e.relevance);

				for (let i = 0; i < Math.min(searchResults.length, 5); i++) {
					const fileName = searchResults[i].chunk.filePath;
					let relevance = 0;
					for (const [expFile, expRel] of relevanceMap) {
						if (fileName.includes(expFile)) {
							relevance = expRel;
							break;
						}
					}
					actualRelevances.push(relevance);
					if (relevance > 0 && firstRelevantRank === null) {
						firstRelevantRank = i + 1;
					}
				}

				// Pad to 5
				while (actualRelevances.length < 5) actualRelevances.push(0);

				// Calculate NDCG
				const dcg = calculateDCG(actualRelevances);
				const idcg = calculateDCG([...idealRelevances].sort((a, b) => b - a));
				const ndcg = idcg === 0 ? 0 : dcg / idcg;

				ndcgSum += ndcg;
				if (firstRelevantRank !== null) {
					mrrSum += 1 / firstRelevantRank;
					if (firstRelevantRank <= 1) hitCounts.k1++;
					if (firstRelevantRank <= 3) hitCounts.k3++;
					if (firstRelevantRank <= 5) hitCounts.k5++;
				}
			}

			// Cleanup
			await store.close();

			const n = testQueries.length;
			progress.finish(modelId);

			return {
				model: modelId,
				speedMs: embedTimeMs,
				cost: embedResult.cost,
				dimension: embedResult.embeddings[0]?.length || 0,
				chunks: chunksWithPaths.length,
				ndcg: (ndcgSum / n) * 100,
				mrr: (mrrSum / n) * 100,
				hitRate: {
					k1: (hitCounts.k1 / n) * 100,
					k3: (hitCounts.k3 / n) * 100,
					k5: (hitCounts.k5 / n) * 100,
				},
			};
		} catch (error) {
			const errMsg = error instanceof Error ? error.message : String(error);
			progress.setError(modelId, errMsg);
			return {
				model: modelId,
				speedMs: Date.now() - startTime,
				cost: undefined,
				dimension: 0,
				chunks: 0,
				ndcg: 0,
				mrr: 0,
				hitRate: { k1: 0, k3: 0, k5: 0 },
				error: errMsg,
			};
		}
	});

	const results = await Promise.all(benchmarkPromises);
	progress.stop();

	// Sort by NDCG (quality first)
	results.sort((a, b) => (a.error ? 1 : 0) - (b.error ? 1 : 0) || b.ndcg - a.ndcg);

	// Display results table
	console.log(`\n${c.bold}Results (sorted by quality):${c.reset}\n`);
	console.log(`  ${"Model".padEnd(32)} ${"Speed".padEnd(8)} ${"Cost".padEnd(12)} ${"Dim".padEnd(6)} ${"NDCG".padEnd(7)} ${"MRR".padEnd(7)} ${"Hit@5"}`);
	console.log("  " + "─".repeat(87));

	// Truncate long model names
	const truncate = (s: string, max = 30) => s.length > max ? s.slice(0, max - 1) + "…" : s;

	// Calculate best/worst for highlighting
	const successResults = results.filter((r) => !r.error);
	const minSpeed = Math.min(...successResults.map((r) => r.speedMs));
	const maxSpeed = Math.max(...successResults.map((r) => r.speedMs));
	const costsWithValues = successResults.filter((r) => r.cost !== undefined);
	const minCost = costsWithValues.length > 0 ? Math.min(...costsWithValues.map((r) => r.cost!)) : undefined;
	const maxCost = costsWithValues.length > 0 ? Math.max(...costsWithValues.map((r) => r.cost!)) : undefined;
	const maxNdcg = Math.max(...successResults.map((r) => r.ndcg));
	const minNdcg = Math.min(...successResults.map((r) => r.ndcg));
	const shouldHighlight = successResults.length > 1;

	for (const r of results) {
		const displayName = truncate(r.model).padEnd(32);
		if (r.error) {
			console.log(`  ${c.red}${displayName} ERROR${c.reset}`);
			console.log(`    ${c.dim}${r.error}${c.reset}`);
			continue;
		}

		// Speed with highlighting
		const speedVal = `${(r.speedMs / 1000).toFixed(2)}s`;
		let speed = speedVal.padEnd(8);
		if (shouldHighlight && r.speedMs === minSpeed) {
			speed = `${c.green}${speedVal.padEnd(8)}${c.reset}`;
		} else if (shouldHighlight && r.speedMs === maxSpeed && minSpeed !== maxSpeed) {
			speed = `${c.red}${speedVal.padEnd(8)}${c.reset}`;
		}

		// Cost with highlighting
		const costVal = r.cost !== undefined ? `$${r.cost.toFixed(6)}` : "N/A";
		let cost = costVal.padEnd(12);
		if (shouldHighlight && r.cost !== undefined && minCost !== undefined && r.cost === minCost) {
			cost = `${c.green}${costVal.padEnd(12)}${c.reset}`;
		} else if (shouldHighlight && r.cost !== undefined && maxCost !== undefined && r.cost === maxCost && minCost !== maxCost) {
			cost = `${c.red}${costVal.padEnd(12)}${c.reset}`;
		}

		// NDCG with highlighting
		const ndcgVal = `${r.ndcg.toFixed(0)}%`;
		let ndcg = ndcgVal.padEnd(7);
		if (shouldHighlight && r.ndcg === maxNdcg) {
			ndcg = `${c.green}${ndcgVal.padEnd(7)}${c.reset}`;
		} else if (shouldHighlight && r.ndcg === minNdcg && minNdcg !== maxNdcg) {
			ndcg = `${c.red}${ndcgVal.padEnd(7)}${c.reset}`;
		}

		const dim = `${r.dimension}d`.padEnd(6);
		const mrr = `${r.mrr.toFixed(0)}%`.padEnd(7);
		const hit5 = `${r.hitRate.k5.toFixed(0)}%`;

		console.log(`  ${displayName} ${speed} ${cost} ${dim} ${ndcg} ${mrr} ${hit5}`);
	}

	// Summary
	if (successResults.length > 0) {
		const fastest = successResults.reduce((a, b) => a.speedMs < b.speedMs ? a : b);
		const cheapest = costsWithValues.length > 0 ? costsWithValues.reduce((a, b) => (a.cost || Infinity) < (b.cost || Infinity) ? a : b) : null;
		const bestQuality = successResults.reduce((a, b) => a.ndcg > b.ndcg ? a : b);

		console.log(`\n${c.bold}Summary:${c.reset}`);
		console.log(`  ${c.green}🏆 Best Quality:${c.reset} ${bestQuality.model} (NDCG: ${bestQuality.ndcg.toFixed(0)}%)`);
		console.log(`  ${c.green}⚡ Fastest:${c.reset} ${fastest.model} (${(fastest.speedMs / 1000).toFixed(2)}s)`);
		if (cheapest) {
			console.log(`  ${c.green}💰 Cheapest:${c.reset} ${cheapest.model} ($${cheapest.cost?.toFixed(6)})`);
		}
	}

	console.log(`\n${c.dim}Metrics: NDCG (quality), MRR (rank), Hit@5 (found in top 5)${c.reset}`);
	console.log(`${c.dim}Use --auto to generate queries from docstrings (works on any codebase)${c.reset}`);
	console.log(`${c.dim}Use --verbose for detailed per-query results${c.reset}\n`);
}

// ============================================================================
// Quality Test Types
// ============================================================================

/**
 * Query categories for comprehensive evaluation
 */
type QueryCategory = "semantic" | "keyword" | "natural" | "error" | "api";

/**
 * Test query with graded relevance (0-3 scale like CodeSearchNet)
 * 0 = irrelevant, 1 = marginally relevant, 2 = relevant, 3 = highly relevant
 */
interface TestQuery {
	query: string;
	/** Category of query for analysis */
	category: QueryCategory;
	/** Expected results with graded relevance scores */
	expected: Array<{
		file: string;
		relevance: 0 | 1 | 2 | 3;
	}>;
	/** Description of what we're testing */
	description: string;
}

interface QueryResult {
	query: string;
	category: QueryCategory;
	/** Rank at which first relevant result was found (null if not found) */
	firstRelevantRank: number | null;
	/** Top 5 results with their relevance scores */
	results: Array<{
		file: string;
		relevance: number;
		rank: number;
	}>;
	/** DCG (Discounted Cumulative Gain) at K=5 */
	dcg: number;
	/** IDCG (Ideal DCG) - best possible DCG */
	idcg: number;
	/** NDCG = DCG / IDCG */
	ndcg: number;
}

interface TestResult {
	model: string;
	indexTimeMs: number;
	indexCost?: number;
	queryResults: QueryResult[];
	/** Metrics computed at different K values */
	metrics: {
		/** Hit Rate: % of queries with at least one relevant result in top K */
		hitRate: { k1: number; k3: number; k5: number };
		/** MRR: Mean Reciprocal Rank */
		mrr: number;
		/** Mean NDCG across all queries */
		ndcg: number;
		/** Precision: avg % of top K results that are relevant */
		precision: { k1: number; k3: number; k5: number };
	};
	/** Metrics broken down by category */
	byCategory: Record<QueryCategory, { count: number; mrr: number; ndcg: number }>;
	error?: string;
}

/**
 * Calculate DCG (Discounted Cumulative Gain)
 * DCG = Σ (relevance_i / log2(i + 1))
 */
function calculateDCG(relevances: number[]): number {
	return relevances.reduce((sum, rel, i) => {
		return sum + rel / Math.log2(i + 2); // i+2 because rank starts at 1
	}, 0);
}

/**
 * Calculate NDCG (Normalized DCG)
 */
function calculateNDCG(actualRelevances: number[], idealRelevances: number[]): number {
	const dcg = calculateDCG(actualRelevances);
	const idcg = calculateDCG(idealRelevances.sort((a, b) => b - a));
	return idcg === 0 ? 0 : dcg / idcg;
}

/**
 * Extract test queries automatically from codebase docstrings
 * Uses docstrings as queries and their source file as expected result
 * This enables testing on ANY codebase, not just claudemem
 */
async function extractAutoTestQueries(projectPath: string): Promise<TestQuery[]> {
	const queries: TestQuery[] = [];
	const seenQueries = new Set<string>();

	// Discover and chunk files WITH file paths
	const chunksWithFiles = await discoverAndChunkFilesWithPaths(projectPath, 500);

	// Regex patterns for extracting docstrings from different languages
	const docstringPatterns = [
		// JSDoc: /** ... */
		/\/\*\*\s*\n?\s*\*?\s*([^@*][^\n*]+)/,
		// Python docstring: """...""" or '''...'''
		/^(?:def|class)\s+\w+[^:]*:\s*(?:"""([^"]+)"""|'''([^']+)''')/m,
		// Single line comment describing function: // description
		/^(?:export\s+)?(?:async\s+)?function\s+\w+[^{]*\{\s*\/\/\s*(.+)/m,
		// TypeScript/JS: function with preceding comment
		/\/\/\s*([A-Z][^.\n]{10,80}\.?)\s*\n(?:export\s+)?(?:async\s+)?function/,
	];

	// Regex to extract function/class name
	const namePatterns = [
		/(?:export\s+)?(?:async\s+)?function\s+(\w+)/,
		/(?:export\s+)?class\s+(\w+)/,
		/(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/,
		/def\s+(\w+)\s*\(/,
		/class\s+(\w+)/,
	];

	for (const { content, fileName } of chunksWithFiles) {
		// Try to extract docstring
		let docstring: string | null = null;
		for (const pattern of docstringPatterns) {
			const match = content.match(pattern);
			if (match) {
				docstring = (match[1] || match[2] || "").trim();
				break;
			}
		}

		// Try to extract name
		let funcName: string | null = null;
		for (const pattern of namePatterns) {
			const match = content.match(pattern);
			if (match) {
				funcName = match[1];
				break;
			}
		}

		// Create queries from docstrings (semantic category)
		if (docstring && docstring.length > 15 && docstring.length < 200 && fileName) {
			// Clean up docstring
			const cleanDoc = docstring
				.replace(/\s+/g, " ")
				.replace(/^[\s*-]+/, "")
				.trim();

			if (!seenQueries.has(cleanDoc.toLowerCase())) {
				seenQueries.add(cleanDoc.toLowerCase());
				queries.push({
					query: cleanDoc,
					category: "semantic",
					expected: [{ file: fileName, relevance: 3 }],
					description: `Docstring: ${funcName || "unknown"}`,
				});
			}
		}

		// Create queries from function names (keyword category)
		if (funcName && funcName.length > 3 && fileName && !seenQueries.has(funcName.toLowerCase())) {
			seenQueries.add(funcName.toLowerCase());

			// Convert camelCase/snake_case to words for better semantic search
			const words = funcName
				.replace(/([a-z])([A-Z])/g, "$1 $2")
				.replace(/_/g, " ")
				.toLowerCase();

			queries.push({
				query: `${funcName} function`,
				category: "keyword",
				expected: [{ file: fileName, relevance: 3 }],
				description: `Function: ${funcName}`,
			});

			// Also add semantic version if it produces meaningful words
			if (words.split(" ").length >= 2) {
				queries.push({
					query: words,
					category: "semantic",
					expected: [{ file: fileName, relevance: 3 }],
					description: `Semantic: ${funcName}`,
				});
			}
		}
	}

	// Limit to reasonable number (too many makes test slow)
	const maxQueries = 30;
	if (queries.length > maxQueries) {
		// Shuffle and take first N, ensuring mix of categories
		const byCategory = new Map<QueryCategory, TestQuery[]>();
		for (const q of queries) {
			if (!byCategory.has(q.category)) {
				byCategory.set(q.category, []);
			}
			byCategory.get(q.category)!.push(q);
		}

		const selected: TestQuery[] = [];
		const perCategory = Math.ceil(maxQueries / byCategory.size);
		for (const [_, catQueries] of byCategory) {
			// Shuffle
			for (let i = catQueries.length - 1; i > 0; i--) {
				const j = Math.floor(Math.random() * (i + 1));
				[catQueries[i], catQueries[j]] = [catQueries[j], catQueries[i]];
			}
			selected.push(...catQueries.slice(0, perCategory));
		}
		return selected.slice(0, maxQueries);
	}

	return queries;
}

function printHelp(): void {
	// Colors (matching claudish style)
	const c = {
		reset: "\x1b[0m",
		bold: "\x1b[1m",
		dim: "\x1b[2m",
		cyan: "\x1b[36m",
		green: "\x1b[38;5;78m",  // Softer green (not acid)
		yellow: "\x1b[33m",
		blue: "\x1b[34m",
		magenta: "\x1b[35m",
		orange: "\x1b[38;5;209m",  // Salmon/orange like claudish
		gray: "\x1b[90m",
	};

	// ASCII art logo (claudish style)
	console.log(`
${c.orange}   ██████╗██╗      █████╗ ██╗   ██╗██████╗ ███████╗${c.reset}${c.green}███╗   ███╗███████╗███╗   ███╗${c.reset}
${c.orange}  ██╔════╝██║     ██╔══██╗██║   ██║██╔══██╗██╔════╝${c.reset}${c.green}████╗ ████║██╔════╝████╗ ████║${c.reset}
${c.orange}  ██║     ██║     ███████║██║   ██║██║  ██║█████╗  ${c.reset}${c.green}██╔████╔██║█████╗  ██╔████╔██║${c.reset}
${c.orange}  ██║     ██║     ██╔══██║██║   ██║██║  ██║██╔══╝  ${c.reset}${c.green}██║╚██╔╝██║██╔══╝  ██║╚██╔╝██║${c.reset}
${c.orange}  ╚██████╗███████╗██║  ██║╚██████╔╝██████╔╝███████╗${c.reset}${c.green}██║ ╚═╝ ██║███████╗██║ ╚═╝ ██║${c.reset}
${c.orange}   ╚═════╝╚══════╝╚═╝  ╚═╝ ╚═════╝ ╚═════╝ ╚══════╝${c.reset}${c.green}╚═╝     ╚═╝╚══════╝╚═╝     ╚═╝${c.reset}

${c.bold}  Local Code Indexing.${c.reset} ${c.green}For Claude Code.${c.reset}
${c.dim}  Semantic search powered by embeddings via OpenRouter${c.reset}

${c.yellow}${c.bold}USAGE${c.reset}
  ${c.cyan}claudemem${c.reset} <command> [options]

${c.yellow}${c.bold}COMMANDS${c.reset}
  ${c.green}index${c.reset} [path]           Index a codebase (default: current directory)
  ${c.green}search${c.reset} <query>         Search indexed code ${c.dim}(auto-indexes changes)${c.reset}
  ${c.green}status${c.reset} [path]          Show index status
  ${c.green}clear${c.reset} [path]           Clear the index
  ${c.green}init${c.reset}                   Interactive setup wizard
  ${c.green}models${c.reset}                 List available embedding models
  ${c.green}benchmark${c.reset}              Compare embedding models (index, search quality, cost)

${c.yellow}${c.bold}INDEX OPTIONS${c.reset}
  ${c.cyan}-f, --force${c.reset}            Force re-index all files

${c.yellow}${c.bold}SEARCH OPTIONS${c.reset}
  ${c.cyan}-n, --limit${c.reset} <n>        Maximum results (default: 10)
  ${c.cyan}-l, --language${c.reset} <lang>  Filter by programming language
  ${c.cyan}-p, --path${c.reset} <path>      Project path (default: current directory)
  ${c.cyan}-y, --yes${c.reset}              Auto-create index if missing (no prompt)
  ${c.cyan}--no-reindex${c.reset}           Skip auto-reindexing changed files

${c.yellow}${c.bold}MODELS OPTIONS${c.reset}
  ${c.cyan}--free${c.reset}                 Show only free models
  ${c.cyan}--refresh${c.reset}              Force refresh from API
  ${c.cyan}--ollama${c.reset}               Show Ollama local models

${c.yellow}${c.bold}BENCHMARK OPTIONS${c.reset}
  ${c.cyan}--models=${c.reset}<list>        Comma-separated model IDs to test
  ${c.cyan}--real${c.reset}                 Use 100 chunks (default: 50)
  ${c.cyan}--auto${c.reset}                 Auto-generate queries from docstrings (any codebase)
  ${c.cyan}--verbose${c.reset}              Show detailed per-query results

${c.yellow}${c.bold}GLOBAL OPTIONS${c.reset}
  ${c.cyan}-v, --version${c.reset}          Show version
  ${c.cyan}-h, --help${c.reset}             Show this help
  ${c.cyan}--models${c.reset}               List available embedding models (with --free, --refresh)

${c.yellow}${c.bold}MCP SERVER${c.reset}
  ${c.cyan}claudemem --mcp${c.reset}        Start as MCP server (for Claude Code)

${c.yellow}${c.bold}ENVIRONMENT${c.reset}
  ${c.magenta}OPENROUTER_API_KEY${c.reset}     API key for embeddings
  ${c.magenta}CLAUDEMEM_MODEL${c.reset}        Override default embedding model

${c.yellow}${c.bold}EXAMPLES${c.reset}
  ${c.dim}# First time setup${c.reset}
  ${c.cyan}claudemem init${c.reset}

  ${c.dim}# Index current project${c.reset}
  ${c.cyan}claudemem index${c.reset}

  ${c.dim}# Search (auto-indexes changes)${c.reset}
  ${c.cyan}claudemem search "authentication flow"${c.reset}
  ${c.cyan}claudemem search "error handling" -n 5${c.reset}

  ${c.dim}# Search without auto-reindex${c.reset}
  ${c.cyan}claudemem search "query" --no-reindex${c.reset}

  ${c.dim}# Auto-create index on first search${c.reset}
  ${c.cyan}claudemem search "something" -y${c.reset}

  ${c.dim}# Show available embedding models${c.reset}
  ${c.cyan}claudemem --models${c.reset}
  ${c.cyan}claudemem --models --free${c.reset}

  ${c.dim}# Benchmark embedding models (index speed, search quality, cost)${c.reset}
  ${c.cyan}claudemem benchmark${c.reset}
  ${c.cyan}claudemem benchmark --auto${c.reset}  ${c.dim}# works on any codebase${c.reset}
  ${c.cyan}claudemem benchmark --models=qwen/qwen3-embedding-8b,openai/text-embedding-3-small${c.reset}

${c.yellow}${c.bold}MORE INFO${c.reset}
  ${c.blue}https://github.com/MadAppGang/claudemem${c.reset}
`);
}
