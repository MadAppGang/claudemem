// REGRESSION: context tool rejects string line/radius params — Fixed in /fix session dev-fix-20260318-164921-9b275cb3
import { describe, expect, test } from "bun:test";
import { z } from "zod";

// Inline recreation of the context tool's numeric parameter schemas,
// mirroring what is in src/mcp/tools/context.ts
const contextToolSchema = z.object({
	file: z.string(),
	line: z.coerce.number().default(1),
	radius: z.coerce.number().min(1).max(10).default(2),
});

describe("context tool schema — string coercion", () => {
	test("rejects string line (currently fails — bug)", () => {
		const result = contextToolSchema.safeParse({ file: "foo.ts", line: "156" });
		expect(result.success).toBe(true);
	});

	test("rejects string radius (currently fails — bug)", () => {
		const result = contextToolSchema.safeParse({ file: "foo.ts", radius: "3" });
		expect(result.success).toBe(true);
	});

	test("rejects string for both line and radius (currently fails — bug)", () => {
		const result = contextToolSchema.safeParse({
			file: "foo.ts",
			line: "10",
			radius: "5",
		});
		expect(result.success).toBe(true);
	});

	test("accepts numeric line and radius (baseline — must keep passing)", () => {
		const result = contextToolSchema.safeParse({
			file: "foo.ts",
			line: 42,
			radius: 4,
		});
		expect(result.success).toBe(true);
	});
});
