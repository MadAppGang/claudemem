/**
 * Unit tests for parseIndexLockFlags — the pure parser mapping `mnemex index`
 * argv flags onto structured lock options.
 *
 * Proves:
 *  - --if-idle => try-acquire-bail on the machine-global lock ({ waitTimeout: 0 }).
 *  - no --if-idle => globalLockOptions undefined (Indexer default WAIT).
 *  - --wait / -w => wait:true (per-project lock waits).
 */

import { describe, expect, test } from "bun:test";
import { parseIndexLockFlags } from "../../../src/core/index-lock-flags.js";

describe("parseIndexLockFlags", () => {
	test("--if-idle => global try-acquire-bail (waitTimeout 0)", () => {
		const flags = parseIndexLockFlags(["--quiet", "--if-idle"]);
		expect(flags.ifIdle).toBe(true);
		expect(flags.globalLockOptions).toEqual({ waitTimeout: 0 });
	});

	test("no --if-idle => globalLockOptions undefined (Indexer default WAIT)", () => {
		const flags = parseIndexLockFlags(["--quiet"]);
		expect(flags.ifIdle).toBe(false);
		expect(flags.globalLockOptions).toBeUndefined();
	});

	test("--wait and -w both set wait:true", () => {
		expect(parseIndexLockFlags(["--wait"]).wait).toBe(true);
		expect(parseIndexLockFlags(["-w"]).wait).toBe(true);
	});

	test("no wait flag => wait:false", () => {
		expect(parseIndexLockFlags([]).wait).toBe(false);
	});

	test("flags are independent (background reindex: --quiet --if-idle)", () => {
		const flags = parseIndexLockFlags(["index", "--quiet", "--if-idle"]);
		expect(flags.wait).toBe(false);
		expect(flags.ifIdle).toBe(true);
		expect(flags.globalLockOptions).toEqual({ waitTimeout: 0 });
	});
});
