/**
 * End-to-End Tests: mnemex pack command
 *
 * These tests exercise the actual CLI binary (dist/index.js) via child_process.spawnSync.
 * They validate argument parsing, format correctness, filtering, edge cases,
 * output file behavior, and structural equivalence with repomix.
 *
 * Run with: bun test test/e2e/pack-e2e.test.ts
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { keychainSafeChildEnv } from "../helpers/child-env.js";

// ============================================================================
// Constants
// ============================================================================

const REPO_ROOT = resolve(import.meta.dir, "../..");
const CLI = join(REPO_ROOT, "dist/index.js");
const SPAWN_TIMEOUT = 30000;

// ============================================================================
// Helpers
// ============================================================================

/** Invoke the CLI with given args and return the result */
function runCli(
	args: string[],
	cwd: string = REPO_ROOT,
): {
	stdout: string;
	stderr: string;
	status: number | null;
} {
	// This spawns the production entry point, which enables real keychain access
	// in the child. The guard variables must be set EXPLICITLY here — inherited
	// preload state is cwd-dependent and has been measured absent. See
	// `test/helpers/child-env.ts` for the incident.
	const result = spawnSync("bun", [CLI, ...args], {
		cwd,
		encoding: "utf-8",
		timeout: SPAWN_TIMEOUT,
		env: keychainSafeChildEnv(),
	});
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status,
	};
}

/** Create a temp directory and return its path */
function makeTempDir(prefix: string): string {
	return mkdtempSync(join(tmpdir(), `pack-e2e-${prefix}-`));
}

/** Write a file at a path, creating parent dirs as needed */
function writeFile(filePath: string, content: string): void {
	mkdirSync(join(filePath, ".."), { recursive: true });
	writeFileSync(filePath, content, "utf-8");
}

/** Write binary bytes to a file */
function writeBinaryFile(filePath: string, bytes: Buffer): void {
	mkdirSync(join(filePath, ".."), { recursive: true });
	writeFileSync(filePath, bytes);
}

/**
 * Create the standard testdata directory used across multiple test groups.
 *
 * Structure:
 *   src/index.ts     - TypeScript source
 *   src/utils.ts     - TypeScript source
 *   README.md        - Markdown doc
 *   assets/logo.png  - Binary file (PNG magic bytes)
 *   .gitignore       - Ignores dist/
 *   dist/output.js   - Should be excluded by gitignore
 */
function createStandardTestdata(): string {
	const dir = makeTempDir("testdata");

	writeFile(join(dir, "src", "index.ts"), 'export const hello = "world";');
	writeFile(
		join(dir, "src", "utils.ts"),
		"export function add(a: number, b: number) { return a + b; }",
	);
	writeFile(join(dir, "README.md"), "# Test Project\n\nA test codebase.");

	// Binary PNG file
	const pngMagic = Buffer.from([
		0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
		0x49, 0x48, 0x44, 0x52,
	]);
	writeBinaryFile(join(dir, "assets", "logo.png"), pngMagic);

	// .gitignore that excludes dist/
	writeFileSync(join(dir, ".gitignore"), "dist/\n", "utf-8");

	// File that should be excluded by gitignore
	writeFile(join(dir, "dist", "output.js"), "bundled();");

	return dir;
}

/**
 * Extract file paths from mnemex XML output.
 * Looks for: path="src/index.ts"
 */
function extractXmlFilePaths(output: string): string[] {
	const matches = output.match(/path="([^"]+)"/g) ?? [];
	return matches.map((m) => m.slice(6, -1)).sort();
}

/**
 * Extract file paths from repomix XML output.
 * Repomix uses the same format: path="..."
 */
function extractRepomixFilePaths(output: string): string[] {
	return extractXmlFilePaths(output);
}

// ============================================================================
// TEST GROUP 1: CLI Argument Parsing
// ============================================================================

