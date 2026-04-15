/**
 * Logo and Banner Utilities
 *
 * ASCII art and branding for CLI tools.
 */

import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, existsSync } from "fs";
import { colors as c } from "./colors.js";

/** Cached version */
let _version: string | null = null;

/**
 * Get package version
 */
function getVersion(): string {
	if (_version) return _version;

	try {
		// Try multiple paths to find package.json
		// ../package.json works from dist/index.js, ../../ works from src/ui/logo.ts
		const base = dirname(fileURLToPath(import.meta.url));
		const paths = [
			join(base, "../package.json"),
			join(base, "../../package.json"),
			join(process.cwd(), "package.json"),
		];

		for (const path of paths) {
			if (existsSync(path)) {
				const pkg = JSON.parse(readFileSync(path, "utf-8"));
				_version = pkg.version || "0.0.0";
				return _version!;
			}
		}
	} catch {
		// Ignore errors
	}

	_version = "0.0.0";
	return _version;
}

/**
 * ASCII logo for mnemex.
 *
 * The word MNEMEX is rendered as a single block, but individual letters are
 * colored so that M(1), E(3), and M(4) — which together spell MEM — glow
 * green, while N(2), E(5), and X(6) stay orange. This lets the embedded
 * "mem" pun read at a glance without splitting the word.
 */
export function getLogo(): string {
	const version = getVersion();
	const g = c.green;
	const o = c.orange;
	const r = c.reset;
	return `
  ${g}███╗   ███╗${r}${o}███╗   ██╗${r}${g}███████╗${r}${g}███╗   ███╗${r}${o}███████╗${r}${o}██╗  ██╗${r}
  ${g}████╗ ████║${r}${o}████╗  ██║${r}${g}██╔════╝${r}${g}████╗ ████║${r}${o}██╔════╝${r}${o}╚██╗██╔╝${r}
  ${g}██╔████╔██║${r}${o}██╔██╗ ██║${r}${g}█████╗  ${r}${g}██╔████╔██║${r}${o}█████╗  ${r}${o} ╚███╔╝ ${r}
  ${g}██║╚██╔╝██║${r}${o}██║╚██╗██║${r}${g}██╔══╝  ${r}${g}██║╚██╔╝██║${r}${o}██╔══╝  ${r}${o} ██╔██╗ ${r}
  ${g}██║ ╚═╝ ██║${r}${o}██║ ╚████║${r}${g}███████╗${r}${g}██║ ╚═╝ ██║${r}${o}███████╗${r}${o}██╔╝ ██╗${r}
  ${g}╚═╝     ╚═╝${r}${o}╚═╝  ╚═══╝${r}${g}╚══════╝${r}${g}╚═╝     ╚═╝${r}${o}╚══════╝${r}${o}╚═╝  ╚═╝${r}
${c.bold}  Seven layers of code memory — benchmarked.${c.reset}               v${version}
${c.dim}  Personal. Team-shared. Offline or any model.${c.reset}
`;
}

/**
 * Print logo to console
 */
export function printLogo(): void {
	console.log(getLogo());
}

/**
 * Print a benchmark header with emoji
 */
export function printBenchmarkHeader(emoji: string, title: string): void {
	console.log(`\n${c.orange}${emoji} ${c.bold}${title}${c.reset}\n`);
}

/**
 * Print a phase header
 */
export function printPhaseHeader(text: string): void {
	console.log(`${c.dim}${text}${c.reset}`);
}

/**
 * Print status with emoji
 */
export function printStatus(emoji: string, label: string, value: string): void {
	console.log(`${emoji} ${c.bold}${label}:${c.reset} ${value}`);
}
