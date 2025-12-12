/**
 * claudemem CLI
 *
 * Command-line interface for code indexing and search.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
	let state: ProgressState = { completed: 0, total: 0, inProgress: 0, phase: "", detail: "" };
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
		const animated = inProgressWidth > 0 ? ANIM_FRAMES[animFrame].repeat(inProgressWidth) : "";
		const empty = "░".repeat(emptyWidth);
		const bar = filled + animated + empty;

		process.stdout.write(
			`\r⏱ ${elapsed} │ ${bar} ${percent.toString().padStart(3)}% │ ${phase.padEnd(9)} │ ${detail.padEnd(35)}`
		);
	}

	return {
		start() {
			interval = setInterval(render, 100); // Update every 100ms
		},
		update(completed: number, total: number, detail: string, inProgress = 0) {
			// Extract phase from detail (e.g., "[parsing] filename")
			const phaseMatch = detail.match(/^\[(\w+)\]/);
			const phase = phaseMatch ? phaseMatch[1] : "processing";
			const cleanDetail = detail.replace(/^\[\w+\]\s*/, "").slice(0, 35);

			// Show phase change
			if (phase !== lastPhase && lastPhase !== "") {
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

		// Stop progress renderer and clear line
		progress.stop();
		process.stdout.write("\r" + " ".repeat(100) + "\r");

		const totalElapsed = formatElapsed(result.durationMs);
		console.log(`\n✅ Indexing complete in ${totalElapsed}!\n`);
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
		for (const model of otherPaid.slice(0, 10)) {
			printModel(model);
		}
		if (otherPaid.length > 10) {
			console.log(`  ${c.dim}... and ${otherPaid.length - 10} more paid models${c.reset}`);
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

${c.yellow}${c.bold}MORE INFO${c.reset}
  ${c.blue}https://github.com/MadAppGang/claudemem${c.reset}
`);
}