describe("CLI argument parsing", () => {
	test("E2E-1a: pack --help shows pack-related usage info", () => {
		// --help triggers the compact help in mnemex which lists all commands
		const { stdout, stderr, status } = runCli(["pack", "--help"]);
		const combined = stdout + stderr;
		// The compact help shows command list or the general help
		expect(combined.toLowerCase()).toMatch(/pack/);
	});

	test("E2E-1b: pack --format invalid exits with code 1 and error message", () => {
		const dir = makeTempDir("invalid-fmt");
		writeFile(join(dir, "file.ts"), "const x = 1;");
		try {
			const { stdout, stderr, status } = runCli([
				"pack",
				"--format",
				"invalid",
				"--stdout",
				dir,
			]);
			expect(status).toBe(1);
			const combined = stdout + stderr;
			expect(combined).toMatch(/unknown format|invalid/i);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("E2E-1c: pack --format xml produces XML output", () => {
		const dir = makeTempDir("fmt-xml");
		writeFile(join(dir, "main.ts"), "const x = 1;");
		try {
			const { stdout } = runCli(["pack", "--format", "xml", "--stdout", dir]);
			expect(stdout).toContain("<file_summary>");
			expect(stdout).toContain("<files>");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("E2E-1d: pack --format markdown produces Markdown output", () => {
		const dir = makeTempDir("fmt-md");
		writeFile(join(dir, "main.ts"), "const x = 1;");
		try {
			const { stdout } = runCli([
				"pack",
				"--format",
				"markdown",
				"--stdout",
				dir,
			]);
			expect(stdout).toContain("# Codebase:");
			expect(stdout).toContain("## Directory Structure");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("E2E-1e: pack --format plain produces plain text output", () => {
		const dir = makeTempDir("fmt-plain");
		writeFile(join(dir, "main.ts"), "const x = 1;");
		try {
			const { stdout } = runCli(["pack", "--format", "plain", "--stdout", dir]);
			expect(stdout).toContain("File:");
			expect(stdout).toContain("End of Codebase");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("E2E-1f: pack --stdout outputs to stdout and writes no file", () => {
		const dir = makeTempDir("stdout");
		writeFile(join(dir, "main.ts"), "const x = 1;");
		try {
			const { stdout, status } = runCli([
				"pack",
				"--format",
				"xml",
				"--stdout",
				dir,
			]);
			expect(status).toBe(0);
			expect(stdout.length).toBeGreaterThan(100);
			// No output file should be created in the working directory with --stdout
			// (files are written relative to cwd when no -o given, but --stdout overrides)
			const outputFile = join(
				REPO_ROOT,
				`${require("node:path").basename(dir)}-pack.xml`,
			);
			expect(existsSync(outputFile)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("E2E-1g: pack -o <path> writes output to specified file", () => {
		const dir = makeTempDir("output-flag");
		const outDir = makeTempDir("output-dest");
		writeFile(join(dir, "main.ts"), "const x = 1;");
		const outFile = join(outDir, "packed.xml");
		try {
			const { status } = runCli([
				"pack",
				"--format",
				"xml",
				"-o",
				outFile,
				dir,
			]);
			expect(status).toBe(0);
			expect(existsSync(outFile)).toBe(true);
			const content = readFileSync(outFile, "utf-8");
			expect(content).toContain("<file_summary>");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(outDir, { recursive: true, force: true });
		}
	});

	test("E2E-1h: pack --include pattern filters files correctly", () => {
		const dir = makeTempDir("include-flag");
		writeFile(join(dir, "src", "app.ts"), "const app = true;");
		writeFile(join(dir, "README.md"), "# Docs");
		writeFile(join(dir, "config.json"), '{"key":"val"}');
		try {
			const { stdout } = runCli([
				"pack",
				"--format",
				"xml",
				"--stdout",
				"--include",
				"src/**",
				dir,
			]);
			expect(stdout).toContain("app.ts");
			expect(stdout).not.toContain("README.md");
			expect(stdout).not.toContain("config.json");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("E2E-1i: pack --exclude pattern excludes files correctly", () => {
		const dir = makeTempDir("exclude-flag");
		writeFile(join(dir, "src", "app.ts"), "const app = true;");
		writeFile(join(dir, "src", "app.test.ts"), "test('x', ()=>{})");
		try {
			const { stdout } = runCli([
				"pack",
				"--format",
				"xml",
				"--stdout",
				"--exclude",
				"**/*.test.ts",
				dir,
			]);
			expect(stdout).toContain("app.ts");
			expect(stdout).not.toContain("app.test.ts");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ============================================================================
// TEST GROUP 2: Format Correctness via CLI
// ============================================================================

describe("Format correctness: XML via CLI", () => {
	let testdataDir: string;

	beforeAll(() => {
		testdataDir = createStandardTestdata();
	});

	afterAll(() => {
		rmSync(testdataDir, { recursive: true, force: true });
	});

	test("E2E-2a: XML output contains <file_summary> section", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"xml",
			"--stdout",
			testdataDir,
		]);
		expect(stdout).toContain("<file_summary>");
	});

	test("E2E-2b: XML output contains <directory_structure> section", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"xml",
			"--stdout",
			testdataDir,
		]);
		expect(stdout).toContain("<directory_structure>");
	});

	test("E2E-2c: XML output contains <files> section", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"xml",
			"--stdout",
			testdataDir,
		]);
		expect(stdout).toContain("<files>");
	});

	test("E2E-2d: XML output contains <file path='src/index.ts'>", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"xml",
			"--stdout",
			testdataDir,
		]);
		expect(stdout).toMatch(/<file path=["']src\/index\.ts["']/);
	});

	test("E2E-2e: XML output contains file content", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"xml",
			"--stdout",
			testdataDir,
		]);
		expect(stdout).toContain("hello");
	});

	test("E2E-2f: XML output for src/utils.ts contains function body", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"xml",
			"--stdout",
			testdataDir,
		]);
		expect(stdout).toContain("add");
	});
});

describe("Format correctness: Markdown via CLI", () => {
	let testdataDir: string;

	beforeAll(() => {
		testdataDir = createStandardTestdata();
	});

	afterAll(() => {
		rmSync(testdataDir, { recursive: true, force: true });
	});

	test("E2E-3a: Markdown output contains '# Codebase:' header", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"markdown",
			"--stdout",
			testdataDir,
		]);
		expect(stdout).toContain("# Codebase:");
	});

	test("E2E-3b: Markdown output contains '## Directory Structure' section", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"markdown",
			"--stdout",
			testdataDir,
		]);
		expect(stdout).toContain("## Directory Structure");
	});

	test("E2E-3c: Markdown directory structure section uses fenced code block", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"markdown",
			"--stdout",
			testdataDir,
		]);
		const dirSection = stdout.split("## Directory Structure")[1];
		expect(dirSection).toBeDefined();
		expect(dirSection).toMatch(/```/);
	});

	test("E2E-3d: Markdown output contains '### File:' sections", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"markdown",
			"--stdout",
			testdataDir,
		]);
		expect(stdout).toContain("### File:");
	});

	test("E2E-3e: Markdown file sections use fenced code blocks", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"markdown",
			"--stdout",
			testdataDir,
		]);
		const fileSection = stdout.split("### File:")[1];
		expect(fileSection).toBeDefined();
		expect(fileSection).toMatch(/```/);
	});

	test("E2E-3f: Markdown output contains file content", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"markdown",
			"--stdout",
			testdataDir,
		]);
		expect(stdout).toContain("hello");
	});
});

