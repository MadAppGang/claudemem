/**
 * Parser Manager for Tree-sitter
 *
 * Manages tree-sitter parsers and provides language detection
 * and parsing capabilities using WASM grammars.
 */

import { existsSync, readFileSync } from "node:fs";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Parser from "web-tree-sitter";
import type { LanguageConfig, SupportedLanguage } from "../types.js";

// ============================================================================
// Language Configurations
// ============================================================================

const LANGUAGE_CONFIGS: Record<SupportedLanguage, LanguageConfig> = {
	typescript: {
		id: "typescript",
		extensions: [".ts", ".mts", ".cts"],
		grammarFile: "tree-sitter-typescript.wasm",
		chunkQuery: `
      (function_declaration
        name: (identifier) @name) @chunk
      (class_declaration
        name: (type_identifier) @name) @chunk
      (method_definition
        name: (property_identifier) @name) @chunk
      (arrow_function) @chunk
      (interface_declaration
        name: (type_identifier) @name) @chunk
      (type_alias_declaration
        name: (type_identifier) @name) @chunk
    `,
	},
	javascript: {
		id: "javascript",
		extensions: [".js", ".mjs", ".cjs"],
		grammarFile: "tree-sitter-javascript.wasm",
		chunkQuery: `
      (function_declaration
        name: (identifier) @name) @chunk
      (class_declaration
        name: (identifier) @name) @chunk
      (method_definition
        name: (property_identifier) @name) @chunk
      (arrow_function) @chunk
    `,
	},
	tsx: {
		id: "tsx",
		extensions: [".tsx"],
		grammarFile: "tree-sitter-tsx.wasm",
		chunkQuery: `
      (function_declaration
        name: (identifier) @name) @chunk
      (class_declaration
        name: (type_identifier) @name) @chunk
      (method_definition
        name: (property_identifier) @name) @chunk
      (arrow_function) @chunk
      (interface_declaration
        name: (type_identifier) @name) @chunk
    `,
	},
	jsx: {
		id: "jsx",
		extensions: [".jsx"],
		grammarFile: "tree-sitter-javascript.wasm",
		chunkQuery: `
      (function_declaration
        name: (identifier) @name) @chunk
      (class_declaration
        name: (identifier) @name) @chunk
      (method_definition
        name: (property_identifier) @name) @chunk
      (arrow_function) @chunk
    `,
	},
	python: {
		id: "python",
		extensions: [".py", ".pyw", ".pyi"],
		grammarFile: "tree-sitter-python.wasm",
		chunkQuery: `
      (function_definition
        name: (identifier) @name) @chunk
      (class_definition
        name: (identifier) @name) @chunk
    `,
	},
	go: {
		id: "go",
		extensions: [".go"],
		grammarFile: "tree-sitter-go.wasm",
		chunkQuery: `
      (function_declaration
        name: (identifier) @name) @chunk
      (method_declaration
        name: (field_identifier) @name) @chunk
      (type_declaration
        (type_spec
          name: (type_identifier) @name)) @chunk
    `,
	},
	rust: {
		id: "rust",
		extensions: [".rs"],
		grammarFile: "tree-sitter-rust.wasm",
		chunkQuery: `
      (function_item
        name: (identifier) @name) @chunk
      (impl_item) @chunk
      (struct_item
        name: (type_identifier) @name) @chunk
      (enum_item
        name: (type_identifier) @name) @chunk
      (trait_item
        name: (type_identifier) @name) @chunk
    `,
	},
	c: {
		id: "c",
		extensions: [".c", ".h"],
		grammarFile: "tree-sitter-c.wasm",
		chunkQuery: `
      (function_definition
        declarator: (function_declarator
          declarator: (identifier) @name)) @chunk
      (struct_specifier
        name: (type_identifier) @name) @chunk
      (enum_specifier
        name: (type_identifier) @name) @chunk
    `,
	},
	cpp: {
		id: "cpp",
		extensions: [".cpp", ".hpp", ".cc", ".hh", ".cxx", ".hxx"],
		grammarFile: "tree-sitter-cpp.wasm",
		chunkQuery: `
      (function_definition
        declarator: (function_declarator
          declarator: (identifier) @name)) @chunk
      (class_specifier
        name: (type_identifier) @name) @chunk
      (struct_specifier
        name: (type_identifier) @name) @chunk
    `,
	},
	java: {
		id: "java",
		extensions: [".java"],
		grammarFile: "tree-sitter-java.wasm",
		chunkQuery: `
      (method_declaration
        name: (identifier) @name) @chunk
      (class_declaration
        name: (identifier) @name) @chunk
      (interface_declaration
        name: (identifier) @name) @chunk
      (enum_declaration
        name: (identifier) @name) @chunk
    `,
	},
};

// ============================================================================
// Extension to Language Mapping
// ============================================================================

