/**
 * Middleware chain for the cloud test server.
 *
 * Simplified: no authentication. Only version check.
 */

import type { RequestContext } from "./router.js";
import { json } from "./router.js";

// ============================================================================
// Version middleware
// ============================================================================

export async function versionMiddleware(
	ctx: RequestContext,
): Promise<Response | null> {
	// Skip version check for health endpoint
	if (ctx.pathname === "/v1/health") return null;

	const version = ctx.req.headers.get("X-ClaudeMem-Version");
	if (!version || version !== "1") {
		return json({ error: "unsupported_version", supported: [1] }, 422);
	}

	// Extract anonymous machine ID for telemetry.
	// Gracefully absent for older clients — log null is fine.
	const machineId = ctx.req.headers.get("X-ClaudeMem-Machine-ID");
	if (machineId) {
		ctx.metrics.machineId = machineId;
	}

	return null;
}

// ============================================================================
// Middleware runner
// ============================================================================

type MiddlewareFn = (ctx: RequestContext) => Promise<Response | null>;

export async function runMiddleware(
	ctx: RequestContext,
	middlewares: MiddlewareFn[],
): Promise<Response | null> {
	for (const mw of middlewares) {
		const result = await mw(ctx);
		if (result !== null) return result;
	}
	return null;
}