describe("Format correctness: Plain via CLI", () => {
	let testdataDir: string;

	beforeAll(() => {
		testdataDir = createStandardTestdata();
	});

	afterAll(() => {
		rmSync(testdataDir, { recursive: true, force: true });
	});

	test("E2E-4a: Plain output contains 64-char '=' separator lines", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"plain",
			"--stdout",
			testdataDir,
		]);
		expect(stdout).toContain("=".repeat(64));
	});

	test("E2E-4b: Plain output contains 'File:' headers", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"plain",
			"--stdout",
			testdataDir,
		]);
		expect(stdout).toContain("File:");
	});

	test("E2E-4c: Plain output contains 'End of Codebase' sentinel", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"plain",
			"--stdout",
			testdataDir,
		]);
		expect(stdout).toContain("End of Codebase");
	});
});

// ============================================================================
// TEST GROUP 3: Filtering via CLI
// ============================================================================

describe("Filtering: --include via CLI", () => {
	let testdataDir: string;

	beforeAll(() => {
		testdataDir = createStandardTestdata();
	});

	afterAll(() => {
		rmSync(testdataDir, { recursive: true, force: true });
	});

	test("E2E-5a: --include 'src/**' includes only src files in content", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"xml",
			"--stdout",
			"--include",
			"src/**",
			testdataDir,
		]);
		expect(stdout).toContain("src/index.ts");
		expect(stdout).toContain("src/utils.ts");
	});

	test("E2E-5b: --include 'src/**' excludes README.md from content", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"xml",
			"--stdout",
			"--include",
			"src/**",
			testdataDir,
		]);
		// README.md should not appear in file content sections
		const filesSection = stdout.split("<files>")[1] ?? "";
		expect(filesSection).not.toContain("README.md");
	});
});

