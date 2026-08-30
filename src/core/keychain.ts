/**
 * macOS Keychain integration for secret storage.
 *
 * Stores API keys in the system Keychain instead of plaintext in
 * ~/.mnemex/config.json. Uses the native `security` CLI — no native
 * dependencies required.
 *
 * On non-macOS platforms, all operations are no-ops and callers fall
 * back to config-file storage.
 */

import { execSync } from "node:child_process";

// ============================================================================
// Constants
// ============================================================================

/** Keychain service name (groups all mnemex secrets together) */
const KEYCHAIN_SERVICE = "mnemex";

/** Timeout for `security` CLI calls (ms) */
const KEYCHAIN_TIMEOUT_MS = 5000;

/**
 * Map of config-field names to keychain account names.
 * Only these fields are routed to the keychain; everything else
 * stays in the JSON config file.
 */
const SECRET_FIELDS: Record<string, string> = {
	openrouterApiKey: "openrouter",
	voyageApiKey: "voyage",
	anthropicApiKey: "anthropic",
	context7ApiKey: "context7",
	cloudApiKey: "cloud",
};

// ============================================================================
// Platform Detection
// ============================================================================

function isMacOS(): boolean {
	return process.platform === "darwin";
}

// ============================================================================
// Keychain Operations
// ============================================================================

/**
 * Store a secret in the macOS Keychain.
 * Overwrites any existing entry for the same account.
 * Returns true on success, false on non-macOS or failure.
 */
export function setKeychainSecret(account: string, value: string): boolean {
	if (!isMacOS()) return false;

	try {
		// Delete existing entry (ignore errors if it doesn't exist)
		runSecurityCli([
			"delete-generic-password",
			"-s",
			KEYCHAIN_SERVICE,
			"-a",
			account,
		]);
	} catch {
		// Entry doesn't exist yet — expected
	}

	try {
		runSecurityCli([
			"add-generic-password",
			"-s",
			KEYCHAIN_SERVICE,
			"-a",
			account,
			"-w",
			value,
			"-U", // update if exists (belt-and-suspenders with delete above)
		]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Retrieve a secret from the macOS Keychain.
 * Returns undefined on non-macOS, missing entry, or failure.
 */
export function getKeychainSecret(account: string): string | undefined {
	if (!isMacOS()) return undefined;

	try {
		const result = runSecurityCli([
			"find-generic-password",
			"-s",
			KEYCHAIN_SERVICE,
			"-a",
			account,
			"-w", // output only the password
		]);
		const value = result.trim();
		return value || undefined;
	} catch {
		return undefined;
	}
}

/**
 * Delete a secret from the macOS Keychain.
 * Returns true if deleted, false if not found or non-macOS.
 */
export function deleteKeychainSecret(account: string): boolean {
	if (!isMacOS()) return false;

	try {
		runSecurityCli([
			"delete-generic-password",
			"-s",
			KEYCHAIN_SERVICE,
			"-a",
			account,
		]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Check if keychain storage is available (macOS only).
 */
export function isKeychainAvailable(): boolean {
	return isMacOS();
}

// ============================================================================
// Config-Field Routing
// ============================================================================

/**
 * Check if a config field name is a secret that should be routed to keychain.
 */
export function isSecretField(field: string): boolean {
	return field in SECRET_FIELDS;
}

/**
 * Get the keychain account name for a config field.
 * Returns undefined if the field is not a secret.
 */
export function getAccountForField(field: string): string | undefined {
	return SECRET_FIELDS[field];
}

/**
 * Get the config field name for a keychain account.
 * Returns undefined if the account is not a known secret.
 */
export function getFieldForAccount(account: string): string | undefined {
	for (const [field, acct] of Object.entries(SECRET_FIELDS)) {
		if (acct === account) return field;
	}
	return undefined;
}

/**
 * Extract secret fields from a config object and store them in the keychain.
 * Returns a copy of the config with secret fields removed (so they won't
 * be written to the plaintext JSON file).
 */
export function routeSecretsToKeychain<T extends Record<string, unknown>>(
	config: T,
): T {
	if (!isMacOS()) return config;

	const stripped = { ...config };
	for (const field of Object.keys(SECRET_FIELDS)) {
		if (field in stripped && stripped[field]) {
			const account = SECRET_FIELDS[field];
			const value = String(stripped[field]);
			setKeychainSecret(account, value);
			delete stripped[field];
		}
	}
	return stripped;
}

/**
 * Remove secret fields from a config object without storing them to keychain.
 * Used before writing to the plaintext JSON file to ensure no secrets leak.
 */
export function stripSecrets<T extends Record<string, unknown>>(config: T): T {
	const stripped = { ...config };
	for (const field of Object.keys(SECRET_FIELDS)) {
		delete stripped[field];
	}
	return stripped;
}

/**
 * Load any secret fields from the keychain and merge them into a config object.
 * Missing keychain entries are skipped (caller's existing value is preserved).
 */
export function mergeKeychainSecrets<T extends Record<string, unknown>>(
	config: T,
): T {
	if (!isMacOS()) return config;

	const merged = { ...config };
	for (const field of Object.keys(SECRET_FIELDS)) {
		if (!(field in merged) || !merged[field]) {
			const account = SECRET_FIELDS[field];
			const value = getKeychainSecret(account);
			if (value) {
				(merged as Record<string, unknown>)[field] = value;
			}
		}
	}
	return merged;
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Run the `security` CLI and return stdout.
 * Throws on non-zero exit code.
 */
function runSecurityCli(args: string[]): string {
	return execSync(`security ${args.map(shellQuote).join(" ")} 2>/dev/null`, {
		encoding: "utf-8",
		timeout: KEYCHAIN_TIMEOUT_MS,
	}).trim();
}

/**
 * Shell-quote a single argument for the `security` CLI.
 * Wraps in single quotes and escapes embedded single quotes.
 */
function shellQuote(arg: string): string {
	return `'${arg.replace(/'/g, "'\\''")}'`;
}
