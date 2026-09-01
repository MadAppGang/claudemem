import { describe, expect, test } from "bun:test";
import { isDistDirectory } from "../../../src/parsers/parser-manager.js";

// REGRESSION: issue #4 — Windows global install could not find grammars (backslash paths)
//
// `fileURLToPath(new URL(".", import.meta.url))` yields a platform-native path with a
// trailing separator: `.../dist/` on POSIX, `C:\...\dist\` on Windows. The classification
// must therefore be separator-agnostic AND tolerate the trailing separator. These cases
// run on POSIX CI, so Windows-style input is passed in directly rather than relying on
// the host platform.
describe("isDistDirectory", () => {
	test("classifies a Windows global-install dist directory as dist", () => {
		expect(isDistDirectory("C:\\Users\\x\\node_modules\\mnemex\\dist\\")).toBe(
			true,
		);
	});

	test("classifies a POSIX global-install dist directory as dist", () => {
		expect(isDistDirectory("/usr/local/lib/node_modules/mnemex/dist/")).toBe(
			true,
		);
	});

	test("classifies a POSIX development source directory as not dist", () => {
		expect(isDistDirectory("/Users/x/mnemex/src/parsers/")).toBe(false);
	});

	test("classifies a Windows development source directory as not dist", () => {
		expect(isDistDirectory("C:\\Users\\x\\mnemex\\src\\parsers\\")).toBe(false);
	});

	test("does not classify a source directory nested under a dist ancestor as dist", () => {
		expect(isDistDirectory("/Users/x/dist/myproject/src/parsers/")).toBe(false);
		expect(
			isDistDirectory("C:\\Users\\x\\dist\\myproject\\src\\parsers\\"),
		).toBe(false);
	});

	test("does not classify a directory whose name merely starts with dist as dist", () => {
		expect(isDistDirectory("/Users/x/mnemex/distribution/")).toBe(false);
	});

	test("tolerates a missing trailing separator", () => {
		expect(isDistDirectory("/usr/local/lib/node_modules/mnemex/dist")).toBe(
			true,
		);
		expect(isDistDirectory("C:\\Users\\x\\node_modules\\mnemex\\dist")).toBe(
			true,
		);
	});
});