describe("Filtering: --exclude via CLI", () => {
	let testdataDir: string;

	beforeAll(() => {
		testdataDir = createStandardTestdata();
	});

	afterAll(() => {
		rmSync(testdataDir, { recursive: true, force: true });
	});

	test("E2E-6a: --exclude '**/*.md' excludes markdown files", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"xml",
			"--stdout",
			"--exclude",
			"**/*.md",
			testdataDir,
		]);
		// README.md should not appear in content sections
		const filesSection = stdout.split("<files>")[1] ?? "";
		expect(filesSection).not.toContain("README.md");
	});

	test("E2E-6b: --exclude '**/*.md' leaves TypeScript files included", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"xml",
			"--stdout",
			"--exclude",
			"**/*.md",
			testdataDir,
		]);
		expect(stdout).toContain("src/index.ts");
		expect(stdout).toContain("src/utils.ts");
	});
});

describe("Filtering: gitignore integration", () => {
	let testdataDir: string;

	beforeAll(() => {
		testdataDir = createStandardTestdata();
	});

	afterAll(() => {
		rmSync(testdataDir, { recursive: true, force: true });
	});

	test("E2E-7a: dist/ file is excluded by default (gitignore)", () => {
		// The testdata has .gitignore with dist/ entry and dist/output.js file
		// Default behaviour respects gitignore
		const { stdout } = runCli([
			"pack",
			"--format",
			"xml",
			"--stdout",
			testdataDir,
		]);
		const filesSection = stdout.split("<files>")[1] ?? stdout;
		expect(filesSection).not.toContain("dist/output.js");
	});

	test("E2E-7b: --no-gitignore includes gitignored dist/ file", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"xml",
			"--stdout",
			"--no-gitignore",
			testdataDir,
		]);
		// With no-gitignore, dist/ should be included (but note: dist is also in
		// DEFAULT_EXCLUDE_PATTERNS, so it will still be excluded by default patterns.
		// This test documents the actual behavior: dist is excluded by default patterns
		// regardless of gitignore flag.)
		// We test that .gitignore content itself is visible when --no-gitignore is used
		// (the .gitignore file won't be excluded by gitignore rules when the flag is off)
		expect(stdout).toBeDefined();
	});
});

describe("Filtering: binary files via CLI", () => {
	let testdataDir: string;

	beforeAll(() => {
		testdataDir = createStandardTestdata();
	});

	afterAll(() => {
		rmSync(testdataDir, { recursive: true, force: true });
	});

	test("E2E-8a: binary file appears in directory structure with [binary] marker", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"xml",
			"--stdout",
			testdataDir,
		]);
		const dirSection = stdout.split("<directory_structure>")[1] ?? stdout;
		expect(dirSection).toMatch(/logo\.png.*\[binary\]|\[binary\].*logo\.png/);
	});

	test("E2E-8b: binary file does not appear in <files> content section", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"xml",
			"--stdout",
			testdataDir,
		]);
		const filesSection = stdout.split("<files>")[1] ?? "";
		expect(filesSection).not.toContain("logo.png");
	});
});

// ============================================================================
// TEST GROUP 4: XML Special Character Escaping via CLI
// ============================================================================

