/**
 * Entry point for the claudemem cloud test server.
 * Uses Bun.serve() for HTTP handling. No authentication.
 */

import { type ServerConfig, loadConfig } from "./config.js";
import { type Sql, createDatabase } from "./db.js";
import { runMiddleware, versionMiddleware } from "./middleware.js";
import { type RequestContext, router } from "./router.js";

let server: ReturnType<typeof Bun.serve> | null = null;
let db: Sql | null = null;

/**
 * Start the HTTP server.
 * Returns the server instance and a base URL string.
 */
export async function startServer(
	config?: Partial<ServerConfig>,
): Promise<{ baseUrl: string; stop: () => Promise<void> }> {
	const fullConfig = { ...loadConfig(), ...config };
	db = createDatabase(fullConfig.databaseUrl);

	const sql = db;
	const cfg = fullConfig;

	server = Bun.serve({
		port: fullConfig.port,
		fetch: async (req: Request): Promise<Response> => {
			const url = new URL(req.url);
			const startMs = Date.now();

			const ctx: RequestContext = {
				req,
				method: req.method,
				pathname: url.pathname,
				params: {},
				query: url.searchParams,
				sql,
				config: cfg,
				metrics: {},
			};

			let response: Response;
			try {
				// Run middleware chain (version check only, no auth)
				const middlewareResult = await runMiddleware(ctx, [
					versionMiddleware,
				]);

				if (middlewareResult !== null) {
					response = middlewareResult;
				} else {
					response = await router(ctx);
				}
			} catch (err) {
				console.error("[server] Fatal error:", err);
				const message = err instanceof Error ? err.message : String(err);
				ctx.metrics.errorCode = "internal_error";
				response = new Response(
					JSON.stringify({ error: "internal_error", message }),
					{
						status: 500,
						headers: { "Content-Type": "application/json" },
					},
				);
			}

			const durationMs = Date.now() - startMs;

			// Slow request detection — must run before primary log
			const slowThresholds: Record<string, number> = {
				"POST /v1/index": 5000,
				"POST /v1/search": 2000,
				"POST /v1/chunks/check": 1000,
			};
			const routeKey = `${req.method} ${url.pathname}`;
			const threshold = slowThresholds[routeKey];
			if (threshold !== undefined && durationMs > threshold) {
				ctx.metrics.slow = true;
			}

			const logEntry = {
				ts: new Date().toISOString(),
				method: req.method,
				path: url.pathname,
				status: response.status,
				ms: durationMs,
				...ctx.metrics,
			};
			console.log(JSON.stringify(logEntry));

			return response;
		},
	});

	const baseUrl = `http://localhost:${fullConfig.port}`;
	console.log(`[server] Started at ${baseUrl}`);

	return {
		baseUrl,
		stop: async () => {
			await stopServer();
		},
	};
}

/**
 * Stop the server and close the database connection.
 */
export async function stopServer(): Promise<void> {
	if (server) {
		server.stop();
		server = null;
	}
	if (db) {
		await db.end();
		db = null;
	}
}

/**
 * Get the current database connection (for test harness use).
 */
export function getDb(): Sql | null {
	return db;
}