const EXTENSION_TO_LANGUAGE: Record<string, SupportedLanguage> = {};

for (const [language, config] of Object.entries(LANGUAGE_CONFIGS)) {
	for (const ext of config.extensions) {
		EXTENSION_TO_LANGUAGE[ext] = language as SupportedLanguage;
	}
}

// ============================================================================
// Parser Manager Class
// ============================================================================

export class ParserManager {
	private initialized = false;
	private parsers: Map<SupportedLanguage, Parser> = new Map();
	private languages: Map<SupportedLanguage, Parser.Language> = new Map();
	private grammarsPath: string;

	constructor(grammarsPath?: string) {
		// Default to grammars directory relative to this file
		// In development: src/parsers/parser-manager.ts -> ../../grammars
		// In bundled dist: dist/index.js -> ../grammars
		const __dirname = fileURLToPath(new URL(".", import.meta.url));
		const isDist = __dirname.includes("/dist") || __dirname.endsWith("/dist/");
		const relativePath = isDist ? "../grammars" : "../../grammars";
		this.grammarsPath = grammarsPath || join(__dirname, relativePath);
	}

	/**
	 * Initialize the parser manager
	 * Must be called before parsing any files
	 */
	async initialize(): Promise<void> {
		if (this.initialized) {
			return;
		}

		// Use locateFile to tell web-tree-sitter where to find tree-sitter.wasm
		// This is critical for bundled distributions where the default path
		// gets baked in at build time (e.g., GitHub Actions path)
		await Parser.init({
			locateFile: (scriptName: string) => {
				// Return the path to tree-sitter.wasm in our grammars directory
				return join(this.grammarsPath, scriptName);
			},
		});
		this.initialized = true;
	}

	/**
	 * Get the language for a file path
	 */
	getLanguage(filePath: string): SupportedLanguage | null {
		const ext = extname(filePath).toLowerCase();
		return EXTENSION_TO_LANGUAGE[ext] || null;
	}

	/**
	 * Check if a file is supported
	 */
	isSupported(filePath: string): boolean {
		return this.getLanguage(filePath) !== null;
	}

	/**
	 * Get the configuration for a language
	 */
	getLanguageConfig(language: SupportedLanguage): LanguageConfig {
		return LANGUAGE_CONFIGS[language];
	}

	/**
	 * Get a parser for a specific language
	 */
	async getParser(language: SupportedLanguage): Promise<Parser | null> {
		await this.initialize();

		// Return cached parser if available
		if (this.parsers.has(language)) {
			return this.parsers.get(language)!;
		}

		// Load the language
		const lang = await this.loadLanguage(language);
		if (!lang) {
			return null;
		}

		// Create parser
		const parser = new Parser();
		parser.setLanguage(lang);

		// Cache it
		this.parsers.set(language, parser);
		return parser;
	}

	/**
	 * Load a language grammar
	 */
	private async loadLanguage(
		language: SupportedLanguage,
	): Promise<Parser.Language | null> {
		// Return cached language if available
		if (this.languages.has(language)) {
			return this.languages.get(language)!;
		}

		const config = LANGUAGE_CONFIGS[language];
		const grammarPath = join(this.grammarsPath, config.grammarFile);

		// Check if grammar file exists
		if (!existsSync(grammarPath)) {
			console.warn(`Grammar file not found: ${grammarPath}`);
			return null;
		}

		try {
			const wasmBuffer = readFileSync(grammarPath);
			const lang = await Parser.Language.load(wasmBuffer);

			// Cache it
			this.languages.set(language, lang);
			return lang;
		} catch (error) {
			console.error(`Failed to load grammar for ${language}:`, error);
			return null;
		}
	}

	/**
	 * Parse source code
	 */
	async parse(
		source: string,
		language: SupportedLanguage,
	): Promise<Parser.Tree | null> {
		const parser = await this.getParser(language);
		if (!parser) {
			return null;
		}

		return parser.parse(source);
	}

	/**
	 * Get supported languages
	 */
	getSupportedLanguages(): SupportedLanguage[] {
		return Object.keys(LANGUAGE_CONFIGS) as SupportedLanguage[];
	}

	/**
	 * Get supported extensions
	 */
	getSupportedExtensions(): string[] {
		return Object.keys(EXTENSION_TO_LANGUAGE);
	}
}

// ============================================================================
// Singleton Instance
// ============================================================================

let parserManagerInstance: ParserManager | null = null;

/**
 * Get the singleton parser manager instance
 */
export function getParserManager(): ParserManager {
	if (!parserManagerInstance) {
		parserManagerInstance = new ParserManager();
	}
	return parserManagerInstance;
}

/**
 * Set a custom grammars path
 */
export function setGrammarsPath(path: string): void {
	parserManagerInstance = new ParserManager(path);
}