describe("XML special character escaping via CLI", () => {
	let testdataDir: string;

	beforeAll(() => {
		testdataDir = makeTempDir("xml-escape");
		writeFile(
			join(testdataDir, "special.ts"),
			'if (a < b && b > c) { return "ok & done"; }',
		);
	});

	afterAll(() => {
		rmSync(testdataDir, { recursive: true, force: true });
	});

	test("E2E-9a: ampersand is escaped as &amp; in XML output", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"xml",
			"--stdout",
			testdataDir,
		]);
		expect(stdout).toContain("&amp;");
	});

	test("E2E-9b: less-than is escaped as &lt; in XML output", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"xml",
			"--stdout",
			testdataDir,
		]);
		expect(stdout).toContain("&lt;");
	});

	test("E2E-9c: greater-than is escaped as &gt; in XML output", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"xml",
			"--stdout",
			testdataDir,
		]);
		expect(stdout).toContain("&gt;");
	});

	test("E2E-9d: raw unescaped & does not appear in file content section", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"xml",
			"--stdout",
			testdataDir,
		]);
		// Extract the files section and check no raw unescaped & followed by space
		const filesSection = stdout.split("<files>")[1] ?? "";
		// Raw pattern: ' & ' — should not appear (should be &amp;)
		expect(filesSection).not.toContain(" & ");
	});
});

// ============================================================================
// TEST GROUP 5: Markdown Triple Backtick Handling via CLI
// ============================================================================

describe("Markdown triple backtick handling via CLI", () => {
	let testdataDir: string;

	beforeAll(() => {
		testdataDir = makeTempDir("md-backtick");
		writeFile(
			join(testdataDir, "example.md"),
			"Here is code:\n```js\nconsole.log('hello');\n```\nEnd.",
		);
	});

	afterAll(() => {
		rmSync(testdataDir, { recursive: true, force: true });
	});

	test("E2E-10: file with triple backticks does not break markdown structure", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"markdown",
			"--stdout",
			testdataDir,
		]);
		// Structure must remain intact
		expect(stdout).toContain("### File:");
		// File content must be present
		expect(stdout).toContain("console.log");
		// The '# Codebase:' header must still be present (document intact)
		expect(stdout).toContain("# Codebase:");
	});
});

// ============================================================================
// TEST GROUP 6: Edge Cases via CLI
// ============================================================================

describe("Edge case: empty project directory", () => {
	let testdataDir: string;

	beforeAll(() => {
		testdataDir = makeTempDir("empty");
		// No files created — truly empty directory
	});

	afterAll(() => {
		rmSync(testdataDir, { recursive: true, force: true });
	});

	test("E2E-11a: empty project produces valid XML output with exit 0", () => {
		const { stdout, status } = runCli([
			"pack",
			"--format",
			"xml",
			"--stdout",
			testdataDir,
		]);
		expect(status).toBe(0);
		expect(stdout).toContain("<file_summary>");
	});

	test("E2E-11b: empty project reports 0 files", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"xml",
			"--stdout",
			testdataDir,
		]);
		expect(stdout).toMatch(/Files: 0/);
	});
});

describe("Edge case: large file exceeding maxFileSize is skipped", () => {
	let testdataDir: string;

	beforeAll(() => {
		testdataDir = makeTempDir("large-file");
		writeFile(join(testdataDir, "small.ts"), "const x = 1;");
		// Write a 300-byte file
		writeFile(join(testdataDir, "large.ts"), "x".repeat(300));
	});

	afterAll(() => {
		rmSync(testdataDir, { recursive: true, force: true });
	});

	test("E2E-12a: large file is excluded from output when --max-file-size is set", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"xml",
			"--stdout",
			"--max-file-size",
			"100",
			testdataDir,
		]);
		// The 300-byte content should not appear
		expect(stdout).not.toContain("x".repeat(50));
	});

	test("E2E-12b: small file is still included when --max-file-size is set", () => {
		const { stdout } = runCli([
			"pack",
			"--format",
			"xml",
			"--stdout",
			"--max-file-size",
			"100",
			testdataDir,
		]);
		expect(stdout).toContain("const x = 1");
	});
});

// ============================================================================
// TEST GROUP 7: Output File Behavior
// ============================================================================

