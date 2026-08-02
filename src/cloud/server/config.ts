/**
 * Server configuration for the mnemex cloud test server.
 */

export interface ServerConfig {
	/** HTTP port to listen on (default: 4510) */
	port: number;
	/** PostgreSQL connection string */
	databaseUrl: string;
	/** Embedding vector dimension (default: 8 for tests) */
	embeddingDim: number;
	/** Master API key from MASTER_API_KEY env var. undefined = auth disabled. */
	masterApiKey?: string;
}

/**
 * Load server config from environment variables with defaults.
 */
export function loadConfig(): ServerConfig {
	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		// No hardcoded fallback: a real connection string must never live in
		// source (it would leak the credential to git history and every fork).
		throw new Error(
			"DATABASE_URL is required. Set it in the environment; there is no default.",
		);
	}

	return {
		port: Number.parseInt(process.env.PORT ?? "4510", 10),
		databaseUrl,
		embeddingDim: Number.parseInt(process.env.EMBEDDING_DIM ?? "8", 10),
		masterApiKey: process.env.MASTER_API_KEY || undefined,
	};
}