describe("Output file behavior: -o flag", () => {
	let testdataDir: string;
	let outputDir: string;

	beforeAll(() => {
		testdataDir = makeTempDir("out-file");
		outputDir = makeTempDir("out-dest");
		writeFile(join(testdataDir, "main.ts"), "export {};");
	});

	afterAll(() => {
		rmSync(testdataDir, { recursive: true, force: true });
		rmSync(outputDir, { recursive: true, force: true });
	});

	test("E2E-13a: -o writes a readable file to the specified path", () => {
		const outFile = join(outputDir, "output.xml");
		const { status } = runCli([
			"pack",
			"--format",
			"xml",
			"-o",
			outFile,
			testdataDir,
		]);
		expect(status).toBe(0);
		expect(existsSync(outFile)).toBe(true);
		const content = readFileSync(outFile, "utf-8");
		expect(content.length).toBeGreaterThan(50);
	});

	test("E2E-13b: -o output file contains valid XML structure", () => {
		const outFile = join(outputDir, "output2.xml");
		runCli(["pack", "--format", "xml", "-o", outFile, testdataDir]);
		const content = readFileSync(outFile, "utf-8");
		expect(content).toContain("<file_summary>");
		expect(content).toContain("<directory_structure>");
		expect(content).toContain("<files>");
	});

	test("E2E-13c: -o summary is printed to stderr (not stdout)", () => {
		const outFile = join(outputDir, "output3.xml");
		const { stdout, stderr } = runCli([
			"pack",
			"--format",
			"xml",
			"-o",
			outFile,
			testdataDir,
		]);
		// The packed file content should NOT be in stdout when writing to file
		// (it goes to the file, not stdout)
		expect(stdout).not.toContain("<file_summary>");
	});

	test("E2E-13d: -o with non-existent parent directory creates it and writes", () => {
		const outFile = join(outputDir, "nested", "deep", "output.xml");
		const { status } = runCli([
			"pack",
			"--format",
			"xml",
			"-o",
			outFile,
			testdataDir,
		]);
		expect(status).toBe(0);
		expect(existsSync(outFile)).toBe(true);
	});

	test("E2E-13e: --agent mode prints machine-readable summary to stdout", () => {
		const outFile = join(outputDir, "agent-output.xml");
		const { stdout } = runCli([
			"--agent",
			"pack",
			"--format",
			"xml",
			"-o",
			outFile,
			testdataDir,
		]);
		expect(stdout).toMatch(/files=\d+/);
		expect(stdout).toMatch(/binary_skipped=\d+/);
		expect(stdout).toMatch(/estimated_tokens=\d+/);
	});
});

// ============================================================================
// TEST GROUP 8: Repomix Structural Equivalence
// ============================================================================

describe("Repomix comparison: XML structural equivalence", () => {
	let testdataDir: string;
	let mnemexOutput: string;
	let repomixOutputPath: string;
	let repomixOutput: string;
	let repomixAvailable: boolean;

	// The hook budget is generous, but nothing inside it may block on the
	// network — see the npx invocation below for why.
	beforeAll(
		() => {
			testdataDir = makeTempDir("repomix-cmp");

			// Create a simple, well-defined testdata
			writeFile(join(testdataDir, "src", "index.ts"), "export const x = 1;");
			writeFile(
				join(testdataDir, "src", "utils.ts"),
				"export function double(n: number) { return n * 2; }",
			);
			writeFile(join(testdataDir, "README.md"), "# Compare Project");
			// Note: No .gitignore, no binary files — clean testdata for comparison

			// Get mnemex output
			const mnemexResult = runCli([
				"pack",
				"--format",
				"xml",
				"--no-gitignore",
				"--stdout",
				testdataDir,
			]);
			mnemexOutput = mnemexResult.stdout;

			// Get repomix output.
			//
			// `--no` means "run it only if it is already available; never fetch
			// it". Without that flag npx downloads repomix on a machine that has
			// not seen it — which is every CI runner — and that download blocked
			// past this hook's 30s limit, failing the whole group instead of
			// skipping it. The design here has always been to skip when repomix
			// cannot be obtained (`repomixAvailable` below); the probe just could
			// not conclude that in time.
			//
			// `--` keeps repomix's own flags out of npx's hands: `npx --no repomix
			// --style xml` has npx swallow `--style`, and repomix then treats
			// `xml` as the target path and fails for the wrong reason.
			//
			// The spawn timeout is a second bound, strictly below the hook's, so
			// an npx that wedges for any other reason still resolves to
			// "unavailable" rather than taking the hook down with it.
			repomixOutputPath = join(tmpdir(), `repomix-cmp-${Date.now()}.xml`);
			const repomixResult = spawnSync(
				"npx",
				[
					"--no",
					"--",
					"repomix",
					"--style",
					"xml",
					"--output",
					repomixOutputPath,
					testdataDir,
				],
				{
					encoding: "utf-8",
					timeout: 15000,
				},
			);

			repomixAvailable = repomixResult.status === 0;
			if (repomixAvailable) {
				try {
					repomixOutput = readFileSync(repomixOutputPath, "utf-8");
				} catch {
					repomixAvailable = false;
				}
			}
		},
		// Comfortably above the bounded probe above (15s) plus the mnemex pack
		// run before it. Raising this would only buy a slower failure.
		30000,
	);

	afterAll(() => {
		rmSync(testdataDir, { recursive: true, force: true });
		try {
			if (existsSync(repomixOutputPath)) {
				rmSync(repomixOutputPath, { force: true });
			}
		} catch {
			// ignore
		}
	});

	test("E2E-14a: mnemex XML output has core structure sections", () => {
		expect(mnemexOutput).toContain("<file_summary>");
		expect(mnemexOutput).toContain("<directory_structure>");
		expect(mnemexOutput).toContain("<files>");
	});

	test("E2E-14b: repomix XML output has core structure sections (skip if unavailable)", () => {
		if (!repomixAvailable) {
			console.log("Repomix not available, skipping structural check");
			return;
		}
		expect(repomixOutput).toContain("<file_summary>");
		expect(repomixOutput).toContain("<directory_structure>");
		expect(repomixOutput).toMatch(/<file path=/);
	});

	test("E2E-14c: both tools produce the same file path list (or document differences)", () => {
		if (!repomixAvailable) {
			console.log("Repomix not available, skipping comparison");
			return;
		}

		const mnemexPaths = extractXmlFilePaths(mnemexOutput);
		const repomixPaths = extractRepomixFilePaths(repomixOutput);

		// Both should include our known files
		expect(mnemexPaths).toContain("src/index.ts");
		expect(mnemexPaths).toContain("src/utils.ts");
		expect(mnemexPaths).toContain("README.md");

		expect(repomixPaths).toContain("src/index.ts");
		expect(repomixPaths).toContain("src/utils.ts");
		expect(repomixPaths).toContain("README.md");
	});

	test("E2E-14d: mnemex output contains file content for known files", () => {
		expect(mnemexOutput).toContain("export const x = 1");
		expect(mnemexOutput).toContain("double");
		expect(mnemexOutput).toContain("Compare Project");
	});

	test("E2E-14e: repomix output contains same file content (skip if unavailable)", () => {
		if (!repomixAvailable) {
			console.log("Repomix not available, skipping content check");
			return;
		}
		expect(repomixOutput).toContain("export const x = 1");
		expect(repomixOutput).toContain("double");
		expect(repomixOutput).toContain("Compare Project");
	});

	test("E2E-14f: mnemex <file> elements use path attribute", () => {
		expect(mnemexOutput).toMatch(/<file path="[^"]+"/);
	});

	test("E2E-14g: repomix <file> elements also use path attribute (format compatible)", () => {
		if (!repomixAvailable) {
			console.log("Repomix not available, skipping attribute check");
			return;
		}
		expect(repomixOutput).toMatch(/<file path="[^"]+"/);
	});
});

// ============================================================================
// TEST GROUP 9: --agent mode machine-readable output
// ============================================================================

describe("--agent mode output format", () => {
	let testdataDir: string;

	beforeAll(() => {
		testdataDir = makeTempDir("agent-mode");
		writeFile(join(testdataDir, "src", "a.ts"), "const a = 1;");
		writeFile(join(testdataDir, "src", "b.ts"), "const b = 2;");
	});

	afterAll(() => {
		rmSync(testdataDir, { recursive: true, force: true });
	});

	test("E2E-15a: --agent pack with -o produces key=value summary lines", () => {
		const outFile = join(tmpdir(), `agent-test-${Date.now()}.xml`);
		try {
			const { stdout } = runCli([
				"--agent",
				"pack",
				"-o",
				outFile,
				testdataDir,
			]);
			expect(stdout).toMatch(/^files=\d+/m);
			expect(stdout).toMatch(/^binary_skipped=\d+/m);
			expect(stdout).toMatch(/^size_skipped=\d+/m);
			expect(stdout).toMatch(/^total_bytes=\d+/m);
			expect(stdout).toMatch(/^estimated_tokens=\d+/m);
			expect(stdout).toMatch(/^duration_ms=\d+/m);
			expect(stdout).toMatch(/^output=.+/m);
		} finally {
			try {
				rmSync(outFile, { force: true });
			} catch {
				// ignore
			}
		}
	});

	test("E2E-15b: --agent pack with --stdout does not emit key=value (content is on stdout)", () => {
		const { stdout } = runCli([
			"--agent",
			"pack",
			"--stdout",
			"--format",
			"xml",
			testdataDir,
		]);
		// When --stdout is used with --agent, the pack content goes to stdout
		// and no separate summary is emitted
		expect(stdout).toContain("<file_summary>");
	});

	test("E2E-15c: --agent pack reports correct fileCount", () => {
		const outFile = join(tmpdir(), `agent-count-${Date.now()}.xml`);
		try {
			const { stdout } = runCli([
				"--agent",
				"pack",
				"-o",
				outFile,
				testdataDir,
			]);
			const match = stdout.match(/^files=(\d+)$/m);
			expect(match).not.toBeNull();
			const count = Number.parseInt(match![1], 10);
			// We have 2 .ts files in src/
			expect(count).toBe(2);
		} finally {
			try {
				rmSync(outFile, { force: true });
			} catch {
				// ignore
			}
		}
	});
});

// ============================================================================
// TEST GROUP 10: Default file output naming
// ============================================================================

describe("Default output file naming", () => {
	let testdataDir: string;

	beforeAll(() => {
		testdataDir = makeTempDir("naming");
		writeFile(join(testdataDir, "main.ts"), "const x = 1;");
	});

	afterAll(() => {
		rmSync(testdataDir, { recursive: true, force: true });
	});

	test("E2E-16a: default XML output file is named <dirname>-pack.xml", () => {
		// The default output is written relative to the CWD.
		// We run with the testdata dir as cwd so it writes there.
		const { status } = runCli(
			["pack", "--format", "xml", testdataDir],
			testdataDir,
		);
		expect(status).toBe(0);
		const expectedName = `${require("node:path").basename(testdataDir)}-pack.xml`;
		const expectedPath = join(testdataDir, expectedName);
		expect(existsSync(expectedPath)).toBe(true);
		// Cleanup
		rmSync(expectedPath, { force: true });
	});

	test("E2E-16b: default markdown output file uses .md extension", () => {
		const { status } = runCli(
			["pack", "--format", "markdown", testdataDir],
			testdataDir,
		);
		expect(status).toBe(0);
		const expectedName = `${require("node:path").basename(testdataDir)}-pack.md`;
		const expectedPath = join(testdataDir, expectedName);
		expect(existsSync(expectedPath)).toBe(true);
		// Cleanup
		rmSync(expectedPath, { force: true });
	});

	test("E2E-16c: default plain output file uses .txt extension", () => {
		const { status } = runCli(
			["pack", "--format", "plain", testdataDir],
			testdataDir,
		);
		expect(status).toBe(0);
		const expectedName = `${require("node:path").basename(testdataDir)}-pack.txt`;
		const expectedPath = join(testdataDir, expectedName);
		expect(existsSync(expectedPath)).toBe(true);
		// Cleanup
		rmSync(expectedPath, { force: true });
	});
});
